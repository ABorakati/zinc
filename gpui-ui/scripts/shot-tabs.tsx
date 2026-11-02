// Headless screenshots of the reader tabs (no window opens):
//   bun scripts/shot-tabs.tsx [outDir]
// Writes tabs-library.png (library active, two reader tabs open in the strip, list scrolled down) and tabs-reader.png
// (the second reader tab active, PDF on screen). Also checks: the list keeps its scroll position across a tab switch,
// closing the active tab activates its neighbour, and double-click / "Open PDF" go through store.openAttachment.
// NOTE: the headless test renderer leaks uploaded bitmaps (each page image stays resident): fine for screenshots, useless for memory numbers.
import { mkdirSync, readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { createTestRoot } from "@gpuix/solid/testing";
import { App } from "../src/App";
import type { ItemRow } from "../src/contracts";
import { registerFonts } from "../src/fonts";
import { store } from "../src/store";

const outDir = process.argv[2] ?? "C:/Users/abora/AppData/Local/Temp/claude/C--Users-abora-Hecate/0719cea7-1eb3-4344-a1e4-a862c3bde6eb/scratchpad/gpui-shots";
mkdirSync(outDir, { recursive: true });

const t = createTestRoot({ width: 1400, height: 900 });
registerFonts(t.renderer);
t.render(() => <App />);
const r = t.renderer;
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
// the test renderer only delivers onLayout / onVisibleRange (the reader sizes its pages from them) after dispatchNativeEvents()
const frames = async (ms: number) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { r.flush(); r.dispatchNativeEvents(); r.flush(); await sleep(16); } };
let failed = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` (${extra})` : ""}`); if (!ok) failed++; };

for (let i = 0; i < 100 && store.total() === 0; i++) await sleep(100);
await frames(800);

// two items with a PDF primary attachment, from the first pages of the list
const pdfItems: ItemRow[] = [];
for (let i = 0; i < 40 && pdfItems.length < 2; i++) {
	const it = store.itemAt(i);
	if (it?.primaryAttachment && !/epub|html/i.test(it.primaryAttachment.contentType ?? "")) pdfItems.push(it);
	if (!it) await frames(100);
}
if (pdfItems.length < 2) { console.error("need 2 items with a PDF in the first 40 rows, found", pdfItems.length); process.exit(1); }
const [a, b] = pdfItems as [ItemRow, ItemRow];

// scroll the list down so a preserved scroll position is visible in the library shot
const native = r as unknown as { getListScrollTop(id: number): number[] | null };
const list = r.findByType("virtual-list")[0]!; // before any reader opens, the only list is the library's
(r as unknown as { scrollToItem(id: number, i: number, o?: number): void }).scrollToItem(list.id, 30);
await frames(1500);
const scrollBefore = native.getListScrollTop(list.id);
const beforePng = `${outDir}/tabs-before.png`;
r.captureScreenshot(beforePng); // library, scrolled, no tabs: the reference for "scroll position kept"

store.openAttachment(a.primaryAttachment!.key, a.title, a.key);
await frames(500);
store.openAttachment(b.primaryAttachment!.key, b.title, b.key);
await frames(500);
check("two reader tabs after openAttachment", store.tabs().length === 3, store.tabs().map((x) => x.id).join(","));
store.openAttachment(a.primaryAttachment!.key, a.title, a.key); // already open: focus, no duplicate
check("re-opening focuses the existing tab", store.tabs().length === 3 && store.activeTab() === a.primaryAttachment!.key);
store.setActiveTab(b.primaryAttachment!.key);

// wait for the second PDF's first page, then shoot the reader tab
await frames(3000);
r.captureScreenshot(`${outDir}/tabs-reader.png`);
console.log("wrote", `${outDir}/tabs-reader.png`);

// back to the library: same scroll position, tabs still in the strip
store.setActiveTab("library");
await frames(800);
r.captureScreenshot(`${outDir}/tabs-library.png`);
console.log("wrote", `${outDir}/tabs-library.png`);
const scrollAfter = native.getListScrollTop(list.id);
const diff = belowTopBarDiff(beforePng, `${outDir}/tabs-library.png`);
check("library scroll position kept", JSON.stringify(scrollBefore) === JSON.stringify(scrollAfter) && diff < 0.5, `list anchor ${JSON.stringify(scrollBefore)} -> ${JSON.stringify(scrollAfter)}, ${diff.toFixed(3)}% of pixels below the top bar differ from before opening the tabs`);

// closing: the active reader tab goes, its neighbour takes over
store.setActiveTab(a.primaryAttachment!.key);
store.closeTab(a.primaryAttachment!.key);
check("closing the active tab activates its neighbour", store.activeTab() === b.primaryAttachment!.key, store.activeTab());
store.closeTab(b.primaryAttachment!.key);
check("closing the last reader tab returns to the library", store.activeTab() === "library" && store.tabs().length === 1);
store.closeTab("library");
check("the library tab cannot be closed", store.tabs().length === 1);

/** Percentage of pixels below the 40px top bar that differ between two screenshots (hover/anti-aliasing noise aside, 0 = identical list). */
function belowTopBarDiff(f1: string, f2: string): number {
	const A = PNG.sync.read(readFileSync(f1)), B = PNG.sync.read(readFileSync(f2));
	if (A.width !== B.width || A.height !== B.height) return 100;
	let n = 0, total = 0;
	for (let y = 44; y < A.height; y++) for (let x = 0; x < A.width; x++) {
		const o = (y * A.width + x) * 4;
		total++;
		if (Math.abs(A.data[o]! - B.data[o]!) + Math.abs(A.data[o + 1]! - B.data[o + 1]!) + Math.abs(A.data[o + 2]! - B.data[o + 2]!) > 24) n++;
	}
	return (100 * n) / total;
}

t.unmount();
process.exit(failed ? 1 : 0);
