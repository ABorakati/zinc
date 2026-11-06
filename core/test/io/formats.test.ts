// Zotero RDF, MODS and Mendeley Desktop imports: sample files modelled on Zotero's translator test cases.
import type { Database } from "bun:sqlite";
import { Database as Sqlite } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ItemDetail, ZoteroItemData } from "../../src/api-types";
import { addFile, hooks } from "../../src/additems/files";
import { createCollection, createItem, listItems, openDb } from "../../src/db";
import { detectFormat } from "../../src/io/import";
import { call, tempDir } from "../fixture";

const originalAfterImport = hooks.afterImport;
beforeAll(() => {
	hooks.afterImport = () => {}; // no background full-text extraction in these tests
});
afterAll(() => {
	hooks.afterImport = originalAfterImport;
});

const dbs: Database[] = [];
function freshDb(): Database {
	const db = openDb(join(tempDir(), "lib.sqlite"));
	dbs.push(db);
	return db;
}
afterAll(() => {
	for (const d of dbs) d.close(true);
});

const mk = (db: Database, data: Partial<ZoteroItemData>): ItemDetail => createItem(db, data);
const dataOf = (db: Database, key: string): ZoteroItemData =>
	JSON.parse((db.query("SELECT data FROM items WHERE key = ?").get(key) as { data: string }).data);
const byTitle = (db: Database, title: string): ZoteroItemData => {
	const row = db.query("SELECT key FROM items WHERE title = ?").get(title) as { key: string } | null;
	if (!row) throw new Error(`no item titled ${title}`);
	return dataOf(db, row.key);
};
const childNotes = (db: Database, key: string): string[] =>
	(db.query("SELECT data FROM items WHERE parent_key = ? AND item_type = 'note'").all(key) as { data: string }[]).map(
		(r) => String(JSON.parse(r.data).note ?? ""),
	);

async function importInto(db: Database, text: string, extra: Record<string, unknown> = {}) {
	const res = await call(db, "POST", "/api/io/import", { text, ...extra });
	return { status: res.status, body: (await res.json()) as Record<string, any> };
}

// ---------------------------------------------------------------- samples

const RDF_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:bib="http://purl.org/net/biblio#"
         xmlns:dc="http://purl.org/dc/elements/1.1/"
         xmlns:dcterms="http://purl.org/dc/terms/"
         xmlns:prism="http://prismstandard.org/namespaces/1.2/basic/"
         xmlns:foaf="http://xmlns.com/foaf/0.1/"
         xmlns:vcard="http://nwalsh.com/rdf/vCard#"
         xmlns:link="http://purl.org/rss/1.0/modules/link/"
         xmlns:z="http://www.zotero.org/namespaces/export#">
  <bib:Article rdf:about="#item_1">
    <z:itemType>journalArticle</z:itemType>
    <dcterms:isPartOf rdf:resource="urn:issn:0140-6736"/>
    <dc:title>Outcomes after liver transplantation</dc:title>
    <bib:authors><rdf:Seq>
      <rdf:li><foaf:Person><foaf:surname>Smith</foaf:surname><foaf:givenName>Jane</foaf:givenName></foaf:Person></rdf:li>
      <rdf:li><foaf:Person><foaf:surname>Müller-García</foaf:surname><foaf:givenName>José</foaf:givenName></foaf:Person></rdf:li>
    </rdf:Seq></bib:authors>
    <bib:editors><rdf:Seq>
      <rdf:li><foaf:Person><foaf:surname>Patel</foaf:surname><foaf:givenName>Dev</foaf:givenName></foaf:Person></rdf:li>
    </rdf:Seq></bib:editors>
    <dc:date>2023-11-02</dc:date>
    <bib:pages>100-110</bib:pages>
    <dcterms:abstract>We studied 100% of patients.</dcterms:abstract>
    <dc:identifier>DOI 10.1016/s0140-6736(23)00001-1</dc:identifier>
    <dc:identifier><dcterms:URI><rdf:value>https://example.org/a</rdf:value></dcterms:URI></dc:identifier>
    <dc:subject>transplant</dc:subject>
    <dc:subject><z:AutomaticTag><rdf:value>liver</rdf:value></z:AutomaticTag></dc:subject>
    <dc:description>Citation Key: smith2023outcomes</dc:description>
    <dcterms:isReferencedBy rdf:resource="#item_1_note"/>
    <link:link><z:Attachment>
      <z:path>files/1/paper.pdf</z:path>
      <dc:title>PDF</dc:title>
      <link:type>application/pdf</link:type>
    </z:Attachment></link:link>
    <link:link rdf:resource="https://example.org/supplement"/>
  </bib:Article>
  <bib:Memo rdf:about="#item_1_note"><rdf:value>&lt;p&gt;Remember this&lt;/p&gt;</rdf:value></bib:Memo>
  <bib:Journal rdf:about="urn:issn:0140-6736">
    <dc:title>The Lancet</dc:title>
    <dcterms:alternative>Lancet</dcterms:alternative>
    <dc:identifier>ISSN 0140-6736</dc:identifier>
  </bib:Journal>
  <bib:Book rdf:about="#item_2">
    <z:itemType>book</z:itemType>
    <dc:title>Surgical Anatomy</dc:title>
    <dc:date>2018</dc:date>
    <bib:authors><rdf:Seq>
      <rdf:li><foaf:Person><foaf:surname>Brown</foaf:surname><foaf:givenName>Cara</foaf:givenName></foaf:Person></rdf:li>
    </rdf:Seq></bib:authors>
    <dc:publisher><foaf:Organization>
      <foaf:name>Oxford University Press</foaf:name>
      <vcard:adr><vcard:Address><vcard:locality>Oxford</vcard:locality></vcard:Address></vcard:adr>
    </foaf:Organization></dc:publisher>
    <dc:identifier>ISBN 9780198000000</dc:identifier>
  </bib:Book>
  <z:Collection rdf:about="#collection_ROOT">
    <dc:title>Imported</dc:title>
    <dcterms:hasPart rdf:resource="#collection_SUB"/>
    <dcterms:hasPart rdf:resource="#item_1"/>
  </z:Collection>
  <z:Collection rdf:about="#collection_SUB">
    <dc:title>Trials</dc:title>
    <dcterms:hasPart rdf:resource="#item_2"/>
  </z:Collection>
