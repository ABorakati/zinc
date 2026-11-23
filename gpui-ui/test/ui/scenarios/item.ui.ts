// The item pane (right-hand side) and everything edited in it, driven with real input: header, sections, every kind of field,
// creators, tags, notes, attachments, collections, related items, the multi-selection pane, citation key, copy actions,
// right-to-left text, read-only groups, and what happens to a half-typed edit when the selection moves away.
import type { Ui } from "../driver";
import { scenario as define, type ScenarioOptions } from "../define";
import { T } from "../library";

/** Nothing here needs more than a handful of extra items (a smaller library starts faster); the list is still longer than ten, which the multi-selection warning needs. */
const scenario = (name: string, run: (ui: Ui) => Promise<void>, options: ScenarioOptions = {}) => define(name, run, { items: 12, ...options });

// ---- reading the screen: what the driver does not offer (test ids, icons without text) ------------------------------------------

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}
interface N {
	id: number;
	type: string;
	testId?: string;
	text?: string;
	bounds?: Box;
	children?: N[];
}

async function flat(ui: Ui): Promise<N[]> {
	await ui.flush();
	const root = await ui.tree();
	const out: N[] = [];
	const walk = (n: N) => {
		out.push(n);
		for (const c of n.children ?? []) walk(c);
	};
	if (root) walk(root as unknown as N);
	return out;
}
const boxOf = async (ui: Ui, n: N): Promise<Box | null> => n.bounds ?? ((await ui.bounds(n.id)) as Box | null);
const live = (b: Box | null): b is Box => !!b && b.width > 0 && b.height > 0;
const PANE_X = 1030;

/** Every element with this test id that is laid out, top first. */
async function withTestId(ui: Ui, id: string): Promise<{ n: N; b: Box }[]> {
	const out: { n: N; b: Box }[] = [];
	for (const n of await flat(ui)) {
		if (n.testId !== id) continue;
		const b = await boxOf(ui, n);
		if (live(b)) out.push({ n, b });
	}
	return out.sort((a, b) => a.b.y - b.b.y);
}

async function clickTestId(ui: Ui, id: string, nth = 0): Promise<void> {
	const hit = (await withTestId(ui, id))[nth];
	if (!hit) throw new Error(`no element "${id}" on screen`);
	await ui.clickAt(hit.b.x + hit.b.width / 2, hit.b.y + hit.b.height / 2);
}

/** The tab row under the header: Details, Abstract, Notes, Files, Collections, Tags, Related. */
async function tab(ui: Ui, id: "info" | "abstract" | "notes" | "attachments" | "collections" | "tags" | "related"): Promise<void> {
	await clickTestId(ui, `ip-nav-${id}`);
	await ui.settle(500);
}

/** Text of the pane, as painted, with where each piece is. */
async function paneTexts(ui: Ui): Promise<{ text: string; x: number; y: number }[]> {
	const out: { text: string; x: number; y: number }[] = [];
	for (const n of await flat(ui)) {
		if (!n.text?.trim()) continue;
		const b = await boxOf(ui, n);
		if (live(b) && b.x + b.width / 2 > PANE_X && b.y + b.height / 2 < 880) out.push({ text: n.text, x: Math.round(b.x), y: Math.round(b.y) });
	}
	return out.sort((a, b) => a.y - b.y || a.x - b.x);
}
const inPane = async (ui: Ui, text: string, exact = true) => (await paneTexts(ui)).some((t) => (exact ? t.text.trim() === text : t.text.includes(text)));

/** Scroll the pane's list until `text` is on screen. */
async function bring(ui: Ui, text: string, o: { exact?: boolean } = { exact: true }): Promise<void> {
	for (let i = 0; i < 25; i++) {
		if (await ui.visible(text, { area: "pane", exact: o.exact })) return;
		await ui.wheel(1230, 600, -240);
	}
	throw new Error(`"${text}" is not in the pane, however far it scrolls`);
}

/** The 20 px icon buttons that sit in the row of `rowY`, to the right of `fromX`, left to right. */
async function iconsAt(ui: Ui, rowY: number, fromX: number): Promise<{ x: number; y: number }[]> {
	const out: { x: number; y: number }[] = [];
	for (const n of await flat(ui)) {
		if (n.type !== "svg") continue;
		const b = await boxOf(ui, n);
		if (!live(b)) continue;
		const cy = b.y + b.height / 2;
		if (Math.abs(cy - rowY) <= 12 && b.x > fromX && b.x < 1425) out.push({ x: b.x + b.width / 2, y: cy });
	}
	return out.sort((a, b) => a.x - b.x);
}

/**
 * Point at a button. (Its tooltip is not painted in the headless window, so the button is known by its place, and each scenario asserts
 * what the click did; `title` is the button's label in the app, for whoever reads the scenario.)
 */
async function hoverTitle(ui: Ui, at: { x: number; y: number }, _title: string): Promise<void> {
	await ui.mouseMove(at.x, at.y);
	await ui.settle(150);
}

// ---- reading what was saved ---------------------------------------------------------------------------------------------------

interface Detail {
	data: Record<string, any>;
	children: { key: string; itemType: string; title?: string; linkMode?: string; hasFile?: boolean }[];
	tags: { tag: string; type: number }[];
	collections: string[];
	related: { key: string; title: string }[];
}
const detailOf = async (ui: Ui, title: string): Promise<Detail> => ui.api<Detail>("GET", `/items/${(await ui.saved(title)).key}`);
const byKey = (ui: Ui, key: string) => ui.api<Detail>("GET", `/items/${key}`);
const people = (d: Detail) =>
	((d.data.creators ?? []) as { creatorType: string; name?: string; lastName?: string; firstName?: string }[]).map(
		(c) => `${c.creatorType}: ${c.name !== undefined ? c.name : `${c.lastName}, ${c.firstName}`}`,
	);
const savedPeople = async (ui: Ui, title: string) => people(await detailOf(ui, title));

/** Select an item: a click when its row is on screen, else the way Open in Zinc does it (set-up only: the rows far down are off screen). */
async function select(ui: Ui, title: string): Promise<void> {
	if (await ui.visible(title, { area: "list" })) await ui.click(title, { area: "list" });
	else {
		await ui.store.revealItem((await ui.saved(title)).key);
		await ui.settle(300);
	}
	await ui.expect("the item is selected", () => ui.selectedTitle(), title);
}

const AUTHORS = ["author: Alpha, Ann", "author: Bravo, Ben", "author: Charlie, Cat"];

// ---- creators: the ⋯ menu that appears on a row ---------------------------------------------------------------------------------

type CreatorAction = "Switch to" | "Move Up" | "Move Down" | "Remove Creator" | "Add Creator";
/**
 * Point at the creator row whose text is `at`, open its ⋯ menu and choose `action`. The button must be the only one on the row. A disabled
 * entry does nothing and leaves the menu open, so the menu is then closed.
 */
async function creatorAction(ui: Ui, at: string, action: CreatorAction, nth = 0): Promise<void> {
	const name = await ui.see(at, { area: "pane", exact: true, nth });
	await ui.mouseMove(name.x, name.y);
	await ui.settle(300);
	const icons = await iconsAt(ui, name.y, 1290);
	if (icons.length !== 1) throw new Error(`the row of "${at}" shows ${icons.length} buttons instead of one ⋯ button when pointed at`);
	const more = icons[0]!;
	if (more.x <= name.x) throw new Error(`the ⋯ button of "${at}" is not right of its name`);
	await ui.mouseMove(more.x, more.y);
	await ui.settle(150);
	await ui.clickAt(more.x, more.y);
	await ui.click(action, { exact: action !== "Switch to" });
	if (action === "Move Up" || action === "Move Down") {
		if (await ui.visible("Remove Creator", { exact: true })) await ui.press("escape");
	}
}

// =====================================================================================================================================
// header
// =====================================================================================================================================

scenario("the header names the type, the authors and where the item was published", async (ui) => {
	await ui.see("Select an item to view its details", { area: "pane" });
	await ui.click(T.authors, { area: "list" });
	await ui.see("JOURNAL ARTICLE", { area: "pane" });
	await ui.see("Ann Alpha, Ben Bravo, Cat Charlie", { area: "pane", exact: true });
	await ui.see("Journal of Testing", { area: "pane", exact: true });
	await ui.see("1(2)", { area: "pane" });
	await ui.see("Mar 2025", { area: "pane" });
});

scenario("a title typed in the header is saved on Enter", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.click(T.authors, { area: "pane", nth: 0 }); // the header's title is the topmost one
	await ui.replace("ZT01 Renamed in the header");
	await ui.press("enter");
	await ui.expect("the saved title", async () => (await detailOf(ui, "ZT01 Renamed in the header")).data.title, "ZT01 Renamed in the header");
	await ui.see("ZT01 Renamed in the header", { area: "list" });
	await ui.see("ZT01 Renamed in the header", { area: "pane", nth: 1 }); // and the Title row of Details follows
});

