// applyChanges: library scope, annotation deletes, trashed collections. Temp folders and temp databases only.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createItem, openDb, upsertAnnotations } from "../../src/db";
import { upsertGroupLibrary } from "../../src/libraries";
import { applyChanges } from "../../src/sync/apply";
import { tempDir } from "../fixture";

let dir: string;
let db: Database;
beforeEach(() => {
	dir = tempDir();
	db = openDb(join(dir, "library.sqlite"));
});
afterEach(() => db.close(true));

const group = (id: number) => upsertGroupLibrary(db, { groupId: id, name: `Group ${id}`, editable: true, filesEditable: true, version: 1 }).id;
const T = "2026-06-01T10:00:00Z";
const up = (type: "item" | "collection" | "annotation", key: string, data: Record<string, unknown>) => ({
	type,
	key,
	data: { key, ...data },
	dateModified: T,
});
const one = (sql: string, ...p: unknown[]) => db.query(sql).get(...(p as never[])) as Record<string, unknown> | null;

describe("a key that another library already uses", () => {
	test("a group child cannot attach itself to a My Library parent with the same key", () => {
		const g = group(7);
		createItem(db, { itemType: "journalArticle", title: "Mine" }, 1);
		db.query("UPDATE items SET key = 'PARENT01' WHERE title = 'Mine'").run();
		const rep = applyChanges(
			db,
			{
				upserts: [
					up("item", "PARENT01", { itemType: "journalArticle", title: "Theirs" }),
					up("item", "CHILD001", { itemType: "note", parentItem: "PARENT01", note: "<p>injected</p>" }),
				],
				deletes: [],
			},
			dir,
			g,
		);
		expect(rep.collisions).toBe(1);
		expect(one("SELECT title, library_id FROM items WHERE key = 'PARENT01'")).toEqual({ title: "Mine", library_id: 1 });
		expect(one("SELECT 1 AS x FROM items WHERE key = 'CHILD001'")).toBeNull();
		// the library that owns the key keeps exactly its own rows
		expect(one("SELECT COUNT(*) AS n FROM items WHERE parent_key = 'PARENT01'")).toEqual({ n: 0 });
	});

	test("a My Library child of that key is not deleted by the group's batch", () => {
		const g = group(7);
		createItem(db, { itemType: "journalArticle", title: "Mine" }, 1);
		db.query("UPDATE items SET key = 'PARENT01' WHERE title = 'Mine'").run();
		createItem(db, { itemType: "note", parentItem: "PARENT01", note: "<p>mine</p>" }, 1);
		const before = one("SELECT COUNT(*) AS n FROM items")!.n;
		applyChanges(
			db,
			{ upserts: [up("item", "PARENT01", { itemType: "journalArticle", title: "Theirs" })], deletes: [] },
			dir,
			g,
		);
		expect(one("SELECT COUNT(*) AS n FROM items")!.n).toBe(before);
	});

	test("a group sub-collection cannot take a My Library collection as its parent", () => {
		const g = group(7);
		applyChanges(db, { upserts: [up("collection", "COLL0001", { name: "Mine" })], deletes: [] }, dir, 1);
		applyChanges(
			db,
			{
				upserts: [
					up("collection", "COLL0001", { name: "Theirs" }),
					up("collection", "COLL0002", { name: "Sub", parentCollection: "COLL0001" }),
				],
				deletes: [],
			},
			dir,
			g,
		);
		expect(one("SELECT name, library_id FROM collections WHERE key = 'COLL0001'")).toEqual({ name: "Mine", library_id: 1 });
		expect(one("SELECT parent_key, library_id FROM collections WHERE key = 'COLL0002'")).toEqual({ parent_key: null, library_id: g });
	});

	test("an ordinary group batch (new parent and child) still applies", () => {
		const g = group(7);
		const rep = applyChanges(
			db,
			{
				upserts: [
					up("collection", "COLL0010", { name: "Top" }),
					up("collection", "COLL0011", { name: "Sub", parentCollection: "COLL0010" }),
					up("item", "PARENT10", { itemType: "journalArticle", title: "P" }),
					up("item", "CHILD010", { itemType: "note", parentItem: "PARENT10", note: "<p>n</p>" }),
				],
				deletes: [],
			},
			dir,
			g,
		);
		expect(rep.collisions).toBeUndefined();
		expect(one("SELECT parent_key FROM collections WHERE key = 'COLL0011'")).toEqual({ parent_key: "COLL0010" });
		expect(one("SELECT parent_key, library_id FROM items WHERE key = 'CHILD010'")).toEqual({ parent_key: "PARENT10", library_id: g });
	});
});

void upsertAnnotations;
