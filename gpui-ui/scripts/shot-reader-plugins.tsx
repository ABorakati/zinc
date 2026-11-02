// Headless screenshots of the reader plugins (annotations, academic, reflow) over a stub ReaderContext on a PdfDoc, so they can be
// checked without the reader core's hosting. No window opens; nothing touches the user's screen.
//   bun scripts/shot-reader-plugins.tsx <attachment key | file.pdf> [--out DIR] [--only a,b,c] [--light] [--page N] [--keep]
// scenarios (default all): annotations, academic, figures, references, reflow
// Annotations are written through the core API (ZN_URL, default http://127.0.0.1:23160, a COPY of the library) and deleted again at
// the end unless --keep. Shots: <out>/plugins-<scenario>[-step].png (default out: the scratchpad's reader-shots).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createMemo, createSignal, For, Show, type Accessor, type JSX } from "solid-js";
import { createTestRoot } from "@gpuix/solid/testing";
import { apiRequest } from "../src/api";
import { registerFonts } from "../src/fonts";
import { kit } from "../src/reader/structure/kit";
import { setReaderDpr, setReaderMode } from "../src/reader/env";
import { fetchAttachment } from "../src/reader/library";
import { PdfDoc } from "../src/reader/pdf";
import { readerPlugins, type NRect, type ReaderContext, type ReaderPlugin, type Word } from "../src/reader/plugins";
import { register } from "../src/reader/register";
import { academicFor } from "../src/reader/academic/session";
import { sessionFor } from "../src/reader/annotations/session";
import { shutdownStructureWorker } from "../src/reader/structure/load";
import { OverlayHost } from "../src/ui";

const args = process.argv.slice(2);
const val = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const has = (n: string) => args.includes(`--${n}`);
const spec = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && ["out", "only", "page"].includes(args[i - 1]!.slice(2))));
if (!spec) { console.error("usage: bun scripts/shot-reader-plugins.tsx <attachment key | file.pdf> [--out DIR] [--only annotations,academic,figures,references,reflow] [--light]"); process.exit(2); }
const OUT = val("out", "C:/Users/abora/AppData/Local/Temp/claude/C--Users-abora-Hecate/0719cea7-1eb3-4344-a1e4-a862c3bde6eb/scratchpad/reader-shots");
mkdirSync(OUT, { recursive: true });
const only = new Set(val("only", "annotations,academic,figures,references,reflow").split(","));
const MODE = has("light") ? "light" : "dark";
setReaderDpr(1);
setReaderMode(MODE);

// ---- the document
const isKey = /^[A-Z0-9]{8}$/.test(spec);
const bytes = isKey ? await fetchAttachment(spec) : new Uint8Array(await Bun.file(spec).arrayBuffer());
const doc = PdfDoc.openBytes(bytes);
const KEY = isKey ? spec : "TESTPDF1";
const layers = new Map<number, Promise<{ words: Word[] }>>();

const [sel, setSel] = createSignal<{ page: number; text: string; rects: NRect[] } | null>(null);
const [alt, setAlt] = createSignal<string | null>(null);
const [curPage, setCurPage] = createSignal(Number(val("page", "0")));
const [mode] = createSignal<"light" | "dark">(MODE);
let pageBox: { id: number } | undefined;
const t = createTestRoot({ width: 1440, height: 880 });
const r = t.renderer;
const scrolls: [number, number][] = [];

const ctx: ReaderContext = {
	attachmentKey: KEY,
	itemKey: isKey ? ((await apiRequest<{ parentItem?: string }>("GET", `/items/${KEY}`).catch(() => ({}) as { parentItem?: string })).parentItem ?? "") : "",
	pageCount: () => doc.pageCount,
	pageSize: (i) => ({ w: doc.sizes[i]![0], h: doc.sizes[i]![1] }),
	textLayer: (i) => {
		let p = layers.get(i);
		if (!p) { p = doc.textLayerAsync(i).then((l) => ({ words: l.words })); layers.set(i, p); }
		return p;
	},
	pdfBytes: async () => bytes,
	currentPage: curPage,
	zoom: () => 1,
	scrollTo: (page, y) => { scrolls.push([page, y ?? -1]); setCurPage(page); },
	selection: sel,
	clearSelection: () => setSel(null),
	altView: alt,
	setAltView: setAlt,
	mode,
	rectToWindow: (page, nr) => {
		const b = pageBox ? r.getElementBounds(pageBox.id) : null;
		return b ? { x: b.x + nr.x * b.width, y: b.y + nr.y * b.height, width: nr.w * b.width, height: nr.h * b.height } : null;
	},
	openUrl: () => true,
	copy: () => true,
};