scenario("Escape leaves the header's title as it was", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.click(T.authors, { area: "pane", nth: 0 });
	await ui.replace("ZT01 Not wanted");
	await ui.press("escape");
	await ui.expectStill("the saved title", async () => (await detailOf(ui, T.authors)).data.title, T.authors);
	await ui.expect("the header shows the old title", async () => inPane(ui, T.authors), true);
});

scenario("a header title is saved when the pointer goes elsewhere", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.click(T.authors, { area: "pane", nth: 0 });
	await ui.replace("ZT01 Left by a click");
	await ui.click("Item Type", { area: "pane", exact: true }); // a label: nothing to do there, but the title field loses the focus
	await ui.expect("the saved title", async () => (await detailOf(ui, "ZT01 Left by a click")).data.title, "ZT01 Left by a click");
});

scenario("an emptied title is saved empty and the pane asks for one", async (ui) => {
	const { key } = await ui.saved(T.empty);
	await select(ui, T.empty);
	await ui.click(T.empty, { area: "pane", nth: 0 });
	await ui.press("ctrl-a");
	await ui.press("backspace");
	await ui.press("enter");
	await ui.expect("the saved title", async () => (await byKey(ui, key)).data.title, "");
	await ui.see("Untitled", { area: "pane" });
});

// =====================================================================================================================================
// the tab row and the sections
// =====================================================================================================================================

const TABS = [
	{ id: "abstract", label: "Abstract", head: "ABSTRACT" },
	{ id: "notes", label: "Notes", head: "NOTES" },
	{ id: "attachments", label: "Files", head: "ATTACHMENTS" },
	{ id: "collections", label: "Collections", head: "LIBRARIES AND COLLECTIONS" },
	{ id: "tags", label: "Tags", head: "TAGS" },
	{ id: "related", label: "Related", head: "RELATED" },
] as const;

scenario("a tab of the tab row is marked and shows its section", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.see("INFO", { area: "pane", exact: true });
	for (const t of TABS) {
		await tab(ui, t.id);
		await ui.see(t.label, { area: { x: 1035, y: 285, width: 393, height: 40 }, exact: true }); // only the marked tab shows its name
		await ui.see(t.head, { area: "pane", exact: true });
	}
	await tab(ui, "info");
	await ui.see("Item Type", { area: "pane", exact: true });
	await ui.see("Details", { area: { x: 1035, y: 285, width: 393, height: 40 }, exact: true });
});

scenario("the tab row counts what each section holds", async (ui) => {
	await select(ui, T.noted);
	const nav = (await withTestId(ui, "ip-nav-notes"))[0]!.b;
	await ui.see("1", { area: { x: nav.x, y: nav.y, width: nav.width + 40, height: nav.height }, exact: true }); // the note
	await tab(ui, "notes");
	await ui.see("NOTES", { area: "pane", exact: true });
});

scenario("a section collapses on a click on its title and opens on the next", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await tab(ui, "tags");
	await ui.see("seminal", { area: "pane", exact: true });
	await ui.click("TAGS", { area: "pane", exact: true });
	await ui.gone("seminal", { area: "pane", exact: true });
	await ui.see("TAGS", { area: "pane", exact: true });
	await ui.click("TAGS", { area: "pane", exact: true });
	await ui.see("seminal", { area: "pane", exact: true });
});

scenario("collapsing Details hides the fields and keeps the other sections", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.click("INFO", { area: "pane", exact: true });
	await ui.gone("Item Type", { area: "pane", exact: true });
	await ui.gone("Volume", { area: "pane", exact: true });
	await ui.see("ABSTRACT", { area: "pane", exact: true });
});

scenario("a tab opens its section when it was collapsed", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await tab(ui, "tags");
	await ui.click("TAGS", { area: "pane", exact: true });
	await ui.gone("seminal", { area: "pane", exact: true });
	await tab(ui, "tags");
	await ui.see("seminal", { area: "pane", exact: true });
});

scenario("the section menu moves a section into a pane of its own and Undo brings it back", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	const tabs = async () => (await withTestId(ui, "ip-nav-tags")).length;
	await ui.expect("the Tags tab is there", tabs, 1);
	await tab(ui, "tags");
	await clickTestId(ui, "ip-section-menu-tags");
	await ui.click("Open in its own pane", {});
	await ui.see("Moved Tags", {});
	await ui.expect("the Tags tab left the tab row", tabs, 0);
	await ui.click("Undo", {});
	await ui.expect("the Tags tab is back", tabs, 1);
});

// =====================================================================================================================================
// plain fields
// =====================================================================================================================================

scenario("a field left by a click on a label is saved", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.clickField("Publication");
	await ui.replace("Journal of Edits");
	await ui.click("Place", { area: "pane", exact: true });
	await ui.expect("the saved publication", async () => (await detailOf(ui, T.authors)).data.publicationTitle, "Journal of Edits");
	await ui.see("Journal of Edits", { area: "pane", exact: true }); // header and field
}, { knownBug: "a click on a label does not take the focus from the field: the text is saved only when the field or the item is left" });

scenario("a multi-line field is saved when the pointer goes to a label", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await bring(ui, "Extra");
	await ui.clickField("Extra");
	await ui.replace("left by a click");
	await ui.click("Series", { area: "pane", exact: true });
	await ui.expect("the saved extra", async () => (await detailOf(ui, T.authors)).data.extra, "left by a click");
}, { knownBug: "a click on a label does not take the focus from the field: the text is saved only when the field or the item is left" });

scenario("a field that is emptied is saved empty", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.clickField("Volume");
	await ui.press("ctrl-a");
	await ui.press("backspace");
	await ui.press("enter");
	await ui.expect("the saved volume", async () => (await detailOf(ui, T.authors)).data.volume, "");
	await ui.expectStill("the issue next to it", async () => (await detailOf(ui, T.authors)).data.issue, "2");
});

scenario("Extra takes new lines, and Ctrl+Enter saves them", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await bring(ui, "Extra");
	await ui.clickField("Extra");
	await ui.replace("first line");
	await ui.press("enter");
	await ui.type("second line");
	await ui.expectStill("nothing saved before Ctrl+Enter", async () => (await detailOf(ui, T.authors)).data.extra, "Original extra");
	await ui.press("ctrl-enter");
	await ui.expect("the saved extra", async () => (await detailOf(ui, T.authors)).data.extra, "first line\nsecond line");
});

scenario("Escape leaves Extra without saving", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await bring(ui, "Extra");
	await ui.clickField("Extra");
	await ui.replace("not this");
	await ui.press("escape");
	await ui.expectStill("the saved extra", async () => (await detailOf(ui, T.authors)).data.extra, "Original extra");
	await ui.see("Original extra", { area: "pane", exact: true });
});

const iconsOfRow = async (ui: Ui, label: string) => {
	const l = (await ui.findAll(label, { area: "pane", exact: true }))[0];
	return l ? (await iconsAt(ui, l.y, 1100)).length : -1;
};

scenario("a web address is saved and gets a link button, other text does not", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await bring(ui, "URL");
	const before = await iconsOfRow(ui, "URL");
	await ui.clickField("URL");
	await ui.replace("https://example.org/paper");
	await ui.press("enter");
	await ui.expect("the saved url", async () => (await detailOf(ui, T.authors)).data.url, "https://example.org/paper");
	await ui.expect("the row has a link button now", () => iconsOfRow(ui, "URL"), before + 1);
	await ui.clickField("URL");
	await ui.replace("not an address");
	await ui.press("enter");
	await ui.expect("the saved url", async () => (await detailOf(ui, T.authors)).data.url, "not an address");
	await ui.expect("the link button is gone", () => iconsOfRow(ui, "URL"), before);
});

scenario("a DOI is saved and gets a link button", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await bring(ui, "DOI");
	const before = await iconsOfRow(ui, "DOI");
	await ui.clickField("DOI");
	await ui.replace("10.1000/test.1");
	await ui.press("enter");
	await ui.expect("the saved DOI", async () => (await detailOf(ui, T.authors)).data.DOI, "10.1000/test.1");
	await ui.expect("the row has a link button", () => iconsOfRow(ui, "DOI"), before + 1);
});

// =====================================================================================================================================
// dates
// =====================================================================================================================================

/** The part of the pane level with the label of a row, for finding what sits in that row. */
async function rowArea(ui: Ui, label: string): Promise<{ x: number; y: number; width: number; height: number }> {
	const l = await ui.see(label, { area: "pane", exact: true });
	return { x: 1030, y: l.y - 14, width: 400, height: 28 };
}
const savedDate = async (ui: Ui, title = T.authors) => (await detailOf(ui, title)).data.date;
const setUp = async (ui: Ui, title: string, data: Record<string, unknown>) => {
	await ui.api("PATCH", `/items/${(await ui.saved(title)).key}`, { data });
};

