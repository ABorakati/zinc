// Ported from zotero/zotero test/tests/searchTest.js @ a14e76b358c88779e293f03e56e7900a5b6c4ad6 (AGPL-3.0, see README.md).
// Subject: zotero-next's advanced-search conditions (core/src/searches/compile.ts, run through listItems on a temp database).
// Test names are the upstream ones; each upstream test builds items with createDataObject and searches with Zotero.Search,
// here the same items go into a temp library and the same condition is compiled by compileSearch.
// zotero-next conditions are a flat list (match all/any), without Zotero's nested groups, cross-level (annotation) scopes,
// isEmpty/isNotEmpty or relative dates ("today"); those upstream tests are todos.
import { beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { listItems, openDb } from "../../src/db";
import { rebuildSearchIndex } from "../../src/search";
import type { SearchCondition, SearchOptions } from "../../src/searches/types";
import { insertAttachment, insertItem, tempDir } from "../fixture";

let db: Database;
const KEYS = new Map<string, string>(); // label -> key
let seq = 0;
function add(label: string, data: Record<string, unknown> & { itemType?: string }): string {
	const key = `ZC${String(++seq).padStart(6, "0")}`;
	insertItem(db, { itemType: "journalArticle", ...data, key } as any);
	KEYS.set(label, key);
	return key;
}
const cond = (field: string, operator: SearchCondition["operator"], value: string): SearchCondition => ({ field, operator, value });
const search = (conditions: SearchCondition[], options: Partial<SearchOptions> = {}): string[] =>
	listItems(db, { searchDef: { conditions, options: options as SearchOptions }, sort: "title", dir: "asc", limit: 1000 }).items.map((i) => i.key).sort();
const ids = (...labels: string[]) => labels.map((l) => KEYS.get(l)!).sort();

beforeAll(() => {
	db = openDb(join(tempDir(), "compat-search.sqlite"));
	add("review", { title: "T1", publicationTitle: "Review of Finance" });
	add("revue", { title: "T2", publicationTitle: "Revue de Séance" });
	add("seance", { title: "zdiaséance" });
	add("resume", { title: "zdiaresume" });
	add("etienne", { title: "T3", creators: [{ creatorType: "author", firstName: "Étiennezdia", lastName: "Müllerzdia" }] });
	add("tag", { title: "T4", tags: [{ tag: "résumézdia" }] });
	add("greek", { title: "zdiaΘΕΜΑ" });
	add("ligatures", { title: "zdiasøren œuvre ﬁle x² ½ straße" });
	add("smallcaps", { title: 'The <span style="font-variant:small-caps;">zdiadrosophila</span> genome' });
	add("quoted", { title: "zdia“pp. 10–12”" });
	add("emdash", { title: "zdiamind—body problem" });
	add("ja", { title: "zdiaがん" });
	add("patent1", { itemType: "patent", title: "P1", filingDate: "2019-06-08" });
	add("patent2", { itemType: "patent", title: "P2", filingDate: "2021-01-15" });
	add("patent3", { itemType: "patent", title: "P3", filingDate: "Foo" });
	add("byTitle", { title: "a ztcyabc b" });
	add("byCreator", { title: "T5", creators: [{ creatorType: "author", lastName: "ztcyabc", firstName: "X" }] });
	add("byOther", { title: "T6", abstractNote: "a ztcyabc b" });
	add("inColl", { title: "In collection" });
	add("inSub", { title: "In subcollection" });
	add("loose", { title: "Not in a collection" });
	add("audio", { itemType: "audioRecording", title: "A1", label: "Some Label" });
	add("book", { itemType: "book", title: "B1", publisher: "Some Label" });
	db.query("INSERT INTO collections(key, name) VALUES('COLLAAA1', 'Parent')").run();
	db.query("INSERT INTO collections(key, name, parent_key) VALUES('COLLAAA2', 'Child', 'COLLAAA1')").run();
	db.query("INSERT INTO collections(key, name) VALUES('COLLAAA3', 'Empty')").run();
	db.query("INSERT INTO collection_items VALUES('COLLAAA1', ?)").run(KEYS.get("inColl")!);
	db.query("INSERT INTO collection_items VALUES('COLLAAA2', ?)").run(KEYS.get("inSub")!);
	insertAttachment(db, "ATTZC001", KEYS.get("inColl")!, "text/html", null);
	rebuildSearchIndex(db);
});

describe("Zotero.Search", () => {
	describe("#search()", () => {
		describe("Conditions", () => {
			describe("Nested condition groups", () => {
				test.todo("should match A AND (B OR C): conditions are a flat list in zotero-next");
				test.todo("should match A OR (B AND C): conditions are a flat list in zotero-next");
				test.todo("should match nested groups A AND (B OR (C AND D)): conditions are a flat list in zotero-next");
			});

			describe("Cross-level scope", () => {
				test.todo("should match a top-level item by a condition on a descendant annotation: annotations are not searchable");
			});

			describe("collection", () => {
				test("should find item in collection", () => {
					expect(search([cond("collection", "is", "COLLAAA1")])).toEqual(ids("inColl"));
				});

				test("should find items not in collection", () => {
					const notIn = search([cond("collection", "isNot", "COLLAAA1")]);
					expect(notIn).not.toContain(KEYS.get("inColl")!);
					expect(notIn).toContain(KEYS.get("loose")!);
					expect(notIn).toContain(KEYS.get("inSub")!);
				});

				test("shouldn't find item in collection with no items", () => {
					expect(search([cond("collection", "is", "COLLAAA3")])).toEqual([]);
				});

				test("should find item in subcollection in recursive mode", () => {
					expect(search([cond("collection", "is", "COLLAAA1")], { searchSubcollections: true })).toEqual(ids("inColl", "inSub"));
				});

				test("should return no results for a collection that doesn't exist in recursive mode", () => {
					expect(search([cond("collection", "is", "NOSUCHKY")], { searchSubcollections: true })).toEqual([]);
				});
			});

			describe("tag", () => {
				test("should match annotation with tag", () => {
					// upstream matches an annotation by its tag; here: an item by its tag
					expect(search([cond("tag", "is", "résumézdia")])).toEqual(ids("tag"));
				});
			});

			describe("is", () => {
				test("should match a value in a different case", () => {
					expect(search([cond("publicationTitle", "is", "review of finance")])).toEqual(ids("review"));
				});

				// Zotero folds accents in its stored/search strings; zotero-next compares with SQLite LIKE/=, which only folds ASCII case.
				// Fixing it needs normalised columns (a db schema change) or a SQL function.
				test.todo("should match a value with different accents ('Revue de Séance' is 'revue de seance')");
			});

			describe("isEmpty/isNotEmpty", () => {
				test.todo("should match items with an empty or non-empty text field: no isEmpty/isNotEmpty operators");
				test.todo("should match items with an empty date field: no isEmpty/isNotEmpty operators");
			});

			describe("dateAdded", () => {
				test.todo("should handle 'today': no relative-day values (isInTheLast covers the common case)");
			});

			describe("date-type item fields", () => {
				test("should compare dates and still accept text operators", () => {
					const p1 = KEYS.get("patent1")!;
					const p2 = KEYS.get("patent2")!;
					const p3 = KEYS.get("patent3")!;
					const before = search([cond("filingDate", "isBefore", "2020")]);
					expect(before).toContain(p1);
					expect(before).not.toContain(p2);
					expect(before).not.toContain(p3);
					// A text operator, as in an existing saved search
					const contains = search([cond("filingDate", "contains", "2021")]);
					expect(contains).toContain(p2);
					expect(contains).not.toContain(p1);
				});
			});

			describe("fileTypeID", () => {
				test("should search by attachment file type", () => {
					expect(search([cond("attachmentFileType", "is", "snapshot")])).toEqual(ids("inColl"));
				});
			});

			describe("titleCreatorYear", () => {
				// zotero-next's quick-search mode of that name; the advanced-search field `title` + `creator` OR-ed is the same set
				test("should match title, creator, and year but not other fields", () => {
					const matches = search([cond("title", "contains", "ztcyabc"), cond("creator", "contains", "ztcyabc")], { match: "any" });
					expect(matches).toEqual(ids("byTitle", "byCreator"));
				});

				test("should exclude items whose title contains the value for doesNotContain", () => {
					const matches = search([cond("title", "doesNotContain", "ztcyabc")]);
					expect(matches).toContain(KEYS.get("loose")!);
					expect(matches).not.toContain(KEYS.get("byTitle")!);
				});
			});

			describe("base-mapped fields", () => {
				// Zotero searches the base field across every type that maps a field onto it (audioRecording.label -> publisher)
				test("should match a base field through the type-specific field", () => {
					expect(search([cond("publisher", "is", "Some Label")])).toEqual(ids("audio", "book"));
				});
			});

			describe("Accent-insensitive matching", () => {
				test.todo("should match accented and unaccented text interchangeably (title contains 'zdiaseance' / 'zdiarésumé')");
				test.todo("should match an accented creator from an unaccented term");
				test.todo("should match an accented tag from an unaccented term");

				// SQLite's LIKE folds only ASCII case (zotero-next stores no normalised column); the same-case term works
				test.todo("should match non-ASCII text case-insensitively (title contains 'zdiaθεμα' finds 'zdiaΘΕΜΑ')");
				test("a non-ASCII term in the stored case matches", () => {
					expect(search([cond("title", "contains", "zdiaΘΕΜΑ")])).toEqual(ids("greek"));
				});

				test.todo("should match ligatures, superscripts, fractions, and non-decomposing letters");
				test.todo("should ignore rich-text formatting tags in item fields");
				test.todo("should fold curly quotes and dashes to their ASCII forms");

				test("should distinguish voiced kana and composed Hangul", () => {
					expect(search([cond("title", "contains", "zdiaがん")])).toEqual(ids("ja"));
					expect(search([cond("title", "contains", "zdiaかん")])).toEqual([]);
				});
			});
		});
	});
});
