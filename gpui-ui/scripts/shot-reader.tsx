// Headless screenshot of the native PDF Reader inside a container (no window opens).
//   bun scripts/shot-reader.tsx <key:ATTACHMENTKEY | ATTACHMENTKEY | file.pdf> [out.png] [options]
//     --width W         container width in px (default 1000; the test window is ~1440x880 whatever is asked)
//     --page N          scroll to page N (0-based) before the shot
//     --zoom Z          start at a custom zoom (1 = 100%) instead of fit-width
//     --zoom-after Z    then change the zoom through the controller (what the +/- buttons do)
//     --fit-after       then press "fit width"
//     --fit-page        then press "fit page"
//     --hscroll PX      then pan right by PX with the (simulated) wheel
//     --resize W        then resize the container to W px (the reader must refit and re-render)
//     --search TEXT     type a search (hits are highlighted); --next N then steps to the next hit N times
//     --start-inactive  create the reader with active=false, check nothing is opened, then activate it
//     --cycle           toggle active=false -> true after the first render (bitmaps must be freed, then restored in place)
//     --debug-words     outline every word rect of the text layer
//     --dpr D           device pixel ratio for the bitmaps (default 1)
//     --light           light theme (default dark)
//     --sidebar TAB     open the sidebar on thumbs | outline | find (default: closed in the shot unless given)
//     --rotate DEG      rotate the document (90 / 180 / 270)
//     --appearance A    dark | sepia | custom | normal
//     --select a:w:c,b:w:c   select from (page a, word w, char c) to (page b, word w, char c) through the controller
//     --drag x1,y1,x2,y2     drag-select with the (simulated) mouse, window px of the test window
//     --copy            after a selection, copy it and print what the system clipboard holds
//     --links           print the links of the pages on screen, then click the first internal one
//     --wheel DY[,ctrl] simulate wheel events over the pages (GPUI: negative DY = scroll down); "ctrl" holds Ctrl (zoom)
//     --click X,Y[;X,Y...]  click at window px (e.g. a toolbar button)
//     --persist FILE    keep the reader's view state in FILE (run twice to see page / zoom / rotation restored)
//     --wait MS         wait this long (pumping frames) before the shot
//     --demo-plugin     register a demo plugin (toolbar item, sidebar panel, page overlay, selection popup, alternate view, onOpen) and show it
//     --alt             with --demo-plugin: switch to the plugin's alternate view for the shot
//     --early MS        screenshot MS after the document opened WITHOUT waiting for the tiles (a page mid-load shows paper / its preview, never "img: no src"); --page N scrolls there first
//     --keys K,K,...    send keys (names as the controller takes them: pagedown, home, ctrl+=, ...)
// Prints per-tile render timings and how many tiles / pages are mounted. Needs a core (ZN_URL, default http://127.0.0.1:23160) for keys.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createSignal } from "solid-js";
import { createTestRoot } from "@gpuix/solid/testing";
import { setReaderDpr, setReaderMode } from "../src/reader/env";
import { setReaderAppearance } from "../src/reader/core/appearance";
import { pasteText } from "../src/reader/core/sys";
import { Reader, type ReaderController } from "../src/reader/Reader";
import { registerReaderPlugin } from "../src/reader/plugins";

const args = process.argv.slice(2);
const VALUE_OPTS = new Set(["width", "page", "zoom", "zoom-after", "hscroll", "resize", "search", "next", "dpr", "sidebar", "rotate", "appearance", "select", "drag", "keys", "wheel", "realkeys", "wait", "click", "persist", "early"]);
const val = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const has = (n: string) => args.includes(`--${n}`);
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && VALUE_OPTS.has(args[i - 1]!.slice(2))));
const spec = positional[0];
if (!spec) { console.error("usage: bun scripts/shot-reader.tsx <key:KEY | file.pdf> [out.png] [--width W] [--page N] [--zoom Z] [--search TEXT] ..."); process.exit(2); }
const out = positional[1] ?? "reader.png";
const width = Number(val("width", "1000"));
const dpr = Number(val("dpr", "1"));
setReaderDpr(dpr);
setReaderMode(has("light") ? "light" : "dark");
// the view state file is not touched unless --persist FILE says where (then the reader remembers page / zoom / rotation across runs)
process.env.ZN_READER_STATE = val("persist", "off");

const isPath = /[\\/.]/.test(spec) && !spec.startsWith("key:");
const key = spec.startsWith("key:") ? spec.slice(4) : spec;

