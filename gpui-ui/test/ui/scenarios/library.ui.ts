// Finding and organising items: the list in both views, sorting and grouping, selection, quick and saved searches, the sidebar, the
// collections, dragging items onto them, the tag selector, and the item context menu.
import { scenario } from "../define";
import type { Ui } from "../driver";
import { T } from "../library";

type Box = { x: number; y: number; width: number; height: number };
/** The Group / Sort bar under the toolbar, and the Classic table's header row (standard 1440 x 900 window). */
const BAR: Box = { x: 265, y: 138, width: 760, height: 30 };
const HEAD: Box = { x: 265, y: 182, width: 760, height: 28 };
/** The room under the Group / Sort bar where its menus open. */
const BAR_MENU: Box = { x: 265, y: 172, width: 760, height: 700 };
const LIST: Box = { x: 265, y: 180, width: 760, height: 690 };
const COLLECTIONS_HEADER_PLUS = 210; // x of the "+" buttons that sit at the right end of a sidebar section header

// ---- reading what the app holds: the order of the list, the selection ---------------------------------------------------------------

/** The titles of the first `n` items of the list, in the list's order. */
async function listTitles(ui: Ui, n: number): Promise<string[]> {
	const out: string[] = [];
	for (let i = 0; i < Math.min(n, await ui.store.total()); i++) out.push((await ui.store.peek(i))?.title ?? "(not loaded)");
	return out;
}

/** The titles the core gives for a query, in its order: what the list must show. */
async function coreTitles(ui: Ui, query: string, n: number): Promise<string[]> {
	const r = await ui.api<{ items: { title: string }[] }>("GET", `/items?limit=${n}&${query}`);
	return r.items.map((i) => i.title);
}

/** The titles of the selected items that are loaded. */
async function selectedTitles(ui: Ui): Promise<string[]> {
	const sel = new Set(await ui.store.selected());
	const out: string[] = [];
	for (let i = 0; i < (await ui.store.total()); i++) {
		const row = (await ui.store.peek(i));
		if (row && sel.has(row.key)) out.push(row.title);
	}
	return out;
}

/** The text of the input at the point of a box (the search box, the tag filter, a dialog's field). */
async function inputBox(ui: Ui, within: Box): Promise<Box | undefined> {
	const tree = await ui.tree();
	let found: Box | undefined;
	const walk = (n: any) => {
		const b = n.bounds as Box | undefined;
		if (!found && /input/i.test(n.type) && b && b.x >= within.x && b.y >= within.y && b.x + b.width <= within.x + within.width && b.y + b.height <= within.y + within.height) found = b;
		for (const c of n.children ?? []) walk(c);
	};
	if (tree) walk(tree);
	return found;
}

async function clickInput(ui: Ui, within: Box): Promise<void> {
	await ui.waitFor("an input field on screen", async () => !!(await inputBox(ui, within)));
	const b = (await inputBox(ui, within))!;
	await ui.clickAt(b.x + b.width / 2, b.y + b.height / 2);
}

const SEARCH_BOX: Box = { x: 265, y: 80, width: 760, height: 60 };
async function search(ui: Ui, text: string): Promise<void> {
	await clickInput(ui, SEARCH_BOX);
	await ui.replace(text);
}
async function clearSearch(ui: Ui): Promise<void> {
	await clickInput(ui, SEARCH_BOX);
	await ui.press("ctrl-a");
	await ui.press("backspace");
}

/** The item titles that can be seen in the list right now (the ones this library names with a prefix we know). */
async function visibleItems(ui: Ui): Promise<string[]> {
	// read from the element tree (the real app has no painted-text call), the list's titles only
	const found = await ui.findAll("", { area: "list" });
	return [...new Set(found.map((f) => f.text.trim()).filter((t) => /^(ZT0\d|ZG0\d|ZD0\d|ZS0\d|Bulk \d{4})/.test(t)))];
}

/** Click up to `n` of the rows on screen and check that each took the click: a row that cannot be clicked is a bug. */
async function rowsTakeClicks(ui: Ui, n = 3): Promise<void> {
	// rows that lie wholly inside the list: one cut by its edge has its centre outside the list, where a click lands on something else
	const inside = async (): Promise<string[]> =>
		[...new Set((await ui.findAll("", { area: { x: 265, y: 215, width: 760, height: 600 } })).map((f) => f.text.trim()).filter((t) => /^(ZT0\d|ZG0\d|ZD0\d|Bulk \d{4})/.test(t)))];
	await ui.waitFor("two rows on screen", async () => (await inside()).length >= 2);
	const seen = (await inside()).slice(0, n + 4);
	const picks = [seen[0]!, seen[1]!, seen[Math.min(seen.length - 1, n)]!];
	for (const text of picks) {
		await ui.click(text, { area: "list", exact: true });
		const prefix = text.replace(/…$/, "");
		await ui.expect(`"${text}" is selected after the click`, async () => ((await ui.selectedTitle()) ?? "").startsWith(prefix), true);
	}
}

// ---- the sort bar and the menus ------------------------------------------------------------------------------------------------------

const DIRS = ["↓", "↑", "A–Z", "Z–A"];
/** The direction buttons of the level chips, left to right. */
const dirButtons = async (ui: Ui) => (await ui.findAll("", { area: BAR })).filter((f) => DIRS.includes(f.text.trim()));

/** Open the group menu and choose a group. */
async function groupBy(ui: Ui, label: string): Promise<void> {
	await ui.click(await groupChipLabel(ui), { area: BAR, exact: true, nth: 0 });
	await ui.see("Group by", { area: BAR_MENU, exact: true });
	await ui.click(label, { area: BAR_MENU, exact: true });
	await ui.gone("Group by", { area: BAR_MENU, exact: true });
}
const groupChipLabel = async (ui: Ui): Promise<string> => {
	const f = (await ui.findAll("", { area: { ...BAR, x: 300, width: 80 } })).find((t) => t.text.trim().length > 1);
	return f?.text.trim() ?? "Year";
};

/** The "+" of the sort bar: it has no text, it sits right of the last level chip. */
async function addLevel(ui: Ui, label: string): Promise<void> {
	const dirs = await dirButtons(ui);
	const last = dirs[dirs.length - 1]!;
	await ui.clickAt(last.x + 40, last.y);
	await ui.see("Then sort by", { exact: true });
	await ui.click(label, { area: BAR_MENU, exact: true });
}

/**
 * Click an entry of an open menu that is longer than the room it has: the menu scrolls, so wheel over it until the entry is inside.
 * (Entries that are clipped have no place on screen, as far as the app tells.)
 */
async function menuClick(ui: Ui, text: string, over: { x: number; y: number }, area?: Box): Promise<void> {
	for (let i = 0; i < 40; i++) {
		if ((await ui.findAll(text, { exact: true, area })).length) {
			try {
				await ui.click(text, { exact: true, area });
				return;
			} catch (e) {
				if (!/is covered/.test(String(e))) throw e;
			}
		}
		await ui.wheel(over.x, over.y, -250);
	}
	throw new Error(`"${text}" never came into view in the menu`);
}

/** Right-click an item and choose an entry of its menu (the menu is long: it scrolls). */
async function itemMenu(ui: Ui, title: string, entry: string): Promise<void> {
	const f = await ui.see(title, { area: "list" });
	await ui.rightClick(title, { area: "list" });
	await ui.see("Open", { exact: true });
	await menuClick(ui, entry, { x: f.x + 60, y: f.y + 120 });
}

/** Choose `label` from the menu of the sort level chip that shows `current`. */
async function changeLevel(ui: Ui, current: string, label: string): Promise<void> {
	// the level chips sit right of the group chip, which can carry the same word
	const chip = (await ui.findAll(current, { area: BAR, exact: true })).find((f) => f.x > 400);
	if (!chip) throw new Error(`no sort level chip "${current}"`);
	await ui.clickAt(chip.x, chip.y);
	await ui.see("Sort level", { area: BAR_MENU });
	await menuClick(ui, label, { x: chip.x + 40, y: chip.y + 250 }, BAR_MENU);
}

// ================================================================================================================ the two views

