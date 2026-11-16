// Headless checks of the reader chrome and the academic mentions inside the REAL reader core (no window opens; simulated mouse only).
//   ZN_URL=<core copy> bun scripts/shot-links.tsx <attachment key> [--only sidebar,reading,links] [--page N] [--out DIR] [--light]
// Shots: <out>/links-*.png (default out: the scratchpad's reader-shots).
//   sidebar  the left sidebar at its default width, dragged narrow (180) and wide (half the reader), tab strip + tooltips
//   reading  the reading view: no page sidebar, the Contents dropdown closed / open / after a pick
//   links    the mentions of a page (citations, figure / table / supplementary mentions, bibliography entries) styled as links,
//            and the hover card (simulated pointer, no click)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createTestRoot } from "@gpuix/solid/testing";
import { registerFonts } from "../src/fonts";
import { setReaderDpr, setReaderMode } from "../src/reader/env";
import { Reader, type ReaderController } from "../src/reader/Reader";
import { registerReaderPlugin, type ReaderContext } from "../src/reader/plugins";
import { register } from "../src/reader/register";
import { academicFor } from "../src/reader/academic/session";
import { toNRect } from "../src/reader/structure/pagetext";
import { shutdownStructureWorker } from "../src/reader/structure/load";
import { OverlayHost } from "../src/ui";

const args = process.argv.slice(2);
const val = (n: string, d: string) => {
	const i = args.indexOf(`--${n}`);
	return i >= 0 ? args[i + 1]! : d;
};
const has = (n: string) => args.includes(`--${n}`);
const KEY = args.find(
	(a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && ["out", "page", "only"].includes(args[i - 1]!.slice(2))),
);
if (!KEY) {
	console.error("usage: bun scripts/shot-links.tsx <attachment key> [--only sidebar,reading,links] [--page N] [--out DIR]");
	process.exit(2);
}
const OUT = val(
	"out",
	"C:/Users/abora/AppData/Local/Temp/claude/C--Users-abora-Hecate/0719cea7-1eb3-4344-a1e4-a862c3bde6eb/scratchpad/reader-shots",
);
const only = new Set(val("only", "sidebar,reading,links").split(","));
mkdirSync(OUT, { recursive: true });
process.env.ZN_READER_STATE = "off";
process.env.ZN_SIM_MOUSE = "1"; // simulated moves carry no pressedButton: a drag must not read that as "released outside the window"
setReaderDpr(1);
setReaderMode(has("light") ? "light" : "dark");

let ctx: ReaderContext | null = null;
register();
registerReaderPlugin({
	id: "probe",
	onOpen: (c) => {
		ctx = c;
	},
});

const t = createTestRoot({ width: 1440, height: 880 });
const r = t.renderer;
let ctl!: ReaderController;
registerFonts(r);
t.render(() => (
	<div style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%" }}>
		<div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%" }}>
			<Reader
				attachmentKey={KEY}
				title="Reader"
				ephemeral
				controller={(c) => {
					ctl = c;
				}}
			/>
		</div>
		<OverlayHost />
	</div>
));
const pump = () => {
	r.flush();
	r.dispatchNativeEvents();
	r.flush();
};
if (process.env.ZN_READER_SELFTEST) {
	// the reader's self-test (the one the packaged exe runs) driven from here: pump frames while it sleeps
	setInterval(pump, 16);
	await Bun.sleep(60000);
	process.exit(1);
}
const frame = async (ms: number) => {
	const t0 = performance.now();
	while (performance.now() - t0 < ms) {
		pump();
		await Bun.sleep(16);
	}
};
const shot = async (name: string, wait = 500) => {
	await frame(wait);
	const f = join(OUT, `links-${name}.png`);
	r.captureScreenshot(f);
	console.log("shot", f);
};
async function until(cond: () => boolean, ms = 20000, what = "condition"): Promise<boolean> {
	const t0 = performance.now();
	while (performance.now() - t0 < ms) {
		pump();
		if (cond()) return true;
		await Bun.sleep(30);
	}
	console.warn(`timeout waiting for ${what}`);
	return false;
}
/** press at (x0, y), drag to x1 and release: the sidebar's resize handle */
async function drag(x0: number, y: number, x1: number) {
	r.nativeSimulateMouseMove(x0, y);
	await frame(80);
	r.nativeSimulateMouseDown(x0, y);
	await frame(80);
	const n = 6;
	for (let i = 1; i <= n; i++) {
		r.nativeSimulateMouseMove(x0 + ((x1 - x0) * i) / n, y);
		await frame(40);
	}
	r.nativeSimulateMouseUp(x1, y);
	await frame(150);
}

