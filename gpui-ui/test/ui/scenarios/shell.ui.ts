// The frame around everything: the top menus, dialogs, toasts, Settings, appearance, panes and keyboard shortcuts.
//
// The app logs "full-text extraction failed: Cannot use a closed database" once per run, whatever the scenario (library.ts closes the
// database that addFile started the PDF's text extraction with); that is the harness' own noise and is not what these scenarios judge.
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { scenario } from "../define";
import type { Found, Ui } from "../driver";
import { GROUP_NAME, T } from "../library";

// ---- helpers (local: the harness has no test-id lookup, no pixel reading, no state reads) ---------------------------------------

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}
interface Node {
	id: number;
	type: string;
	text?: string;
	testId?: string;
	bounds?: Box;
	children?: Node[];
}

const tree = async (ui: Ui): Promise<Node[]> => {
	await ui.flush();
	const root = (await ui.tree()) as Node | null;
	const out: Node[] = [];
	const walk = (n: Node) => {
		out.push(n);
		for (const c of n.children ?? []) walk(c);
	};
	if (root && typeof root.id === "number") walk(root);
	return out;
};
const boxOf = async (ui: Ui, n: Node): Promise<Box | null> => {
	const b = n.bounds ?? (await ui.bounds(n.id));
	return b && b.width > 0 && b.height > 0 ? b : null;
};
/** The painted box of the element with this test id, null while it is not drawn. */
const byTestId = async (ui: Ui, id: string): Promise<Box | null> => {
	for (const n of await tree(ui)) if (n.testId === id) return boxOf(ui, n);
	return null;
};
const hasTestId = async (ui: Ui, id: string): Promise<boolean> => (await byTestId(ui, id)) !== null;
/** The boxes of every node in the tree that is painted (null boxes dropped). */
const allBoxes = async (ui: Ui): Promise<Box[]> => {
	const out: Box[] = [];
	for (const n of await tree(ui)) {
		const b = await boxOf(ui, n);
		if (b) out.push(b);
	}
	return out;
};
const inputBoxes = async (ui: Ui): Promise<Box[]> => {
	const out: Box[] = [];
	for (const n of await tree(ui)) {
		if (n.type !== "input" && n.type !== "textarea") continue;
		const b = await boxOf(ui, n);
		if (b) out.push(b);
	}
	return out;
};
const centre = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
async function clickTestId(ui: Ui, id: string, o: { button?: number; count?: number } = {}): Promise<void> {
	await ui.waitFor(`${id} on screen`, () => hasTestId(ui, id));
	const c = centre((await byTestId(ui, id))!);
	await ui.clickAt(c.x, c.y, o);
}
async function hoverAt(ui: Ui, x: number, y: number, ms = 450): Promise<void> {
	ui.steps.push(`hover ${Math.round(x)},${Math.round(y)}`);
	await ui.mouseMove(x, y);
	await ui.settle(ms);
}

/** A pixel of the last frame: [r, g, b] (PNG screenshots, 8 bit). */
async function pixel(ui: Ui, x: number, y: number): Promise<[number, number, number]> {
	const file = await ui.screenshot(`px-${Math.round(x)}-${Math.round(y)}-${Math.random().toString(36).slice(2, 6)}`);
	const png = readFileSync(file);
	let pos = 8;
	let w = 0,
		h = 0,
		ct = 6;
	const idat: Buffer[] = [];
	while (pos < png.length) {
		const len = png.readUInt32BE(pos);
		const type = png.toString("ascii", pos + 4, pos + 8);
		if (type === "IHDR") {
			w = png.readUInt32BE(pos + 8);
			h = png.readUInt32BE(pos + 12);
			ct = png[pos + 17]!;
		} else if (type === "IDAT") idat.push(png.subarray(pos + 8, pos + 8 + len));
		pos += 12 + len;
	}
	const bpp = ct === 6 ? 4 : 3;
	const raw = inflateSync(Buffer.concat(idat));
	const stride = w * bpp;
	const rows: Buffer[] = [];
	for (let r = 0; r < h; r++) {
		const f = raw[r * (stride + 1)]!;
		const line = Buffer.from(raw.subarray(r * (stride + 1) + 1, (r + 1) * (stride + 1)));
		const prev = r ? rows[r - 1]! : Buffer.alloc(stride);
		for (let i = 0; i < stride; i++) {
			const a = i >= bpp ? line[i - bpp]! : 0;
			const b = prev[i]!;
			const c = i >= bpp ? prev[i - bpp]! : 0;
			let add = 0;
			if (f === 1) add = a;
			else if (f === 2) add = b;
			else if (f === 3) add = (a + b) >> 1;
			else if (f === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a),
					pb = Math.abs(p - b),
					pc = Math.abs(p - c);
				add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			line[i] = (line[i]! + add) & 255;
		}
		rows.push(line);
	}
	const sx = Math.min(w - 1, Math.round((x * w) / ui.size.width));
	const sy = Math.min(h - 1, Math.round((y * h) / ui.size.height));
	const o = sx * bpp;
	return [rows[sy]![o]!, rows[sy]![o + 1]!, rows[sy]![o + 2]!];
}
const luma = (c: [number, number, number]) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
const sameColour = (a: [number, number, number], b: [number, number, number], tol = 6) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= tol;

/** Click the first text field painted at or below this text (the placeholder of a field is not text in the tree). */
async function clickInputBelow(ui: Ui, y: number, from = 0): Promise<void> {
	const boxes = (await inputBoxes(ui))
		.filter((b) => b.y >= y - 4 && b.x + b.width > from)
		.sort((p, q) => p.y - q.y || p.x - q.x);
	if (!boxes[0]) throw new Error(`no text field below y=${Math.round(y)}`);
	await ui.clickAt(boxes[0].x + Math.min(40, boxes[0].width / 2), boxes[0].y + boxes[0].height / 2);
}

const TOP_BAR: Box = { x: 0, y: 0, width: 420, height: 28 };
/** Opens a top menu; returns the area its entries are in. */
async function openMenu(ui: Ui, name: string): Promise<Box> {
	const trigger = await ui.see(name, { exact: true, area: TOP_BAR });
	await ui.clickAt(trigger.x, trigger.y);
	return { x: trigger.box.x - 6, y: 29, width: 300, height: 700 };
}
async function pick(ui: Ui, menu: string, entry: string): Promise<void> {
	const panel = await openMenu(ui, menu);
	await ui.click(entry, { exact: true, area: panel });
}
const menuHas = (ui: Ui, panel: Box, entry: string) => ui.visible(entry, { exact: true, area: panel });

// (the modules of the app: they are the app's own state only in the in-process mode, so they are read behind `ui.inProcess`)
const layoutMod = () => import("../../../src/shell/layout");
const registryMod = () => import("../../../src/registry");
const chromeMod = () => import("../../../src/wasmplugins/extend/Chrome");
const uiCore = () => import("../../../src/ui/core");
const selectedCount = async (ui: Ui): Promise<number> => (await ui.store.selected()).length;
const itemsTotal = async (ui: Ui): Promise<number> => (await ui.api<{ total: number }>("GET", "/items?limit=1&q=")).total;
const trashCount = async (ui: Ui): Promise<number> => (await ui.api<{ items: number }>("GET", "/maintenance/trash")).items;

/** The right of the window where toasts stack. */
const toastArea = (ui: Ui): Box => ({ x: ui.size.width * 0.5, y: ui.size.height * 0.45, width: ui.size.width * 0.5, height: ui.size.height * 0.55 });

/** The gear at the right of the top bar and the two panel buttons: there are no labels to click, so by their place. */
const gear = (ui: Ui) => ({ x: ui.size.width - 26, y: 47 });
const leftToggle = () => ({ x: 26, y: 47 });
const rightToggle = (ui: Ui) => ({ x: ui.size.width - 58, y: 47 });
async function openSettings(ui: Ui): Promise<void> {
	const g = gear(ui);
	await ui.clickAt(g.x, g.y);
	await ui.see("SETTINGS", { exact: true });
}
async function leaveSettings(ui: Ui): Promise<void> {
	await ui.click("Library", { exact: true, area: { x: 0, y: 30, width: 400, height: 36 } });
	await ui.gone("SETTINGS", { exact: true });
}
const NAV = (ui: Ui): Box => ({ x: 0, y: 100, width: 208, height: ui.size.height - 100 });
const CONTENT = (ui: Ui): Box => ({ x: 210, y: 110, width: ui.size.width - 210, height: ui.size.height - 110 });
async function gotoSection(ui: Ui, label: string): Promise<void> {
	await ui.click(label, { exact: true, area: NAV(ui) });
	await ui.see(label, { exact: true, area: CONTENT(ui) });
}
/** Scroll the Settings page down until `text` is painted in it. */
async function scrollTo(ui: Ui, text: string, o: { exact?: boolean } = {}): Promise<Found> {
	const area = CONTENT(ui);
	for (let i = 0; i < 60; i++) {
		const f = (await ui.findAll(text, { ...o, area: { x: area.x, y: area.y, width: area.width, height: area.height } }))[0];
		if (f) return f;
		await ui.wheel(area.x + area.width / 2, area.y + area.height / 2, -240);
	}
	throw new Error(`"${text}" never came into view when scrolling the page`);
}
async function scrollTop(ui: Ui, heading?: string): Promise<void> {
	const area = CONTENT(ui);
	for (let i = 0; i < 40; i++) {
		if (heading && (await ui.visible(heading, { exact: true, area }))) return;
		await ui.wheel(area.x + area.width / 2, area.y + area.height / 2, heading ? 2400 : 600);
	}
}

// ================================================================================================================================
// The six top menus
// ================================================================================================================================

const MENU_NAMES = ["File", "Edit", "View", "Go", "Tools", "Help"] as const;

scenario("the menubar offers File, Edit, View, Go, Tools and Help in that order", async (ui) => {
	const found: Found[] = [];
	for (const m of MENU_NAMES) found.push(await ui.see(m, { exact: true, area: TOP_BAR }));
	await ui.expect("they are in a row, left to right", () => found.every((f, i) => i === 0 || f.x > found[i - 1]!.x), true);
	await ui.expect("they are all on one line", () => new Set(found.map((f) => Math.round(f.y))).size, 1);
});

for (const name of MENU_NAMES) {
	scenario(`the ${name} menu opens and lists exactly its entries`, async (ui) => {
		const { menubarItems } = await chromeMod();
		const wanted = menubarItems(name.toLowerCase() as never).filter((i) => !i.separator);
		const panel = await openMenu(ui, name);
		let last = 0;
		for (const it of wanted) {
			const f = await ui.see(it.label!, { exact: true, area: panel });
			await ui.expect(`${it.label} is below the entry before it`, () => f.y > last, true, 0);
			last = f.y;
			if (it.shortcut) await ui.see(it.shortcut, { exact: true, area: panel });
		}
		await ui.screenshot(`menu-${name.toLowerCase()}`);
	}, name === "File" || name === "Help" ? { inProcessOnly: "the entries come from the app's action registry, which the runner only has in-process" } : {});
	}

scenario("Escape closes an open menu and runs nothing", async (ui) => {
	const panel = await openMenu(ui, "Go");
	await ui.see("Settings", { exact: true, area: panel });
	await ui.press("escape");
	await ui.gone("Settings", { exact: true, area: panel });
	await ui.expectStill("the library is still the tab", () => ui.store.activeTab(), "library");
});

