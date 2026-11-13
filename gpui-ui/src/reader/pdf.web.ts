// src/reader/pdf.ts for the browser builds: the same PdfDoc interface, on PDFium compiled to WebAssembly (web/pdf-engine.ts) instead
// of zn_pdf.dll. web/build.ts uses this file wherever `./pdf` is imported (the `X.web.ts` rule). There is no page editing or printing in the browser.
//
// Where the work runs: the page keeps one copy of PDFium for the calls the reader makes synchronously (open, page sizes, rotation,
// links, outline: all cheap), and renders pages and text layers in Web Workers (web/pdf-worker.ts), each holding its own copy of
// the document, so a long or image-heavy PDF scrolls without blocking the interface. Number of workers: ?pdfworkers=N in the page's
// address (0 = render on the main thread, the old behaviour, kept for comparison and as the fallback when workers cannot start),
// default 2 (1 on a machine with fewer than 4 cores). Timings go to globalThis.znPdfStats for the headless checks.
//
// initPdfium() must have finished before a document is opened (the reader's file fetcher awaits it).
import { closeDoc, drawPage, engineReady, fn, free, geometry, heap, initEngine, malloc, openDoc, pageText, withPage, type DocHandle, type DrawOpts, type Look, type TextLayer, type TextWord } from "../../web/pdf-engine";

export type { Look, TextLayer, TextWord };

/** Timings of this page's PDF work (read by gpui-ui/web/library-pdf-check.ts). */
export const pdfStats = {
	mode: "main" as string,
	opens: [] as { bytes: number; ms: number }[],
	renders: 0,
	renderMs: [] as number[],
	/** request -> pixels back, including the time in the queue */
	latencyMs: [] as number[],
	texts: 0,
};
(globalThis as Record<string, unknown>).znPdfStats = pdfStats;

let loading: Promise<void> | null = null;
/** Load PDFium (pdfium.wasm next to the bundle) once, and start the render workers; later calls return the same promise. */
export function initPdfium(bytes?: ArrayBuffer): Promise<void> {
	loading ??= (async () => {
		startPool();
		await initEngine(bytes ?? new URL("pdfium.wasm", import.meta.url).href);
	})();
	return loading;
}

export const findDll = (): string => "pdfium.wasm";
export const pdfOpsUnavailable = (): string | null => "Page editing and printing need the desktop app.";
export const nativeVersion = (): string => "pdfium-wasm";
export const pdfiumStatus = (): string => (engineReady() ? `PDFium (WebAssembly, ${pdfStats.mode})` : "PDFium (WebAssembly) not loaded yet");
export interface PdfEdit { rotate?: { page: number; turns: number }[]; delete?: number[] }
export async function editPdf(_bytes: Uint8Array, _e: PdfEdit): Promise<Uint8Array> { throw new Error("Page editing needs the desktop app."); }
export interface PrintResult { result: "printed" | "cancelled"; pages: number; printer: string }
export async function printPdf(): Promise<PrintResult> { throw new Error("Printing needs the desktop app."); }
export async function printPdfTo(): Promise<PrintResult> { throw new Error("Printing needs the desktop app."); }

export const PRIO_BACKGROUND = 4e6;
export interface RenderOpts { rot?: number; region?: { x: number; y: number; w: number; h: number }; look?: Look; prio?: number }
export interface OutlineEntry { t: string; l: number; p: number; y: number }
export type PdfLink = { x: number; y: number; w: number; h: number } & ({ k: "page"; p: number; ty: number } | { k: "uri"; u: string });
export interface Rendered { width: number; height: number; pixels: Uint8Array; renderMs: number; slice(y: number, h: number): Uint8Array; release(): void }
export interface RenderTask { promise: Promise<Rendered | null>; cancel(): void; setPrio(prio: number): void }

const asRendered = (width: number, height: number, pixels: Uint8Array, renderMs: number): Rendered => ({
	width, height, pixels, renderMs,
	slice: (y, h) => pixels.subarray(y * width * 4, (y + Math.min(h, height - y)) * width * 4),
	release: () => {},
});
const drawOpts = (o: RenderOpts): DrawOpts => ({ rot: o.rot, region: o.region, look: o.look });

