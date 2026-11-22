// Find Full Text in group libraries: the snapshot carries the real library and its permissions, and saving a PDF re-checks them
// (the permission can change while a job runs). Temp folders and temp databases only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createItem, openDb } from "../../src/db";
import { OpError } from "../../src/fulltext/http";
import { snapshotItems } from "../../src/fulltext/items";
import { savePdf } from "../../src/fulltext/save";
import { upsertGroupLibrary } from "../../src/libraries";
import { tempDir } from "../fixture";

let dir: string;
let db: Database;
beforeEach(() => {
	dir = tempDir();
	db = openDb(join(dir, "library.sqlite"));
});
afterEach(() => db.close(true));

const group = (groupId: number, editable = true, filesEditable = true) =>
	upsertGroupLibrary(db, { groupId, name: `Group ${groupId}`, editable, filesEditable, version: 1 }).id;
const lock = (g: number, editable: number, filesEditable: number) =>
	db.query("UPDATE libraries SET editable = ?, files_editable = ? WHERE id = ?").run(editable, filesEditable, g);

function save(parent: string, staged: string) {
	const bodies = { get: () => ({ kind: "pdf", path: staged }), release: () => {} } as never;
	return savePdf(
		{ db, dataDir: dir, bodies, keyOfItem: () => parent, ezproxySuffix: "" },
		{
			item: 1,
			body: { handle: 1, len: 1 },
			trim_prefix: 0,
			version: "published",
			url_to_store: "https://example.org/a.pdf",
			route: "x",
			source: "y",
		},
	);
}

describe("snapshot library", () => {
	test("My Library items are editable user-library items", () => {
		const k = createItem(db, { itemType: "journalArticle", title: "Mine" }, 1).data.key;
		const lib = snapshotItems(db, [k]).items[0].snapshot.library;
		expect(lib).toMatchObject({ id: 1, kind: "user", files_editable: true });
	});

	test("group items carry the group's id, kind and file permission", () => {
		const g = group(55);
		const k = createItem(db, { itemType: "journalArticle", title: "Shared" }, g).data.key;
		const s = snapshotItems(db, [k]).items[0].snapshot;
		expect(s.library).toMatchObject({ id: g, kind: "group", files_editable: true, name: "Group 55" });
		expect(s.key).toBe(`${g}/${k}`);
		lock(g, 1, 0);
		expect(snapshotItems(db, [k]).items[0].snapshot.library.files_editable).toBe(false);
		lock(g, 0, 1);
		expect(snapshotItems(db, [k]).items[0].snapshot.library.files_editable).toBe(false);
	});
});

describe("savePdf permissions", () => {
	test("a read-only group refuses the save and creates nothing", () => {
		const g = group(56);
		const k = createItem(db, { itemType: "journalArticle", title: "Shared" }, g).data.key;
		lock(g, 0, 0);
		const staged = join(dir, "s.pdf");
		writeFileSync(staged, "%PDF-1.4 body");
		let err: unknown;
		try {
			save(k, staged);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(OpError);
		expect((err as OpError).kind).toBe("not_editable");
		expect(db.query("SELECT COUNT(*) AS n FROM items WHERE parent_key = ?").get(k)).toEqual({ n: 0 });
		expect(existsSync(join(dir, "storage"))).toBe(false);
	});

	test("a group that forbids file changes refuses the save, one that allows them saves into the group", () => {
		const g = group(57, true, false);
		const k = createItem(db, { itemType: "journalArticle", title: "Shared" }, g).data.key;
		const staged = join(dir, "s2.pdf");
		writeFileSync(staged, "%PDF-1.4 body");
		expect(() => save(k, staged)).toThrow(/does not allow|not_editable|file/i);
		db.query("UPDATE libraries SET files_editable = 1 WHERE id = ?").run(g);
		const r = save(k, staged);
		expect(db.query("SELECT library_id FROM items WHERE key = ?").get(r.attachment_key)).toEqual({ library_id: g });
	});
});
