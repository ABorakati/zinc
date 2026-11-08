import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { listItems, openDb } from "../src/db";
import { SCHEMA_HEAD } from "../src/migrations";
import { rebuildSearchIndex, search } from "../src/search";
import { insertItem, tempDir } from "./fixture";
import type { ZoteroItemData } from "../src/api-types";

// Toolbar quick search (migration 3, trigram index) must answer exactly what the LIKE query it replaced answered.

let dir: string;
let path: string;
let db: Database;
beforeEach(() => {
	dir = tempDir();
	path = join(dir, "library.sqlite");
	db = openDb(path);
});
afterEach(() => db.close());

const WORDS = ["pancreatic", "resection", "survival", "cohort", "Machine", "learning", "KIDNEY", "50%_off", 'say "hi"', "naïve", "École", "x1"];
function seed(n = 300): void {
	for (let i = 0; i < n; i++) {
		const key = `ITEM${String(i).padStart(4, "0")}`;
		const data: ZoteroItemData = {
			key,
			itemType: "journalArticle",
			title: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} study ${i}`,
			date: String(1990 + (i % 35)),
			creators: [{ creatorType: "author", firstName: "A", lastName: `Author${i % 40}` }],
		};
		insertItem(db, data);
		if (i % 3 === 0) db.run("INSERT INTO bbt_keys(item_key, key) VALUES(?, ?)", [key, `author${i % 40}${1990 + (i % 35)}Key${i}`]);
	}
}

/** The LIKE query the trigram index replaced, run directly (top-level, not trashed, not annotations). */
function viaLike(terms: string[]): string[] {
	const esc = (t: string) => t.replace(/[\\%_]/g, (c) => "\\" + c);
	const where = terms.map(
		() =>
			"(i.title LIKE ? ESCAPE '\\' OR i.creators_summary LIKE ? ESCAPE '\\' OR CAST(i.year AS TEXT) LIKE ? ESCAPE '\\' OR i.key IN (SELECT item_key FROM bbt_keys WHERE key LIKE ? ESCAPE '\\'))",
	);
	const params = terms.flatMap((t) => Array(4).fill(`%${esc(t)}%`));
	return (
		db
			.query(`SELECT key FROM items i WHERE parent_key IS NULL AND item_type <> 'annotation' AND deleted = 0 AND ${where.join(" AND ")} ORDER BY key`)
			.all(...params) as { key: string }[]
	).map((r) => r.key);
}
const viaApi = (q: string): string[] =>
	listItems(db, { q, limit: 5000 })
		.items.map((i) => i.key)
		.sort();

describe("trigram quick search", () => {
	test("migration 3 created the index and its triggers", () => {
		expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'quick_search'").get()).toBeTruthy();
		const triggers = (db.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'quick_search_%'").all() as { name: string }[]).length;
		expect(triggers).toBe(6);
	});

	test("matches what LIKE matched, for ASCII terms of any case and kind", () => {
		seed();
		const queries = ["pancre", "PANCRE", "resec", "sur", "cohort", "kidney", "Machine learning", "study 1", "Author1", "author17", "199", "1999", "key12", "50%", "%_o", "_off", 'say "h', '"hi"', "x1", "zzzz"];
		for (const q of queries) {
			const terms = q.split(/\s+/).filter(Boolean);
			expect({ q, keys: viaApi(q) }).toEqual({ q, keys: viaLike(terms) });
		}
	});

	test("terms under 3 characters still work (LIKE fallback), alone and mixed with long ones", () => {
		seed();
		for (const q of ["x", "x1", "19", "ab", "au", "pancreatic x", "ca 19", "a c"]) {
			expect({ q, keys: viaApi(q) }).toEqual({ q, keys: viaLike(q.split(/\s+/).filter(Boolean)) });
		}
	});

	test("non-ASCII: exact-case matches work; the index also folds case for non-ASCII letters (wider than LIKE)", () => {
		seed();
		expect(viaApi("naïve").length).toBeGreaterThan(0);
		expect(viaApi("École")).toEqual(viaLike(["École"]));
		expect(viaApi("école").length).toBeGreaterThanOrEqual(viaLike(["école"]).length);
	});

	test("totals and paging agree with the list", () => {
		seed();
		const all = listItems(db, { q: "cohort", limit: 5000 });
		const page = listItems(db, { q: "cohort", limit: 10, offset: 10, sort: "title" });
		expect(page.total).toBe(all.total);
		expect(page.items).toHaveLength(10);
	});
});

describe("the triggers keep the index current", () => {
	test("insert, retitle, re-credit and re-date an item", () => {
		insertItem(db, { key: "TRIG0001", itemType: "journalArticle", title: "Initial heading", date: "2001", creators: [{ creatorType: "author", lastName: "Smith" }] });
		expect(viaApi("initial")).toEqual(["TRIG0001"]);
		db.run("UPDATE items SET title = 'Retitled paper' WHERE key = 'TRIG0001'");
		expect(viaApi("initial")).toEqual([]);
		expect(viaApi("retitled")).toEqual(["TRIG0001"]);
		db.run("UPDATE items SET creators_summary = 'Nguyen et al.' WHERE key = 'TRIG0001'");
		expect(viaApi("nguyen")).toEqual(["TRIG0001"]);
		expect(viaApi("smith")).toEqual([]);
		db.run("UPDATE items SET year = 1987 WHERE key = 'TRIG0001'");
		expect(viaApi("1987")).toEqual(["TRIG0001"]);
		expect(viaApi("2001")).toEqual([]);
	});

	test("delete, and INSERT OR REPLACE, leave no stale entry", () => {
		insertItem(db, { key: "TRIG0002", itemType: "journalArticle", title: "Ephemeral thing" });
		db.run("DELETE FROM items WHERE key = 'TRIG0002'");
		expect(viaApi("ephemeral")).toEqual([]);
		insertItem(db, { key: "TRIG0003", itemType: "journalArticle", title: "Gamma ray" });
		db.run("UPDATE items SET title = 'Delta wave' WHERE key = 'TRIG0003'");
		db.run("INSERT OR REPLACE INTO items(key, item_type, title, data, date_added, date_modified) VALUES('TRIG0003', 'journalArticle', 'Epsilon band', '{}', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')");
		expect(viaApi("epsilon")).toEqual(["TRIG0003"]);
		expect(viaApi("delta")).toEqual([]);
		expect(viaApi("gamma")).toEqual([]);
	});

	test("an item that becomes a child leaves the list index", () => {
		insertItem(db, { key: "PARENT01", itemType: "journalArticle", title: "Parent work" });
		insertItem(db, { key: "CHILD001", itemType: "attachment", title: "Loose scan quartz" });
		expect(viaApi("quartz")).toEqual(["CHILD001"]);
		db.run("UPDATE items SET parent_key = 'PARENT01' WHERE key = 'CHILD001'");
		expect(viaApi("quartz")).toEqual([]);
		db.run("UPDATE items SET parent_key = NULL WHERE key = 'CHILD001'");
		expect(viaApi("quartz")).toEqual(["CHILD001"]);
	});

	test("citation keys: insert, change, delete, and deleting the item", () => {
		insertItem(db, { key: "BBT00001", itemType: "journalArticle", title: "No visible overlap" });
		db.run("INSERT INTO bbt_keys(item_key, key) VALUES('BBT00001', 'smith2020alpha')");
		expect(viaApi("smith2020alpha")).toEqual(["BBT00001"]);
		db.run("UPDATE bbt_keys SET key = 'jones2021beta' WHERE item_key = 'BBT00001'");
		expect(viaApi("smith2020alpha")).toEqual([]);
		expect(viaApi("jones2021")).toEqual(["BBT00001"]);
		db.run("DELETE FROM bbt_keys WHERE item_key = 'BBT00001'");
		expect(viaApi("jones2021")).toEqual([]);
		db.run("INSERT INTO bbt_keys(item_key, key) VALUES('BBT00001', 'brown2022gamma')");
		db.run("DELETE FROM items WHERE key = 'BBT00001'");
		expect(viaApi("brown2022")).toEqual([]);
	});

	test("rebuildSearchIndex repairs a damaged trigram index", () => {
		seed(60);
		db.run("DELETE FROM quick_search");
		expect(viaApi("pancreatic")).toEqual([]);
		rebuildSearchIndex(db);
		expect(viaApi("pancreatic")).toEqual(viaLike(["pancreatic"]));
		expect(viaApi("pancreatic").length).toBeGreaterThan(0);
	});
});

describe("older libraries", () => {
	test("a library recorded at schema version 2 is migrated and backfilled on open", () => {
		seed(80);
		db.close();
		const raw = new Database(path);
		raw.run("DROP TABLE quick_search");
		for (const t of raw.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'quick_search_%'").all() as { name: string }[]) raw.run(`DROP TRIGGER ${t.name}`);
		raw.run("UPDATE meta SET value = '2' WHERE name = 'schema_version'");
		raw.close();
		db = openDb(path);
		expect(db.query("SELECT value FROM meta WHERE name = 'schema_version'").get()).toEqual({ value: String(SCHEMA_HEAD) });
		expect(viaApi("pancreatic")).toEqual(viaLike(["pancreatic"]));
		expect(viaApi("pancreatic").length).toBeGreaterThan(0);
	});

	test("a connection to a library without the index falls back to LIKE", () => {
		seed(80);
		db.close();
		const raw = new Database(path);
		raw.run("DROP TABLE quick_search");
		for (const t of raw.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'quick_search_%'").all() as { name: string }[]) raw.run(`DROP TRIGGER ${t.name}`);
		raw.close();
		const ro = new Database(path, { readonly: true });
		const got = listItems(ro, { q: "pancreatic", limit: 5000 }).items.map((i) => i.key).sort();
		ro.close();
		db = openDb(path); // migrates again for afterEach's close()
		expect(got).toEqual(viaLike(["pancreatic"]));
		expect(got.length).toBeGreaterThan(0);
	});
});

describe("search(): rank first, snippet for the page", () => {
	// The single query it replaced, kept here as the reference.
	function legacy(q: string, limit: number, offset: number, match: string) {
		return db
			.query(
				`SELECT i.key, bm25(search, 10.0, 5.0, 3.0, 2.0, 2.0, 1.0, 1.0) AS rank, snippet(search, -1, '<mark>', '</mark>', '…', 16) AS snippet
				 FROM search s JOIN items i ON i.rowid = s.rowid
				 WHERE search MATCH ? AND i.deleted = 0 ORDER BY rank LIMIT ? OFFSET ?`,
			)
			.all(match, limit, offset) as { key: string; rank: number; snippet: string }[];
	}
	test("same hits, ranks and snippets as the one-query version", () => {
		for (let i = 0; i < 120; i++) {
			insertItem(db, {
				key: `SRCH${String(i).padStart(4, "0")}`,
				itemType: "journalArticle",
				title: `${WORDS[i % 6]} ${WORDS[(i * 5) % 6]} paper ${i}`,
				abstractNote: `${WORDS[(i * 3) % 6]} ${"filler words ".repeat(i % 9)} ${WORDS[(i * 11) % 6]}`,
				creators: [{ creatorType: "author", lastName: `Writer${i % 12}` }],
			});
		}
		rebuildSearchIndex(db);
		for (const q of ["pancreatic", "survival cohort", "resection", "Writer3", "machine learning", "zzzz"]) {
			const match = q.split(/\s+/).map((w) => `"${w}"`).join(" ");
			for (const [limit, offset] of [[20, 0], [5, 10], [200, 0]]) {
				const want = legacy(q, limit, offset, match);
				const got = search(db, q, { limit, offset });
				// Hits tied on rank may come in either order, so compare in (rank, key) order.
				const norm = (h: { key: string; rank: number; snippet: string }[]) => h.map((x) => `${x.rank}|${x.key}|${x.snippet}`).sort();
				expect({ q, limit, offset, hits: norm(got.hits.map((h) => ({ key: h.key, rank: h.rank, snippet: h.snippet }))) }).toEqual({ q, limit, offset, hits: norm(want) });
				for (let k = 1; k < got.hits.length; k++) expect(got.hits[k].rank).toBeGreaterThanOrEqual(got.hits[k - 1].rank);
			}
		}
	});
});