scenario("Classic lists the same items in columns, and rows take clicks there and back in List", async (ui) => {
	await ui.click("Classic");
	for (const h of ["Title", "Creator", "Year", "Publication", "Date Added"]) await ui.see(h, { area: HEAD, exact: true });
	await ui.see("Zinc demo", { area: "list", exact: true }); // ZT00's creator, a column of its own
	await ui.see("139 items", { exact: true });
	await rowsTakeClicks(ui);
	await ui.click("List");
	await ui.see("Find full text", { area: "list" });
	await ui.gone("Creator", { area: HEAD, exact: true });
	await rowsTakeClicks(ui);
});

scenario("the Classic table of a long list takes clicks after a scroll", async (ui) => {
	await ui.click("Classic");
	for (let i = 0; i < 10; i++) await ui.wheel(640, 500, -240); // a long run of wheel notches
	await ui.waitFor("the list moved", async () => !(await visibleItems(ui)).some((t) => t.startsWith("ZT0")));
	await rowsTakeClicks(ui);
}, { items: 300 });

// ================================================================================================================ grouping

scenario("grouping by item type puts one header per type", async (ui) => {
	await groupBy(ui, "Item type");
	await ui.see("Book", { area: LIST, exact: true });
	await ui.see("Journal Article", { area: LIST, exact: true });
	await ui.expect("one group per item type, with its size", async () => (await ui.store.groups()).map((g) => [g.value, g.count]), [["book", 1], ["journalArticle", 136], ["report", 2]]);
	await ui.expect("level 1 follows the group", async () => (await ui.store.sortLevels())[0]!.key, "itemType");
	await ui.gone("2025", { area: LIST, exact: true }); // the year headers are gone
	await ui.click(T.hebrew, { area: LIST });
	await ui.expect("the row under the new header takes the click", async () => (await ui.selectedTitle()), T.hebrew);
});

scenario("None takes every group header away and keeps the items", async (ui) => {
	await groupBy(ui, "None");
	await ui.gone("2025", { area: LIST, exact: true });
	await ui.expect("no groups", async () => (await ui.store.groups()).length, 0);
	await ui.expect("the same items", async () => (await ui.store.total()), 139);
	await ui.click(T.authors, { area: LIST });
	await ui.expect("the first row takes the click", async () => (await ui.selectedTitle()), T.authors);
});

scenario("a group header collapses its rows and opens them again, and the rows after it take clicks", async (ui) => {
	await ui.see(T.neighbour, { area: LIST });
	await ui.click("2024", { area: LIST, exact: true });
	await ui.gone(T.neighbour, { area: LIST });
	await ui.gone(T.arabic, { area: LIST });
	await ui.see("2025", { area: LIST, exact: true }); // the groups around it stay
	await ui.click("2024", { area: LIST, exact: true });
	await ui.see(T.neighbour, { area: LIST });
	await ui.see(T.arabic, { area: LIST });
	await rowsTakeClicks(ui);
});

scenario("the arrow keys skip the rows of a collapsed group", async (ui) => {
	await ui.click("2024", { area: LIST, exact: true });
	await ui.gone(T.neighbour, { area: LIST });
	await ui.click(T.authors, { area: LIST });
	await ui.press("down");
	// the next group after 2024 in the list is 2020
	await ui.expect("the item after the collapsed group is selected", async () => (await ui.selectedTitle()), T.many);
	await ui.press("up");
	await ui.expect("and the way back skips it too", async () => (await ui.selectedTitle()), T.authors);
});

// ================================================================================================================ sort levels

scenario("the first level of a grouped list is the group: no menu, but its direction flips", async (ui) => {
	const before = await listTitles(ui, 3);
	await ui.click("Year", { area: BAR, exact: true, nth: 1 }); // the chip's label
	await ui.expectStill("no level menu opened", async () => (await ui.visible("Sort level", { area: BAR_MENU })), false, 400);
	await ui.click("↓", { area: BAR, exact: true, nth: 0 });
	const wanted = await coreTitles(ui, "sort=year&dir=asc&then=dateAdded:desc", 4);
	await ui.expect("the oldest year comes first", () => listTitles(ui, 4), wanted);
	await ui.see("↑", { area: BAR, exact: true });
	if (JSON.stringify(wanted.slice(0, 3)) === JSON.stringify(before)) throw new Error("the order did not change");
	await ui.click("↑", { area: BAR, exact: true, nth: 0 });
	await ui.expect("and back", () => listTitles(ui, 3), before);
});

scenario("level 2 can be changed to another field and flipped, and the list follows the core's order", async (ui) => {
	await changeLevel(ui, "Date Added", "Title");
	await ui.see("Title", { area: BAR, exact: true });
	const asc = await coreTitles(ui, "sort=year&dir=desc&then=title:asc", 22);
	await ui.expect("year, then title A-Z", () => listTitles(ui, 22), asc);
	await rowsTakeClicks(ui);

	await ui.click("A–Z", { area: BAR, exact: true });
	const desc = await coreTitles(ui, "sort=year&dir=desc&then=title:desc", 22);
	await ui.expect("year, then title Z-A", () => listTitles(ui, 22), desc);
	await ui.see("Z–A", { area: BAR, exact: true });
	if (JSON.stringify(asc) === JSON.stringify(desc)) throw new Error("the two orders are the same: nothing to tell them apart");
	await rowsTakeClicks(ui);
});

scenario("a sort level is added from the plus, and removed from its menu", async (ui) => {
	await addLevel(ui, "Title");
	await ui.see("3", { area: BAR, exact: true });
	await ui.expect("three levels", async () => (await ui.store.sortLevels()).map((l) => l.key), ["year", "dateAdded", "title"]);

	await changeLevel(ui, "Date Added", "Remove level");
	await ui.expect("level 2 left, the one after it moved up", async () => (await ui.store.sortLevels()).map((l) => l.key), ["year", "title"]);
	await ui.gone("Date Added", { area: BAR, exact: true });
	const wanted = await coreTitles(ui, "sort=year&dir=desc&then=title:asc", 8);
	await ui.expect("the list follows", () => listTitles(ui, 8), wanted);
	await rowsTakeClicks(ui);
});

scenario("picking a field that another level already uses moves it, so no field is sorted twice", async (ui) => {
	await addLevel(ui, "Title");
	await ui.expect("three levels", async () => (await ui.store.sortLevels()).map((l) => l.key), ["year", "dateAdded", "title"]);
	// level 2 is changed to Title, which level 3 has: the old one goes, so the field is not sorted twice
	await changeLevel(ui, "Date Added", "Title");
	await ui.expect("no field twice", async () => (await ui.store.sortLevels()).map((l) => l.key), ["year", "title"]);
});

scenario("ungrouped, every level can be edited and the first one can be removed", async (ui) => {
	await groupBy(ui, "None");
	await changeLevel(ui, "Year", "Remove level");
	await ui.expect("the date added level is the only one left", async () => (await ui.store.sortLevels()).map((l) => l.key), ["dateAdded"]);
	const wanted = await coreTitles(ui, "sort=dateAdded&dir=desc", 6);
	await ui.expect("the list is by date added alone", () => listTitles(ui, 6), wanted);
	await ui.click("Date Added", { area: BAR, exact: true });
	await ui.expectStill("the last level has no Remove entry", async () => (await ui.visible("Remove level")), false, 300);
	await ui.press("escape");
	await rowsTakeClicks(ui);
});

// ================================================================================================================ the table's header

scenario("a column header sorts by it, again reverses, and rows take clicks after each", async (ui) => {
	await ui.click("Classic");
	await ui.click("Title", { area: HEAD, exact: true });
	const asc = await coreTitles(ui, "sort=year&dir=desc&then=title:asc", 20);
	await ui.expect("title A-Z inside the year groups", () => listTitles(ui, 20), asc);
	await ui.see("↑2", { area: HEAD });
	await rowsTakeClicks(ui);
	await ui.click("Title", { area: HEAD, exact: true });
	const desc = await coreTitles(ui, "sort=year&dir=desc&then=title:desc", 20);
	await ui.expect("title Z-A", () => listTitles(ui, 20), desc);
	await ui.see("↓2", { area: HEAD });
	await rowsTakeClicks(ui);
});

