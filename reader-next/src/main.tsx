import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import "./styles.css";
import { academicPlugin } from "./academic";
import { annotationsPlugin } from "./annotations";
import { reflowPlugin } from "./reflow";
import type { ReaderPlugin } from "./contract";
import { ViewerController } from "./viewer/controller";
import { watchReadingVars } from "./viewer/appearance";
import { watchTheme } from "./viewer/theme";
import { getEngine, PdfDoc, type OutlineNode } from "./viewer/pdf";
import { Viewer } from "./viewer/Viewer";

watchTheme(); // chrome theme (mode, colour scheme, font, size) from the app's Settings > Appearance; follows it live

const root = document.getElementById("root")!;
const params = new URLSearchParams(location.search);
const attachment = params.get("attachment");

function message(text: string) {
	root.innerHTML = "";
	const d = document.createElement("div");
	d.className = "flex h-full items-center justify-center text-sm text-muted-foreground";
	d.textContent = text;
	root.appendChild(d);
}

async function json<T>(url: string): Promise<T | null> {
	try {
		const r = await fetch(url);
		if (!r.ok) return null;
		return (await r.json()) as T;
	} catch { return null; }
}

async function boot() {
	if (!attachment) return message("No attachment specified (?attachment=KEY).");
	message("Loading…");
	watchReadingVars();
	void getEngine(); // start compiling the WASM while the bytes download
	const [bytesRes, item, viewState] = await Promise.all([
		fetch(params.get("src") ?? `/api/attachments/${attachment}/file`), // ?src= is a test hook (any URL serving a PDF)
		json<{ data: { parentItem?: string; title?: string; filename?: string } }>(`/api/items/${attachment}`),
		json<Record<string, unknown>>(`/api/attachments/${attachment}/view-state`),
	]);
	if (!bytesRes.ok) {
		// the server explains why (e.g. OneDrive could not download an online-only file)
		const why = await bytesRes.json().then((b: { error?: string }) => b.error, () => undefined);
		return message(why ?? `Could not load the file (HTTP ${bytesRes.status}).`);
	}
	const bytes = await bytesRes.arrayBuffer();
	(window as unknown as { __rnT0: number }).__rnT0 = performance.now();
	const pdfP = PdfDoc.open(bytes);
	const itemKey = item?.data.parentItem ?? null;
	const parent = itemKey ? await json<{ data: { title?: string } }>(`/api/items/${itemKey}`) : null;
	const title = parent?.data.title || item?.data.title || item?.data.filename || "Document";
	document.title = title;
	let pdf: PdfDoc;
	try { pdf = await pdfP; } catch (e) { return message(`Could not open the PDF: ${e instanceof Error ? e.message : JSON.stringify(e)}`); }

	const ctl = new ViewerController(attachment, itemKey, title, pdf);
	(window as unknown as { __rnState: unknown }).__rnState = viewState;
	(window as unknown as { __rn: unknown }).__rn = ctl;
	const [outline, setOutline] = createSignal<OutlineNode[]>([]);
	root.innerHTML = "";
	render(() => <Viewer ctl={ctl} outline={outline()} />, root);
	void pdf.outline().then(setOutline);

	// plugins get the handle once the first page has been painted
	const start = () => {
		for (const p of [academicPlugin, annotationsPlugin, reflowPlugin] as ReaderPlugin[]) {
			try { p(ctl); } catch (e) { console.error("reader plugin failed", e); }
		}
	};
	const t = setInterval(() => {
		if (ctl.firstPaintMs[0]() !== null) {
			clearInterval(t);
			console.log(`[reader-next] first page painted ${ctl.firstPaintMs[0]()} ms after bytes arrived`);
			start();
		}
	}, 16);
}

// The app shell asks an idle tab to persist everything before it unloads this frame: view state (page, zoom,
// scroll) and any pending annotation / comment edits. Reply ok only if both were accepted by the server.
window.addEventListener("message", (e: MessageEvent) => {
	if (e.source !== window.parent || e.origin !== location.origin || !e.data || e.data.type !== "zn-save-now") return;
	const w = window as unknown as { __rn?: ViewerController; __rnAnn?: { store: { flush(): Promise<void>; status(): string } } };
	void (async () => {
		let ok = true;
		try {
			if (w.__rn) ok = await w.__rn.saveNowAck();
			const ann = w.__rnAnn?.store;
			if (ann) { await ann.flush(); if (ann.status() === "error") ok = false; }
		} catch { ok = false; }
		window.parent.postMessage({ type: "zn-saved", id: e.data.id, ok }, location.origin);
	})();
});

void boot();
