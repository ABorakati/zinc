import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveColumns, openDb } from "../src/db";
import { rebuildSearchIndex } from "../src/search";
import type { ZoteroItemData } from "../src/api-types";

export function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "zn-core-"));
}

export function insertItem(db: Database, data: ZoteroItemData, parent?: string, deleted = 0): void {
	const cols = deriveColumns(data);
	const now = data.dateAdded ?? "2024-01-01T00:00:00Z";
	data.dateAdded = now;
	data.dateModified = data.dateModified ?? now;
	db.query(
		`INSERT INTO items(key, item_type, parent_key, title, creators_summary, year, publication, data, date_added, date_modified, deleted)
		 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		data.key,
		data.itemType,
		parent ?? null,
		cols.title,
		cols.creators_summary,
		cols.year,
		cols.publication,
		JSON.stringify(data),
		now,
		data.dateModified,
		deleted,
	);
	for (const t of data.tags ?? []) db.query("INSERT INTO item_tags(item_key, tag, type) VALUES(?, ?, 0)").run(data.key, t.tag);
}

export function insertAttachment(
	db: Database,
	key: string,
	parent: string,
	contentType: string,
	path: string | null,
	added = "2024-01-01T00:00:00Z",
): void {
	insertItem(
		db,
		{ key, itemType: "attachment", title: `att ${key}`, contentType, linkMode: "imported_file", parentItem: parent, dateAdded: added },
		parent,
	);
	db.query("INSERT INTO attachments(item_key, link_mode, content_type, path) VALUES(?, 'imported_file', ?, ?)").run(
		key,
		contentType,
		path,
	);
}

export const PDF_BYTES = new Uint8Array(1000).map((_, i) => i % 251);

export interface Fixture {
	db: Database;
	dir: string;
	pdfPath: string;
}

export function buildFixture(): Fixture {
	const dir = tempDir();
	const pdfPath = join(dir, "paper.pdf");
	writeFileSync(pdfPath, PDF_BYTES);
	const db = openDb(join(dir, "lib.sqlite"));

	insertItem(db, {
		key: "AAAAAAA1",
		itemType: "journalArticle",
		title: "Deep learning for radiology",
		creators: [
			{ creatorType: "author", firstName: "Ann", lastName: "Smith" },
			{ creatorType: "author", firstName: "Bob", lastName: "Jones" },
		],
		date: "2020-05-01",
		abstractNote: "We study neural networks applied to chest imaging.",
		publicationTitle: "Journal of Medical AI",
		tags: [{ tag: "ml" }, { tag: "imaging" }],
		collections: ["COLLAAA1"],
		dateAdded: "2024-03-01T00:00:00Z",
	});
	insertItem(
		db,
		{ key: "NOTE0001", itemType: "note", note: "<p>Great <b>transformer</b> paper &amp; notes</p>", parentItem: "AAAAAAA1" },
		"AAAAAAA1",
	);
	insertAttachment(db, "ATT00001", "AAAAAAA1", "text/html", null, "2024-01-01T00:00:00Z");
	insertAttachment(db, "ATT00002", "AAAAAAA1", "application/pdf", pdfPath, "2024-01-02T00:00:00Z");
	db.query(
		"INSERT INTO fulltext(attachment_key, content, source, indexed_at) VALUES('ATT00002', ?, 'zotero-cache', '2024-01-01T00:00:00Z')",
	).run("convolutional segmentation of pulmonary nodules in lung scans");

	insertItem(db, {
		key: "BBBBBBB2",
		itemType: "book",
		title: "Surgical anatomy",
		creators: [{ creatorType: "author", firstName: "Cara", lastName: "Brown" }],
		date: "2018",
		tags: [{ tag: "imaging" }],
		dateAdded: "2024-02-01T00:00:00Z",
	});
	insertItem(
		db,
		{ key: "CCCCCCC3", itemType: "journalArticle", title: "Trashed article about zebras", dateAdded: "2024-01-15T00:00:00Z" },
		undefined,
		1,
	);
	insertItem(db, {
		key: "DDDDDDD4",
		itemType: "journalArticle",
		title: "Zebra genetics",
		creators: [
			{ creatorType: "author", lastName: "Lee" },
			{ creatorType: "author", lastName: "Kim" },
			{ creatorType: "author", lastName: "Park" },
		],
		date: "March 2022",
		dateAdded: "2024-04-01T00:00:00Z",
	});
	insertAttachment(db, "ATT00003", "DDDDDDD4", "application/epub+zip", join(dir, "missing.epub"));

	db.query("INSERT INTO collections(key, name) VALUES('COLLAAA1', 'Radiology')").run();
	db.query("INSERT INTO collections(key, name, parent_key) VALUES('COLLAAA2', 'Sub', 'COLLAAA1')").run();
	db.query("INSERT INTO collection_items VALUES('COLLAAA1', 'AAAAAAA1')").run();

	db.query(
		"INSERT INTO annotations(key, attachment_key, data, date_modified) VALUES('ANNO0001', 'ATT00002', ?, '2024-01-01T00:00:00Z')",
	).run(
		JSON.stringify({
			id: "ANNO0001",
			type: "highlight",
			sortIndex: "00001|000100|00200",
			position: {},
			dateModified: "2024-01-01T00:00:00Z",
		}),
	);

	rebuildSearchIndex(db);
	return { db, dir, pdfPath };
}

export async function call(db: Database, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
	const { handleApi } = await import("../src/api");
	const res = await handleApi(
		new Request(`http://127.0.0.1:23120${path}`, {
			method,
			headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		db,
	);
	return res!;
}
