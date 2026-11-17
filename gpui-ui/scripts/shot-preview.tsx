// Headless check of the item pane's PDF page preview (src/itempane/Preview.tsx) against an in-process core on a library COPY:
//   ZN_DB=<copy of library.sqlite> ZN_PORT=23160 ZN_SHOTS=<dir> bun scripts/shot-preview.tsx
// Picks items whose PDF is on disk, then measures: time from selecting an item to its first page thumbnail (HEAD, fetch, open,
// render), scrolling the strip (pages mount and render on demand), fast selection changes (only the item it stops on is read),
// memory (thumbnail cache bytes, process RSS), the size guard ("Show preview"), and double-click -> reader tab at that page.
// Writes <ZN_SHOTS>/preview-*.png. Reads the attachment files (never writes them); the core writes only to the copy.
import "./_shell-env";
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { boot, sleep, SHOTS } from "./shell-shot-lib";
import { startCore } from "../src/core";
import { ItemPane } from "../src/itempane";
import { OverlayHost } from "../src/ui";
import { store } from "../src/store";
import { tw } from "../src/theme";
import { previewStats, setPreviewMaxBytes, thumbCache, PREVIEW_CACHE_BYTES } from "../src/itempane/previewDoc";

const dbPath = process.env.ZN_DB;
if (!dbPath) throw new Error("set ZN_DB to a COPY of library.sqlite");

// ---- candidates: regular items whose PDF attachment is a file on disk (absolute path, so no storage lookup is needed to size it)
const ro = new Database(dbPath, { readonly: true });
const rows = ro
	.query(
		`SELECT i.parent_key AS parent, a.item_key AS att, a.path AS path FROM attachments a JOIN items i ON i.key = a.item_key
		 JOIN items p ON p.key = i.parent_key
		 WHERE a.content_type LIKE '%pdf%' AND i.deleted = 0 AND p.deleted = 0 AND a.path NOT LIKE 'attachments:%' LIMIT 3000`,
	)
	.all() as { parent: string; att: string; path: string }[];
ro.close();
const onDisk = rows
	.map((r) => {
		try {
			return existsSync(r.path) ? { ...r, size: statSync(r.path).size } : null;
		} catch {
			return null;
		}
	})
	.filter((r): r is { parent: string; att: string; path: string; size: number } => !!r && r.size > 0);
const byParent = new Map<string, (typeof onDisk)[number]>();
for (const r of onDisk) if (!byParent.has(r.parent)) byParent.set(r.parent, r);
const cands = [...byParent.values()];
console.log(`candidates: ${cands.length} items with a PDF on disk (of ${rows.length} PDF attachments)`);
const pick = (lo: number, hi: number, skip: Set<string>) => cands.find((c) => c.size >= lo && c.size <= hi && !skip.has(c.parent));
const used = new Set<string>();
const short = pick(200e3, 1.5e6, used);
if (short) used.add(short.parent);
const long = [...cands].filter((c) => c.size < 25e6 && !used.has(c.parent)).sort((a, b) => b.size - a.size)[0];
if (long) used.add(long.parent);
const third = pick(300e3, 4e6, used);
if (third) used.add(third.parent);
if (!short || !long || !third) throw new Error("not enough items with PDFs on disk");

const core = await startCore();
console.log("core:", core?.url);

const { t, settle, click } = await boot({
	prefs: { mode: "light" },
	width: 1100,
	height: 900,
	view: () => (
		<div style={{ ...tw("flex bg-canvas", store.mode()), width: "100%", height: "100%" }}>
			<div style={{ flexGrow: 1 }} />
			<div
				style={{
					...tw("rounded-[14px] bg-background shadow-raised overflow-hidden", store.mode()),
					width: 403,
					height: "100%",
					flexShrink: 0,
				}}
			>
				<ItemPane />
			</div>
			<OverlayHost />
		</div>
	),
});
store.setMode("light");

const shot = async (name: string) => {
	await settle(400);
	const file = `${SHOTS}/preview-${name}.png`;
	t.renderer.captureScreenshot(file);
	console.log("wrote", file);
};
const boundsOf = (testId: string) => {
	const el = t.renderer.findByTestId(testId);
	return el ? t.renderer.getElementBounds(el.id) : null;
};
/** Click the Files tab until the preview is on screen (the pane can scroll back to the top while the item's detail settles). */
const toFiles = async () => {
	for (let i = 0; i < 8; i++) {
		const b = boundsOf("ip-nav-attachments");
		if (!b) {
			await settle(60);
			continue;
		}
		await click(b.x + b.width / 2, b.y + b.height / 2);
		await sleep(150);
		await settle(150);
		const p = boundsOf("ip-preview");
		if (p && p.y > 0 && p.y < 880) return;
	}
	console.log("!! the preview did not come into view");
};
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const med = (a: number[]) => {
	const s = [...a].sort((x, y) => x - y);
	return s.length ? s[Math.floor(s.length / 2)]!.toFixed(1) : "-";
};
/** select, show the Files section, and wait for the first thumbnail; ms from the selection to it */
async function selectAndWait(key: string): Promise<number> {
	const r0 = previewStats.renders;
	const t0 = performance.now();
	store.selectItem(key);
	await settle(30);
	await toFiles();
	for (let i = 0; i < 400 && previewStats.renders === r0; i++) await settle(15);
	const ms = performance.now() - t0;
	await toFiles();
	return ms;
}

