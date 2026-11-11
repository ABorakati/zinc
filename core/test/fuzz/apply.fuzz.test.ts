// Fuzz: item JSON that reaches the database from outside: the Web API pull (core/src/sync/apply.ts, used by websync/pull.ts
// and the local Zotero sync) and the browser connector's translator JSON (core/src/connector/items.ts).
//
// Properties: whatever the JSON holds (wrong types, hostile keys, parent loops, collection loops), applying it never leaves the
// database corrupt (integrity_check, foreign_key_check, structural invariants), never writes outside the storage folder, and an
// apply that fails leaves no partial writes. Only fresh temp databases are used.
import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { createItem, openDb } from "../../src/db";
import { saveTranslatedItem } from "../../src/connector/items";
import { applyChanges, type RemoteChanges } from "../../src/sync/apply";
import { tempDir } from "../fixture";
import { describeError, fc, fuzz, mutated } from "./harness";

const dbs: Database[] = [];
function freshDb(): { db: Database; dir: string } {
	const dir = tempDir();
	const db = openDb(join(dir, "lib.sqlite"));
	dbs.push(db);
	return { db, dir };
}
afterAll(() => {
	for (const d of dbs) d.close(true);
});

const TABLES = ["items", "collections", "collection_items", "item_tags", "attachments", "annotations", "sync_base", "sync_outbox", "sync_conflicts"];
function dump(db: Database): string {
	return JSON.stringify(TABLES.map((t) => db.query(`SELECT * FROM ${t} ORDER BY 1, 2`).all()));
}

function expectHealthy(db: Database): void {
	expect((db.query("PRAGMA integrity_check").all() as { integrity_check: string }[]).map((r) => r.integrity_check)).toEqual(["ok"]);
	expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
	// structure the rest of the app relies on
	expect(db.query("SELECT key FROM items WHERE parent_key = key").all()).toEqual([]);
	expect(db.query("SELECT c.key FROM items c JOIN items p ON p.key = c.parent_key WHERE p.parent_key IS NOT NULL").all()).toEqual([]);
	expect(db.query("SELECT key FROM collections WHERE parent_key = key").all()).toEqual([]);
	const cyc = db
		.query(
			`WITH RECURSIVE up(start, key, depth) AS (
				SELECT key, parent_key, 1 FROM collections WHERE parent_key IS NOT NULL
				UNION SELECT up.start, c.parent_key, up.depth + 1 FROM up JOIN collections c ON c.key = up.key WHERE c.parent_key IS NOT NULL AND up.depth < 1000)
			 SELECT start FROM up WHERE key = start LIMIT 1`,
		)
		.all();
	expect(cyc).toEqual([]);
	for (const r of db.query("SELECT key, data FROM items").all() as { key: string; data: string }[]) {
		const d = JSON.parse(r.data);
		expect(d.key).toBe(r.key);
		expect(typeof d.itemType).toBe("string");
	}
	for (const r of db.query("SELECT key, data FROM annotations").all() as { key: string; data: string }[]) JSON.parse(r.data);
}

// ---------------------------------------------------------------- generators

const KEYS = ["AAAAAAA1", "BBBBBBB2", "CCCCCCC3", "DDDDDDD4", "EEEEEEE5"];
const CKEYS = ["COLLAAA1", "COLLBBB2", "COLLCCC3"];
const HOSTILE = ["../evil", "..\\evil", "a/b", "C:\\x", "", " ", "x'; DROP TABLE items;--", "\0", "A".repeat(300), "\u202e", "con"];
const key = fc.oneof({ weight: 12, arbitrary: fc.constantFrom(...KEYS) }, { weight: 1, arbitrary: fc.constantFrom(...HOSTILE) });
const ckey = fc.oneof({ weight: 12, arbitrary: fc.constantFrom(...CKEYS) }, { weight: 1, arbitrary: fc.constantFrom(...HOSTILE) });
const junk = fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<unknown>;
const orJunk = <T>(a: fc.Arbitrary<T>): fc.Arbitrary<unknown> => fc.oneof({ weight: 9, arbitrary: a as fc.Arbitrary<unknown> }, { weight: 1, arbitrary: junk });
const text = fc.oneof(fc.string({ unit: "grapheme", maxLength: 30 }), fc.constantFrom("", "A study &#99999999; of &#x110000; things", "<b>x</b>", "ß", "{\\'e}"));
const date = fc.oneof(
	fc.constantFrom("2020-05-17T10:00:00Z", "2021-01-01 00:00:00", "not a date", "", "0000-00-00", "2020-13-45T99:99:99Z"),
	fc.date({ min: new Date("2000-01-01"), max: new Date("2030-01-01"), noInvalidDate: true }).map((d) => d.toISOString()),
);