try {
	await frame(200);
	await Promise.race([ctl.ready(), Bun.sleep(20000)]);
	await until(() => ctx !== null, 10000, "the plugin context");
	await ctl.idle();

	if (only.has("sidebar")) {
		ctl.setSidebar(true, "thumbs");
		await shot("sidebar-default", 1200);
		if (has("scan")) {
			const tr = JSON.stringify(r.getAutomationTree());
			await Bun.write(
				"C:/Users/abora/AppData/Local/Temp/claude/C--Users-abora-Hecate/0719cea7-1eb3-4344-a1e4-a862c3bde6eb/scratchpad/rdl-tree.json",
				tr,
			);
		}
		if (has("scan"))
			for (let x = 200; x < 250; x += 2) {
				console.log("x", x);
				r.nativeSimulateMouseMove(x, 400);
				await frame(40);
			}
		// narrow: the tabs wrap, nothing is clipped; wide: up to half of the reader
		await drag(234, 400, 120);
		await shot("sidebar-narrow", 600);
		ctl.setSidebar(true, "plugin:academic-references:references");
		await shot("sidebar-narrow-refs", 800);
		await drag(182, 400, 900);
		await shot("sidebar-wide", 600);
		r.nativeSimulateMouseMove(20, 20);
		await drag(722, 400, 260);
		ctl.setSidebar(true, "thumbs");
	}

	if (only.has("reading")) {
		const ac = academicFor(ctx!);
		ctl.setSidebar(true, "thumbs");
		ctl.setAltView("reflow");
		await until(() => ac.struct().phase === "ready", 60000, "structure");
		await shot("reading-closed", 2500);
		const cx = Number(val("contents-x", "130")),
			cy = Number(val("contents-y", "61"));
		r.nativeSimulateMouseMove(cx, cy);
		r.nativeSimulateClick(cx, cy);
		await shot("reading-contents-open", 800);
		r.nativeSimulateClick(cx + 20, cy + 150); // pick an entry
		await shot("reading-contents-picked", 1500);
		r.nativeSimulateClick(cx, cy);
		await frame(300);
		r.simulateKeystrokes("escape");
		await shot("reading-contents-escaped", 500);
		ctl.setAltView(null);
		await shot("reading-back-to-pdf", 1500);
	}

	if (only.has("links")) {
		const page = Number(val("page", "0"));
		const ac = academicFor(ctx!);
		ctl.setSidebar(false);
		ctx!.scrollTo(page, 0);
		await frame(1500);
		await shot("page-early", 200); // the structure may still be loading: the PDF's own link annotations already style as mentions
		await until(() => ac.struct().phase !== "loading", 60000, "structure");
		console.log("structure:", ac.struct().phase, "refStart:", JSON.stringify(ac.refStart()));
		await frame(2500);
		await shot("page", 500);
		const links = ctl.linksOf(page);
		console.log(
			`page ${page + 1}: ${links.length} links (${links.filter((l) => l.target.kind === "page").length} internal); mounted: ${ctx!.mountedPages?.().join(",")}`,
		);
		// the first citation of the page: its internal link, else the first "[n]" group of the text
		const cite = links.find((l) => l.target.kind === "page");
		let nr = cite?.rect;
		if (!nr) {
			const pt = await ac.pageText(page);
			const m = /\[\d+(?:[,–-]\s*\d+)*\]/.exec(pt.text);
			if (!m) throw new Error("no citation on that page");
			const sz = ctx!.pageSize(page);
			nr = toNRect(
				[
					Math.min(...pt.rects.slice(m.index, m.index + m[0].length).map((q) => q[0])),
					Math.min(...pt.rects.slice(m.index, m.index + m[0].length).map((q) => q[1])),
					Math.max(...pt.rects.slice(m.index, m.index + m[0].length).map((q) => q[2])),
					Math.max(...pt.rects.slice(m.index, m.index + m[0].length).map((q) => q[3])),
				],
				sz.w,
				sz.h,
			);
			console.log("citation from the text:", m[0]);
		}
		const w = ctx!.rectToWindow?.(page, nr);
		if (!w) throw new Error("page not mounted");
		const cx = w.x + w.width / 2,
			cy = w.y + w.height / 2;
		r.nativeSimulateMouseMove(cx - 40, cy + 40);
		await frame(100);
		r.nativeSimulateMouseMove(cx, cy);
		await frame(1500);
		console.log("popup after hover:", JSON.stringify(ac.popup() && { key: ac.popup()!.key, pinned: ac.popup()!.pinned }));
		await shot("hover", 600);
		r.nativeSimulateMouseMove(cx + 450, cy + 300);
		await frame(1500);
		console.log("popup after leaving:", JSON.stringify(ac.popup() && ac.popup()!.key));
	}
} catch (e) {
	console.error("FAILED:", e);
} finally {
	shutdownStructureWorker();
	process.exit(0);
}