scenario("Shift+click on a header adds a level; a plain click on the group column flips the group", async (ui) => {
	await ui.click("Classic");
	await ui.click("Creator", { area: HEAD, exact: true, modifiers: "shift" });
	await ui.expect("creator is a third level", async () => (await ui.store.sortLevels()).map((l) => l.key), ["year", "dateAdded", "creator"]);
	await ui.click("Year", { area: HEAD, exact: true });
	await ui.expect("the group flipped", async () => (await ui.store.sortLevels())[0], { key: "year", dir: "asc" });
	const wanted = await coreTitles(ui, "sort=year&dir=asc&then=dateAdded:desc,creator:asc", 6);
	await ui.expect("the list follows", () => listTitles(ui, 6), wanted);
	await rowsTakeClicks(ui);
});

// ================================================================================================================ columns

/** The column picker, opened by a right-click on the header; its entries are below the header row. */
const COLUMN_MENU: Box = { x: 265, y: 212, width: 500, height: 690 };
const columnMenu = async (ui: Ui) => {
	await ui.rightClick("Title", { area: HEAD, exact: true });
	await ui.see("Creator", { area: COLUMN_MENU, exact: true });
};

scenario("the column menu shows and hides a column, and the title column cannot be hidden", async (ui) => {
	await ui.click("Classic");
	await columnMenu(ui);
	await ui.click("Publisher", { area: COLUMN_MENU, exact: true });
	await ui.see("Publisher", { area: HEAD, exact: true });
	await ui.press("escape");
	await ui.click("Surname1", { area: "list", exact: true }); // the title column has given way: the row is clicked by another cell
	await ui.expect("the row took the click", async () => (await ui.selectedTitle()), "Bulk 0001");

	await columnMenu(ui);
	await ui.click("Publisher", { area: COLUMN_MENU, exact: true });
	await ui.gone("Publisher", { area: HEAD, exact: true });
	await ui.click("Title", { area: COLUMN_MENU, exact: true }); // its own entry is disabled
	await ui.expectStill("the title column is still there", async () => (await ui.visible("Title", { area: HEAD, exact: true })), true, 300);
	await ui.press("escape");
});

// ================================================================================================================ selection

scenario("click selects one, Ctrl+click toggles, Shift+click takes a range", async (ui) => {
	await ui.click(T.neighbour, { area: "list" });
	await ui.expect("one selected", () => selectedTitles(ui), [T.neighbour]);
	await ui.click(T.hebrew, { area: "list", modifiers: "ctrl" });
	await ui.expect("two selected", () => selectedTitles(ui), [T.neighbour, T.hebrew]);
	await ui.see("2 selected", { exact: true });
	await ui.click(T.neighbour, { area: "list", modifiers: "ctrl" });
	await ui.expect("Ctrl+click on a selected row takes it out", () => selectedTitles(ui), [T.hebrew]);
	await ui.click(T.authors, { area: "list", modifiers: "shift" });
	// the anchor is the last Ctrl+click (ZT02)... the range is ZT01 to it
	await ui.expect("a range from the anchor", async () => (await selectedTitles(ui)).length >= 2, true);
	await ui.click(T.arabic, { area: "list" });
	await ui.expect("a plain click drops the rest", () => selectedTitles(ui), [T.arabic]);
});

scenario("Shift+click selects the whole range between two rows", async (ui) => {
	await ui.click(T.neighbour, { area: "list" });
	await ui.click(T.hebrew, { area: "list", modifiers: "shift" });
	await ui.expect("ZT02 to ZT04", () => selectedTitles(ui), [T.neighbour, T.arabic, T.hebrew]);
	await ui.click(T.authors, { area: "list", modifiers: "ctrl" });
	await ui.expect("Ctrl+click adds a row outside the range", () => selectedTitles(ui), [T.authors, T.neighbour, T.arabic, T.hebrew]);
});

scenario("a selected row still takes clicks: Ctrl+click takes it out, a plain click keeps only it", async (ui) => {
	await ui.click(T.neighbour, { area: "list" });
	await ui.click(T.arabic, { area: "list", modifiers: "ctrl" });
	await ui.expect("two selected", () => selectedTitles(ui), [T.neighbour, T.arabic]);
	await ui.click(T.arabic, { area: "list", modifiers: "ctrl" });
	await ui.expect("Ctrl+click on a selected row takes it out", () => selectedTitles(ui), [T.neighbour]);
	await ui.click(T.hebrew, { area: "list", modifiers: "shift" });
	await ui.expect("a range from the row clicked last", () => selectedTitles(ui), [T.arabic, T.hebrew]);
	await ui.click(T.arabic, { area: "list" });
	await ui.expect("a plain click on one of them selects only that one", () => selectedTitles(ui), [T.arabic]);
});

scenario("Shift+click across pages that are not loaded yet selects every row between", async (ui) => {
	await ui.click(T.article, { area: "list" });
	for (let i = 0; i < 30; i++) await ui.wheel(640, 500, -1200);
	await ui.waitFor("the list scrolled far down", async () => !(await ui.visible(T.article, { area: "list" })) && (await visibleItems(ui)).length > 2);
	const target = (await visibleItems(ui)).filter((t) => t.startsWith("Bulk")).at(-1)!;
	await ui.click(target, { area: "list", exact: true, modifiers: "shift" });
	const at = (await ui.store.focusIndex());
	if (at < 200) throw new Error(`expected a row far down, got index ${at}`);
	await ui.expect("every row from the first to the clicked one is selected", async () => (await ui.store.selected()).length, at + 1, 10_000);
	await ui.see(`${at + 1} selected`, { exact: true });
}, { items: 450 });

scenario("Select All takes every item of a list of several pages", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.press("ctrl-a");
	await ui.expect("every item is selected", async () => (await ui.store.selected()).length, (await ui.store.total()), 10_000);
	await ui.see(`${(await ui.store.total())} selected`, { exact: true });
}, { items: 450 });

scenario("Escape clears the selection", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.click(T.neighbour, { area: "list", modifiers: "ctrl" });
	await ui.expect("two", async () => (await ui.store.selected()).length, 2);
	await ui.press("escape");
	await ui.expect("none", async () => (await ui.store.selected()).length, 0);
	await ui.see("139 items", { exact: true });
});

scenario("the arrow keys move the selection, Shift extends it, Space toggles", async (ui) => {
	await ui.click(T.neighbour, { area: "list" });
	await ui.press("down");
	await ui.expect("down", () => selectedTitles(ui), [T.arabic]);
	await ui.press("shift-down");
	await ui.press("shift-down");
	await ui.expect("Shift+down extends from where the arrows started", () => selectedTitles(ui), [T.arabic, T.hebrew, T.emoji]);
	await ui.press("shift-up");
	await ui.expect("Shift+up takes the last one off", () => selectedTitles(ui), [T.arabic, T.hebrew]);
	await ui.press("up");
	await ui.expect("a plain arrow collapses it to one row, next to where the focus was", () => selectedTitles(ui), [T.arabic]);
	await ui.press("space");
	await ui.expect("Space toggles the focused row (it was the only one selected)", () => selectedTitles(ui), []);
});

scenario("Home and End go to the first and the last item, also when the last page is not loaded", async (ui) => {
	await ui.click(T.neighbour, { area: "list" });
	await ui.press("home");
	await ui.expect("the first item", async () => (await ui.selectedTitle()), T.article);
	await ui.press("end");
	const last = (await coreTitles(ui, "sort=year&dir=desc&then=dateAdded:desc&offset=138", 1))[0]!;
	await ui.expect("the last item", async () => (await ui.selectedTitle()), last);
	await ui.see(last, { area: "list" }); // and it is on screen
});

// The list learns how many rows a screen holds from the visible range it is told about; the test renderer tells it only when the
// list scrolls, so on a list that has not moved, Page Down steps one row.
scenario("Page Down on a list that was just opened moves a screenful", async (ui) => {
	await ui.click(T.article, { area: "list" });
	await ui.press("pagedown");
	await ui.expect("the focus moved several rows", async () => (await ui.store.focusIndex()) >= 3, true);
}, { knownBug: "the visible range reaches the list only after its first scroll in the test renderer: needs a look in a real window whether Page Down is one row there too" });

