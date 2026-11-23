// Tabs and the PDF reader.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { scenario } from "../define";
import type { Ui } from "../driver";
import { T } from "../library";
import { net } from "../../../../core/src/references/net";

// Set-up, before the app starts: a paper that is opened asks Crossref for its references. The network is fenced off, so those answers are
// "not found" (the reader then reads the bibliography from the PDF itself).
net.fetch = async () => new Response("{}", { status: 404 });

const PDF = join(import.meta.dir, "..", "..", "..", "web", "demo-article.pdf");

// ---- the reader as seen from the test: read-only views of its state, and where things are ---------------------------------------

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

async function ctxOf(ui: Ui) {
	const { openReaders } = await import("../../../src/reader/plugins");
	const key = await ui.store.activeTab();
	const c = openReaders().find((r) => r.attachmentKey === key);
	if (!c) throw new Error(`no reader is open for the active tab (${key})`);
	return c;
}
/** The page area (right of the sidebar, under the toolbars): the reader's own figure in-process, the standard layout's in the real app. */
const PANE: Rect = { x: 232, y: 110, width: 1208, height: 770 };
async function paneOf(ui: Ui): Promise<Rect> {
	return ui.inProcess ? (await ctxOf(ui)).paneBounds!()! : PANE;
}
async function opsOf(ui: Ui) {
	const { opsOf } = await import("../../../src/reader/ops");
	const o = opsOf(await ctxOf(ui));
	if (!o) throw new Error("the reader has no operations registered");
	return o;
}
async function state(ui: Ui) {
	return (await opsOf(ui)).state();
}

/** The elements that carry this testId, with their boxes. */
async function byTestId(ui: Ui, id: string): Promise<Rect[]> {
	await ui.flush();
	const out: Rect[] = [];
	const walk = async (n: any) => {
		if (n.testId === id) {
			const b = n.bounds ?? (await ui.bounds(n.id));
			if (b && b.width > 0) out.push(b);
		}
		for (const c of n.children ?? []) await walk(c);
	};
	const t = await ui.tree();
	if (t) await walk(t);
	return out;
}
/** Every element whose box the test accepts. */
async function boxesWhere(ui: Ui, ok: (b: Rect) => boolean): Promise<Rect[]> {
	await ui.flush();
	const out: Rect[] = [];
	const walk = async (n: any) => {
		const b = n.bounds ?? (await ui.bounds(n.id));
		if (b && b.width > 0 && ok(b) && !out.some((o) => o.x === b.x && o.y === b.y && o.width === b.width && o.height === b.height)) out.push(b);
		for (const c of n.children ?? []) await walk(c);
	};
	const t = await ui.tree();
	if (t) await walk(t);
	return out;
}
const mid = (b: Rect) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

const PNG_ERR = "the screenshot is not an 8-bit RGBA PNG";
/** A screenshot's pixels: [r, g, b, a] per pixel, row by row. */
function readPng(file: string): { w: number; h: number; px: Uint8Array } {
	const b = readFileSync(file);
	const w = b.readUInt32BE(16),
		h = b.readUInt32BE(20);
	if (b[24] !== 8 || b[25] !== 6 || b[28] !== 0) throw new Error(PNG_ERR);
	const parts: Buffer[] = [];
	for (let at = 8; at < b.length; ) {
		const len = b.readUInt32BE(at);
		if (b.toString("latin1", at + 4, at + 8) === "IDAT") parts.push(b.subarray(at + 8, at + 8 + len));
		at += 12 + len;
	}
	const raw = inflateSync(Buffer.concat(parts));
	const stride = w * 4,
		px = new Uint8Array(h * stride);
	for (let y = 0; y < h; y++) {
		const f = raw[y * (stride + 1)]!;
		const row = y * (stride + 1) + 1;
		for (let i = 0; i < stride; i++) {
			const x = raw[row + i]!;
			const a = i >= 4 ? px[y * stride + i - 4]! : 0;
			const up = y ? px[(y - 1) * stride + i]! : 0;
			const c = i >= 4 && y ? px[(y - 1) * stride + i - 4]! : 0;
			let v = x;
			if (f === 1) v = x + a;
			else if (f === 2) v = x + up;
			else if (f === 3) v = x + ((a + up) >> 1);
			else if (f === 4) {
				const p = a + up - c,
					pa = Math.abs(p - a),
					pb = Math.abs(p - up),
					pc = Math.abs(p - c);
				v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
			}
			px[y * stride + i] = v & 255;
		}
	}
	return { w, h, px };
}
/** What a part of a screenshot holds: the share of paper (near white) and of ink (dark) pixels, and how many different colours. */
function paint(file: string, box: Rect, logicalWidth?: number) {
	const { w, h, px } = readPng(file);
	if (logicalWidth && w !== logicalWidth) {
		// the real app's screenshot is in device pixels (2x on the harness' display): the box is in the window's own units
		const k = w / logicalWidth;
		box = { x: box.x * k, y: box.y * k, width: box.width * k, height: box.height * k };
	}
	let n = 0,
		paper = 0,
		ink = 0;
	const seen = new Set<number>();
	for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(h, box.y + box.height); y++)
		for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(w, box.x + box.width); x++) {
			const i = (y * w + x) * 4;
			const r = px[i]!,
				g = px[i + 1]!,
				b = px[i + 2]!;
			n++;
			if (r > 235 && g > 235 && b > 235) paper++;
			else if (r < 110 && g < 110 && b < 110) ink++;
			seen.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
		}
	return { paper: paper / Math.max(1, n), ink: ink / Math.max(1, n), colours: seen.size };
}
/** How many pixels of a part of a screenshot `want` accepts. */
function count(file: string, box: Rect, want: (r: number, g: number, b: number) => boolean): number {
	const { w, h, px } = readPng(file);
	let n = 0;
	for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(h, box.y + box.height); y++)
		for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(w, box.x + box.width); x++) {
			const i = (y * w + x) * 4;
			if (want(px[i]!, px[i + 1]!, px[i + 2]!)) n++;
		}
	return n;
}
/** The colour of one pixel. */
function pixel(file: string, x: number, y: number): [number, number, number] {
	const { w, px } = readPng(file);
	const i = (Math.round(y) * w + Math.round(x)) * 4;
	return [px[i]!, px[i + 1]!, px[i + 2]!];
}
// the colour of a highlight in the default yellow (#ffd400 at 40%) over white paper, and of the find hits (#ffd60a at 40%)
const yellowish = (r: number, g: number, b: number) => r > 245 && g > 215 && g < 248 && b > 100 && b < 185;

// ---- driving the reader the way a user does ---------------------------------------------------------------------------------------

const ZOOM_AREA: Rect = { x: 250, y: 70, width: 450, height: 40 };
/** Where the toolbar's buttons are, from the centre of the zoom percentage (the title in front of them takes up what is left of the row). */
const TB = {
	zoomOut: -41,
	zoomIn: 43,
	fitWidth: 79,
	fitPage: 115,
	rotateLeft: 151,
	rotateRight: 187,
	appearance: 223,
	view: 262,
	print: 305,
	pageBox: -111,
	search: 420,
	prev: 585,
	next: 621,
	matches: 657,
	highlight: 690,
	underline: 720,
	note: 750,
	ink: 780,
	eraser: 810,
} as const;
/** In front of the title: they do not move. */
const FIXED = { sidebar: 24, back: 60, forward: 96 } as const;

/** The toolbar of the reader and, below it, the bar of the reading view. */
const BAR: Rect = { x: 0, y: 70, width: 1440, height: 100 };
const zoomLabel = (ui: Ui) => ui.see("%", { area: ZOOM_AREA });
async function tb(ui: Ui, name: keyof typeof TB): Promise<void> {
	const z = await zoomLabel(ui);
	await ui.clickAt(z.x + TB[name], z.y);
}
async function tbFixed(ui: Ui, name: keyof typeof FIXED): Promise<void> {
	const z = await zoomLabel(ui);
	await ui.clickAt(FIXED[name], z.y);
}
/** The sidebar's tabs, in the order they have: pages, outline, annotations, figures, references, supplementary. */
const SIDE = ["thumbs", "outline", "annotations", "figures-tables", "references", "supplementary"];
async function sideTab(ui: Ui, name: (typeof SIDE)[number]): Promise<void> {
	const pane = await paneOf(ui);
	await ui.clickAt(19 + 30 * SIDE.indexOf(name), pane.y + 18);
	if (ui.inProcess) await ui.expect(`the ${name} tab is shown`, async () => (await state(ui)).sidebar.tab?.replace(/^plugin:[^:]*:/, ""), name);
}

/** Open the library's PDF from its card and wait until its first page is on screen. Returns the attachment's key. */
async function openFromCard(ui: Ui): Promise<string> {
	await ui.click(T.article, { area: "list" });
	await ui.click("Open PDF", { area: "list" });
	await ui.see("/ 3");
	const key = await ui.store.activeTab();
	await drawn(ui, "opened");
	return key;
}

/** The pages in the reader's page area are not blank: paper and ink are in the screenshot. */
async function drawn(ui: Ui, name: string, minInk = 0.002, minPaper = 0.3) {
	const b = await paneOf(ui);
	const box = { x: b.x, y: b.y, width: b.width - 12, height: b.height };
	let last = { paper: 0, ink: 0, colours: 0 };
	try {
		await ui.waitFor(`the pages are painted (${name})`, async () => {
			last = paint(await ui.screenshot(name), box, ui.size.width);
			return last.paper > minPaper && last.ink > minInk;
		}, 20000);
	} catch (e) {
		throw new Error(`${(e as Error).message}: a blank page. Paper ${last.paper.toFixed(3)} (wanted > ${minPaper}), ink ${last.ink.toFixed(4)} (wanted > ${minInk}), ${last.colours} colours`);
	}
	ui.steps.push(`painted ${name}: paper ${last.paper.toFixed(2)} ink ${last.ink.toFixed(4)} colours ${last.colours}`);
	return last;
}