// ---- main-thread queue (no workers): one job at a time, lowest priority first, behind a timer so frames keep painting
interface Job { prio: number; run: () => void; cancelled: boolean; done: boolean }
const queue: Job[] = [];
let ticking = false;
function pump(): void {
	ticking = false;
	queue.sort((a, b) => a.prio - b.prio);
	const job = queue.shift();
	if (job && !job.cancelled) { job.done = true; job.run(); }
	if (queue.length && !ticking) { ticking = true; setTimeout(pump, 0); }
}
function enqueue(prio: number, run: () => void): Job {
	const job: Job = { prio, run, cancelled: false, done: false };
	queue.push(job);
	if (!ticking) { ticking = true; setTimeout(pump, 0); }
	return job;
}

// ---- the worker pool
interface PoolJob { resolve: (v: any) => void; reject: (e: Error) => void; worker: Slot; t0: number; retry: () => void }
interface Slot { w: Worker; docs: Set<number>; inflight: number; ready: boolean }
let pool: { slots: Slot[]; jobs: Map<number, PoolJob> } | null = null;
let nextJob = 1;

function workerCount(): number {
	let asked: string | null = null;
	try { asked = new URLSearchParams(globalThis.location?.search ?? "").get("pdfworkers"); } catch { /* no location */ }
	if (asked !== null && /^\d+$/.test(asked)) return Math.min(4, Number(asked));
	const cores = globalThis.navigator?.hardwareConcurrency ?? 4;
	return cores >= 4 ? 2 : 1;
}

/** The pool broke (a worker could not start): what was in flight runs on the main thread, and so does everything after. */
function dropPool(why: string): void {
	if (!pool) return;
	console.warn("[pdf] render workers unavailable, rendering on the main thread:", why);
	const p = pool;
	pool = null;
	pdfStats.mode = "main (workers failed)";
	for (const s of p.slots) s.w.terminate();
	for (const j of p.jobs.values()) j.retry();
	p.jobs.clear();
}

function startPool(): void {
	const n = workerCount();
	if (!n || typeof Worker === "undefined") { pdfStats.mode = "main"; return; }
	try {
		const slots: Slot[] = [];
		const jobs = new Map<number, PoolJob>();
		for (let i = 0; i < n; i++) {
			const w = new Worker(new URL("pdf-worker.js", import.meta.url), { type: "module" });
			const slot: Slot = { w, docs: new Set(), inflight: 0, ready: false };
			w.onmessage = (e: MessageEvent) => {
				const m = e.data as { t: string; job?: number; [k: string]: unknown };
				if (m.t === "ready") { slot.ready = true; return; }
				if (m.t === "failed") return dropPool(String(m.error));
				if (m.t === "openfailed") return;
				const j = m.job !== undefined ? jobs.get(m.job) : undefined;
				if (!j) return;
				jobs.delete(m.job!);
				slot.inflight--;
				if (m.t === "rendered") {
					pdfStats.renders++;
					pdfStats.renderMs.push(m.renderMs as number);
					pdfStats.latencyMs.push(performance.now() - j.t0);
					j.resolve(asRendered(m.width as number, m.height as number, new Uint8Array(m.pixels as ArrayBuffer), m.renderMs as number));
				} else if (m.t === "text") { pdfStats.texts++; j.resolve(m.layer); }
				else if (m.t === "cancelled") j.resolve(null);
				else j.reject(new Error(String(m.error)));
			};
			w.onerror = (e) => { e.preventDefault?.(); dropPool(e.message || "worker error"); };
			slots.push(slot);
		}
		pool = { slots, jobs };
		pdfStats.mode = `${n} worker${n === 1 ? "" : "s"}`;
	} catch (e) {
		pool = null;
		pdfStats.mode = "main (workers failed)";
		console.warn("[pdf] render workers could not start:", e);
	}
}

/** Send a job to the least busy worker, opening the document there first if needed. */
function poolSend<T>(doc: PdfDoc, msg: Record<string, unknown>, retry: (res: (v: T) => void, rej: (e: Error) => void) => void): { promise: Promise<T>; job: number; slot: Slot } | null {
	if (!pool) return null;
	const p = pool;
	const slot = p.slots.reduce((a, b) => (b.inflight < a.inflight ? b : a));
	if (!slot.docs.has(doc.id)) {
		const copy = doc.bytes.slice().buffer;
		slot.w.postMessage({ t: "open", doc: doc.id, bytes: copy }, [copy]);
		slot.docs.add(doc.id);
	}
	const job = nextJob++;
	slot.inflight++;
	const promise = new Promise<T>((resolve, reject) => {
		p.jobs.set(job, { resolve, reject, worker: slot, t0: performance.now(), retry: () => retry(resolve, reject) });
		slot.w.postMessage({ ...msg, job, doc: doc.id });
	});
	return { promise, job, slot };
}