scenario("Page Down moves a screenful and Shift+End selects to the end", async (ui) => {
	await ui.wheel(640, 500, -150); // the list reports its visible range when it scrolls
	await ui.wheel(640, 500, 150);
	await ui.click(T.article, { area: "list" });
	await ui.press("pagedown");
	await ui.expect("the focus moved several rows", async () => (await ui.store.focusIndex()) >= 3, true);
	await ui.press("home");
	await ui.press("shift-end");
	await ui.expect("everything from the first row to the last is selected", async () => (await ui.store.selected()).length, (await ui.store.total()), 10_000);
});

// ================================================================================================================ quick search

scenario("the quick search narrows the list as the words are typed, and clearing brings it back", async (ui) => {
	await search(ui, "Neighbour");
	await ui.expect("one item", () => listTitles(ui, 5), [T.neighbour]);
	await ui.see("1 item", { exact: true });
	await ui.gone(T.authors, { area: "list" });
	await ui.see(T.neighbour, { area: "list" });
	await ui.click(T.neighbour, { area: "list" });
	await ui.expect("the one row takes the click", async () => (await ui.selectedTitle()), T.neighbour);
	await clearSearch(ui);
	await ui.see("139 items", { exact: true });
	await ui.see(T.authors, { area: "list" });
});

scenario("a search with no match says so", async (ui) => {
	await search(ui, "qqqzzzxx");
	await ui.see("No items", { area: "list", exact: true });
	await ui.see("0 items", { exact: true });
	await clearSearch(ui);
	await ui.see(T.authors, { area: "list" });
});

scenario("Title, Creator, Year matches creators and years but not other fields", async (ui) => {
	await search(ui, "Delta");
	await ui.expect("the creator matches", () => listTitles(ui, 3), [T.neighbour]);
	await search(ui, "2025");
	await ui.expect("the year matches", () => listTitles(ui, 3), [T.authors]);
	await search(ui, "Journal of Testing");
	await ui.see("No items", { area: "list", exact: true }); // the publication is not in this mode
});

scenario("All Fields & Tags also matches the publication and the tags", async (ui) => {
	await ui.click("Title, Creator, Year");
	await ui.click("All Fields & Tags", { exact: true });
	await ui.gone("All Fields & Tags", { exact: true, area: { x: 265, y: 120, width: 300, height: 200 } });
	await search(ui, "Journal of Testing");
	await ui.expect("the publication matches", () => listTitles(ui, 3), [T.authors]);
	await search(ui, "seminal");
	await ui.expect("the tag matches", () => listTitles(ui, 3), [T.authors]);
	await search(ui, "Note body");
	await ui.see("No items", { area: "list", exact: true }); // note text needs the next mode
});

scenario("Everything also matches the text of notes", async (ui) => {
	await ui.click("Title, Creator, Year");
	await ui.click("Everything", { exact: true });
	await search(ui, "Note body for the test");
	await ui.expect("the item with that note", () => listTitles(ui, 3), [T.noted]);
	await ui.see("Everything", { area: SEARCH_BOX, exact: true }); // the picker shows the mode
});

scenario("Full text shows results with their passages instead of the list", async (ui) => {
	await ui.click("Title, Creator, Year");
	await ui.click("Full text", { exact: true });
	await ui.see("Type to search titles, notes and full text", { exact: true });
	await ui.gone("Year", { area: BAR, exact: true }); // the sort bar belongs to the list
	await search(ui, "Neighbour");
	await ui.see(T.neighbour, { area: "list" });
	await ui.see("1 hits", { exact: true });
	await search(ui, "qqqzzzxx");
	await ui.see("No matches", { exact: true });
	await ui.click("Full text", { area: SEARCH_BOX, exact: true, nth: 0 }); // the picker, above its own menu
	await ui.click("Title, Creator, Year", { exact: true });
	await ui.see("Year", { area: BAR, exact: true });
});

scenario("Ctrl+F in the list puts the cursor in the search box", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.press("ctrl-f");
	await ui.type("Neighbour");
	await ui.expect("the typing went into the search", () => listTitles(ui, 3), [T.neighbour]);
});

scenario("a search is kept while another collection is opened, and applies to it", async (ui) => {
	await search(ui, "ZT0");
	await ui.click("Methods", { area: "sidebar", exact: true });
	await ui.expect("only the collection's item that matches", () => listTitles(ui, 5), [T.article]);
	await ui.click("My Library", { area: "sidebar", exact: true });
	await ui.expect("My Library again, filtered", async () => (await listTitles(ui, 3))[0], T.article);
	await ui.expect("with its search", async () => (await ui.store.total()) < 139, true);
});

// ================================================================================================================ the sidebar's views

const sidebarEntry = (ui: Ui, text: string) => ui.click(text, { area: "sidebar", exact: true });

/** Every collection of My Library as the core has it, flat. */
async function allCollections(ui: Ui): Promise<{ key: string; name: string; parentKey: string | null; itemCount?: number }[]> {
	const tree = await ui.api<any[]>("GET", "/collections");
	const out: any[] = [];
	const walk = (l: any[]) => {
		for (const c of l) {
			out.push(c);
			walk(c.children ?? []);
		}
	};
	walk(tree);
	return out;
}
const collectionNamed = async (ui: Ui, name: string) => (await allCollections(ui)).find((c) => c.name === name);

/** The "+" buttons at the right end of the sidebar's section headers have no text: they sit on the header's line. */
async function headerButton(ui: Ui, header: string, x: number): Promise<void> {
	const h = await ui.see(header, { area: "sidebar", exact: true });
	await ui.clickAt(x, h.y);
}

scenario("Unfiled lists the items that are in no collection", async (ui) => {
	await sidebarEntry(ui, "Unfiled");
	const wanted = await coreTitles(ui, "unfiled=1&sort=year&dir=desc&then=dateAdded:desc", 8);
	await ui.expect("the list is the core's unfiled items", () => listTitles(ui, 8), wanted);
	if (wanted.includes(T.article) || wanted.includes(T.authors)) throw new Error("the core listed items that are in collections");
	await ui.see(T.neighbour, { area: "list" });
	await ui.gone(T.article, { area: "list" }); // it is in Methods
	await rowsTakeClicks(ui);
	await sidebarEntry(ui, "My Library");
	await ui.see(T.article, { area: "list" });
});

scenario("My Publications is empty until an item is put in it, and Remove takes it out", async (ui) => {
	await sidebarEntry(ui, "My Publications");
	await ui.see("No items in My Publications", { area: "list", exact: true });
	await sidebarEntry(ui, "My Library");
	await ui.rightClick(T.neighbour, { area: "list" });
	await ui.click("Show in My Publications", { exact: true });
	await sidebarEntry(ui, "My Publications");
	await ui.expect("the item is listed", () => listTitles(ui, 3), [T.neighbour]);
	await ui.rightClick(T.neighbour, { area: "list" });
	await ui.click("Remove from My Publications", { exact: true });
	await ui.see("No items in My Publications", { area: "list", exact: true });
});

scenario("Move to Trash from the item menu takes the item to the Trash", async (ui) => {
	await itemMenu(ui, T.neighbour, "Move to Trash");
	await ui.gone(T.neighbour, { area: "list" });
	await ui.expect("it is in the trash", async () => (await ui.api<{ items: { title: string }[] }>("GET", "/items?trash=1&limit=10")).items.map((i) => i.title).sort(), [T.neighbour, T.trashed].sort());
	await sidebarEntry(ui, "Trash");
	await ui.see(T.neighbour, { area: "list" });
});

scenario("the Delete key moves the selected items to the Trash", async (ui) => {
	await ui.click(T.neighbour, { area: "list" });
	await ui.click(T.arabic, { area: "list", modifiers: "ctrl" });
	await ui.press("delete");
	await ui.see("Move 2 items to the Trash?", { exact: true });
	await ui.click("Move to Trash", { exact: true, area: { x: 300, y: 300, width: 900, height: 500 } });
	await ui.gone(T.neighbour, { area: "list" });
	await ui.gone(T.arabic, { area: "list" });
	await ui.expect("both are in the trash", async () => (await ui.api<{ total: number }>("GET", "/items?trash=1&limit=10")).total, 3);
});