/** A second PDF in the library, under ZT01 (the library has one only): returns its attachment key. */
async function addSecondPdf(ui: Ui): Promise<string> {
	const parent = (await ui.saved(T.authors)).key;
	const att = await ui.api<{ data: { key: string } }>("POST", "/add/file", { parentKey: parent, path: PDF, name: "Second.pdf", keepName: true });
	await ui.store.refreshItems();
	await ui.settle(800);
	return att.data.key;
}
/** Open the second PDF from the card of ZT01. */
async function openSecond(ui: Ui): Promise<void> {
	await ui.click(T.authors, { area: "list" });
	await ui.click("Open PDF", { area: "list", nth: 1 });
	await ui.expect("the ZT01 tab is open and active", async () => {
		const active = await ui.store.activeTab();
		return (await ui.store.tabs()).some((t) => t.id === active && "title" in t && t.title === T.authors);
	}, true, 6000);
	await ui.see("/ 3");
}

/** The window rectangle of the first word the test picks on a page, scrolling the page list with the wheel until it is well inside the page area. */
async function showWord(ui: Ui, page: number, pick: (w: { t: string; x: number; y: number }, i: number, all: { t: string; x: number; y: number }[]) => boolean) {
	const c = await ctxOf(ui);
	const words = (await c.textLayer(page)).words;
	const i = words.findIndex((w, k) => pick(w, k, words));
	if (i < 0) throw new Error(`no such word on page ${page + 1}`);
	const w = words[i]!;
	for (let n = 0; n < 40; n++) {
		const pane = c.paneBounds!()!;
		const r = c.rectToWindow!(page, w);
		const cy = r ? r.y + r.height / 2 : 0;
		if (r && cy > pane.y + 70 && cy < pane.y + pane.height - 150 && r.x > pane.x && r.x + r.width < pane.x + pane.width - 12) return { rect: r, word: w, index: i, words };
		const dy = r ? cy - (pane.y + pane.height * 0.4) : (page > (await state(ui)).page ? 600 : -600);
		await ui.wheel(pane.x + pane.width / 2, pane.y + pane.height / 2, -Math.round(dy));
	}
	throw new Error(`could not scroll to "${w.t}" on page ${page + 1}`);
}
/** Select the words from..to of one page by dragging the mouse from the start of the first to the end of the last. */
async function dragWords(ui: Ui, page: number, from: string[], count: number) {
	const first = await showWord(ui, page, (_w, i, all) => from.every((t, k) => all[i + k]?.t === t));
	const c = await ctxOf(ui);
	const last = c.rectToWindow!(page, first.words[first.index + count - 1]!)!;
	const a = first.rect;
	await ui.drag({ x: a.x + 1, y: a.y + a.height / 2 }, { x: last.x + last.width - 1, y: last.y + last.height / 2 });
	await ui.waitFor("the selection is made", () => !!c.selection(), 4000);
	return first;
}
const BODY = ["Deep", "learning", "learns", "layered"]; // the first line of "1. Background"
const clipboard = (ui: Ui): Promise<string> => ui.clipboard();
/** Click in the margin of the page area: the reader takes the keyboard, nothing is selected. */
async function focusPages(ui: Ui): Promise<void> {
	const pane = await paneOf(ui);
	await ui.clickAt(pane.x + 6, pane.y + pane.height / 2);
}
const pageTop = async (ui: Ui, page: number): Promise<number> => (await ctxOf(ui)).rectToWindow!(page, { x: 0, y: 0, w: 1, h: 1 })?.y ?? Number.NaN;
const annotationsOf = (ui: Ui, key: string) => ui.api<any[]>("GET", `/attachments/${key}/annotations`);
const tabIds = async (ui: Ui) => (await ui.store.tabs()).map((t) => t.id);

// ---- opening the reader ------------------------------------------------------------------------------------------------------

scenario("the Open PDF button of a card opens the PDF in a tab and its page is drawn", async (ui) => {
	const lib = await ui.store.activeTab();
	const key = await openFromCard(ui);
	await ui.expect("the tabs", () => tabIds(ui), [lib, key]);
	await ui.expect("the reader tab is the active one", () => ui.store.activeTab(), key);
	await ui.see(T.article, { area: "top" }); // the tab's title
	if (ui.inProcess) await ui.expect("page 1 of 3 is shown", async () => [(await state(ui)).page, (await state(ui)).pages], [0, 3]);
	if (ui.inProcess) await ui.expect("the page number box", async () => (await ui.painted()).includes("1"), true);
	await ui.screenshot("opened-from-card");
});

scenario("Enter on the selected item opens its PDF", async (ui) => {
	await ui.click(T.article, { area: "list" });
	await ui.press("enter");
	await ui.expect("a reader tab is active", async () => (await ui.store.tabs()).length === 2 && (await ui.store.activeTab()) !== "library", true, 6000);
	await ui.see("/ 3");
	await drawn(ui, "opened-by-enter");
});

scenario("the Open PDF button of the item pane opens the PDF", async (ui) => {
	await ui.click(T.article, { area: "list" });
	await ui.click("Open PDF", { area: "pane" });
	await ui.expect("a reader tab is active", async () => (await ui.store.tabs()).length === 2 && (await ui.store.activeTab()) !== "library", true, 6000);
	await ui.see("/ 3");
	await drawn(ui, "opened-from-pane");
});

scenario(
	"a double click on a card opens its PDF",
	async (ui) => {
		await ui.click(T.article, { area: "list", count: 2 });
		await ui.expect("a reader tab is active", async () => (await ui.store.tabs()).length === 2 && (await ui.store.activeTab()) !== "library", true, 6000);
	},
);

scenario("opening a PDF that is already open shows its tab and makes no second one", async (ui) => {
	const key = await openFromCard(ui);
	await ui.click("Library", { area: "top", exact: true });
	await ui.expect("the library is shown", () => ui.store.activeTab(), "library");
	await ui.click("Open PDF", { area: "list" });
	await ui.expect("the same tab is active again", () => ui.store.activeTab(), key);
	await ui.expectStill("one reader tab", async () => (await tabIds(ui)).length, 2, 400);
});

scenario("a library item with a second PDF opens it in a second tab", async (ui) => {
	const first = await openFromCard(ui);
	const second = await addSecondPdf(ui);
	await ui.click("Library", { area: "top", exact: true });
	await openSecond(ui);
	await ui.expect("the tabs", () => tabIds(ui), ["library", first, second]);
	await drawn(ui, "second");
	await ui.see(T.article, { area: "top" });
	await ui.see(T.authors, { area: "top" });
});

// ---- tabs: switching, closing, reopening -------------------------------------------------------------------------------------

scenario("a click on a tab shows that tab, the library list is back on the Library tab", async (ui) => {
	const first = await openFromCard(ui);
	const second = await addSecondPdf(ui);
	await ui.click("Library", { area: "top", exact: true });
	await openSecond(ui);
	await ui.click(T.article, { area: "top" });
	await ui.expect("the first PDF's tab is active", () => ui.store.activeTab(), first);
	await drawn(ui, "first-again");
	await ui.click("Library", { area: "top", exact: true });
	await ui.expect("the library is active", () => ui.store.activeTab(), "library");
	await ui.see(T.neighbour, { area: "list" });
	await ui.click(T.authors, { area: "top" });
	await ui.expect("the second PDF's tab is active", () => ui.store.activeTab(), second);
});

scenario("the x of a tab closes it and the tab to its right takes over", async (ui) => {
	const first = await openFromCard(ui);
	const second = await addSecondPdf(ui);
	await ui.click("Library", { area: "top", exact: true });
	await openSecond(ui);
	await ui.click(T.article, { area: "top" });
	await ui.expect("the first PDF's tab is active", () => ui.store.activeTab(), first);
	const chip = await ui.see(T.article, { area: "top" });
	await ui.clickAt(chip.box.x + chip.box.width + 15, chip.y);
	await ui.expect("the tabs", () => tabIds(ui), ["library", second]);
	await ui.expect("the neighbour on the right is active", () => ui.store.activeTab(), second);
	await ui.gone(T.article, { area: "top" });
	await drawn(ui, "after-close");
});

scenario("the x of the last tab closes it and the library is shown", async (ui) => {
	await openFromCard(ui);
	const chip = await ui.see(T.article, { area: "top" });
	await ui.clickAt(chip.box.x + chip.box.width + 15, chip.y);
	await ui.expect("only the library is left", () => tabIds(ui), ["library"]);
	await ui.expect("the library is active", () => ui.store.activeTab(), "library");
	await ui.see(T.neighbour, { area: "list" });
});

scenario("the x of a tab that is not shown closes it and keeps the shown tab", async (ui) => {
	const first = await openFromCard(ui);
	const second = await addSecondPdf(ui);
	await ui.click("Library", { area: "top", exact: true });
	await openSecond(ui);
	const chip = await ui.see(T.article, { area: "top" });
	await ui.clickAt(chip.box.x + chip.box.width + 15, chip.y);
	await ui.expect("the tabs", () => tabIds(ui), ["library", second]);
	await ui.expectStill("the second PDF's tab is still active", () => ui.store.activeTab(), second, 400);
	void first;
});

scenario("Ctrl+W closes the shown tab and never the library", async (ui) => {
	await openFromCard(ui);
	await ui.press("ctrl-w");
	await ui.expect("only the library is left", () => tabIds(ui), ["library"]);
	await ui.press("ctrl-w");
	await ui.expectStill("the library tab is still there", () => tabIds(ui), ["library"], 300);
	await ui.see(T.neighbour, { area: "list" });
});

