// Headless check of the reader's page layouts (View menu: vertical / horizontal / wrapped scrolling, no / odd / even spreads), the
// thumbnails' selection, and Rotate / Delete Pages. No window opens.
//   bun scripts/shot-reader-layout.tsx <key:KEY | file.pdf> <out dir> [--only layouts,menu,thumbs,ops] [--width W]
//
//   layouts   a shot per layout, with how many pages are mounted, the tiles and how much of the visible area is sharp; a wheel
//             scroll in the horizontal strip; the position kept across switches
//   menu      the View menu open
//   thumbs    Ctrl / Shift clicks in the thumbnails, and their right-click menu
//   ops       CHANGES THE FILE: rotate page 1 right, then delete pages 2 and 4 (no confirmation), then asks to delete page 1 and
//             cancels the dialog. Only for a COPY: a file path in a scratch folder, or a test attachment (key:...) that a library
//             copy points at a copied file. With a key, the annotations before / after are printed (they must follow their pages).
// Needs ZN_URL (a core on a library COPY) for a key, and ZN_PDF_DLL when the shared zn_pdf.dll predates the page edits.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createTestRoot } from "@gpuix/solid/testing";
import { apiRequest } from "../src/api";
import { registerFonts } from "../src/fonts";
import { setReaderDpr, setReaderMode } from "../src/reader/env";
import { Reader, type ReaderController } from "../src/reader/Reader";
import { PdfDoc } from "../src/reader/pdf";
import { OverlayHost } from "../src/ui";
import type { ScrollMode, SpreadMode } from "../src/reader/core/layout";

const args = process.argv.slice(2);
const val = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const pos = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")));
const [spec, OUT] = pos as [string, string];
if (!spec || !OUT) { console.error("usage: bun scripts/shot-reader-layout.tsx <key:KEY | file.pdf> <out dir> [--only layouts,menu,thumbs,ops]"); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const only = new Set(val("only", "layouts,menu,thumbs").split(","));
process.env.ZN_READER_STATE ??= "off";
setReaderDpr(1);
setReaderMode("dark");
const isPath = !spec.startsWith("key:");
const key = isPath ? "FILEPATH" : spec.slice(4);

const t = createTestRoot({ width: 1440, height: 880 });
const r = t.renderer;
registerFonts(r as never);
let ctl!: ReaderController;
t.render(() => (
	<div style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%", backgroundColor: "#141413" }}>
		<div style={{ display: "flex", flexDirection: "column", width: Number(val("width", "1200")), height: "100%", flexShrink: 0 }}>
			<Reader attachmentKey={key} path={isPath ? spec : undefined} itemKey="" title="Layout test" ephemeral={false} controller={(c) => { ctl = c; }} />
		</div>
		<OverlayHost />
	</div>
));
const pump = () => { r.flush(); r.dispatchNativeEvents(); r.flush(); };
const frame = async (ms: number) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { pump(); await Bun.sleep(16); } };
const settle = async () => { await frame(300); await ctl.idle(); await frame(300); await ctl.idle(); await frame(150); };
const shot = async (name: string) => { await settle(); const f = join(OUT, `${name}.png`); r.captureScreenshot(f); return f; };
const cov = () => {
	const c = ctl.coverage();
	const vis = c.reduce((s, x) => s + x.vis, 0) || 1;
	const sharp = c.reduce((s, x) => s + x.sharp * x.vis, 0) / vis, blank = c.reduce((s, x) => s + x.blank * x.vis, 0) / vis;
	return `visible pages ${c.map((x) => x.page + 1).join(",")} sharp ${(sharp * 100).toFixed(0)}% blank ${(blank * 100).toFixed(0)}%`;
};
const state = () => { const d = ctl.debug() as { curPage: number; rows: number; scroll: string; spread: string }; return `${d.scroll}/${d.spread} rows=${d.rows} current page ${d.curPage + 1}, ${ctl.mounted()} pages / ${ctl.tiles()} tiles mounted, ${cov()}`; };