register();
const plugins = (): ReaderPlugin[] => readerPlugins();
const panelId = createSignal<string>("annotations");
const [panel, setPanel] = panelId;

// ---- the stub reader chrome: side panel | (toolbar / page or alternate view)
const PAGE_W = 620;
function PageView(p: { page: number }): JSX.Element {
	const size = ctx.pageSize(p.page);
	const h = Math.round((PAGE_W * size.h) / size.w);
	let img: { mounted: boolean; setImagePixels(w: number, h: number, b: Uint8Array, o?: { format?: "rgba" | "bgra" }): void } | undefined;
	void doc.renderAsync(p.page, (PAGE_W * 1) / size.w).then(async (rd) => {
		if (!rd) return;
		for (let i = 0; i < 100 && !(img && img.mounted); i++) await Bun.sleep(8);
		img?.setImagePixels(rd.width, rd.height, rd.pixels, { format: "bgra" });
		rd.release();
	});
	const box: Accessor<{ width: number; height: number }> = () => ({ width: PAGE_W, height: h });
	return (
		<div ref={(el: { id: number }) => { pageBox = el; }} style={{ position: "relative", width: PAGE_W, height: h, flexShrink: 0, backgroundColor: "#ffffff" }}>
			<img ref={(el) => { img = el as never; }} objectFit="fill" style={{ position: "absolute", left: 0, top: 0, width: PAGE_W, height: h }} />
			<For each={plugins()}>
				{(pl) => (
					<Show when={pl.pageOverlay}>
						<div style={{ position: "absolute", left: 0, top: 0, width: PAGE_W, height: h, pointerEvents: "none" }}>{pl.pageOverlay!(ctx, p.page, box)}</div>
					</Show>
				)}
			</For>
		</div>
	);
}

function Chrome(): JSX.Element {
	const k = kit(mode);
	const panels = createMemo(() => plugins().filter((p) => p.sidePanel).map((p) => p.sidePanel!));
	const cur = createMemo(() => panels().find((s) => s.id === panel()));
	const altPlugin = createMemo(() => plugins().find((p) => p.altView && p.altView.id === alt()));
	return (
		<div style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%", backgroundColor: k.tok("background") }}>
			<div style={{ ...k.t("flex flex-col border-r bg-card"), width: 340, flexShrink: 0, height: "100%", minHeight: 0 }}>
				<Show when={cur()}>{cur()!.render(ctx)}</Show>
			</div>
			<div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0, height: "100%" }}>
				<div style={{ ...k.t("flex h-10 flex-none flex-row items-center border-b bg-card px-2"), gap: 8 }}>
					<text style={{ ...k.tx("text-[13px] font-medium text-foreground"), whiteSpace: "nowrap" }}>Stub reader</text>
					<For each={plugins()}>{(pl) => <Show when={pl.toolbar}>{pl.toolbar!(ctx)}</Show>}</For>
				</div>
				<Show
					when={altPlugin()}
					fallback={
						<div style={{ ...k.t("flex flex-row justify-center bg-muted"), flexGrow: 1, minHeight: 0, paddingTop: 12 }}>
							<PageView page={curPage()} />
							<Show when={sel() && plugins().find((p) => p.selectionPopup)}>
								<div style={{ position: "absolute", left: 360, top: 330 }}>
									<div style={{ ...k.t("flex rounded-lg border bg-popover p-2"), boxShadow: [{ offsetX: 0, offsetY: 6, blurRadius: 14, spreadRadius: -2, color: "rgba(0, 0, 0, 0.3)" }] }}>
										<For each={plugins().filter((p) => p.selectionPopup)}>{(pl) => pl.selectionPopup!(ctx)}</For>
									</div>
								</div>
							</Show>
						</div>
					}
				>
					{altPlugin()!.altView!.render(ctx)}
				</Show>
			</div>
			<OverlayHost />
		</div>
	);
}