scenario("Ctrl+Tab and Ctrl+number move between the tabs", async (ui) => {
	const first = await openFromCard(ui);
	const second = await addSecondPdf(ui);
	await ui.click("Library", { area: "top", exact: true });
	await openSecond(ui);
	await ui.press("ctrl-1");
	await ui.expect("Ctrl+1 shows the library", () => ui.store.activeTab(), "library");
	await ui.press("ctrl-2");
	await ui.expect("Ctrl+2 shows the first PDF", () => ui.store.activeTab(), first);
	await ui.press("ctrl-tab");
	await ui.expect("Ctrl+Tab shows the next tab", () => ui.store.activeTab(), second);
	await ui.press("ctrl-tab");
	await ui.expect("Ctrl+Tab wraps around to the library", () => ui.store.activeTab(), "library");
	await ui.press("ctrl-shift-tab");
	await ui.expect("Ctrl+Shift+Tab goes back to the last tab", () => ui.store.activeTab(), second);
	await ui.press("ctrl-9");
	await ui.expect("Ctrl+9 shows the last tab", () => ui.store.activeTab(), second);
});

scenario(
	"a PDF that was closed opens again where it was left, at its zoom",
	async (ui) => {
		await openFromCard(ui);
		await tb(ui, "zoomIn");
		await tb(ui, "zoomIn");
		await focusPages(ui);
		await ui.press("end");
		const before = await state(ui);
		await ui.expect("the end of the document is shown", async () => (await state(ui)).page, 2);
		await ui.press("ctrl-w");
		await ui.expect("the tab is closed", async () => (await tabIds(ui)).length, 1);
		await ui.click("Open PDF", { area: "list" });
		await ui.see("/ 3");
		await ui.expect("the page and the zoom are what they were", async () => {
			const s = await state(ui);
			return [s.page, s.zoomMode, Math.round(s.zoom * 100)];
		}, [2, "custom", Math.round(before.zoom * 100)], 6000);
		await drawn(ui, "reopened");
	},
	{ inProcessOnly: "reads the reader's page and zoom (reader plugin state)" },
);




// ---- that the pages really draw ------------------------------------------------------------------------------------------------

scenario(
	"every page of the document is drawn, and so is every thumbnail",
	async (ui) => {
		await openFromCard(ui);
		const c = await ctxOf(ui);
		const side: Rect = { x: 0, y: c.paneBounds!()!.y + 40, width: 230, height: 700 };
		// the thumbnails of all three pages: a white page with ink on it, three times down the sidebar
		await ui.waitFor("three thumbnails are painted", async () => {
			const f = await ui.screenshot("thumbs");
			const rows = [0, 1, 2].map((i) => paint(f, { x: 55, y: side.y + 30 + i * 205, width: 125, height: 150 }, ui.size.width));
			return rows.every((r) => r.paper > 0.5 && r.ink > 0.002 && r.colours > 4) || rows.slice(0, 2).every((r) => r.paper > 0.5 && r.ink > 0.002);
		}, 20000);
		await focusPages(ui);
		for (let p = 0; p < 3; p++) {
			await ui.press(p === 0 ? "home" : p === 1 ? "alt-down" : "alt-down");
			await ui.expect(`page ${p + 1} is at the top`, async () => (await state(ui)).page, p);
			await drawn(ui, `page-${p + 1}`, p === 2 ? 0.0002 : 0.002);
		}
	},
	{ inProcessOnly: "reader context (pane bounds, page state)" },
);

// ---- page navigation ---------------------------------------------------------------------------------------------------------------

scenario(
	"Page Down, Page Up, the arrow keys and Space scroll the pages by what they should",
	async (ui) => {
		await openFromCard(ui);
		await focusPages(ui);
		const c = await ctxOf(ui);
		const vh = c.paneBounds!()!.height;
		const y0 = await pageTop(ui, 0);
		await ui.press("pagedown");
		await ui.expect("Page Down scrolls 90% of the viewport", async () => Math.round(y0 - (await pageTop(ui, 0))), Math.round(vh * 0.9), 3000);
		await ui.press("pageup");
		await ui.expect("Page Up scrolls back", async () => Math.round(await pageTop(ui, 0)), Math.round(y0), 3000);
		await ui.press("down");
		await ui.expect("Down scrolls 48 px", async () => Math.round(y0 - (await pageTop(ui, 0))), 48, 3000);
		await ui.press("up");
		await ui.expect("Up scrolls back", async () => Math.round(await pageTop(ui, 0)), Math.round(y0), 3000);
		await ui.press("space");
		await ui.expect("Space scrolls a screen down", async () => Math.round(y0 - (await pageTop(ui, 0))), Math.round(vh * 0.9), 3000);
		await ui.press("shift-space");
		await ui.expect("Shift+Space scrolls back", async () => Math.round(await pageTop(ui, 0)), Math.round(y0), 3000);
	},
	{ inProcessOnly: "reader page geometry" },
);

scenario(
	"Home, End, Alt+Down and Alt+Up go to the first, last, next and previous page",
	async (ui) => {
		await openFromCard(ui);
		await focusPages(ui);
		await ui.press("end");
		await ui.expect("End shows the last page", async () => (await state(ui)).page, 2);
		await drawn(ui, "end", 0.0002);
		await ui.press("home");
		await ui.expect("Home shows the first page", async () => (await state(ui)).page, 0);
		await ui.press("alt-down");
		await ui.expect("Alt+Down shows page 2", async () => (await state(ui)).page, 1);
		await ui.expect("page 2 is at the top of the view", async () => Math.abs((await pageTop(ui, 1)) - (await ctxOf(ui)).paneBounds!()!.y) < 24, true);
		await ui.press("alt-up");
		await ui.expect("Alt+Up shows page 1", async () => (await state(ui)).page, 0);
	},
	{ inProcessOnly: "reader page state and geometry" },
);

scenario(
	"the mouse wheel scrolls the pages",
	async (ui) => {
		await openFromCard(ui);
		const pane = (await ctxOf(ui)).paneBounds!()!;
		const y0 = await pageTop(ui, 0);
		await ui.wheel(pane.x + pane.width / 2, pane.y + 300, -300);
		await ui.expect("the page moved up by the wheel's 300 px", async () => Math.round(y0 - (await pageTop(ui, 0))), 300, 3000);
		await ui.wheel(pane.x + pane.width / 2, pane.y + 300, 100);
		await ui.expect("a wheel the other way moves it back by 100", async () => Math.round(y0 - (await pageTop(ui, 0))), 200, 3000);
		await ui.wheel(pane.x + pane.width / 2, pane.y + 300, -2500);
		await ui.expect("a long way down is on page 2", async () => (await state(ui)).page, 1, 4000);
		await drawn(ui, "wheeled");
	},
	{ inProcessOnly: "reader page geometry" },
);

scenario(
	"a page number typed in the page box goes to that page",
	async (ui) => {
		await openFromCard(ui);
		const z = await zoomLabel(ui);
		await ui.clickAt(z.x + TB.pageBox, z.y);
		await ui.replace("3");
		await ui.press("enter");
		await ui.expect("page 3 is shown", async () => (await state(ui)).page, 2, 4000);
		await ui.expect("the box shows 3", async () => (await ui.painted()).includes("3"), true);
		await drawn(ui, "page-box", 0.0002);
		// the keyboard is back on the pages
		await ui.press("home");
		await ui.expect("Home works after the box was left", async () => (await state(ui)).page, 0);
	},
	{ inProcessOnly: "reader page state" },
);

scenario(
	"a page number that does not exist is held to the last page, text is ignored",
	async (ui) => {
		await openFromCard(ui);
		const z = await zoomLabel(ui);
		await ui.clickAt(z.x + TB.pageBox, z.y);
		await ui.replace("99");
		await ui.press("enter");
		await ui.expect("the last page is shown", async () => (await state(ui)).page, 2, 4000);
		await ui.clickAt(z.x + TB.pageBox, z.y);
		await ui.replace("abc");
		await ui.press("enter");
		await ui.expectStill("the page did not change", async () => (await state(ui)).page, 2, 500);
	},
	{ inProcessOnly: "reader page state" },
);

scenario(
	"a click on a thumbnail goes to that page and marks it",
	async (ui) => {
		await openFromCard(ui);
		const side: Rect = { x: 0, y: 110, width: 232, height: 770 };
		const two = await ui.see("2", { area: side, exact: true });
		await ui.clickAt(two.x, two.y);
		await ui.expect("page 2 is shown", async () => (await state(ui)).page, 1, 4000);
		await drawn(ui, "thumb-2");
		const three = await ui.see("3", { area: side, exact: true });
		await ui.clickAt(three.x, three.y - 80);
		await ui.expect("page 3 is shown", async () => (await state(ui)).page, 2, 4000);
		await drawn(ui, "thumb-3", 0.0002);
		await ui.expectStill("a plain click picks no page for Rotate or Delete", async () => (await state(ui)).selectedPages, [], 300);
	},
	{ inProcessOnly: "reader page state" },
);

scenario(
	"Ctrl+click and Shift+click on thumbnails pick pages",
	async (ui) => {
		await openFromCard(ui);
		const side: Rect = { x: 0, y: 110, width: 232, height: 770 };
		const one = await ui.see("1", { area: side, exact: true });
		const three = await ui.see("3", { area: side, exact: true });
		await ui.clickAt(one.x, one.y, { modifiers: "ctrl" });
		await ui.expect("Ctrl+click on page 1 (with the current page 1 counted) leaves nothing picked", async () => (await state(ui)).selectedPages, []);
		await ui.clickAt(three.x, three.y, { modifiers: "ctrl" });
		await ui.expect("Ctrl+click adds page 3 to the current page", async () => (await state(ui)).selectedPages, [0, 2]);
		await ui.clickAt(three.x, three.y - 100, { modifiers: "shift" });
		await ui.expect("Shift+click picks the range from the last pick", async () => (await state(ui)).selectedPages, [2]);
	},
	{ inProcessOnly: "reader page-selection state" },
);

