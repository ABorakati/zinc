// A PDF render worker for the browser builds (web/pdf.ts starts one or more): PDFium WebAssembly off the page's main thread, so the
// interface keeps drawing while pages render. Built by web/build.ts as a module worker script (pdf-worker.js, one self-contained
// file next to pdfium.wasm: Manifest V3 extension pages allow workers from the package, not from blob: URLs).
//
// Messages in:  {t:"open", doc, bytes} | {t:"close", doc} | {t:"render", job, doc, page, scale, opts, prio} | {t:"text", job, doc, page,
//               prio} | {t:"cancel", job} | {t:"prio", job, prio}
// Messages out: {t:"ready"} | {t:"failed", error} | {t:"rendered", job, width, height, pixels, renderMs} (pixels transferred) |
//               {t:"text", job, layer} | {t:"error", job, error} | {t:"cancelled", job}
import { closeDoc, drawPage, initEngine, openDoc, pageText, type DocHandle, type DrawOpts } from "./pdf-engine";

type In =
	| { t: "open"; doc: number; bytes: ArrayBuffer }
	| { t: "close"; doc: number }
	| { t: "render"; job: number; doc: number; page: number; scale: number; opts: DrawOpts; prio: number }
	| { t: "text"; job: number; doc: number; page: number; prio: number }
	| { t: "cancel"; job: number }
	| { t: "prio"; job: number; prio: number };
type Job = Extract<In, { t: "render" } | { t: "text" }>;

const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
const docs = new Map<number, DocHandle>();
const queue: Job[] = [];
let ticking = false;
let ready = false;

// the engine sits next to this script; the page sends its open/render messages right away, they wait in the queue until it loads
initEngine(new URL("pdfium.wasm", self.location.href).href).then(
	() => { ready = true; post({ t: "ready" }); schedule(); },
	(e) => post({ t: "failed", error: String(e instanceof Error ? e.message : e) }),
);

const pendingOpens: { doc: number; bytes: ArrayBuffer }[] = [];

function schedule(): void {
	if (!ticking && ready && (queue.length || pendingOpens.length)) {
		ticking = true;
		// one job per turn, so cancel and priority messages that arrived meanwhile are seen before the next page
		setTimeout(pump, 0);
	}
}

function pump(): void {
	ticking = false;
	for (const o of pendingOpens.splice(0)) {
		try { docs.set(o.doc, openDoc(new Uint8Array(o.bytes))); } catch (e) { post({ t: "openfailed", doc: o.doc, error: String(e instanceof Error ? e.message : e) }); }
	}
	queue.sort((a, b) => a.prio - b.prio);
	const job = queue.shift();
	if (job) {
		const h = docs.get(job.doc);
		try {
			if (!h) throw new Error("document not open in the render worker");
			if (job.t === "render") {
				const d = drawPage(h, job.page, job.scale, job.opts);
				post({ t: "rendered", job: job.job, width: d.width, height: d.height, pixels: d.pixels, renderMs: d.renderMs }, [d.pixels.buffer]);
			} else post({ t: "text", job: job.job, layer: pageText(h, job.page) });
		} catch (e) {
			post({ t: "error", job: job.job, error: String(e instanceof Error ? e.message : e) });
		}
	}
	schedule();
}

self.onmessage = (e: MessageEvent<In>) => {
	const m = e.data;
	switch (m.t) {
		case "open": pendingOpens.push({ doc: m.doc, bytes: m.bytes }); break;
		case "close": {
			const i = pendingOpens.findIndex((o) => o.doc === m.doc);
			if (i >= 0) pendingOpens.splice(i, 1);
			const h = docs.get(m.doc);
			if (h) { closeDoc(h); docs.delete(m.doc); }
			for (let j = queue.length - 1; j >= 0; j--) if (queue[j]!.doc === m.doc) post({ t: "cancelled", job: queue.splice(j, 1)[0]!.job });
			break;
		}
		case "render": case "text": queue.push(m); break;
		case "cancel": { const j = queue.findIndex((q) => q.job === m.job); if (j >= 0) { queue.splice(j, 1); post({ t: "cancelled", job: m.job }); } break; }
		case "prio": { const q = queue.find((x) => x.job === m.job); if (q) q.prio = m.prio; break; }
	}
	schedule();
};
