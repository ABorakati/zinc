// Headless check of the reading view's toggle and the academic hover popovers inside the REAL reader core (no window opens).
//   ZN_URL=<core copy> bun scripts/shot-reflow.tsx <attachment key> [--page N] [--out DIR] [--light]
// Shots: <out>/reflow-*.png. Uses simulated mouse events only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createTestRoot } from "@gpuix/solid/testing";
import { registerFonts } from "../src/fonts";
import { setReaderDpr, setReaderMode } from "../src/reader/env";
import { Reader, type ReaderController } from "../src/reader/Reader";
import { registerReaderPlugin, type ReaderContext } from "../src/reader/plugins";
import { register } from "../src/reader/register";
import { academicFor } from "../src/reader/academic/session";
import { markerOf } from "../src/reader/academic/citations";
import { computeLines, lineRect } from "../src/reader/academic/textlines";
import { toNRect } from "../src/reader/structure/pagetext";
import { shutdownStructureWorker } from "../src/reader/structure/load";
import { OverlayHost } from "../src/ui";

const args = process.argv.slice(2);
const val = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const has = (n: string) => args.includes(`--${n}`);
const KEY = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && ["out", "page"].includes(args[i - 1]!.slice(2))));
if (!KEY) { console.error("usage: bun scripts/shot-reflow.tsx <attachment key> [--page N] [--out DIR]"); process.exit(2); }
const OUT = val("out", "C:/Users/abora/AppData/Local/Temp/claude/C--Users-abora-Hecate/0719cea7-1eb3-4344-a1e4-a862c3bde6eb/scratchpad/reader-shots");
mkdirSync(OUT, { recursive: true });
setReaderDpr(1);
setReaderMode(has("light") ? "light" : "dark");

let ctx: ReaderContext | null = null;
register();
registerReaderPlugin({ id: "probe", onOpen: (c) => { ctx = c; } });

const t = createTestRoot({ width: 1440, height: 880 });
const r = t.renderer;
let ctl!: ReaderController;
registerFonts(r);
t.render(() => (
	<div style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%" }}>
		<div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}>
			<Reader attachmentKey={KEY} title="Reader" ephemeral controller={(c) => { ctl = c; }} />
		</div>
		<OverlayHost />
	</div>
));
const pump = () => { r.flush(); r.dispatchNativeEvents(); r.flush(); };
const frame = async (ms: number) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { pump(); await Bun.sleep(16); } };
const shot = async (name: string, wait = 500) => { await frame(wait); const f = join(OUT, `reflow-${name}.png`); r.captureScreenshot(f); console.log("shot", f); };
async function until(cond: () => boolean, ms = 20000, what = "condition"): Promise<boolean> {
	const t0 = performance.now();
	while (performance.now() - t0 < ms) { pump(); if (cond()) return true; await Bun.sleep(30); }
	console.warn(`timeout waiting for ${what}`);
	return false;
}

try {
	await frame(200);
	await Promise.race([ctl.ready(), Bun.sleep(20000)]);
	await until(() => ctx !== null, 10000, "the plugin context");
	await ctl.idle();
	await shot("toolbar", 1000);
	if (has("default-open")) {
		// ZN_READING_SETTINGS with openByDefault: the reader opens straight into the reading view; going back must show a fitted PDF
		await frame(3000);
		console.log("alt view:", ctx!.altView(), "zoom:", JSON.stringify(ctl.viewState()));
		await shot("default-open", 500);
		ctl.setAltView(null);
		await frame(2500);
		console.log("back to pages, zoom:", JSON.stringify(ctl.viewState()));
		await shot("default-open-back", 500);
		process.exit(0);
	}

	// ---- the academic hover popover on an in-text citation link
	const page = Number(val("page", "8"));
	const ac = academicFor(ctx!);
	ctl.setSidebar(false);
	ctx!.scrollTo(page, 0);
	await frame(1500);
	await until(() => ac.struct().phase !== "loading", 60000, "structure");
	console.log("structure:", ac.struct().phase, "refStart:", JSON.stringify(ac.refStart()));
	await frame(2500);
	const links = ctl.linksOf(page);
	console.log(`page ${page + 1}: ${links.length} links; mounted: ${ctx!.mountedPages?.().join(",")}`);
	const cite = links.find((l) => l.target.kind === "page");
	if (!cite) throw new Error("no internal link on that page");
	const w = ctx!.rectToWindow?.(page, cite.rect);
	console.log("link window rect:", JSON.stringify(w));
	if (!w) throw new Error("page not mounted");
	const cx = w.x + w.width / 2, cy = w.y + w.height / 2;
	await shot("page", 300);
	r.nativeSimulateMouseMove(cx - 30, cy + 30);
	await frame(100);
	r.nativeSimulateMouseMove(cx, cy);
	await frame(1500);
	console.log("popup after hover:", JSON.stringify(ac.popup() && { key: ac.popup()!.key, pinned: ac.popup()!.pinned }));
	await shot("cite-hover", 600);
	r.nativeSimulateMouseMove(cx + 500, cy + 300);
	await frame(1500);
	console.log("popup after leaving:", JSON.stringify(ac.popup() && ac.popup()!.key));

	// ---- hover on a bibliography entry of the PDF
	const rs = ac.refStart();
	if (rs) {
		const bn = Number(val("ref", "23"));
		const bp = rs.page + Number(val("ref-page-offset", "0"));
		ctx!.scrollTo(bp, 0);
		await frame(2500);
		const pt = await ac.pageText(bp);
		const line = computeLines(pt.text, pt.rects).find((l) => markerOf(l.text) === bn && (bp > rs.page || l.y2 <= rs.y));
		if (!line) console.warn(`no line for reference ${bn} on page ${bp + 1}`);
		else {
			const sz = ctx!.pageSize(bp);
			const nr = toNRect(lineRect(line), sz.w, sz.h);
			ctx!.scrollTo(bp, Math.max(0, nr.y - 0.25));
			await frame(2500);
			const bw = ctx!.rectToWindow?.(bp, nr);
			console.log("bib line:", JSON.stringify(line.text.slice(0, 60)), JSON.stringify(bw));
			if (bw) {
				const bx = bw.x + bw.width / 2, by = bw.y + bw.height / 2;
				r.nativeSimulateMouseMove(bx - 20, by + 40);
				await frame(100);
				r.nativeSimulateMouseMove(bx, by);
				await frame(1500);
				console.log("bib popup:", JSON.stringify(ac.popup() && { key: ac.popup()!.key }));
				await shot("bib-hover", 800);
				r.nativeSimulateMouseMove(bx + 500, by + 300);
				await frame(1200);
			}
		}
	}

	// ---- the reading view
	ctl.setAltView("reflow");
	await shot("reading-view", 2500);
	// the bibliography at the end of the reading view: a click on an entry shows where the paper cites it
	const sy = Number(val("scroll", "0"));
	if (sy) {
		for (let i = 0; i < 8; i++) { r.nativeSimulateScrollWheel(900, 500, 0, -sy / 8); await frame(250); }
		await shot("reading-view-refs", 1200);
		r.nativeSimulateMouseMove(900, Number(val("click-y", "400")));
		r.nativeSimulateClick(900, Number(val("click-y", "400")));
		await shot("reading-view-bib", 1500);
	}
	ctl.setAltView(null);
} finally {
	shutdownStructureWorker();
	process.exit(0);
}
