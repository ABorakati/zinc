// Headless screenshots of the item list in its different states: the Classic table, multi-select, context menu, sort dropdown,
// full-text results, column menu, drag. Renders Toolbar + SortBar + the list (CardList picks cards / table / results) in a
// ~758 px column with the overlay host on top, drives it with simulated mouse / keys and writes PNGs.
//   bun scripts/shot-table.tsx <scenario> [out.png] [--mode dark|light] [--width PX]
// scenarios: table | cards | multi | ctx | sort | group | fulltext | colmenu | tablectx | customize | resize | compact
// Needs a core at ZN_URL (default http://127.0.0.1:23160). Never touches the user's ui-state.json (writes disabled).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createTestRoot } from "@gpuix/solid/testing";
import { PNG } from "pngjs";
import { CardList } from "../src/cards/CardList";
import { cardLayout } from "../src/cards/layout";
import { registerFonts } from "../src/fonts";
import { dragging } from "../src/dnd";
import { store, uiState } from "../src/store";
import { columnLayout } from "../src/table/layout";
import { SortBar, Toolbar } from "../src/Toolbar";
import { OverlayHost } from "../src/ui";

uiState.disableWrites();

const DIR = "C:/Users/abora/AppData/Local/Temp/claude/C--Users-abora-Hecate/0719cea7-1eb3-4344-a1e4-a862c3bde6eb/scratchpad/gpui-shots";
const args = process.argv.slice(2);
const flag = (n: string) => args.indexOf(`--${n}`);
const val = (n: string, d: string) => (flag(n) >= 0 ? args[flag(n) + 1]! : d);
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")));
const scenario = positional[0] ?? "table";
const out = positional[1] ?? join(DIR, `list-${scenario}.png`);
const mode = val("mode", "dark") === "light" ? "light" : "dark";
const COLUMN = Number(val("width", "758"));

const t = createTestRoot({ width: COLUMN + 400, height: 900 });
const r = t.renderer;
(registerFonts as (x?: unknown) => void)(r);
store.setMode(mode);
store.setViewMode(scenario === "cards" || scenario === "multi" || scenario === "ctx" || scenario === "customize" || scenario === "compact" ? "cards" : "table");
if (scenario === "compact") cardLayout.set("density", "compact");

t.render(() => (
	<div style={{ display: "flex", flexDirection: "row", width: "100%", height: "100%", backgroundColor: mode === "dark" ? "#0c0c0f" : "#f4f4f6" }}>
		<div style={{ display: "flex", flexDirection: "column", width: COLUMN, height: "100%", flexShrink: 0, backgroundColor: mode === "dark" ? "#16161a" : "#ffffff" }}>
			<Toolbar />
			<SortBar />
			<div style={{ flexGrow: 1, minHeight: 0, width: "100%", display: "flex", flexDirection: "column" }}>
				<CardList />
			</div>
		</div>
		<OverlayHost />
	</div>
));

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const frames = (n = 3) => { for (let i = 0; i < n; i++) { r.flush(); r.dispatchNativeEvents(); r.flush(); } };
async function settle(ms = 150) { frames(); await sleep(ms); frames(); }

const t0 = performance.now();
while (performance.now() - t0 < 15000) {
	frames(1);
	if (store.peek(0) && store.groups().length) break;
	await sleep(40);
}
await settle(300);
console.log(`ready after ${Math.round(performance.now() - t0)} ms; total=${store.total()} groups=${store.groups().length}`);

/** Centre of the first element whose text contains `s` (window px). */
function at(s: string, nth = 0): { x: number; y: number } {
	const all = r.getAllText();
	void all;
	const hits = r.findByType("text").filter((e) => (e.text ?? "").includes(s));
	const e = hits[nth];
	if (!e) throw new Error(`no text "${s}"`);
	const b = r.getElementBounds(e.id);
	if (!b) throw new Error(`"${s}" has no bounds`);
	return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}
