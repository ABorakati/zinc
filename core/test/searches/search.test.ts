import { beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { listItems, openDb } from "../../src/db";
import { rebuildSearchIndex } from "../../src/search";
import { compileSearch, parseDateValue, parseInTheLast } from "../../src/searches/compile";
import type { SearchCondition, SearchOptions } from "../../src/searches/types";
import { call, insertAttachment, insertItem, tempDir } from "../fixture";

let db: Database;
const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");

beforeAll(() => {
	db = openDb(join(tempDir(), "s.sqlite"));
	insertItem(db, {
		key: "AAAAAAA1",
		itemType: "journalArticle",
		title: "Deep learning for radiology",
		creators: [
			{ creatorType: "author", firstName: "Ann", lastName: "Smith" },
			{ creatorType: "author", firstName: "Bob", lastName: "Jones" },
		],
		date: "2020-05-01",
		abstractNote: "We study neural networks applied to chest imaging.",
		publicationTitle: "Journal of Medical AI",
		tags: [{ tag: "ml" }, { tag: "imaging" }],
		collections: ["COLLAAA1"],
		dateAdded: "2024-03-01T00:00:00Z",
	});
	insertItem(db, { key: "NOTE0001", itemType: "note", note: "<p>Great <b>transformer</b> paper</p>", parentItem: "AAAAAAA1" }, "AAAAAAA1");
	insertAttachment(db, "ATT00001", "AAAAAAA1", "text/html", null);
	insertAttachment(db, "ATT00002", "AAAAAAA1", "application/pdf", null);
	db.query("INSERT INTO fulltext(attachment_key, content, source, indexed_at) VALUES('ATT00002', ?, 'zotero-cache', '2024-01-01T00:00:00Z')").run(
		"convolutional segmentation of pulmonary nodules in lung scans",
	);
	insertItem(db, {
		key: "BBBBBBB2",
		itemType: "book",
		title: "Surgical anatomy",
		creators: [{ creatorType: "author", firstName: "Cara", lastName: "Brown" }],
		date: "2018",
		tags: [{ tag: "imaging" }],
		dateAdded: "2024-02-01T00:00:00Z",
	});
	insertItem(db, { key: "CCCCCCC3", itemType: "journalArticle", title: "Trashed article about zebras", dateAdded: "2024-01-15T00:00:00Z" }, undefined, 1);
	insertItem(db, {
		key: "DDDDDDD4",
		itemType: "journalArticle",
		title: "Zebra genetics",
		creators: [
			{ creatorType: "author", lastName: "Lee" },
			{ creatorType: "author", lastName: "Kim" },
		],
		date: "March 2022",
		dateAdded: "2024-04-01T00:00:00Z",
	});
	insertItem(db, {
		key: "EEEEEEE5",
		itemType: "conferencePaper",
		title: "Paper on kidneys",
		proceedingsTitle: "Kidney Congress",
		DOI: "10.1/xyz",
		date: "2021-11-15",
		dateAdded: daysAgo(2),
	});
	insertItem(db, { key: "FFFFFFF6", itemType: "note", note: "<p>standalone zebra note</p>", dateAdded: "2023-06-01T00:00:00Z" });
	insertItem(db, { key: "GGGGGGG7", itemType: "journalArticle", title: "Obscure findings", date: "2019", dateAdded: "2023-01-01T00:00:00Z" });
	insertItem(db, { key: "NOTE0002", itemType: "note", note: "<p>rare keyword quokka</p>", parentItem: "GGGGGGG7" }, "GGGGGGG7");
	db.query("INSERT INTO collections(key, name) VALUES('COLLAAA1', 'Radiology')").run();
	db.query("INSERT INTO collections(key, name, parent_key) VALUES('COLLAAA2', 'Sub', 'COLLAAA1')").run();
	db.query("INSERT INTO collection_items VALUES('COLLAAA1', 'AAAAAAA1')").run();
	db.query("INSERT INTO collection_items VALUES('COLLAAA2', 'BBBBBBB2')").run();
	rebuildSearchIndex(db);
});

const cond = (field: string, operator: SearchCondition["operator"], value: string): SearchCondition => ({ field, operator, value });
const run = (conditions: SearchCondition[], options: Partial<SearchOptions> = {}) =>
	listItems(db, { searchDef: { conditions, options: options as SearchOptions }, sort: "title", dir: "asc", limit: 100 })
		.items.map((i) => i.key)
		.sort();
const K = (...n: number[]) => n.map((x) => String.fromCharCode(64 + x).repeat(7) + x).sort();

test("title operators", () => {
	expect(run([cond("title", "contains", "radiology")])).toEqual(K(1));
	expect(run([cond("title", "is", "SURGICAL ANATOMY")])).toEqual(K(2));
	expect(run([cond("title", "beginsWith", "zebra")])).toEqual(K(4));
	expect(run([cond("title", "doesNotContain", "zebra")])).toEqual(K(1, 2, 5, 7)); // the standalone note's title is its text
	expect(run([cond("title", "isNot", "Zebra genetics")])).toContain("AAAAAAA1");
	expect(run([cond("title", "contains", "100%")])).toEqual([]); // LIKE wildcards are escaped
});

test("creator operators", () => {
	expect(run([cond("creator", "contains", "smith")])).toEqual(K(1));
	expect(run([cond("creator", "is", "Jones")])).toEqual(K(1));
	expect(run([cond("creator", "is", "Ann Smith")])).toEqual(K(1));
	expect(run([cond("creator", "is", "Smith, Ann")])).toEqual(K(1));
	expect(run([cond("creator", "beginsWith", "Kim")])).toEqual(K(4));
	expect(run([cond("creator", "doesNotContain", "Smith")])).not.toContain("AAAAAAA1");
});

test("year and date", () => {
	expect(run([cond("year", "is", "2018")])).toEqual(K(2));
	expect(run([cond("year", "isBefore", "2020")])).toEqual(K(2, 7));
	expect(run([cond("year", "isAfter", "2020")])).toEqual(K(4, 5));
	expect(run([cond("date", "is", "2020-05-01")])).toEqual(K(1));
	expect(run([cond("date", "is", "2020")])).toEqual(K(1)); // coarser value matches within the year
	expect(run([cond("date", "isBefore", "2020-01-01")])).toEqual(K(2, 7));
	expect(run([cond("date", "isAfter", "2021-06")])).toEqual(K(4, 5)); // 'March 2022' falls back to its year
	expect(run([cond("date", "isAfter", "May 2020")])).toEqual(K(4, 5));
	expect(() => run([cond("date", "is", "someday")])).toThrow();
	expect(() => run([cond("year", "is", "abc")])).toThrow();
});

test("dateAdded / dateModified", () => {
	expect(run([cond("dateAdded", "isAfter", "2024-02-15")])).toEqual(K(1, 4, 5));
	expect(run([cond("dateAdded", "isBefore", "2024-02-15")])).toEqual(K(2, 6, 7));
	expect(run([cond("dateAdded", "is", "2024-03-01")])).toEqual(K(1));
	expect(run([cond("dateAdded", "is", "2024-03")])).toEqual(K(1));
	expect(run([cond("dateAdded", "isInTheLast", "7 days")])).toEqual(K(5));
	expect(run([cond("dateModified", "isInTheLast", "1 year")])).toEqual(K(5));
	expect(run([cond("dateAdded", "isInTheLast", "10 years")]).length).toBe(6);
	expect(() => run([cond("dateAdded", "isInTheLast", "soon")])).toThrow();
	expect(parseDateValue("1 May 2020")).toBe("2020-05-01");
	expect(parseDateValue("2020/5/3")).toBe("2020-05-03");
	expect(parseInTheLast("1 week", new Date("2024-01-08T00:00:00Z"))).toBe("2024-01-01T00:00:00Z");
	expect(parseInTheLast("2 months", new Date("2024-03-15T00:00:00Z"))).toBe("2024-01-15T00:00:00Z");
});

test("schema fields and base-field mapping", () => {
	expect(run([cond("publicationTitle", "contains", "kidney")])).toEqual(K(5)); // proceedingsTitle -> publicationTitle
	expect(run([cond("publicationTitle", "beginsWith", "Journal of")])).toEqual(K(1));
	expect(run([cond("DOI", "is", "10.1/xyz")])).toEqual(K(5));
	expect(run([cond("doi", "contains", "xyz")])).toEqual(K(5)); // field names are case-insensitive
	expect(run([cond("abstractNote", "contains", "chest")])).toEqual(K(1));
	expect(run([cond("itemType", "is", "book")])).toEqual(K(2));
	expect(run([cond("itemType", "isNot", "journalArticle")])).toEqual(K(2, 5, 6));
});

test("tags", () => {
	expect(run([cond("tag", "is", "ML")])).toEqual(K(1));
	expect(run([cond("tag", "is", "imaging")])).toEqual(K(1, 2));
	expect(run([cond("tag", "isNot", "imaging")])).toEqual(K(4, 5, 6, 7));
	expect(run([cond("tag", "contains", "mag")])).toEqual(K(1, 2));
	expect(run([cond("tag", "beginsWith", "m")])).toEqual(K(1));
	expect(run([cond("tag", "doesNotContain", "mag")])).toEqual(K(4, 5, 6, 7));
});

test("match all vs any", () => {
	const cs = [cond("tag", "is", "imaging"), cond("year", "is", "2018")];
	expect(run(cs, { match: "all" })).toEqual(K(2));
	expect(run(cs, { match: "any" })).toEqual(K(1, 2));
	expect(run([cond("tag", "is", "imaging"), cond("creator", "contains", "kim")], { match: "any" })).toEqual(K(1, 2, 4));
});

test("collections and subcollections", () => {
	expect(run([cond("collection", "is", "COLLAAA1")])).toEqual(K(1));
	expect(run([cond("collection", "is", "COLLAAA1")], { searchSubcollections: true })).toEqual(K(1, 2));
	expect(run([cond("collection", "is", "Radiology")], { searchSubcollections: true })).toEqual(K(1, 2)); // by name
	expect(run([cond("collection", "is", "0_COLLAAA2")])).toEqual(K(2)); // Zotero-style libraryID_key
	expect(run([cond("collection", "isNot", "COLLAAA1")], { searchSubcollections: true })).toEqual(K(4, 5, 6, 7));
	expect(run([cond("collection", "is", "NOPE")])).toEqual([]);
});

test("notes, attachments and full text", () => {
	expect(run([cond("note", "contains", "transformer")])).toEqual(K(1)); // child note lifts its parent
	expect(run([cond("note", "contains", "transformer")], { topLevelOnly: true })).toEqual([]);
	expect(run([cond("note", "contains", "quokka")])).toEqual(K(7));
	expect(run([cond("note", "contains", "standalone")])).toEqual(K(6)); // standalone note
	expect(run([cond("note", "doesNotContain", "transformer")])).not.toContain("AAAAAAA1");
	expect(run([cond("attachmentFileType", "is", "pdf")])).toEqual(K(1));
	expect(run([cond("attachmentFileType", "is", "snapshot")])).toEqual(K(1));
	expect(run([cond("attachmentFileType", "is", "audio")])).toEqual([]);
	expect(run([cond("attachmentFileType", "isNot", "pdf")])).not.toContain("AAAAAAA1");
	expect(run([cond("attachmentFileType", "is", "application/pdf")])).toEqual(K(1));
	expect(() => run([cond("attachmentFileType", "is", "bogus")])).toThrow();
	expect(run([cond("fulltextContent", "contains", "pulmonary nodules")])).toEqual(K(1));
	expect(run([cond("fulltextContent", "contains", "pulmon*")])).toEqual(K(1));
	expect(run([cond("fulltextContent", "contains", "quokka")])).toEqual([]); // note text is not full text
	expect(run([cond("fulltextContent", "doesNotContain", "pulmonary")])).not.toContain("AAAAAAA1");
});

test("anyField", () => {
	expect(run([cond("anyField", "contains", "chest imaging")])).toEqual(K(1)); // abstract
	expect(run([cond("anyField", "contains", "ml")])).toContain("AAAAAAA1"); // tag
	expect(run([cond("anyField", "contains", "jones")])).toEqual(K(1)); // creator
	expect(run([cond("anyField", "is", "10.1/xyz")])).toEqual(K(5));
	expect(run([cond("anyField", "contains", "journalArticle")])).toEqual([]); // itemType value is not a field
	expect(run([cond("anyField", "doesNotContain", "chest")])).not.toContain("AAAAAAA1");
});

test("trash option", () => {
	expect(run([cond("title", "contains", "zebras")])).toEqual([]);
	expect(run([cond("title", "contains", "zebras")], { includeTrash: true })).toEqual(K(3));
	expect(run([cond("title", "contains", "zebra")], { includeTrash: true })).toEqual(K(3, 4, 6));
});

test("include parent and child items", () => {
	// 'att ATT00002' is an attachment title
	expect(run([cond("title", "contains", "att ATT00002")])).toEqual([]);
	expect(run([cond("title", "contains", "att ATT00002")], { includeParentsAndChildren: true })).toEqual(K(1));
	expect(run([cond("title", "contains", "att ATT00002")], { includeParentsAndChildren: true, topLevelOnly: true })).toEqual([]);
	// conditions may be met by different family members only when children are included
	const split = [cond("title", "contains", "att ATT00002"), cond("tag", "is", "ml")];
	expect(run(split, { includeParentsAndChildren: true })).toEqual(K(1));
	expect(run(split)).toEqual([]);
});

test("blank conditions are ignored; no usable conditions match nothing", () => {
	expect(run([cond("title", "contains", "radiology"), cond("tag", "is", "   ")])).toEqual(K(1));
	expect(run([cond("title", "contains", "")])).toEqual([]);
	expect(run([])).toEqual([]);
	expect(compileSearch(db, { conditions: [], options: {} as SearchOptions }).empty).toBe(true);
});

test("hostile input is bound as a parameter or rejected", () => {
	const evil = `'); DROP TABLE items; --`;
	expect(run([cond("title", "contains", evil)])).toEqual([]);
	expect(run([cond("tag", "is", evil)])).toEqual([]);
	expect(run([cond("anyField", "contains", evil)])).toEqual([]);
	expect(run([cond("fulltextContent", "contains", `" OR ""="`)])).toEqual([]);
	expect(db.query("SELECT count(*) AS n FROM items").get()).toEqual({ n: 11 });
	expect(() => run([cond("title') OR 1=1 --", "is", "x")])).toThrow();
	expect(() => run([{ field: "title", operator: "is; DROP" as any, value: "x" }])).toThrow();
	expect(() => run([cond("year", "contains", "x"), cond("tag", "isBefore", "x")])).toThrow(); // tag has no isBefore
	expect(() => run([cond("creator", "isBefore", "x")])).toThrow();
});

// ---------------------------------------------------------------- saved searches + API

test("saved search CRUD over HTTP", async () => {
	let res = await call(db, "POST", "/api/searches", { name: "  Imaging  ", conditions: [cond("tag", "is", "imaging")], options: { match: "all" } });
	expect(res.status).toBe(201);
	const created = await res.json();
	expect(created.key).toMatch(/^[0-9A-Z]{8}$/);
	expect(created.name).toBe("Imaging");
	expect(created.options.match).toBe("all");

	res = await call(db, "GET", "/api/searches");
	expect((await res.json()).map((s: any) => s.key)).toContain(created.key);

	res = await call(db, "GET", `/api/searches/${created.key}`);
	expect((await res.json()).conditions).toEqual([cond("tag", "is", "imaging")]);

	res = await call(db, "PATCH", `/api/searches/${created.key}`, { name: "Imaging 2" });
	expect((await res.json()).name).toBe("Imaging 2");
	res = await call(db, "PATCH", `/api/searches/${created.key}`, { conditions: [cond("year", "is", "2018")], options: { includeTrash: true } });
	const patched = await res.json();
	expect(patched.conditions[0].field).toBe("year");
	expect(patched.options.includeTrash).toBe(true);
	expect(patched.name).toBe("Imaging 2");

	res = await call(db, "GET", `/api/items?search=${created.key}`);
	expect((await res.json()).items.map((i: any) => i.key)).toEqual(["BBBBBBB2"]);

	res = await call(db, "DELETE", `/api/searches/${created.key}`);
	expect(res.status).toBe(200);
	expect((await call(db, "GET", `/api/searches/${created.key}`)).status).toBe(404);
	expect((await call(db, "DELETE", `/api/searches/${created.key}`)).status).toBe(404);
	expect((await call(db, "GET", `/api/items?search=${created.key}`)).status).toBe(404);
});

test("saved search validation", async () => {
	for (const body of [
		{ name: "", conditions: [cond("tag", "is", "x")] },
		{ name: "x", conditions: [] },
		{ name: "x", conditions: [cond("tag", "is", "")] },
		{ name: "x", conditions: [cond("nope", "is", "x")] },
		{ name: "x", conditions: [cond("date", "is", "garbage")] },
		{ name: "x", conditions: [cond("tag", "is", "x")], options: { match: "some" } },
		{ name: "x", conditions: "tag" },
	]) {
		expect((await call(db, "POST", "/api/searches", body)).status).toBe(400);
	}
	expect((await call(db, "PATCH", "/api/searches/NOSUCHKY", { name: "n" })).status).toBe(404);
	expect((await call(db, "PUT", "/api/searches", {})).status).toBe(405);
});

test("POST /api/searches/run", async () => {
	const res = await call(db, "POST", "/api/searches/run", {
		conditions: [cond("year", "isAfter", "2000")],
		options: { match: "all" },
		sort: "year",
		dir: "asc",
		limit: 2,
		offset: 1,
		include: ["tags"],
	});
	const body = await res.json();
	expect(body.total).toBe(5); // A1 B2 D4 E5 G7 (the standalone note has no year)
	expect(body.items.map((i: any) => i.key)).toEqual(["GGGGGGG7", "AAAAAAA1"]); // 2019, 2020 after skipping 2018
	expect(body.items[1].tags.map((t: any) => t.tag).sort()).toEqual(["imaging", "ml"]);
});

test("listItems({search}) pages and sorts the saved results", async () => {
	const s = await (await call(db, "POST", "/api/searches", { name: "All years", conditions: [cond("year", "isAfter", "1900")] })).json();
	const all = listItems(db, { search: s.key, sort: "title", dir: "asc", limit: 100 });
	expect(all.total).toBe(all.items.length);
	expect(all.items.map((i) => i.title)).toEqual([...all.items.map((i) => i.title)].sort((a, b) => a.localeCompare(b)));
	const p1 = listItems(db, { search: s.key, sort: "title", dir: "asc", limit: 2, offset: 0 });
	const p2 = listItems(db, { search: s.key, sort: "title", dir: "asc", limit: 2, offset: 2 });
	expect(p1.total).toBe(all.total);
	expect([...p1.items, ...p2.items].map((i) => i.key)).toEqual(all.items.slice(0, 4).map((i) => i.key));
	const desc = listItems(db, { search: s.key, sort: "year", dir: "desc", limit: 100 });
	const years = desc.items.map((i) => i.year!);
	expect(years).toEqual([...years].sort((a, b) => b - a));
	// combines with the other list filters
	const tagged = listItems(db, { search: s.key, tag: "imaging", sort: "title", limit: 100 });
	expect(tagged.items.map((i) => i.key).sort()).toEqual(K(1, 2));
	const q = listItems(db, { search: s.key, q: "anatomy", limit: 100 });
	expect(q.items.map((i) => i.key)).toEqual(K(2));
	expect(listItems(db, { search: s.key, collection: "COLLAAA1", limit: 100 }).total).toBe(1);
	await call(db, "DELETE", `/api/searches/${s.key}`);
});

test("quick search modes", () => {
	const q = (text: string, qmode?: string) => listItems(db, { q: text, qmode, limit: 100 }).items.map((i) => i.key).sort();
	expect(q("smith")).toEqual(K(1));
	expect(q("ml")).toEqual([]); // default mode: title, creator, year only
	expect(q("ml", "titleCreatorYear")).toEqual([]);
	expect(q("ml", "fields")).toEqual(K(1));
	expect(q("chest imaging", "fields")).toEqual(K(1));
	expect(q("kidney 10.1", "fields")).toEqual(K(5)); // every word, any field
	expect(q("pulmonary", "fields")).toEqual([]);
	expect(q("pulmonary", "everything")).toEqual(K(1)); // full text
	expect(q("quokka", "everything")).toEqual(K(7)); // child note
	expect(q("transformer smith", "everything")).toEqual(K(1));
	expect(q("2018", "titleCreatorYear")).toEqual(K(2));
	expect(() => q("x", "bogus")).toThrow();
});

test("/api/items accepts qmode and rejects a bad one", async () => {
	let res = await call(db, "GET", "/api/items?q=pulmonary&qmode=everything");
	expect((await res.json()).total).toBe(1);
	res = await call(db, "GET", "/api/items?q=pulmonary&qmode=nope");
	expect(res.status).toBe(400);
});