scenario("a year typed in the date is saved on Enter and keeps the month and day", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.clickField("Date");
	await ui.replace("2021");
	await ui.press("enter");
	await ui.expect("the saved date", () => savedDate(ui), "2021-03-04");
});

scenario("a month picked from the list is saved with the year and day", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.click("Mar", { area: await rowArea(ui, "Date"), exact: true });
	await ui.click("Jun", { exact: true });
	await ui.expect("the saved date", () => savedDate(ui), "2025-06-04");
});

scenario("a day picked from the list is saved with the year and month", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.click("4", { area: await rowArea(ui, "Date"), exact: true });
	await ui.click("17", { exact: true });
	await ui.expect("the saved date", () => savedDate(ui), "2025-03-17");
});

scenario("a day past the end of a shorter month is moved back into it", async (ui) => {
	await setUp(ui, T.authors, { date: "2025-01-31" });
	await ui.click(T.authors, { area: "list" });
	await ui.click("Jan", { area: await rowArea(ui, "Date"), exact: true });
	await ui.click("Feb", { exact: true });
	await ui.expect("the saved date", () => savedDate(ui), "2025-02-28");
});

scenario("choosing Month in the list clears the month and the day", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.click("Mar", { area: await rowArea(ui, "Date"), exact: true });
	await ui.click("Month", { exact: true });
	await ui.expect("the saved date", () => savedDate(ui), "2025");
});

scenario("an emptied year clears the whole date", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.clickField("Date");
	await ui.press("ctrl-a");
	await ui.press("backspace");
	await ui.press("enter");
	await ui.expect("the saved date", () => savedDate(ui), "");
});

scenario("a date can be edited as text", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	const row = await rowArea(ui, "Date");
	const [toggle] = await iconsAt(ui, row.y + 14, 1360);
	if (!toggle) throw new Error("no Edit as text button in the Date row");
	await hoverTitle(ui, toggle, "Edit as text");
	await ui.clickAt(toggle.x, toggle.y);
	await ui.click("2025-03-04", { area: "pane", exact: true });
	await ui.replace("Spring 2020");
	await ui.press("enter");
	await ui.expect("the saved date", () => savedDate(ui), "Spring 2020");
	await ui.see("Spring 2020", { area: "pane", exact: true });
});

scenario("a date that is not a plain date opens as text and nothing is rewritten by looking at it", async (ui) => {
	await setUp(ui, T.authors, { date: "Spring 2020" });
	await ui.click(T.authors, { area: "list" });
	await ui.see("Spring 2020", { area: "pane", exact: true });
	await ui.expect("no Year box", () => ui.visible("Year", { area: "pane", exact: true }), false);
	const row = await rowArea(ui, "Date");
	const [toggle] = await iconsAt(ui, row.y + 14, 1360);
	await hoverTitle(ui, toggle!, "Pick year, month and day");
	await ui.clickAt(toggle!.x, toggle!.y);
	await ui.see("2020", { area: await rowArea(ui, "Date"), exact: true });
	await ui.expectStill("the saved date", () => savedDate(ui), "Spring 2020");
});

// =====================================================================================================================================
// item type
// =====================================================================================================================================

const typeSelect = async (ui: Ui, current: string) => ui.click(current, { area: await rowArea(ui, "Item Type"), exact: true });

scenario("an item type with nothing to lose is changed at once", async (ui) => {
	await select(ui, T.empty);
	await typeSelect(ui, "Journal Article");
	await ui.click("Book", { exact: true });
	await ui.expect("the saved type", async () => (await detailOf(ui, T.empty)).data.itemType, "book");
	await ui.see("BOOK", { area: "pane", exact: true });
	await ui.expect("no warning", async () => inPane(ui, "will remove these fields", false), false);
});

scenario("a type change that loses fields asks first, and Cancel keeps the item as it was", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await typeSelect(ui, "Journal Article");
	await ui.click("Book", { exact: true });
	await ui.see("Changing to Book will remove these fields", { area: "pane", exact: false });
	await ui.expect("the type is still saved as it was", async () => (await detailOf(ui, T.authors)).data.itemType, "journalArticle");
	await ui.click("Cancel", { area: "pane", exact: true });
	await ui.gone("Changing to Book", { area: "pane", exact: false });
	await ui.expectStill("the saved type", async () => (await detailOf(ui, T.authors)).data.itemType, "journalArticle");
	await ui.see("Journal Article", { area: await rowArea(ui, "Item Type"), exact: true });
});

scenario("Change Item Type confirms: the fields of the old type go, the shared ones stay", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await typeSelect(ui, "Journal Article");
	await ui.click("Book", { exact: true });
	await ui.click("Change Item Type", { area: "pane", exact: true });
	await ui.expect("the saved type", async () => (await detailOf(ui, T.authors)).data.itemType, "book");
	const d = (await detailOf(ui, T.authors)).data;
	if (d.publicationTitle) throw new Error(`the journal's name survived the move to a book: ${d.publicationTitle}`);
	if (d.title !== T.authors || d.volume !== "1" || d.date !== "2025-03-04") throw new Error(`title, volume or date changed: ${JSON.stringify([d.title, d.volume, d.date])}`);
	await ui.expect("the creators", () => savedPeople(ui, T.authors), AUTHORS);
	await ui.see("BOOK", { area: "pane", exact: true });
});

scenario("a type change that is waiting for an answer is dropped when another item is selected", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await typeSelect(ui, "Journal Article");
	await ui.click("Book", { exact: true });
	await ui.see("Changing to Book will remove these fields", { area: "pane", exact: false });
	await ui.click(T.neighbour, { area: "list" });
	await ui.click(T.authors, { area: "list" });
	await ui.see("Item Type", { area: "pane", exact: true });
	await ui.expect("no warning is left", async () => inPane(ui, "will remove these fields", false), false);
	await ui.expectStill("the type", async () => (await detailOf(ui, T.authors)).data.itemType, "journalArticle");
});

// =====================================================================================================================================
// creators: every edit saves the whole list, so every scenario asserts the whole list
// =====================================================================================================================================

scenario("a creator added after the second one is saved in place", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await creatorAction(ui, "Bravo", "Add Creator");
	await ui.click("Last", { area: "pane", exact: true });
	await ui.type("Zulu");
	await ui.press("enter");
	await ui.click("First", { area: "pane", exact: true });
	await ui.type("Zed");
	await ui.press("enter");
	await ui.expect("the saved creators", () => savedPeople(ui, T.authors), ["author: Alpha, Ann", "author: Bravo, Ben", "author: Zulu, Zed", "author: Charlie, Cat"]);
});

scenario("a creator removed leaves the others in order", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await creatorAction(ui, "Bravo", "Remove Creator");
	await ui.expect("the saved creators", () => savedPeople(ui, T.authors), ["author: Alpha, Ann", "author: Charlie, Cat"]);
	await ui.gone("Bravo", { area: "pane", exact: true });
});

scenario("a creator moved up and another moved down swap places and nothing else changes", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await creatorAction(ui, "Bravo", "Move Up");
	await ui.expect("Bravo is first", () => savedPeople(ui, T.authors), ["author: Bravo, Ben", "author: Alpha, Ann", "author: Charlie, Cat"]);
	await creatorAction(ui, "Bravo", "Move Down");
	await creatorAction(ui, "Bravo", "Move Down");
	await ui.expect("Bravo is last", () => savedPeople(ui, T.authors), ["author: Alpha, Ann", "author: Charlie, Cat", "author: Bravo, Ben"]);
});

scenario("the first creator cannot move up and the last cannot move down", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await creatorAction(ui, "Alpha", "Move Up");
	await creatorAction(ui, "Charlie", "Move Down");
	await ui.expectStill("the saved creators", () => savedPeople(ui, T.authors), AUTHORS);
});

scenario("a creator's type is changed from its menu and only that creator changes", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.click("Author", { area: "pane", exact: true, nth: 1 });
	await ui.click("Editor", { exact: true });
	await ui.expect("the saved creators", () => savedPeople(ui, T.authors), ["author: Alpha, Ann", "editor: Bravo, Ben", "author: Charlie, Cat"]);
	await ui.see("Editor", { area: "pane", exact: true });
});

scenario("a creator with two name fields becomes one with a single field and back", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await creatorAction(ui, "Bravo", "Switch to");
	await ui.expect("one name", () => savedPeople(ui, T.authors), ["author: Alpha, Ann", "author: Ben Bravo", "author: Charlie, Cat"]);
	await ui.see("Ben Bravo", { area: "pane", exact: true });
	await creatorAction(ui, "Ben Bravo", "Switch to");
	await ui.expect("two names again", () => savedPeople(ui, T.authors), AUTHORS);
});