scenario("Empty Trash asks first: Cancel keeps the items, Empty Trash deletes them", async (ui) => {
	await ui.rightClick("Trash", { area: "sidebar", exact: true });
	await ui.click("Empty Trash…", { exact: true });
	await ui.see("Empty Trash?", { exact: true });
	await ui.click("Cancel", { exact: true });
	await ui.gone("Empty Trash?", { exact: true });
	await ui.expect("the item is still in the trash", async () => (await ui.api<{ total: number }>("GET", "/items?trash=1&limit=10")).total, 1);
	await ui.rightClick("Trash", { area: "sidebar", exact: true });
	await ui.click("Empty Trash…", { exact: true });
	await ui.click("Empty Trash", { exact: true, area: { x: 300, y: 300, width: 900, height: 500 } });
	await ui.expect("the trash is empty", async () => (await ui.api<{ total: number }>("GET", "/items?trash=1&limit=10")).total, 0);
	await ui.expect("and the item is gone for good", async () => (await ui.api<{ total: number }>("GET", "/items?limit=5&q=ZT09")).total, 0);
});

scenario("the Duplicate Items count follows the library", async (ui) => {
	for (const n of [1, 2]) await ui.api("POST", "/items", { data: { itemType: "book", title: "ZD02 Twin count", date: "2021", creators: [{ creatorType: "author", lastName: "Twin", firstName: "Tom" }] } });
	await ui.store.refresh();
	await ui.settle(1500);
	const count = (await ui.api<{ total: number }>("GET", "/duplicates")).total;
	if (!count) throw new Error("the core found no duplicates to count");
	await ui.see(String(count), { area: { x: 150, y: 225, width: 100, height: 30 }, exact: true });
});

scenario("the read-only group offers no new collection", async (ui) => {
	await ui.rightClick("Read-only test group", { area: "sidebar" });
	await ui.see("New Collection…", { exact: true });
	await ui.click("New Collection…", { exact: true });
	await ui.expectStill("no name prompt opened", async () => (await ui.visible("New collection in Read-only test group")), false, 500);
	await ui.press("escape");
});

scenario("items dragged out of a read-only group do not go into a collection of My Library", async (ui) => {
	await sidebarEntry(ui, "Read-only test group");
	await ui.see(T.groupItem, { area: "list" });
	const from = await ui.see(T.groupItem, { area: "list" });
	const to = await ui.see("Empty collection", { area: "sidebar", exact: true });
	await ui.drag(from, to);
	const key = (await collectionNamed(ui, "Empty collection"))!.key;
	await ui.expectStill("nothing went into the collection", async () => (await coreTitles(ui, `collection=${key}`, 5)).length, 0, 800);
});

scenario("the arrow keys in the sidebar move through the entries and open them", async (ui) => {
	await sidebarEntry(ui, "Unfiled");
	await ui.press("down");
	await ui.expect("My Publications opened", async () => (await ui.store.view()).kind, "publications");
	await ui.press("down");
	await ui.expect("Trash opened", async () => (await ui.store.view()).kind, "trash");
	await ui.press("up");
	await ui.expect("and back up", async () => (await ui.store.view()).kind, "publications");
});

scenario("the Library, Collections and Group Libraries headers fold their rows", async (ui) => {
	await ui.click("LIBRARY", { area: "sidebar", exact: true });
	await ui.gone("Unfiled", { area: "sidebar", exact: true });
	await ui.click("LIBRARY", { area: "sidebar", exact: true });
	await ui.see("Unfiled", { area: "sidebar", exact: true });
	await ui.click("COLLECTIONS", { area: "sidebar", exact: true });
	await ui.gone("Methods", { area: "sidebar", exact: true });
	await ui.click("COLLECTIONS", { area: "sidebar", exact: true });
	await ui.see("Methods", { area: "sidebar", exact: true });
	await ui.click("GROUP LIBRARIES", { area: "sidebar", exact: true });
	await ui.gone("Read-only test group", { area: "sidebar", exact: true });
});

// ================================================================================================================ collections

scenario("a collection is created from the plus: type a name, press Enter", async (ui) => {
	await headerButton(ui, "COLLECTIONS", COLLECTIONS_HEADER_PLUS);
	await ui.type("ZC Fresh");
	await ui.press("enter");
	await ui.see("ZC Fresh", { area: "sidebar", exact: true });
	await ui.expect("the core has it, at the top level", async () => { const c = await collectionNamed(ui, "ZC Fresh"); return !!c && !c.parentKey; }, true);
});

scenario("Escape and an empty name create no collection", async (ui) => {
	const before = (await allCollections(ui)).length;
	await headerButton(ui, "COLLECTIONS", COLLECTIONS_HEADER_PLUS);
	await ui.type("ZC Cancelled");
	await ui.press("escape");
	await ui.gone("ZC Cancelled", { area: "sidebar" });
	await headerButton(ui, "COLLECTIONS", COLLECTIONS_HEADER_PLUS);
	await ui.press("enter");
	await ui.expectStill("no collection was made", async () => (await allCollections(ui)).length, before, 600);
});

scenario("a collection is renamed from its menu, and Escape keeps the old name", async (ui) => {
	await ui.rightClick("Empty collection", { area: "sidebar", exact: true });
	await ui.click("Rename", { exact: true });
	await ui.replace("ZC Renamed");
	await ui.press("escape");
	await ui.expectStill("Escape did not rename it", async () => !!(await collectionNamed(ui, "Empty collection")), true, 400);
	await ui.rightClick("Empty collection", { area: "sidebar", exact: true });
	await ui.click("Rename", { exact: true });
	await ui.replace("ZC Renamed");
	await ui.press("enter");
	await ui.see("ZC Renamed", { area: "sidebar", exact: true });
	await ui.expect("renamed in the core", async () => !!(await collectionNamed(ui, "ZC Renamed")), true);
	await ui.expect("the old name is gone", async () => !!(await collectionNamed(ui, "Empty collection")), false);
});

scenario("double-clicking a collection lets its name be edited", async (ui) => {
	await ui.click("Empty collection", { area: "sidebar", exact: true, count: 2 });
	await ui.replace("ZC Twice");
	await ui.press("enter");
	await ui.expect("renamed in the core", async () => !!(await collectionNamed(ui, "ZC Twice")), true);
});

scenario("deleting a collection asks first; Cancel keeps it, Delete removes it and keeps its items", async (ui) => {
	await ui.rightClick("Methods", { area: "sidebar", exact: true });
	await ui.click("Delete…", { exact: true });
	await ui.see('Delete collection "Methods"?', { exact: true });
	await ui.click("Cancel", { exact: true });
	await ui.gone('Delete collection "Methods"?', { exact: true });
	await ui.expectStill("the collection is still there", async () => !!(await collectionNamed(ui, "Methods")), true, 400);
	await ui.click("Methods", { area: "sidebar", exact: true }); // open it, to see the view move away
	await ui.rightClick("Methods", { area: "sidebar", exact: true });
	await ui.click("Delete…", { exact: true });
	await ui.click("Delete", { exact: true, area: { x: 300, y: 300, width: 900, height: 500 } });
	await ui.gone("Methods", { area: "sidebar", exact: true });
	await ui.expect("gone from the core, its subcollection with it", async () => (await allCollections(ui)).map((c) => c.name).filter((n) => /methods/i.test(n)), []);
	await ui.expect("the list left the deleted collection", async () => (await ui.store.view()).kind, "library");
	await ui.expect("its items are kept", async () => (await ui.saved(T.article)).title, T.article);
});

scenario("a subcollection is made from the menu and the parent opens to show it", async (ui) => {
	await ui.rightClick("Methods", { area: "sidebar", exact: true });
	await ui.click("New subcollection", { exact: true });
	// type once the field has the keys, as a user waits for the caret: it must get them without a click. (The field is in the tree a
	// frame before the window gives it the focus; keys sent in between go to the sidebar.)
	await ui.see("Collection name", { area: "sidebar" });
	await ui.waitFor("the name field has the keys", async () => (await ui.focused())?.type === "input", 3000);
	await ui.type("ZC Child");
	await ui.press("enter");
	await ui.see("ZC Child", { area: "sidebar", exact: true });
	await ui.see("Nested methods", { area: "sidebar", exact: true });
	const parent = await collectionNamed(ui, "Methods");
	await ui.expect("its parent in the core", async () => (await collectionNamed(ui, "ZC Child"))?.parentKey, parent!.key);
});