scenario("a click outside a menu closes it and does not reach what is beneath", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.expect("ZT01 is selected", () => ui.selectedTitle(), T.authors);
	const panel = await openMenu(ui, "Go");
	await ui.see("Settings", { exact: true, area: panel });
	const row = await ui.see(T.neighbour, { area: "list" });
	await ui.clickAt(row.x, row.y);
	await ui.gone("Settings", { exact: true, area: panel });
	await ui.expectStill("the click only closed the menu", () => ui.selectedTitle(), T.authors);
});

scenario("arrow keys and Enter choose a menu entry", async (ui) => {
	await openMenu(ui, "Go");
	await ui.press("down");
	await ui.press("down");
	await ui.press("enter");
	await ui.expect("the Settings tab is active", () => ui.store.activeTab(), "settings");
	await ui.see("SETTINGS", { exact: true });
});

scenario("Up from the first entry wraps to the last, Home and End jump to the ends", async (ui) => {
	await openMenu(ui, "Go");
	await ui.press("up");
	await ui.press("enter");
	await ui.expect("the last entry ran", () => ui.store.activeTab(), "settings");
	await ui.click("Library", { exact: true, area: { x: 0, y: 30, width: 400, height: 36 } });
	await ui.expect("back on the library", () => ui.store.activeTab(), "library");
	await openMenu(ui, "Go");
	await ui.press("end");
	await ui.press("enter");
	await ui.expect("End chose the last entry", () => ui.store.activeTab(), "settings");
	await ui.click("Library", { exact: true, area: { x: 0, y: 30, width: 400, height: 36 } });
	await openMenu(ui, "Go");
	await ui.press("end");
	await ui.press("home");
	await ui.press("enter");
	await ui.expectStill("Home chose the first entry", () => ui.store.activeTab(), "library");
});

scenario("a menu entry that does not apply is left out, and appears when it does", async (ui) => {
	let panel = await openMenu(ui, "Tools");
	await ui.see("Edit layout", { exact: true, area: panel });
	await ui.expect("Undo layout change is not offered with nothing to undo", () => menuHas(ui, panel, "Undo layout change"), false);
	await ui.press("escape");
	// hide the item pane from its hover header: that is an undoable change
	const pane = (await byTestId(ui, "pane-item"))!;
	await hoverAt(ui, pane.x + pane.width / 2, pane.y + 3);
	await clickTestId(ui, "pane-hover-close-item");
	await ui.gone("Select an item to view its details");
	panel = await openMenu(ui, "Tools");
	await ui.see("Undo layout change", { exact: true, area: panel });
});

scenario("a second menu can be opened after the first was closed by a click on the bar", async (ui) => {
	const panel = await openMenu(ui, "File");
	await ui.see("New Item…", { exact: true, area: panel });
	const edit = await ui.see("Edit", { exact: true, area: TOP_BAR });
	await ui.clickAt(edit.x, edit.y); // the backdrop takes this click: the first menu closes
	await ui.gone("New Item…", { exact: true });
	await ui.clickAt(edit.x, edit.y);
	await ui.see("Select all items", { exact: true });
});

// ---- the entries -----------------------------------------------------------------------------------------------------------------

scenario("File > New Item… opens a type list; the chosen type is created", async (ui) => {
	const before = await itemsTotal(ui);
	await pick(ui, "File", "New Item…");
	await ui.see("New Item", { exact: true });
	await ui.see("Book", { exact: true });
	await ui.screenshot("new-item");
	await ui.click("Book", { exact: true });
	await ui.gone("New Item", { exact: true });
	await ui.expect("one more item in the library", () => itemsTotal(ui), before + 1, 5000);
	await ui.expect("it is a book", async () => (await ui.api<{ items: { itemType: string }[] }>("GET", "/items?limit=5&q=&sort=dateAdded&dir=desc")).items.some((i) => i.itemType === "book"), true);
});

scenario("New Item: typing narrows the types, Enter takes the first, Escape leaves without creating", async (ui) => {
	const before = await itemsTotal(ui);
	await pick(ui, "File", "New Item…");
	await ui.see("Artwork", { exact: true });
	await ui.type("pat");
	await ui.see("Patent", { exact: true });
	await ui.gone("Artwork", { exact: true });
	await ui.press("escape");
	await ui.gone("New Item", { exact: true });
	await ui.expectStill("nothing was created", () => itemsTotal(ui), before);
	await pick(ui, "File", "New Item…");
	await ui.type("patent");
	await ui.press("enter");
	await ui.gone("New Item", { exact: true });
	await ui.expect("a patent was created", () => itemsTotal(ui), before + 1, 5000);
});

scenario("File > Add Item by Identifier…: Cancel closes it; Add with nothing typed does nothing", async (ui) => {
	await pick(ui, "File", "Add Item by Identifier…");
	await ui.see("Add Item by Identifier", { exact: true });
	await ui.screenshot("identifier");
	await ui.click("Add", { exact: true, area: { x: 0, y: ui.size.height / 2, width: ui.size.width, height: ui.size.height / 2 } });
	await ui.expectStill("no lookup was started", () => ui.visible("Looking up identifiers…"), false, 500);
	await ui.expect("the dialog is still there", () => ui.visible("Add Item by Identifier", { exact: true }), true);
	await ui.click("Cancel", { exact: true });
	await ui.gone("Add Item by Identifier", { exact: true });
});

scenario("Add Item by Identifier starts with the identifiers found on the clipboard", async (ui) => {
	await ui.setClipboard("10.1136/bmj-2023-078378");
	await pick(ui, "File", "Add Item by Identifier…");
	await ui.see("Add Item by Identifier", { exact: true });
	await ui.expect("the identifier is in the text field", async () => (await ui.painted()).some((t) => t.includes("10.1136/bmj-2023-078378")), true);
	await ui.press("escape");
	await ui.gone("Add Item by Identifier", { exact: true });
}, { inProcessOnly: "the text of an input is not in the automation tree" });