</rdf:RDF>
`;

const MODS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<modsCollection xmlns="http://www.loc.gov/mods/v3">
  <mods>
    <titleInfo><title>The spleen</title></titleInfo>
    <titleInfo type="abbreviated"><title>Spleen</title></titleInfo>
    <typeOfResource>text</typeOfResource>
    <genre authority="local">journalArticle</genre>
    <genre authority="marcgt">journal</genre>
    <name type="personal">
      <namePart type="family">Lee</namePart>
      <namePart type="given">Ann</namePart>
      <role><roleTerm type="code" authority="marcrelator">aut</roleTerm></role>
    </name>
    <name type="personal">
      <namePart type="family">Kim</namePart>
      <namePart type="given">Bo</namePart>
      <role><roleTerm type="code" authority="marcrelator">edt</roleTerm></role>
    </name>
    <originInfo><dateIssued>2020-05</dateIssued><issuance>continuing</issuance></originInfo>
    <part>
      <detail type="volume"><number>4</number></detail>
      <detail type="issue"><number>2</number></detail>
      <extent unit="pages"><start>45</start><end>67</end></extent>
    </part>
    <identifier type="doi">10.5555/spleen.1</identifier>
    <location><url usage="primary display" dateLastAccessed="2024-02-01">https://example.org/spleen</url></location>
    <abstract>About the spleen.</abstract>
    <subject><topic>anatomy</topic></subject>
    <subject><topic>surgery</topic></subject>
    <language><languageTerm type="text">en</languageTerm></language>
    <note>Remember this</note>
    <relatedItem type="host">
      <titleInfo><title>Textbook of Surgery</title></titleInfo>
      <titleInfo type="abbreviated"><title>Textbook Surg</title></titleInfo>
      <identifier type="issn">1234-5678</identifier>
      <originInfo>
        <publisher>Elsevier</publisher>
        <place><placeTerm type="text">London</placeTerm></place>
      </originInfo>
      <part><detail type="volume"><number>4</number></detail></part>
    </relatedItem>
  </mods>
  <mods>
    <titleInfo><title>Surgical Anatomy</title></titleInfo>
    <genre authority="local">book</genre>
    <name type="personal">
      <namePart type="family">Brown</namePart>
      <namePart type="given">Cara</namePart>
      <role><roleTerm type="code" authority="marcrelator">aut</roleTerm></role>
    </name>
    <originInfo><publisher>Oxford University Press</publisher><copyrightDate>2018</copyrightDate></originInfo>
    <identifier type="isbn">978-0-19-800000-1</identifier>
  </mods>
</modsCollection>
`;

