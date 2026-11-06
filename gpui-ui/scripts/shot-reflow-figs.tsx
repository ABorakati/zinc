// Headless shots of the reading view's figures and tables at several column widths (no window opens).
//   ZN_READING_SETTINGS=<scratch.json> ZN_URL=<core copy> bun scripts/shot-reflow-figs.tsx <attachment key> [--tag NAME] [--out DIR] [--n 4]
// For each of the first N figures / tables (spread over the document) at the narrow / default / wide column width: scroll the
// reading list to it, shoot, and report the shown image's size against the column (it must fit, aspect kept). Shots: <out>/<tag>-<width>-<label>.png
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createTestRoot } from "@gpuix/solid/testing";
import { registerFonts } from "../src/fonts";
import { setReaderDpr, setReaderMode } from "../src/reader/env";
import { Reader, type ReaderController } from "../src/reader/Reader";
import { registerReaderPlugin, type ReaderContext } from "../src/reader/plugins";
import { register } from "../src/reader/register";
import { academicFor } from "../src/reader/academic/session";
import { setReflowSettings } from "../src/reader/reflow/state";
import { shutdownStructureWorker } from "../src/reader/structure/load";
import { OverlayHost } from "../src/ui";

const args = process.argv.slice(2);
const val = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const KEY = args.find((a, i) => !a.startsWith("--") && !(i > 0 && ["--out", "--tag", "--n"].includes(args[i - 1]!)));
if (!KEY) { console.error("usage: bun scripts/shot-reflow-figs.tsx <attachment key> [--tag NAME] [--out DIR] [--n 4]"); process.exit(2); }
if (!process.env.ZN_READING_SETTINGS) { console.error("set ZN_READING_SETTINGS=<scratch json>: the probe changes the reading settings"); process.exit(2); }
const OUT = val("out", "C:/Users/abora/zn-ws/_tmp/reflow-figs");
const TAG = val("tag", "fig");
const N = Number(val("n", "4"));
mkdirSync(OUT, { recursive: true });
process.env.ZN_READER_STATE = "off";
process.env.ZN_REFLOW_PROBE = "1";
setReaderDpr(1);
setReaderMode("light");

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
async function until(cond: () => boolean, ms = 20000): Promise<boolean> { const t0 = performance.now(); while (performance.now() - t0 < ms) { pump(); if (cond()) return true; await Bun.sleep(30); } return false; }
type Probe = { items: () => { id: string; kind: string; page: number }[]; goToIndex: (i: number, remember?: boolean) => void };
const probe = () => (globalThis as Record<string, unknown>).__znReflow as Probe | undefined;

try {
	await frame(200);
	await Promise.race([ctl.ready(), Bun.sleep(20000)]);
	await until(() => ctx !== null, 10000);
	await ctl.idle();
	const ac = academicFor(ctx!);
	ctl.setSidebar(false);
	await until(() => ac.struct().phase === "ready", 90000);
	await until(() => ac.analysed(), 90000);
	ctl.setAltView("reflow");
	await frame(2500);
	const P = probe()!;
	const its = P.items();
	const idx = its.map((it, i) => (it.kind === "figure" ? i : -1)).filter((i) => i >= 0);
	console.log("figure items:", idx.length, "of", its.length, " pages:", ctx!.pageCount());
	const pick = idx.length <= N ? idx : Array.from({ length: N }, (_, k) => idx[Math.round((k * (idx.length - 1)) / (N - 1))]!);
	for (const [name, width] of [["narrow", 480], ["default", 680], ["wide", 1000]] as const) {
		setReflowSettings({ width });
		await frame(800);
		for (const i of pick) {
			P.goToIndex(i, false);
			await frame(1800); // (the crop renders asynchronously)
			const f = join(OUT, `${TAG}-${name}-p${its[i]!.page + 1}.png`);
			r.captureScreenshot(f);
			console.log(`  ${name} (${width}px) item ${i} page ${its[i]!.page + 1}: ${f}`);
		}
	}
} finally {
	shutdownStructureWorker();
	process.exit(0);
}