const itemJson: fc.Arbitrary<Record<string, unknown>> = fc
	.record(
		{
			itemType: orJunk(fc.constantFrom("journalArticle", "book", "note", "attachment", "webpage", "weirdType")),
			title: orJunk(text),
			version: orJunk(fc.integer({ min: 0, max: 1000 })),
			dateAdded: orJunk(date),
			dateModified: orJunk(date),
			date: orJunk(text),
			creators: orJunk(fc.array(fc.record({ creatorType: orJunk(fc.constantFrom("author", "editor")), firstName: orJunk(text), lastName: orJunk(text), name: orJunk(text) }, { requiredKeys: [] }), { maxLength: 3 })),
			tags: orJunk(fc.array(orJunk(fc.oneof(text, fc.record({ tag: orJunk(text), type: orJunk(fc.integer({ min: 0, max: 1 })) }))), { maxLength: 4 })),
			collections: orJunk(fc.array(orJunk(ckey), { maxLength: 3 })),
			relations: orJunk(fc.constant({})),
			parentItem: orJunk(fc.oneof(key, fc.constant(false))),
			deleted: orJunk(fc.constantFrom(0, 1, true)),
			inPublications: orJunk(fc.boolean()),
			linkMode: orJunk(fc.constantFrom("imported_file", "imported_url", "linked_file", "linked_url")),
			contentType: orJunk(fc.constantFrom("application/pdf", "text/html", "")),
			filename: orJunk(fc.constantFrom("paper.pdf", "../../../secret.txt", "..\\x", "a/b.pdf", "", "con", "x\0y")),
			path: orJunk(fc.constantFrom("storage:paper.pdf", "C:\\Users\\x\\f.pdf", "/etc/passwd", "attachments:a/b.pdf", "")),
			url: orJunk(fc.constantFrom("https://example.org/", "", "javascript:alert(1)")),
			note: orJunk(text),
			extra: orJunk(text),
			DOI: orJunk(text),
			publicationTitle: orJunk(text),
			abstractNote: orJunk(text),
		},
		{ requiredKeys: [] },
	)
	.map((o) => o as Record<string, unknown>);

const changes: fc.Arbitrary<RemoteChanges> = fc.record({
	upserts: fc.array(
		fc.oneof(
			{ weight: 6, arbitrary: fc.record({ type: fc.constant("item" as const), key, data: itemJson, dateModified: orJunk(date) }) },
			{ weight: 2, arbitrary: fc.record({ type: fc.constant("collection" as const), key: ckey, data: fc.record({ name: orJunk(text), parentCollection: orJunk(fc.oneof(ckey, fc.constant(false))), version: orJunk(fc.integer({ min: 0, max: 99 })) }, { requiredKeys: [] }), dateModified: orJunk(date) }) },
			{ weight: 1, arbitrary: fc.record({ type: fc.constant("annotation" as const), key, data: fc.record({ parentItem: orJunk(key), type: orJunk(fc.constantFrom("highlight", "note")), position: junk, comment: orJunk(text) }, { requiredKeys: [] }), dateModified: orJunk(date) }) },
		),
		{ maxLength: 8 },
	),
	deletes: fc.array(fc.record({ type: fc.constantFrom("item" as const, "collection" as const, "annotation" as const), key: fc.oneof(key, ckey) }), { maxLength: 3 }),
}) as unknown as fc.Arbitrary<RemoteChanges>;

// ---------------------------------------------------------------- applyChanges