// ---------------------------------------------------------------- RDF

describe("Zotero RDF", () => {
	test("imports items, creators, tags, notes, collections and attachments", async () => {
		const dir = tempDir();
		mkdirSync(join(dir, "files", "1"), { recursive: true });
		writeFileSync(join(dir, "files", "1", "paper.pdf"), "%PDF-1.4 test");
		const db = freshDb();
		expect(detectFormat(RDF_SAMPLE)).toBe("rdf");
		const r = await importInto(db, RDF_SAMPLE, { basePath: dir, collectionName: null });
		expect(r.body.errors).toEqual([]);
		expect(r.body).toMatchObject({ created: 2, format: "rdf", collections: 2, attachments: 2 });

		const article = byTitle(db, "Outcomes after liver transplantation");
		expect(article).toMatchObject({
			itemType: "journalArticle",
			publicationTitle: "The Lancet",
			journalAbbreviation: "Lancet",
			pages: "100–110",
			date: "2023-11-02",
			DOI: "10.1016/s0140-6736(23)00001-1",
			url: "https://example.org/a",
			abstractNote: "We studied 100% of patients.",
			ISSN: "0140-6736",
			extra: "Citation Key: smith2023outcomes",
		});
		expect((article.creators ?? []).map((c) => `${c.creatorType}:${c.lastName}`)).toEqual([
			"author:Smith", "author:Müller-García", "editor:Patel",
		]);
		expect((article.tags ?? []).map((t) => `${t.tag}|${t.type ?? 0}`)).toEqual(["transplant|0", "liver|1"]);
		expect(childNotes(db, article.key)).toEqual(["<p>Remember this</p>"]);

		const attachments = db
			.query("SELECT i.title, a.link_mode, a.content_type, a.path, a.url FROM items i JOIN attachments a ON a.item_key = i.key WHERE i.parent_key = ? ORDER BY i.title")
			.all(article.key) as { title: string; link_mode: string; content_type: string | null; path: string | null; url: string | null }[];
		expect(attachments.map((a) => a.link_mode).sort()).toEqual(["imported_file", "linked_url"]);
		const file = attachments.find((a) => a.link_mode === "imported_file")!;
		expect(file.content_type).toBe("application/pdf");
		expect(existsSync(file.path!)).toBe(true);
		const link = attachments.find((a) => a.link_mode === "linked_url")!;
		expect(link.url).toBe("https://example.org/supplement");

		const book = byTitle(db, "Surgical Anatomy");
		expect(book).toMatchObject({ itemType: "book", publisher: "Oxford University Press", place: "Oxford", date: "2018", ISBN: "9780198000000" });

		// collection tree: root + nested, each with its item
		const names = db.query("SELECT key, name, parent_key FROM collections ORDER BY name").all() as { key: string; name: string; parent_key: string | null }[];
		expect(names.map((c) => c.name)).toEqual(["Imported", "Trials"]);
		const root = names.find((c) => c.name === "Imported")!;
		const sub = names.find((c) => c.name === "Trials")!;
		expect(sub.parent_key).toBe(root.key);
		expect(listItems(db, { collection: sub.key, limit: 10 }).items.map((i) => i.title)).toEqual(["Surgical Anatomy"]);
		expect(listItems(db, { collection: root.key, limit: 10 }).items.map((i) => i.title)).toEqual(["Outcomes after liver transplantation"]);
		expect(r.body.collectionKey).toBe(root.key);
	});

	test("missing attachment files are reported, not fatal", async () => {
		const db = freshDb();
		const r = await importInto(db, RDF_SAMPLE, { basePath: tempDir(), collectionName: null });
		expect(r.body.created).toBe(2);
		expect(r.body.attachments).toBe(1); // only the URL link
		expect(r.body.errors.join("\n")).toContain("attachment not found");
	});

	test("export and re-import keeps the item, collection and note", async () => {
		const db = freshDb();
		const root = createCollection(db, "Papers").key;
		const item = mk(db, {
			itemType: "journalArticle",
			title: "Alpha study",
			creators: [{ creatorType: "author", firstName: "Jane", lastName: "Smith" }],
			publicationTitle: "The Lancet",
			journalAbbreviation: "Lancet",
			volume: "383",
			issue: "9",
			pages: "100–110",
			date: "2023-11-02",
			DOI: "10.1016/s0140-6736(23)00001-1",
			ISSN: "0140-6736",
			abstractNote: "An abstract",
			tags: [{ tag: "transplant" }],
			collections: [root],
		});
		mk(db, { itemType: "note", note: "<p>Child note</p>", parentItem: item.data.key });
		const res = await call(db, "POST", "/api/io/export", { collectionKey: root, format: "rdf", includeNotes: true });
		const exported = (await res.json()) as { text: string; filename: string; count: number };
		expect(exported.filename).toBe("Papers.rdf");
		expect(exported.text).toContain("<z:itemType>journalArticle</z:itemType>");
		expect(exported.text).toContain("<foaf:surname>Smith</foaf:surname>");
		expect(exported.text).toContain("<dc:identifier>DOI 10.1016/s0140-6736(23)00001-1</dc:identifier>");
		expect(exported.text).toContain("<z:Collection");

		const other = freshDb();
		const r = await importInto(other, exported.text);
		expect(r.body.errors).toEqual([]);
		expect(r.body.created).toBe(1);
		const back = byTitle(other, "Alpha study");
		expect(back).toMatchObject({
			itemType: "journalArticle",
			publicationTitle: "The Lancet",
			journalAbbreviation: "Lancet",
			volume: "383",
			issue: "9",
			pages: "100–110",
			date: "2023-11-02",
			DOI: "10.1016/s0140-6736(23)00001-1",
			ISSN: "0140-6736",
			abstractNote: "An abstract",
		});
		expect((back.creators ?? []).map((c) => c.lastName)).toEqual(["Smith"]);
		expect((back.tags ?? []).map((t) => t.tag)).toEqual(["transplant"]);
		expect(childNotes(other, back.key)).toEqual(["<p>Child note</p>"]);
		const colls = other.query("SELECT name FROM collections").all() as { name: string }[];
		expect(colls.map((c) => c.name)).toEqual(["Papers"]);
	});

	test("export with a folder writes the file and copies attachment files", async () => {
		const db = freshDb();
		const dir = tempDir();
		const source = join(dir, "source.pdf");
		writeFileSync(source, "%PDF-1.4 attached");
		const item = mk(db, { itemType: "book", title: "With file", date: "2020" });
		const attachment = addFile(db, { mode: "linked_file", path: source, parentKey: item.data.key });
		expect(attachment.data.key).toBeTruthy();
		const out = join(dir, "export");
		const res = await call(db, "POST", "/api/io/export", { keys: [item.data.key], format: "rdf", dir: out, includeNotes: false });
		const body = (await res.json()) as { path: string; files: number; text: string };
		expect(body.files).toBe(1);
		expect(existsSync(body.path)).toBe(true);
		expect(existsSync(join(out, "files", "1", "source.pdf"))).toBe(true);
		expect(body.text).toContain("<z:path>files/1/source.pdf</z:path>");
	});
});

