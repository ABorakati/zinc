// Regression tests for import / export fixes: nested collections, RDF volume and issue, BibTeX names, and so on.
import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import { createCipheriv } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decryptMendeleyDb, libraryKey } from "../../src/import/mendeley";
import { createCollection, createItem, listItems, openDb } from "../../src/db";
import { upsertGroupLibrary } from "../../src/libraries";
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

describe("BibTeX names with braces", () => {
	const authorsOf = async (author: string) => {
		const db = freshDb();
		const r = await importInto(db, `@article{k, title = {T}, author = {${author}}, year = {2020}}`, { format: "bibtex", collectionName: null });
		expect(r.body.errors).toEqual([]);
		return (dataOf(db, keyByTitle(db, "T")).creators as { firstName?: string; lastName?: string; name?: string }[]).map((c) =>
			c.name !== undefined ? c.name : `${c.lastName}|${c.firstName}`,
		);
	};
	test("a braced institution with braces inside stays one name", async () => {
		expect(await authorsOf('{Universit{\\"a}t Z{\\"u}rich}')).toEqual(["Universität Zürich"]);
		expect(await authorsOf("{Cl{\\'e}ment Consortium} and Smith, John")).toEqual(["Clément Consortium", "Smith|John"]);
	});
	test("separately braced parts of a name are still split", async () => {
		expect(await authorsOf("{Smith}, {John}")).toEqual(["Smith|John"]);
		expect(await authorsOf("{Smith}, {John {Jr}}")).toEqual(["Smith|John Jr"]);
		expect(await authorsOf("{Smith} {Jones}")).toEqual(["Jones|Smith"]);
	});
});