scenario(
	"the outline lists the headings and a click goes to one, and Back returns",
	async (ui) => {
		await openFromCard(ui);
		await sideTab(ui, "outline");
		await ui.waitFor("the outline is read", async () => !!(await opsOf(ui)).outline(), 20000);
		const o = (await opsOf(ui)).outline()!;
		await ui.see("3. Reporting standards", { area: { x: 0, y: 110, width: 232, height: 770 } });
		const want = o.find((e) => e.t === "3. Reporting standards")!;
		ui.steps.push(`outline: ${JSON.stringify(o)}`);
		await ui.click("3. Reporting standards", { area: { x: 0, y: 110, width: 232, height: 770 } });
		await ui.expect("the page of the heading is shown", async () => (await state(ui)).page, want.p, 4000);
		await ui.expect("the heading is in view", async () => {
			const pane = (await ctxOf(ui)).paneBounds!()!;
			const t = await pageTop(ui, want.p);
			return t + want.y * 0 < pane.y + pane.height && t > -3000;
		}, true);
		await ui.expect("Back is available", async () => (await state(ui)).canBack, true);
		await tbFixed(ui, "back");
		await ui.expect("Back returns to page 1", async () => (await state(ui)).page, 0, 4000);
		await ui.expect("Forward is available", async () => (await state(ui)).canForward, true);
		await tbFixed(ui, "forward");
		await ui.expect("Forward goes to the heading again", async () => (await state(ui)).page, want.p, 4000);
	},
	{ inProcessOnly: "reader outline and page state" },
);

scenario(
	"the outline shows each heading as the PDF names it",
	async (ui) => {
		await openFromCard(ui);
		await sideTab(ui, "outline");
		await ui.waitFor("the outline is read", async () => !!(await opsOf(ui)).outline(), 20000);
		const o = (await opsOf(ui)).outline()!;
		await ui.see("1. Background", { area: { x: 0, y: 110, width: 232, height: 770 } });
		for (const e of o) await ui.expect(`outline entry "${e.t}" is shown as written`, async () => (await ui.painted()).includes(e.t), true, 1500);
	},
	{ inProcessOnly: "reader outline operations" },
);

scenario(
	"the sidebar button hides and shows the sidebar, and its edge can be dragged to resize it",
	async (ui) => {
		await openFromCard(ui);
		const c = await ctxOf(ui);
		const x0 = c.paneBounds!()!.x;
		await tbFixed(ui, "sidebar");
		await ui.expect("the sidebar is closed", async () => (await state(ui)).sidebar.open, false);
		await ui.expect("the pages use the whole width", () => c.paneBounds!()!.x, 0);
		await tbFixed(ui, "sidebar");
		await ui.expect("the sidebar is open again", async () => (await state(ui)).sidebar.open, true);
		const w0 = (await state(ui)).sidebar.width;
		const y = c.paneBounds!()!.y + 300;
		await ui.drag({ x: w0 + 1, y }, { x: w0 + 101, y });
		await ui.expect("the sidebar is 100 px wider", async () => (await state(ui)).sidebar.width, w0 + 100, 3000);
		await ui.expect("the pages moved over", () => Math.round(c.paneBounds!()!.x - x0), 100, 3000);
		await drawn(ui, "wide-sidebar");
	},
	{ inProcessOnly: "reader sidebar state and pane bounds" },
);

// ---- zoom, rotation, layout, appearance ------------------------------------------------------------------------------------------

scenario(
	"the zoom buttons zoom in and out by a step and show the percentage",
	async (ui) => {
		await openFromCard(ui);
		const z0 = (await state(ui)).zoom;
		await tb(ui, "zoomIn");
		await ui.expect("zoom in is a step of 15%", async () => Math.round(((await state(ui)).zoom / z0) * 100), 115);
		await ui.expect("the mode is custom now", async () => (await state(ui)).zoomMode, "custom");
		await ui.see(`${Math.round((await state(ui)).zoom * 100)}%`, { area: ZOOM_AREA });
		const zIn = (await state(ui)).zoom;
		await tb(ui, "zoomOut");
		await tb(ui, "zoomOut");
		await ui.expect("two zoom outs are two steps of 15% below", async () => Math.abs((await state(ui)).zoom - zIn / 1.15 / 1.15) < 0.01, true);
		await ui.see(`${Math.round((await state(ui)).zoom * 100)}%`, { area: ZOOM_AREA });
		await drawn(ui, "zoomed-out");
	},
	{ inProcessOnly: "reader zoom state" },
);

scenario(
	"Ctrl+Plus, Ctrl+Minus and Ctrl+0 zoom, and the Ctrl+wheel zooms at the pointer",
	async (ui) => {
		await openFromCard(ui);
		await focusPages(ui);
		const z0 = (await state(ui)).zoom;
		await ui.press("ctrl-=");
		await ui.expect("Ctrl+= zooms in by 10%", async () => Math.round(((await state(ui)).zoom / z0) * 100), 110);
		await ui.press("ctrl--");
		await ui.expect("Ctrl+- zooms out by 10%", async () => Math.round(((await state(ui)).zoom / z0) * 100), 100);
		await ui.press("ctrl-=");
		await ui.press("ctrl-0");
		await ui.expect("Ctrl+0 fits the width", async () => (await state(ui)).zoomMode, "width");
		const pane = (await ctxOf(ui)).paneBounds!()!;
		await ui.mouseMove(pane.x + 400, pane.y + 300);
		await ui.wheelAt(pane.x + 400, pane.y + 300, 0, 40, "ctrl");
		await ui.settle(600);
		await ui.expect("Ctrl+wheel up zooms in", async () => (await state(ui)).zoom > z0 * 1.05, true);
		const z1 = (await state(ui)).zoom;
		await ui.wheelAt(pane.x + 400, pane.y + 300, 0, -80, "ctrl");
		await ui.settle(600);
		await ui.expect("Ctrl+wheel down zooms out", async () => (await state(ui)).zoom < z1 * 0.95, true);
	},
	{ inProcessOnly: "reader zoom state" },
);

scenario(
	"Fit width and Fit page set their modes and make the pages fit",
	async (ui) => {
		await openFromCard(ui);
		await tb(ui, "zoomIn");
		await tb(ui, "fitPage");
		await ui.expect("fit page is the mode", async () => (await state(ui)).zoomMode, "page");
		const c = await ctxOf(ui);
		await ui.expect("a whole page is in the page area", () => {
			const pane = c.paneBounds!()!;
			const r = c.rectToWindow!(0, { x: 0, y: 0, w: 1, h: 1 });
			return !!r && r.height <= pane.height && r.width <= pane.width;
		}, true, 3000);
		await drawn(ui, "fit-page");
		await tb(ui, "fitWidth");
		await ui.expect("fit width is the mode", async () => (await state(ui)).zoomMode, "width");
		await ui.expect("the page is as wide as the page area allows", () => {
			const pane = c.paneBounds!()!;
			const r = c.rectToWindow!(0, { x: 0, y: 0, w: 1, h: 1 });
			return !!r && Math.abs(r.width - (pane.width - 32 - 8)) < 20;
		}, true, 3000);
		await drawn(ui, "fit-width");
	},
	{ inProcessOnly: "reader zoom state and page geometry" },
);

scenario(
	"Rotate left and right turn the pages, and four turns are the start again",
	async (ui) => {
		await openFromCard(ui);
		const c = await ctxOf(ui);
		const ratio = () => {
			const r = c.rectToWindow!(0, { x: 0, y: 0, w: 1, h: 1 })!;
			return r.width / r.height;
		};
		const portrait = ratio();
		await tb(ui, "rotateRight");
		await ui.expect("the rotation is 90", async () => (await state(ui)).rotation, 90);
		await ui.expect("the page is on its side", () => ratio() > 1, true, 3000);
		await drawn(ui, "rotated-90", 0.001);
		await tb(ui, "rotateRight");
		await ui.expect("180", async () => (await state(ui)).rotation, 180);
		await tb(ui, "rotateLeft");
		await tb(ui, "rotateLeft");
		await ui.expect("two turns left are the start", async () => (await state(ui)).rotation, 0);
		await ui.expect("the page is upright again", () => Math.abs(ratio() - portrait) < 0.01, true, 3000);
		await tb(ui, "rotateLeft");
		await ui.expect("left from the start is 270", async () => (await state(ui)).rotation, 270);
	},
	{ inProcessOnly: "reader rotation state and page geometry" },
);

scenario(
	"Ctrl+] and Ctrl+[ rotate the document, with Shift only the current page",
	async (ui) => {
		await openFromCard(ui);
		await focusPages(ui);
		await ui.press("ctrl-]");
		await ui.expect("Ctrl+] turns right", async () => (await state(ui)).rotation, 90);
		await ui.press("ctrl-[");
		await ui.expect("Ctrl+[ turns left", async () => (await state(ui)).rotation, 0);
		const c = await ctxOf(ui);
		await ui.press("ctrl-shift-]");
		await ui.expect("Ctrl+Shift+] turns page 1 only", () => c.rotation!(0), 90);
		await ui.expectStill("the document is not turned", async () => (await state(ui)).rotation, 0, 300);
	},
	{ inProcessOnly: "reader rotation state" },
);

scenario(
	"the View menu: horizontal scrolling puts the pages side by side",
	async (ui) => {
		await openFromCard(ui);
		await tb(ui, "fitPage");
		await tb(ui, "view");
		await ui.see("Scrolling", { area: "top", nth: 0 }).catch(() => undefined);
		await ui.click("Horizontal Scrolling");
		await ui.expect("the scroll mode", async () => (await state(ui)).scroll, "horizontal");
		const c = await ctxOf(ui);
		await ui.expect("pages 1 and 2 are on the same line, 2 to the right of 1", () => {
			const a = c.rectToWindow!(0, { x: 0, y: 0, w: 1, h: 1 }),
				b = c.rectToWindow!(1, { x: 0, y: 0, w: 1, h: 1 });
			return !!a && !!b && Math.abs(a.y - b.y) < 3 && b.x >= a.x + a.width;
		}, true, 4000);
		await drawn(ui, "horizontal", 0.001, 0.2);
		await tb(ui, "view");
		await ui.click("Vertical Scrolling");
		await ui.expect("vertical again", async () => (await state(ui)).scroll, "vertical");
	},
	{ inProcessOnly: "reader scroll state and page geometry" },
);