// ---------------------------------------------------------------- MODS

describe("MODS", () => {
	test("imports a modsCollection", async () => {
		const db = freshDb();
		expect(detectFormat(MODS_SAMPLE)).toBe("mods");
		const r = await importInto(db, MODS_SAMPLE, { collectionName: "MODS" });
		expect(r.body).toMatchObject({ created: 2, errors: [], format: "mods" });
		const d = byTitle(db, "The spleen");
		expect(d).toMatchObject({
			itemType: "journalArticle",
			shortTitle: "Spleen",
			publicationTitle: "Textbook of Surgery",
			journalAbbreviation: "Textbook Surg",
			volume: "4",
			issue: "2",
			pages: "45–67",
			date: "2020-05",
			DOI: "10.5555/spleen.1",
			ISSN: "1234-5678",
			abstractNote: "About the spleen.",
			language: "en",
			url: "https://example.org/spleen",
			accessDate: "2024-02-01",
			publisher: "Elsevier",
			place: "London",
		});
		expect((d.creators ?? []).map((c) => `${c.creatorType}:${c.lastName}`)).toEqual(["author:Lee", "editor:Kim"]);
		expect((d.tags ?? []).map((t) => t.tag)).toEqual(["anatomy", "surgery"]);
		expect(childNotes(db, d.key)).toEqual(["<p>Remember this</p>"]);
		expect(byTitle(db, "Surgical Anatomy")).toMatchObject({ itemType: "book", ISBN: "9780198000001", publisher: "Oxford University Press", date: "2018" });
	});

	test("export and re-import round trips the fields", async () => {
		const db = freshDb();
		const item = mk(db, {
			itemType: "journalArticle",
			title: "The spleen",
			creators: [
				{ creatorType: "author", firstName: "Ann", lastName: "Lee" },
				{ creatorType: "editor", firstName: "Bo", lastName: "Kim" },
			],
			publicationTitle: "Textbook of Surgery",
			journalAbbreviation: "Textbook Surg",
			volume: "4",
			issue: "2",
			pages: "45–67",
			date: "2020-05",
			DOI: "10.5555/spleen.1",
			ISSN: "1234-5678",
			abstractNote: "About the spleen.",
			language: "en",
			url: "https://example.org/spleen",
			publisher: "Elsevier",
			place: "London",
			tags: [{ tag: "anatomy" }],
		});
		const res = await call(db, "POST", "/api/io/export", { keys: [item.data.key], format: "mods", includeNotes: true });
		const exported = (await res.json()) as { text: string; filename: string };
		expect(exported.filename).toBe("Exported Items.xml");
		expect(exported.text).toContain('<genre authority="local">journalArticle</genre>');
		expect(exported.text).toContain('<url usage="primary display"');
		const other = freshDb();
		const r = await importInto(other, exported.text);
		expect(r.body.errors).toEqual([]);
		const back = byTitle(other, "The spleen");
		expect(back).toMatchObject({
			itemType: "journalArticle",
			publicationTitle: "Textbook of Surgery",
			journalAbbreviation: "Textbook Surg",
			volume: "4",
			issue: "2",
			pages: "45–67",
			date: "2020-05",
			DOI: "10.5555/spleen.1",
			ISSN: "1234-5678",
			url: "https://example.org/spleen",
			publisher: "Elsevier",
			place: "London",
		});
		expect((back.creators ?? []).map((c) => c.creatorType)).toEqual(["author", "editor"]);
		expect((back.tags ?? []).map((t) => t.tag)).toEqual(["anatomy"]);
	});

	test("a bare mods element is detected too", async () => {
		const db = freshDb();
		const r = await importInto(db, MODS_SAMPLE.replace(/<\/?modsCollection[^>]*>/g, "").replace('<?xml version="1.0" encoding="UTF-8"?>', ""), { collectionName: null });
		expect(r.body).toMatchObject({ created: 2, format: "mods" });
	});

	test("export leaves out empty part details", async () => {
		const db = freshDb();
		const item = mk(db, { itemType: "book", title: "No volume", date: "2000" });
		const res = await call(db, "POST", "/api/io/export", { keys: [item.data.key], format: "mods" });
		const text = ((await res.json()) as { text: string }).text;
		expect(text).not.toContain("<detail");
		expect(text).not.toContain("<part>");
		expect(text).toContain("<copyrightDate>2000</copyrightDate>");
	});
});