if (has("demo-plugin")) {
	registerReaderPlugin({
		id: "demo",
		onOpen: (c) => { console.log(`[demo plugin] onOpen: attachment ${c.attachmentKey}, ${c.pageCount()} pages, page 1 is ${JSON.stringify(c.pageSize(0))} pt`); return () => console.log("[demo plugin] closed"); },
		toolbar: (c) => <div style={{ display: "flex", height: 28, alignItems: "center", paddingLeft: 8, paddingRight: 8, backgroundColor: "#7BA3E6", borderRadius: 6 }}><text style={{ color: "#101010", fontSize: 12 }}>{`demo p${c.currentPage() + 1}`}</text></div>,
		sidePanel: { id: "demo", label: "Demo panel", icon: "sticky-note", render: (c) => <div style={{ padding: 12 }}><text style={{ color: "#dddddd", fontSize: 12 }}>{`plugin side panel: ${c.pageCount()} pages, zoom ${Math.round(c.zoom() * 100)}%`}</text></div> },
		pageOverlay: (_c, page, box) => page === 0 ? <div style={{ position: "absolute", left: box().width * 0.1, top: box().height * 0.5, width: box().width * 0.3, height: 26, backgroundColor: "rgba(255, 200, 0, 0.45)" }} /> : <div />,
		selectionPopup: (c) => <div onClick={() => { console.log(`[demo plugin] highlight ${JSON.stringify(c.selection()?.text.slice(0, 40))} pages=${c.selection()?.pages?.length}`); c.clearSelection(); }} style={{ display: "flex", height: 28, alignItems: "center", paddingLeft: 8, paddingRight: 8, backgroundColor: "#ffd400", borderRadius: 6, cursor: "pointer" }}><text style={{ color: "#101010", fontSize: 12 }}>Highlight</text></div>,
		altView: { id: "demo-alt", label: "Demo view", icon: "book-open", render: (c) => <div style={{ flexGrow: 1, padding: 24, backgroundColor: "#1d1d1b" }}><text style={{ color: "#eeeeee", fontSize: 18 }}>{`alternate view of ${c.attachmentKey}; page ${c.currentPage() + 1}`}</text></div> },
	});
}

const [w, setW] = createSignal(width);
const [active, setActive] = createSignal(!has("start-inactive"));
const t = createTestRoot({ width: 1440, height: 880 });
let ctl!: ReaderController;
t.render(() => (
	<div style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%", backgroundColor: "#141413" }}>
		<div style={{ display: "flex", flexDirection: "column", width: w(), height: "100%", flexShrink: 0 }}>
			<Reader
				attachmentKey={isPath ? "FILEPATH" : key}
				itemKey=""
				ephemeral={val("persist", "off") === "off"}
				path={isPath ? spec : undefined}
				title="A Neural Network Approach to Predict Acute Allograft Rejection in Liver Transplant Recipients"
				active={active()}
				dpr={dpr}
				zoom={val("zoom", "") ? Number(val("zoom", "1")) : undefined}
				debugWords={has("debug-words")}
				controller={(c) => { ctl = c; }}
			/>
		</div>
	</div>
));
const r = t.renderer;
// the test renderer only delivers native events (onLayout, onVisibleRange, ...) when asked; the real window's loop does it itself
const pump = () => { r.flush(); r.dispatchNativeEvents(); r.flush(); };
const frame = async (ms: number) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { pump(); await Bun.sleep(16); } };
const settle = async (min = 1) => {
	const t0 = performance.now();
	while (performance.now() - t0 < 20000) { pump(); await ctl.idle(); await Bun.sleep(30); pump(); if (ctl.stats.renders >= min || ctl.error()) break; }
	await frame(400);
	await ctl.idle();
	await frame(200);
};
const mounted = () => `${ctl.tiles()} tiles on ${ctl.mounted()} pages`;
const vis = () => ctl.visible().map((x) => x.toFixed(2)).join(",");
const parseCaret = (s: string) => { const [p, wd, c] = s.split(":").map(Number); return { page: p!, w: wd!, c: c! }; };

