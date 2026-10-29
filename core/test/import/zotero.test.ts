import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creatorsSummary, dateForApi, importZotero, parseYear } from "../../src/import/zotero";

const schemaPath = join(import.meta.dir, "..", "..", "schema.sql");
let root: string;
let zdir: string;
let base: string;
let target: string;

function buildFixture() {
	zdir = join(root, "Zotero");
	base = join(root, "linked");
	mkdirSync(join(zdir, "storage", "ATT00001"), { recursive: true });
	mkdirSync(join(zdir, "storage", "ATT00002"), { recursive: true });
	mkdirSync(base, { recursive: true });
	writeFileSync(join(zdir, "storage", "ATT00001", "paper.pdf"), "%PDF");
	writeFileSync(join(zdir, "storage", "ATT00001", ".zotero-ft-cache"), "hello full text");
	writeFileSync(join(base, "linked.pdf"), "%PDF");

	const db = new Database(join(zdir, "zotero.sqlite"), { create: true });
	db.exec(`
	CREATE TABLE libraries (libraryID INTEGER PRIMARY KEY, type TEXT);
	CREATE TABLE feeds (libraryID INTEGER PRIMARY KEY);
	CREATE TABLE itemTypesCombined (itemTypeID INT PRIMARY KEY, typeName TEXT);
	CREATE TABLE fieldsCombined (fieldID INT PRIMARY KEY, fieldName TEXT);
	CREATE TABLE creatorTypes (creatorTypeID INTEGER PRIMARY KEY, creatorType TEXT);
	CREATE TABLE charsets (charsetID INTEGER PRIMARY KEY, charset TEXT);
	CREATE TABLE items (itemID INTEGER PRIMARY KEY, itemTypeID INT, dateAdded TEXT, dateModified TEXT, libraryID INT, key TEXT, version INT);
	CREATE TABLE itemDataValues (valueID INTEGER PRIMARY KEY, value UNIQUE);
	CREATE TABLE itemData (itemID INT, fieldID INT, valueID INT);
	CREATE TABLE creators (creatorID INTEGER PRIMARY KEY, firstName TEXT, lastName TEXT, fieldMode INT);
	CREATE TABLE itemCreators (itemID INT, creatorID INT, creatorTypeID INT, orderIndex INT);
	CREATE TABLE tags (tagID INTEGER PRIMARY KEY, name TEXT);
	CREATE TABLE itemTags (itemID INT, tagID INT, type INT);
	CREATE TABLE collections (collectionID INTEGER PRIMARY KEY, collectionName TEXT, parentCollectionID INT, libraryID INT, key TEXT, version INT);
	CREATE TABLE collectionItems (collectionID INT, itemID INT);
	CREATE TABLE relationPredicates (predicateID INTEGER PRIMARY KEY, predicate TEXT);
	CREATE TABLE itemRelations (itemID INT, predicateID INT, object TEXT);
	CREATE TABLE itemNotes (itemID INTEGER PRIMARY KEY, parentItemID INT, note TEXT, title TEXT);
	CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INT, linkMode INT, contentType TEXT, charsetID INT, path TEXT, storageModTime INT, storageHash TEXT);
	CREATE TABLE itemAnnotations (itemID INTEGER PRIMARY KEY, parentItemID INT, type INT, authorName TEXT, text TEXT, comment TEXT, color TEXT, pageLabel TEXT, sortIndex TEXT, position TEXT);
	CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY);

	INSERT INTO libraries VALUES (1,'user'),(2,'group');
	INSERT INTO itemTypesCombined VALUES (1,'annotation'),(3,'attachment'),(22,'journalArticle'),(28,'note'),(8,'bookSection');
	INSERT INTO fieldsCombined VALUES (1,'title'),(2,'date'),(3,'publicationTitle'),(4,'url'),(5,'bookTitle');
	INSERT INTO creatorTypes VALUES (1,'author'),(2,'editor');
	INSERT INTO charsets VALUES (1,'utf-8');
	INSERT INTO items VALUES
	 (1,22,'2020-01-02 03:04:05','2021-01-02 03:04:05',1,'ITEM0001',100),
	 (2,3,'2020-01-02 03:04:06','2020-01-02 03:04:06',1,'ATT00001',101),
	 (3,3,'2020-01-02 03:04:07','2020-01-02 03:04:07',1,'ATT00002',102),
	 (4,28,'2020-01-02 03:04:08','2020-01-02 03:04:08',1,'NOTE0001',103),
	 (5,1,'2020-01-02 03:04:09','2020-01-02 03:04:09',1,'ANNOT001',104),
	 (6,8,'2020-02-02 03:04:09','2020-02-02 03:04:09',1,'ITEM0002',105),
	 (7,3,'2020-02-02 03:04:09','2020-02-02 03:04:09',1,'LINK0001',106),
	 (8,22,'2020-03-02 03:04:09','2020-03-02 03:04:09',2,'GROUP001',107);
	INSERT INTO itemDataValues VALUES (1,'Deep learning in surgery'),(2,'2019-05-00 May 2019'),(3,'J Surg'),(4,'https://example.org/x'),(5,'Some Book'),(6,'A chapter'),(7,'paper');
	INSERT INTO itemData VALUES (1,1,1),(1,2,2),(1,3,3),(1,4,4),(6,1,6),(6,5,5),(2,1,7);
	INSERT INTO creators VALUES (1,'Ada','Smith',0),(2,'Bo','Jones',0),(3,NULL,'WHO',1),(4,'Ed','Editor',0);
	INSERT INTO itemCreators VALUES (1,1,1,0),(1,2,1,1),(1,4,2,2),(6,3,1,0),(6,1,1,1),(6,2,1,2);
	INSERT INTO tags VALUES (1,'ml'),(2,'auto'),(3,'hl');
	INSERT INTO itemTags VALUES (1,1,0),(1,2,1),(5,3,0);
	INSERT INTO collections VALUES (1,'Parent',NULL,1,'COLL0001',5),(2,'Child',1,1,'COLL0002',6);
	INSERT INTO collectionItems VALUES (2,1),(1,1);
	INSERT INTO relationPredicates VALUES (1,'dc:relation');
	INSERT INTO itemRelations VALUES (1,1,'http://zotero.org/users/1/items/AAAAAAAA'),(1,1,'http://zotero.org/users/1/items/BBBBBBBB');
	INSERT INTO itemNotes VALUES (4,1,'<div>My note</div>','My note');
	INSERT INTO itemAttachments VALUES
	 (2,1,0,'application/pdf',1,'storage:paper.pdf',1700000000000,'abc123'),
	 (3,1,1,'text/html',NULL,'storage:gone.html',NULL,NULL),
	 (7,1,2,'application/pdf',NULL,'attachments:linked.pdf',NULL,NULL);
	INSERT INTO itemAnnotations VALUES (5,2,1,NULL,'highlighted','my comment','#ffd400','3','00000|000001|00002','{"pageIndex":2,"rects":[[1,2,3,4]]}');
	INSERT INTO deletedItems VALUES (6);
	`);
	db.close();
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "zimp-test-"));
	buildFixture();
	target = join(root, "out", "library.sqlite");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("helpers", () => {
	test("date parsing", () => {
		expect(dateForApi("2019-05-00 May 2019")).toBe("May 2019");
		expect(parseYear("2019-05-00 May 2019")).toBe(2019);
		expect(parseYear("0000-00-00 circa 1850")).toBe(1850);
		expect(parseYear(undefined)).toBeNull();
	});
	test("creators summary", () => {
		const a = (n: string) => ({ creatorType: "author", lastName: n });
		expect(creatorsSummary([a("Smith")])).toBe("Smith");
		expect(creatorsSummary([a("Smith"), a("Jones")])).toBe("Smith and Jones");
		expect(creatorsSummary([a("A"), a("B"), a("C")])).toBe("A et al.");
		expect(creatorsSummary([{ creatorType: "editor", lastName: "Ed" }])).toBe("Ed");
		expect(creatorsSummary([])).toBe("");
	});
});

