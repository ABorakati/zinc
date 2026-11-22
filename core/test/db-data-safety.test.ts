// db.ts: annotation ids across attachments, string tags in a patch, atomic collection updates, attachment fields mirrored
// into the attachments table, a bounded file cache. Temp folders and temp databases only.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	createCollection,
	createItem,
	fileCacheSize,
	fileExists,
	getAnnotations,
	openDb,
	patchItem,
	updateCollection,
	upsertAnnotations,
} from "../src/db";
import { upsertGroupLibrary } from "../src/libraries";
import { tempDir } from "./fixture";

let dir: string;
let db: Database;
beforeEach(() => {
	dir = tempDir();
	db = openDb(join(dir, "library.sqlite"));
});
afterEach(() => db.close(true));

const attachment = (lib = 1, parent?: string) =>
	createItem(db, { itemType: "attachment", linkMode: "imported_file", title: "p.pdf", contentType: "application/pdf", parentItem: parent }, lib)
		.data.key;
const ann = (id: string, comment = "c") =>
	({ id, type: "highlight", sortIndex: "00000|000000|00000", comment, position: { pageIndex: 0 }, dateModified: "2024-01-01T00:00:00Z" }) as never;
const status = (fn: () => unknown): number | undefined => {
	try {
		fn();
	} catch (e) {
		return (e as { status?: number }).status;
	}
	return undefined;
};

describe("an annotation id that belongs to another attachment", () => {
	test("is neither moved nor overwritten, and the request is refused", () => {
		const a = attachment();
		const b = attachment();
		upsertAnnotations(db, a, [ann("VICTIM01", "original")]);
		expect(status(() => upsertAnnotations(db, b, [ann("OWN00001"), ann("VICTIM01", "taken")]))).toBe(409);
		expect(getAnnotations(db, a).map((x) => (x as { comment?: string }).comment)).toEqual(["original"]);
		expect(getAnnotations(db, b)).toEqual([]); // the refused request wrote nothing, not even the allowed first annotation
	});

	test("the same annotation saved again on its own attachment is updated", () => {
		const a = attachment();
		upsertAnnotations(db, a, [ann("ANNOT001", "one")]);
		upsertAnnotations(db, a, [ann("ANNOT001", "one")]); // identical re-save
		upsertAnnotations(db, a, [ann("ANNOT001", "two")]);
		expect(getAnnotations(db, a).map((x) => (x as { comment?: string }).comment)).toEqual(["two"]);
	});

	test("a read-only group's annotation cannot be replaced from My Library", () => {
		const g = upsertGroupLibrary(db, { groupId: 9, name: "G", editable: true, filesEditable: true, version: 1 }).id;
		const theirs = attachment(g);
		upsertAnnotations(db, theirs, [ann("GROUPANN", "group")]);
		db.query("UPDATE libraries SET editable = 0, files_editable = 0 WHERE id = ?").run(g);
		const mine = attachment(1);
		expect(status(() => upsertAnnotations(db, mine, [ann("GROUPANN", "mine")]))).toBe(409);
		expect(getAnnotations(db, theirs).map((x) => (x as { comment?: string }).comment)).toEqual(["group"]);
	});
});

describe("patchItem with plain string tags", () => {
	const tagsOf = (key: string) =>
		(db.query("SELECT tag FROM item_tags WHERE item_key = ? ORDER BY tag").all(key) as { tag: string }[]).map((r) => r.tag);

	test("sets them instead of clearing the item's tags", () => {
		const key = createItem(db, { itemType: "journalArticle", title: "T", tags: [{ tag: "x" }, { tag: "y" }] }).data.key;
		const out = patchItem(db, key, { tags: ["z", " w ", "z"] } as never);
		expect(tagsOf(key)).toEqual(["w", "z"]);
		expect(out.data.tags).toEqual([{ tag: "z" }, { tag: "w" }]);
	});

	test("objects (with a type) and an explicit empty list behave as before", () => {
		const key = createItem(db, { itemType: "journalArticle", title: "T", tags: [{ tag: "x" }] }).data.key;
		patchItem(db, key, { tags: [{ tag: "a", type: 1 }, { tag: "b" }, "c"] } as never);
		expect(db.query("SELECT tag, type FROM item_tags WHERE item_key = ? ORDER BY tag").all(key)).toEqual([
			{ tag: "a", type: 1 },
			{ tag: "b", type: 0 },
			{ tag: "c", type: 0 },
		]);
		patchItem(db, key, { tags: [] });
		expect(tagsOf(key)).toEqual([]);
	});
});

describe("updateCollection", () => {
	test("a refused move leaves the name as it was", () => {
		const c = createCollection(db, "Original").key;
		expect(status(() => updateCollection(db, c, { name: "Renamed", parentKey: "NOPE0000" }))).toBe(404);
		expect(status(() => updateCollection(db, c, { name: "Renamed", parentKey: c }))).toBe(400);
		expect(db.query("SELECT name, parent_key FROM collections WHERE key = ?").get(c)).toEqual({ name: "Original", parent_key: null });
	});

	test("a valid rename and move still apply together", () => {
		const parent = createCollection(db, "Parent").key;
		const c = createCollection(db, "Original").key;
		updateCollection(db, c, { name: "Renamed", parentKey: parent });
		expect(db.query("SELECT name, parent_key FROM collections WHERE key = ?").get(c)).toEqual({ name: "Renamed", parent_key: parent });
	});
});

describe("patchItem on an attachment keeps the attachments table in step", () => {
	const row = (key: string) => db.query("SELECT link_mode, content_type, url, path FROM attachments WHERE item_key = ?").get(key);

	test("url, contentType and linkMode follow the item, the path does not move", () => {
		const key = attachment();
		db.query("UPDATE attachments SET path = '/some/where.pdf' WHERE item_key = ?").run(key);
		patchItem(db, key, { url: "https://example.org/x", contentType: "text/html", linkMode: "imported_url" } as never);
		expect(row(key)).toEqual({ link_mode: "imported_url", content_type: "text/html", url: "https://example.org/x", path: "/some/where.pdf" });
		patchItem(db, key, { url: "" } as never);
		expect(row(key)).toMatchObject({ url: null, content_type: "text/html", link_mode: "imported_url" });
	});

	test("a patch of other fields leaves the row alone", () => {
		const key = attachment();
		const before = row(key);
		patchItem(db, key, { title: "renamed" });
		expect(row(key)).toEqual(before);
	});

	test("a non-attachment item gets no attachments row", () => {
		const key = createItem(db, { itemType: "journalArticle", title: "T" }).data.key;
		patchItem(db, key, { url: "https://example.org", contentType: "text/html" } as never);
		expect(db.query("SELECT COUNT(*) AS n FROM attachments WHERE item_key = ?").get(key)).toEqual({ n: 0 });
	});
});

describe("the file-existence cache", () => {
	test("stays bounded and keeps answering correctly", () => {
		for (let i = 0; i < 6000; i++) expect(fileExists(join(dir, `no-such-${i}.pdf`))).toBe(false);
		expect(fileCacheSize()).toBeLessThanOrEqual(5000);
		expect(fileExists(join(dir, "library.sqlite"))).toBe(true);
	});
});
