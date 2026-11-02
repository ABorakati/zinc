// Headless screenshot of the Sidebar in a 260 px wide column, once the collections have loaded.
//   bun scripts/shot-sidebar.tsx [dark|light] [out.png] [--expand] [--select]
// Writes <scratch>/gpui-shots/sidebar.png (dark) or sidebar-light.png (light) unless an output path is given.
//   --expand  clicks the first chevron (ACC Economics) so its child shows
//   --select  clicks "Unfiled", then a collection row (logs store.selectedCollection after each)
import { createTestRoot } from "@gpuix/solid/testing";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Sidebar } from "../src/Sidebar";
import { registerFonts } from "../src/fonts";
import { store } from "../src/store";
import { tw } from "../src/theme";

const args = process.argv.slice(2);
const mode = args.includes("light") ? "light" : "dark";
const expand = args.includes("--expand");
const select = args.includes("--select");
const outArg = args.find((a) => a.endsWith(".png"));
const SHOTS = "C:/Users/abora/AppData/Local/Temp/claude/C--Users-abora-Hecate/0719cea7-1eb3-4344-a1e4-a862c3bde6eb/scratchpad/gpui-shots";
const out = outArg ?? `${SHOTS}/${mode === "light" ? "sidebar-light" : "sidebar"}.png`;
mkdirSync(dirname(out), { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

store.setMode(mode);
const t = createTestRoot({ width: 260, height: 860 });
registerFonts(t.renderer);
t.render(() => (
	<div style={{ ...tw("bg-canvas", store.mode()), display: "flex", flexDirection: "row", width: "100%", height: "100%" }}>
		<div style={{ width: 260, height: 860, flexShrink: 0, display: "flex" }}>
			<Sidebar />
		</div>
	</div>
));
for (let i = 0; i < 100 && store.collections().length === 0; i++) await sleep(50); // GET /api/collections
console.log("collections loaded:", store.collections().length);
await sleep(300);
t.renderer.flush();

if (expand) {
	t.renderer.nativeSimulateClick?.(24, 260); // chevron of the first collection row
	await sleep(200);
}
if (select) {
	t.renderer.nativeSimulateClick?.(100, 73); // Unfiled
	await sleep(150);
	console.log("selected after Unfiled click:", store.selectedCollection());
	t.renderer.nativeSimulateClick?.(120, 405); // a collection row
	await sleep(150);
	console.log("selected after collection click:", store.selectedCollection());
}
t.renderer.flush();
t.renderer.captureScreenshot(out);
console.log("wrote", out);
t.unmount();
process.exit(0);