describe("importZotero", () => {
	let report: Awaited<ReturnType<typeof importZotero>>;
	let db: Database;

	beforeAll(async () => {
		report = await importZotero({
			zoteroDir: zdir,
			targetDbPath: target,
			schemaPath,
			baseAttachmentPath: base,
			searchRoots: [base], // never crawl the real home dir from tests
		});
		db = new Database(target, { readonly: true });
	});

	const item = (key: string) => {
		const row = db.query("SELECT * FROM items WHERE key = ?").get(key) as any;
		return { row, data: JSON.parse(row.data) };
	};

	test("report counts", () => {
		expect(report.counts.items).toBe(6); // annotation and group items excluded
		expect(report.counts.collections).toBe(2);
		expect(report.counts.annotations).toBe(1);
		expect(report.counts.fulltext).toBe(1);
		expect(report.counts.trashed).toBe(1);
		expect(report.missingFiles.total).toBe(1);
		expect(report.groupLibraries).toEqual([{ libraryID: 2, items: 1 }]);
	});

	test("journal article data JSON and columns", () => {
		const { row, data } = item("ITEM0001");
		expect(data).toMatchObject({
			key: "ITEM0001",
			version: 100,
			itemType: "journalArticle",
			title: "Deep learning in surgery",
			date: "May 2019",
			publicationTitle: "J Surg",
			url: "https://example.org/x",
			creators: [
				{ creatorType: "author", firstName: "Ada", lastName: "Smith" },
				{ creatorType: "author", firstName: "Bo", lastName: "Jones" },
				{ creatorType: "editor", firstName: "Ed", lastName: "Editor" },
			],
			tags: [{ tag: "auto", type: 1 }, { tag: "ml" }],
			collections: ["COLL0001", "COLL0002"],
			dateAdded: "2020-01-02T03:04:05Z",
			dateModified: "2021-01-02T03:04:05Z",
		});
		expect(data.relations["dc:relation"]).toHaveLength(2);
		expect(row.creators_summary).toBe("Smith and Jones");
		expect(row.year).toBe(2019);
		expect(row.publication).toBe("J Surg");
		expect(row.deleted).toBe(0);
		expect(row.version).toBe(100);
	});

	test("single-field creator, bookSection publication, trash flag", () => {
		const { row, data } = item("ITEM0002");
		expect(data.creators[0]).toEqual({ creatorType: "author", name: "WHO" });
		expect(row.publication).toBe("Some Book");
		expect(row.creators_summary).toBe("WHO et al.");
		expect(row.deleted).toBe(1);
	});

	test("note", () => {
		const { row, data } = item("NOTE0001");
		expect(data.note).toBe("<div>My note</div>");
		expect(data.parentItem).toBe("ITEM0001");
		expect(row.parent_key).toBe("ITEM0001");
		expect(row.title).toBe("My note");
		expect(data.collections).toBeUndefined();
	});

	test("attachments and path resolution", () => {
		const a = (k: string) => db.query("SELECT * FROM attachments WHERE item_key = ?").get(k) as any;
		expect(a("ATT00001").link_mode).toBe("imported_file");
		expect(a("ATT00001").path).toBe(join(zdir, "storage", "ATT00001", "paper.pdf"));
		expect(a("ATT00002").path).toBeNull(); // file missing
		expect(a("ATT00002").link_mode).toBe("imported_url");
		expect(a("LINK0001").link_mode).toBe("linked_file");
		expect(a("LINK0001").path).toBe(join(base, "linked.pdf"));
		const d = item("ATT00001").data;
		expect(d).toMatchObject({
			itemType: "attachment",
			linkMode: "imported_file",
			contentType: "application/pdf",
			charset: "utf-8",
			filename: "paper.pdf",
			md5: "abc123",
			parentItem: "ITEM0001",
			title: "paper",
		});
	});

	test("annotation reader JSON", () => {
		const r = db.query("SELECT * FROM annotations").get() as any;
		expect(r.key).toBe("ANNOT001");
		expect(r.attachment_key).toBe("ATT00001");
		expect(JSON.parse(r.data)).toEqual({
			id: "ANNOT001",
			type: "highlight",
			color: "#ffd400",
			sortIndex: "00000|000001|00002",
			position: { pageIndex: 2, rects: [[1, 2, 3, 4]] },
			text: "highlighted",
			comment: "my comment",
			tags: [{ name: "hl" }],
			pageLabel: "3",
			dateModified: "2020-01-02T03:04:09Z",
		});
	});

	test("collections, links, tags, fulltext, meta", () => {
		expect(db.query("SELECT key, parent_key FROM collections ORDER BY key").all()).toEqual([
			{ key: "COLL0001", parent_key: null },
			{ key: "COLL0002", parent_key: "COLL0001" },
		]);
		expect((db.query("SELECT COUNT(*) c FROM collection_items").get() as any).c).toBe(2);
		expect(db.query("SELECT tag, type FROM item_tags ORDER BY tag").all()).toEqual([
			{ tag: "auto", type: 1 },
			{ tag: "ml", type: 0 },
		]);
		expect(db.query("SELECT * FROM fulltext").get()).toMatchObject({
			attachment_key: "ATT00001",
			content: "hello full text",
			source: "zotero-cache",
		});
		expect((db.query("SELECT value FROM meta WHERE name='zotero_import_at'").get() as any).value).toMatch(/^\d{4}-/);
		expect((db.query("SELECT COUNT(*) c FROM search").get() as any).c).toBe(0);
	});

	test("refuses to overwrite without replace, replaces with it", async () => {
		db.close(true);
		await expect(
			importZotero({ zoteroDir: zdir, targetDbPath: target, schemaPath, baseAttachmentPath: base, searchRoots: false }),
		).rejects.toThrow(/replace/);
		const again = await importZotero({
			zoteroDir: zdir,
			targetDbPath: target,
			schemaPath,
			baseAttachmentPath: base,
			searchRoots: [base],
			replace: true,
		});
		expect(again.counts.items).toBe(6);
	});
});