scenario("a collection shows its own items, and an empty one says so", async (ui) => {
	await ui.click("Methods", { area: "sidebar", exact: true });
	await ui.expect("Methods holds the article", () => listTitles(ui, 3), [T.article]);
	await ui.click("Empty collection", { area: "sidebar", exact: true });
	await ui.see("No items", { area: "list", exact: true });
	await ui.click("My Library", { area: "sidebar", exact: true });
	await ui.see(T.article, { area: "list" });
});

scenario("Pin to top gathers a collection under a Pinned header that folds", async (ui) => {
	await ui.rightClick("Empty collection", { area: "sidebar", exact: true });
	await ui.click("Pin to top", { exact: true });
	await ui.see("Pinned", { area: "sidebar", exact: true });
	await ui.expect("the pinned row sits above the tree", async () => (await ui.findAll("Empty collection", { area: "sidebar", exact: true }))[0]!.y < (await ui.findAll("Methods", { area: "sidebar", exact: true }))[0]!.y, true);
	await ui.click("Pinned", { area: "sidebar", exact: true });
	await ui.expect("folded: only the tree's own copy is left", async () => (await ui.findAll("Empty collection", { area: "sidebar", exact: true })).length, 1);
	await ui.rightClick("Empty collection", { area: "sidebar", exact: true });
	await ui.click("Unpin", { exact: true });
	await ui.gone("Pinned", { area: "sidebar", exact: true });
});

scenario("the collections' sort menu reorders the tree", async (ui) => {
	const y = async (name: string) => (await ui.findAll(name, { area: "sidebar", exact: true }))[0]!.y;
	await ui.expect("A-Z by default", async () => (await y("Empty collection")) < (await y("Methods")), true);
	await headerButton(ui, "COLLECTIONS", 187);
	await ui.click("Name Z–A", { exact: true });
	await ui.expect("Z-A", async () => (await y("Methods")) < (await y("Empty collection")), true);
	await headerButton(ui, "COLLECTIONS", 187);
	await ui.click("Name A–Z", { exact: true });
	await ui.expect("A-Z again", async () => (await y("Empty collection")) < (await y("Methods")), true);
});

scenario("grouping collections by colour makes a header that folds", async (ui) => {
	await ui.rightClick("Methods", { area: "sidebar", exact: true });
	await ui.click("Colour", { exact: true });
	await ui.click("Blue", { exact: true });
	await headerButton(ui, "COLLECTIONS", 187);
	await ui.click("By colour", { exact: true });
	await ui.see("Blue", { area: "sidebar", exact: true });
	await ui.click("Blue", { area: "sidebar", exact: true });
	await ui.gone("Methods", { area: "sidebar", exact: true });
	await ui.click("Blue", { area: "sidebar", exact: true });
	await ui.see("Methods", { area: "sidebar", exact: true });
});

scenario("a collection can be moved under another by dragging it", async (ui) => {
	const from = await ui.see("Empty collection", { area: "sidebar", exact: true });
	const to = await ui.see("Methods", { area: "sidebar", exact: true });
	await ui.drag(from, to);
	const methods = await collectionNamed(ui, "Methods");
	await ui.expect("it is a child of Methods in the core", async () => (await collectionNamed(ui, "Empty collection"))?.parentKey, methods!.key);
});

// ================================================================================================================ dragging items

scenario("dragging an item onto a collection adds it", async (ui) => {
	const from = await ui.see(T.neighbour, { area: "list" });
	const to = await ui.see("Empty collection", { area: "sidebar", exact: true });
	await ui.drag(from, to);
	const key = (await collectionNamed(ui, "Empty collection"))!.key;
	await ui.expect("the item is in the collection", async () => coreTitles(ui, `collection=${key}`, 5), [T.neighbour]);
	await ui.see('Added 1 item to "Empty collection"');
	await ui.see("1", { area: { x: 150, y: 360, width: 100, height: 40 }, exact: true }); // its count badge
});

scenario("dragging one of several selected items takes all of them", async (ui) => {
	await ui.click(T.neighbour, { area: "list" });
	await ui.click(T.hebrew, { area: "list", modifiers: "ctrl" });
	const from = await ui.see(T.hebrew, { area: "list" });
	const to = await ui.see("Empty collection", { area: "sidebar", exact: true });
	await ui.drag(from, to);
	const key = (await collectionNamed(ui, "Empty collection"))!.key;
	await ui.expect("both are in", async () => (await coreTitles(ui, `collection=${key}`, 5)).sort(), [T.neighbour, T.hebrew].sort());
	await ui.see('Added 2 items to "Empty collection"');
});

scenario("dragging a row that is not selected takes it alone, whatever else is selected", async (ui) => {
	await ui.click(T.neighbour, { area: "list" });
	const from = await ui.see(T.hebrew, { area: "list" });
	const to = await ui.see("Empty collection", { area: "sidebar", exact: true });
	await ui.drag(from, to);
	const key = (await collectionNamed(ui, "Empty collection"))!.key;
	await ui.expect("only the dragged one is in", async () => coreTitles(ui, `collection=${key}`, 5), [T.hebrew]);
});

scenario("an item that is already selected can be dragged onto a collection", async (ui) => {
	await ui.click(T.neighbour, { area: "list" });
	const from = await ui.see(T.neighbour, { area: "list" });
	const to = await ui.see("Empty collection", { area: "sidebar", exact: true });
	await ui.drag(from, to);
	const key = (await collectionNamed(ui, "Empty collection"))!.key;
	await ui.expect("the item is in the collection", async () => coreTitles(ui, `collection=${key}`, 5), [T.neighbour]);
});

scenario("a selected row of the Classic table can be dragged onto a collection", async (ui) => {
	await ui.click("Classic");
	await ui.click(T.neighbour, { area: "list" });
	const from = await ui.see(T.neighbour, { area: "list" });
	const to = await ui.see("Empty collection", { area: "sidebar", exact: true });
	await ui.drag(from, to);
	const key = (await collectionNamed(ui, "Empty collection"))!.key;
	await ui.expect("the item is in the collection", async () => coreTitles(ui, `collection=${key}`, 5), [T.neighbour]);
});

scenario("an item released on the toolbar goes nowhere, and the rows still take clicks", async (ui) => {
	const key = (await collectionNamed(ui, "Empty collection"))!.key;
	const from = await ui.see(T.neighbour, { area: "list" });
	await ui.drag(from, { x: 640, y: 120 });
	await ui.expectStill("nothing was added anywhere", async () => (await coreTitles(ui, `collection=${key}`, 5)).length, 0, 600);
	await ui.expectStill("nothing was trashed", async () => (await ui.api<{ total: number }>("GET", "/items?trash=1&limit=5")).total, 1);
	await ui.click(T.authors, { area: "list" });
	await ui.expect("the rows take clicks after the drag", async () => (await ui.selectedTitle()), T.authors);
});

scenario("an item released on a Library row does not open that row", async (ui) => {
	const from = await ui.see(T.neighbour, { area: "list" });
	const unfiled = await ui.see("Unfiled", { area: "sidebar", exact: true });
	await ui.drag(from, unfiled);
	await ui.expectStill("the list is still My Library", async () => (await ui.store.view()).kind, "library", 600);
});

scenario("a drag whose button was released outside the window is not a drop", async (ui) => {
	const key = (await collectionNamed(ui, "Empty collection"))!.key;
	const from = await ui.see(T.neighbour, { area: "list" });
	const to = await ui.see("Empty collection", { area: "sidebar", exact: true });
	const r = ui.renderer;
	r.nativeSimulateMouseMove(from.x, from.y);
	r.nativeSimulateMouseDown(from.x, from.y);
	for (let i = 1; i <= 8; i++) {
		r.nativeSimulateMouseMove(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8, 0);
		await ui.settle(30);
	}
	r.nativeSimulateMouseMove(to.x, to.y); // no button pressed any more: it was let go outside
	await ui.settle(200);
	r.nativeSimulateMouseUp(to.x, to.y);
	await ui.settle();
	await ui.expectStill("nothing was dropped on the row", async () => (await coreTitles(ui, `collection=${key}`, 5)).length, 0, 600);
}, { inProcessOnly: "needs ui.renderer's separate mouse down / up (the driver has drag() only)" });