await frame(200);
await Promise.race([ctl.ready(), Bun.sleep(20000)]);
if (ctl.error()) { console.log("error:", ctl.error()); process.exit(1); }
ctl.setSidebar(false);
await settle();
console.log(`opened: ${ctl.doc()!.pageCount} pages, zoom ${Math.round(ctl.zoom() * 100)}%`);

if (only.has("layouts")) {
	const steps: [ScrollMode, SpreadMode, string, (() => void)?][] = [
		["vertical", "none", "v-none"],
		["vertical", "odd", "v-odd"],
		["vertical", "even", "v-even"],
		["wrapped", "none", "w-none", () => ctl.setZoom(0.35)],
		["wrapped", "odd", "w-odd"],
		["horizontal", "none", "h-none", () => ctl.fitPage()],
		["horizontal", "even", "h-even"],
	];
	ctl.scrollToPage(4);
	await settle();
	for (const [s, p, name, extra] of steps) {
		const before = ctl.viewState().page;
		ctl.setLayout(s, p);
		await frame(200);
		extra?.();
		const f = await shot(`layout-${name}`);
		console.log(`${name}: page at the top before ${before + 1}, now ${ctl.viewState().page + 1}; ${state()} -> ${f}`);
	}
	// the horizontal strip scrolls sideways with the mouse wheel (no vertical overflow at fit page)
	const v0 = ctl.viewState().page;
	const dbg = () => { const d = ctl.debug() as { raw: unknown; inner: unknown; vp: unknown }; return JSON.stringify({ raw: d.raw, inner: d.inner, vp: d.vp }); };
	console.log(`before the wheel: ${dbg()}`);
	for (let i = 0; i < 6; i++) { r.nativeSimulateMouseMove(600, 450); r.nativeSimulateScrollWheel(600, 450, 0, -120); await frame(60); }
	await frame(300);
	console.log(`h-even after the wheel: page ${v0 + 1} -> ${ctl.viewState().page + 1}; ${dbg()}`);
	for (let i = 0; i < 3; i++) { r.nativeSimulateMouseMove(600, 450); r.nativeSimulateScrollWheel(600, 450, -120, 0); await frame(60); }
	await frame(300);
	console.log(`after a sideways wheel: ${dbg()}`);
	console.log(`  ${state()} -> ${await shot("layout-h-wheel")}`);
	ctl.key({ key: "right" }); await frame(300);
	console.log(`right arrow: ${state()}`);
	ctl.key({ key: "end" }); await frame(300);
	console.log(`end: ${state()} -> ${await shot("layout-h-end")}`);
	// find in the horizontal strip: the first hit comes into view
	ctl.search("Kaplan-Meier");
	for (let i = 0; i < 200 && !ctl.hits()[2]; i++) await frame(50);
	ctl.next();
	await frame(300);
	const hr = ctl.hitRows()[ctl.hits()[0] - 1];
	console.log(`search: hit ${ctl.hits()[0]}/${ctl.hits()[1]} on page ${(hr?.page ?? -1) + 1}; ${state()} -> ${await shot("layout-h-search")}`);
	ctl.search("");
	ctl.setLayout("vertical", "none");
	ctl.fitWidth();
	await settle();
	console.log(`back to vertical: ${state()}`);
}

if (only.has("menu")) {
	ctl.setLayout("vertical", "odd");
	await settle();
	const n = r.findByTestId("reader-view-menu");
	const b = n ? r.getElementBounds(n.id) : null;
	if (!b) throw new Error("no View menu button");
	const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
	r.nativeSimulateMouseMove(at.x, at.y); await frame(60);
	r.nativeSimulateClick(at.x, at.y);
	await frame(400);
	console.log(`View menu open -> ${await shot("menu-view")}`);
	r.simulateKeystrokes?.("escape");
	await frame(200);
}