const click = (p: { x: number; y: number }, button = 0, mods?: string) => { frames(1); r.nativeSimulateClick(p.x, p.y, button, mods); frames(); };

async function shot(name: string, cropW = COLUMN + 400) {
	await settle(120);
	mkdirSync(dirname(name), { recursive: true });
	const full = name.replace(/\.png$/i, "-full.png");
	r.captureScreenshot(full);
	const png = PNG.sync.read(readFileSync(full));
	const w = Math.min(cropW, png.width);
	const crop = new PNG({ width: w, height: png.height });
	PNG.bitblt(png, crop, 0, 0, w, png.height, 0, 0);
	writeFileSync(name, PNG.sync.write(crop));
	console.log("wrote", name);
}

switch (scenario) {
	case "table":
	case "cards":
	case "compact":
		break;
	case "multi": { // click, ctrl+click, ctrl+click on three separate cards, then shift+click a fourth (range)
		const ys: number[] = [];
		const titles = r.findByType("text")
			.map((e) => ({ e, b: r.getElementBounds(e.id) }))
			.filter((x) => x.b && x.b.y > 120 && x.b.x < 80 + 20 && x.b.x > 40 && (x.e.text ?? "").length > 20)
			.sort((p, q) => p.b!.y - q.b!.y);
		const cards = titles.filter((x) => { if (ys.some((y) => Math.abs(y - x.b!.y) < 70)) return false; ys.push(x.b!.y); return true; });
		console.log("cards", cards.length);
		click({ x: cards[0]!.b!.x + 30, y: cards[0]!.b!.y + 4 });
		click({ x: cards[2]!.b!.x + 30, y: cards[2]!.b!.y + 4 }, 0, "ctrl");
		click({ x: cards[3]!.b!.x + 30, y: cards[3]!.b!.y + 4 }, 0, "ctrl");
		console.log("selected", store.selected().size);
		break;
	}
	case "ctx": { // right-click a card
		const a = at("Borakati", 0);
		frames(1);
		r.nativeSimulateClick(a.x, a.y, 2);
		frames(); await sleep(400); frames();
		break;
	}
	case "tablectx": {
		const a = at("Borakati", 0);
		frames(1);
		r.nativeSimulateClick(a.x, a.y, 2);
		frames(); await sleep(400); frames();
		break;
	}
	case "sort": click(at("Date Added", 0)); break;
	case "group": click(at("Year", 0)); break;
	case "fulltext": {
		store.setFulltext(true);
		store.setFilter("liver transplantation");
		await sleep(1200);
		break;
	}
	case "colmenu": {
		const h = at("Creator", 1); // 0 is the quick-search mode label
		frames(1); r.nativeSimulateClick(h.x, h.y, 2); frames(); await sleep(200); frames();
		break;
	}
	case "customize": click(at("Customise")); await sleep(200); break;
	case "resize": { // drag the Creator column's right edge 80 px to the right
		const h = at("Creator", 0);
		const b = r.getElementBounds(r.findByType("text").filter((e) => (e.text ?? "") === "Creator")[0]!.id)!;
		const edge = columnLayout.widthOf("title") + columnLayout.widthOf("creator");
		console.log("widths before", columnLayout.widthOf("creator"), "edge", edge, h, b);
		const x = 6 + edge + 0; // approximate header left = column x (0) -> right edge of the creator column
		r.nativeSimulateMouseDown(x - 2, h.y, 0); frames();
		r.nativeSimulateMouseMove(x + 60, h.y, 0); frames();
		r.nativeSimulateMouseMove(x + 80, h.y, 0); frames();
		r.nativeSimulateMouseUp(x + 80, h.y, 0); frames();
		console.log("widths after", columnLayout.widthOf("creator"));
		break;
	}
	default:
		console.error("unknown scenario", scenario);
}
void dragging;
await shot(out);
t.unmount();
process.exit(0);
