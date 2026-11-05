// Headless probe of the Locate menu (no window opens): right-click an item and open the item pane's More menu, check the
// four entries and (through stubbed open/reveal calls, so no browser or Explorer opens) the URL each one passes on.
// Shots: <out>/shell-locate-context.png and shell-locate-pane.png.
//   ZN_URL=http://127.0.0.1:<port> bun scripts/shot-locate.tsx [--out DIR]
// The OpenURL resolver is seeded in the throw-away ui-state.json (scripts/_shell-env.ts), so nothing of the user's is touched.
import { SHOTS } from "./_shell-env";
import { boot, sleep } from "./shell-shot-lib";
import { setOpenUrlResolver } from "../src/locate/prefs";
import { api } from "../src/api";
import { ipApi } from "../src/itempane/net";
import { getDetail } from "../src/cards/actions";
import { itemMenuItems } from "../src/cards/menus";
import { fieldOf } from "../src/table/defs";
import { locateItemOf } from "../src/locate/item";
import { buildOpenUrl, googleScholarUrl, viewOnlineUrl } from "../src/locate/openurl";
import { openMenu } from "../src/ui";

const RESOLVER = "https://library.example.edu/openurl/";
const args = process.argv.slice(2);
const out = args.includes("--out") ? args[args.indexOf("--out") + 1]! : SHOTS;
setOpenUrlResolver(RESOLVER);

// No browser and no Explorer: record what the menu entries hand to the existing open/reveal helpers.
const opened: string[] = [];
const revealed: string[] = [];
api.openUrl = async (url) => { opened.push(url); return { ok: true }; };
api.reveal = async (key) => { revealed.push(key); return { ok: true }; };
ipApi.openUrl = async (url) => { opened.push(url); return { ok: true }; };
ipApi.reveal = async (key) => { revealed.push(key); return { ok: true }; };

const h = await boot({ prefs: { mode: "dark" } });
const r = h.t.renderer;
let failed = 0;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) failed++; };
const has = (s: string) => r.getAllText().some((t) => t.includes(s));
const bounds = (s: string) => {
	const el = r.findByText(s);
	return el ? r.getElementBounds(el.id) : null;
};
const clickText = async (s: string) => {
	const b = bounds(s);
	if (!b) throw new Error(`no text "${s}"`);
	r.nativeSimulateClick(b.x + b.width / 2, b.y + b.height / 2);
	await h.settle(500);
};
const hoverText = async (s: string) => {
	const b = bounds(s);
	if (!b) throw new Error(`no text "${s}"`);
	r.nativeSimulateMouseMove(b.x + b.width / 2, b.y + b.height / 2);
	await h.settle(400);
};
/** The menu the row's right-click (or the table's) builds, opened directly: the test renderer can swallow a repeat right-click
 *  once the detail is cached (the menu appears inside the click it would then close). */
const showItemMenu = async (key: string) => {
	let item = h.store.itemAt(0);
	for (let i = 0; i < 200; i++) if (h.store.itemAt(i)?.key === key) { item = h.store.itemAt(i); break; }
	if (!item) throw new Error(`no row ${key}`);
	const detail = await getDetail(key);
	openMenu({ x: 420, y: 300 }, itemMenuItems(item, [key], detail));
	await h.settle(400);
	await hoverText("Locate");
};

/** First visible row title (table cells may be clipped with an ellipsis). */
const rowTitle = (): { key: string; x: number; y: number } | null => {
	const texts = r.findByType("text").map((e) => ({ e, b: r.getElementBounds(e.id) })).filter((x) => x.b);
	for (let i = 0; i < 60; i++) {
		const it = h.store.itemAt(i);
		if (!it?.title || it.title.length < 4) continue;
		const key = it.title.slice(0, 16);
		const hit = texts.find((x) => (x.e.text ?? "").includes(key) && x.b!.y > 100 && x.b!.x > 260 && x.b!.x < 1000);
		if (hit) return { key: it.key, x: hit.b!.x + 30, y: hit.b!.y + 6 };
	}
	return null;
};