if (only.has("thumbs")) {
	ctl.setLayout("vertical", "none");
	ctl.setSidebar(true, "thumbs");
	ctl.scrollToPage(0);
	await settle();
	ctl.selectPages([1, 2, 4]);
	await settle();
	console.log(`picked ${ctl.selectedPages().map((p) => p + 1)} -> ${await shot("thumbs-selected")}`);
	// right-click on the first thumbnail: it is not picked, so it becomes the selection
	r.nativeSimulateMouseMove(130, 160); await frame(60);
	r.nativeSimulateClick(130, 160, 2);
	await frame(400);
	console.log(`right-click on thumbnail 1: picked ${ctl.selectedPages().map((p) => p + 1)} -> ${await shot("thumbs-menu")}`);
	r.simulateKeystrokes?.("escape");
	await frame(200);
	// clicks: a plain click goes to the page and picks nothing (the current page counts), Ctrl adds, Shift extends
	const clickThumb = async (y: number, mods?: string) => { r.nativeSimulateMouseMove(115, y); await frame(60); r.nativeSimulateClick(115, y, 0, mods); await frame(400); };
	await clickThumb(360);
	console.log(`click thumbnail 2: picked [${ctl.selectedPages().map((p) => p + 1)}], current page ${(ctl.debug() as { curPage: number }).curPage + 1}`);
	await clickThumb(560, "ctrl");
	console.log(`ctrl+click thumbnail 3: picked [${ctl.selectedPages().map((p) => p + 1)}]`);
	await clickThumb(757, "shift");
	console.log(`shift+click thumbnail 4: picked [${ctl.selectedPages().map((p) => p + 1)}] -> ${await shot("thumbs-clicks")}`);
	await clickThumb(560, "ctrl");
	console.log(`ctrl+click thumbnail 3 again: picked [${ctl.selectedPages().map((p) => p + 1)}]`);
	ctl.selectPages([]);
	ctl.setSidebar(false);
	await settle();
}

if (only.has("ops")) {
	const annotations = async () => (isPath ? [] : ((await apiRequest<{ id: string; position: { pageIndex: number; rects?: number[][] }; sortIndex: string; pageLabel?: string }[]>("GET", `/attachments/${key}/annotations`)) ?? []));
	const showAnn = async () => (await annotations()).map((a) => `${a.id}@p${a.position.pageIndex + 1}(${a.sortIndex.slice(0, 5)},label ${a.pageLabel ?? "-"}) ${JSON.stringify(a.position.rects?.[0]?.map((n) => Math.round(n)))}`).join("; ");
	const fileInfo = async () => {
		const b = isPath ? new Uint8Array(await Bun.file(spec).arrayBuffer()) : new Uint8Array(await (await fetch(`${process.env.ZN_URL}/api/attachments/${key}/file`)).arrayBuffer());
		const d = PdfDoc.openBytes(b);
		const s = `${d.pageCount} pages, /Rotate of pages 1-4: ${[0, 1, 2, 3].map((i) => d.pageRotation(i)).join(",")}, ${b.byteLength} bytes`;
		d.close();
		return s;
	};
	ctl.setLayout("vertical", "none");
	ctl.scrollToPage(2, 0.3);
	await settle();
	console.log(`before: file ${await fileInfo()}; view ${JSON.stringify(ctl.viewState())}`);
	console.log(`  annotations: ${await showAnn()}`);
	await shot("ops-0-before");

	let t0 = performance.now();
	await ctl.rotatePages([0], 1);
	await Promise.race([ctl.ready(), Bun.sleep(10000)]);
	console.log(`rotate page 1 right: ${Math.round(performance.now() - t0)} ms; file ${await fileInfo()}; view ${JSON.stringify(ctl.viewState())}`);
	console.log(`  annotations: ${await showAnn()}`);
	ctl.scrollToPage(0);
	console.log(`  -> ${await shot("ops-1-rotated")}`);

	ctl.scrollToPage(4, 0.2);
	await settle();
	const vBefore = ctl.viewState();
	t0 = performance.now();
	await ctl.deletePages([1, 3], false);
	await Promise.race([ctl.ready(), Bun.sleep(10000)]);
	await settle();
	console.log(`delete pages 2 and 4: ${Math.round(performance.now() - t0)} ms; file ${await fileInfo()}; view ${JSON.stringify(vBefore)} -> ${JSON.stringify(ctl.viewState())} (page 5 is page 3 now)`);
	console.log(`  annotations: ${await showAnn()}`);
	console.log(`  -> ${await shot("ops-2-deleted")}`);

	// with confirmation: the dialog, then Cancel (Escape)
	const p = ctl.deletePages([0], true);
	await frame(500);
	console.log(`delete page 1 asks first -> ${await shot("ops-3-confirm")}`);
	r.simulateKeystrokes?.("escape");
	await frame(300);
	await Promise.race([p, Bun.sleep(3000)]);
	console.log(`cancelled: file ${await fileInfo()}`);
}