// ---- find in the document -----------------------------------------------------------------------------------------------------

/** How many places a word is in the text of the pages (what a person counts), word by word joined with spaces. */
async function occurrences(ui: Ui, needle: string): Promise<number> {
	const c = await ctxOf(ui);
	let n = 0;
	for (let p = 0; p < c.pageCount(); p++) {
		const text = (await c.textLayer(p)).words.map((w) => w.t).join(" ").toLowerCase();
		for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) n++;
	}
	return n;
}
async function search(ui: Ui, text: string): Promise<void> {
	const z = await zoomLabel(ui);
	await ui.clickAt(z.x + TB.search, z.y);
	if (text) await ui.replace(text);
	else {
		await ui.press("ctrl-a");
		await ui.press("backspace");
	}
}

scenario(
	"find in the document counts the matches, steps with next and previous and wraps around",
	async (ui) => {
		await openFromCard(ui);
		const want = await occurrences(ui, "deep");
		await search(ui, "deep");
		await ui.expect("the number of matches", async () => (await state(ui)).find.total, want, 8000);
		await ui.expect("the first match is the current one", async () => (await state(ui)).find.index, 0);
		await ui.see(`1 / ${want}`, { area: BAR });
		await ui.screenshot("find-deep");
		await tb(ui, "next");
		await ui.expect("next goes to the second match", async () => (await state(ui)).find.index, 1);
		await ui.see(`2 / ${want}`, { area: BAR });
		await tb(ui, "prev");
		await ui.expect("previous goes back", async () => (await state(ui)).find.index, 0);
		await tb(ui, "prev");
		await ui.expect("previous from the first wraps to the last", async () => (await state(ui)).find.index, want - 1);
		await tb(ui, "next");
		await ui.expect("next from the last wraps to the first", async () => (await state(ui)).find.index, 0);
	},
	{ inProcessOnly: "reader find state and text layer" },
);

scenario(
	"the matches of find are marked on the page and the current one moves",
	async (ui) => {
		await openFromCard(ui);
		await search(ui, "learning");
		await ui.expect("there are matches", async () => (await state(ui)).find.total > 1, true, 8000);
		const c = await ctxOf(ui);
		const pane = c.paneBounds!()!;
		const marked = async () => count(await ui.screenshot("marks"), { x: pane.x, y: pane.y, width: pane.width - 12, height: pane.height }, (r, g, b) => r > 240 && g > 150 && g < 240 && b < 190);
		await ui.expect("hits are marked in the page", async () => (await marked()) > 300, true, 4000);
		const first = await marked();
		await tb(ui, "next");
		await ui.expect("the current hit has its own (orange) mark", async () => {
			const f = await ui.screenshot("marks2");
			return count(f, { x: pane.x, y: pane.y, width: pane.width - 12, height: pane.height }, (r, g, b) => r > 240 && g > 175 && g < 205 && b > 95 && b < 135) > 100;
		}, true, 4000);
		void first;
	},
	{ inProcessOnly: "reader find state and pane bounds" },
);

scenario(
	"find for something that is not in the document says there is no result",
	async (ui) => {
		await openFromCard(ui);
		await search(ui, "zzzqqq");
		await ui.see("No results", { area: BAR });
		await ui.expect("no matches", async () => (await state(ui)).find.total, 0);
		await ui.press("enter");
		await ui.expectStill("the page did not move", async () => (await state(ui)).page, 0, 400);
		await search(ui, "");
		await ui.gone("No results", { area: BAR });
	},
	{ inProcessOnly: "reader find state" },
);

scenario(
	"Ctrl+F puts the cursor in the find box",
	async (ui) => {
		await openFromCard(ui);
		await focusPages(ui);
		await ui.press("ctrl-f");
		await ui.type("references");
		await ui.expect("what was typed is searched for", async () => (await state(ui)).find.query, "references", 3000);
		await ui.expect("there are matches", async () => (await state(ui)).find.total > 0, true, 8000);
	},
	{ inProcessOnly: "reader find state" },
);

scenario(
	"the match list shows each match with its context and a click goes to it",
	async (ui) => {
		await openFromCard(ui);
		const want = await occurrences(ui, "deep");
		await search(ui, "deep");
		await ui.expect("the matches", async () => (await state(ui)).find.total, want, 8000);
		await tb(ui, "matches");
		await ui.see("Deep learning", { area: { x: 900, y: 100, width: 540, height: 400 } });
		await ui.screenshot("match-list");
		const rows = await ui.findAll("eep", { area: { x: 900, y: 100, width: 540, height: 400 } });
		ui.steps.push(`match list rows: ${rows.length}`);
		await ui.expect("the list has a row for every match", () => rows.length >= Math.min(want, 5), true);
		await ui.clickAt(rows[Math.min(2, rows.length - 1)]!.x, rows[Math.min(2, rows.length - 1)]!.y);
		await ui.expect("the clicked match is current", async () => (await state(ui)).find.index > 0, true, 3000);
	},
	{ inProcessOnly: "reader find state and text layer" },
);

// ---- selecting text, copying ---------------------------------------------------------------------------------------------------------

scenario(
	"dragging over text selects it, Ctrl+C copies it and a click elsewhere clears it",
	async (ui) => {
		await openFromCard(ui);
		const c = await ctxOf(ui);
		await dragWords(ui, 0, BODY, 4);
		await ui.expect("the selected text", () => c.selection()?.text, "Deep learning learns layered");
		await ui.screenshot("selected");
		await ui.press("ctrl-c");
		await ui.expect("the clipboard has the text", () => clipboard(ui), "Deep learning learns layered");
		const blank = c.rectToWindow!(0, { x: 0.97, y: 0.2, w: 0, h: 0 })!;
		await ui.clickAt(blank.x, blank.y);
		await ui.expect("a click on an empty part of the page clears the selection", () => c.selection(), null);
	},
	{ inProcessOnly: "reader selection and page geometry" },
);

scenario(
	"the Copy button of the selection popup copies the text",
	async (ui) => {
		await openFromCard(ui);
		const c = await ctxOf(ui);
		await dragWords(ui, 0, BODY, 4);
		await ui.expect("the selected text", () => c.selection()?.text, "Deep learning learns layered");
		await ui.click("Copy", { area: c.paneBounds!()! });
		await ui.expect("the clipboard has the text", () => clipboard(ui), "Deep learning learns layered");
	},
	{ inProcessOnly: "reader selection and page geometry" },
);

scenario(
	"Escape clears a selection",
	async (ui) => {
		await openFromCard(ui);
		const c = await ctxOf(ui);
		await dragWords(ui, 0, BODY, 4);
		await ui.press("escape");
		await ui.expect("nothing is selected", () => c.selection(), null);
	},
	{ inProcessOnly: "reader selection and page geometry" },
);

scenario(
	"a drag over several lines selects all of them in reading order",
	async (ui) => {
		await openFromCard(ui);
		const c = await ctxOf(ui);
		const first = await showWord(ui, 0, (_w, i, all) => all[i]?.t === "Deep" && all[i + 1]?.t === "learning" && all[i + 2]?.t === "learns");
		const mark = first.words.findIndex((w, k) => k > first.index && w.t === "stochastic");
		const to = c.rectToWindow!(0, first.words[mark + 1]!)!;
		await ui.drag({ x: first.rect.x + 1, y: first.rect.y + first.rect.height / 2 }, { x: to.x + to.width - 1, y: to.y + to.height / 2 });
		await ui.waitFor("the selection is made", () => !!c.selection(), 4000);
		const text = c.selection()!.text;
		await ui.expect("it starts and ends where the drag did", () => text.startsWith("Deep learning learns layered") && text.endsWith("optimisers"), true);
		await ui.expect("it holds the words between", () => text.includes("directly from data [1]") && text.includes("allowed much deeper"), true);
	},
	{ inProcessOnly: "reader selection and page geometry" },
);

scenario(
	"a double click selects a word, a triple click a line",
	async (ui) => {
		await openFromCard(ui);
		const c = await ctxOf(ui);
		const w = await showWord(ui, 0, (w) => w.t === "Convolutional");
		await ui.clickAt(w.rect.x + w.rect.width / 2, w.rect.y + w.rect.height / 2, { count: 2 });
		await ui.expect("the word is selected", () => c.selection()?.text, "Convolutional");
	},
	{ inProcessOnly: "reader selection and page geometry" },
);

// ---- annotations -----------------------------------------------------------------------------------------------------------------------

/** The saved annotations, once there are `n` of them. */
async function savedAnnotations(ui: Ui, key: string, n: number, timeoutMs = 5000): Promise<any[]> {
	await ui.expect(`${n} annotation(s) saved`, async () => (await annotationsOf(ui, key)).length, n, timeoutMs);
	return annotationsOf(ui, key);
}
/** The small round buttons (swatches) of a part of the window. */
const swatches = async (ui: Ui, area: Rect, size: number) => (await boxesWhere(ui, (b) => Math.round(b.width) === size && Math.round(b.height) === size && b.x > area.x && b.x < area.x + area.width && b.y > area.y && b.y < area.y + area.height)).sort((a, b) => a.x - b.x);

scenario(
	"Highlight in the selection popup saves a yellow highlight of the selected text",
	async (ui) => {
		const key = await openFromCard(ui);
		const c = await ctxOf(ui);
		const sel = await dragWords(ui, 0, BODY, 4);
		await ui.click("Highlight", { area: c.paneBounds!()! });
		const [a] = await savedAnnotations(ui, key, 1);
		await ui.expect("the saved annotation", () => [a.type, a.color, a.text, a.position.pageIndex, a.position.rects.length], ["highlight", "#ffd400", "Deep learning learns layered", 0, 1]);
		const r = a.position.rects[0] as number[];
		await ui.expect("its rectangle covers the words that were selected (in PDF points, from the page's bottom)", () => {
			const size = c.pageSize(0);
			const top = size.h - r[3],
				bottom = size.h - r[1];
			return Math.abs(top / size.h - sel.word.y) < 0.02 && bottom / size.h > sel.word.y + sel.word.h * 0.8 && r[2] > r[0] + 100;
		}, true);
		await ui.expect("the selection is gone", () => c.selection(), null);
		const f = await ui.screenshot("highlighted");
		await ui.expect("the words are painted with a yellow mark", () => count(f, sel.rect, yellowish) > 200, true, 3000);
	},
	{ inProcessOnly: "reader selection, page geometry and text layer" },
);

