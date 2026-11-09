import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { addItemsToCollection, addTags, createCollection, createItem, deleteAnnotations, deleteCollection, listCollections, listItems, listTags, openDb, patchItem, removeTags, updateCollection, upsertAnnotations } from "../src/db";
import { USER_LIBRARY, getLibrary, listLibraries, resolveLibrary, upsertGroupLibrary, markGroupsRemoved } from "../src/libraries";
import { MIGRATIONS, SCHEMA_HEAD, migrate } from "../src/migrations";
import { rebuildSearchIndex, search } from "../src/search";
import { buildPush, pendingCount } from "../src/sync/build";
import { tempDir } from "./fixture";

let dir: string;
let path: string;
let db: Database;
beforeEach(() => {
	dir = tempDir();
	path = join(dir, "library.sqlite");
	db = openDb(path);
});
afterEach(() => db.close());

const group = (groupId = 100, over: Partial<{ name: string; editable: boolean; filesEditable: boolean }> = {}) =>
	upsertGroupLibrary(db, { groupId, name: over.name ?? `Group ${groupId}`, editable: over.editable ?? true, filesEditable: over.filesEditable ?? true, version: 1 });
const outbox = () => db.query("SELECT type, key, op, library_id AS lib FROM sync_outbox ORDER BY seq").all() as { type: string; key: string; op: string; lib: number }[];
const clearOutbox = () => db.run("DELETE FROM sync_outbox");
const status = (fn: () => unknown): number | undefined => {
	try {
		fn();
	} catch (e) {
		return (e as { status?: number }).status;
	}
	return undefined;
};