registerFonts(r);
t.render(() => <Chrome />);

// ---- driving helpers
const pump = () => { r.flush(); r.dispatchNativeEvents(); r.flush(); };
const frame = async (ms: number) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { pump(); await Bun.sleep(16); } };
const shot = async (name: string, wait = 400) => {
	await frame(wait);
	const file = join(OUT, `plugins-${name}.png`);
	r.captureScreenshot(file);
	console.log("shot", file);
};
async function until(cond: () => boolean, ms = 20000, what = "condition"): Promise<boolean> {
	const t0 = performance.now();
	while (performance.now() - t0 < ms) { pump(); if (cond()) return true; await Bun.sleep(30); }
	console.warn(`timeout waiting for ${what}`);
	return false;
}

/** The words of a text line of the page that look like prose (>= minWords words), as a selection. */
async function pickSelection(page: number, from: number, count: number): Promise<{ page: number; text: string; rects: NRect[] }> {
	const { words } = await ctx.textLayer(page);
	const byLine = new Map<number, Word[]>();
	for (const w of words) { const l = byLine.get(w.l) ?? []; l.push(w); byLine.set(w.l, l); }
	const lines = [...byLine.values()].filter((l) => l.length >= 7).slice(from, from + count);
	const ws = lines.flat();
	return { page, text: ws.map((w) => w.t).join(" "), rects: ws.map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h })) };
}