let nextDocId = 1;

export class PdfDoc {
	readonly pageCount: number;
	readonly sizes: [number, number][];
	readonly id = nextDocId++;
	/** the file's bytes, sent to each worker that renders this document */
	readonly bytes: Uint8Array;
	private h: DocHandle;

	private constructor(h: DocHandle, bytes: Uint8Array) {
		this.h = h;
		this.bytes = bytes;
		this.pageCount = h.pageCount;
		this.sizes = h.sizes;
	}

	static open(path: string): PdfDoc { throw new Error(`no file system in the browser: ${path}`); }

	static openBytes(data: Uint8Array): PdfDoc {
		const t0 = performance.now();
		const d = new PdfDoc(openDoc(data), data);
		pdfStats.opens.push({ bytes: data.byteLength, ms: performance.now() - t0 });
		return d;
	}

	renderSize(page: number, scale: number): [number, number] { return this.renderSize2(page, scale, 0); }
	renderSize2(page: number, scale: number, rot = 0): [number, number] {
		const [pw, ph] = this.sizes[page] ?? [612, 792];
		const g = geometry(pw, ph, scale, rot);
		return [g.fw, g.fh];
	}

	private drawHere(page: number, scale: number, o: RenderOpts): Rendered {
		const d = drawPage(this.h, page, scale, drawOpts(o));
		pdfStats.renders++;
		pdfStats.renderMs.push(d.renderMs);
		return asRendered(d.width, d.height, d.pixels, d.renderMs);
	}

	private renderHere(page: number, scale: number, o: RenderOpts, res: (r: Rendered | null) => void, rej: (e: Error) => void): Job {
		const t0 = performance.now();
		return enqueue(o.prio ?? PRIO_BACKGROUND, () => {
			try { const r = this.drawHere(page, scale, o); pdfStats.latencyMs.push(performance.now() - t0); res(r); } catch (e) { rej(e as Error); }
		});
	}

	render(page: number, scale: number): RenderTask { return this.render3(page, scale, {}); }
	render2(page: number, scale: number, o: RenderOpts = {}): RenderTask { return this.render3(page, scale, o); }
	render3(page: number, scale: number, o: RenderOpts = {}): RenderTask {
		const prio = o.prio ?? PRIO_BACKGROUND;
		const sent = poolSend<Rendered | null>(this, { t: "render", page, scale, opts: drawOpts(o), prio }, (res, rej) => { this.renderHere(page, scale, o, res, rej); });
		if (sent) {
			let settled = false;
			let resolveNull: () => void = () => {};
			const promise = new Promise<Rendered | null>((res, rej) => {
				resolveNull = () => res(null);
				sent.promise.then((r) => { settled = true; res(r); }, (e) => { settled = true; rej(e); });
			});
			return {
				promise,
				cancel: () => { if (settled) return; settled = true; sent.slot.w.postMessage({ t: "cancel", job: sent.job }); resolveNull(); },
				setPrio: (p) => { if (!settled) sent.slot.w.postMessage({ t: "prio", job: sent.job, prio: p }); },
			};
		}
		let job!: Job;
		let resolveNull: () => void = () => {};
		const promise = new Promise<Rendered | null>((res, rej) => {
			job = this.renderHere(page, scale, o, res, rej);
			resolveNull = () => { if (!job.done) { job.cancelled = true; res(null); } };
		});
		return { promise, cancel: () => resolveNull(), setPrio: (p) => { if (!job.done) job.prio = p; } };
	}
	renderAsync(page: number, scale: number): Promise<Rendered | null> { return this.render(page, scale).promise; }
	renderSync(page: number, scale: number): Rendered { return this.drawHere(page, scale, {}); }

	pageRotation(page: number): number { return withPage(this.h, page, (p) => (fn("FPDFPage_GetRotation")(p) % 4) * 90); }
	backend(): "pdfium" | "hayro" { return "pdfium"; }
	poolSize(): number { return pool ? pool.slots.length : 1; }

