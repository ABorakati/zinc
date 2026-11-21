// Standalone unit tests for changing itemType in ZoteroDbWriter (using a minimal temp Zotero SQLite DB
// populated from the vendored Zotero schema + consistency triggers — does not require a real Zotero DB).
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, patchItem } from "../../src/db";
import rawSchema from "../../src/schema-data/schema.json" with { type: "json" };
import { SyncService } from "../../src/sync/engine";
import type { ZoteroWrite } from "../../src/sync/protocol";
import { ZoteroDbReader, ZoteroDbWriter } from "../../src/zotero-db";
import { genKey, noRunning } from "./helpers";

interface RawItemType {
	itemType: string;
	fields: { field: string; baseField?: string }[];
	creatorTypes: { creatorType: string; primary?: boolean }[];
}

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function createMinimalZoteroDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "zn-zotero-itemtype-"));
	tempDirs.push(dir);
	mkdirSync(join(dir, "storage"), { recursive: true });
	const db = new Database(join(dir, "zotero.sqlite"), { create: true, readwrite: true });
	try {
		db.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE libraries (
				libraryID INTEGER PRIMARY KEY,
				type TEXT NOT NULL,
				editable INT DEFAULT 1,
				filesEditable INT DEFAULT 1,
				version INT DEFAULT 0,
				storageVersion INT DEFAULT 0,
				lastSync INT DEFAULT 0,
				archived INT DEFAULT 0,
				clientVersion INT DEFAULT 0
			);
			CREATE TABLE itemTypesCombined (
				itemTypeID INTEGER PRIMARY KEY,
				typeName TEXT NOT NULL UNIQUE,
				display INT DEFAULT 2,
				custom INT DEFAULT 0
			);
			CREATE TABLE fieldsCombined (
				fieldID INTEGER PRIMARY KEY,
				fieldName TEXT NOT NULL UNIQUE,
				label TEXT,
				custom INT DEFAULT 0
			);
			CREATE TABLE itemTypeFieldsCombined (
				itemTypeID INT NOT NULL,
				fieldID INT NOT NULL,
				hide INT DEFAULT 0,
				orderIndex INT DEFAULT 0,
				PRIMARY KEY (itemTypeID, fieldID)
			);
			CREATE TABLE baseFieldMappingsCombined (
				itemTypeID INT NOT NULL,
				baseFieldID INT NOT NULL,
				fieldID INT NOT NULL,
				PRIMARY KEY (itemTypeID, baseFieldID, fieldID)
			);
			CREATE TABLE creatorTypes (
				creatorTypeID INTEGER PRIMARY KEY,
				creatorType TEXT NOT NULL UNIQUE
			);
			CREATE TABLE itemTypeCreatorTypes (
				itemTypeID INT NOT NULL,
				creatorTypeID INT NOT NULL,
				primaryField INT DEFAULT 0,
				PRIMARY KEY (itemTypeID, creatorTypeID)
			);
			CREATE TABLE charsets (
				charsetID INTEGER PRIMARY KEY,
				charset TEXT NOT NULL UNIQUE
			);
			CREATE TABLE settings (
				setting TEXT NOT NULL,
				key TEXT NOT NULL,
				value,
				PRIMARY KEY (setting, key)
			);
			CREATE TABLE items (
				itemID INTEGER PRIMARY KEY AUTOINCREMENT,
				itemTypeID INT NOT NULL REFERENCES itemTypesCombined(itemTypeID),
				dateAdded TEXT NOT NULL,
				dateModified TEXT NOT NULL,
				clientDateModified TEXT NOT NULL,
				libraryID INT NOT NULL REFERENCES libraries(libraryID),
				key TEXT NOT NULL,
				version INT NOT NULL DEFAULT 0,
				synced INT NOT NULL DEFAULT 0,
				clientVersion INT NOT NULL DEFAULT 0,
				UNIQUE (libraryID, key)
			);
			CREATE TABLE deletedItems (
				itemID INTEGER PRIMARY KEY REFERENCES items(itemID) ON DELETE CASCADE,
				dateDeleted TEXT NOT NULL
			);
			CREATE TABLE itemDataValues (
				valueID INTEGER PRIMARY KEY AUTOINCREMENT,
				value UNIQUE,
				valueNormalized TEXT
			);
			CREATE TABLE itemData (
				itemID INT NOT NULL REFERENCES items(itemID) ON DELETE CASCADE,
				fieldID INT NOT NULL REFERENCES fieldsCombined(fieldID),
				valueID INT NOT NULL REFERENCES itemDataValues(valueID),
				PRIMARY KEY (itemID, fieldID)
			);
			CREATE TABLE creators (
				creatorID INTEGER PRIMARY KEY AUTOINCREMENT,
				firstName TEXT NOT NULL,
				lastName TEXT NOT NULL,
				fieldMode INT NOT NULL DEFAULT 0,
				firstNameNormalized TEXT,
				lastNameNormalized TEXT
			);
			CREATE TABLE itemCreators (
				itemID INT NOT NULL REFERENCES items(itemID) ON DELETE CASCADE,
				creatorID INT NOT NULL REFERENCES creators(creatorID) ON DELETE CASCADE,
				creatorTypeID INT NOT NULL DEFAULT 1 REFERENCES creatorTypes(creatorTypeID),
				orderIndex INT NOT NULL DEFAULT 0,
				PRIMARY KEY (itemID, creatorID, creatorTypeID, orderIndex),
				UNIQUE (itemID, orderIndex)
			);
			CREATE TABLE tags (
				tagID INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL UNIQUE,
				nameNormalized TEXT
			);
			CREATE TABLE itemTags (
				itemID INT NOT NULL REFERENCES items(itemID) ON DELETE CASCADE,
				tagID INT NOT NULL REFERENCES tags(tagID) ON DELETE CASCADE,
				type INT NOT NULL DEFAULT 0,
				PRIMARY KEY (itemID, tagID)
			);
			CREATE TABLE collections (
				collectionID INTEGER PRIMARY KEY AUTOINCREMENT,
				collectionName TEXT NOT NULL,
				parentCollectionID INT REFERENCES collections(collectionID),
				clientDateModified TEXT NOT NULL,
				libraryID INT NOT NULL REFERENCES libraries(libraryID),
				key TEXT NOT NULL,
				version INT NOT NULL DEFAULT 0,
				synced INT NOT NULL DEFAULT 0,
				clientVersion INT NOT NULL DEFAULT 0,
				UNIQUE (libraryID, key)
			);
			CREATE TABLE deletedCollections (
				collectionID INTEGER PRIMARY KEY REFERENCES collections(collectionID) ON DELETE CASCADE,
				dateDeleted TEXT NOT NULL
			);
			CREATE TABLE collectionItems (
				collectionID INT NOT NULL REFERENCES collections(collectionID) ON DELETE CASCADE,
				itemID INT NOT NULL REFERENCES items(itemID) ON DELETE CASCADE,
				orderIndex INT NOT NULL DEFAULT 0,
				PRIMARY KEY (collectionID, itemID)
			);
			CREATE TABLE relationPredicates (
				predicateID INTEGER PRIMARY KEY AUTOINCREMENT,
				predicate TEXT UNIQUE
			);
			CREATE TABLE itemRelations (
				itemID INT NOT NULL REFERENCES items(itemID) ON DELETE CASCADE,
				predicateID INT NOT NULL REFERENCES relationPredicates(predicateID),
				object TEXT NOT NULL,
				PRIMARY KEY (itemID, predicateID, object)
			);
			CREATE TABLE publicationsItems (
				itemID INTEGER PRIMARY KEY REFERENCES items(itemID) ON DELETE CASCADE
			);
			CREATE TABLE itemNotes (
				itemID INTEGER PRIMARY KEY REFERENCES items(itemID) ON DELETE CASCADE,
				parentItemID INT REFERENCES items(itemID) ON DELETE CASCADE,
				note TEXT,
				title TEXT
			);
			CREATE TABLE itemAttachments (
				itemID INTEGER PRIMARY KEY REFERENCES items(itemID) ON DELETE CASCADE,
				parentItemID INT REFERENCES items(itemID) ON DELETE CASCADE,
				linkMode INT,
				contentType TEXT,
				charsetID INT REFERENCES charsets(charsetID),
				path TEXT,
				syncState INT,
				storageModTime INT,
				storageHash TEXT,
				lastProcessedModificationTime INT,
				lastRead TEXT
			);
			CREATE TABLE itemAnnotations (
				itemID INTEGER PRIMARY KEY REFERENCES items(itemID) ON DELETE CASCADE,
				parentItemID INT NOT NULL REFERENCES items(itemID) ON DELETE CASCADE,
				type INT,
				authorName TEXT,
				text TEXT,
				textNormalized TEXT,
				comment TEXT,
				commentNormalized TEXT,
				color TEXT,
				pageLabel TEXT,
				sortIndex TEXT,
				position TEXT,
				isExternal INT
			);
			CREATE TABLE syncDeleteLog (
				syncObjectTypeID INT NOT NULL,
				libraryID INT NOT NULL,
				key TEXT NOT NULL,
				dateDeleted TEXT NOT NULL,
				PRIMARY KEY (syncObjectTypeID, libraryID, key)
			);

			-- Consistency triggers mirroring Zotero's invariants when changing itemTypeID / writing itemData / itemCreators.
			CREATE TRIGGER trg_itemData_valid_field BEFORE INSERT ON itemData
			WHEN NOT EXISTS (
				SELECT 1 FROM items i
				JOIN itemTypeFieldsCombined f ON f.itemTypeID = i.itemTypeID
				WHERE i.itemID = NEW.itemID AND f.fieldID = NEW.fieldID
			)
			BEGIN
				SELECT RAISE(ABORT, 'itemData fieldID is invalid for item itemTypeID');
			END;

			CREATE TRIGGER trg_itemCreators_valid_type BEFORE INSERT ON itemCreators
			WHEN NOT EXISTS (
				SELECT 1 FROM items i
				JOIN itemTypeCreatorTypes c ON c.itemTypeID = i.itemTypeID
				WHERE i.itemID = NEW.itemID AND c.creatorTypeID = NEW.creatorTypeID
			)
			BEGIN
				SELECT RAISE(ABORT, 'itemCreators creatorTypeID is invalid for item itemTypeID');
			END;

			CREATE TRIGGER trg_items_type_change_fields BEFORE UPDATE OF itemTypeID ON items
			WHEN EXISTS (
				SELECT 1 FROM itemData d
				WHERE d.itemID = NEW.itemID
				  AND d.fieldID NOT IN (SELECT fieldID FROM itemTypeFieldsCombined WHERE itemTypeID = NEW.itemTypeID)
			)
			BEGIN
				SELECT RAISE(ABORT, 'stale itemData fieldID invalid for new itemTypeID');
			END;

			CREATE TRIGGER trg_items_type_change_creators BEFORE UPDATE OF itemTypeID ON items
			WHEN EXISTS (
				SELECT 1 FROM itemCreators c
				WHERE c.itemID = NEW.itemID
				  AND c.creatorTypeID NOT IN (SELECT creatorTypeID FROM itemTypeCreatorTypes WHERE itemTypeID = NEW.itemTypeID)
			)
			BEGIN
				SELECT RAISE(ABORT, 'stale itemCreators creatorTypeID invalid for new itemTypeID');
			END;
		`);

		db.transaction(() => {
			db.run("INSERT INTO libraries (libraryID, type, clientVersion) VALUES (1, 'user', 100)");
			db.run("INSERT INTO charsets (charsetID, charset) VALUES (1, 'utf-8')");
			db.run("INSERT INTO settings (setting, key, value) VALUES ('account', 'userID', '12345')");

			const typeIds = new Map<string, number>();
			const fieldIds = new Map<string, number>();
			const creatorTypeIds = new Map<string, number>();

			const ensureField = (name: string): number => {
				let id = fieldIds.get(name);
				if (id === undefined) {
					id = fieldIds.size + 1;
					fieldIds.set(name, id);
					db.run("INSERT INTO fieldsCombined (fieldID, fieldName) VALUES (?, ?)", [id, name]);
				}
				return id;
			};
			const ensureCreatorType = (name: string): number => {
				let id = creatorTypeIds.get(name);
				if (id === undefined) {
					id = creatorTypeIds.size + 1;
					creatorTypeIds.set(name, id);
					db.run("INSERT INTO creatorTypes (creatorTypeID, creatorType) VALUES (?, ?)", [id, name]);
				}
				return id;
			};

			// Keep 'author' at creatorTypeID = 1, matching real Zotero.
			ensureCreatorType("author");

			const rawTypes = rawSchema.itemTypes as RawItemType[];
			for (const t of rawTypes) {
				const tid = typeIds.size + 1;
				typeIds.set(t.itemType, tid);
				db.run("INSERT INTO itemTypesCombined (itemTypeID, typeName) VALUES (?, ?)", [tid, t.itemType]);
				t.fields.forEach((f, idx) => {
					const fid = ensureField(f.field);
					db.run("INSERT INTO itemTypeFieldsCombined (itemTypeID, fieldID, orderIndex) VALUES (?, ?, ?)", [tid, fid, idx]);
					if (f.baseField) {
						const bfid = ensureField(f.baseField);
						db.run("INSERT INTO baseFieldMappingsCombined (itemTypeID, baseFieldID, fieldID) VALUES (?, ?, ?)", [
							tid,
							bfid,
							fid,
						]);
					}
				});
				for (const c of t.creatorTypes) {
					const ctid = ensureCreatorType(c.creatorType);
					db.run("INSERT INTO itemTypeCreatorTypes (itemTypeID, creatorTypeID, primaryField) VALUES (?, ?, ?)", [
						tid,
						ctid,
						c.primary ? 1 : 0,
					]);
				}
			}
		})();
	} finally {
		db.close(true);
	}
	return dir;
}

function makeHarness() {
	const dataDir = createMinimalZoteroDir();
	const writer = new ZoteroDbWriter({ dataDir, isRunning: noRunning, keepBackups: 2, baseAttachmentPath: null });
	const reader = new ZoteroDbReader({ dataDir, isRunning: noRunning, baseAttachmentPath: null });
	const q = <T = Record<string, any>>(sql: string, ...p: unknown[]): T[] => {
		const db = new Database(join(dataDir, "zotero.sqlite"), { readonly: true });
		try {
			return db.query(sql).all(...(p as never[])) as T[];
		} finally {
			db.close(true);
		}
	};
	const exec = (sql: string, ...p: unknown[]) => {
		const db = new Database(join(dataDir, "zotero.sqlite"), { readwrite: true });
		try {
			db.query(sql).run(...(p as never[]));
		} finally {
			db.close(true);
		}
	};
	const apply = (...writes: ZoteroWrite[]) => writer.apply(writes);
	const itemFields = (key: string): Record<string, string> =>
		Object.fromEntries(
			q<{ fieldName: string; value: string }>(
				`SELECT f.fieldName, v.value
				 FROM items i
				 JOIN itemData d ON d.itemID = i.itemID
				 JOIN fieldsCombined f ON f.fieldID = d.fieldID
				 JOIN itemDataValues v ON v.valueID = d.valueID
				 WHERE i.key = ?`,
				key,
			).map((r) => [r.fieldName, r.value]),
		);
	const itemCreators = (key: string) =>
		q<{ creatorType: string; firstName: string; lastName: string; fieldMode: number }>(
			`SELECT ct.creatorType, c.firstName, c.lastName, c.fieldMode
			 FROM items i
			 JOIN itemCreators ic ON ic.itemID = i.itemID
			 JOIN creators c ON c.creatorID = ic.creatorID
			 JOIN creatorTypes ct ON ct.creatorTypeID = ic.creatorTypeID
			 WHERE i.key = ?
			 ORDER BY ic.orderIndex`,
			key,
		);
	const itemMeta = (key: string) =>
		q<{
			itemID: number;
			typeName: string;
			version: number;
			synced: number;
			clientVersion: number;
			dateModified: string;
			clientDateModified: string;
		}>(
			`SELECT i.itemID, t.typeName, i.version, i.synced, i.clientVersion, i.dateModified, i.clientDateModified
			 FROM items i
			 JOIN itemTypesCombined t ON t.itemTypeID = i.itemTypeID
			 WHERE i.key = ?`,
			key,
		)[0];
	return { dataDir, writer, reader, q, exec, apply, itemFields, itemCreators, itemMeta };
}

describe("zotero-db writer itemType changes", () => {
	test("blogPost -> webpage remaps blogTitle -> websiteTitle, cleans stale fields, and preserves version", async () => {
		const h = makeHarness();
		const key = "PUX4PUM5";

		await h.apply({
			type: "item",
			op: "upsert",
			key,
			data: {
				itemType: "blogPost",
				title: "Understanding SQLite Triggers",
				blogTitle: "Systems Engineering Blog",
				websiteType: "Technical Blog",
				ISSN: "1234-5678",
				date: "2026-01-15",
				url: "https://example.org/sqlite-triggers",
				creators: [
					{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
					{ creatorType: "commenter", firstName: "Grace", lastName: "Hopper" },
				],
				tags: [{ tag: "sqlite" }],
			},
		});
		// Simulate an item previously synced with Zotero server
		h.exec("UPDATE items SET version = 7, synced = 1, dateModified = '2026-01-15 10:00:00' WHERE key = ?", key);
		const beforeMeta = h.itemMeta(key);
		expect(beforeMeta).toMatchObject({ typeName: "blogPost", version: 7, synced: 1 });
		expect(h.itemFields(key)).toMatchObject({
			title: "Understanding SQLite Triggers",
			blogTitle: "Systems Engineering Blog",
			websiteType: "Technical Blog",
			ISSN: "1234-5678",
		});

		// Change itemType from blogPost -> webpage with blogTitle still in payload (and ISSN dropped)
		const { results } = await h.apply({
			type: "item",
			op: "upsert",
			key,
			data: {
				itemType: "webpage",
				title: "Understanding SQLite Triggers",
				blogTitle: "Systems Engineering Blog",
				websiteType: "Technical Blog",
				date: "2026-01-15",
				url: "https://example.org/sqlite-triggers",
				creators: [
					{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
					{ creatorType: "commenter", firstName: "Grace", lastName: "Hopper" },
				],
				tags: [{ tag: "sqlite" }],
			},
		});

		expect(results[0]).toMatchObject({ key, ok: true, changed: true });
		const afterMeta = h.itemMeta(key);
		expect(afterMeta.typeName).toBe("webpage");
		expect(afterMeta.version).toBe(7); // untouched
		expect(afterMeta.synced).toBe(0);
		expect(afterMeta.clientVersion).toBeGreaterThan(beforeMeta.clientVersion);

		const fields = h.itemFields(key);
		expect(fields.websiteTitle).toBe("Systems Engineering Blog");
		expect(fields.websiteType).toBe("Technical Blog");
		expect(fields.blogTitle).toBeUndefined();
		expect(fields.ISSN).toBeUndefined();
		expect(fields.extra).toBeUndefined();

		// commenter is invalid on webpage -> remapped to primary creatorType (author)
		expect(h.itemCreators(key)).toEqual([
			{ creatorType: "author", firstName: "Ada", lastName: "Lovelace", fieldMode: 0 },
			{ creatorType: "author", firstName: "Grace", lastName: "Hopper", fieldMode: 0 },
		]);

		// Reader round-trip
		const pulled = (await h.reader.changesSince(null)).upserts.find((u) => u.key === key);
		expect(pulled?.data).toMatchObject({
			itemType: "webpage",
			title: "Understanding SQLite Triggers",
			websiteTitle: "Systems Engineering Blog",
			websiteType: "Technical Blog",
			date: "2026-01-15",
			url: "https://example.org/sqlite-triggers",
		});
		expect(pulled?.data.blogTitle).toBeUndefined();
		expect(pulled?.data.ISSN).toBeUndefined();

		// Re-applying identical webpage payload is a no-op
		const cvBefore = h.itemMeta(key).clientVersion;
		const noop = await h.apply({
			type: "item",
			op: "upsert",
			key,
			data: {
				itemType: "webpage",
				title: "Understanding SQLite Triggers",
				websiteTitle: "Systems Engineering Blog",
				websiteType: "Technical Blog",
				date: "2026-01-15",
				url: "https://example.org/sqlite-triggers",
				creators: [
					{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
					{ creatorType: "author", firstName: "Grace", lastName: "Hopper" },
				],
				tags: [{ tag: "sqlite" }],
			},
		});
		expect(noop.results[0]).toMatchObject({ ok: true, changed: false });
		expect(h.itemMeta(key).clientVersion).toBe(cvBefore);
	});

	test("blogPost -> webpage prefers direct websiteTitle over blogTitle regardless of key order", async () => {
		const h = makeHarness();
		const kDirect = genKey();
		const kBlogFirst = genKey();
		const kSiteFirst = genKey();

		for (const key of [kDirect, kBlogFirst, kSiteFirst]) {
			await h.apply({
				type: "item",
				op: "upsert",
				key,
				data: { itemType: "blogPost", title: "Post", blogTitle: "Original Blog" },
			});
		}

		// 1. Data already has websiteTitle only (e.g. converted by Zinc patchItem)
		const r1 = await h.apply({
			type: "item",
			op: "upsert",
			key: kDirect,
			data: { itemType: "webpage", title: "Post", websiteTitle: "Converted Site" },
		});
		expect(r1.results[0]).toMatchObject({ ok: true, changed: true });
		expect(h.itemFields(kDirect)).toEqual({ title: "Post", websiteTitle: "Converted Site" });

		// 2. Both blogTitle and websiteTitle appear (blogTitle first)
		const r2 = await h.apply({
			type: "item",
			op: "upsert",
			key: kBlogFirst,
			data: { itemType: "webpage", title: "Post", blogTitle: "Stale Blog", websiteTitle: "Explicit Site" },
		});
		expect(r2.results[0]).toMatchObject({ ok: true, changed: true });
		expect(h.itemFields(kBlogFirst)).toEqual({ title: "Post", websiteTitle: "Explicit Site" });

		// 3. Both websiteTitle and blogTitle appear (websiteTitle first)
		const r3 = await h.apply({
			type: "item",
			op: "upsert",
			key: kSiteFirst,
			data: { itemType: "webpage", title: "Post", websiteTitle: "Explicit Site", blogTitle: "Stale Blog" },
		});
		expect(r3.results[0]).toMatchObject({ ok: true, changed: true });
		expect(h.itemFields(kSiteFirst)).toEqual({ title: "Post", websiteTitle: "Explicit Site" });
	});

	test("journalArticle -> book moves unmapped fields to extra and remaps invalid creatorType to primary", async () => {
		const h = makeHarness();
		const key = genKey();

		await h.apply({
			type: "item",
			op: "upsert",
			key,
			data: {
				itemType: "journalArticle",
				title: "Deep Thoughts",
				publicationTitle: "Journal of Thought",
				journalAbbreviation: "J. Thought",
				issue: "4",
				volume: "12",
				DOI: "10.1234/thought.1",
				extra: "PMID: 98765",
				creators: [
					{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
					{ creatorType: "reviewedAuthor", firstName: "Alan", lastName: "Turing" },
					{ creatorType: "editor", firstName: "Grace", lastName: "Hopper" },
				],
			},
		});

		const { results } = await h.apply({
			type: "item",
			op: "upsert",
			key,
			data: {
				itemType: "book",
				title: "Deep Thoughts",
				publicationTitle: "Journal of Thought",
				journalAbbreviation: "J. Thought",
				issue: "4",
				volume: "12",
				DOI: "10.1234/thought.1",
				extra: "PMID: 98765",
				creators: [
					{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
					{ creatorType: "reviewedAuthor", firstName: "Alan", lastName: "Turing" },
					{ creatorType: "editor", firstName: "Grace", lastName: "Hopper" },
				],
			},
		});

		expect(results[0]).toMatchObject({ ok: true, changed: true });
		expect(h.itemMeta(key).typeName).toBe("book");

		const fields = h.itemFields(key);
		expect(fields.title).toBe("Deep Thoughts");
		expect(fields.volume).toBe("12");
		expect(fields.DOI).toBe("10.1234/thought.1");
		expect(fields.publicationTitle).toBeUndefined();
		expect(fields.journalAbbreviation).toBeUndefined();
		expect(fields.issue).toBeUndefined();
		expect(fields.extra).toBe("PMID: 98765\npublicationTitle: Journal of Thought\njournalAbbreviation: J. Thought\nissue: 4");

		// reviewedAuthor is not valid on book -> remapped to author; editor stays editor
		expect(h.itemCreators(key)).toEqual([
			{ creatorType: "author", firstName: "Ada", lastName: "Lovelace", fieldMode: 0 },
			{ creatorType: "author", firstName: "Alan", lastName: "Turing", fieldMode: 0 },
			{ creatorType: "editor", firstName: "Grace", lastName: "Hopper", fieldMode: 0 },
		]);

		// Removing a creator whose old creatorType is invalid on the new type purges the orphan creator
		const kOrphan = genKey();
		await h.apply({
			type: "item",
			op: "upsert",
			key: kOrphan,
			data: {
				itemType: "journalArticle",
				title: "Orphan Creator Test",
				creators: [{ creatorType: "reviewedAuthor", firstName: "Unique", lastName: "Reviewer" }],
			},
		});
		const rOrphan = await h.apply({
			type: "item",
			op: "upsert",
			key: kOrphan,
			data: { itemType: "book", title: "Orphan Creator Test", creators: [] },
		});
		expect(rOrphan.results[0]).toMatchObject({ ok: true, changed: true });
		expect(h.itemCreators(kOrphan)).toEqual([]);
		expect(h.q("SELECT 1 FROM creators WHERE lastName = 'Reviewer'")).toEqual([]);
	});

	test("journalArticle <-> preprint remaps publisher <-> repository via baseField", async () => {
		const h = makeHarness();
		const key = genKey();

		await h.apply({
			type: "item",
			op: "upsert",
			key,
			data: {
				itemType: "journalArticle",
				title: "Preprint Paper",
				publisher: "bioRxiv",
				publicationTitle: "Working Papers",
				DOI: "10.1101/2026.01.01",
			},
		});

		const toPreprint = await h.apply({
			type: "item",
			op: "upsert",
			key,
			data: {
				itemType: "preprint",
				title: "Preprint Paper",
				publisher: "bioRxiv",
				publicationTitle: "Working Papers",
				DOI: "10.1101/2026.01.01",
			},
		});
		expect(toPreprint.results[0]).toMatchObject({ ok: true, changed: true });
		expect(h.itemMeta(key).typeName).toBe("preprint");
		expect(h.itemFields(key)).toEqual({
			title: "Preprint Paper",
			repository: "bioRxiv",
			DOI: "10.1101/2026.01.01",
			extra: "publicationTitle: Working Papers",
		});

		// Reverse: preprint -> journalArticle maps type-specific repository -> base field publisher
		const backToArticle = await h.apply({
			type: "item",
			op: "upsert",
			key,
			data: {
				itemType: "journalArticle",
				title: "Preprint Paper",
				repository: "bioRxiv",
				DOI: "10.1101/2026.01.01",
			},
		});
		expect(backToArticle.results[0]).toMatchObject({ ok: true, changed: true });
		expect(h.itemMeta(key).typeName).toBe("journalArticle");
		expect(h.itemFields(key)).toEqual({
			title: "Preprint Paper",
			publisher: "bioRxiv",
			DOI: "10.1101/2026.01.01",
		});
	});

	test("itemType change with identical fields still marks changed, updates itemTypeID, synced = 0, and clientVersion", async () => {
		const h = makeHarness();
		const key = genKey();
		const sharedFields = {
			title: "Minimal Page",
			url: "https://example.org/minimal",
			date: "2025-11-20",
			creators: [{ creatorType: "author", firstName: "Jane", lastName: "Doe" }],
			tags: [{ tag: "web" }],
		};

		await h.apply({ type: "item", op: "upsert", key, data: { itemType: "blogPost", ...sharedFields } });
		h.exec(
			"UPDATE items SET version = 3, synced = 1, dateModified = '2025-11-20 12:00:00', clientDateModified = '2025-11-20 12:00:00' WHERE key = ?",
			key,
		);
		const before = h.itemMeta(key);
		expect(before).toMatchObject({ typeName: "blogPost", version: 3, synced: 1 });

		const { results } = await h.apply({ type: "item", op: "upsert", key, data: { itemType: "webpage", ...sharedFields } });
		expect(results[0]).toMatchObject({ key, ok: true, changed: true });

		const after = h.itemMeta(key);
		expect(after.typeName).toBe("webpage");
		expect(after.version).toBe(3);
		expect(after.synced).toBe(0);
		expect(after.clientVersion).toBe(before.clientVersion + 1);
		expect(after.dateModified).not.toBe("2025-11-20 12:00:00");
		expect(after.clientDateModified).not.toBe("2025-11-20 12:00:00");
		expect(h.itemFields(key)).toEqual({
			title: "Minimal Page",
			url: "https://example.org/minimal",
			date: "2025-11-20 2025-11-20",
		});
	});

	test("structural itemType changes (note, attachment, annotation) are still rejected", async () => {
		const h = makeHarness();
		const kWeb = genKey();
		const kNote = genKey();
		const kAtt = genKey();
		const kAnn = genKey();

		const setup = await h.apply(
			{ type: "item", op: "upsert", key: kWeb, data: { itemType: "webpage", title: "A page" } },
			{ type: "item", op: "upsert", key: kNote, data: { itemType: "note", note: "<p>A note</p>" } },
			{
				type: "item",
				op: "upsert",
				key: kAtt,
				data: {
					itemType: "attachment",
					parentItem: kWeb,
					linkMode: "imported_file",
					title: "doc.pdf",
					contentType: "application/pdf",
					filename: "doc.pdf",
				},
			},
			{
				type: "annotation",
				op: "upsert",
				key: kAnn,
				data: {
					parentItem: kAtt,
					type: "highlight",
					sortIndex: "00000|000001|00000",
					position: { pageIndex: 0, rects: [[0, 0, 1, 1]] },
				},
			},
		);
		expect(setup.results.every((r) => r.ok)).toBe(true);

		const cases: [string, string, string, string][] = [
			[kNote, "note", "webpage", "changing itemType (note -> webpage) is not supported"],
			[kWeb, "webpage", "note", "changing itemType (webpage -> note) is not supported"],
			[kAtt, "attachment", "webpage", "changing itemType (attachment -> webpage) is not supported"],
			[kWeb, "webpage", "attachment", "changing itemType (webpage -> attachment) is not supported"],
			[kNote, "note", "attachment", "changing itemType (note -> attachment) is not supported"],
			[kAtt, "attachment", "note", "changing itemType (attachment -> note) is not supported"],
			[kWeb, "webpage", "annotation", "annotations must use type 'annotation'"],
			[kAnn, "annotation", "webpage", `${kAnn} is an annotation, not an item`],
		];

		for (const [key, fromType, toType, expectedError] of cases) {
			const payload: Record<string, unknown> = { itemType: toType, title: "Attempted change" };
			if (toType === "note") payload.note = "<p>nope</p>";
			if (toType === "attachment") payload.linkMode = "linked_url";
			const { results } = await h.apply({ type: "item", op: "upsert", key, data: payload });
			expect(results[0]).toMatchObject({ key, ok: false, error: expectedError });
			expect(h.itemMeta(key).typeName).toBe(fromType);
		}
	});

	test("end-to-end SyncService push after patchItem changes blogPost -> webpage", async () => {
		const h = makeHarness();
		const key = "PUX4PUM5";
		await h.apply({
			type: "item",
			op: "upsert",
			key,
			data: {
				itemType: "blogPost",
				title: "Synced Post",
				blogTitle: "Example Blog",
				url: "https://example.org/post",
				creators: [{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" }],
			},
		});

		const zincDb = openDb(":memory:");
		try {
			const svc = new SyncService(zincDb, {
				dataDir: h.dataDir,
				reader: h.reader,
				writer: h.writer,
				isZoteroRunning: noRunning,
				ownStorageDir: null,
				watch: false,
				pollMs: 0,
			});
			await svc.pull();
			await svc.setEnabled(true);

			// Change itemType in Zinc (same flow as the UI)
			const patched = patchItem(zincDb, key, { itemType: "webpage" });
			expect(patched.data.itemType).toBe("webpage");
			expect(patched.data.websiteTitle).toBe("Example Blog");
			expect(patched.data.blogTitle).toBeUndefined();

			// Push into Zotero DB and verify clean completion
			await svc.push();
			const st = await svc.status();
			expect(st.pending).toBe(0);
			expect(st.lastError).toBeUndefined();
			expect(h.itemMeta(key).typeName).toBe("webpage");
			expect(h.itemFields(key)).toMatchObject({ title: "Synced Post", websiteTitle: "Example Blog" });
			expect(h.itemFields(key).blogTitle).toBeUndefined();

			// Subsequent pull does not conflict or revert
			await svc.pull();
			expect((await svc.status()).conflicts).toBe(0);
			const row = zincDb.query("SELECT item_type FROM items WHERE key = ?").get(key) as { item_type: string };
			expect(row.item_type).toBe("webpage");
		} finally {
			zincDb.close(true);
		}
	});
});