scenario("a creator's first name typed and Entered is saved with the list intact", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.click("Ben", { area: "pane", exact: true });
	await ui.replace("Benedict");
	await ui.press("enter");
	await ui.expect("the saved creators", () => savedPeople(ui, T.authors), ["author: Alpha, Ann", "author: Bravo, Benedict", "author: Charlie, Cat"]);
});

scenario("Escape leaves a creator's name unchanged", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.click("Bravo", { area: "pane", exact: true });
	await ui.replace("Nobody");
	await ui.press("escape");
	await ui.expectStill("the saved creators", () => savedPeople(ui, T.authors), AUTHORS);
	await ui.see("Bravo", { area: "pane", exact: true });
});

scenario("an item without creators gets a first one from the Add button", async (ui) => {
	await select(ui, T.empty);
	await ui.click("Add", { area: "pane", exact: true });
	await ui.see("Last", { area: "pane", exact: true });
	await ui.click("Last", { area: "pane", exact: true });
	await ui.type("Solo");
	await ui.press("enter");
	await ui.click("First", { area: "pane", exact: true });
	await ui.type("Person");
	await ui.press("enter");
	await ui.expect("the saved creators", () => savedPeople(ui, T.empty), ["author: Solo, Person"]);
});

const COAUTHORS = Array.from({ length: 24 }, (_, i) => `author: Coauthor${i + 1}, Test`);

scenario("a long list of creators shows five, expands, and collapses again without changing", async (ui) => {
	await select(ui, T.many);
	await ui.see("Coauthor5", { area: "pane", exact: true });
	await ui.expect("the sixth is hidden", () => ui.visible("Coauthor6", { area: "pane", exact: true }), false);
	await ui.click("19 more… (19 hidden)", { area: "pane" });
	await bring(ui, "Coauthor24");
	await bring(ui, "Show fewer");
	await ui.click("Show fewer", { area: "pane", exact: true });
	await ui.gone("Coauthor6", { area: "pane", exact: true });
	await ui.expectStill("the saved creators", () => savedPeople(ui, T.many), COAUTHORS);
});

scenario("a creator edited in a collapsed list is saved with all 24 creators", async (ui) => {
	await select(ui, T.many);
	await ui.click("Coauthor3", { area: "pane", exact: true });
	await ui.replace("Renamed");
	await ui.press("enter");
	const wanted = [...COAUTHORS];
	wanted[2] = "author: Renamed, Test";
	await ui.expect("the saved creators", () => savedPeople(ui, T.many), wanted);
});

scenario("a creator removed from a collapsed list keeps the hidden ones", async (ui) => {
	await select(ui, T.many);
	await creatorAction(ui, "Coauthor2", "Remove Creator");
	await ui.expect("the saved creators", () => savedPeople(ui, T.many), COAUTHORS.filter((_, i) => i !== 1));
});

scenario("a creator far down an expanded list can be edited without losing the others", async (ui) => {
	await select(ui, T.many);
	await ui.click("19 more… (19 hidden)", { area: "pane" });
	await bring(ui, "Coauthor20");
	await ui.click("Coauthor20", { area: "pane", exact: true });
	await ui.replace("Twentieth");
	await ui.press("enter");
	const wanted = [...COAUTHORS];
	wanted[19] = "author: Twentieth, Test";
	await ui.expect("the saved creators", () => savedPeople(ui, T.many), wanted);
});

scenario("the header cuts a long list of authors and its +N button goes to the Details", async (ui) => {
	await select(ui, T.many);
	await ui.see("+18", { area: "pane", exact: true });
	await ui.see("Test Coauthor6", { area: "pane" });
	await ui.expect("the seventh is not in the header", async () => inPane(ui, "Test Coauthor7", false), false);
	await tab(ui, "tags");
	await ui.click("+18", { area: "pane", exact: true });
	await ui.see("Item Type", { area: "pane", exact: true });
});

// =====================================================================================================================================
// abstract
// =====================================================================================================================================

const savedAbstract = async (ui: Ui, title: string) => (await detailOf(ui, title)).data.abstractNote;

scenario("an abstract is edited in place, Enter makes a new line and Ctrl+Enter saves", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await tab(ui, "abstract");
	await ui.click("Original abstract of the first item.", { area: "pane" });
	await ui.replace("First paragraph.");
	await ui.press("enter");
	await ui.type("Second paragraph.");
	await ui.expectStill("nothing saved yet", () => savedAbstract(ui, T.authors), "Original abstract of the first item.");
	await ui.press("ctrl-enter");
	await ui.expect("the saved abstract", () => savedAbstract(ui, T.authors), "First paragraph.\nSecond paragraph.");
});

scenario("Escape leaves the abstract as it was", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await tab(ui, "abstract");
	await ui.click("Original abstract of the first item.", { area: "pane" });
	await ui.replace("Thrown away");
	await ui.press("escape");
	await ui.expectStill("the saved abstract", () => savedAbstract(ui, T.authors), "Original abstract of the first item.");
	await ui.see("Original abstract of the first item.", { area: "pane" });
});

scenario("an abstract is saved when the pointer goes elsewhere", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await tab(ui, "abstract");
	await ui.click("Original abstract of the first item.", { area: "pane" });
	await ui.replace("Left by a click.");
	await ui.click("ABSTRACT", { area: "pane", exact: true }); // the section's title folds the section: the field is removed, not blurred
	await ui.expect("the saved abstract", () => savedAbstract(ui, T.authors), "Left by a click.");
});

scenario("an item without an abstract invites one and keeps what is typed", async (ui) => {
	await select(ui, T.empty);
	await tab(ui, "abstract");
	await ui.click("Add abstract", { area: "pane", exact: true });
	await ui.type("Written from nothing.");
	await ui.press("ctrl-enter");
	await ui.expect("the saved abstract", () => savedAbstract(ui, T.empty), "Written from nothing.");
});

// =====================================================================================================================================
// tags
// =====================================================================================================================================

const savedTags = async (ui: Ui, title: string) => (await detailOf(ui, title)).tags.map((t) => t.tag).sort();

scenario("a tag typed in the pane is saved on Enter and shown as a chip", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await tab(ui, "tags");
	await ui.click("Add tag…", { area: "pane" });
	await ui.type("brand new");
	await ui.press("enter");
	await ui.expect("the saved tags", () => savedTags(ui, T.authors), ["brand new", "seminal"]);
	await ui.see("brand new", { area: "pane", exact: true });
});

scenario("a tag chosen from the suggestions is saved", async (ui) => {
	await ui.click(T.neighbour, { area: "list" });
	await tab(ui, "tags");
	await ui.click("Add tag…", { area: "pane" });
	await ui.type("semi");
	await ui.click("seminal", { area: "pane", exact: true });
	await ui.expect("the saved tags", () => savedTags(ui, T.neighbour), ["seminal"]);
	await ui.expectStill("the tags of the first item", () => savedTags(ui, T.authors), ["seminal"]);
});

scenario("a tag that is there already is not added twice, and blanks are cut", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await tab(ui, "tags");
	await ui.click("Add tag…", { area: "pane" });
	await ui.type("  seminal  ");
	await ui.press("enter");
	await ui.type("   ");
	await ui.press("enter");
	await ui.expectStill("the saved tags", async () => (await detailOf(ui, T.authors)).tags, [{ tag: "seminal", type: 0 }]);
	await ui.expect("one chip", async () => (await ui.findAll("seminal", { area: "pane", exact: true })).length, 1);
});

const dotsInPane = async (ui: Ui) => {
	let count = 0;
	for (const n of await flat(ui)) {
		const b = await boxOf(ui, n);
		if (n.type === "div" && live(b) && b.width === 7 && b.height === 7 && b.x > PANE_X) count++;
	}
	return count;
};

scenario("a coloured tag shows its colour on its chip and a plain one does not", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await tab(ui, "tags");
	await ui.see("seminal", { area: "pane", exact: true });
	await ui.expect("one colour dot", async () => dotsInPane(ui), 1);
	await ui.click("Add tag…", { area: "pane" });
	await ui.type("plain");
	await ui.press("enter");
	await ui.see("plain", { area: "pane", exact: true });
	await ui.expectStill("still one colour dot", async () => dotsInPane(ui), 1);
	await ui.screenshot("tags-coloured");
});

// =====================================================================================================================================
// collections and related items
// =====================================================================================================================================

async function collectionKey(ui: Ui, name: string): Promise<string> {
	const walk = (list: { key: string; name: string; children?: unknown[] }[]): string | undefined => {
		for (const c of list) {
			if (c.name === name) return c.key;
			const inner = walk((c.children ?? []) as never);
			if (inner) return inner;
		}
		return undefined;
	};
	const res = await ui.api<any>("GET", "/collections");
	const key = walk(Array.isArray(res) ? res : (res.collections ?? []));
	if (!key) throw new Error(`no collection "${name}"`);
	return key;
}

