// Headless screenshot of the native PDF Reader on one PDF (no window opens).
//   bun scripts/shot-reader.tsx <file.pdf | key:ATTACHMENTKEY> [out.png] [--page N] [--zoom Z] [--zoom-after Z] [--highlight TEXT] [--debug-words] [--dpr D]
// The test renderer's window comes out ~1440x880 whatever size is asked (see README.md), so the reader is laid out in the
// left 1000 px. Prints per-page render timings and how many pages are mounted.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createTestRoot } from "@gpuix/solid/testing";
import { resolvePdf } from "../src/reader/library";
import { Reader, type ReaderController } from "../src/reader/Reader";

const args = process.argv.slice(2);
const val = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const has = (n: string) => args.includes(`--${n}`);
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && args[i - 1] !== "--debug-words"));
const pdf = positional[0];
if (!pdf) { console.error("usage: bun scripts/shot-reader.tsx <file.pdf> [out.png] [--page N] [--zoom Z] [--highlight TEXT] [--debug-words] [--dpr D]"); process.exit(2); }
const out = positional[1] ?? "reader.png";
const page = Number(val("page", "0"));
const zoom = Number(val("zoom", "1"));
const dpr = Number(val("dpr", "1"));

const t = createTestRoot({ width: 1000, height: 880 });
let ctl!: ReaderController;
t.render(() => (
	<div style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%", backgroundColor: "#2a2a2f" }}>
		<div style={{ display: "flex", flexDirection: "column", width: 1000, height: "100%", flexShrink: 0 }}>
			<Reader path={resolvePdf(pdf)} dpr={dpr} zoom={zoom} viewportWidth={1000} highlight={val("highlight", "")} debugWords={has("debug-words")} controller={(c) => { ctl = c; }} />
		</div>
	</div>
));
const r = t.renderer;
const frame = async (ms: number) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { r.flush(); await Bun.sleep(16); } };
await frame(150);
if (page > 0) { ctl.scrollToPage(page); await frame(150); }
// let renders (and the text layer) land, flushing so the new bitmaps are painted
const t0 = performance.now();
while (performance.now() - t0 < 20000) { r.flush(); await ctl.idle(); await Bun.sleep(30); r.flush(); if (ctl.stats.renders >= 1) break; }
await frame(400);
// --zoom-after Z: change zoom through the controller (what the +/- buttons do) and wait for the re-render to land
const zAfter = Number(val("zoom-after", "0"));
if (zAfter > 0) {
	const before = ctl.stats.renders, t1 = performance.now();
	ctl.setZoom(zAfter);
	while (performance.now() - t1 < 15000) { r.flush(); await Bun.sleep(30); if (ctl.stats.renders > before) { await ctl.idle(); break; } }
	console.log(`zoom ${zAfter}: first new bitmap after ${Math.round(performance.now() - t1)} ms (includes the 140 ms debounce), renders +${ctl.stats.renders - before}, cancelled=${ctl.stats.cancelled}`);
	await frame(500);
}
console.log(`pages=${ctl.doc.pageCount} mounted=${ctl.mounted()} renders=${ctl.stats.renders} lastRender=${ctl.stats.lastRenderMs.toFixed(1)}ms upload=${ctl.stats.lastUploadMs.toFixed(2)}ms visible=${ctl.visible().map((x) => x.toFixed(2))}`);
mkdirSync(dirname(out), { recursive: true });
r.captureScreenshot(out);
console.log("wrote", out);
t.unmount();
process.exit(0);
