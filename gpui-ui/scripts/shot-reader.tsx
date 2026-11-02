// Headless screenshot of the native PDF Reader inside a container (no window opens).
//   bun scripts/shot-reader.tsx <key:ATTACHMENTKEY | ATTACHMENTKEY | file.pdf> [out.png] [options]
//     --width W         container width in px (default 1000; the test window is ~1440x880 whatever is asked)
//     --page N          scroll to page N (0-based) before the shot
//     --zoom Z          start at a custom zoom (1 = 100%) instead of fit-width
//     --zoom-after Z    then change the zoom through the controller (what the +/- buttons do)
//     --fit-after       then press "fit width"
//     --hscroll PX      then pan right by PX with the (simulated) wheel
//     --resize W        then resize the container to W px (the reader must refit and re-render)
//     --search TEXT     type a search (hits are highlighted); --next N then steps to the next hit N times
//     --start-inactive  create the reader with active=false, check nothing is opened, then activate it
//     --cycle           toggle active=false -> true after the first render (bitmaps must be freed, then restored in place)
//     --debug-words     outline every word rect of the text layer
//     --dpr D           device pixel ratio for the bitmaps (default 1)
//     --light           light theme (default dark)
// Prints per-page render timings and how many pages are mounted. Needs a core (ZN_URL, default http://127.0.0.1:23160) for keys.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createSignal } from "solid-js";
import { createTestRoot } from "@gpuix/solid/testing";
import { setReaderDpr, setReaderMode } from "../src/reader/env";
import { Reader, type ReaderController } from "../src/reader/Reader";

const args = process.argv.slice(2);
const VALUE_OPTS = new Set(["width", "page", "zoom", "zoom-after", "hscroll", "resize", "search", "next", "dpr"]);
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

const isPath = /[\\/.]/.test(spec) && !spec.startsWith("key:");
const key = spec.startsWith("key:") ? spec.slice(4) : spec;

const [w, setW] = createSignal(width);
const [active, setActive] = createSignal(!has("start-inactive"));
const t = createTestRoot({ width: 1440, height: 880 });
let ctl!: ReaderController;
t.render(() => (
	<div style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%", backgroundColor: "#141413" }}>
		<div style={{ display: "flex", flexDirection: "column", width: w(), height: "100%", flexShrink: 0 }}>
			<Reader
				attachmentKey={isPath ? "FILEPATH" : key}
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
};
const mounted = () => `${ctl.mounted()} pages mounted`;
const vis = () => ctl.visible().map((x) => x.toFixed(2)).join(",");

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
} else {
	await frame(150);
	const page = Number(val("page", "0"));
	if (page > 0) { ctl.scrollToPage(page); await frame(150); }
	await settle();
	console.log(`pages=${ctl.doc()!.pageCount} zoom=${Math.round(ctl.zoom() * 100)}% dpr=${ctl.dpr()} ${mounted()} renders=${ctl.stats.renders} lastRender=${ctl.stats.lastRenderMs.toFixed(1)}ms upload=${ctl.stats.lastUploadMs.toFixed(2)}ms visible=${vis()}`);

	// controller zoom (the +/- buttons) / fit
	const zAfter = Number(val("zoom-after", "0"));
	if (zAfter > 0 || has("fit-after")) {
		const before = ctl.stats.renders, t1 = performance.now();
		if (zAfter > 0) ctl.setZoom(zAfter); else ctl.fitWidth();
		while (performance.now() - t1 < 15000) { pump(); await Bun.sleep(30); if (ctl.stats.renders > before) { await ctl.idle(); break; } }
		console.log(`zoom -> ${Math.round(ctl.zoom() * 100)}%: first new bitmap after ${Math.round(performance.now() - t1)} ms (includes the 140 ms debounce), renders +${ctl.stats.renders - before}, cancelled=${ctl.stats.cancelled}, visible=${vis()}`);
		await frame(500);
	}
	// horizontal pan with the wheel (a zoomed-in page is wider than the container)
	const hs = Number(val("hscroll", "0"));
	if (hs !== 0) {
		r.nativeSimulateScrollWheel(500, 400, -hs, 0);
		await frame(500);
		console.log(`hscroll ${hs}`);
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
		const steps = Number(val("next", "0"));
		for (let i = 0; i < steps; i++) { ctl.next(); await frame(300); await ctl.idle(); }
		if (steps > 0) { await frame(300); console.log(`after next x${steps}: current ${ctl.hits()[0]}/${ctl.hits()[1]}, visible=${vis()}`); }
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
mkdirSync(dirname(out), { recursive: true });
r.captureScreenshot(out);
console.log("wrote", out);
t.unmount();
process.exit(0);