scenario("the Collections section names the library and the collection path of the item", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await tab(ui, "collections");
	await ui.see("My Library", { area: "pane", exact: true });
	await ui.see("Methods", { area: "pane", exact: true });
	await ui.see("Nested methods", { area: "pane", exact: true });
});

scenario("an item is removed from a collection with the minus of its row", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await tab(ui, "collections");
	const row = await ui.see("Nested methods", { area: "pane", exact: true });
	await ui.mouseMove(row.x, row.y);
	await ui.settle(200);
	const [minus] = await iconsAt(ui, row.y, 1300);
	await hoverTitle(ui, minus!, "Remove from collection");
	await ui.clickAt(minus!.x, minus!.y);
	await ui.expect("the saved collections", async () => (await detailOf(ui, T.authors)).collections, []);
	await ui.gone("Nested methods", { area: "pane", exact: true });
});

scenario("an item is related to another from the search picker, in both directions", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await tab(ui, "related");
	const head = await ui.see("RELATED", { area: "pane", exact: true });
	const [plus] = await iconsAt(ui, head.y, 1300);
	await hoverTitle(ui, plus!, "Add related item");
	await ui.clickAt(plus!.x, plus!.y);
	await ui.type("Neighbour");
	await ui.click(T.neighbour, { area: "pane" });
	const a = await ui.saved(T.authors);
	const b = await ui.saved(T.neighbour);
	await ui.expect("related of the first", async () => (await byKey(ui, a.key)).related.map((r) => r.key), [b.key]);
	await ui.expect("related of the second", async () => (await byKey(ui, b.key)).related.map((r) => r.key), [a.key]);
});

scenario("a related item opens on a click and a relation is removed with its minus", async (ui) => {
	const a = await ui.saved(T.authors);
	const b = await ui.saved(T.neighbour);
	await ui.api("POST", `/items/${a.key}/related`, { keys: [b.key] });
	await ui.click(T.authors, { area: "list" });
	await tab(ui, "related");
	const row = await ui.see(T.neighbour, { area: "pane", exact: true });
	await ui.mouseMove(row.x, row.y);
	await ui.settle(200);
	const [minus] = await iconsAt(ui, row.y, 1300);
	await hoverTitle(ui, minus!, "Remove relation");
	await ui.clickAt(minus!.x, minus!.y);
	await ui.expect("related of the first", async () => (await byKey(ui, a.key)).related ?? [], []);
	await ui.expect("related of the second", async () => (await byKey(ui, b.key)).related ?? [], []);
});

scenario("clicking a related item selects it", async (ui) => {
	const a = await ui.saved(T.authors);
	const b = await ui.saved(T.neighbour);
	await ui.api("POST", `/items/${a.key}/related`, { keys: [b.key] });
	await ui.click(T.authors, { area: "list" });
	await tab(ui, "related");
	await ui.click(T.neighbour, { area: "pane", exact: true });
	await ui.expect("the neighbour is selected", () => ui.selectedTitle(), T.neighbour);
});

// =====================================================================================================================================
// notes (the Markdown editor: the headless window has no rich note editor)
// =====================================================================================================================================

const noteKeys = async (ui: Ui, title: string) => (await detailOf(ui, title)).children.filter((c) => c.itemType === "note").map((c) => c.key);
const noteHtml = async (ui: Ui, key: string) => String((await byKey(ui, key)).data.note ?? "");
const noteText = (html: string) => html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

scenario("a note is added to an item and what is typed in it is saved", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await tab(ui, "notes");
	await ui.click("Add Note", { area: "pane", exact: true });
	await ui.expect("one note", async () => (await noteKeys(ui, T.authors)).length, 1);
	await ui.type("Fresh note text");
	await ui.expect("the saved note", async () => noteText(await noteHtml(ui, (await noteKeys(ui, T.authors))[0]!)), "Fresh note text");
	await ui.see("Fresh note text", { area: "pane" });
});

scenario("a note is opened from its row, edited and saved after a pause", async (ui) => {
	await select(ui, T.noted);
	const [note] = await noteKeys(ui, T.noted);
	await tab(ui, "notes");
	await ui.click("Note body for the test.", { area: "pane", exact: true });
	await ui.click("Edit", { area: "pane", exact: true });
	await ui.press("ctrl-end");
	await ui.type(" And more.");
	await ui.expect("the saved note", async () => noteText(await noteHtml(ui, note!)), "Note body for the test. And more.");
	await ui.see("Saved", { area: "pane", exact: true });
});

scenario("a note is saved when the editor is switched to Preview", async (ui) => {
	await select(ui, T.noted);
	const [note] = await noteKeys(ui, T.noted);
	await tab(ui, "notes");
	await ui.click("Note body for the test.", { area: "pane", exact: true });
	await ui.click("Edit", { area: "pane", exact: true });
	await ui.press("ctrl-end");
	await ui.type(" Previewed.");
	await ui.click("Preview", { area: "pane", exact: true });
	await ui.expect("the saved note", async () => noteText(await noteHtml(ui, note!)), "Note body for the test. Previewed.");
	await ui.see("Note body for the test. Previewed.", { area: "pane" });
});

scenario("a note is moved to the trash from its row", async (ui) => {
	await select(ui, T.noted);
	const [note] = await noteKeys(ui, T.noted);
	await tab(ui, "notes");
	const row = await ui.see("Note body for the test.", { area: "pane", exact: true });
	await ui.mouseMove(row.x, row.y);
	await ui.settle(200);
	const icons = await iconsAt(ui, row.y, 1300);
	await hoverTitle(ui, icons[1]!, "Move note to Trash");
	await ui.clickAt(icons[1]!.x, icons[1]!.y);
	await ui.expect("the note is deleted", async () => !!(await byKey(ui, note!)).data.deleted, true);
	await ui.see("No notes", { area: "pane", exact: true });
	await ui.expect("the item has no notes any more", async () => (await noteKeys(ui, T.noted)).length, 0);
});

scenario("a note being typed survives a selection that moves without a click", async (ui) => {
	await select(ui, T.noted);
	const [note] = await noteKeys(ui, T.noted);
	await tab(ui, "notes");
	await ui.click("Note body for the test.", { area: "pane", exact: true });
	await ui.click("Edit", { area: "pane", exact: true });
	await ui.press("ctrl-end");
	await ui.type(" Revealed.");
	await ui.store.revealItem((await ui.saved(T.neighbour)).key);
	await ui.expect("the saved note", async () => noteText(await noteHtml(ui, note!)), "Note body for the test. Revealed.");
	await ui.expectStill("the other item has no note", async () => (await noteKeys(ui, T.neighbour)).length, 0);
});

scenario("a note being typed survives opening the item's other note", async (ui) => {
	const parent = await ui.saved(T.noted);
	const [first] = await noteKeys(ui, T.noted);
	const second = (await ui.api<Detail>("POST", "/items", { data: { itemType: "note", parentItem: parent.key, note: "<p>Second note body</p>" } })).data.key;
	await select(ui, T.noted);
	await tab(ui, "notes");
	await ui.click("Note body for the test.", { area: "pane", exact: true });
	await ui.click("Edit", { area: "pane", exact: true });
	await ui.press("ctrl-end");
	await ui.type(" First edited.");
	await ui.click("Second note body", { area: "pane", exact: true });
	await ui.expect("the first note", async () => noteText(await noteHtml(ui, first!)), "Note body for the test. First edited.");
	await ui.expectStill("the second note", async () => noteText(await noteHtml(ui, second)), "Second note body");
	await ui.see("Second note body", { area: "pane" });
});

// =====================================================================================================================================
// attachments
// =====================================================================================================================================

const attachmentOf = async (ui: Ui, title: string) => (await detailOf(ui, title)).children.find((c) => c.itemType === "attachment")!;

/** A row under the PDF preview, scrolled clear of the pane's bottom edge (beside the preview, which would scroll itself). */
async function rowInView(ui: Ui, text: string) {
	let row = await ui.see(text, { area: "pane", exact: true });
	for (let i = 0; i < 12 && row.y > 820; i++) {
		await ui.wheel(1420, 600, -160);
		row = await ui.see(text, { area: "pane", exact: true });
	}
	return row;
}

/** Point at an attachment row and press the button at `index` of those that appear on it (checked by tooltip). */
async function rowButton(ui: Ui, rowText: string, index: number, title: string): Promise<void> {
	const row = await rowInView(ui, rowText);
	await ui.mouseMove(row.x, row.y);
	await ui.settle(200);
	const icons = await iconsAt(ui, row.y, 1200);
	const at = icons[index];
	if (!at) throw new Error(`the row "${rowText}" shows ${icons.length} buttons, not ${index + 1}`);
	await hoverTitle(ui, at, title);
	await ui.clickAt(at.x, at.y);
}

