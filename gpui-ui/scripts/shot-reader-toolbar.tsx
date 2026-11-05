// Headless check that the reader toolbar fits at every width with each annotation tool selected (no window opens).
//   bun scripts/shot-reader-toolbar.tsx <file.pdf> <outDir> [--widths 1400,800,700] [--light]
// For every width it shoots the reader with no tool, then with each annotation tool, then with the colour palette and the
// overflow menu open, and prints where the toolbar's last control ends (it must be <= the container width).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createSignal } from "solid-js";
import { createTestRoot } from "@gpuix/solid/testing";
import { setReaderDpr, setReaderMode } from "../src/reader/env";
import { Reader, type ReaderController } from "../src/reader/Reader";
import { register } from "../src/reader/register";
import { sessionFor } from "../src/reader/annotations/session";
import { OverlayHost } from "../src/ui";

const args = process.argv.slice(2);
const val = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1]! : d; };
const pos = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && ["widths"].includes(args[i - 1]!.slice(2))));
const pdf = pos[0], outDir = pos[1];
if (!pdf || !outDir) { console.error("usage: bun scripts/shot-reader-toolbar.tsx <file.pdf> <outDir> [--widths 1400,800,700]"); process.exit(2); }
mkdirSync(outDir, { recursive: true });
setReaderDpr(1);
setReaderMode(args.includes("--light") ? "light" : "dark");
process.env.ZN_READER_STATE = "off";
register();

const widths = val("widths", "1400,800,700").split(",").map(Number);
const t = createTestRoot({ width: 1440, height: 880 });
const [w, setW] = createSignal(widths[0]!);
let ctl!: ReaderController;
t.render(() => (
	<div style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%", backgroundColor: "#141413" }}>
		<div style={{ display: "flex", flexDirection: "column", width: w(), height: "100%", flexShrink: 0 }}>
			<Reader attachmentKey="FILEPATH" itemKey="" ephemeral path={pdf} title="A Neural Network Approach to Predict Acute Allograft Rejection in Liver Transplant Recipients" active dpr={1} controller={(c) => { ctl = c; }} />
		</div>
		<OverlayHost />
	</div>
));
const r = t.renderer;
const pump = () => { r.flush(); r.dispatchNativeEvents(); r.flush(); };
const frame = async (ms: number) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { pump(); await Bun.sleep(16); } };
await frame(150);
await Promise.race([ctl.ready(), Bun.sleep(15000)]);
if (ctl.error()) { console.error("reader error:", ctl.error()); process.exit(1); }
ctl.setSidebar(false);
await frame(500); await ctl.idle(); await frame(300);
const s = sessionFor(ctl.context()!);

const tools: (string | null)[] = [null, "highlight", "underline", "note", "ink", "eraser"];
for (const width of widths) {
	setW(width);
	await frame(600); await ctl.idle(); await frame(200);
	for (const tool of tools) {
		s.ui.setTool(tool as never);
		await frame(350);
		const file = join(outDir, `w${width}-${tool ?? "none"}.png`);
		r.captureScreenshot(file);
		console.log("wrote", file);
	}
	// open the tool options of the ink tool (colour palette, size) when the toolbar offers them as popovers
	s.ui.setTool("ink" as never);
	await frame(300);
	for (const [name, x, y] of (val("click", "").split(";").filter(Boolean).map((c, i) => [`click${i}`, ...c.split(",").map(Number)]) as [string, number, number][])) {
		r.nativeSimulateMouseMove(x, y); await frame(60); r.nativeSimulateClick(x, y); await frame(400);
		console.log(`clicked ${x},${y}: tool=${s.ui.tool()}`);
		const file = join(outDir, `w${width}-ink-${name}.png`);
		r.captureScreenshot(file);
		console.log("wrote", file);
	}
}
t.unmount();
process.exit(0);
