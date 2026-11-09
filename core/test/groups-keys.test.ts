import { beforeEach, describe, expect, test } from "bun:test";
import { upsertGroupLibrary } from "../src/libraries";
import { rebuildSearchIndex } from "../src/search";
import { buildFixture, call, insertAttachment, insertItem, type Fixture } from "./fixture";

// Groupings beyond year / itemType / publication: first author, date added / modified (by month), has PDF, language, publisher.
// Base fixture top-level items (added, creators, attachments): AAAAAAA1 2024-03 Smith+Jones, pdf + html; BBBBBBB2 2024-02 Brown, none;
// DDDDDDD4 2024-04 Lee+Kim+Park, epub. CCCCCCC3 is in the trash.
let fx: Fixture;
let groupLib: number;
beforeEach(() => {
	fx = buildFixture();
	insertItem(fx.db, {
		key: "EEEEEEE5", itemType: "journalArticle", title: "Editor first",
		creators: [{ creatorType: "editor", lastName: "Zane" }, { creatorType: "author", lastName: "smith" }],
		language: "en", publisher: "Elsevier", tags: [{ tag: "x" }], dateAdded: "2023-12-15T00:00:00Z", dateModified: "2025-01-06T00:00:00Z",
	});
	insertItem(fx.db, {
		key: "FFFFFFF6", itemType: "book", title: "Single field",
		creators: [{ creatorType: "author", name: "WHO" }],
		language: "EN", publisher: "elsevier", dateAdded: "2023-12-20T00:00:00Z",
	});
	// no creators, no language / publisher; its only attachment is in the trash
	insertItem(fx.db, { key: "GGGGGGG7", itemType: "book", title: "Bare", dateAdded: "2024-04-02T00:00:00Z" });
	insertAttachment(fx.db, "ATT00007", "GGGGGGG7", "application/pdf", null);
	fx.db.query("UPDATE items SET deleted = 1 WHERE key = 'ATT00007'").run();
	// only an editor; its only attachment is a link
	insertItem(fx.db, {
		key: "HHHHHHH8", itemType: "book", title: "Editor only", creators: [{ creatorType: "editor", lastName: "Ed" }],
		language: "fr", publisher: "Springer", tags: [{ tag: "x" }], dateAdded: "2024-03-10T00:00:00Z", dateModified: "2025-01-05T00:00:00Z",
	});
	insertAttachment(fx.db, "ATT00008", "HHHHHHH8", "text/html", null);
	fx.db.query("UPDATE attachments SET link_mode = 'linked_url' WHERE item_key = 'ATT00008'").run();
	// a top-level PDF attachment is itself "has a PDF"
	insertItem(fx.db, { key: "IIIIIII9", itemType: "attachment", title: "Loose pdf", contentType: "application/pdf", linkMode: "imported_file", dateAdded: "2024-03-20T00:00:00Z" });
	fx.db.query("INSERT INTO attachments(item_key, link_mode, content_type, path) VALUES('IIIIIII9', 'imported_file', 'application/pdf', NULL)").run();
	// a group library item with its own author / month / language
	insertItem(fx.db, { key: "JJJJJJJ0", itemType: "book", title: "Group book", creators: [{ creatorType: "author", lastName: "Zebra" }], language: "de", dateAdded: "2020-01-01T00:00:00Z" });
	groupLib = upsertGroupLibrary(fx.db, { groupId: 100, name: "G", editable: true, filesEditable: true, version: 1 }).id;
	fx.db.query("UPDATE items SET library_id = ? WHERE key = 'JJJJJJJ0'").run(groupLib);
	fx.db.query("INSERT INTO collection_items VALUES('COLLAAA1', 'FFFFFFF6')").run();
	fx.db.query("INSERT INTO collection_items VALUES('COLLAAA1', 'HHHHHHH8')").run();
	rebuildSearchIndex(fx.db);
});

