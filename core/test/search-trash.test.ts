// A trashed attachment's full text is not searchable, and is again after a restore. Temp databases only.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { createItem, openDb, patchItem } from "../src/db";
import { indexItem, rebuildSearchIndex, search } from "../src/search";
import { tempDir } from "./fixture";

let db: Database;
beforeEach(() => {
	db = openDb(join(tempDir(), "library.sqlite"));
});
afterEach(() => db.close(true));

function paperWithPdfText(): { parent: string; att: string } {
	const parent = createItem(db, { itemType: "journalArticle", title: "Unrelated title" }).data.key;
	const att = createItem(db, { itemType: "attachment", linkMode: "imported_file", contentType: "application/pdf", parentItem: parent }).data
		.key;
	db.query("INSERT INTO fulltext(attachment_key, content, source, indexed_at) VALUES(?, ?, 'test', '2024-01-01T00:00:00Z')").run(
		att,
		"zebrafish regeneration",
	);
	indexItem(db, parent);
	return { parent, att };
}
const hits = (q: string) => search(db, q).hits.map((h) => h.key);

test("trashing the attachment removes its text from the parent's index, restoring brings it back", () => {
	const { parent, att } = paperWithPdfText();
	expect(hits("zebrafish")).toEqual([parent]);
	patchItem(db, att, { deleted: 1 });
	indexItem(db, att); // what PATCH /api/items/:key does after the patch
	expect(hits("zebrafish")).toEqual([]);
	patchItem(db, att, { deleted: 0 });
	indexItem(db, att);
	expect(hits("zebrafish")).toEqual([parent]);
});

test("a rebuild of the whole index agrees", () => {
	const { parent, att } = paperWithPdfText();
	patchItem(db, att, { deleted: 1 });
	rebuildSearchIndex(db);
	expect(hits("zebrafish")).toEqual([]);
	patchItem(db, att, { deleted: 0 });
	rebuildSearchIndex(db);
	expect(hits("zebrafish")).toEqual([parent]);
});

test("the text of a second, live attachment stays searchable while the first is in the trash", () => {
	const { parent, att } = paperWithPdfText();
	const other = createItem(db, { itemType: "attachment", linkMode: "imported_file", contentType: "application/pdf", parentItem: parent }).data
		.key;
	db.query("INSERT INTO fulltext(attachment_key, content, source, indexed_at) VALUES(?, 'axolotl limb', 'test', '2024-01-01T00:00:00Z')").run(
		other,
	);
	patchItem(db, att, { deleted: 1 });
	indexItem(db, att);
	expect(hits("zebrafish")).toEqual([]);
	expect(hits("axolotl")).toEqual([parent]);
});