await frame(150);
if (has("start-inactive")) {
	// a reader created inactive (a background tab) must not open the PDF or mount a page
	await frame(500);
	console.log(`started inactive: doc=${ctl.doc() ? "open" : "none"}, ${mounted()}`);
	setActive(true);
}
await Promise.race([ctl.ready(), Bun.sleep(15000)]);
if (ctl.error()) {
	await frame(500);
	console.log("error state:", ctl.error());
} else if (Number(val("early", "0")) > 0) {
	// the state of a page mid-load: tiles exist but have no pixels yet
	const pg = Number(val("page", "0"));
	if (pg > 0) ctl.scrollToPage(pg);
	await frame(Number(val("early", "0")));
	console.log("early:", ctl.coverage().map((c) => "p" + c.page + " blank " + c.blank.toFixed(2) + " soft " + c.soft.toFixed(2) + " sharp " + c.sharp.toFixed(2) + " noSrc " + c.noSrc).join(" | "), "previews", JSON.stringify(ctl.previews()));
	mkdirSync(dirname(out), { recursive: true });
	r.captureScreenshot(out);
	console.log("wrote", out);
	t.unmount();
	process.exit(0);
} else {
	await frame(150);
	const sb = val("sidebar", "");
	if (sb && sb !== "off") ctl.setSidebar(true, sb); else ctl.setSidebar(false);
	const ap = val("appearance", "");
	if (ap) setReaderAppearance({ mode: ap as never, custom: "#e8f0e0" });
	const rot = Number(val("rotate", "0"));
	if (rot) ctl.rotate(rot);
	await frame(150);
	const page = Number(val("page", "0"));
	if (page > 0) { ctl.scrollToPage(page); await frame(150); }
	await settle();
	console.log(`pages=${ctl.doc()!.pageCount} zoom=${Math.round(ctl.zoom() * 100)}% dpr=${ctl.dpr()} ${mounted()} renders=${ctl.stats.renders} lastRender=${ctl.stats.lastRenderMs.toFixed(1)}ms upload=${ctl.stats.lastUploadMs.toFixed(2)}ms visible=${vis()}`);

	// controller zoom (the +/- buttons) / fit
	const zAfter = Number(val("zoom-after", "0"));
	if (zAfter > 0 || has("fit-after") || has("fit-page")) {
		const before = ctl.stats.renders, t1 = performance.now();
		if (zAfter > 0) ctl.setZoom(zAfter); else if (has("fit-page")) ctl.fitPage(); else ctl.fitWidth();
		while (performance.now() - t1 < 15000) { pump(); await Bun.sleep(30); if (ctl.stats.renders > before) { await ctl.idle(); break; } }
		await settle(before + 1);
		console.log(`zoom -> ${Math.round(ctl.zoom() * 100)}%: first new bitmap after ${Math.round(performance.now() - t1)} ms (includes the 140 ms debounce), renders +${ctl.stats.renders - before}, cancelled=${ctl.stats.cancelled}, ${mounted()}, peak tiles ${ctl.stats.peakTiles}, visible=${vis()}`);
		await frame(500);
	}
	// horizontal pan with the wheel (a zoomed-in page is wider than the container)
	const hs = Number(val("hscroll", "0"));
	if (hs !== 0) {
		r.nativeSimulateScrollWheel(500, 400, -hs, 0);
		await frame(500);
		await settle();
		console.log(`hscroll ${hs}: ${mounted()}`);
	}
	// container resize
	const rw = Number(val("resize", "0"));
	if (rw > 0) {
		const before = ctl.stats.renders, t1 = performance.now();
		setW(rw);
		while (performance.now() - t1 < 15000) { pump(); await Bun.sleep(30); if (ctl.stats.renders > before) { await ctl.idle(); break; } }
		console.log(`resize ${width} -> ${rw}: zoom ${Math.round(ctl.zoom() * 100)}%, new bitmap after ${Math.round(performance.now() - t1)} ms, renders +${ctl.stats.renders - before}, visible=${vis()}`);
		await frame(500);
	}
	// real key events through GPUI's input pipeline: a click gives the reader the focus, then keystrokes (space separated, "ctrl-=" style)
	const rk = val("realkeys", "");
	if (rk) {
		r.nativeSimulateMouseMove(700, 400); await frame(60); r.nativeSimulateClick(700, 400); await frame(200);
		for (const k of rk.split(" ").filter(Boolean)) {
			const v0 = JSON.stringify(ctl.viewState());
			r.simulateKeystrokes(k);
			await frame(300); await settle();
			console.log(`real key ${k}: ${v0} -> ${JSON.stringify(ctl.viewState())}`);
		}
	}
	for (const c of val("click", "").split(";").filter(Boolean)) {
		const [cx, cy] = c.split(",").map(Number) as [number, number];
		r.nativeSimulateMouseMove(cx, cy); await frame(60);
		r.nativeSimulateClick(cx, cy);
		await frame(400); await settle();
		console.log(`clicked ${cx},${cy}: ${JSON.stringify(ctl.viewState())}`);
	}
	// wheel
	const wh = val("wheel", "");
	if (wh) {
		const [dy, mod] = wh.split(":");
		const v0 = JSON.stringify(ctl.viewState());
		for (let i = 0; i < 5; i++) { r.nativeSimulateMouseMove(500, 400); r.nativeSimulateScrollWheel(500, 400, 0, Number(dy), mod === "ctrl" ? "ctrl" : undefined); await frame(80); }
		await frame(900); await settle(); await frame(600); await ctl.idle(); await frame(300);
		console.log(`wheel ${wh}: ${v0} -> ${JSON.stringify(ctl.viewState())} ${mounted()}`);
		console.log("debug", JSON.stringify(ctl.debug()));
	}
	// keys
	for (const k of val("keys", "").split(",").filter(Boolean)) {
		const parts = k.toLowerCase().split("+");
		ctl.key({ key: parts[parts.length - 1]!, ctrl: parts.includes("ctrl"), shift: parts.includes("shift"), alt: parts.includes("alt") });
		await frame(250);
		await settle();
		console.log(`key ${k}: zoom ${Math.round(ctl.zoom() * 100)}% visible=${vis()} ${mounted()}`);
	}
	// search
	const q = val("search", "");
	if (q) {
		ctl.search(q);
		const t1 = performance.now();
		while (performance.now() - t1 < 60000) { pump(); await Bun.sleep(30); if (ctl.hits()[2]) break; }
		await ctl.idle();
		await frame(400);
		const [c, n] = ctl.hits();
		console.log(`search "${q}": ${n} hits, current ${c}, scan ${Math.round(performance.now() - t1)} ms, visible=${vis()}`);
		console.log("  first rows:", JSON.stringify(ctl.hitRows().slice(0, 2)));
		const steps = Number(val("next", "0"));
		for (let i = 0; i < steps; i++) { ctl.next(); await frame(300); await ctl.idle(); }
		if (steps > 0) { await frame(300); console.log(`after next x${steps}: current ${ctl.hits()[0]}/${ctl.hits()[1]}, visible=${vis()}`); }
	}
	// selection through the controller
	const sel = val("select", "");
	if (sel) {
		const [a, b] = sel.split(",");
		await ctl.select(parseCaret(a!), parseCaret(b!));
		await frame(300);
		console.log(`selected ${JSON.stringify(ctl.selectedText())}`);
	}
	// selection with the mouse
	const dg = val("drag", "");
	if (dg) {
		const [x1, y1, x2, y2] = dg.split(",").map(Number) as [number, number, number, number];
		r.nativeSimulateMouseMove(x1, y1);
		await frame(60);
		r.nativeSimulateMouseDown(x1, y1, 0);
		await frame(120);
		const steps = 8;
		for (let i = 1; i <= steps; i++) { r.nativeSimulateMouseMove(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps, 0); await frame(40); }
		r.nativeSimulateMouseUp(x2, y2, 0);
		await frame(500);
		console.log(`drag selection: ${JSON.stringify(ctl.selectedText())}`);
	}
	if (has("copy")) {
		const ok = ctl.copySelection();
		console.log(`copy -> ${ok}, clipboard now: ${JSON.stringify(pasteText())}`);
	}
	if (has("links")) {
		const [a, b] = ctl.visible();
		for (let p = Math.floor(a); p < Math.ceil(b); p++) {
			await ctl.context()!.pageLinks!(p);
			const ls = ctl.linksOf(p);
			const pg = ls.filter((l) => l.target.kind === "page");
			console.log(`page ${p}: ${ls.length} links (${pg.length} internal); first internal:`, JSON.stringify(pg.slice(0, 2)));
			if (pg.length && p === Math.floor(a)) {
				// click the first internal link of the first visible page through the real hit-test, then see where we land
				const el = ctl.context()!.rectToWindow!(p, pg[0]!.rect);
				if (el) {
					const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
					r.nativeSimulateMouseMove(cx, cy); await frame(60);
					r.nativeSimulateClick(cx, cy);
					await frame(400); await settle();
					console.log(`clicked link at ${Math.round(cx)},${Math.round(cy)} -> ${JSON.stringify(pg[0]!.target)}; visible now ${vis()}, state ${JSON.stringify(ctl.viewState())}`);
				}
			}
		}
	}
	if (has("demo-plugin")) {
		if (has("alt")) { ctl.setAltView("demo-alt"); await frame(500); console.log(`alt view on: ${mounted()}`); }
		else { ctl.setSidebar(true, "plugin:demo:demo"); await frame(300); }
	}
	// active -> inactive -> active
	if (has("cycle")) {
		const v0 = ctl.visible()[0], z0 = ctl.zoom();
		setActive(false);
		await frame(600);
		console.log(`inactive: ${mounted()}`);
		const shotOff = out.replace(/\.png$/, "-inactive.png");
		mkdirSync(dirname(shotOff), { recursive: true });
		r.captureScreenshot(shotOff);
		const before = ctl.stats.renders;
		setActive(true);
		await frame(300);
		await settle(before + 1);
		console.log(`active again: ${mounted()}, zoom ${Math.round(z0 * 100)}% -> ${Math.round(ctl.zoom() * 100)}%, top page ${v0.toFixed(2)} -> ${ctl.visible()[0].toFixed(2)}, renders +${ctl.stats.renders - before}`);
	}
}
if (Number(val("wait", "0")) > 0) { await frame(Number(val("wait", "0"))); await ctl.idle(); await frame(300); }
mkdirSync(dirname(out), { recursive: true });
r.captureScreenshot(out);
console.log("wrote", out);
t.unmount();
process.exit(0);