const j = async (r: Response) => (await r.json()) as any;
const list = async (q: string) => await j(await call(fx.db, "GET", `/api/items?${q}`));
const groups = async (q: string) => (await j(await call(fx.db, "GET", `/api/items/groups?${q}`))).groups as { value: string | null; count: number }[];
const lower = (g: { value: string | null; count: number }[]) => g.map((x) => [x.value?.toLowerCase() ?? null, x.count]);

// Walk the list in group order (the way the UI lays headers out) and return the item keys of each group.
async function slices(by: string, dir: string, filter = "") {
	const g = await groups(`by=${by}&dir=${dir}${filter}`);
	const l = await list(`sort=${by}&dir=${dir}&limit=1000${filter}`);
	expect(g.reduce((n, x) => n + x.count, 0)).toBe(l.total);
	let off = 0;
	return g.map((x) => {
		const keys = l.items.slice(off, off + x.count).map((i: any) => i.key as string).sort();
		off += x.count;
		return { value: x.value, keys };
	});
}

describe("first author", () => {
	test("last name of the first author (editors only when there is no author), merged case-insensitively, No author last", async () => {
		expect(lower(await groups("by=firstAuthor&dir=asc"))).toEqual([["brown", 1], ["ed", 1], ["lee", 1], ["smith", 2], ["who", 1], [null, 2]]);
		expect(lower(await groups("by=firstAuthor&dir=desc"))).toEqual([[ "who", 1], ["smith", 2], ["lee", 1], ["ed", 1], ["brown", 1], [null, 2]]);
	});
	test("groups are contiguous in the list sorted by the same key", async () => {
		for (const dir of ["asc", "desc"]) {
			const s = await slices("firstAuthor", dir);
			const byValue = Object.fromEntries(s.map((x) => [x.value?.toLowerCase() ?? "null", x.keys]));
			expect(byValue.smith).toEqual(["AAAAAAA1", "EEEEEEE5"]);
			expect(byValue.null).toEqual(["GGGGGGG7", "IIIIIII9"]);
			expect(byValue.ed).toEqual(["HHHHHHH8"]);
			expect(s[s.length - 1]!.value).toBeNull();
		}
	});
});

describe("date added / date modified by month", () => {
	test("YYYY-MM groups, newest first by default order, oldest first ascending", async () => {
		expect(await groups("by=dateAdded&dir=desc")).toEqual([
			{ value: "2024-04", count: 2 }, { value: "2024-03", count: 3 }, { value: "2024-02", count: 1 }, { value: "2023-12", count: 2 },
		]);
		expect((await groups("by=dateAdded&dir=asc")).map((x) => x.value)).toEqual(["2023-12", "2024-02", "2024-03", "2024-04"]);
		expect(await groups("by=dateModified&dir=desc")).toEqual([
			{ value: "2025-01", count: 2 }, { value: "2024-04", count: 2 }, { value: "2024-03", count: 2 }, { value: "2024-02", count: 1 }, { value: "2023-12", count: 1 },
		]);
	});
	test("groups are contiguous in the list sorted by the full timestamp", async () => {
		for (const by of ["dateAdded", "dateModified"]) {
			for (const dir of ["asc", "desc"]) {
				const s = await slices(by, dir);
				expect(s.flatMap((x) => x.keys).sort()).toEqual(["AAAAAAA1", "BBBBBBB2", "DDDDDDD4", "EEEEEEE5", "FFFFFFF6", "GGGGGGG7", "HHHHHHH8", "IIIIIII9"]);
			}
		}
		const s = await slices("dateAdded", "desc");
		expect(s.map((x) => x.keys)).toEqual([["DDDDDDD4", "GGGGGGG7"], ["AAAAAAA1", "HHHHHHH8", "IIIIIII9"], ["BBBBBBB2"], ["EEEEEEE5", "FFFFFFF6"]]);
	});
});