describe("sync apply (Web API / local Zotero pull)", () => {
	// one database for a whole run of cases: state accumulates, so updates, conflicts and deletes of known keys happen
	const { db, dir } = freshDb();
	fuzz("random and malformed remote changes never corrupt the database", [fc.array(changes, { minLength: 1, maxLength: 3 })], (batches) => {
		for (const ch of batches) {
			const before = dump(db);
			try {
				applyChanges(db, ch, dir);
			} catch (e) {
				// a failing apply is allowed only when it leaves nothing behind
				if (dump(db) !== before) throw new Error(`apply threw ${describeError(e)} and left partial writes`, { cause: e });
				throw new Error(`apply threw instead of skipping the bad object: ${describeError(e)}`, { cause: e });
			}
			expectHealthy(db);
		}
	}, { normal: 100 });

	fuzz("no attachment path points outside the storage folder or the linked file the server named", [fc.array(changes, { minLength: 1, maxLength: 2 })], (batches) => {
		const fresh = freshDb();
		for (const ch of batches) applyChanges(fresh.db, ch, fresh.dir);
		const storage = resolve(fresh.dir, "storage");
		for (const r of fresh.db.query("SELECT a.item_key, a.link_mode, a.path FROM attachments a").all() as { item_key: string; link_mode: string; path: string | null }[]) {
			if (r.path && r.link_mode !== "linked_file") expect(resolve(r.path).startsWith(storage)).toBe(true);
		}
	}, { normal: 60 });

	fuzz("the same changes applied twice give the same database", [changes], (ch) => {
		const f = freshDb();
		applyChanges(f.db, ch, f.dir);
		const shape = () => [
			f.db.query("SELECT key, item_type, parent_key, title, deleted FROM items ORDER BY key").all(),
			f.db.query("SELECT key, name, parent_key FROM collections ORDER BY key").all(),
			f.db.query("SELECT * FROM collection_items ORDER BY 1, 2").all(),
			f.db.query("SELECT * FROM item_tags ORDER BY 1, 2").all(),
		];
		const once = shape();
		applyChanges(f.db, ch, f.dir);
		expect(shape()).toEqual(once);
	}, { normal: 60 });

	test("regression: two collections that name each other as parent do not loop", () => {
		const f = freshDb();
		applyChanges(f.db, {
			upserts: [
				{ type: "collection", key: "COLLAAA1", data: { name: "a", parentCollection: "COLLBBB2" }, dateModified: "2020-01-01T00:00:00Z" },
				{ type: "collection", key: "COLLBBB2", data: { name: "b", parentCollection: "COLLAAA1" }, dateModified: "2020-01-01T00:00:00Z" },
			],
			deletes: [],
		}, f.dir);
		expectHealthy(f.db);
		applyChanges(f.db, { upserts: [], deletes: [{ type: "collection", key: "COLLAAA1" }] }, f.dir);
		expectHealthy(f.db);
	});
	test("regression: an item that is its own parent, or the child of a child, is not stored", () => {
		const f = freshDb();
		const it = (key: string, parentItem?: string) => ({ type: "item" as const, key, dateModified: "2020-01-01T00:00:00Z", data: { itemType: "note", note: "x", ...(parentItem ? { parentItem } : {}) } });
		applyChanges(f.db, { upserts: [it("AAAAAAA1", "AAAAAAA1"), it("BBBBBBB2", "CCCCCCC3"), it("CCCCCCC3", "BBBBBBB2")], deletes: [] }, f.dir);
		expectHealthy(f.db);
	});
	// found by the nightly fuzz: the path of a linked file was kept when the same attachment came again as a stored file
	test("regression: a linked file that becomes a stored attachment does not keep its outside path", () => {
		const f = freshDb();
		applyChanges(f.db, {
			upserts: [
				{ type: "item", key: "AAAAAAA1", data: { itemType: "attachment", linkMode: "linked_file", path: "/etc/passwd" }, dateModified: "2020-05-17T10:00:00Z" },
				{ type: "item", key: "AAAAAAA1", data: { itemType: "attachment" }, dateModified: "0000-00-00" },
			],
			deletes: [],
		} as unknown as RemoteChanges, f.dir);
		const r = f.db.query("SELECT link_mode, path FROM attachments WHERE item_key = 'AAAAAAA1'").get() as { link_mode: string; path: string | null } | null;
		expect(r?.link_mode).toBe("imported_file");
		expect(r?.path ?? null).toBeNull();
		expectHealthy(f.db);
	});
	test("regression: an unsafe key or filename from the server never reaches the file system", () => {
		const f = freshDb();
		applyChanges(f.db, {
			upserts: [
				{ type: "item", key: "../evil", dateModified: "2020-01-01T00:00:00Z", data: { itemType: "attachment", linkMode: "imported_file", filename: "x.pdf" } },
				{ type: "item", key: "AAAAAAA1", dateModified: "2020-01-01T00:00:00Z", data: { itemType: "attachment", linkMode: "imported_file", filename: "../../../etc/passwd" } },
			],
			deletes: [],
		}, f.dir);
		expect(f.db.query("SELECT key FROM items WHERE key LIKE '%/%' OR key LIKE '%..%'").all()).toEqual([]);
		for (const r of f.db.query("SELECT path FROM attachments").all() as { path: string | null }[]) expect(r.path === null || !r.path.includes("..")).toBe(true);
	});
	test("regression: a bad object does not stop the rest of the batch", () => {
		const f = freshDb();
		const r = applyChanges(f.db, {
			upserts: [
				{ type: "item", key: "AAAAAAA1", dateModified: "2020-01-01T00:00:00Z", data: { itemType: { x: 1 }, title: { y: 2 }, creators: "no", tags: 5, collections: 7 } },
				{ type: "item", key: "BBBBBBB2", dateModified: "2020-01-01T00:00:00Z", data: { itemType: "book", title: "Fine" } },
			],
			deletes: [],
		}, f.dir);
		expect(f.db.query("SELECT title FROM items WHERE key = 'BBBBBBB2'").get()).toEqual({ title: "Fine" });
		expect(r.applied).toBeGreaterThanOrEqual(1);
		expectHealthy(f.db);
	});
});

