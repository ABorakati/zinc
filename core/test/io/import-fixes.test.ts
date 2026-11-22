// Regression tests for import / export fixes: nested collections, RDF volume and issue, BibTeX names, and so on.
import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createCollection, createItem, listItems, openDb } from "../../src/db";
import { call, tempDir } from "../fixture";

const dbs: Database[] = [];
function freshDb(): Database {
	const db = openDb(join(tempDir(), "lib.sqlite"));
	dbs.push(db);
	return db;
}
afterAll(() => {
	for (const d of dbs) d.close(true);
});

async function exportText(db: Database, format: string, extra: Record<string, unknown> = {}): Promise<string> {
	const res = await call(db, "POST", "/api/io/export", { format, ...extra });
	expect(res.status).toBe(200);
	return ((await res.json()) as { text: string }).text;
}
async function importInto(db: Database, text: string, extra: Record<string, unknown> = {}) {
	const res = await call(db, "POST", "/api/io/import", { text, ...extra });
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const dataOf = (db: Database, key: string): Record<string, any> =>
	JSON.parse((db.query("SELECT data FROM items WHERE key = ?").get(key) as { data: string }).data);
const keyByTitle = (db: Database, title: string): string =>
	(db.query("SELECT key FROM items WHERE title = ?").get(title) as { key: string }).key;
const collectionOf = (db: Database, name: string) =>
	db.query("SELECT key, name, parent_key FROM collections WHERE name = ?").get(name) as { key: string; name: string; parent_key: string | null };
const titlesIn = (db: Database, key: string) => listItems(db, { collection: key, limit: 50 }).items.map((i) => i.title).sort();

describe("nested collections on import", () => {
	test("every item of a new nested collection lands in the deepest collection", async () => {
		const src = freshDb();
		const top = createCollection(src, "Top");
		const mid = createCollection(src, "Mid", top.key);
		const leaf = createCollection(src, "Leaf", mid.key);
		createItem(src, { itemType: "book", title: "A", collections: [leaf.key] });
		createItem(src, { itemType: "book", title: "B", collections: [leaf.key] });
		const rdf = await exportText(src, "rdf");

		const dst = freshDb();
		const r = await importInto(dst, rdf, { collectionName: null });
		expect(r.body.errors).toEqual([]);
		expect(r.body.created).toBe(2);
		const leafKey = collectionOf(dst, "Leaf").key;
		expect(titlesIn(dst, leafKey)).toEqual(["A", "B"]);
		expect(titlesIn(dst, collectionOf(dst, "Top").key)).toEqual([]);
	});
});

const FILED_THEN_LOOSE = `<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:bib="http://purl.org/net/biblio#"
         xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
         xmlns:z="http://www.zotero.org/namespaces/export#">
  <bib:Book rdf:about="#item_1"><z:itemType>book</z:itemType><dc:title>Filed</dc:title></bib:Book>
  <bib:Book rdf:about="#item_2"><z:itemType>book</z:itemType><dc:title>Loose</dc:title></bib:Book>
  <z:Collection rdf:about="#collection_1"><dc:title>Only</dc:title><dcterms:hasPart rdf:resource="#item_1"/></z:Collection>
</rdf:RDF>`;

describe("items without a collection in a file that has collections", () => {
	test("they are not filed under the first item's collection", async () => {
		const dst = freshDb();
		const r = await importInto(dst, FILED_THEN_LOOSE, { collectionName: null });
		expect(r.body.errors).toEqual([]);
		const only = collectionOf(dst, "Only");
		expect(titlesIn(dst, only.key)).toEqual(["Filed"]);
		expect(r.body.collectionKey).toBe(only.key);

		// with the default "import into a new collection", the loose item goes there instead
		const dst2 = freshDb();
		const r2 = await importInto(dst2, FILED_THEN_LOOSE);
		expect(r2.body.errors).toEqual([]);
		const only2 = collectionOf(dst2, "Only");
		expect(titlesIn(dst2, only2.key)).toEqual(["Filed"]);
		const imported = dst2.query("SELECT key FROM collections WHERE name LIKE 'Imported %'").get() as { key: string } | null;
		expect(imported).not.toBeNull();
		expect(titlesIn(dst2, imported!.key)).toEqual(["Loose"]);
	});
});