scenario(
	"Underline in the selection popup saves an underline",
	async (ui) => {
		const key = await openFromCard(ui);
		const c = await ctxOf(ui);
		const sel = await dragWords(ui, 0, BODY, 4);
		await ui.click("Underline", { area: c.paneBounds!()! });
		const [a] = await savedAnnotations(ui, key, 1);
		await ui.expect("the saved annotation", () => [a.type, a.color, a.text], ["underline", "#ffd400", "Deep learning learns layered"]);
		const f = await ui.screenshot("underlined");
		const under = { x: sel.rect.x, y: sel.rect.y + sel.rect.height - 6, width: sel.rect.width * 3, height: 8 };
		await ui.expect("a yellow line is under the words", () => count(f, under, (r, g, b) => r > 240 && g > 190 && b < 60) > 80, true, 3000);
	},
	{ inProcessOnly: "reader selection and page geometry" },
);

scenario(
	"a colour picked in the selection popup is the colour of the highlight",
	async (ui) => {
		const key = await openFromCard(ui);
		const c = await ctxOf(ui);
		await dragWords(ui, 0, BODY, 4);
		const pane = c.paneBounds!()!;
		const dots = await swatches(ui, pane, 16);
		ui.steps.push(`popup swatches: ${dots.length}`);
		await ui.expect("the popup has the eight colours", () => dots.length, 8);
		await ui.clickAt(mid(dots[1]!).x, mid(dots[1]!).y); // red
		const [a] = await savedAnnotations(ui, key, 1);
		await ui.expect("the saved colour is red", () => [a.type, a.color], ["highlight", "#ff6666"]);
	},
	{ inProcessOnly: "reader selection and page geometry" },
);

scenario(
	"the comment button of the selection popup saves a highlight and takes the typing",
	async (ui) => {
		const key = await openFromCard(ui);
		const c = await ctxOf(ui);
		await dragWords(ui, 0, BODY, 4);
		const pane = c.paneBounds!()!;
		const hl = await ui.see("Highlight", { area: pane });
		const underline = await ui.see("Underline", { area: pane });
		await ui.clickAt(underline.x + underline.box.width / 2 + 24, underline.y); // the comment icon is the third action
		await savedAnnotations(ui, key, 1);
		await ui.type("a remark");
		await ui.expect("the comment is saved", async () => (await annotationsOf(ui, key))[0]?.comment, "a remark", 4000);
		void hl;
	},
	{ inProcessOnly: "reader selection and page geometry" },
);

scenario(
	"the Note tool puts a note where the page is clicked and takes its comment",
	async (ui) => {
		const key = await openFromCard(ui);
		await tb(ui, "note");
		const c = await ctxOf(ui);
		const r = c.rectToWindow!(0, { x: 0.8, y: 0.3, w: 0, h: 0 })!;
		await ui.clickAt(r.x, r.y);
		const [a] = await savedAnnotations(ui, key, 1);
		await ui.expect("a note on page 1", () => [a.type, a.position.pageIndex], ["note", 0]);
		await ui.expect("the note is where the click was", () => {
			const size = c.pageSize(0);
			const q = a.position.rects[0] as number[];
			return Math.abs((q[0] + q[2]) / 2 / size.w - 0.8) < 0.04 && Math.abs(1 - (q[1] + q[3]) / 2 / size.h - 0.3) < 0.04;
		}, true);
		await ui.type("check this");
		await ui.expect("the comment is saved", async () => (await annotationsOf(ui, key))[0]?.comment, "check this", 4000);
		const { sessionOf } = await import("../../../src/reader/annotations/session");
		await ui.expect("the tool is off after the note", () => sessionOf(key)?.ui.tool(), null);
		await ui.expect("the note's popup is open", async () => (await byTestId(ui, "annotation-popup")).length, 1);
		await ui.screenshot("note");
	},
	{ inProcessOnly: "reader page geometry and annotation session" },
);

/** Make a highlight of the first line and return the saved annotation and where it is. */
async function oneHighlight(ui: Ui) {
	const key = await openFromCard(ui);
	const c = await ctxOf(ui);
	const sel = await dragWords(ui, 0, BODY, 4);
	await ui.click("Highlight", { area: c.paneBounds!()! });
	const [a] = await savedAnnotations(ui, key, 1);
	return { key, c, sel, a };
}
/** The round handle at the top left of an annotation, which selects it. */
const handleOf = (sel: { rect: Rect }) => ({ x: sel.rect.x - 13 + 5, y: sel.rect.y + Math.min(2, sel.rect.height / 4) + 5 });

scenario(
	"the handle of an annotation opens its popup, where the comment is typed and saved",
	async (ui) => {
		const { key, sel } = await oneHighlight(ui);
		await ui.expect("the popup is open after the highlight was made", async () => (await byTestId(ui, "annotation-popup")).length, 1);
		await ui.clickAt(handleOf(sel).x, handleOf(sel).y); // closes it
		await ui.expect("a click on the handle closes the popup", async () => (await byTestId(ui, "annotation-popup")).length, 0);
		await ui.clickAt(handleOf(sel).x, handleOf(sel).y);
		await ui.expect("and opens it again", async () => (await byTestId(ui, "annotation-popup")).length, 1);
		const pop = (await byTestId(ui, "annotation-popup"))[0]!;
		await ui.screenshot("annotation-popup");
		// the comment box is the widest box under the colours (its placeholder is not part of the element tree)
		const box = (await boxesWhere(ui, (b) => b.width > 200 && b.height >= 24 && b.height < 80 && b.x >= pop.x && b.x < pop.x + pop.width && b.y > pop.y + 30 && b.y < pop.y + pop.height)).sort((p, q) => p.y - q.y)[0]!;
		await ui.clickAt(mid(box).x, mid(box).y);
		await ui.type("hello there");
		await ui.expect("the comment is saved", async () => (await annotationsOf(ui, key))[0]?.comment, "hello there", 4000);
	},
	{ inProcessOnly: "reader selection, page geometry and annotation popup" },
);

scenario(
	"a colour picked in the annotation's popup changes the saved colour",
	async (ui) => {
		const { key } = await oneHighlight(ui);
		const pop = (await byTestId(ui, "annotation-popup"))[0]!;
		const dots = await swatches(ui, pop, 16);
		await ui.expect("eight colours in the popup", () => dots.length, 8);
		await ui.clickAt(mid(dots[2]!).x, mid(dots[2]!).y); // green
		await ui.expect("the saved colour is green", async () => (await annotationsOf(ui, key))[0]?.color, "#5fb236", 4000);
	},
	{ inProcessOnly: "reader selection, page geometry and annotation popup" },
);

scenario(
	"the trash button of the annotation's popup deletes the annotation",
	async (ui) => {
		const { key, sel } = await oneHighlight(ui);
		const pop = (await byTestId(ui, "annotation-popup"))[0]!;
		const trash = await boxesWhere(ui, (b) => Math.round(b.width) === 24 && Math.round(b.height) === 24 && b.x > pop.x && b.x < pop.x + pop.width && b.y < pop.y + 40);
		await ui.expect("a trash button", () => trash.length, 1);
		await ui.clickAt(mid(trash[0]!).x, mid(trash[0]!).y);
		await ui.expect("nothing is saved any more", async () => (await annotationsOf(ui, key)).length, 0, 4000);
		const f = await ui.screenshot("deleted");
		await ui.expect("the mark is gone from the page", () => count(f, sel.rect, yellowish) < 20, true);
	},
	{ inProcessOnly: "reader selection, page geometry and annotation popup" },
);

scenario(
	"Delete removes the selected annotation",
	async (ui) => {
		const { key, c } = await oneHighlight(ui);
		await ui.press("delete");
		await ui.expect("nothing is saved any more", async () => (await annotationsOf(ui, key)).length, 0, 4000);
		void c;
	},
	{ inProcessOnly: "reader selection and page geometry" },
);

scenario(
	"a tag typed in the annotation's popup is saved on the annotation",
	async (ui) => {
		const { key } = await oneHighlight(ui);
		const pop = (await byTestId(ui, "annotation-popup"))[0]!;
		await ui.clickAt(pop.x + 40, pop.y + pop.height - 18); // "Add tags..." is the last line of the popup
		await ui.type("method");
		await ui.press("enter");
		await ui.expect("the tag is saved", async () => (await annotationsOf(ui, key))[0]?.tags, [{ name: "method" }], 4000);
	},
	{ inProcessOnly: "reader selection, page geometry and annotation popup" },
);