describe("migration 4 on an existing library", () => {
	test("keeps every row in My Library, backs up first, and the outbox keeps its entries", () => {
		const old = join(dir, "old.sqlite");
		const raw = new Database(old);
		migrate(raw, old, { migrations: MIGRATIONS.slice(0, SCHEMA_HEAD - 1) }); // as the last release left it: no libraries yet
		expect((raw.query("PRAGMA table_info(items)").all() as { name: string }[]).some((c) => c.name === "library_id")).toBe(false);
		for (let i = 0; i < 20; i++) {
			raw.run("INSERT INTO items(key, item_type, title, data, date_added, date_modified) VALUES(?, 'journalArticle', ?, '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", [`OLD${String(i).padStart(5, "0")}`, `Old ${i}`]);
		}
		raw.run("INSERT INTO collections(key, name) VALUES('OLDCOLL1', 'Old collection')");
		raw.run("INSERT INTO collection_items(collection_key, item_key) VALUES('OLDCOLL1', 'OLD00000')");
		const queued = raw.query("SELECT count(*) AS n FROM sync_outbox").get() as { n: number };
		expect(queued.n).toBeGreaterThan(0);
		raw.close();

		const up = new Database(old);
		const r = migrate(up, old);
		expect(r.from).toBe(SCHEMA_HEAD - 1);
		expect(r.to).toBe(SCHEMA_HEAD);
		expect(r.backup && existsSync(r.backup)).toBe(true);
		expect(readdirSync(dir).some((f) => new RegExp(`^library\\.backup-v${SCHEMA_HEAD - 1}-to-v${SCHEMA_HEAD}-`).test(f))).toBe(true);
		const n = (sql: string) => (up.query(sql).get() as { n: number }).n;
		expect(n("SELECT count(*) AS n FROM items")).toBe(20);
		expect(n("SELECT count(*) AS n FROM items WHERE library_id = 1")).toBe(20);
		expect(n("SELECT count(*) AS n FROM collections WHERE library_id = 1")).toBe(1);
		expect(n("SELECT count(*) AS n FROM sync_outbox WHERE library_id = 1")).toBe(queued.n);
		expect(up.query("SELECT id, type, name, editable FROM libraries").all()).toEqual([{ id: 1, type: "user", name: "My Library", editable: 1 }]);
		expect(up.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
		// the re-created triggers keep working: a new edit is queued, in the right library
		up.run("DELETE FROM sync_outbox");
		up.run("UPDATE items SET title = 'Edited' WHERE key = 'OLD00001'");
		expect(up.query("SELECT type, key, op, library_id AS lib FROM sync_outbox").all()).toEqual([{ type: "item", key: "OLD00001", op: "upsert", lib: 1 }]);
		up.close();
	});

	test("running it again changes nothing", () => {
		createItem(db, { itemType: "journalArticle", title: "Keep me" });
		const before = db.query("SELECT key, library_id FROM items").all();
		const m = MIGRATIONS[SCHEMA_HEAD - 1];
		db.transaction(() => m.up(db))();
		expect(db.query("SELECT key, library_id FROM items").all()).toEqual(before);
		expect(db.query("SELECT count(*) AS n FROM libraries").get()).toEqual({ n: 1 });
	});
});

describe("libraries", () => {
	test("My Library always exists; groups are added, renamed and hidden when removed", () => {
		expect(listLibraries(db).map((l) => l.name)).toEqual(["My Library"]);
		const g = group(100, { name: "Lab" });
		expect(g.id).toBeGreaterThan(1);
		expect(listLibraries(db).map((l) => l.name)).toEqual(["My Library", "Lab"]);
		group(100, { name: "Lab renamed", editable: false });
		expect(getLibrary(db, g.id)).toMatchObject({ name: "Lab renamed", editable: false, groupId: 100, type: "group" });
		markGroupsRemoved(db, []);
		expect(listLibraries(db).map((l) => l.name)).toEqual(["My Library"]);
		expect(listLibraries(db, { includeRemoved: true })).toHaveLength(2);
		group(100); // it comes back
		expect(listLibraries(db)).toHaveLength(2);
	});

	test("resolveLibrary: absent is My Library; junk and unknown ids are refused", () => {
		const g = group();
		expect(resolveLibrary(db, undefined)).toBe(USER_LIBRARY);
		expect(resolveLibrary(db, String(g.id))).toBe(g.id);
		expect(status(() => resolveLibrary(db, "abc"))).toBe(400);
		expect(status(() => resolveLibrary(db, 9999))).toBe(404);
	});
});

describe("items and collections belong to one library", () => {
	test("a group's items, collections and tags stay out of My Library, and the other way round", () => {
		const g = group();
		createItem(db, { itemType: "journalArticle", title: "Mine", tags: [{ tag: "mine" }] });
		const coll = createCollection(db, "Shared", null, g.id);
		const gi = createItem(db, { itemType: "journalArticle", title: "Theirs", tags: [{ tag: "theirs" }], collections: [coll.key] });
		expect(coll.libraryId).toBe(g.id);
		expect(db.query("SELECT library_id AS l FROM items WHERE key = ?").get(gi.data.key)).toEqual({ l: g.id });

		expect(listItems(db).items.map((i) => i.title)).toEqual(["Mine"]);
		expect(listItems(db, { library: g.id }).items.map((i) => i.title)).toEqual(["Theirs"]);
		expect(listItems(db, { collection: coll.key }).items.map((i) => i.title)).toEqual(["Theirs"]); // the collection names the library
		expect(listItems(db, { library: g.id }).total).toBe(1);
		expect(listCollections(db).map((c) => c.name)).toEqual([]);
		expect(listCollections(db, g.id).map((c) => c.name)).toEqual(["Shared"]);
		expect(listTags(db).map((t) => t.tag)).toEqual(["mine"]);
		expect(listTags(db, g.id).map((t) => t.tag)).toEqual(["theirs"]);
		expect(listItems(db, { library: g.id, trash: true }).total).toBe(0);
	});

	test("an item in a collection of another library, and a cross-library collection move, are refused", () => {
		const g = group();
		const mine = createCollection(db, "Mine");
		const theirs = createCollection(db, "Theirs", null, g.id);
		expect(status(() => createItem(db, { itemType: "journalArticle", title: "x", collections: [mine.key] }, g.id))).toBe(400);
		const it = createItem(db, { itemType: "journalArticle", title: "Mine" });
		expect(status(() => addItemsToCollection(db, theirs.key, [it.data.key]))).toBe(400);
		expect(status(() => patchItem(db, it.data.key, { collections: [theirs.key] }))).toBe(400);
		expect(status(() => updateCollection(db, mine.key, { parentKey: theirs.key }))).toBe(400);
		expect(status(() => createCollection(db, "sub", mine.key, g.id))).toBe(400);
		const sub = createCollection(db, "sub", theirs.key); // follows its parent
		expect(sub.libraryId).toBe(g.id);
	});

	test("a note or attachment joins its parent's library, however it was inserted", () => {
		const g = group();
		const parent = createItem(db, { itemType: "journalArticle", title: "Parent" }, g.id);
		const child = createItem(db, { itemType: "note", parentItem: parent.data.key, note: "<p>n</p>" });
		expect(db.query("SELECT library_id AS l FROM items WHERE key = ?").get(child.data.key)).toEqual({ l: g.id });
		// raw SQL, as importers and the connector do: no library given
		db.run("INSERT INTO items(key, item_type, parent_key, title, data, date_added, date_modified) VALUES('RAWCHILD', 'attachment', ?, 'a', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", [parent.data.key]);
		expect(db.query("SELECT library_id AS l FROM items WHERE key = 'RAWCHILD'").get()).toEqual({ l: g.id });
		expect(status(() => createItem(db, { itemType: "note", parentItem: parent.data.key }, USER_LIBRARY))).toBe(400);
	});

	test("full-text search is per library", () => {
		const g = group();
		createItem(db, { itemType: "journalArticle", title: "Pancreatic mine" });
		createItem(db, { itemType: "journalArticle", title: "Pancreatic theirs" }, g.id);
		rebuildSearchIndex(db);
		expect(search(db, "pancreatic").hits.map((h) => h.title)).toEqual(["Pancreatic mine"]);
		expect(search(db, "pancreatic", { library: g.id }).hits.map((h) => h.title)).toEqual(["Pancreatic theirs"]);
		expect(listItems(db, { q: "pancreatic" }).items).toHaveLength(1);
		expect(listItems(db, { q: "pancreatic", library: g.id }).items.map((i) => i.title)).toEqual(["Pancreatic theirs"]);
	});
});

describe("read-only libraries", () => {
	test("nothing can be changed in one, and My Library is unaffected", () => {
		const g = group(100, { editable: true });
		const coll = createCollection(db, "C", null, g.id);
		const it = createItem(db, { itemType: "journalArticle", title: "T" }, g.id);
		const att = createItem(db, { itemType: "attachment", parentItem: it.data.key, linkMode: "linked_url", url: "https://example.org" });
		upsertGroupLibrary(db, { groupId: 100, name: "Group 100", editable: false, filesEditable: false, version: 2 }); // permissions change
		const denied = (fn: () => unknown) => expect(status(fn)).toBe(403);
		denied(() => createItem(db, { itemType: "journalArticle", title: "x" }, g.id));
		denied(() => createItem(db, { itemType: "note", parentItem: it.data.key }));
		denied(() => createCollection(db, "x", null, g.id));
		denied(() => createCollection(db, "x", coll.key));
		denied(() => updateCollection(db, coll.key, { name: "y" }));
		denied(() => deleteCollection(db, coll.key));
		denied(() => patchItem(db, it.data.key, { title: "y" }));
		denied(() => patchItem(db, it.data.key, { deleted: 1 })); // trash
		denied(() => addItemsToCollection(db, coll.key, [it.data.key]));
		denied(() => addTags(db, it.data.key, ["x"]));
		denied(() => removeTags(db, it.data.key, ["x"]));
		denied(() => upsertAnnotations(db, att.data.key, [{ id: "ANNOT001", type: "highlight", sortIndex: "0", dateModified: "2026-01-01T00:00:00Z" } as never]));
		denied(() => deleteAnnotations(db, att.data.key, ["ANNOT001"]));
		// reading is fine, and My Library still works
		expect(listItems(db, { library: g.id }).total).toBe(1);
		expect(status(() => createItem(db, { itemType: "journalArticle", title: "mine" }))).toBeUndefined();
	});
});

describe("the sync outbox knows each change's library", () => {
	test("My Library's queue (the local-Zotero sync) never contains a group's changes", () => {
		const g = group();
		clearOutbox();
		const mine = createItem(db, { itemType: "journalArticle", title: "Mine" });
		const coll = createCollection(db, "Shared", null, g.id);
		const theirs = createItem(db, { itemType: "journalArticle", title: "Theirs", collections: [coll.key], tags: [{ tag: "t" }] });
		addTags(db, theirs.data.key, ["more"]);
		patchItem(db, theirs.data.key, { title: "Theirs edited" });
		const rows = outbox();
		const keysIn = (lib: number) => new Set(rows.filter((r) => r.lib === lib).map((r) => `${r.type}:${r.key}`));
		expect(keysIn(USER_LIBRARY)).toEqual(new Set([`item:${mine.data.key}`]));
		expect(keysIn(g.id)).toEqual(new Set([`item:${theirs.data.key}`, `collection:${coll.key}`]));
		expect(pendingCount(db)).toBe(1);
		expect(pendingCount(db, g.id)).toBe(2);
		const own = buildPush(db, dir).writes.map((w) => w.key);
		expect(own).toEqual([mine.data.key]);
		const grp = buildPush(db, dir, g.id).writes.map((w) => w.key).sort();
		expect(grp).toEqual([coll.key, theirs.data.key].sort());
	});

	test("deleting a group item queues the delete in the group's library", () => {
		const g = group();
		const it = createItem(db, { itemType: "journalArticle", title: "Gone soon" }, g.id);
		clearOutbox();
		db.run("DELETE FROM items WHERE key = ?", [it.data.key]);
		expect(outbox()).toContainEqual({ type: "item", key: it.data.key, op: "delete", lib: g.id });
	});
});

describe("adding items to a library", () => {
	test("links, files, copies and new parents go into the library they were asked for, and a read-only one refuses", async () => {
		const { addLink, addFile } = await import("../src/additems/files");
		const { duplicateItem } = await import("../src/additems/duplicate");
		const { createParent } = await import("../src/additems/parent");
		const g = group(100);
		const coll = createCollection(db, "Group papers", null, g.id);
		const libOf = (key: string) => (db.query("SELECT library_id AS l FROM items WHERE key = ?").get(key) as { l: number }).l;

		const link = addLink(db, { url: "https://example.org/a", libraryId: g.id });
		expect(libOf(link.data.key)).toBe(g.id);
		const mine = addLink(db, { url: "https://example.org/b" });
		expect(libOf(mine.data.key)).toBe(USER_LIBRARY);

		const file = addFile(db, { name: "paper.pdf", contentType: "application/pdf", dataBase64: Buffer.from("%PDF-1.4 test").toString("base64"), collectionKey: coll.key });
		expect(libOf(file.data.key)).toBe(g.id); // filed in a group collection: it is the group's
		expect(db.query("SELECT collection_key FROM collection_items WHERE item_key = ?").all(file.data.key)).toEqual([{ collection_key: coll.key }]);
		expect(status(() => addFile(db, { name: "x.pdf", dataBase64: Buffer.from("x").toString("base64"), collectionKey: coll.key, libraryId: USER_LIBRARY }))).toBe(400);

		const lone = createItem(db, { itemType: "journalArticle", title: "Lonely group item" }, g.id);
		const child = addFile(db, { name: "child.pdf", contentType: "application/pdf", dataBase64: Buffer.from("%PDF child").toString("base64"), parentKey: lone.data.key });
		expect(libOf(child.data.key)).toBe(g.id);

		const copy = duplicateItem(db, lone.data.key);
		expect(libOf(copy.data.key)).toBe(g.id);
		expect(libOf(duplicateItem(db, lone.data.key).data.key)).toBe(g.id);

		const orphan = addLink(db, { url: "https://example.org/c", libraryId: g.id });
		const adopted = await createParent(db, { itemKey: orphan.data.key, itemType: "webpage" });
		expect(libOf(adopted.parent.data.key)).toBe(g.id);
		expect(libOf(orphan.data.key)).toBe(g.id);

		upsertGroupLibrary(db, { groupId: 100, name: "Group 100", editable: false, filesEditable: false, version: 3 });
		expect(status(() => addLink(db, { url: "https://example.org/d", libraryId: g.id }))).toBe(403);
		expect(status(() => addFile(db, { name: "n.pdf", dataBase64: Buffer.from("n").toString("base64"), collectionKey: coll.key }))).toBe(403);
		expect(status(() => duplicateItem(db, lone.data.key))).toBe(403);
		expect(status(() => addLink(db, { url: "https://example.org/e" }))).toBeUndefined(); // My Library is unaffected
	});
});
