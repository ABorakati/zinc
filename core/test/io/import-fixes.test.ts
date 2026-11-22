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

describe("Zotero RDF volume and issue per article", () => {
	const article = (title: string, volume: string, issue: string) => ({
		itemType: "journalArticle" as const,
		title,
		publicationTitle: "The Lancet",
		journalAbbreviation: "Lancet",
		ISSN: "0140-6736",
		volume,
		issue,
	});

	test("two articles of one journal keep their own volume and issue", async () => {
		const src = freshDb();
		createItem(src, article("First", "1", "2"));
		createItem(src, article("Second", "9", "7"));
		const rdf = await exportText(src, "rdf");
		// the first container takes the ISSN uri, as Zotero's own exporter does; the next one is a separate resource
		expect(rdf.match(/rdf:about="urn:issn:0140-6736"/g)?.length).toBe(1);
		expect(rdf.match(/<prism:volume>/g)?.length).toBe(2);

		const dst = freshDb();
		const r = await importInto(dst, rdf, { collectionName: null });
		expect(r.body.errors).toEqual([]);
		for (const [title, volume, issue] of [
			["First", "1", "2"],
			["Second", "9", "7"],
		] as const) {
			const d = dataOf(dst, keyByTitle(dst, title));
			expect([d.volume, d.issue, d.publicationTitle, d.journalAbbreviation, d.ISSN]).toEqual([volume, issue, "The Lancet", "Lancet", "0140-6736"]);
		}
	});

	test("a file written with one shared container still imports", async () => {
		const old = `<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:bib="http://purl.org/net/biblio#"
         xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
         xmlns:prism="http://prismstandard.org/namespaces/1.2/basic/" xmlns:z="http://www.zotero.org/namespaces/export#">
  <bib:Article rdf:about="#item_1"><z:itemType>journalArticle</z:itemType><dcterms:isPartOf rdf:resource="urn:issn:0140-6736"/><dc:title>One</dc:title></bib:Article>
  <bib:Article rdf:about="#item_2"><z:itemType>journalArticle</z:itemType><dcterms:isPartOf rdf:resource="urn:issn:0140-6736"/><dc:title>Two</dc:title></bib:Article>
  <bib:Journal rdf:about="urn:issn:0140-6736"><dc:title>The Lancet</dc:title><prism:volume>1</prism:volume><prism:number>2</prism:number></bib:Journal>
</rdf:RDF>`;
		const dst = freshDb();
		const r = await importInto(dst, old, { collectionName: null });
		expect(r.body.errors).toEqual([]);
		for (const title of ["One", "Two"]) {
			const d = dataOf(dst, keyByTitle(dst, title));
			expect([d.volume, d.issue, d.publicationTitle]).toEqual(["1", "2", "The Lancet"]);
		}
	});
});

describe("cyclic collection parts in RDF", () => {
	test("a collection that contains its own ancestor does not overflow the stack", async () => {
		const rdf = `<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:bib="http://purl.org/net/biblio#"
         xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
         xmlns:z="http://www.zotero.org/namespaces/export#">
  <bib:Book rdf:about="#item_1"><z:itemType>book</z:itemType><dc:title>In B</dc:title></bib:Book>
  <z:Collection rdf:about="#c_r"><dc:title>R</dc:title><dcterms:hasPart rdf:resource="#c_a"/></z:Collection>
  <z:Collection rdf:about="#c_a"><dc:title>A</dc:title><dcterms:hasPart rdf:resource="#c_b"/></z:Collection>
  <z:Collection rdf:about="#c_b"><dc:title>B</dc:title><dcterms:hasPart rdf:resource="#c_a"/><dcterms:hasPart rdf:resource="#c_b"/><dcterms:hasPart rdf:resource="#item_1"/></z:Collection>
</rdf:RDF>`;
		const dst = freshDb();
		const r = await importInto(dst, rdf, { collectionName: null });
		expect(r.status).toBe(200);
		expect(r.body.errors).toEqual([]);
		const b = collectionOf(dst, "B");
		expect(titlesIn(dst, b.key)).toEqual(["In B"]);
		expect(collectionOf(dst, "A").parent_key).toBe(collectionOf(dst, "R").key);
		expect(b.parent_key).toBe(collectionOf(dst, "A").key);
	});
});