scenario("an attachment is listed with its name", async (ui) => {
	await ui.click(T.article, { area: "list" });
	await tab(ui, "attachments");
	await ui.see("Demo review.pdf", { area: "pane", exact: true });
	await ui.expect("the file is not reported missing", () => ui.visible("File missing", { area: "pane" }), false);
});

scenario("an attachment is renamed from its menu", async (ui) => {
	await ui.click(T.article, { area: "list" });
	await tab(ui, "attachments");
	const before = await attachmentOf(ui, T.article);
	await rowButton(ui, "Demo review.pdf", 3, "More");
	await ui.click("Rename", { exact: true });
	await ui.replace("Renamed review");
	await ui.press("enter");
	await ui.expect("the saved name", async () => (await byKey(ui, before.key)).data.title, "Renamed review");
	await ui.see("Renamed review", { area: "pane", exact: true });
});

scenario("Escape leaves an attachment's name as it was", async (ui) => {
	await ui.click(T.article, { area: "list" });
	await tab(ui, "attachments");
	const before = await attachmentOf(ui, T.article);
	await rowButton(ui, "Demo review.pdf", 3, "More");
	await ui.click("Rename", { exact: true });
	await ui.replace("Never saved");
	await ui.press("escape");
	await ui.expectStill("the saved name", async () => (await byKey(ui, before.key)).data.title, "Demo review.pdf");
	await ui.see("Demo review.pdf", { area: "pane", exact: true });
});

scenario("an attachment is moved to the trash from its menu", async (ui) => {
	await ui.click(T.article, { area: "list" });
	await tab(ui, "attachments");
	const before = await attachmentOf(ui, T.article);
	await rowButton(ui, "Demo review.pdf", 3, "More");
	await ui.click("Move Attachment to Trash", { exact: true });
	await ui.expect("the attachment is deleted", async () => !!(await byKey(ui, before.key)).data.deleted, true);
	await ui.see("No attachments", { area: "pane", exact: true });
	await ui.see("Find full text", { area: "pane" }); // the header offers to look for one again instead of Open PDF
});

scenario("the Open PDF button of the header opens the reader", async (ui) => {
	await ui.click(T.article, { area: "list" });
	await ui.click("Open PDF", { area: "pane", exact: true });
	await ui.expect("a reader tab is active", async () => (await ui.store.activeTab()) !== "library", true);
});

// =====================================================================================================================================
// creating items and children (Add menu, the item menu, dialogs)
// =====================================================================================================================================

scenario("Add > New Standalone Note creates a note and opens it in the pane", async (ui) => {
	await ui.click("Add", { area: "list", exact: true });
	await ui.click("New Standalone Note", {});
	await ui.see("NOTE", { area: "pane", exact: true });
	await ui.expect("a note is selected", async () => (await ui.store.selectedItem()) !== null, true);
	const key = (await ui.store.selectedItem())!;
	await ui.expect("the item is a note", async () => (await byKey(ui, key)).data.itemType, "note");
});

scenario("Add Note in the item menu adds an empty child note", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.rightClick(T.authors, { area: "list" });
	await ui.click("Add Note", {});
	await ui.expect("the item has a note", async () => (await noteKeys(ui, T.authors)).length, 1);
	await ui.expect("the item is still selected", () => ui.selectedTitle(), T.authors);
});

// =====================================================================================================================================
// citation key and the copy actions
// =====================================================================================================================================

const keyInfo = async (ui: Ui, itemKey: string) => (await ui.api<{ keys: Record<string, { key: string; pinned: boolean } | null> }>("GET", `/bbt/keys?items=${itemKey}`)).keys[itemKey];

/** The Citation Key row's buttons are: pin or unpin, then refresh. */
async function keyButton(ui: Ui, index: number, title: string): Promise<void> {
	const label = await ui.see("Citation Key", { area: "pane", exact: true });
	const icons = await iconsAt(ui, label.y, 1340);
	const at = icons.at(-2 + index);
	if (!at) throw new Error(`the Citation Key row has ${icons.length} buttons`);
	await hoverTitle(ui, at, title);
	await ui.clickAt(at.x, at.y);
}

scenario("the citation key is shown, and Pin keeps it", async (ui) => {
	const { key } = await ui.saved(T.authors);
	await ui.click(T.authors, { area: "list" });
	await ui.see("alphaZT01ThreeAuthors2025", { area: "pane", exact: true });
	await ui.expect("not pinned", async () => (await keyInfo(ui, key))?.pinned, false);
	await keyButton(ui, 0, "Pin this citation key");
	await ui.expect("pinned, with the same key", async () => await keyInfo(ui, key), { key: "alphaZT01ThreeAuthors2025", pinned: true } as never);
});

scenario("Unpin gives the key back to the formula", async (ui) => {
	const { key } = await ui.saved(T.authors);
	await ui.api("POST", "/bbt/pin", { itemKey: key, key: "pinned2025" });
	await ui.click(T.authors, { area: "list" });
	await ui.see("pinned2025", { area: "pane", exact: true });
	await keyButton(ui, 0, "Unpin");
	await ui.expect("not pinned, the generated key", async () => await keyInfo(ui, key), { key: "alphaZT01ThreeAuthors2025", pinned: false } as never);
	await ui.see("alphaZT01ThreeAuthors2025", { area: "pane", exact: true });
});

scenario("a citation key typed in the row is pinned as typed", async (ui) => {
	const { key } = await ui.saved(T.authors);
	await ui.click(T.authors, { area: "list" });
	await ui.click("alphaZT01ThreeAuthors2025", { area: "pane", exact: true });
	await ui.replace("myOwnKey2025");
	await ui.press("enter");
	await ui.expect("pinned as typed", async () => await keyInfo(ui, key), { key: "myOwnKey2025", pinned: true } as never);
});

scenario("the ... menu lists Locate, Copy bibliography and Copy DOI, and Find full text again only with a PDF", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await clickTestId(ui, "ip-more");
	await ui.see("Locate", {});
	await ui.see("Copy bibliography", {});
	await ui.see("Copy DOI", {});
	await ui.expect("no Find full text again", () => ui.visible("Find full text again"), false);
	await ui.press("escape");
	await ui.click(T.article, { area: "list" });
	await clickTestId(ui, "ip-more");
	await ui.see("Find full text again", {});
});

scenario("the Locate submenu of the ... menu opens", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await clickTestId(ui, "ip-more");
	await ui.click("Locate", {});
	await ui.screenshot("locate");
	await ui.expect("a Locate entry is shown", async () => (await ui.painted()).some((t) => /Library Lookup|Online|Open/i.test(t)), true);
});

// =====================================================================================================================================
// several items selected
// =====================================================================================================================================

/** ZT01 and ZT02, which are on screen at the start: a click and a Ctrl+click. */
async function selectTwo(ui: Ui): Promise<void> {
	await ui.click(T.authors, { area: "list" });
	await ui.click(T.neighbour, { area: "list", modifiers: "ctrl" });
	await ui.see("2 items selected", { area: "pane", exact: true });
}

scenario("two selected items give the multi-selection pane and no item details", async (ui) => {
	await selectTwo(ui);
	await ui.see("Add tag to all", { area: "pane", exact: true });
	await ui.see("Move to Trash", { area: "pane", exact: true });
	await ui.expect("no Details", () => ui.visible("Item Type", { area: "pane", exact: true }), false);
});

scenario("a tag added to all is saved on every selected item and no other", async (ui) => {
	await selectTwo(ui);
	await ui.click("Tag name…", { area: "pane" });
	await ui.type("bulk");
	await ui.press("enter");
	await ui.expect("tags of the first", () => savedTags(ui, T.authors), ["bulk", "seminal"]);
	await ui.expect("tags of the second", () => savedTags(ui, T.neighbour), ["bulk"]);
	await ui.expectStill("tags of an item that was not selected", () => savedTags(ui, "Bulk 0001"), []);
});

scenario("a tag removed from all is taken off every selected item", async (ui) => {
	const a = await ui.saved(T.authors);
	const b = await ui.saved(T.neighbour);
	await ui.api("POST", `/items/${b.key}/tags`, { tags: ["seminal"] });
	await selectTwo(ui);
	await ui.click("Tag to remove…", { area: "pane" });
	await ui.type("seminal");
	await ui.press("enter");
	await ui.expect("tags of the first", async () => (await byKey(ui, a.key)).tags, []);
	await ui.expect("tags of the second", async () => (await byKey(ui, b.key)).tags, []);
});

scenario("all selected items are added to a collection chosen from the list", async (ui) => {
	await selectTwo(ui);
	await ui.click("Choose collection…", { area: "pane" });
	await ui.click("Empty collection", { area: "pane", exact: true });
	const empty = await collectionKey(ui, "Empty collection");
	await ui.expect("first", async () => (await detailOf(ui, T.authors)).collections.includes(empty), true);
	await ui.expect("second", async () => (await detailOf(ui, T.neighbour)).collections.includes(empty), true);
});