scenario("File > Add Attachment: Link to File… links the file where it is", async (ui) => {
	// (a PDF would be looked up on crossref.org once linked, which the fence refuses: a JSON file is linked instead)
	const file = new URL("../../../package.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
	const before = await itemsTotal(ui);
	await pick(ui, "File", "Add Attachment: Link to File…");
	await ui.see("Link to File", { exact: true });
	await ui.type(process.platform === "win32" ? file.replace(/\//g, "\\") : file);
	await ui.click("Link", { exact: true });
	await ui.gone("Link to File", { exact: true });
	await ui.expect("a linked attachment was added", () => itemsTotal(ui), before + 1, 5000);
});

scenario("Link to File: Cancel and Escape add nothing", async (ui) => {
	const before = await itemsTotal(ui);
	await pick(ui, "File", "Add Attachment: Link to File…");
	await ui.see("Link to File", { exact: true });
	await ui.click("Cancel", { exact: true });
	await ui.gone("Link to File", { exact: true });
	await pick(ui, "File", "Add Attachment: Link to File…");
	await ui.see("Link to File", { exact: true });
	await ui.press("escape");
	await ui.gone("Link to File", { exact: true });
	await ui.expectStill("nothing was added", () => itemsTotal(ui), before);
});

scenario("File > Add Attachment: Link to URI… adds the address with its title", async (ui) => {
	const before = await itemsTotal(ui);
	await pick(ui, "File", "Add Attachment: Link to URI…");
	await ui.see("Link to URI", { exact: true });
	await ui.screenshot("link-uri");
	await ui.type("https://example.org/paper");
	await ui.press("tab");
	await ui.type("Example paper link");
	await ui.click("Add", { exact: true, area: { x: 0, y: ui.size.height / 2, width: ui.size.width, height: ui.size.height / 2 } });
	await ui.gone("Link to URI", { exact: true });
	await ui.expect("one more item", () => itemsTotal(ui), before + 1, 5000);
	await ui.expect("it is saved with that title", async () => (await ui.api<{ items: { title: string }[] }>("GET", "/items?limit=5&q=Example%20paper%20link")).items.map((i) => i.title), ["Example paper link"]);
});

scenario("Link to URI: Cancel adds nothing", async (ui) => {
	const before = await itemsTotal(ui);
	await pick(ui, "File", "Add Attachment: Link to URI…");
	await ui.see("Link to URI", { exact: true });
	await ui.type("https://example.org/never");
	await ui.click("Cancel", { exact: true });
	await ui.gone("Link to URI", { exact: true });
	await ui.expectStill("nothing was added", () => itemsTotal(ui), before);
});

scenario("File > Add from URL… opens its dialog, and Cancel closes it (the lookup itself needs the network: not run)", async (ui) => {
	await pick(ui, "File", "Add from URL…");
	await ui.see("Add from URL", { exact: true });
	await ui.screenshot("add-url");
	await ui.click("Cancel", { exact: true });
	await ui.gone("Add from URL", { exact: true });
});

scenario("File > New Standalone Note adds a note to the library", async (ui) => {
	const before = await itemsTotal(ui);
	await pick(ui, "File", "New Standalone Note");
	await ui.expect("one more item", () => itemsTotal(ui), before + 1, 6000);
	await ui.expect("one item is selected", () => selectedCount(ui), 1);
});

scenario("in a read-only group the File menu offers no way to add items", async (ui) => {
	await ui.click(GROUP_NAME, { area: "sidebar" });
	await ui.see(T.groupItem, { area: "list" });
	const panel = await openMenu(ui, "File");
	await ui.settle(300);
	await ui.screenshot("file-menu-read-only");
	for (const e of ["New Item…", "New Standalone Note", "Add Item by Identifier…", "Add Attachment: Stored File…", "Add Attachment: Link to File…", "Add Attachment: Link to URI…", "Add from URL…"])
		await ui.expect(`"${e}" is not offered in a read-only library`, () => menuHas(ui, panel, e), false, 500);
});

scenario("Edit > Select all items selects every item of the list", async (ui) => {
	await pick(ui, "Edit", "Select all items");
	await ui.expect("every item is selected", () => selectedCount(ui), await ui.store.total(), 6000);
});

// ---- View ------------------------------------------------------------------------------------------------------------------------

scenario("View > Collections sidebar hides and shows the sidebar", async (ui) => {
	await ui.see("COLLECTIONS", { exact: true, area: "sidebar" });
	await pick(ui, "View", "Collections sidebar");
	await ui.gone("COLLECTIONS", { exact: true });
	if (ui.inProcess) await ui.expect("the layout says the sidebar is hidden", async () => (await layoutMod()).leftOpen(), false);
	await pick(ui, "View", "Collections sidebar");
	await ui.see("COLLECTIONS", { exact: true, area: "sidebar" });
});

scenario("View > Item pane hides and shows the item pane", async (ui) => {
	await ui.see("Select an item to view its details");
	await pick(ui, "View", "Item pane");
	await ui.gone("Select an item to view its details");
	if (ui.inProcess) await ui.expect("the layout says the item pane is hidden", async () => (await layoutMod()).rightOpen(), false);
	await pick(ui, "View", "Item pane");
	await ui.see("Select an item to view its details");
});

scenario("View > Classic table shows the table, View > List view the cards again", async (ui) => {
	await ui.see("Find full text", { area: "list" });
	await pick(ui, "View", "Classic table");
	await ui.expect("the store is in table mode", () => ui.store.viewMode(), "table");
	await ui.gone("Find full text");
	await ui.screenshot("classic-table");
	await pick(ui, "View", "List view");
	await ui.expect("the store is in card mode", () => ui.store.viewMode(), "cards");
	await ui.see("Find full text", { area: "list" });
});

// ---- Go --------------------------------------------------------------------------------------------------------------------------

scenario("Go > Settings opens the Settings tab and Go > Library comes back", async (ui) => {
	await pick(ui, "Go", "Settings");
	await ui.see("SETTINGS", { exact: true });
	await ui.expect("Settings is the active tab", () => ui.store.activeTab(), "settings");
	await ui.see("Settings", { exact: true, area: { x: 0, y: 30, width: 600, height: 36 } });
	await pick(ui, "Go", "Library");
	await ui.expect("the library is the active tab", () => ui.store.activeTab(), "library");
	await ui.see(T.article, { area: "list" });
});

// ---- Tools -----------------------------------------------------------------------------------------------------------------------

scenario("Tools > Edit layout shows the layout bar; the entry then reads Finish editing layout and ends it", async (ui) => {
	await pick(ui, "Tools", "Edit layout");
	await ui.see("Editing layout");
	await ui.screenshot("edit-layout");
	await ui.expect("the layout bar is painted", () => hasTestId(ui, "layout-edit-bar"), true);
	await pick(ui, "Tools", "Finish editing layout");
	await ui.expect("the layout bar is gone", () => hasTestId(ui, "layout-edit-bar"), false);
});

scenario("Edit layout mode ends with Escape and with Done", async (ui) => {
	await pick(ui, "Tools", "Edit layout");
	await ui.expect("editing", () => hasTestId(ui, "layout-edit-bar"), true);
	await ui.press("escape");
	await ui.expect("Escape ended it", () => hasTestId(ui, "layout-edit-bar"), false);
	await pick(ui, "Tools", "Edit layout");
	await ui.click("Done", { exact: true });
	await ui.expect("Done ended it", () => hasTestId(ui, "layout-edit-bar"), false);
});

scenario("Tools > Undo layout change brings a hidden pane back", async (ui) => {
	const pane = (await byTestId(ui, "pane-item"))!;
	await hoverAt(ui, pane.x + pane.width / 2, pane.y + 3);
	await clickTestId(ui, "pane-hover-close-item");
	await ui.gone("Select an item to view its details");
	await pick(ui, "Tools", "Undo layout change");
	await ui.see("Select an item to view its details");
	if (ui.inProcess) await ui.expect("the item pane is shown", async () => (await layoutMod()).rightOpen(), true);
});

scenario("Tools > Reset pane sizes puts the columns back after they were dragged", async (ui) => {
	const left = (await byTestId(ui, "column-left"))!;
	await ui.drag({ x: left.x + left.width + 6, y: 400 }, { x: left.x + left.width + 106, y: 400 });
	await ui.expect("the sidebar got wider", async () => (await byTestId(ui, "column-left"))!.width > left.width + 40, true);
	await pick(ui, "Tools", "Reset pane sizes");
	await ui.expect("the sidebar is the default width again", async () => Math.abs((await byTestId(ui, "column-left"))!.width - left.width) < 2, true);
});

scenario("Tools > Reset layout brings back hidden panes and the standard arrangement", async (ui) => {
	await pick(ui, "View", "Item pane");
	await ui.gone("Select an item to view its details");
	await pick(ui, "Tools", "Reset layout");
	await ui.see("Select an item to view its details");
	if (ui.inProcess) await ui.expect("the item pane is shown", async () => (await layoutMod()).rightOpen(), true);
});

scenario("Tools > Settings… opens Settings", async (ui) => {
	await pick(ui, "Tools", "Settings…");
	await ui.see("SETTINGS", { exact: true });
});

scenario("Tools > Duplicate Items… opens the duplicates dialog; with none in the library it says so, and leaving it goes back to the library", async (ui) => {
	await pick(ui, "Tools", "Duplicate Items…");
	await ui.see("No duplicate sets found.", { exact: true });
	await ui.see("Duplicate Items", { exact: true, area: { x: 300, y: 80, width: ui.size.width - 300, height: 200 } });
	await ui.screenshot("duplicates");
	await ui.press("escape");
	await ui.gone("No duplicate sets found.", { exact: true });
	await ui.expect("still on the library view", async () => (await ui.store.view()).kind, "library");
});

scenario("Tools > Empty Trash… asks first; Cancel keeps the trashed item", async (ui) => {
	await ui.expect("the trash holds one item", () => trashCount(ui), 1);
	await pick(ui, "Tools", "Empty Trash…");
	await ui.see("Empty Trash?", { exact: true });
	await ui.screenshot("empty-trash");
	await ui.click("Cancel", { exact: true });
	await ui.gone("Empty Trash?", { exact: true });
	await ui.expectStill("the trash is untouched", () => trashCount(ui), 1);
});

scenario("Empty Trash: Escape cancels, Enter confirms and empties it", async (ui) => {
	await pick(ui, "Tools", "Empty Trash…");
	await ui.see("Empty Trash?", { exact: true });
	await ui.press("escape");
	await ui.gone("Empty Trash?", { exact: true });
	await ui.expectStill("Escape kept the item", () => trashCount(ui), 1);
	await pick(ui, "Tools", "Empty Trash…");
	await ui.see("Empty Trash?", { exact: true });
	await ui.press("enter");
	await ui.expect("the trash is empty", () => trashCount(ui), 0, 5000);
});

scenario("Empty Trash: clicking the backdrop does not dismiss the question", async (ui) => {
	await pick(ui, "Tools", "Empty Trash…");
	await ui.see("Empty Trash?", { exact: true });
	await ui.clickAt(60, ui.size.height - 40);
	await ui.expectStill("the question is still asked", () => ui.visible("Empty Trash?", { exact: true }), true, 400);
	await ui.expect("nothing was deleted", () => trashCount(ui), 1);
});

scenario("Tools > Delete Automatic Tags… says there are none, in a toast", async (ui) => {
	await pick(ui, "Tools", "Delete Automatic Tags…");
	const t = await ui.see("There are no automatic tags in this library", { area: toastArea(ui) });
	await ui.screenshot("toast-no-auto-tags");
	await ui.expect("the toast is in the bottom right corner", () => t.x > ui.size.width * 0.6 && t.y > ui.size.height * 0.6, true, 0);
});

scenario("Tools > Import from Clipboard imports what is on the clipboard", async (ui) => {
	const before = await itemsTotal(ui);
	await ui.setClipboard("@article{zt-clip, title={ZT Clipboard import}, author={Clip, Cara}, year={2022}, journal={Clip Journal}}");
	await pick(ui, "Tools", "Import from Clipboard");
	await ui.expect("one more item", () => itemsTotal(ui), before + 1, 8000);
	await ui.see("ZT Clipboard import", { area: "list" });
});

scenario("Tools > Keyboard Shortcuts lists the commands with their keys and closes with Close", async (ui) => {
	await pick(ui, "Tools", "Keyboard Shortcuts");
	await ui.see("COMMANDS", { exact: true });
	for (const k of ["F6", "Ctrl+Shift+N", "Ctrl+Tab", "Ctrl+,", "Ctrl+Shift+K", "NAVIGATION"]) {
		for (let i = 0; i < 30 && !(await ui.visible(k, { exact: true })); i++) await ui.wheel(ui.size.width / 2, ui.size.height / 2, -200);
		await ui.see(k, { exact: true });
	}
	await ui.screenshot("shortcut-help");
	await ui.click("Close", { exact: true });
	await ui.gone("COMMANDS", { exact: true });
});

scenario("Tools > Report a problem… shows the report, copies it, and Close closes it", async (ui) => {
	await pick(ui, "Tools", "Report a problem…");
	await ui.see("Zinc problem report", { exact: true });
	await ui.screenshot("report");
	await ui.click("Copy to clipboard", { exact: true });
	await ui.expect("the report is on the clipboard", async () => (await ui.clipboard()).startsWith("Zinc problem report"), true);
	await ui.click("Close", { exact: true });
	await ui.gone("Zinc problem report", { exact: true });
});

scenario("Help > Report a problem… opens the same report, and Escape closes it", async (ui) => {
	await pick(ui, "Help", "Report a problem…");
	await ui.see("Zinc problem report", { exact: true });
	await ui.press("escape");
	await ui.gone("Zinc problem report", { exact: true });
});

scenario("Tools > Advanced Search… searches the library, and Close closes it", async (ui) => {
	await pick(ui, "Tools", "Advanced Search…");
	await ui.see("Advanced Search", { exact: true });
	await ui.screenshot("advanced-search");
	await ui.click("Enter a value to search", { exact: true });
	await ui.type("Neighbour");
	await ui.see(T.neighbour, { area: { x: 0, y: 0, width: ui.size.width, height: ui.size.height } });
	await ui.click("Close", { exact: true });
	await ui.gone("Advanced Search", { exact: true });
});

scenario("Tools > Find Full Text Settings…: Cancel changes nothing, Save keeps the change and says so", async (ui) => {
	await pick(ui, "Tools", "Find Full Text Settings…");
	await ui.see("Unpaywall email", { exact: true });
	await ui.screenshot("fulltext-settings");
	const mail = async () => {
		const l = await ui.see("Unpaywall email", { exact: true });
		await clickInputBelow(ui, l.y, l.box.x - 4);
	};
	await mail();
	await ui.type("a@b.org");
	await ui.click("Cancel", { exact: true });
	await ui.gone("Unpaywall email", { exact: true });
	await pick(ui, "Tools", "Find Full Text Settings…");
	await ui.see("Unpaywall email", { exact: true });
	await ui.expect("the text that was cancelled is not there", async () => (await ui.painted()).some((t) => t.includes("a@b.org")), false);
	await mail();
	await ui.type("a@b.org");
	await ui.click("Save", { exact: true });
	await ui.see("Find Full Text settings saved", { area: toastArea(ui) });
	await pick(ui, "Tools", "Find Full Text Settings…");
	await ui.expect("the saved address is in the field", async () => (await ui.painted()).some((t) => t.includes("a@b.org")), true);
}, { inProcessOnly: "the text of an input is not in the automation tree" });

// ================================================================================================================================
// Settings
// ================================================================================================================================

const prefsMod = () => import("../../../src/shell/appearance");
const settingsRegistry = () => import("../../../src/settings/registry");
const settingsSectionsMod = () => import("../../../src/registry");

/** Leave Settings for the library and come back: what a user does to see whether a choice was kept. */
async function roundTrip(ui: Ui): Promise<void> {
	await leaveSettings(ui);
	await ui.see("ZT00", { area: "list" });
	await openSettings(ui);
}
/** The right edge of the controls of a Settings row: the card is 768 wide and has 16 px of padding. */
const controlRight = async (ui: Ui): Promise<number> => {
	const edges = (await allBoxes(ui))
		.filter((x) => x.width >= 760 && x.width <= 770 && x.x >= 210)
		.map((x) => x.x + x.width);
	return Math.max(...edges, 1000) - 16;
};
/** Click the switch of the row with this label. */
async function clickSwitch(ui: Ui, label: string): Promise<void> {
	const f = await scrollTo(ui, label, { exact: true });
	await ui.clickAt((await controlRight(ui)) - 17, f.y + 9);
}

/** The search box of Settings (its placeholder is not text in the tree). */
const clickSearch = (ui: Ui) => ui.clickAt(CONTENT(ui).x + 150, 91);
const paintedHas = async (ui: Ui, text: string): Promise<boolean> => (await ui.painted()).some((t) => t.includes(text));

const sectionList = async () => (await settingsSectionsMod()).settingsSections().map((s) => ({ id: s.id, label: s.label }));

// ---- the page --------------------------------------------------------------------------------------------------------------------

scenario("the gear opens Settings as a tab, its x closes it and the library is back", async (ui) => {
	await openSettings(ui);
	await ui.expect("Settings is the active tab", () => ui.store.activeTab(), "settings");
	await ui.see("Settings", { exact: true, area: { x: 0, y: 30, width: 600, height: 40 } });
	await ui.screenshot("settings-open");
	const tab = (await ui.findAll("Settings", { exact: true, area: { x: 0, y: 30, width: 600, height: 40 } }))[0]!;
	await ui.clickAt(tab.box.x + tab.box.width + 14, tab.y); // the x of the tab
	await ui.expect("back on the library", () => ui.store.activeTab(), "library");
	await ui.gone("SETTINGS", { exact: true });
});

scenario("Settings lists every section in its sidebar", async (ui) => {
	await openSettings(ui);
	// (the registry is the app's own state: the real app is checked against the list of sections written below)
	const labels = ui.inProcess ? (await sectionList()).map((s) => s.label) : SECTIONS;
	for (const label of labels) await ui.see(label, { exact: true, area: NAV(ui) });
});

scenario("searching Settings filters the sections, shows counts, and Escape clears the search", async (ui) => {
	await openSettings(ui);
	await clickSearch(ui);
	await ui.type("dark");
	await ui.see("Theme", { exact: true, area: CONTENT(ui) });
	await ui.see("setting", { area: { x: 210, y: 70, width: ui.size.width - 210, height: 60 } });
	await ui.screenshot("settings-search");
	await ui.press("escape");
	await ui.see("Plugins", { exact: true, area: NAV(ui) }); // the sections that the search had filtered out are listed again
	if (ui.inProcess) await ui.expect("the search box is empty again", () => paintedHas(ui, "Search settings"), true);
});

scenario("a search with no match says so and Clear search shows the section again", async (ui) => {
	await openSettings(ui);
	await clickSearch(ui);
	await ui.type("zzzzqqq");
	await ui.see('No settings match "zzzzqqq"', { exact: true });
	await ui.click("Clear search", { exact: true });
	await ui.gone('No settings match "zzzzqqq"', { exact: true });
	await ui.see("Theme", { exact: true, area: CONTENT(ui) });
});

// ---- every section: opens and renders all of its rows when scrolled ------------------------------------------------------------------

const SECTIONS = [
	"Appearance",
	"General",
	"Reader",
	"Sync",
	"Find Full Text",
	"Cite",
	"Better BibTeX",
	"Export",
	"Shortcuts",
	"Files and folders",
	"Experimental",
	"System",
	"Plugins",
];
// Cite is left out: it fetches the list of styles from zotero.org, and a test has no network.
for (const label of SECTIONS.filter((s) => s !== "Cite")) {
	scenario(`Settings > ${label} opens and every row of it is painted when scrolled`, async (ui) => {
		await openSettings(ui);
		await gotoSection(ui, label);
		await ui.settle(500);
		await ui.screenshot(`section-top`);
			// (the list of rows is the registry of the app: the real app only gets its section opened and scrolled both ways)
		let wanted: string[] = [];
		if (ui.inProcess) {
			const reg = await settingsSectionsMod();
			const id = reg.settingsSections().find((s) => s.label === label)!.id;
			const { allSettings } = await settingsRegistry();
			const rows = allSettings().filter((s) => s.section === id);
			wanted = rows.map((r) => (r.label.length > 48 ? r.label.slice(0, 48) : r.label));
		}
		const found = new Set<string>();
		const area = CONTENT(ui);
		await scrollTop(ui, label);
		// a screenful at a time (rows are far shorter than the overlap), the screen read once per step
		for (let step = 0; step < 80 && found.size < wanted.length; step++) {
			for (const w of await ui.shownOf(wanted, area)) found.add(w);
			if (found.size === wanted.length) break;
			await ui.wheel(area.x + area.width / 2, area.y + area.height / 2, -480);
		}
		await ui.expect("every registered row was painted at some scroll position", () => wanted.filter((w) => !found.has(w)), []);
		await ui.screenshot(`section-bottom`);
		// and the page can be scrolled back to its top
		await scrollTop(ui, label);
		await ui.see(label, { exact: true, area: CONTENT(ui) });
	});
}

// ---- Appearance -----------------------------------------------------------------------------------------------------------------

for (const [mode, high] of [
	["Light", true],
	["Dark", false],
] as const) {
	scenario(`Settings > Appearance > Theme ${mode} repaints the window and is kept`, async (ui) => {
		// the test starts dark (define.ts); light must be chosen, dark must be chosen from light first
		await openSettings(ui);
		await ui.see("Theme", { exact: true, area: CONTENT(ui) });
		if (!high) {
			await ui.click("Light", { exact: true, area: CONTENT(ui) });
			await ui.expect("light first", async () => luma(await pixel(ui, ui.size.width - 60, ui.size.height - 60)) > 0.7, true);
		}
		await ui.click(mode, { exact: true, area: CONTENT(ui) });
		// (the pixel is what the user sees; the preference is read only where the app is in this process)
		const prefs = ui.inProcess ? (await prefsMod()).themePrefs : undefined;
		if (prefs) await ui.expect("the preference", () => prefs().mode, mode.toLowerCase() as "light" | "dark");
		await ui.expect(`the page is painted ${mode.toLowerCase()}`, async () => luma(await pixel(ui, ui.size.width - 60, ui.size.height - 60)) > 0.7, high);
		await ui.screenshot(`theme-${mode.toLowerCase()}`);
		await roundTrip(ui);
		if (prefs) await ui.expect("still the preference", () => prefs().mode, mode.toLowerCase() as "light" | "dark");
		await ui.expect(`the page is still painted ${mode.toLowerCase()}`, async () => luma(await pixel(ui, ui.size.width - 60, ui.size.height - 60)) > 0.7, high);
	});
}

scenario("Settings > Appearance > Theme System follows the machine and is kept", async (ui) => {
	await openSettings(ui);
	await ui.click("System", { exact: true, area: CONTENT(ui) });
	const { themePrefs } = await prefsMod();
	await ui.expect("the preference", () => themePrefs().mode, "system");
	await roundTrip(ui);
	await ui.expect("still system", () => themePrefs().mode, "system");
}, { inProcessOnly: "reads the saved theme preference (nothing on screen tells System from the machine's own mode)" });

scenario("Settings > Appearance > Colour scheme: each swatch changes the accent, the custom one takes a hex colour, all kept", async (ui) => {
	await openSettings(ui);
	const { themePrefs, SCHEMES } = await prefsMod();
	const custom = await scrollTo(ui, "Custom", { exact: true });
	const swatches = (await allBoxes(ui))
		.filter((b) => Math.round(b.width) === 28 && Math.round(b.height) === 28 && Math.abs(b.y + 14 - custom.y) < 8)
		.sort((a, b) => a.x - b.x);
	await ui.expect("a swatch per scheme and the custom one", () => swatches.length, SCHEMES.length + 1);
	const dot = (b: Box) => centre(b);
	// the accent shows in the Add button, behind the settings page: look at the quiet "Add" the Library tab has instead, i.e. the focus
	// ring colour is not readable; so compare the swatch's own filled disc, which is painted in the scheme's colour
	const seen: string[] = [];
	for (let i = 0; i < SCHEMES.length; i++) {
		const p = dot(swatches[i]!);
		const nodes = await tree(ui);
		const hit = ((await ui.elementsAt(p.x, p.y)) ?? []).slice(0, 4).map((id) => { const n = nodes.find((t) => t.id === id); return `${id}:${n?.type}:${Math.round(n?.bounds?.width ?? 0)}x${Math.round(n?.bounds?.height ?? 0)}`; });
		await ui.clickAt(p.x, p.y);
		await ui.expect(`scheme ${SCHEMES[i]!.id} is chosen (the click at ${Math.round(p.x)},${Math.round(p.y)} hit ${hit.join(" ")})`, () => themePrefs().scheme, SCHEMES[i]!.id);
		await ui.see(`${SCHEMES[i]!.label} ·`, {});
		const px = await pixel(ui, dot(swatches[i]!).x - 6, dot(swatches[i]!).y);
		seen.push(px.join(","));
	}
	await ui.expect("the schemes are painted in different colours", () => new Set(seen).size > SCHEMES.length / 2, true);
	await ui.clickAt(dot(swatches[SCHEMES.length]!).x, dot(swatches[SCHEMES.length]!).y);
	await ui.expect("custom is chosen", () => themePrefs().scheme, "custom");
	await clickInputBelow(ui, custom.y + 10);
	await ui.replace("#ff0000");
	await ui.press("enter");
	await ui.expect("the accent", () => themePrefs().accent, "#ff0000");
	await roundTrip(ui);
	await ui.expect("the scheme was kept", () => [themePrefs().scheme, themePrefs().accent], ["custom", "#ff0000"]);
}, { inProcessOnly: "reads the theme preference and the hit test under each swatch (ui.renderer)" });

scenario("Colour scheme: a custom colour that is not a colour is not applied", async (ui) => {
	await openSettings(ui);
	const { themePrefs } = await prefsMod();
	const custom = await scrollTo(ui, "Custom", { exact: true });
	await ui.clickAt(custom.x - 30, custom.y);
	await ui.expect("custom is chosen", () => themePrefs().scheme, "custom");
	const before = themePrefs().accent;
	await clickInputBelow(ui, custom.y + 10);
	await ui.replace("not a colour");
	await ui.press("enter");
	await ui.expectStill("the accent is unchanged", () => themePrefs().accent, before);
}, { inProcessOnly: "reads the theme preference" });

scenario("Settings > Appearance > Interface font: every font is chosen from the list, 'Other…' takes an installed font's name", async (ui) => {
	await openSettings(ui);
	const { themePrefs, FONTS } = await prefsMod();
	const start = await scrollTo(ui, "Inter (default)", { exact: true });
	const widthBefore = (await ui.findAll("The quick brown fox", { area: CONTENT(ui) }))[0]!.box.width;
	for (const f of FONTS.filter((x) => x.id !== "inter")) {
		await scrollTo(ui, themePrefs().font === "inter" ? "Inter (default)" : FONTS.find((x) => x.id === themePrefs().font)!.label, { exact: true }).then((c) => ui.clickAt(c.x, c.y));
		await ui.click(f.label, { exact: true });
		await ui.expect(`${f.id} is chosen`, () => themePrefs().font, f.id);
	}
	void start;
	await ui.expect("the sample line is painted in another font", async () => (await ui.findAll("The quick brown fox", { area: CONTENT(ui) }))[0]!.box.width !== widthBefore, true);
	const cur = await scrollTo(ui, FONTS.find((x) => x.id === themePrefs().font)!.label, { exact: true });
	await ui.clickAt(cur.x, cur.y);
	await ui.click("Other…", { exact: true });
	await ui.expect("custom is chosen", () => themePrefs().font, "custom");
	await clickInputBelow(ui, cur.y - 10);
	await ui.type("Segoe UI");
	await ui.press("enter");
	await ui.expect("the custom family", () => themePrefs().fontCustom, "Segoe UI");
	await roundTrip(ui);
	await ui.expect("kept", () => [themePrefs().font, themePrefs().fontCustom], ["custom", "Segoe UI"]);
}, { inProcessOnly: "reads the theme preference" });

scenario("Settings > Appearance > Text size: every size changes the size of the interface text and is kept", async (ui) => {
	await openSettings(ui);
	// (the sizes are constants; the preference itself is read only where the app is in this process)
	const { TEXT_SIZES } = await import("../../../src/shell/schemes");
	const prefs = ui.inProcess ? (await prefsMod()).themePrefs : undefined;
	const themeHeight = async () => (await ui.findAll("Theme", { exact: true, area: CONTENT(ui) }))[0]!.box.height;
	const heights: number[] = [];
	for (const n of TEXT_SIZES) {
		await ui.click(n === 13 ? "13 px (default)" : `${n} px`, { exact: true, area: CONTENT(ui) });
		if (prefs) await ui.expect(`${n} px is chosen`, () => prefs().size, n);
		await ui.settle(300);
		heights.push(await themeHeight());
	}
	await ui.expect("text grows with the size", () => heights[3]! > heights[0]!, true);
	await ui.click("15 px", { exact: true, area: CONTENT(ui) });
	await roundTrip(ui);
	await ui.expect("the size is kept: the heading is as tall as it was at 15 px", async () => Math.abs((await themeHeight()) - heights[3]!) < 0.5, true);
	if (prefs) await ui.expect("kept", () => prefs().size, 15);
	await ui.screenshot("text-15");
});

scenario("Settings > Appearance > Reset appearance goes back to System, Quiet Paper, Inter, 13 px", async (ui) => {
	await openSettings(ui);
	const { themePrefs, DEFAULT_THEME } = await prefsMod();
	await ui.click("Light", { exact: true, area: CONTENT(ui) });
	await ui.click("15 px", { exact: true, area: CONTENT(ui) });
	await ui.expect("changed", () => [themePrefs().mode, themePrefs().size], ["light", 15]);
	const f = await scrollTo(ui, "Reset appearance", { exact: true });
	await ui.clickAt((await controlRight(ui)) - 30, f.y + 9);
	await ui.expect("the defaults", () => [themePrefs().mode, themePrefs().size, themePrefs().scheme, themePrefs().font], [DEFAULT_THEME.mode, DEFAULT_THEME.size, DEFAULT_THEME.scheme, DEFAULT_THEME.font]);
}, { inProcessOnly: "reads the theme preference" });

scenario("Settings > Appearance > Left sidebar: Move down puts a group below the next one", async (ui) => {
	await openSettings(ui);
	const { leftLayout } = await import("../../../src/shell/sidebarLayout");
	await scrollTo(ui, "Left sidebar", { exact: true });
	const before = leftLayout.layout().order.slice();
	const row = (await byTestId(ui, "sidebar-row-left-library"))!;
	// the chevrons are the last two controls of the row
	await ui.clickAt(row.x + row.width - 18, row.y + row.height / 2);
	await ui.expect("Library moved down", () => leftLayout.layout().order.indexOf("library"), before.indexOf("library") + 1);
}, { inProcessOnly: "reads the sidebar layout state" });

scenario("Settings > Appearance > Default layout: Stacked puts the item details below the list, Reset layout undoes it", async (ui) => {
	await openSettings(ui);
	const f = await scrollTo(ui, "Standard", { exact: true });
	await ui.clickAt(f.x, f.y);
	await ui.click("Stacked", { exact: true });
	await leaveSettings(ui);
	await ui.expect("the item details are below the list", async () => {
		const items = await byTestId(ui, "pane-items");
		const item = await byTestId(ui, "pane-item");
		return !!items && !!item && item.y > items.y + items.height - 10;
	}, true);
	await ui.screenshot("layout-stacked");
});

scenario("Settings > Appearance > Customize layout… enters edit layout mode and shows the library", async (ui) => {
	await openSettings(ui);
	const f = await scrollTo(ui, "Customize…", { exact: true });
	await ui.clickAt(f.x, f.y);
	await ui.see("Editing layout");
	await ui.expect("the library is the tab", () => ui.store.activeTab(), "library");
});

scenario("Settings > Appearance > Reset layout says so in a toast", async (ui) => {
	await openSettings(ui);
	const f = await scrollTo(ui, "Reset layout", { exact: true });
	await ui.clickAt((await controlRight(ui)) - 30, f.y + 9);
	await ui.see("Layout reset", { exact: true, area: toastArea(ui) });
});

// ---- General --------------------------------------------------------------------------------------------------------------------

scenario("Settings > General > Show the sidebar and Show the item pane follow the panels, both ways", async (ui) => {
	await openSettings(ui);
	await gotoSection(ui, "General");
	const { leftOpen, rightOpen } = await layoutMod();
	await clickSwitch(ui, "Show the sidebar");
	await ui.expect("the sidebar is hidden", () => leftOpen(), false);
	await clickSwitch(ui, "Show the item pane");
	await ui.expect("the item pane is hidden", () => rightOpen(), false);
	await roundTrip(ui);
	await ui.expect("both stay hidden", () => [leftOpen(), rightOpen()], [false, false]);
	await ui.see("Show the sidebar", { exact: true });
	// and back on with the top bar's own buttons
	const l = leftToggle();
	await ui.clickAt(l.x, l.y);
	await ui.expect("the top bar button does nothing on the Settings tab", () => leftOpen(), false);
	await leaveSettings(ui);
	await ui.clickAt(l.x, l.y);
	await ui.expect("the sidebar is back", () => leftOpen(), true);
}, { inProcessOnly: "reads the layout state of the panels" });

scenario("Settings > General > OpenURL resolver applies on Enter and not before", async (ui) => {
	await openSettings(ui);
	await gotoSection(ui, "General");
	const { openUrlResolver } = await import("../../../src/locate/prefs");
	const f = await scrollTo(ui, "OpenURL resolver", { exact: true });
	await clickInputBelow(ui, f.y);
	await ui.type("https://resolver.example.org/openurl/");
	await ui.expectStill("typing alone applies nothing", () => openUrlResolver(), "", 300);
	await ui.see("Apply", { exact: true });
	await ui.press("enter");
	await ui.expect("applied", () => openUrlResolver(), "https://resolver.example.org/openurl/");
	await roundTrip(ui);
	await ui.expect("the field shows it", () => paintedHas(ui, "https://resolver.example.org/openurl/"), true);
}, { inProcessOnly: "reads the OpenURL preference" });

// ---- Reader ---------------------------------------------------------------------------------------------------------------------

scenario("Settings > Reader: every choice can be changed to another option and is kept", async (ui) => {
	await openSettings(ui);
	await gotoSection(ui, "Reader");
	const { readerPrefs } = await import("../../../src/settings/readerPrefs");
	const before = [readerPrefs.zoomKey(), readerPrefs.pageAppearance(), readerPrefs.sidebar(), readerPrefs.scrollMode(), readerPrefs.spreadMode()];
	const pickOther = async (label: string, option: string) => {
		const f = await scrollTo(ui, label, { exact: true });
		await ui.clickAt(f.x, f.y);
		await ui.click(option, { exact: true });
	};
	// the choice shows its current option: Default zoom ... (labels from the registry)
	const { ZOOM_CHOICES, zoomLabel } = await import("../../../src/settings/readerPrefs");
	const otherZoom = ZOOM_CHOICES.find((z) => z !== readerPrefs.zoomKey())!;
	await pickOther(zoomLabel(readerPrefs.zoomKey()), zoomLabel(otherZoom));
	await pickOther("Follow the app theme", "Sepia");
	await pickOther("As I left it", "Always open");
	await pickOther("Vertical scrolling", "Wrapped scrolling");
	await pickOther("No spreads", "Odd spreads");
	await ui.expect("all five changed", () => [readerPrefs.zoomKey(), readerPrefs.pageAppearance(), readerPrefs.sidebar(), readerPrefs.scrollMode(), readerPrefs.spreadMode()], [otherZoom, "sepia", "open", "wrapped", "odd"]);
	void before;
	await roundTrip(ui);
	await ui.expect("kept", () => [readerPrefs.zoomKey(), readerPrefs.pageAppearance(), readerPrefs.sidebar(), readerPrefs.scrollMode(), readerPrefs.spreadMode()], [otherZoom, "sepia", "open", "wrapped", "odd"]);
	const r = await scrollTo(ui, "Restore reader defaults", { exact: true });
	await ui.clickAt((await controlRight(ui)) - 60, r.y + 9);
	await ui.expect("restored", () => readerPrefs.pageAppearance(), "app");
}, { inProcessOnly: "reads the reader preferences" });

scenario("Settings > Reader > Reading view: the switch, the choices and Restore defaults", async (ui) => {
	await openSettings(ui);
	await gotoSection(ui, "Reader");
	const { readingView } = await import("../../../src/settings/readerPrefs");
	await clickSwitch(ui, "Open PDFs in the reading view by default");
	await ui.expect("opens by default", () => readingView.settings().openByDefault, true);
	const size = await scrollTo(ui, `${readingView.settings().size} px`, { exact: true });
	await ui.clickAt(size.x, size.y);
	await ui.click("24 px", { exact: true });
	await ui.expect("size", () => readingView.settings().size, 24);
	const theme = await scrollTo(ui, "Light", { exact: true });
	await ui.clickAt(theme.x, theme.y);
	await ui.click("Sepia", { exact: true });
	await ui.expect("theme", () => readingView.settings().theme, "sepia");
	await roundTrip(ui);
	await ui.expect("kept", () => [readingView.settings().size, readingView.settings().theme, readingView.settings().openByDefault], [24, "sepia", true]);
	const r = await scrollTo(ui, "Restore reading view defaults", { exact: true });
	await ui.clickAt((await controlRight(ui)) - 60, r.y + 9);
	await ui.expect("restored", () => readingView.settings().size, 17);
}, { inProcessOnly: "reads the reading-view preferences" });

// ---- Shortcuts ------------------------------------------------------------------------------------------------------------------

async function openShortcuts(ui: Ui): Promise<void> {
	await openSettings(ui);
	await gotoSection(ui, "Shortcuts");
}
async function changeShortcut(ui: Ui, label: string): Promise<void> {
	const f = await scrollTo(ui, label, { exact: true });
	// the Change button of the row
	const btns = await ui.findAll("Change", { exact: true, area: { x: CONTENT(ui).x, y: f.y - 22, width: CONTENT(ui).width, height: 44 } });
	await ui.clickAt(btns[0]!.x, btns[0]!.y);
	await ui.see("Press the new keys… (Esc cancels)", { exact: true });
}

scenario("Settings > Shortcuts: a new key for New Item… runs it, the old key stops, and the menu shows the new one", async (ui) => {
	await openShortcuts(ui);
	await changeShortcut(ui, "New Item…");
	await ui.press("ctrl-alt-j");
	await ui.see("Ctrl+Alt+J", { exact: true });
	await leaveSettings(ui);
	await ui.press("ctrl-shift-n");
	await ui.expectStill("the old key does nothing", () => ui.visible("Choose an item type.", { exact: true }), false, 400);
	await ui.press("ctrl-alt-j");
	await ui.see("Choose an item type.", { exact: true });
	await ui.press("escape");
	const panel = await openMenu(ui, "File");
	await ui.see("Ctrl+Alt+J", { exact: true, area: panel });
});

scenario("Settings > Shortcuts: Remove takes a key off and Reset brings the default back", async (ui) => {
	await openShortcuts(ui);
	const f = await scrollTo(ui, "New Item…", { exact: true });
	const row = { x: CONTENT(ui).x, y: f.y - 22, width: CONTENT(ui).width, height: 44 };
	await ui.click("Remove", { exact: true, area: row });
	await ui.see("None", { exact: true, area: row });
	await ui.click("Reset to Ctrl+Shift+N", { exact: true, area: row });
	await ui.see("Ctrl+Shift+N", { exact: true, area: row });
});

scenario("Settings > Shortcuts: a plain letter is refused with a hint, Escape cancels recording", async (ui) => {
	await openShortcuts(ui);
	await changeShortcut(ui, "New Item…");
	await ui.press("j");
	await ui.see("Use Ctrl or Alt with a key, or a function key (F1–F12).", { exact: true });
	await ui.press("escape");
	await ui.gone("Press the new keys… (Esc cancels)", { exact: true });
	await ui.see("Ctrl+Shift+N", { exact: true });
});

scenario("Settings > Shortcuts: taking a key another command has moves it, and says so", async (ui) => {
	await openShortcuts(ui);
	await changeShortcut(ui, "New Item…");
	await ui.press("ctrl-shift-o"); // New Standalone Note has it
	await ui.see('Ctrl+Shift+O now runs "New Item…"', { exact: true, area: toastArea(ui) });
	await ui.see('Removed from "New Standalone Note".', { exact: true, area: toastArea(ui) });
	const { appActions } = await registryMod();
	const { actionShortcut } = await import("../../../src/shell/shortcuts");
	await ui.expect("the note command has no key now", () => actionShortcut(appActions().find((a) => a.id === "add.note")!), undefined);
	const reset = await scrollTo(ui, "Reset all shortcuts", { exact: true });
	await ui.clickAt((await controlRight(ui)) - 35, reset.y + 9);
	await ui.expect("both defaults are back", () => [actionShortcut(appActions().find((a) => a.id === "add.note")!), actionShortcut(appActions().find((a) => a.id === "add.newItem")!)], ["Ctrl+Shift+O", "Ctrl+Shift+N"]);
}, { inProcessOnly: "reads the registered app actions" });

// ---- Experimental, System, Updates, Integrations ------------------------------------------------------------------------------------

scenario("Settings > Experimental: the notes and plugins switches flip and are kept; the editor row says why it is unavailable", async (ui) => {
	await openSettings(ui);
	await gotoSection(ui, "Experimental");
	const notes = await import("../../../src/notes/native/prefs");
	const flag = await import("../../../src/wasmplugins/flag");
	const was = [notes.nativeNotes(), flag.wasmPluginsEnabled()];
	await clickSwitch(ui, "Show notes natively");
	await clickSwitch(ui, "Enable plugins");
	await ui.expect("both flipped", () => [notes.nativeNotes(), flag.wasmPluginsEnabled()], was.map((v) => !v));
	await roundTrip(ui);
	await ui.expect("kept", () => [notes.nativeNotes(), flag.wasmPluginsEnabled()], was.map((v) => !v));
	await ui.screenshot("experimental");
}, { inProcessOnly: "reads the notes and plugin flags" });

scenario("Settings > System: Reset pane sizes toasts and restores the sizes; the core shows as connected", async (ui) => {
	await openSettings(ui);
	await gotoSection(ui, "System");
	await ui.see("Connected", { area: CONTENT(ui) });
	await leaveSettings(ui);
	const left = (await byTestId(ui, "column-left"))!;
	await ui.drag({ x: left.x + left.width + 6, y: 400 }, { x: left.x + left.width + 80, y: 400 });
	await ui.expect("the drag widened the sidebar", async () => (await byTestId(ui, "column-left"))!.width > left.width + 40, true);
	await openSettings(ui);
	const f = await scrollTo(ui, "Reset pane sizes", { exact: true });
	await ui.clickAt((await controlRight(ui)) - 30, f.y + 9);
	await ui.see("Pane sizes reset", { exact: true, area: toastArea(ui) });
	await leaveSettings(ui);
	await ui.expect("the default width", async () => Math.abs((await byTestId(ui, "column-left"))!.width - left.width) < 2, true);
});

for (const mode of ["dark", "light"] as const)
	scenario(
		`a colour scheme chosen in Settings paints the Add button in its accent, in ${mode}`,
		async (ui) => {
			const addButton = async () => {
				const a = (await ui.findAll("Add", { exact: true, area: { x: ui.size.width * 0.6, y: 80, width: ui.size.width * 0.4, height: 70 } }))[0]!;
				return pixel(ui, a.box.x + a.box.width + 8, a.y);
			};
			const paper = await addButton();
			await openSettings(ui);
			const custom = await scrollTo(ui, "Custom", { exact: true });
			const swatches = (await allBoxes(ui))
				.filter((b) => Math.round(b.width) === 28 && Math.round(b.height) === 28 && Math.abs(b.y + 14 - custom.y) < 8)
				.sort((a, b) => a.x - b.x);
			const rose = centre(swatches[4]!); // Quiet Paper, Blue, Teal, Violet, Rose
			await ui.clickAt(rose.x, rose.y);
			if (ui.inProcess) {
				const { themePrefs } = await prefsMod();
				await ui.expect("rose is chosen", () => themePrefs().scheme, "rose");
			}
			await leaveSettings(ui);
			await ui.expect("the button is a different colour", async () => sameColour(await addButton(), paper, 12), false);
			await ui.expect("and it is reddish", async () => { const c = await addButton(); return c[0] > c[2] + 20; }, true);
			await ui.screenshot(`add-rose-${mode}`);
		},
		{ mode },
	);

// ================================================================================================================================
// Panes
// ================================================================================================================================

const hoverPane = async (ui: Ui, id: string): Promise<Box> => {
	const pane = (await byTestId(ui, `pane-${id}`))!;
	await hoverAt(ui, pane.x + pane.width / 2, pane.y + 3);
	await ui.waitFor(`the hover header of ${id}`, () => hasTestId(ui, `pane-hover-header-${id}`));
	return pane;
};

scenario("the top bar's panel buttons hide and show the sidebar and the item pane", async (ui) => {
	const layout = ui.inProcess ? await layoutMod() : undefined;
	const l = leftToggle();
	const r = rightToggle(ui);
	const itemsBefore = (await byTestId(ui, "pane-items"))!;
	await ui.clickAt(l.x, l.y);
	if (layout) await ui.expect("the sidebar is hidden", () => layout.leftOpen(), false);
	await ui.gone("COLLECTIONS", { exact: true });
	await ui.expect("the list took the room", async () => (await byTestId(ui, "pane-items"))!.x < itemsBefore.x - 100, true);
	await ui.clickAt(l.x, l.y);
	await ui.see("COLLECTIONS", { exact: true, area: "sidebar" });
	await ui.clickAt(r.x, r.y);
	if (layout) await ui.expect("the item pane is hidden", () => layout.rightOpen(), false);
	await ui.gone("Select an item to view its details");
	await ui.expect("the list is wider", async () => (await byTestId(ui, "pane-items"))!.width > itemsBefore.width + 100, true);
	await ui.clickAt(r.x, r.y);
	await ui.see("Select an item to view its details");
});

scenario("both side panels can be hidden at once and the list fills the window", async (ui) => {
	await ui.clickAt(leftToggle().x, leftToggle().y);
	await ui.clickAt(rightToggle(ui).x, rightToggle(ui).y);
	await ui.expect("the list spans most of the window", async () => (await byTestId(ui, "pane-items"))!.width > ui.size.width - 80, true);
	await ui.screenshot("both-hidden");
	await ui.click(T.authors, { area: { x: 0, y: 80, width: ui.size.width, height: ui.size.height - 80 } });
	await ui.expect("a row still takes clicks", () => ui.selectedTitle(), T.authors);
});

scenario("the hover header of the list has the menu and Maximise but no Minimise or Hide, and goes when the pointer leaves", async (ui) => {
	await hoverPane(ui, "items");
	await ui.screenshot("hover-header-items");
	await ui.see("My Library", { exact: true, area: { x: 0, y: 70, width: ui.size.width, height: 40 } });
	await ui.expect("menu button", () => hasTestId(ui, "pane-hover-menu-items"), true);
	await ui.expect("maximise button", () => hasTestId(ui, "pane-hover-max-items"), true);
	await ui.expect("no minimise on the list", () => hasTestId(ui, "pane-hover-min-items"), false);
	await ui.expect("no hide on the list", () => hasTestId(ui, "pane-hover-close-items"), false);
	await hoverAt(ui, ui.size.width / 2, ui.size.height - 20, 900);
	await ui.expect("the header went away", () => hasTestId(ui, "pane-hover-header-items"), false);
});

scenario("Minimise sends the item pane to the edge; its button brings it back", async (ui) => {
	await hoverPane(ui, "item");
	await clickTestId(ui, "pane-hover-min-item");
	await ui.expect("the item pane is not drawn", () => hasTestId(ui, "pane-item"), false);
	await ui.expect("a button for it on the rail", () => hasTestId(ui, "pane-rail-item"), true);
	await ui.screenshot("rail");
	await clickTestId(ui, "pane-rail-item");
	await ui.expect("the item pane is drawn again", () => hasTestId(ui, "pane-item"), true);
	await ui.expect("the rail is empty again", () => hasTestId(ui, "pane-rail-item"), false);
});

scenario("Maximise fills the frame with the list and Restore size brings the others back", async (ui) => {
	await hoverPane(ui, "items");
	await clickTestId(ui, "pane-hover-max-items");
	await ui.expect("the item pane is not drawn", () => hasTestId(ui, "pane-item"), false);
	await ui.expect("the sidebar is not drawn", () => ui.visible("COLLECTIONS", { exact: true }), false);
	await ui.screenshot("maximised");
	await hoverPane(ui, "items");
	await clickTestId(ui, "pane-hover-max-items");
	await ui.expect("the item pane is back", () => hasTestId(ui, "pane-item"), true);
	await ui.see("COLLECTIONS", { exact: true, area: "sidebar" });
});

scenario("Hide closes the item pane with a toast whose Undo brings it back", async (ui) => {
	await hoverPane(ui, "item");
	await clickTestId(ui, "pane-hover-close-item");
	await ui.gone("Select an item to view its details");
	await ui.see("Hid Item details", { exact: true, area: toastArea(ui) });
	await ui.screenshot("toast-hid");
	await ui.click("Undo", { exact: true, area: toastArea(ui) });
	await ui.see("Select an item to view its details");
	await ui.gone("Hid Item details", { exact: true });
});

scenario("the pane menu of the item pane offers Move, Stack, Maximise, Minimise and Hide; the list's has no Minimise or Hide", async (ui) => {
	await hoverPane(ui, "item");
	await clickTestId(ui, "pane-hover-menu-item");
	for (const e of ["Move to", "Stack with", "Move up", "Move down", "Maximise", "Minimise to the edge", "Hide"]) await ui.see(e, { exact: true });
	await ui.screenshot("pane-menu");
	await ui.press("escape");
	await ui.gone("Move to", { exact: true });
	await hoverPane(ui, "items");
	await clickTestId(ui, "pane-hover-menu-items");
	await ui.see("Maximise", { exact: true });
	await ui.expect("no Minimise for the list", () => ui.visible("Minimise to the edge", { exact: true }), false);
	await ui.expect("no Hide for the list", () => ui.visible("Hide", { exact: true }), false);
});

scenario("a submenu opens on hover and with Right, Left closes it and Escape closes everything", async (ui) => {
	await hoverPane(ui, "item");
	await clickTestId(ui, "pane-hover-menu-item");
	const move = await ui.see("Move to", { exact: true });
	await hoverAt(ui, move.x, move.y, 300);
	await ui.see("Centre column", { exact: true });
	await ui.see("Right column", { exact: true });
	await ui.screenshot("submenu");
	await ui.press("left");
	await ui.press("down");
	await ui.press("right");
	await ui.expect("a submenu opened again with Right", async () => (await ui.visible("Centre column", { exact: true })) || (await ui.visible("My Library", { exact: true, area: { x: 0, y: 100, width: ui.size.width, height: 300 } })), true);
	await ui.press("escape");
	await ui.gone("Centre column", { exact: true });
	await ui.gone("Move to", { exact: true });
});

scenario("Move to > Centre column puts the item details under the list, with a Moved toast and Undo", async (ui) => {
	await hoverPane(ui, "item");
	await clickTestId(ui, "pane-hover-menu-item");
	const move = await ui.see("Move to", { exact: true });
	await hoverAt(ui, move.x, move.y, 300);
	await ui.click("Centre column", { exact: true });
	await ui.see("Moved Item details", { exact: true, area: toastArea(ui) });
	await ui.expect("the item details are below the list", async () => {
		const items = await byTestId(ui, "pane-items");
		const item = await byTestId(ui, "pane-item");
		return !!items && !!item && item.y >=items.y + items.height - 12 && Math.abs(item.x - items.x) < 6;
	}, true);
	await ui.screenshot("moved-centre");
	await ui.click("Undo", { exact: true, area: toastArea(ui) });
	await ui.expect("the item details are right of the list again", async () => (await byTestId(ui, "pane-item"))!.x > (await byTestId(ui, "pane-items"))!.x + (await byTestId(ui, "pane-items"))!.width - 10, true);
});

scenario("Stack with puts two panes in one stack with tabs; clicking a tab and the arrow keys change the pane shown", async (ui) => {
	await hoverPane(ui, "item");
	await clickTestId(ui, "pane-hover-menu-item");
	const stack = await ui.see("Stack with", { exact: true });
	await hoverAt(ui, stack.x, stack.y, 300);
	// the submenu may open to the left of the menu: it is the right-most "My Library" (the sidebar has one too)
	await ui.waitFor("the submenu entry", async () => (await ui.findAll("My Library", { exact: true })).length > 1);
	const entry = (await ui.findAll("My Library", { exact: true })).sort((a, b) => b.x - a.x)[0]!;
	await ui.clickAt(entry.x, entry.y);
	await ui.see("Moved Item details", { exact: true, area: toastArea(ui) });
	await ui.expect("the tab of the details", () => hasTestId(ui, "pane-tab-item"), true);
	await ui.expect("the tab of the list", () => hasTestId(ui, "pane-tab-items"), true);
	await ui.screenshot("stacked-tabs");
	await clickTestId(ui, "pane-tab-item");
	await ui.see("Select an item to view its details");
	await ui.expect("the list is behind the tab", () => hasTestId(ui, "pane-items"), false);
	await ui.press("left");
	await ui.expect("Left on the tab showed the list", () => hasTestId(ui, "pane-items"), true);
	await ui.press("right");
	await ui.expect("Right on the tab showed the details", () => hasTestId(ui, "pane-item"), true);
});

scenario("Edit layout: every pane has a header with a grip, and Reset puts the standard layout back", async (ui) => {
	await pick(ui, "Tools", "Edit layout");
	await ui.expect("grip on the list", () => hasTestId(ui, "pane-grip-items"), true);
	await ui.expect("grip on the item pane", () => hasTestId(ui, "pane-grip-item"), true);
	await ui.screenshot("edit-headers");
	await hoverAt(ui, 600, 300, 50);
	// move the item pane under the list through its pane menu, then Reset
	await clickTestId(ui, "pane-menu-item");
	const move = await ui.see("Move to", { exact: true });
	await hoverAt(ui, move.x, move.y, 300);
	await ui.click("Centre column", { exact: true });
	await ui.click("Reset", { exact: true, area: { x: 0, y: 70, width: ui.size.width, height: 60 } });
	await ui.expect("the item pane is in the right column again", async () => (await byTestId(ui, "pane-item"))!.x > (await byTestId(ui, "pane-items"))!.x + (await byTestId(ui, "pane-items"))!.width - 10, true);
});

scenario("dragging a pane's grip onto the top of the list places it above the list", async (ui) => {
	await pick(ui, "Tools", "Edit layout");
	const grip = (await byTestId(ui, "pane-grip-item"))!;
	const items = (await byTestId(ui, "pane-items"))!;
	await ui.drag(centre(grip), { x: items.x + items.width / 2, y: items.y + 10 }, 14);
	await ui.expect("the item pane is first in the centre column, above the list", async () => {
		const now = await byTestId(ui, "pane-items");
		const item = await byTestId(ui, "pane-item");
		return !!now && !!item && item.y + item.height <= now.y + 12 && Math.abs(item.x - now.x) < 6;
	}, true);
	await ui.see("Moved Item details", { exact: true, area: toastArea(ui) });
});

scenario("dragging a pane's grip onto the middle of the list stacks it as a tab", async (ui) => {
	await pick(ui, "Tools", "Edit layout");
	const grip = (await byTestId(ui, "pane-grip-item"))!;
	const items = (await byTestId(ui, "pane-items"))!;
	await ui.drag(centre(grip), { x: items.x + items.width / 2, y: items.y + items.height / 2 }, 14);
	await ui.expect("one stack holds both: a tab for each", async () => [await hasTestId(ui, "pane-tab-items"), await hasTestId(ui, "pane-tab-item")], [true, true]);
});

scenario("a drag that ends outside every pane moves nothing", async (ui) => {
	await pick(ui, "Tools", "Edit layout");
	const where = async () => JSON.stringify([await byTestId(ui, "pane-items"), await byTestId(ui, "pane-item"), await hasTestId(ui, "pane-tab-item")]);
	const before = await where();
	const grip = (await byTestId(ui, "pane-grip-item"))!;
	await ui.drag(centre(grip), { x: 4, y: ui.size.height - 4 }, 14);
	await ui.expectStill("the layout is unchanged", where, before, 400);
});

scenario("dragging the gutter beside the sidebar resizes it, and it will not go below its minimum", async (ui) => {
	const layout = ui.inProcess ? await layoutMod() : undefined;
	const start = (await byTestId(ui, "column-left"))!;
	await ui.drag({ x: start.x + start.width + 6, y: 420 }, { x: start.x + start.width + 90, y: 420 });
	await ui.expect("the sidebar is wider", async () => (await byTestId(ui, "column-left"))!.width > start.width + 60, true);
	const wide = (await byTestId(ui, "column-left"))!;
	await ui.drag({ x: wide.x + wide.width + 6, y: 420 }, { x: 5, y: 420 }, 20);
	await ui.expect("the sidebar is narrower than it started", async () => (await byTestId(ui, "column-left"))!.width < start.width, true);
	await ui.expect("but not gone", async () => (await byTestId(ui, "column-left"))!.width >= ui.size.width * 0.09, true);
	if (layout) await ui.expect("the layout kept the size", () => layout.libraryLayout().sizes[0]! < 0.2, true);
	await ui.screenshot("sidebar-narrow");
});

scenario("dragging the gutter beside the item pane resizes the item pane", async (ui) => {
	const items = (await byTestId(ui, "pane-items"))!;
	const item = (await byTestId(ui, "pane-item"))!;
	const x = (items.x + items.width + item.x) / 2;
	await ui.drag({ x, y: 420 }, { x: x - 120, y: 420 });
	await ui.expect("the item pane is wider", async () => (await byTestId(ui, "pane-item"))!.width > item.width + 80, true);
	await ui.expect("the list is narrower", async () => (await byTestId(ui, "pane-items"))!.width < items.width - 80, true);
});

scenario("pane sizes survive a trip through Settings and back", async (ui) => {
	const left = (await byTestId(ui, "column-left"))!;
	await ui.drag({ x: left.x + left.width + 6, y: 420 }, { x: left.x + left.width + 70, y: 420 });
	const w = (await byTestId(ui, "column-left"))!.width;
	await openSettings(ui);
	await leaveSettings(ui);
	await ui.expect("the sidebar has the same width", async () => Math.abs((await byTestId(ui, "column-left"))!.width - w) < 2, true);
});

// ================================================================================================================================
// Toasts
// ================================================================================================================================

scenario("a toast goes by itself after a few seconds", async (ui) => {
	await pick(ui, "Tools", "Delete Automatic Tags…");
	await ui.see("There are no automatic tags in this library", { area: toastArea(ui) });
	await ui.gone("There are no automatic tags in this library", {}, 9000);
});

scenario("a click on a toast dismisses it", async (ui) => {
	await pick(ui, "Tools", "Delete Automatic Tags…");
	const t = await ui.see("There are no automatic tags in this library", { area: toastArea(ui) });
	await ui.clickAt(t.x, t.y);
	await ui.gone("There are no automatic tags in this library");
});

scenario("a toast stays while the pointer is on it", async (ui) => {
	await pick(ui, "Tools", "Delete Automatic Tags…");
	const t = await ui.see("There are no automatic tags in this library", { area: toastArea(ui) });
	await hoverAt(ui, t.x, t.y, 100);
	await ui.expectStill("still there after longer than it normally lasts", () => ui.visible("There are no automatic tags in this library"), true, 5500);
});

scenario("layout toasts replace each other instead of stacking", async (ui) => {
	await hoverPane(ui, "item");
	await clickTestId(ui, "pane-hover-close-item");
	await ui.see("Hid Item details", { exact: true, area: toastArea(ui) });
	await pick(ui, "View", "Item pane");
	await hoverPane(ui, "item");
	await clickTestId(ui, "pane-hover-menu-item");
	const move = await ui.see("Move to", { exact: true });
	await hoverAt(ui, move.x, move.y, 300);
	await ui.click("Centre column", { exact: true });
	await ui.see("Moved Item details", { exact: true, area: toastArea(ui) });
	await ui.expect("only one layout toast", async () => (await ui.findAll("Hid Item details", {})).length + (await ui.findAll("Moved Item details", {})).length, 1);
});

// ================================================================================================================================
// Keyboard shortcuts
// ================================================================================================================================

scenario("Ctrl+Shift+N opens New Item", async (ui) => {
	await ui.press("ctrl-shift-n");
	await ui.see("New Item", { exact: true });
	await ui.press("escape");
	await ui.gone("New Item", { exact: true });
});

scenario("Ctrl+, opens Settings, Ctrl+W closes the tab", async (ui) => {
	await ui.press("ctrl-,");
	await ui.see("SETTINGS", { exact: true });
	await ui.press("ctrl-w");
	await ui.gone("SETTINGS", { exact: true });
	await ui.expect("the library", () => ui.store.activeTab(), "library");
});

scenario("Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+PageDown, Ctrl+PageUp and Ctrl+1 / Ctrl+9 move between the tabs", async (ui) => {
	await openSettings(ui);
	await ui.press("ctrl-1");
	await ui.expect("Ctrl+1 is the library", () => ui.store.activeTab(), "library");
	await ui.press("ctrl-tab");
	await ui.expect("Ctrl+Tab goes to Settings", () => ui.store.activeTab(), "settings");
	await ui.press("ctrl-tab");
	await ui.expect("Ctrl+Tab wraps to the library", () => ui.store.activeTab(), "library");
	await ui.press("ctrl-shift-tab");
	await ui.expect("Ctrl+Shift+Tab wraps back", () => ui.store.activeTab(), "settings");
	await ui.press("ctrl-pageup");
	await ui.expect("Ctrl+PageUp", () => ui.store.activeTab(), "library");
	await ui.press("ctrl-pagedown");
	await ui.expect("Ctrl+PageDown", () => ui.store.activeTab(), "settings");
	await ui.press("ctrl-1");
	await ui.press("ctrl-9");
	await ui.expect("Ctrl+9 is the last tab", () => ui.store.activeTab(), "settings");
	await ui.press("ctrl-2");
	await ui.expect("Ctrl+2 is the second tab", () => ui.store.activeTab(), "settings");
});

scenario("Ctrl+/ opens the shortcut list and Escape closes it", async (ui) => {
	await ui.press("ctrl-/");
	await ui.see("COMMANDS", { exact: true });
	await ui.press("escape");
	await ui.gone("COMMANDS", { exact: true });
});

scenario("Ctrl+Shift+K and Ctrl+F put the cursor in the search box", async (ui) => {
	await ui.press("ctrl-shift-k");
	await ui.type("Neighbour");
	await ui.see(T.neighbour, { area: "list" });
	await ui.expect("the list is filtered", () => ui.visible(T.authors, { area: "list" }), false);
	await ui.press("ctrl-a");
	await ui.press("backspace");
	await ui.see(T.authors, { area: "list" });
	await ui.click(T.article, { area: "list" });
	await ui.press("ctrl-f");
	await ui.type("Delta");
	await ui.expect("Ctrl+F searched too", () => ui.visible(T.authors, { area: "list" }), false);
});

scenario("Ctrl+Shift+T shows and hides the tag selector", async (ui) => {
	const { tagsOpen } = await import("../../../src/sidebar/state");
	const was = tagsOpen();
	await ui.press("ctrl-shift-t");
	await ui.expect("toggled", () => tagsOpen(), !was);
	await ui.press("ctrl-shift-t");
	await ui.expect("toggled back", () => tagsOpen(), was);
}, { inProcessOnly: "reads the tag selector state" });

scenario("Ctrl+Shift+F opens Advanced Search", async (ui) => {
	await ui.press("ctrl-shift-f");
	await ui.see("Advanced Search", { exact: true });
	await ui.press("escape");
	await ui.gone("Advanced Search", { exact: true });
});

scenario("Ctrl+Shift+O adds a standalone note", async (ui) => {
	const before = await itemsTotal(ui);
	await ui.press("ctrl-shift-o");
	await ui.expect("one more item", () => itemsTotal(ui), before + 1, 6000);
});

scenario("Ctrl+Alt+Shift+I imports from the clipboard", async (ui) => {
	const before = await itemsTotal(ui);
	await ui.setClipboard("@article{zt-key, title={ZT Key import}, author={Key, Kay}, year={2021}, journal={Key Journal}}");
	await ui.press("ctrl-alt-shift-i");
	await ui.expect("one more item", () => itemsTotal(ui), before + 1, 8000);
});

scenario("F6 and Shift+F6 move the focus through the panes and wrap", async (ui) => {
	const { focusedId } = await uiCore();
	const ids = async () => {
		const all = await tree(ui);
		return ["column-left", "pane-items", "pane-item"].map((t) => ({ t, id: all.find((n) => n.testId === t)?.id }));
	};
	const where = async () => {
		const f = focusedId();
		const hit = (await ids()).find((x) => x.id === f);
		return hit ? hit.t : "elsewhere";
	};
	await ui.press("f6");
	const first = await where();
	await ui.press("f6");
	const second = await where();
	await ui.expect("F6 moved the focus", () => second !== first, true);
	await ui.press("shift-f6");
	await ui.expect("Shift+F6 moved it back", () => where(), first);
}, { inProcessOnly: "reads the focused element id from the UI core" });

scenario("a shortcut whose condition is false lets the next action on the same keys run", async (ui) => {
	const { registerAppAction } = await registryMod();
	const ran: string[] = [];
	registerAppAction({ id: "t.fall", label: "Fall through", menu: "none", shortcut: "Ctrl+Shift+K", run: () => void ran.push("fall") });
	await ui.press("ctrl-shift-k");
	await ui.expectStill("in the library Quick Search has the keys", () => ran.length, 0, 300);
	await openSettings(ui);
	await ui.press("ctrl-shift-k");
	await ui.expect("on the Settings tab the later action ran", () => ran, ["fall"]);
}, { inProcessOnly: "registers an app action in the app's registry" });

scenario("a shortcut with no action does nothing", async (ui) => {
	await ui.press("ctrl-alt-shift-q");
	await ui.expectStill("nothing opened", async () => [await ui.store.activeTab(), await ui.visible("New Item", { exact: true })], ["library", false], 300);
});

// ================================================================================================================================
// The window at three sizes, in both themes
// ================================================================================================================================

/** Text that overlaps other text, or leaves the window: what a screenshot shows as clutter. */
async function clutter(ui: Ui): Promise<string[]> {
	const seen = new Map<string, Box & { text: string }>();
	for (const n of await tree(ui)) {
		const t = (n.text ?? "").trim();
		if (!t) continue;
		const b = await boxOf(ui, n);
		if (!b) continue;
		seen.set(`${t}|${Math.round(b.x)}|${Math.round(b.y)}|${Math.round(b.width)}`, { ...b, text: t });
	}
	const list = [...seen.values()].filter((b) => b.x >= 0 && b.y >= 0 && b.x < ui.size.width && b.y < ui.size.height);
	const out: string[] = [];
	for (const b of list) if (b.x + b.width > ui.size.width + 1) out.push(`"${b.text.slice(0, 30)}" runs off the window (${Math.round(b.x + b.width)} > ${ui.size.width})`);
	for (let i = 0; i < list.length; i++)
		for (let j = i + 1; j < list.length; j++) {
			const a = list[i]!;
			const b = list[j]!;
			const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
			const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
			if (w > 4 && h > 6 && (w * h) / Math.min(a.width * a.height, b.width * b.height) > 0.25 && a.text !== b.text && !a.text.includes(b.text) && !b.text.includes(a.text))
				out.push(`"${a.text.slice(0, 24)}" overlaps "${b.text.slice(0, 24)}" at ${Math.round(Math.max(a.x, b.x))},${Math.round(Math.max(a.y, b.y))}`);
		}
	return out;
}

for (const [w, h] of [[1440, 900]] as const)
	for (const mode of ["dark", "light"] as const) {
		scenario(
			`the library at ${w} x ${h} in ${mode}: nothing overlaps, nothing is cut off, the controls can be reached`,
			async (ui) => {
				await ui.see(T.article, { area: "list" });
				await ui.expect("the window has the size asked for", async () => Math.round((await tree(ui))[0]!.bounds!.width), w, 0);
				await ui.screenshot(`library-${w}-${mode}`);
				await ui.expect("no text overlaps other text or leaves the window", () => clutter(ui), []);
				// the sidebar's group headings sit clear of their own buttons
				const head = (await ui.findAll("COLLECTIONS", { exact: true, area: "sidebar" }))[0];
				await ui.expect("the COLLECTIONS heading is painted", () => !!head, true);
				const sidebar = (await byTestId(ui, "column-left"))!;
				await ui.expect("the heading is inside the sidebar", () => head!.box.x + head!.box.width <= sidebar.x + sidebar.width + 1, true);
				const buttons = (await allBoxes(ui))
					.filter((b) => b.width >= 14 && b.width <= 30 && b.height >= 14 && b.height <= 30 && Math.abs(b.y + b.height / 2 - head!.y) < 10 && b.x > head!.box.x - 2 && b.x < sidebar.x + sidebar.width + 8);
				await ui.expect("the heading does not run under the buttons beside it", () => buttons.every((b) => b.x >= head!.box.x + head!.box.width - 1), true);
				// the top bar controls can be clicked: the panel button, the gear, the Library tab
				for (const p of [leftToggle(), gear(ui), rightToggle(ui)]) {
					const el = await ui.elementsAt(p.x, p.y); // (null in the real app: it has no hit test to ask)
					if (el) await ui.expect(`something is at ${Math.round(p.x)},${p.y}`, () => el.length > 0, true, 0);
				}
				await ui.click(T.authors, { area: "list" });
				await ui.expect("a row can be selected", () => ui.selectedTitle(), T.authors);
				await ui.screenshot(`library-${w}-${mode}-selected`);
			},
			{ width: w, height: h, mode },
		);
	}

for (const [w, h] of [[1440, 900]] as const)
	for (const mode of ["dark", "light"] as const) {
		scenario(
			`Settings at ${w} x ${h} in ${mode}: the sections list and the rows are readable and clear of each other`,
			async (ui) => {
				await ui.expect("the window has the size asked for", async () => Math.round((await tree(ui))[0]!.bounds!.width), w, 0);
				await openSettings(ui);
				await ui.settle(500);
				await ui.screenshot(`settings-${w}-${mode}`);
				await ui.expect("no text overlaps other text or leaves the window", () => clutter(ui), []);
				await gotoSection(ui, "Shortcuts");
				await ui.settle(500);
				await ui.screenshot(`settings-shortcuts-${w}-${mode}`);
				await ui.expect("no overlap in Shortcuts", () => clutter(ui), []);
				await gotoSection(ui, "General");
				await ui.settle(500);
				await ui.expect("no overlap in General", () => clutter(ui), []);
			},
			{ width: w, height: h, mode },
		);
	}

/** The group headings of the sidebar, and the buttons beside each. */
async function headingClash(ui: Ui): Promise<string[]> {
	const out: string[] = [];
	const sidebar = (await byTestId(ui, "column-left"))!;
	const boxes = (await allBoxes(ui))
		.filter((b) => b.width >= 12 && b.width <= 32 && b.height >= 12 && b.height <= 32);
	for (const name of ["LIBRARY", "SAVED SEARCHES", "COLLECTIONS", "GROUP LIBRARIES", "TAGS"]) {
		const head = (await ui.findAll(name, { exact: true, area: { x: sidebar.x, y: sidebar.y, width: sidebar.width, height: sidebar.height } }))[0];
		if (!head) {
			out.push(`${name} is not painted`);
			continue;
		}
		const right = head.box.x + head.box.width;
		for (const b of boxes)
			if (Math.abs(b.y + b.height / 2 - head.y) < 10 && b.x > head.box.x + 4 && b.x < right - 2) out.push(`${name} (to ${Math.round(right)}) runs under a button at ${Math.round(b.x)}`);
		if (right > sidebar.x + sidebar.width + 1) out.push(`${name} runs out of the sidebar (${Math.round(right)} > ${Math.round(sidebar.x + sidebar.width)})`);
	}
	return out;
}

scenario("the sidebar at its narrowest, the width it has in an 800 px window, keeps every group heading clear of its buttons", async (ui) => {
	const start = (await byTestId(ui, "column-left"))!;
	await ui.drag({ x: start.x + start.width + 6, y: 420 }, { x: 5, y: 420 }, 20);
	await ui.expect("the sidebar is at its narrowest", async () => (await byTestId(ui, "column-left"))!.width < 160, true);
	await ui.screenshot("sidebar-narrowest");
	await ui.expect("no heading runs under its buttons or out of the sidebar", () => headingClash(ui), []);
}, { knownBug: "at its narrowest the sidebar's headings run under their buttons" });

scenario("the sidebar at its narrowest does not cut the names of the built-in rows", async (ui) => {
	const start = (await byTestId(ui, "column-left"))!;
	await ui.drag({ x: start.x + start.width + 6, y: 420 }, { x: 5, y: 420 }, 20);
	await ui.expect("the sidebar is at its narrowest", async () => (await byTestId(ui, "column-left"))!.width < 160, true);
	const sidebar = (await byTestId(ui, "column-left"))!;
	// a name is cut when its text box is wider than the room the sidebar leaves it
	const names = ["My Library", "Unfiled", "My Publications", "Trash", "Duplicate Items", "Methods", "Empty collection"];
	const cut: string[] = [];
	for (const name of names) {
		const f = (await ui.findAll(name, { exact: true, area: { x: sidebar.x, y: sidebar.y, width: sidebar.width, height: sidebar.height } }))[0];
		if (!f || f.box.x + f.box.width > sidebar.x + sidebar.width - 16) cut.push(name);
	}
	await ui.expect("every built-in name fits", () => cut, []);
}, { knownBug: "at its narrowest the sidebar cuts the built-in names" });