scenario("Escape during a drag cancels it", async (ui) => {
	const key = (await collectionNamed(ui, "Empty collection"))!.key;
	const from = await ui.see(T.neighbour, { area: "list" });
	const to = await ui.see("Empty collection", { area: "sidebar", exact: true });
	const r = ui.renderer;
	r.nativeSimulateMouseMove(from.x, from.y);
	r.nativeSimulateMouseDown(from.x, from.y);
	for (let i = 1; i <= 8; i++) {
		r.nativeSimulateMouseMove(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8, 0);
		await ui.settle(30);
	}
	await ui.press("escape");
	r.nativeSimulateMouseUp(to.x, to.y);
	await ui.settle();
	await ui.expectStill("the item was not added", async () => (await coreTitles(ui, `collection=${key}`, 5)).length, 0, 600);
}, { knownBug: "Escape does not cancel a drag: the item is filed where the pointer is released", inProcessOnly: "needs ui.renderer's separate mouse down / up (the driver has drag() only)" });

// ================================================================================================================ the tag selector

async function tagItem(ui: Ui, title: string, tags: string[]): Promise<void> {
	const { key } = await ui.saved(title);
	await ui.api("POST", `/items/${key}/tags`, { tags });
}

scenario("the tag selector opens, filters the list by a tag, and a second click lets go", async (ui) => {
	await ui.gone("Filter tags");
	await ui.click("TAGS", { area: "sidebar", exact: true });
	await ui.see("Filter tags", { area: "sidebar" }).catch(() => undefined);
	await ui.see("seminal", { area: "sidebar", exact: true });
	await ui.click("seminal", { area: "sidebar", exact: true });
	await ui.expect("only the tagged item", () => listTitles(ui, 3), [T.authors]);
	await ui.see("1 item", { exact: true });
	await ui.click("seminal", { area: "sidebar", exact: true });
	await ui.expect("everything again", async () => (await ui.store.total()), 139);
	await ui.click("seminal", { area: "sidebar", exact: true });
	await ui.click(T.authors, { area: "list" });
	await ui.expect("rows take clicks while a tag filters", async () => (await ui.selectedTitle()), T.authors);
});

scenario("the tag filter box narrows the tags, and says when none match", async (ui) => {
	await tagItem(ui, T.neighbour, ["alpha", "alphabet", "zulu"]);
	await ui.click("TAGS", { area: "sidebar", exact: true });
	await ui.see("zulu", { area: "sidebar", exact: true });
	await clickInput(ui, { x: 0, y: 400, width: 260, height: 500 });
	await ui.type("alph");
	await ui.see("alphabet", { area: "sidebar", exact: true });
	await ui.gone("zulu", { area: "sidebar", exact: true });
	await ui.gone("seminal", { area: "sidebar", exact: true });
	await ui.press("ctrl-a");
	await ui.type("qqqq");
	await ui.see("No matching tags", { area: "sidebar", exact: true });
});

scenario("a tag is renamed from its menu", async (ui) => {
	await ui.click("TAGS", { area: "sidebar", exact: true });
	await ui.rightClick("seminal", { area: "sidebar", exact: true });
	await ui.click("Rename Tag…", { exact: true });
	await ui.see("Rename tag", { exact: true });
	await ui.replace("landmark");
	await ui.click("Rename", { exact: true, area: { x: 300, y: 250, width: 900, height: 500 } });
	await ui.see("landmark", { area: "sidebar", exact: true });
	await ui.expect("the core knows only the new name", async () => (await ui.api<{ tag: string }[]>("GET", "/tags")).map((t) => t.tag), ["landmark"]);
});

scenario("deleting a tag asks first: Cancel keeps it, Delete Tag removes it from the items", async (ui) => {
	await ui.click("TAGS", { area: "sidebar", exact: true });
	await ui.rightClick("seminal", { area: "sidebar", exact: true });
	await ui.click("Delete Tag…", { exact: true });
	await ui.see('Delete tag "seminal"?', { exact: true });
	await ui.click("Cancel", { exact: true });
	await ui.expectStill("still there", async () => (await ui.api<{ tag: string }[]>("GET", "/tags")).length, 1, 400);
	await ui.rightClick("seminal", { area: "sidebar", exact: true });
	await ui.click("Delete Tag…", { exact: true });
	await ui.click("Delete Tag", { exact: true, area: { x: 300, y: 250, width: 900, height: 500 } });
	await ui.gone("seminal", { area: "sidebar", exact: true });
	await ui.expect("no tag is left", async () => (await ui.api<unknown[]>("GET", "/tags")).length, 0);
});

scenario("a tag gets a colour from its menu", async (ui) => {
	await tagItem(ui, T.neighbour, ["plain"]);
	await ui.click("TAGS", { area: "sidebar", exact: true });
	await ui.rightClick("plain", { area: "sidebar", exact: true });
	await ui.click("Assign Colour…", { exact: true });
	await ui.see('Colour for "plain"', { exact: true });
	await ui.click("Blue", { exact: true, area: { x: 300, y: 250, width: 900, height: 500 } });
	await ui.expect("the core has the colour", async () => (await ui.api<{ name: string }[]>("GET", "/tag-colors")).map((t) => t.name).sort(), ["plain", "seminal"]);
});

scenario("a coloured tag is toggled on the selection by its number key", async (ui) => {
	await ui.click(T.neighbour, { area: "list" });
	await ui.press("1");
	await ui.expect("ZT02 has the first coloured tag", async () => ((await ui.saved(T.neighbour)).tags as any[] | undefined)?.map?.((t: any) => t.tag ?? t), ["seminal"]);
	await ui.press("1");
	await ui.expect("the key toggles it off again", async () => (((await ui.saved(T.neighbour)).tags as any[] | undefined) ?? []).length, 0);
});

scenario("Deselect All in the tag menu lifts the tag filter", async (ui) => {
	await ui.click("TAGS", { area: "sidebar", exact: true });
	await ui.click("seminal", { area: "sidebar", exact: true });
	await ui.expect("filtered", async () => (await ui.store.total()), 1);
	const h = await ui.see("TAGS", { area: "sidebar", exact: true });
	await ui.clickAt(COLLECTIONS_HEADER_PLUS, h.y);
	await ui.click("Deselect All", { exact: true });
	await ui.expect("everything again", async () => (await ui.store.total()), 139);
});

// ================================================================================================================ the item context menu

scenario("the item menu names what can be done with an item", async (ui) => {
	await ui.rightClick(T.neighbour, { area: "list" });
	for (const entry of ["Open", "Locate", "Add Note", "Duplicate Item", "Find Full Text", "Mark as Read", "Mark as Unread", "Show in collection…", "Add to collection", "Copy DOI", "Show in My Publications", "Copy Citation"])
		await ui.see(entry, { exact: true });
	await ui.screenshot("item-menu");
	await ui.press("escape");
	await ui.gone("Mark as Unread", { exact: true });
	await ui.expectStill("Escape did nothing to the item", async () => (await listTitles(ui, 3)).includes(T.neighbour), true, 300);
});

scenario("Add to collection puts the item in the chosen collection", async (ui) => {
	await ui.rightClick(T.neighbour, { area: "list" });
	await ui.click("Add to collection", { exact: true });
	await ui.click("Empty collection", { exact: true, area: { x: 400, y: 200, width: 700, height: 700 } });
	const key = (await collectionNamed(ui, "Empty collection"))!.key;
	await ui.expect("in the collection", async () => coreTitles(ui, `collection=${key}`, 5), [T.neighbour]);
});

scenario("Show in collection… opens the collection an item is in", async (ui) => {
	await ui.rightClick(T.authors, { area: "list" });
	await ui.click("Show in collection…", { exact: true });
	await ui.click("Nested methods", { exact: true, area: { x: 400, y: 200, width: 700, height: 700 } });
	await ui.expect("the nested collection is open", () => listTitles(ui, 3), [T.authors]);
});

scenario("a right-click on an item outside the selection selects just that one", async (ui) => {
	await ui.click(T.neighbour, { area: "list" });
	await ui.click(T.hebrew, { area: "list", modifiers: "ctrl" });
	await ui.rightClick(T.arabic, { area: "list" });
	await ui.expect("only the right-clicked item is selected", () => selectedTitles(ui), [T.arabic]);
	await ui.press("escape");
});