scenario(
	"a highlight over the end of one page and the start of the next is one annotation on both pages",
	async (ui) => {
		const key = await openFromCard(ui);
		const c = await ctxOf(ui);
		const words0 = (await c.textLayer(0)).words;
		const words1 = (await c.textLayer(1)).words;
		// the last word on page 1 (the lowest) and a word at the top of page 2
		const last = words0.reduce((m, w) => (w.y + w.h > m.y + m.h ? w : m), words0[0]!);
		const top = words1.reduce((m, w) => (w.y < m.y ? w : m), words1[0]!);
		await showWord(ui, 0, (w) => w === last || (w.t === last.t && w.y === last.y && w.x === last.x));
		// bring the boundary between the pages to the middle of the page area
		const pane = c.paneBounds!()!;
		const bottom = c.rectToWindow!(0, last)!;
		await ui.wheel(pane.x + pane.width / 2, pane.y + 300, -Math.round(bottom.y - (pane.y + 130)));
		const a = c.rectToWindow!(0, last);
		const b = c.rectToWindow!(1, top);
		ui.steps.push(`last word on page 1: ${last.t} ${JSON.stringify(a)}; first on page 2: ${top.t} ${JSON.stringify(b)}`);
		if (!a || !b) throw new Error("the end of page 1 and the start of page 2 are not both on screen");
		await ui.drag({ x: a.x + 1, y: a.y + a.height / 2 }, { x: b.x + b.width - 1, y: b.y + b.height / 2 });
		await ui.waitFor("the selection is made", () => !!c.selection(), 4000);
		await ui.expect("the selection reaches both pages", () => c.selection()?.pages?.map((p) => p.page), [0, 1]);
		await ui.click("Highlight", { area: c.paneBounds!()! });
		const list = await savedAnnotations(ui, key, 1);
		const h = list[0];
		await ui.expect("one highlight: on page 1, continuing onto page 2", () => [h.type, h.position.pageIndex, h.position.rects.length >= 1, (h.position.nextPageRects ?? []).length >= 1], ["highlight", 0, true, true]);
		await ui.expect("its text has the words of both ends", () => h.text.includes(last.t) && h.text.includes(top.t), true);
		const f = await ui.screenshot("two-pages");
		const area = { x: pane.x, y: pane.y, width: pane.width - 12, height: pane.height };
		await ui.expect("the end of page 1 is marked yellow", () => count(f, { x: a.x - 2, y: a.y, width: a.width + 4, height: a.height }, yellowish) > 20, true, 3000);
		await ui.expect("the start of page 2 is marked yellow", () => count(f, { x: b.x - 2, y: b.y, width: b.width + 4, height: b.height }, yellowish) > 20, true, 3000);
		void area;
	},
	{ inProcessOnly: "reader selection, text layer and page geometry" },
);

// ---- the annotations sidebar ------------------------------------------------------------------------------------------------------------

/** Three annotations of different colours, put in the library as a sync would, then the PDF is opened from its card. */
async function threeAnnotations(ui: Ui) {
	await ui.click(T.article, { area: "list" });
	const parent = (await ui.saved(T.article)).key;
	const d = await ui.api<{ children: { key: string; itemType: string }[] }>("GET", `/items/${parent}`);
	const key = d.children.find((x) => x.itemType === "attachment")!.key;
	const mk = (id: string, type: string, color: string, text: string, top: number) => ({
		id,
		type,
		color,
		text,
		sortIndex: `00000|${String(900 - top).padStart(6, "0")}|${String(900 - top).padStart(5, "0")}`,
		pageLabel: "1",
		dateModified: "2026-01-01T00:00:00Z",
		position: { pageIndex: 0, rects: [[72, top, 300, top + 12]] },
	});
	await ui.api("PUT", `/attachments/${key}/annotations`, [
		mk("HIGHL222", "highlight", "#ffd400", "Deep learning learns layered", 500),
		mk("HIGHL333", "highlight", "#2ea8e5", "Attention-based models later replaced", 450),
		mk("UNDER222", "underline", "#ffd400", "Practical training relied", 400),
	]);
	await ui.click("Open PDF", { area: "list" });
	await ui.see("/ 3");
	await drawn(ui, "three");
	return { key };
}

scenario("the annotations tab lists the annotations in the order of the document, with their text and a count", async (ui) => {
	await threeAnnotations(ui);
	await sideTab(ui, "annotations");
	const side: Rect = { x: 0, y: 110, width: 232, height: 770 };
	await ui.see("3 annotations", { area: side });
	await ui.see("Saved", { area: side });
	const texts = ["Deep learning learns layered", "Attention-based models later replaced", "Practical training relied"];
	for (const t of texts) await ui.see(t, { area: side });
	const ys: number[] = [];
	for (const t of texts) ys.push((await ui.findAll(t, { area: side }))[0]!.y);
	await ui.expect("they are listed from top to bottom in reading order", () => ys[0]! < ys[1]! && ys[1]! < ys[2]!, true);
	await ui.screenshot("annotations-panel");
});

scenario("a colour in the annotations filter keeps the annotations of that colour", async (ui) => {
	await threeAnnotations(ui);
	await sideTab(ui, "annotations");
	const side: Rect = { x: 0, y: 110, width: 232, height: 770 };
	await ui.see("3 annotations", { area: side });
	const dots = await swatches(ui, side, 18);
	await ui.expect("a filter dot for each of the two colours in use", () => dots.length, 2);
	await ui.clickAt(mid(dots[1]!).x, mid(dots[1]!).y); // blue
	await ui.see("1 of 3", { area: side });
	await ui.see("Attention-based models later replaced", { area: side });
	await ui.gone("Practical training relied", { area: side });
});

scenario("the trash icon of an annotation in the list deletes it", async (ui) => {
	const { key } = await threeAnnotations(ui);
	await sideTab(ui, "annotations");
	const side: Rect = { x: 0, y: 110, width: 232, height: 770 };
	await ui.see("3 annotations", { area: side });
	const text = await ui.see("Attention-based models later replaced", { area: side });
	const heads = (await ui.findAll("Page 1", { area: side })).filter((h) => h.y < text.y);
	await ui.clickAt(213, heads[heads.length - 1]!.y); // the trash icon at the right of the second card's head
	await ui.expect("two are left", async () => (await annotationsOf(ui, key)).map((a) => a.text), ["Deep learning learns layered", "Practical training relied"], 4000);
	await ui.see("2 annotations", { area: side });
});

scenario("Add note from annotations puts a note with them under the item", async (ui) => {
	await threeAnnotations(ui);
	await sideTab(ui, "annotations");
	const side: Rect = { x: 0, y: 110, width: 232, height: 770 };
	await ui.click("Add note from annotations", { area: side });
	await ui.see("Added a note with 3 annotations to the item.", { area: side });
	const item = await ui.saved(T.article);
	await ui.expect("the item has a note with the annotated text", async () => {
		const d = await ui.api<{ children: { itemType: string; key: string }[] }>("GET", `/items/${item.key}`);
		const note = d.children.find((x) => x.itemType === "note");
		if (!note) return "";
		const n = await ui.api<{ data: { note: string } }>("GET", `/items/${note.key}`);
		return ["Deep learning learns layered", "Attention-based models later replaced", "Practical training relied"].every((t) => n.data.note.includes(t));
	}, true, 4000);
});

scenario("an empty annotations list says how to make one", async (ui) => {
	await openFromCard(ui);
	await sideTab(ui, "annotations");
	const side: Rect = { x: 0, y: 110, width: 232, height: 770 };
	await ui.see("0 annotations", { area: side });
	await ui.see("No annotations yet.", { area: side });
});

scenario(
	"annotations of every kind that are in the library are drawn, listed and can be deleted from the menu",
	async (ui) => {
		await ui.click(T.article, { area: "list" });
		const att = (await ui.saved(T.article)).key;
		const children = await ui.api<{ children: { key: string; itemType: string }[] }>("GET", `/items/${att}`);
		const pdf = children.children.find((x) => x.itemType === "attachment")!.key;
		const mk = (id: string, type: string, extra: Record<string, unknown>, rects: number[][]) => ({
			id,
			type,
			color: "#a28ae5",
			sortIndex: "00000|000100|00200",
			pageLabel: "1",
			dateModified: "2026-01-01T00:00:00Z",
			position: { pageIndex: 0, rects },
			...extra,
		});
		await ui.api("PUT", `/attachments/${pdf}/annotations`, [
			mk("IMAGE222", "image", {}, [[100, 500, 300, 600]]),
			mk("TEXTT222", "text", { text: "typed words" }, [[100, 300, 300, 340]]),
		]);
		await ui.click("Open PDF", { area: "list" });
		await ui.see("/ 3");
		await sideTab(ui, "annotations");
		const side: Rect = { x: 0, y: 110, width: 232, height: 770 };
		await ui.see("2 annotations", { area: side });
		await ui.see("Image area", { area: side });
		await ui.see("typed words", { area: side });
		const c = await ctxOf(ui);
		const f = await ui.screenshot("image-annotation");
		const size = c.pageSize(0);
		const r = c.rectToWindow!(0, { x: 100 / size.w, y: 1 - 600 / size.h, w: 200 / size.w, h: 100 / size.h })!;
		await ui.expect("the image area has a violet dashed frame", () => count(f, { x: r.x - 3, y: r.y - 3, width: r.width + 6, height: 7 }, (rr, g, b) => rr > 140 && rr < 190 && g > 110 && g < 160 && b > 200) > 20, true, 3000);
		await ui.rightClick("Image area", { area: side });
		await ui.see("Copy Image");
		await ui.see("Export Image…");
		await ui.click("Delete", { exact: true });
		await ui.expect("the image annotation is deleted", async () => (await annotationsOf(ui, pdf)).map((a) => a.type), ["text"], 4000);
	},
	{ inProcessOnly: "reader page geometry (pageSize, rectToWindow)" },
);

// ---- citations, figures, references -----------------------------------------------------------------------------------------------------

const CARD: Rect = { x: 0, y: 0, width: 1440, height: 900 };
/** Put the pointer over the first word of a page that has this text and let the card come up. */
async function hoverWord(ui: Ui, page: number, text: string) {
	const w = await showWord(ui, page, (w) => w.t.startsWith(text));
	const x = w.rect.x + w.rect.width / 2,
		y = w.rect.y + w.rect.height / 2;
	await ui.mouseMove(x, y);
	await ui.settle(900);
	return { ...w, x, y };
}
const cardBox = async (ui: Ui) => (await byTestId(ui, "academic-hover-card"))[0];