// ---------------------------------------------------------------- connector translator JSON

const seedTranslated = JSON.stringify({
	id: "ext1", itemType: "journalArticle", title: "T", creators: [{ firstName: "A", lastName: "B", creatorType: "author" }], date: "2020", publicationTitle: "J", DOI: "10.1/x",
	tags: ["a", { tag: "b", type: 1 }], notes: [{ note: "<p>n</p>" }], attachments: [{ id: "a1", title: "page", url: "https://example.org/x", snapshot: false, mimeType: "text/html" }],
});

describe("connector translator JSON", () => {
	const { db } = freshDb();
	const translated: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
		mutated(seedTranslated).map((s) => {
			try {
				const v = JSON.parse(s);
				return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
			} catch {
				return {};
			}
		}),
		fc.dictionary(fc.constantFrom("id", "itemType", "title", "creators", "tags", "notes", "attachments", "date", "url", "DOI", "extra", "accessDate", "note", "publicationTitle", "relations", "collections", "weird", "ISBN", "libraryCatalog"), junk, { maxKeys: 10 }) as fc.Arbitrary<Record<string, unknown>>,
	);
	fuzz("saveTranslatedItem never crashes and leaves a healthy database with no partial item", [translated, fc.constantFrom(null, "COLLAAA1", "missing1")], (raw, coll) => {
		const before = dump(db);
		try {
			saveTranslatedItem(db, JSON.parse(JSON.stringify(raw)), coll);
		} catch (e) {
			// collection missing is the intended failure; it must leave nothing behind
			if (dump(db) !== before) throw new Error(`saveTranslatedItem threw ${describeError(e)} and left partial writes`, { cause: e });
			if (coll !== "missing1" && coll !== "COLLAAA1") throw new Error(`saveTranslatedItem threw ${describeError(e)}`, { cause: e });
		}
		expectHealthy(db);
	}, { normal: 200 });
	test("a database created from items stays healthy (control)", () => {
		const f = freshDb();
		createItem(f.db, { itemType: "book", title: "x" });
		expectHealthy(f.db);
	});
});