// ================================================================================================================ saved and advanced searches

const DIALOG_VALUE: Box = { x: 355, y: 290, width: 720, height: 40 };

scenario("Advanced Search runs as the value is typed and its result can be opened", async (ui) => {
	await headerButton(ui, "SAVED SEARCHES", COLLECTIONS_HEADER_PLUS);
	await ui.see("Advanced Search", { exact: true });
	await ui.see("Enter a value to search", { exact: true });
	await clickInput(ui, DIALOG_VALUE);
	await ui.type("Neighbour");
	await ui.see("1 result", { exact: true });
	await clickInput(ui, DIALOG_VALUE);
	await ui.press("ctrl-a");
	await ui.type("qqqzzz");
	await ui.see("0 results", { exact: true });
	await ui.press("ctrl-a");
	await ui.type("Neighbour");
	await ui.see("1 result", { exact: true });
	await ui.click(T.neighbour, { exact: true, area: { x: 355, y: 420, width: 720, height: 200 } });
	await ui.gone("Advanced Search", { exact: true });
	await ui.expect("the item is selected in the library", async () => (await ui.selectedTitle()), T.neighbour);
});

scenario("Include items in the trash widens an advanced search", async (ui) => {
	await headerButton(ui, "SAVED SEARCHES", COLLECTIONS_HEADER_PLUS);
	await clickInput(ui, DIALOG_VALUE);
	await ui.type("ZT09");
	await ui.see("0 results", { exact: true });
	await ui.click("Include items in the trash", { exact: true });
	await ui.see("1 result", { exact: true });
	await ui.click("Close", { exact: true });
	await ui.gone("Advanced Search", { exact: true });
});

async function makeSavedSearch(ui: Ui, name: string, value: string): Promise<void> {
	await headerButton(ui, "SAVED SEARCHES", COLLECTIONS_HEADER_PLUS);
	await clickInput(ui, DIALOG_VALUE);
	await ui.type(value);
	await ui.see("1 result", { exact: true });
	await ui.click("Save Search…", { exact: true });
	await ui.replace(name);
	await ui.press("enter");
	await ui.see(name, { area: "sidebar", exact: true });
}

scenario("a saved search is made from Advanced Search, listed in the sidebar and opens its items", async (ui) => {
	await makeSavedSearch(ui, "ZS Neighbours", "Neighbour");
	await ui.expect("the saved search is open", async () => (await ui.store.view()).kind, "savedSearch");
	await ui.expect("with its items", () => listTitles(ui, 3), [T.neighbour]);
	await sidebarEntry(ui, "My Library");
	await ui.expect("the library again", async () => (await ui.store.total()), 139);
	await sidebarEntry(ui, "ZS Neighbours");
	await ui.expect("and the search again", () => listTitles(ui, 3), [T.neighbour]);
});

scenario("a saved search is renamed from its menu", async (ui) => {
	await makeSavedSearch(ui, "ZS First", "Neighbour");
	await ui.rightClick("ZS First", { area: "sidebar", exact: true });
	await ui.click("Rename", { exact: true });
	await ui.replace("ZS Second");
	await ui.press("enter");
	await ui.see("ZS Second", { area: "sidebar", exact: true });
	await ui.gone("ZS First", { area: "sidebar", exact: true });
});

scenario("Edit Search… changes what a saved search finds", async (ui) => {
	await makeSavedSearch(ui, "ZS Edit me", "Neighbour");
	await ui.rightClick("ZS Edit me", { area: "sidebar", exact: true });
	await ui.click("Edit Search…", { exact: true });
	await ui.see("Edit Saved Search", { exact: true });
	await clickInput(ui, DIALOG_VALUE);
	await ui.press("ctrl-a");
	await ui.type("Delta");
	await ui.see("0 results", { exact: true }); // no title has Delta in it (it is a creator)
	await ui.click("Save Changes", { exact: true });
	await ui.gone("Edit Saved Search", { exact: true });
	await ui.expect("the saved search is open", async () => (await ui.store.view()).kind, "savedSearch");
	await ui.expect("it now finds nothing: the old condition is gone", async () => (await ui.store.total()), 0);
});

scenario("deleting a saved search asks first; Cancel keeps it, Delete removes it", async (ui) => {
	await makeSavedSearch(ui, "ZS Doomed", "Neighbour");
	await ui.rightClick("ZS Doomed", { area: "sidebar", exact: true });
	await ui.click("Delete…", { exact: true });
	await ui.see('Delete saved search "ZS Doomed"?', { exact: true });
	await ui.click("Cancel", { exact: true });
	await ui.see("ZS Doomed", { area: "sidebar", exact: true });
	await ui.rightClick("ZS Doomed", { area: "sidebar", exact: true });
	await ui.click("Delete…", { exact: true });
	await ui.click("Delete", { exact: true, area: { x: 300, y: 300, width: 900, height: 500 } });
	await ui.gone("ZS Doomed", { area: "sidebar", exact: true });
	await ui.expect("the list left the deleted search", async () => (await ui.store.view()).kind, "library");
	await ui.see("No saved searches", { exact: true });
});

// ================================================================================================================ scrolling a long list

scenario("a long list scrolls with the wheel and its rows take clicks anywhere in it", async (ui) => {
	for (let i = 0; i < 12; i++) await ui.wheel(640, 500, -1000);
	await ui.waitFor("the top of the list is out of sight", async () => !(await ui.visible(T.article, { area: "list" })));
	await rowsTakeClicks(ui);
	for (let i = 0; i < 12; i++) await ui.wheel(640, 500, 1000);
	await ui.see(T.article, { area: "list" });
}, { items: 450 });

scenario("dragging the scrollbar thumb jumps through a long list, and the rows show", async (ui) => {
	const bar = await ui.see(T.article, { area: "list" }); // anchors the first frame
	void bar;
	await ui.drag({ x: 1016, y: 195 }, { x: 1016, y: 560 });
	await ui.waitFor("the list moved away from the top", async () => !(await ui.visible(T.article, { area: "list" })), 4000);
	await ui.expect("rows are on screen", async () => (await visibleItems(ui)).length >= 2, true, 4000);
	await rowsTakeClicks(ui);
}, { items: 450 });

scenario("the list keeps its selection and takes clicks after a refresh", async (ui) => {
	await ui.click(T.neighbour, { area: "list" });
	await ui.store.refreshItems(["abstractNote"]);
	await ui.settle(800);
	await ui.expect("still selected", async () => (await ui.selectedTitle()), T.neighbour);
	await ui.click(T.arabic, { area: "list" });
	await ui.expect("a new click selects", async () => (await ui.selectedTitle()), T.arabic);
});

scenario("Customise rows hides the authors line and makes the cards compact, and Reset brings both back", async (ui) => {
	const count = await ui.see("139 items", { exact: true });
	await ui.clickAt(count.box.x + count.box.width + 23, count.y); // the sliders button at the right end of the sort bar
	await ui.see("Customise rows", { exact: true });
	const gap = async () => (await ui.findAll(T.arabic, { area: LIST }))[0]!.y - (await ui.findAll(T.neighbour, { area: LIST }))[0]!.y;
	const before = await gap();
	await ui.click("Hidden", { exact: true });
	await ui.expect("the authors line is gone from the cards", async () => (await ui.visible("Delta D", { area: LIST })), false);
	await ui.click("Compact", { exact: true });
	await ui.expect("the cards are shorter", async () => (await gap()) < before, true);
	await ui.screenshot("customise");
	await ui.click("Reset", { exact: true });
	await ui.expect("the authors line is back", async () => (await ui.visible("Delta D", { area: LIST })), true);
	await ui.expect("and the cards are as tall as before", () => gap(), before);
});

scenario("the split between Collections and Tags is dragged to give the tags more room", async (ui) => {
	await ui.click("TAGS", { area: "sidebar", exact: true });
	await ui.see("Filter tags", { area: "sidebar" }).catch(() => undefined);
	const before = (await ui.see("TAGS", { area: "sidebar", exact: true })).y;
	await ui.drag({ x: 130, y: before - 16 }, { x: 130, y: before - 216 });
	await ui.expect("the Tags header moved up", async () => (await ui.findAll("TAGS", { area: "sidebar", exact: true }))[0]!.y < before - 100, true);
});