if (only.has("perf")) {
	// scroll through the document in every layout: mounted pages stay bounded, the visible area keeps getting sharp
	const modes: [ScrollMode, SpreadMode, number | null][] = [["vertical", "none", null], ["vertical", "odd", null], ["wrapped", "none", 0.45], ["horizontal", "none", null], ["horizontal", "odd", null]];
	for (const [s, p, z] of modes) {
		ctl.setLayout(s, p);
		if (z) ctl.setZoom(z); else if (s === "horizontal") ctl.fitPage(); else ctl.fitWidth();
		ctl.scrollToPage(0);
		await settle();
		let maxMounted = 0, maxTiles = 0, blankSum = 0, n = 0;
		const r0 = ctl.stats.renders, t0 = performance.now();
		for (let i = 0; i < 40; i++) {
			r.nativeSimulateMouseMove(600, 450);
			r.nativeSimulateScrollWheel(600, 450, 0, -90);
			await frame(33);
			const c = ctl.coverage(), vis = c.reduce((a, x) => a + x.vis, 0) || 1;
			blankSum += c.reduce((a, x) => a + x.blank * x.vis, 0) / vis; n++;
			maxMounted = Math.max(maxMounted, ctl.mounted()); maxTiles = Math.max(maxTiles, ctl.tiles());
		}
		const ms = performance.now() - t0;
		await settle();
		console.log(`${s}/${p}: 40 wheel steps in ${Math.round(ms)} ms, now at page ${ctl.viewState().page + 1}; at most ${maxMounted} pages / ${maxTiles} tiles mounted; mean blank while scrolling ${(blankSum / n * 100).toFixed(1)}%; renders +${ctl.stats.renders - r0}; at rest ${cov()}`);
	}
}

if (only.has("persist")) {
	// run twice with ZN_READER_STATE=<file>: the first run sets --set scroll/spread, the second prints what the document opened with
	const set = val("set", "");
	console.log(`opened with ${JSON.stringify(ctl.layout())}`);
	if (set) { const [s, p] = set.split("/") as [ScrollMode, SpreadMode]; ctl.setLayout(s, p); await settle(); console.log(`set ${JSON.stringify(ctl.layout())}`); }
}

if (only.has("look")) {
	// one page at "fit page" (e.g. a rotated page and its annotations): --page N (1-based)
	ctl.setLayout("vertical", "none");
	const pg = Number(val("page", "1")) - 1;
	ctl.scrollToPage(pg);
	await frame(200);
	ctl.fitPage();
	await frame(300);
	ctl.scrollToPage(pg);
	console.log(`page ${pg + 1} at fit page -> ${await shot(`look-p${pg + 1}`)}`);
}

t.unmount();
process.exit(0);