// ---------------------------------------------------------------- Mendeley

interface MendeleyFixture {
	path: string;
	dir: string;
}

/** A tiny Mendeley Desktop library with the tables Zotero's importer reads. */
function mendeleyFixture(): MendeleyFixture {
	const dir = tempDir();
	const path = join(dir, "11111111-2222-3333-4444-555555555555@www.mendeley.com.sqlite");
	const pdf = join(dir, "Downloaded", "paper.pdf");
	mkdirSync(join(dir, "Downloaded"), { recursive: true });
	writeFileSync(pdf, "%PDF-1.4 mendeley");
	const m = new Sqlite(path, { create: true });
	m.exec(`
		CREATE TABLE Documents (
			id INTEGER PRIMARY KEY, uuid TEXT, type TEXT, title TEXT, abstract TEXT,
			year TEXT, month TEXT, day TEXT, publication TEXT, volume TEXT, issue TEXT, pages TEXT,
			doi TEXT, isbn TEXT, issn TEXT, publisher TEXT, city TEXT, country TEXT, note TEXT,
			added TEXT, modified TEXT, inTrash TEXT, favourite TEXT, citationKey TEXT, pmid TEXT
		);
		CREATE TABLE DocumentContributors (documentId INTEGER, contribution TEXT, firstNames TEXT, lastName TEXT);
		CREATE TABLE DocumentTags (documentId INTEGER, tag TEXT);
		CREATE TABLE DocumentKeywords (documentId INTEGER, keyword TEXT);
		CREATE TABLE DocumentFolders (documentId INTEGER, folderId INTEGER);
		CREATE TABLE Folders (id INTEGER PRIMARY KEY, name TEXT, parentId INTEGER, groupId INTEGER);
		CREATE TABLE DocumentFiles (documentId INTEGER, hash TEXT);
		CREATE TABLE Files (hash TEXT, localUrl TEXT);
		CREATE TABLE DocumentUrls (documentId INTEGER, url BLOB, position INTEGER);
	`);
	m.query("INSERT INTO Documents VALUES (1, '{AAAAAAAA-1111-2222-3333-444444444444}', 'JournalArticle', 'Mendeley paper', 'An abstract', '2019', '3', '7', 'The Lancet', '12', '4', '77-88', '10.1000/men.1', NULL, '0140-6736', 'Elsevier', 'London', 'UK', '<p>Mendeley <m:italic>note</m:italic></p>', '1560000000', '1560000000', 'false', 'true', 'men2019paper', '31452104')").run();
	m.query("INSERT INTO Documents VALUES (2, '{BBBBBBBB-1111-2222-3333-444444444444}', 'Book', 'A Mendeley book', '', '2001', '', '', '', '', '', '', '', '9780198000000', NULL, 'OUP', '', '', '', '1560000000', '1560000000', 'false', 'false', '', '')").run();
	m.query("INSERT INTO Documents VALUES (3, '{CCCCCCCC-1111-2222-3333-444444444444}', 'JournalArticle', 'Deleted paper', '', '2001', '', '', '', '', '', '', '', NULL, NULL, '', '', '', '', '1560000000', '1560000000', 'true', 'false', '', '')").run();
	m.query("INSERT INTO DocumentContributors VALUES (1, 'DocumentAuthor', 'Jane', 'Smith'), (1, 'DocumentEditor', '', 'Patel'), (2, 'DocumentAuthor', 'Cara', 'Brown')").run();
	m.query("INSERT INTO DocumentTags VALUES (1, 'manual tag')").run();
	m.query("INSERT INTO DocumentKeywords VALUES (1, 'auto tag')").run();
	m.query("INSERT INTO Folders VALUES (10, 'Parent', -1, 0), (11, 'Child', 10, 0)").run();
	m.query("INSERT INTO DocumentFolders VALUES (1, 11)").run();
	m.query("INSERT INTO Files VALUES ('hash1', ?)").run(`file:///${pdf.replace(/\\/g, "/")}`);
	m.query("INSERT INTO DocumentFiles VALUES (1, 'hash1')").run();
	m.query("INSERT INTO DocumentUrls VALUES (1, ?, 0), (1, 'https://example.org/paper.pdf', 1)").run("https://example.org/paper");
	m.close();
	return { path, dir };
}