describe("has PDF", () => {
	test("0 = PDF (child or the item itself), 1 = other file, null = no file (trashed and link-only attachments do not count), No file last", async () => {
		expect(await groups("by=hasPdf&dir=asc")).toEqual([{ value: "0", count: 2 }, { value: "1", count: 1 }, { value: null, count: 5 }]);
		expect(await groups("by=hasPdf&dir=desc")).toEqual([{ value: "1", count: 1 }, { value: "0", count: 2 }, { value: null, count: 5 }]);
		const s = await slices("hasPdf", "asc");
		expect(s.map((x) => x.keys)).toEqual([["AAAAAAA1", "IIIIIII9"], ["DDDDDDD4"], ["BBBBBBB2", "EEEEEEE5", "FFFFFFF6", "GGGGGGG7", "HHHHHHH8"]]);
		await slices("hasPdf", "desc");
	});
});

describe("language and publisher", () => {
	test("case-insensitive merge, empty last", async () => {
		expect(lower(await groups("by=language&dir=asc"))).toEqual([["en", 2], ["fr", 1], [null, 5]]);
		expect(lower(await groups("by=language&dir=desc"))).toEqual([["fr", 1], ["en", 2], [null, 5]]);
		expect(lower(await groups("by=publisher&dir=asc"))).toEqual([["elsevier", 2], ["springer", 1], [null, 5]]);
		const s = await slices("publisher", "desc");
		expect(s[0]!.keys).toEqual(["HHHHHHH8"]);
		expect(s[1]!.keys).toEqual(["EEEEEEE5", "FFFFFFF6"]);
		await slices("language", "asc");
	});
});

describe("scoping and filters", () => {
	test("library_id: a group library has its own groups and My Library's never include it", async () => {
		expect(lower(await groups(`by=language&dir=asc&library=${groupLib}`))).toEqual([["de", 1]]);
		expect(await groups(`by=dateAdded&dir=desc&library=${groupLib}`)).toEqual([{ value: "2020-01", count: 1 }]);
		expect(await groups(`by=firstAuthor&dir=asc&library=${groupLib}`)).toEqual([{ value: "Zebra", count: 1 }]);
		expect(await groups(`by=hasPdf&dir=asc&library=${groupLib}`)).toEqual([{ value: null, count: 1 }]);
		expect((await groups("by=language&dir=asc")).some((x) => x.value === "de")).toBe(false);
		await slices("firstAuthor", "asc", `&library=${groupLib}`);
	});
	test("tag, collection, search and trash filters", async () => {
		expect(lower(await groups("by=firstAuthor&dir=asc&tag=x"))).toEqual([["ed", 1], ["smith", 1]]);
		expect(await groups("by=dateAdded&dir=desc&tag=x")).toEqual([{ value: "2024-03", count: 1 }, { value: "2023-12", count: 1 }]);
		expect(lower(await groups("by=language&dir=asc&collection=COLLAAA1"))).toEqual([["en", 1], ["fr", 1], [null, 1]]);
		expect(await groups("by=hasPdf&dir=asc&collection=COLLAAA1")).toEqual([{ value: "0", count: 1 }, { value: null, count: 2 }]);
		expect(lower(await groups("by=firstAuthor&dir=asc&q=zebra"))).toEqual([["lee", 1]]);
		await slices("firstAuthor", "desc", "&q=zebra");
		await slices("publisher", "asc", "&tag=x");
		expect(await groups("by=dateAdded&dir=desc&trash=1")).toEqual([{ value: "2024-01", count: 1 }]);
		expect(await groups("by=hasPdf&dir=asc&trash=1")).toEqual([{ value: null, count: 1 }]);
	});
	test("sort keys behave as list sorts too, and the existing four are unchanged", async () => {
		const l = await list("sort=hasPdf&dir=asc&limit=1000");
		expect(l.items.slice(0, 3).map((i: any) => i.key).sort()).toEqual(["AAAAAAA1", "DDDDDDD4", "IIIIIII9"]);
		const y = await groups("by=year&dir=desc");
		expect(y.reduce((n, x) => n + x.count, 0)).toBe((await list("limit=1000")).total);
		expect((await call(fx.db, "GET", "/api/items/groups?by=creator")).status).toBe(400);
	});
});