// ---- 1. a short paper: time to the first page, then a screenshot
const ms1 = await selectAndWait(short.parent);
console.log(
	`short (${short.parent}, ${mb(short.size)}): first thumbnail ${ms1.toFixed(0)} ms after select (script incl. tab clicks), ` +
		`${previewStats.firstShownMs.toFixed(0)} ms after the preview mounted (incl. the 100 ms delay);` +
		` HEAD ${previewStats.headMs.toFixed(1)} ms, fetch ${previewStats.fetchMs.toFixed(1)} ms, open ${previewStats.openMs.toFixed(1)} ms,` +
		` render median ${med(previewStats.renderMs)} ms`,
);
await shot("short");

// ---- 2. a long PDF: scroll the strip to the end with the wheel, pages render as they come into view
const rss0 = process.memoryUsage().rss;
const ms2 = await selectAndWait(long.parent);
const rendersBefore = previewStats.renders;
console.log(
	`long (${long.parent}, ${mb(long.size)}): first thumbnail ${ms2.toFixed(0)} ms (${previewStats.firstShownMs.toFixed(0)} ms after mount); HEAD ${previewStats.headMs.toFixed(1)} ms, fetch ${previewStats.fetchMs.toFixed(1)} ms, open ${previewStats.openMs.toFixed(1)} ms`,
);
await shot("long");
const strip = boundsOf("ip-preview-strip");
if (!strip) throw new Error("no preview strip");
let maxImgs = 0;
const tScroll = performance.now();
for (let k = 0; k < 60; k++) {
	t.renderer.nativeSimulateScrollWheel(strip.x + strip.width / 2, strip.y + strip.height / 2, 0, -240);
	await settle(30);
	maxImgs = Math.max(maxImgs, t.renderer.findByType("img").length);
}
await settle(800);
console.log(
	`scrolled 60 wheel steps in ${(performance.now() - tScroll).toFixed(0)} ms: ${previewStats.renders - rendersBefore} pages rendered,` +
		` at most ${maxImgs} <img> mounted at once; render median ${med(previewStats.renderMs)} ms`,
);
await shot("long-scrolled");
console.log(
	`memory: thumbnail cache ${mb(thumbCache.bytes)} in ${thumbCache.size} thumbnails (cap ${mb(PREVIEW_CACHE_BYTES)}),` +
		` RSS ${mb(rss0)} -> ${mb(process.memoryUsage().rss)}`,
);

// ---- 3. fast selection changes: 40 items, 30 ms apart, while the Files section is shown; only the last should be read
const scrub = cands.filter((c) => !used.has(c.parent)).slice(0, 40);
const open0 = previewStats.opened;
for (const c of scrub) {
	store.selectItem(c.parent);
	await settle(30);
}
await settle(1200);
await toFiles();
for (let i = 0; i < 100 && previewStats.opened === open0; i++) await settle(30);
await settle(300);
console.log(
	`scrub: ${scrub.length} selections 30 ms apart -> ${previewStats.opened - open0} documents opened; open now ${previewStats.opened - previewStats.closed} (want 1)`,
);

// ---- 4. back to the short paper: its thumbnails come from the cache before the file is read again
const hits0 = thumbCache.hits;
store.selectItem(short.parent);
await settle(60);
await toFiles();
console.log(`back to the short paper: ${thumbCache.hits - hits0} cache hits right away`);
await settle(500);

// ---- 5. the size guard: a limit below the third file's size
setPreviewMaxBytes(100 * 1024);
store.selectItem(third.parent);
for (let i = 0; i < 40; i++) await settle(30);
await toFiles();
await settle(800);
const hasBtn = t.renderer.getAllText().some((s) => s.includes("Show preview"));
console.log(`size guard (${mb(third.size)} > 0.1 MB): "Show preview" shown: ${hasBtn}`);
await shot("big");
if (hasBtn) {
	const el = t.renderer.findByText("Show preview")!;
	const b = t.renderer.getElementBounds(el.id)!;
	const r0 = previewStats.renders;
	await click(b.x + b.width / 2, b.y + b.height / 2);
	for (let i = 0; i < 200 && previewStats.renders === r0; i++) await settle(15);
	console.log(`after "Show preview": ${previewStats.renders - r0} pages rendered`);
	await shot("big-shown");
}
setPreviewMaxBytes(30 * 1024 * 1024);

// ---- 6. double-click the second page: a reader tab for that attachment (the test window delivers only one of two quick clicks,
// so the page's click layer gets a click with clickCount 2 directly, as shot-table.tsx does for its rows)
const page2 = t.renderer.findByTestId("ip-preview-page-1") ?? t.renderer.findByTestId("ip-preview-page-0");
if (page2) {
	const root = (t as unknown as { root: { dispatch(e: object): boolean } }).root;
	root.dispatch({ elementId: page2.id, eventType: "click", clickCount: 2, button: 0 });
	await settle(300);
	await sleep(600);
	console.log(`double-click: tabs ${JSON.stringify(store.tabs().map((x) => x.id))}, active ${store.activeTab()} (want ${third.att})`);
} else console.log("!! no page to double-click");

await core?.stop();
process.exit(0);