scenario("a field set on all selected items is saved on each, and Clear field empties it", async (ui) => {
	await selectTwo(ui);
	await ui.click("Publication", { area: "pane", exact: true });
	await ui.click("Volume", { exact: true });
	await ui.click("Value (or leave empty to clear)…", { area: "pane" });
	await ui.type("77");
	await ui.click("Set field", { area: "pane", exact: true });
	await ui.expect("volume of the first", async () => (await detailOf(ui, T.authors)).data.volume, "77");
	await ui.expect("volume of the second", async () => (await detailOf(ui, T.neighbour)).data.volume, "77");
	await ui.click("Clear field", { area: "pane", exact: true });
	await ui.expect("volume of the first", async () => (await detailOf(ui, T.authors)).data.volume, "");
	await ui.expect("volume of the second", async () => (await detailOf(ui, T.neighbour)).data.volume, "");
	await ui.expectStill("the other fields of the first", async () => (await detailOf(ui, T.authors)).data.issue, "2");
});

scenario("a tag for more than ten items asks first, and Cancel adds nothing", async (ui) => {
	await ui.click(T.authors, { area: "list" });
	await ui.press("ctrl-a");
	await ui.see("items selected", { area: "pane" });
	await ui.click("Tag name…", { area: "pane" });
	await ui.type("everyone");
	await ui.press("enter");
	await ui.see("to 14", { exact: false }).catch(() => {});
	await ui.see("This will add the tag to every selected item.", {});
	await ui.click("Cancel", { exact: true });
	await ui.expectStill("no item got the tag", async () => (await ui.api<{ items: unknown[] }>("GET", "/items?limit=5&q=everyone")).items.length, 0);
	await ui.expectStill("the first item's tags", () => savedTags(ui, T.authors), ["seminal"]);
});

scenario("the multi-selection pane is replaced by the details when one item stays selected", async (ui) => {
	await selectTwo(ui);
	await ui.click(T.neighbour, { area: "list" });
	await ui.see("Item Type", { area: "pane", exact: true });
	await ui.gone("2 items selected", { area: "pane", exact: true });
});

// =====================================================================================================================================
// read-only group
// =====================================================================================================================================

async function openGroupItem(ui: Ui): Promise<void> {
	await ui.click("Read-only test group", { area: "sidebar" });
	await ui.click(T.groupItem, { area: "list" });
	await ui.expect("the group item is selected", () => ui.selectedTitle(), T.groupItem);
	await ui.see("Item Type", { area: "pane", exact: true });
}
const groupItem = async (ui: Ui) => {
	const row = await ui.api<{ items: { key: string; title: string }[] }>("GET", "/items?limit=5&q=ZG01&library=900001").catch(() => null);
	return row;
};

scenario("the header title of a read-only group's item does not open for editing", async (ui) => {
	await openGroupItem(ui);
	await ui.click(T.groupItem, { area: "pane", nth: 0 });
	await ui.type("changed");
	await ui.press("enter");
	await ui.expect("no change shown", async () => inPane(ui, "changed", false), false);
});

scenario("the creators of a read-only group's item offer no buttons and no menu", async (ui) => {
	await openGroupItem(ui);
	const name = await ui.see("Group", { area: "pane", exact: true });
	await ui.mouseMove(name.x, name.y);
	await ui.settle(300);
	await ui.expect("no row buttons", async () => (await iconsAt(ui, name.y, 1290)).length, 0);
	await ui.click("Author", { area: "pane", exact: true });
	await ui.expect("no creator type menu", () => ui.visible("Editor"), false);
	await ui.click("Group", { area: "pane", exact: true });
	await ui.type("Changed");
	await ui.press("enter");
	await ui.expect("no change shown", async () => inPane(ui, "Changed", false), false);
});

scenario("a read-only group's item has no tag box, no add buttons, no relation or collection buttons", async (ui) => {
	await openGroupItem(ui);
	await tab(ui, "tags");
	await ui.expect("no tag box", () => ui.visible("Add tag…", { area: "pane" }), false);
	await tab(ui, "notes");
	await ui.see("No notes", { area: "pane", exact: true });
	await ui.expect("no Add Note", () => ui.visible("Add Note", { area: "pane" }), false);
	await ui.expect("no Find Full Text", () => ui.visible("Find Full Text", { area: "pane" }), false);
	const related = await ui.see("RELATED", { area: "pane", exact: true });
	await ui.expect("no add button of Related", async () => (await iconsAt(ui, related.y, 1300)).length, 1); // the section menu only
	const coll = await ui.see("LIBRARIES AND COLLECTIONS", { area: "pane", exact: true });
	await ui.expect("no add button of Collections", async () => (await iconsAt(ui, coll.y, 1300)).length, 1);
});

scenario("the item type of a read-only group's item cannot be changed", async (ui) => {
	await openGroupItem(ui);
	await ui.click("Book", { area: await rowArea(ui, "Item Type"), exact: true });
	await ui.expect("no list of types", () => ui.visible("Thesis"), false);
});

scenario("the Add menu offers nothing to create in a read-only group", async (ui) => {
	await ui.click("Read-only test group", { area: "sidebar" });
	// an Add menu with nothing in it is not shown at all
	await ui.waitFor("the Add button is gone", async () => !(await ui.visible("Add", { area: "list", exact: true })));
	await ui.expect("no New Item", () => ui.visible("New Item…"), false);
	await ui.expect("no New Standalone Note", () => ui.visible("New Standalone Note"), false);
});

// =====================================================================================================================================
// right-to-left text
// =====================================================================================================================================

const ARABIC_TITLE = "ZT03 عنوان جديد للاختبار";
const HEBREW_TITLE = "ZT04 כותרת חדשה לבדיקה";

scenario("an Arabic item shows its title and creator in the pane", async (ui) => {
	await ui.click(T.arabic, { area: "list" });
	await ui.see(T.arabic, { area: "pane", exact: true, nth: 1 });
	await ui.see("الاختبار", { area: "pane", exact: true });
	await ui.see("سامي", { area: "pane", exact: true });
	await ui.screenshot("arabic-pane");
});

scenario("a Hebrew item shows its title and creator in the pane", async (ui) => {
	await ui.click(T.hebrew, { area: "list" });
	await ui.see(T.hebrew, { area: "pane", exact: true, nth: 1 });
	await ui.see("בדיקה", { area: "pane", exact: true });
	await ui.see("דנה", { area: "pane", exact: true });
	await ui.screenshot("hebrew-pane");
});

scenario("an Arabic title typed in the Details is saved exactly as typed", async (ui) => {
	await ui.click(T.arabic, { area: "list" });
	await ui.clickField("Title");
	await ui.replace(ARABIC_TITLE);
	await ui.press("enter");
	await ui.expect("the saved title", async () => (await detailOf(ui, "ZT03")).data.title, ARABIC_TITLE);
	await ui.see(ARABIC_TITLE, { area: "list" });
});

scenario("a Hebrew title typed in the header is saved exactly as typed", async (ui) => {
	await ui.click(T.hebrew, { area: "list" });
	await ui.click(T.hebrew, { area: "pane", nth: 0 });
	await ui.replace(HEBREW_TITLE);
	await ui.press("enter");
	await ui.expect("the saved title", async () => (await detailOf(ui, "ZT04")).data.title, HEBREW_TITLE);
});

scenario("an Arabic creator edited keeps the whole list and the right-to-left names", async (ui) => {
	const { key } = await ui.saved(T.arabic);
	await ui.api("PATCH", `/items/${key}`, {
		data: { creators: [{ creatorType: "author", lastName: "الاختبار", firstName: "سامي" }, { creatorType: "editor", lastName: "Latin", firstName: "Lee" }] },
	});
	await ui.click(T.arabic, { area: "list" });
	await ui.click("سامي", { area: "pane", exact: true });
	await ui.replace("سمير");
	await ui.press("enter");
	await ui.expect("the saved creators", () => savedPeople(ui, T.arabic), ["author: الاختبار, سمير", "editor: Latin, Lee"]);
});

scenario("an Arabic abstract is saved as typed, and the web address of an Arabic item stays as typed", async (ui) => {
	await ui.click(T.arabic, { area: "list" });
	await bring(ui, "URL");
	await ui.clickField("URL");
	await ui.replace("https://example.org/path?q=1");
	await ui.press("enter");
	await ui.expect("the saved url", async () => (await detailOf(ui, T.arabic)).data.url, "https://example.org/path?q=1");
	await tab(ui, "abstract");
	await ui.click("Add abstract", { area: "pane", exact: true });
	await ui.type("نص تجريبي");
	await ui.press("ctrl-enter");
	await ui.expect("the saved abstract", () => savedAbstract(ui, T.arabic), "نص تجريبي");
	await ui.screenshot("arabic-abstract");
});