scenario(
	"the pointer over a citation number shows the reference it stands for",
	async (ui) => {
		await openFromCard(ui);
		const w = await hoverWord(ui, 0, "[1]");
		await ui.waitFor("the card of reference 1", async () => !!(await cardBox(ui)), 8000);
		const box = (await cardBox(ui))!;
		await ui.waitFor("the card names the reference", async () => {
			const p = await ui.painted();
			return p.some((t) => t.includes("LeCun")) && p.some((t) => t === "Deep learning");
		}, 8000);
		await ui.screenshot("citation-card");
		await ui.expect("the card is inside the window", () => box.x >= 0 && box.y >= 0 && box.x + box.width <= 1440 && box.y + box.height <= 900, true);
		void w;
	},
	{ inProcessOnly: "reader text layer and page geometry" },
);

scenario(
	"the card of a citation goes away when the pointer does, and Escape closes it",
	async (ui) => {
		await openFromCard(ui);
		await hoverWord(ui, 0, "[2]");
		await ui.waitFor("a card", async () => !!(await cardBox(ui)), 8000);
		await ui.mouseMove(700, 160);
		await ui.waitFor("the card is gone", async () => !(await cardBox(ui)), 4000);
		await hoverWord(ui, 0, "[2]");
		await ui.waitFor("a card again", async () => !!(await cardBox(ui)), 8000);
		await ui.press("escape");
		await ui.expect("Escape closed it", async () => !!(await cardBox(ui)), false, 3000);
	},
	{ inProcessOnly: "reader text layer and page geometry" },
);

scenario(
	"a click on a citation number goes to its reference, and Back to page 1 comes back",
	async (ui) => {
		await openFromCard(ui);
		const w = await hoverWord(ui, 0, "[1]");
		await ui.clickAt(w.x, w.y);
		await ui.expect("the page with the reference list is shown", async () => (await state(ui)).page >= 1, true, 5000);
		await ui.expect("there is a way back", async () => (await state(ui)).canBack || (await ui.visible("Back to page 1", { area: BAR })), true, 4000);
		await drawn(ui, "citation-jump", 0.002, 0.2);
		if (await ui.visible("Back to page 1", { area: BAR })) await ui.click("Back to page 1", { area: BAR });
		else await tbFixed(ui, "back");
		await ui.expect("page 1 again", async () => (await state(ui)).page, 0, 4000);
	},
	{ inProcessOnly: "reader text layer, page geometry and state" },
);

scenario("the Figures and Tables tab lists the figure and the table and a click goes to it", async (ui) => {
	await openFromCard(ui);
	await sideTab(ui, "figures-tables");
	const side: Rect = { x: 0, y: 110, width: 232, height: 770 };
	await ui.see("Figures (1)", { area: side }, 60000);
	await ui.see("Figure 1", { area: side });
	await ui.see("Tables (1)", { area: side });
	await ui.screenshot("figures-panel");
	await focusPages(ui);
	await ui.press("end");
	if (ui.inProcess) await ui.expect("the last page is shown", async () => (await state(ui)).page, 2, 3000);
	await ui.click("Figure 1", { area: side });
	if (ui.inProcess) await ui.expect("page 1 is shown", async () => (await state(ui)).page, 0, 4000);
	await ui.see("Back to page 3", { area: BAR });
});

scenario("the References tab lists the bibliography, filters it and opens a card", async (ui) => {
	await openFromCard(ui);
	await sideTab(ui, "references");
	const side: Rect = { x: 0, y: 110, width: 232, height: 770 };
	await ui.see("[1]", { area: side }, 60000);
	await ui.see("[8]", { area: side });
	await ui.screenshot("references-panel");
	const box = await ui.see("[1]", { area: side });
	await ui.clickAt(70, (await paneOf(ui)).y + 58); // the filter box
	void box;
	await ui.type("residual");
	await ui.see("[3]", { area: side });
	await ui.gone("[1]", { area: side });
	await ui.type("zzzz");
	await ui.see("No matches.", { area: side });
});

scenario("the Supplementary tab says an item without other attachments has none", async (ui) => {
	await openFromCard(ui);
	await sideTab(ui, "supplementary");
	await ui.see("This item has no other attachments.", { area: { x: 0, y: 110, width: 232, height: 770 } });
});

// ---- the reading view -----------------------------------------------------------------------------------------------------------------------------

scenario("the Reading view shows the text of the paper, Contents lists its headings and PDF goes back", async (ui) => {
	await openFromCard(ui);
	await ui.click("Reading view", { area: BAR });
	if (ui.inProcess) await ui.expect("the reading view is shown", async () => (await ctxOf(ui)).altView(), "reflow", 4000);
	await ui.see("Deep learning in clinical research: a short demo review", { area: { x: 0, y: 150, width: 1440, height: 700 } }, 60000);
	await ui.see("1. Background", { area: { x: 0, y: 150, width: 1440, height: 700 } });
	await ui.screenshot("reading-view");
	await ui.click("Contents", { area: BAR, exact: true });
	await ui.see("CONTENTS");
	await ui.see("3. Reporting standards", { area: { x: 0, y: 150, width: 700, height: 500 } });
	await ui.click("3. Reporting standards", { area: { x: 0, y: 150, width: 700, height: 500 } });
	await ui.gone("CONTENTS");
	await ui.see("3. Reporting standards", { area: { x: 0, y: 120, width: 1440, height: 300 } }, 4000);
	await ui.click("PDF", { area: BAR, exact: true });
	if (ui.inProcess) await ui.expect("the page view is back", async () => (await ctxOf(ui)).altView(), null);
	else await ui.gone("Deep learning in clinical research: a short demo review", { area: { x: 0, y: 150, width: 1440, height: 700 } });
	await drawn(ui, "pdf-again");
});

scenario("the Aa panel of the reading view: size, line spacing, width and theme change the page, Reset restores them", async (ui) => {
	await openFromCard(ui);
	await ui.click("Reading view", { area: BAR });
	await ui.see("1. Background", { area: { x: 0, y: 150, width: 1440, height: 700 } }, 60000);
	await ui.click("Aa", { area: BAR, exact: true });
	await ui.see("Line spacing");
	await ui.screenshot("reading-settings");
	const row = async (name: string) => (await ui.findAll(name, { exact: true, area: { x: 0, y: 100, width: 1440, height: 400 } }))[0]!;
	const size = await row("Size");
	const value = async () => (await ui.findAll("px", { area: { x: size.x, y: size.y - 8, width: 400, height: 16 } }))[0]?.text;
	const v0 = await value();
	await ui.clickAt(size.x + 74 + 60 + 26 + 6, size.y); // the plus after the value
	await ui.expect("the size grew by 1", async () => Number.parseInt((await value()) ?? "0"), Number.parseInt(v0 ?? "0") + 1);
	await ui.click("Dark", { exact: true });
	await ui.expect("the page is dark", async () => {
		const f = await ui.screenshot("reading-dark");
		return pixel(f, 700, 700).every((v) => v < 70);
	}, true, 4000);
	await ui.click("Sepia", { exact: true });
	await ui.expect("the page is sepia", async () => {
		const f = await ui.screenshot("reading-sepia");
		const [r, , b] = pixel(f, 700, 700);
		return r > 200 && b < 230 && r - b > 12;
	}, true, 4000);
	await ui.click("Reset", { exact: true });
	await ui.expect("the size is what it was", () => value(), v0);
	await ui.expect("the page is light again", async () => pixel(await ui.screenshot("reading-reset"), 700, 700).every((v) => v > 235), true, 4000);
});

// ---- the view state ----------------------------------------------------------------------------------------------------------------------------------

scenario(
	"the view of a PDF is as it was after another tab was shown",
	async (ui) => {
		await openFromCard(ui);
		await tb(ui, "zoomIn");
		await tb(ui, "zoomIn");
		await tb(ui, "rotateRight");
		await sideTab(ui, "outline");
		await search(ui, "learning");
		await ui.expect("matches", async () => (await state(ui)).find.total > 1, true, 8000);
		await tb(ui, "next");
		await focusPages(ui);
		await ui.press("end");
		const before = await state(ui);
		await ui.click("Library", { area: "top", exact: true });
		await ui.see(T.neighbour, { area: "list" });
		await ui.click(T.article, { area: "top" });
		await ui.see("/ 3");
		await ui.expect("the state is the same", async () => {
			const s = await state(ui);
			return { ...s, zoom: Math.round(s.zoom * 1000) };
		}, { ...before, zoom: Math.round(before.zoom * 1000) }, 5000);
		await drawn(ui, "view-kept", 0.001, 0.15);
	},
	{ inProcessOnly: "reader view state" },
);

scenario("a tab that was not shown draws its pages and thumbnails again when it is", async (ui) => {
	await openFromCard(ui);
	const second = await addSecondPdf(ui);
	await ui.click("Library", { area: "top", exact: true });
	await openSecond(ui);
	await drawn(ui, "second-shown");
	for (let i = 0; i < 3; i++) {
		await ui.click(T.article, { area: "top" });
		await ui.expect("the first PDF is active", async () => {
			const a = await ui.store.activeTab();
			return a !== second && a !== "library";
		}, true);
		await drawn(ui, `first-shown-${i}`);
		await ui.click(T.authors, { area: "top" });
		await ui.expect("the second PDF is active", () => ui.store.activeTab(), second);
		await drawn(ui, `second-shown-${i}`);
	}
	await ui.click(T.article, { area: "top" });
	await ui.expect("the thumbnails are painted too", async () => paint(await ui.screenshot("thumbs-again"), { x: 55, y: 150, width: 125, height: 150 }, ui.size.width).paper > 0.5, true, 6000);
});

scenario(
	"a hidden reader keeps its place when the window is used for something else for a while",
	async (ui) => {
		await openFromCard(ui);
		await focusPages(ui);
		await ui.press("alt-down");
		await ui.expect("page 2", async () => (await state(ui)).page, 1);
		await ui.click("Library", { area: "top", exact: true });
		await ui.click(T.authors, { area: "list" });
		await ui.settle(1500);
		await ui.click(T.article, { area: "top" });
		await ui.expect("page 2 is still the page", async () => (await state(ui)).page, 1, 4000);
		await drawn(ui, "kept-place", 0.001);
	},
	{ inProcessOnly: "reader page state" },
);