// 1. the real right-click path on a row (cards and the Classic table share cards/menus.ts itemMenuItems)
const row = rowTitle();
if (!row) {
	check("a list row is visible", false);
} else {
	r.nativeSimulateClick(row.x, row.y, 2);
	await h.settle(700);
	check("context menu has Locate", has("Locate"));
	check("context menu keeps Open", has("Open"));
	await hoverText("Locate");
	for (const label of ["View Online", "Library Lookup", "Search Google Scholar", "Show File"]) check(`Locate has ${label}`, has(label));
	const shot = `${out}/shell-locate-context.png`;
	r.captureScreenshot(shot);
	console.log("wrote", shot);
	r.nativeSimulateClick(1400, 840); // backdrop: the first row has no web address, so its View Online stays disabled
	await h.settle(300);
}

if (row) {
	const detail = await api.item(row.key);
	const item = locateItemOf(detail.data);
	const online = viewOnlineUrl(item);
	const lookup = buildOpenUrl(item, RESOLVER);
	const scholar = googleScholarUrl(item.title);

	await showItemMenu(row.key);
	await clickText("View Online");
	if (online) check("View Online opens the item URL", opened.at(-1) === online);
	else check("View Online is disabled without a web address", opened.length === 0);

	await showItemMenu(row.key);
	await clickText("Library Lookup");
	check("Library Lookup opens the OpenURL link", opened.at(-1) === lookup);

	await showItemMenu(row.key);
	await clickText("Search Google Scholar");
	check("Search Google Scholar opens the title search", opened.at(-1) === scholar);

	const fileKey = detail.children.find((c) => c.hasFile)?.key;
	await showItemMenu(row.key);
	await clickText("Show File");
	check(fileKey ? "Show File reveals the attachment" : "Show File is disabled without a file", fileKey ? revealed[0] === fileKey : revealed.length === 0);
}

// 2. View Online on an item that has a URL or DOI (the first row of this library copy has neither)
let withLink = -1;
for (let i = 0; i < 200 && withLink < 0; i++) {
	const it = h.store.itemAt(i);
	if (it && (fieldOf(it, "url") || fieldOf(it, "DOI"))) withLink = i;
}
if (withLink < 0) {
	check("an item with a URL or DOI exists", false);
} else {
	const it = h.store.itemAt(withLink)!;
	const expected = viewOnlineUrl(locateItemOf((await api.item(it.key)).data));
	await showItemMenu(it.key);
	await clickText("View Online");
	check("View Online opens the item URL", opened.at(-1) === expected);
}

// 3. the Classic table: the same menu items, from the table's shared itemMenuItems
h.store.setViewMode("table");
await h.settle(900);
const trow = rowTitle();
if (!trow) {
	check("a table row is visible", false);
} else {
	await showItemMenu(trow.key);
	check("table menu has Locate", has("Locate"));
	check("table Locate has Library Lookup", has("Library Lookup"));
	r.nativeSimulateClick(1400, 840);
	await h.settle(300);
}

// 4. the item pane's More menu (itempane/Header.tsx moreItems): pick an item with a file
let withFile = -1;
for (let i = 0; i < 200 && withFile < 0; i++) if (h.store.itemAt(i)?.primaryAttachment) withFile = i;
if (withFile < 0) {
	check("an item with an attachment exists", false);
} else {
	const key = h.store.itemAt(withFile)!.key;
	h.store.selectItem(key);
	await h.settle(1800);
	if (has("Locate")) { r.simulateKeystrokes("escape"); await h.settle(300); }
	const more = r.findByTestId("ip-more");
	const mb = more ? r.getElementBounds(more.id) : null;
	if (!mb) {
		check("item pane More button", false);
	} else {
		r.nativeSimulateClick(mb.x + mb.width / 2, mb.y + mb.height / 2);
		await h.settle(500);
		check("More menu has Locate", has("Locate"));
		await hoverText("Locate");
		for (const label of ["View Online", "Library Lookup", "Search Google Scholar", "Show File"]) check(`pane Locate has ${label}`, has(label));
		const shot = `${out}/shell-locate-pane.png`;
		r.captureScreenshot(shot);
		console.log("wrote", shot);

		const pd = await ipApi.item(key);
		const paneFile = pd.children.find((c) => c.hasFile)?.key;
		const before = revealed.length;
		await clickText("Show File");
		check("pane Show File reveals the attachment", !!paneFile && revealed.length > before && revealed.at(-1) === paneFile);
	}
}

await sleep(300);
h.t.unmount();
console.log(failed ? `${failed} check(s) failed` : "all Locate checks passed");
process.exit(failed ? 1 : 0);