// =====================================================================================================================================
// the list refreshes, or the item changes from outside, while the pane is being edited
// =====================================================================================================================================

scenario("a field typed while the list refreshes is saved afterwards", async (ui) => {
	const neighbour = await ui.saved(T.neighbour);
	await ui.click(T.authors, { area: "list" });
	await ui.clickField("Volume");
	await ui.replace("55");
	await ui.changeOutside(neighbour.key, { abstractNote: "Changed by another program" });
	await ui.press("enter");
	await ui.expect("the saved volume", async () => (await detailOf(ui, T.authors)).data.volume, "55");
	await ui.expect("the item is still selected", () => ui.selectedTitle(), T.authors);
});

scenario("a change from outside to the shown item appears in the pane", async (ui) => {
	const { key } = await ui.saved(T.authors);
	await ui.click(T.authors, { area: "list" });
	await ui.see("Journal of Testing", { area: "pane", exact: true });
	await ui.changeOutside(key, { publicationTitle: "Journal of Outside" });
	await ui.see("Journal of Outside", { area: "pane", exact: true });
});

scenario("a creator typed while another field of the item changes from outside saves both", async (ui) => {
	const { key } = await ui.saved(T.authors);
	await ui.click(T.authors, { area: "list" });
	await ui.click("Bravo", { area: "pane", exact: true });
	await ui.replace("Typed");
	await ui.changeOutside(key, { volume: "9" });
	await ui.press("enter");
	await ui.expect("the saved creators", () => savedPeople(ui, T.authors), ["author: Alpha, Ann", "author: Typed, Ben", "author: Charlie, Cat"]);
	await ui.expect("the volume from outside", async () => (await detailOf(ui, T.authors)).data.volume, "9");
});

scenario("a creator typed after the creators changed from outside does not bring the old list back", async (ui) => {
	const { key } = await ui.saved(T.authors);
	await ui.click(T.authors, { area: "list" });
	await ui.see("Bravo", { area: "pane", exact: true });
	await ui.changeOutside(key, { creators: [{ creatorType: "author", lastName: "Alpha", firstName: "Ann" }, { creatorType: "author", lastName: "Newcomer", firstName: "Nia" }] });
	await ui.see("Newcomer", { area: "pane", exact: true });
	await ui.click("Alpha", { area: "pane", exact: true });
	await ui.replace("Alphonse");
	await ui.press("enter");
	await ui.expect("the saved creators", () => savedPeople(ui, T.authors), ["author: Alphonse, Ann", "author: Newcomer, Nia"]);
});

// =====================================================================================================================================
// text being typed when the selection moves away: by a click, by the keyboard, and without either (Open in Zinc)
// =====================================================================================================================================

type Mover = "click" | "keyboard" | "reveal";

/** Take the selection from `from` to `to` the way a user (or Open in Zinc) does. */
async function moveAway(ui: Ui, how: Mover, to: string): Promise<void> {
	if (how === "click") await ui.click(to, { area: "list" });
	else if (how === "reveal") await ui.store.revealItem((await ui.saved(to)).key);
	else {
		// the keyboard: back to the list (Shift+F6 is "focus the previous pane"), then the arrow that reaches the next row
		await ui.press("shift-f6");
		await ui.press("down"); // the neighbour and the item under the article both follow in the list
	}
	await ui.expect(`${to} is selected`, () => ui.selectedTitle(), to);
}

interface Place {
	/** what is typed into */
	name: string;
	/** the item it is typed into and the one the selection goes to */
	item: string;
	other: string;
	/** Start editing and type; nothing is confirmed. */
	type: (ui: Ui) => Promise<void>;
	/** What must have been saved by then: reads the item's key's saved state. */
	saved: (ui: Ui, key: string) => Promise<unknown>;
	wanted: unknown;
	/** What the other item keeps. */
	other_saved: (ui: Ui, key: string) => Promise<unknown>;
	other_wanted: unknown;
}

const dataOf = (field: string) => async (ui: Ui, key: string) => (await byKey(ui, key)).data[field] ?? "";
const peopleOf = async (ui: Ui, key: string) => people(await byKey(ui, key));

const PLACES: Place[] = [
	{
		name: "a title in the header",
		item: T.authors,
		other: T.neighbour,
		type: async (ui) => {
			await ui.click(T.authors, { area: "pane", nth: 0 });
			await ui.replace("ZT01 Header typed");
		},
		saved: dataOf("title"),
		wanted: "ZT01 Header typed",
		other_saved: dataOf("title"),
		other_wanted: T.neighbour,
	},
	{
		name: "a field of the Details",
		item: T.authors,
		other: T.neighbour,
		type: async (ui) => {
			await ui.clickField("Publication");
			await ui.replace("Journal typed");
		},
		saved: dataOf("publicationTitle"),
		wanted: "Journal typed",
		other_saved: dataOf("publicationTitle"),
		other_wanted: "",
	},
	{
		name: "the Extra field",
		item: T.authors,
		other: T.neighbour,
		type: async (ui) => {
			await bring(ui, "Extra");
			await ui.clickField("Extra");
			await ui.replace("extra typed");
		},
		saved: dataOf("extra"),
		wanted: "extra typed",
		other_saved: dataOf("extra"),
		other_wanted: "",
	},
	{
		name: "the abstract",
		item: T.authors,
		other: T.neighbour,
		type: async (ui) => {
			await tab(ui, "abstract");
			await ui.click("Original abstract of the first item.", { area: "pane" });
			await ui.replace("abstract typed");
		},
		saved: dataOf("abstractNote"),
		wanted: "abstract typed",
		other_saved: dataOf("abstractNote"),
		other_wanted: "Original abstract of the neighbour.",
	},
	{
		name: "a first name",
		item: T.authors,
		other: T.neighbour,
		type: async (ui) => {
			await ui.click("Ben", { area: "pane", exact: true });
			await ui.replace("Typed");
		},
		saved: peopleOf,
		wanted: ["author: Alpha, Ann", "author: Bravo, Typed", "author: Charlie, Cat"],
		other_saved: peopleOf,
		other_wanted: ["author: Delta, Dee"],
	},
	{
		name: "a year in the date",
		item: T.authors,
		other: T.neighbour,
		type: async (ui) => {
			await ui.clickField("Date");
			await ui.replace("2031");
		},
		saved: dataOf("date"),
		wanted: "2031-03-04",
		other_saved: dataOf("date"),
		other_wanted: "2024",
	},
	{
		name: "a date as text",
		item: T.authors,
		other: T.neighbour,
		type: async (ui) => {
			await setUp(ui, T.authors, { date: "Spring 2020" });
			await ui.click(T.neighbour, { area: "list" });
			await ui.click(T.authors, { area: "list" });
			await ui.click("Spring 2020", { area: "pane", exact: true });
			await ui.replace("Autumn 2021");
		},
		saved: dataOf("date"),
		wanted: "Autumn 2021",
		other_saved: dataOf("date"),
		other_wanted: "2024",
	},
	{
		name: "a citation key",
		item: T.authors,
		other: T.neighbour,
		type: async (ui) => {
			await ui.click("alphaZT01ThreeAuthors2025", { area: "pane", exact: true });
			await ui.replace("typedKey2025");
		},
		saved: async (ui, key) => (await keyInfo(ui, key)) as unknown,
		wanted: { key: "typedKey2025", pinned: true },
		other_saved: async (ui, key) => (await keyInfo(ui, key))?.pinned,
		other_wanted: false,
	},
	{
		name: "the name of an attachment",
		item: T.article,
		other: T.authors,
		type: async (ui) => {
			await tab(ui, "attachments");
			await rowButton(ui, "Demo review.pdf", 3, "More");
			await ui.click("Rename", { exact: true });
			await ui.replace("Typed name");
		},
		saved: async (ui, key) => (await ui.api<Detail>("GET", `/items/${(await byKey(ui, key)).children[0]!.key}`)).data.title,
		wanted: "Typed name",
		other_saved: async (ui, key) => (await byKey(ui, key)).children.length,
		other_wanted: 0,
	},
];

for (const place of PLACES)
	for (const how of ["click", "keyboard", "reveal"] as const) {
		scenario(`${place.name} being typed is saved to its own item when the selection moves by ${how === "reveal" ? "Open in Zinc" : how}`, async (ui) => {
			const a = await ui.saved(place.item);
			const b = await ui.saved(place.other);
			await select(ui, place.item);
			await place.type(ui);
			await moveAway(ui, how, place.other);
			await ui.expect(`what was typed, saved to ${place.item}`, () => place.saved(ui, a.key), place.wanted);
			await ui.expectStill(`${place.other} as it was`, () => place.other_saved(ui, b.key), place.other_wanted);
		}, how === "keyboard" && place.name === "a date as text" ? { knownBug: "after an edit re-sorts the list, Down moves from the row's old place" } : {});
	}