const created: string[] = [];
try {
	await frame(300);

	// ------------------------------------------------------------------------------------------ annotations
	if (only.has("annotations")) {
		setPanel("annotations");
		const s = sessionFor(ctx);
		await until(() => s.store.loaded(), 8000, "annotations to load");
		const before = s.store.list().length;
		console.log(`annotations loaded: ${before}`);
		// select a few lines and show the selection popup
		const page = curPage();
		setSel(await pickSelection(page, 3, 2));
		await shot("annotations-selection");
		// highlight (yellow), a second selection underlined, a third highlighted with a comment, and a note
		const a1 = await s.act.fromSelection("highlight", "#ffd400");
		setSel(await pickSelection(page, 8, 1));
		const a2 = await s.act.fromSelection("underline", "#2ea8e5");
		setSel(await pickSelection(page, 12, 3));
		const a3 = await s.act.fromSelection("highlight", "#5fb236", { comment: true });
		if (a3) s.store.update(a3.id, { comment: "Check this against the supplementary table.", tags: [{ name: "to-read" }] });
		const a4 = await s.act.placeNote(page, 0.8, 0.12, "#ff6666");
		s.store.update(a4.id, { comment: "Margin note placed by the note tool." });
		for (const a of [a1, a2, a3, a4]) if (a) created.push(a.id);
		console.log(`created ${created.length} annotations`);
		s.ui.select(a1?.id ?? null);
		await shot("annotations", 600);
		// select one by clicking its handle (real hit testing)
		s.ui.select(null);
		await frame(200);
		const b = pageBox ? r.getElementBounds(pageBox.id) : null;
		if (b && a3) {
			const rr = a3.position.rects![0]!;
			const size = ctx.pageSize(page);
			const hx = b.x + (rr[0] / size.w) * b.width - 13 + 5, hy = b.y + (1 - rr[3] / size.h) * b.height + 2 + 5;
			r.nativeSimulateClick(hx, hy);
			await frame(300);
			console.log(`clicked the handle at ${hx.toFixed(0)},${hy.toFixed(0)}: selected=${s.ui.selectedId() === a3.id}`);
		}
		await shot("annotations-popup", 500);
		// colour filter + persisted state
		await s.store.flush();
		const server = await apiRequest<unknown[]>("GET", `/attachments/${KEY}/annotations`);
		console.log(`saved on the core: ${server.length} annotations (status ${s.store.status()})`);
		s.ui.select(null);
		s.ui.setTool("note");
		await shot("annotations-notetool", 300);
		s.ui.setTool(null);
	}

	// ------------------------------------------------------------------------------------------ academic
	if (only.has("academic") || only.has("figures") || only.has("references")) {
		const s = academicFor(ctx);
		const t0 = performance.now();
		await s.start();
		console.log(`structure ${s.struct().phase} in ${Math.round(performance.now() - t0)} ms: ${s.structure().blocks.length} blocks, ${s.figItems().length} figure/table entries, ${s.structure().references.length} references; refStart=${JSON.stringify(s.refStart())}`);
		if (only.has("academic")) {
			setPanel("figures-tables");
			// find a page with a citation and click it
			let cited = -1;
			for (let i = 0; i < doc.pageCount && cited < 0; i++) {
				const pt = await s.pageText(i);
				if (/\[\d+(?:[,\u2013-]\s*\d+)*\]/.test(pt.text) || /\b(?:Figure|Table)\s+\d/.test(pt.text)) cited = i;
			}
			console.log(`first page with citations / mentions: ${cited}`);
			setCurPage(cited >= 0 ? cited : 0);
			await frame(800);
			await shot("academic-page", 800);
			const bb = pageBox ? r.getElementBounds(pageBox.id) : null;
			// hover / click the first hot area: find it from the text
			const pt = await s.pageText(curPage());
			const size = ctx.pageSize(curPage());
			const m = /\[\d+(?:[,\u2013-]\s*\d+)*\]/.exec(pt.text) ?? /\b(?:Figure|Table)\s+\d/.exec(pt.text);
			if (m && bb) {
				const rc = pt.rects[m.index + 1]!;
				const x = bb.x + ((rc[0] + rc[2]) / 2 / size.w) * bb.width, y = bb.y + (1 - (rc[1] + rc[3]) / 2 / size.h) * bb.height;
				console.log(`hover "${m[0]}" at ${x.toFixed(0)},${y.toFixed(0)}`);
				r.nativeSimulateMouseMove(x, y);
				await frame(700);
				console.log(`after hover: popup=${s.popup()?.key ?? "none"}`);
				await shot("academic-hover", 600);
				r.nativeSimulateClick(x, y);
				await until(() => !!s.popup(), 4000, "popup");
				console.log(`after click: popup=${s.popup()?.key ?? "none"} pinned=${s.popup()?.pinned}`);
				await frame(1500);
				await shot("academic-popover", 800);
			}
		}
		if (only.has("figures")) { setPanel("figures-tables"); setCurPage(0); await shot("figures", 2500); }
		if (only.has("references")) { setPanel("references"); await frame(500); await shot("references", 2500); }
	}

	// ------------------------------------------------------------------------------------------ reflow
	if (only.has("reflow")) {
		setAlt("reflow");
		await until(() => academicFor(ctx).struct().phase === "ready", 60000, "structure");
		await shot("reflow", 2500);
		// click an in-text citation of the reading view: the reference popover opens (CHARMS: "[1-3]" in the first paragraph)
		const cx = Number(val("cite-x", "985")), cy = Number(val("cite-y", "578"));
		r.nativeSimulateMouseMove(cx, cy);
		r.nativeSimulateClick(cx, cy);
		await frame(2000);
		await shot("reflow-citation", 600);
		r.nativeSimulateClick(900, 860); // dismiss
		await frame(300);
		// the settings panel (the "Aa" chip), then the sepia and dark themes with a larger size
		r.nativeSimulateClick(1403, 60);
		await frame(400);
		await shot("reflow-settings", 600);
		const { setReflowSettings } = await import("../src/reader/reflow");
		setReflowSettings({ theme: "sepia", font: "georgia", size: 20, width: 720 });
		await shot("reflow-sepia", 600);
		setReflowSettings({ theme: "dark", font: "inter", size: 17 });
		r.nativeSimulateScrollWheel(1000, 500, 0, -Number(val("scroll", "2600"))); // down to a figure / table
		await shot("reflow-dark-scrolled", 1500);
		setReflowSettings({ theme: "light", font: "source-serif", size: 17, width: 680 });
		ctx.setAltView("reflow");
	}
} finally {
	if (!has("keep") && created.length) {
		await apiRequest("DELETE", `/attachments/${KEY}/annotations`, { ids: created }).catch((e) => console.warn("cleanup failed:", e.message));
		console.log(`removed ${created.length} test annotations again`);
	}
	shutdownStructureWorker();
	doc.close();
	process.exit(0);
}