describe("Mendeley", () => {
	const PROFILE = "11111111-2222-3333-4444-555555555555";
	const HEADER = Buffer.from("SQLite format 3\0", "latin1");

	/** Plain pages with an SQLite header, encrypted the way Mendeley does it (OFB, 12 reserved bytes per page). */
	function encryptedPages(key: Buffer): { plain: Buffer; encrypted: Buffer } {
		const size = 4096;
		const plain = Buffer.alloc(size * 3);
		HEADER.copy(plain, 0);
		plain.writeUInt16BE(size, 16);
		plain[20] = 12;
		for (let i = 24; i < plain.length; i++) if (i % size < size - 12) plain[i] = (i * 31) & 0xff;
		const encrypted = Buffer.from(plain);
		for (let n = 1; n <= 3; n++) {
			const page = encrypted.subarray((n - 1) * size, n * size);
			const size12 = size - 12;
			for (let i = 0; i < 12; i++) page[size12 + i] = (n * 7 + i) & 0xff;
			const iv = Buffer.alloc(16);
			iv.writeUInt32LE(n, 0);
			page.copy(iv, 4, size12);
			const clear = Buffer.from(page.subarray(16, 24));
			const ks = createCipheriv("aes-256-ofb", key, iv).update(Buffer.alloc(size12));
			for (let i = 0; i < size12; i++) page[i] ^= ks[i]!;
			if (n === 1) clear.copy(page, 16);
		}
		return { plain, encrypted };
	}

	test("a database encrypted with the profile key opens when it is read from a copy", () => {
		const dir = tempDir();
		const { plain, encrypted } = encryptedPages(libraryKey(PROFILE));
		const named = join(dir, `${PROFILE}@www.mendeley.com.sqlite`);
		const copy = join(dir, "mendeley.sqlite"); // the importer works on a copy with a neutral name
		writeFileSync(named, encrypted);
		writeFileSync(copy, encrypted);
		const out = join(dir, "out.sqlite");
		decryptMendeleyDb(copy, out, named);
		const got = readFileSync(out);
		expect(got.subarray(0, 16).equals(HEADER)).toBe(true);
		// everything but the reserved bytes of each page is the original
		for (let n = 0; n < 3; n++) expect(got.subarray(n * 4096, n * 4096 + 4084).equals(plain.subarray(n * 4096, n * 4096 + 4084))).toBe(true);
		// and without the profile name the profile key cannot be derived
		expect(() => decryptMendeleyDb(copy, join(dir, "out2.sqlite"))).toThrow("cannot derive");
	});

	test("the import finds the profile key from the name of the original file", async () => {
		const dir = tempDir();
		const path = join(dir, `${PROFILE}@www.mendeley.com.sqlite`);
		writeFileSync(path, encryptedPages(libraryKey(PROFILE)).encrypted);
		const r = await call(freshDb(), "POST", "/api/io/mendeley", { path });
		// the key is derived; the synthetic pages are not a real library, so reading it fails later and differently
		expect(((await r.json()) as { error: string }).error).not.toContain("cannot derive");
	});

	test("a document in more than 50 folders is filed in all of them", async () => {
		const dir = tempDir();
		const path = join(dir, "lib.sqlite");
		const m = new Sqlite(path, { create: true });
		m.exec(`
			CREATE TABLE Documents (id INTEGER PRIMARY KEY, uuid TEXT, type TEXT, title TEXT, abstract TEXT, year TEXT, month TEXT, day TEXT,
				publication TEXT, volume TEXT, issue TEXT, pages TEXT, doi TEXT, isbn TEXT, issn TEXT, publisher TEXT, city TEXT, country TEXT,
				note TEXT, added TEXT, modified TEXT, inTrash TEXT, favourite TEXT, citationKey TEXT, pmid TEXT);
			CREATE TABLE DocumentContributors (documentId INTEGER, contribution TEXT, firstNames TEXT, lastName TEXT);
			CREATE TABLE DocumentTags (documentId INTEGER, tag TEXT);
			CREATE TABLE DocumentKeywords (documentId INTEGER, keyword TEXT);
			CREATE TABLE DocumentFolders (documentId INTEGER, folderId INTEGER);
			CREATE TABLE Folders (id INTEGER PRIMARY KEY, name TEXT, parentId INTEGER, groupId INTEGER);
			CREATE TABLE DocumentFiles (documentId INTEGER, hash TEXT);
			CREATE TABLE Files (hash TEXT, localUrl TEXT);
			CREATE TABLE DocumentUrls (documentId INTEGER, url BLOB, position INTEGER);
		`);
		m.query(
			"INSERT INTO Documents VALUES (1, '{AAAAAAAA-1111-2222-3333-444444444444}', 'Book', 'Many folders', '', '2001', '', '', '', '', '', '', '', NULL, NULL, '', '', '', '', '1', '1', 'false', 'false', '', '')",
		).run();
		for (let i = 1; i <= 60; i++) {
			m.query("INSERT INTO Folders VALUES (?, ?, -1, 0)").run(100 + i, `Folder ${i}`);
			m.query("INSERT INTO DocumentFolders VALUES (1, ?)").run(100 + i);
		}
		m.close();
		const db = freshDb();
		const res = await call(db, "POST", "/api/io/mendeley", { path, collectionName: null });
		const body = (await res.json()) as { created: number; errors: string[] };
		expect(body).toMatchObject({ created: 1, errors: [] });
		expect(db.query("SELECT count(*) AS n FROM collection_items").get()).toEqual({ n: 60 });
	});
});

describe("whole-library RDF export and other libraries", () => {
	test("collections of a group library are not written into My Library's export", async () => {
		const db = freshDb();
		const g = upsertGroupLibrary(db, { groupId: 500, name: "Group", editable: true, filesEditable: true, version: 1 });
		createCollection(db, "Mine");
		createCollection(db, "Theirs", null, g.id);
		createItem(db, { itemType: "book", title: "In my library" });

		const mine = await exportText(db, "rdf");
		expect(mine).toContain("<dc:title>Mine</dc:title>");
		expect(mine).not.toContain("Theirs");

		const theirs = await exportText(db, "rdf", { library: g.id });
		expect(theirs).toContain("<dc:title>Theirs</dc:title>");
		expect(theirs).not.toContain("<dc:title>Mine</dc:title>");
	});
});