describe("Mendeley Desktop", () => {
	test("a valid library is discovered and read", async () => {
		const { path } = mendeleyFixture();
		expect(existsSync(path)).toBe(true);
		const db = freshDb();
		const res = await call(db, "POST", "/api/io/mendeley", { path });
		const body = (await res.json()) as Record<string, any>;
		expect(res.status).toBe(200);
		expect(body).toMatchObject({ format: "mendeley", created: 2, skipped: 0, errors: [], collections: 2, attachments: 2 });

		const paper = byTitle(db, "Mendeley paper");
		expect(paper).toMatchObject({
			itemType: "journalArticle",
			publicationTitle: "The Lancet",
			volume: "12",
			issue: "4",
			pages: "77-88",
			date: "2019-03-07",
			DOI: "10.1000/men.1",
			ISSN: "0140-6736",
			publisher: "Elsevier",
			place: "London, UK",
			abstractNote: "An abstract",
			url: "https://example.org/paper",
		});
		expect((paper.creators ?? []).map((c) => `${c.creatorType}:${c.lastName ?? c.name}`)).toEqual(["author:Smith", "editor:Patel"]);
		expect((paper.tags ?? []).map((t) => `${t.tag}|${t.type ?? 0}`).sort()).toEqual(["auto tag|1", "manual tag|0", "★|0"]);
		expect((paper.extra ?? "")).toContain("PMID: 31452104");
		expect((paper.extra ?? "")).toContain("Citation Key: men2019paper");
		expect((paper.relations ?? {})["mendeleyDB:documentUUID"]).toBe("AAAAAAAA-1111-2222-3333-444444444444");
		expect(childNotes(db, paper.key)).toEqual(["<p>Mendeley <i>note</i></p>"]);

		const attachments = db
			.query("SELECT a.link_mode, a.path, a.content_type FROM items i JOIN attachments a ON a.item_key = i.key WHERE i.parent_key = ?")
			.all(paper.key) as { link_mode: string; path: string | null; content_type: string | null }[];
		expect(attachments.map((a) => a.link_mode).sort()).toEqual(["imported_file", "linked_url"]);
		expect(existsSync(attachments.find((a) => a.link_mode === "imported_file")!.path!)).toBe(true);

		const book = byTitle(db, "A Mendeley book");
		expect(book).toMatchObject({ itemType: "book", ISBN: "9780198000000", publisher: "OUP", date: "2001" });

		// trashed documents are left behind; folders become a nested collection tree under the import collection
		expect(db.query("SELECT count(*) AS n FROM items WHERE title = 'Deleted paper'").get()).toEqual({ n: 0 });
		const folders = db.query("SELECT name, parent_key FROM collections ORDER BY name").all() as { name: string; parent_key: string | null }[];
		expect(folders.map((f) => f.name)).toEqual(["Child", `Imported ${new Date().toISOString().slice(0, 10)}`, "Parent"]);
		expect(folders.find((f) => f.name === "Parent")!.parent_key).toMatch(/^[A-Z0-9]{8}$/);
		expect(folders.find((f) => f.name === "Child")!.parent_key).not.toBeNull();
		expect(body.collectionKey).toBe(folders.find((f) => f.name === "Parent")!.parent_key);
	});

	test("importing the same library twice skips what is already there", async () => {
		const { path } = mendeleyFixture();
		const db = freshDb();
		await call(db, "POST", "/api/io/mendeley", { path });
		const res = await call(db, "POST", "/api/io/mendeley", { path });
		const body = (await res.json()) as { created: number; skipped: number };
		expect(body).toMatchObject({ created: 0, skipped: 2 });
		expect(db.query("SELECT count(*) AS n FROM items WHERE item_type = 'journalArticle'").get()).toEqual({ n: 1 });
	});

	test("files can be linked instead of copied", async () => {
		const { path } = mendeleyFixture();
		const db = freshDb();
		const res = await call(db, "POST", "/api/io/mendeley", { path, linkFiles: true });
		expect(res.status).toBe(200);
		const linked = db.query("SELECT a.path FROM attachments a WHERE a.link_mode = 'linked_file'").all() as { path: string }[];
		expect(linked.length).toBe(1);
		expect(linked[0]!.path).toContain("paper.pdf");
	});

	test("a file that is not a Mendeley library is refused", async () => {
		const dir = tempDir();
		const path = join(dir, "other.sqlite");
		const other = new Sqlite(path, { create: true });
		other.exec("CREATE TABLE something (x INTEGER)");
		other.close();
		const db = freshDb();
		const res = await call(db, "POST", "/api/io/mendeley", { path });
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("Mendeley");
	});

	test("a missing file is a 404", async () => {
		const db = freshDb();
		const res = await call(db, "POST", "/api/io/mendeley", { path: join(tempDir(), "nope.sqlite") });
		expect(res.status).toBe(404);
	});

	test("discovery answers even with no Mendeley installed", async () => {
		const db = freshDb();
		const res = await call(db, "GET", "/api/io/mendeley");
		const body = (await res.json()) as { databases: unknown[]; available: boolean };
		expect(res.status).toBe(200);
		expect(Array.isArray(body.databases)).toBe(true);
		expect(body.available).toBe(body.databases.length > 0);
	});
});
