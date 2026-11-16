// Headless screenshot of the CardList in a ~470 px column (the app's middle column) once the first page has loaded.
//   bun scripts/shot-cards.tsx [out.png] [--mode dark|light] [--select N] [--scroll ROW] [--width PX]
// The test renderer's window comes out ~1440x880 whatever size is asked, so the column is rendered at the left edge and the
// PNG is cropped to it (pngjs, same as scripts/compare.ts).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTestRoot } from "@gpuix/solid/testing";
import { PNG } from "pngjs";
import { CardList } from "../src/cards/CardList";
import { registerFonts } from "../src/fonts";
import { store, uiState } from "../src/store";

uiState.disableWrites(); // never write the user's ui-state.json
store.setViewMode("cards");

const DEFAULT_OUT =
	"C:/Users/abora/AppData/Local/Temp/claude/C--Users-abora-Hecate/0719cea7-1eb3-4344-a1e4-a862c3bde6eb/scratchpad/gpui-shots/cards.png";
const args = process.argv.slice(2);
const flag = (n: string) => args.indexOf(`--${n}`);
const val = (n: string, d: string) => (flag(n) >= 0 ? args[flag(n) + 1]! : d);
const out =
	args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--") && args[i - 1] !== "--collapse")) ?? DEFAULT_OUT;
const mode = val("mode", "dark") === "light" ? "light" : "dark";
// The reference frame (zn-trace 005852.jpg) is the 1440 px wide app downscaled to 900 px (x0.625), so its ~475 px middle column
// is ~758 px at 1:1 (measured from the web UI at 1440 px: the list scroller is 758.17 px wide). --width 470 renders a literally
// 470 px wide column instead.
const COLUMN = Number(val("width", "758"));

const t = createTestRoot({ width: COLUMN, height: 880 });
(registerFonts as (r?: unknown) => void)(t.renderer);
store.setMode(mode);

t.render(() => (
	<div
		style={{
			display: "flex",
			flexDirection: "row",
			width: "100%",
			height: "100%",
			backgroundColor: mode === "dark" ? "#0c0c0f" : "#f4f4f6",
		}}
	>
		<div style={{ display: "flex", flexDirection: "column", width: COLUMN, height: "100%", flexShrink: 0 }}>
			<CardList />
		</div>
	</div>
));

// wait for page 0 + the year groups
const t0 = performance.now();
while (performance.now() - t0 < 15000) {
	t.renderer.flush();
	if (store.itemAt(0) && store.groups().length) break;
	await Bun.sleep(25);
}
for (let i = 0; i < 5; i++) {
	t.renderer.flush();
	await Bun.sleep(20);
}
console.log(`first page + groups after ${Math.round(performance.now() - t0)} ms; total=${store.total()} groups=${store.groups().length}`);

const sel = Number(val("select", "-1"));
if (sel >= 0) {
	const it = store.itemAt(sel);
	if (it) store.selectOnly(it.key, sel);
}
const scroll = Number(val("scroll", "0"));
if (scroll > 0) {
	const list = t.renderer.findByType("virtual-list")[0]!;
	t.renderer.scrollToItem(list.id, scroll);
	for (let i = 0; i < 8; i++) {
		t.renderer.flush();
		await Bun.sleep(60);
	}
}
for (let i = 0; i < 3; i++) {
	t.renderer.flush();
	await Bun.sleep(30);
}

mkdirSync(dirname(out), { recursive: true });
const full = out.replace(/\.png$/i, "-full.png");
t.renderer.captureScreenshot(full);
const png = PNG.sync.read(readFileSync(full));
const w = Math.min(COLUMN, png.width);
const crop = new PNG({ width: w, height: png.height });
PNG.bitblt(png, crop, 0, 0, w, png.height, 0, 0);
writeFileSync(out, PNG.sync.write(crop));
// x0.625 box-filtered copy, directly comparable with the downscaled reference frame
{
	const k = 0.625,
		W = Math.round(w * k),
		H = Math.round(png.height * k);
	const small = new PNG({ width: W, height: H });
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const x0 = Math.floor(x / k),
				x1 = Math.min(w, Math.ceil((x + 1) / k)),
				y0 = Math.floor(y / k),
				y1 = Math.min(png.height, Math.ceil((y + 1) / k));
			let r = 0,
				g = 0,
				b = 0,
				n = 0;
			for (let yy = y0; yy < y1; yy++)
				for (let xx = x0; xx < x1; xx++) {
					const i = (yy * crop.width + xx) * 4;
					r += crop.data[i]!;
					g += crop.data[i + 1]!;
					b += crop.data[i + 2]!;
					n++;
				}
			const o = (y * W + x) * 4;
			small.data[o] = r / n;
			small.data[o + 1] = g / n;
			small.data[o + 2] = b / n;
			small.data[o + 3] = 255;
		}
	writeFileSync(out.replace(/\.png$/i, "-x0625.png"), PNG.sync.write(small));
}
console.log(`wrote ${out} (${w}x${png.height}; full capture ${png.width}x${png.height} at ${full})`);
t.unmount();
process.exit(0);