	textLayer(page: number): TextLayer { return pageText(this.h, page); }
	textLayerAsync(page: number): Promise<TextLayer> {
		const here = (res: (v: TextLayer) => void, rej: (e: Error) => void) => { enqueue(PRIO_BACKGROUND / 2, () => { try { pdfStats.texts++; res(this.textLayer(page)); } catch (e) { rej(e as Error); } }); };
		const sent = poolSend<TextLayer>(this, { t: "text", page, prio: PRIO_BACKGROUND / 2 }, here);
		return sent ? sent.promise : new Promise(here);
	}

	private destOf(dest: number): { p: number; y: number } {
		const p = dest ? fn("FPDFDest_GetDestPageIndex")(this.h.doc, dest) : -1;
		if (p < 0) return { p: -1, y: -1 };
		const has = malloc(12), xy = malloc(24);
		let y = -1;
		if (fn("FPDFDest_GetLocationInPage")(dest, has, has + 4, has + 8, xy, xy + 4, xy + 8) && heap().HEAP32[(has >> 2) + 1]) {
			const ph = this.sizes[p]?.[1] ?? 792;
			y = Math.min(1, Math.max(0, (ph - heap().HEAPF32[(xy >> 2) + 1]!) / ph));
		}
		free(has); free(xy);
		return { p, y };
	}

	linksAsync(page: number): Promise<PdfLink[]> {
		return Promise.resolve().then(() => withPage(this.h, page, (p) => {
			const [pw, ph] = this.sizes[page] ?? [612, 792];
			const pos = malloc(4), link = malloc(4), rect = malloc(16);
			heap().HEAP32[pos >> 2] = 0;
			const out: PdfLink[] = [];
			while (fn("FPDFLink_Enumerate")(p, pos, link)) {
				const l = heap().HEAP32[link >> 2]!;
				if (!fn("FPDFLink_GetAnnotRect")(l, rect)) continue;
				const f = heap().HEAPF32, i = rect >> 2;
				const left = f[i]!, top = f[i + 1]!, right = f[i + 2]!, bottom = f[i + 3]!;
				const box = { x: Math.min(left, right) / pw, y: (ph - Math.max(top, bottom)) / ph, w: Math.abs(right - left) / pw, h: Math.abs(top - bottom) / ph };
				let dest = fn("FPDFLink_GetDest")(this.h.doc, l);
				const action = fn("FPDFLink_GetAction")(l);
				if (!dest && action) {
					const type = fn("FPDFAction_GetType")(action);
					if (type === 3) { // URI
						const n = fn("FPDFAction_GetURIPath")(this.h.doc, action, 0, 0);
						const b = malloc(n);
						fn("FPDFAction_GetURIPath")(this.h.doc, action, b, n);
						const u = heap().UTF8ToString(b);
						free(b);
						if (u) out.push({ ...box, k: "uri", u });
						continue;
					}
					if (type === 1) dest = fn("FPDFAction_GetDest")(this.h.doc, action);
				}
				if (dest) { const d = this.destOf(dest); if (d.p >= 0) out.push({ ...box, k: "page", p: d.p, ty: d.y }); }
			}
			free(pos); free(link); free(rect);
			return out;
		}));
	}

	outlineAsync(): Promise<OutlineEntry[]> {
		return Promise.resolve().then(() => {
			const out: OutlineEntry[] = [];
			const walk = (bm: number, level: number) => {
				for (let b = bm; b; b = fn("FPDFBookmark_GetNextSibling")(this.h.doc, b)) {
					const n = fn("FPDFBookmark_GetTitle")(b, 0, 0);
					const buf = malloc(n);
					fn("FPDFBookmark_GetTitle")(b, buf, n);
					const t = heap().UTF16ToString(buf);
					free(buf);
					let dest = fn("FPDFBookmark_GetDest")(this.h.doc, b);
					if (!dest) { const a = fn("FPDFBookmark_GetAction")(b); if (a && fn("FPDFAction_GetType")(a) === 1) dest = fn("FPDFAction_GetDest")(this.h.doc, a); }
					const d = this.destOf(dest);
					out.push({ t, l: level, p: d.p, y: d.y });
					walk(fn("FPDFBookmark_GetFirstChild")(this.h.doc, b), level + 1);
				}
			};
			walk(fn("FPDFBookmark_GetFirstChild")(this.h.doc, 0), 0);
			return out;
		});
	}

	clearCache(): void {}
	close(): void {
		if (!this.h.doc) return;
		closeDoc(this.h);
		if (pool) for (const s of pool.slots) if (s.docs.delete(this.id)) s.w.postMessage({ t: "close", doc: this.id });
	}
}
