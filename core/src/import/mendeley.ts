// Mendeley Desktop (the retired desktop app) -> zotero-next.
// Reads the SQLite library Mendeley keeps at
//   %LOCALAPPDATA%\Mendeley Ltd\Mendeley Desktop\<account>@www.mendeley.com.sqlite
// and writes documents, creators, tags, folders (as collections), notes and file links.
// The mapping follows Zotero's own importer (zotero/zotero chrome/content/zotero/import/mendeley).
//
// The file is never modified: it is copied to a temporary folder first, and an encrypted database
// (Mendeley encrypts newer libraries with SQLCipher-style page encryption) is decrypted on the copy.
import { Database } from "bun:sqlite";
import { createCipheriv } from "node:crypto";
import {
	closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addFile, addLink } from "../additems/files";
import type { Creator, ZoteroItemData } from "../api-types";
import { appendExtra, hasField } from "../io/common";
import { mendeleyDataDirs } from "../platform-dirs";
import { createCollection, createItem, getCollection, HttpError } from "../db";

// ---------------------------------------------------------------- discovery

export interface MendeleyDatabase {
	path: string;
	account: string; // the profile UUID, or "online"
	sizeBytes: number;
	modified: string;
	encrypted: boolean; // decrypted on import
	inUse: boolean; // Mendeley is probably still running
}

function mendeleyDirs(): string[] {
	return mendeleyDataDirs().filter((d) => existsSync(d));
}

/** True when the database file is encrypted (no SQLite header, 12 reserved bytes per page). */
export function isEncryptedMendeleyDb(path: string): boolean {
	let header: Buffer;
	try {
		const fd = openSync(path, "r");
		try {
			header = Buffer.alloc(24);
			if (readSync(fd, header, 0, 24, 0) < 24) return false;
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
	if (header.subarray(0, 16).toString("latin1") === "SQLite format 3\0") return false;
	const pageSize = header.readUInt16BE(16) === 1 ? 65536 : header.readUInt16BE(16);
	return header[20] === 12 && pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0;
}

/** Mendeley databases on this machine, newest first. Empty when the app was never used. */
export function discoverMendeleyDatabases(): MendeleyDatabase[] {
	const out: MendeleyDatabase[] = [];
	for (const dir of mendeleyDirs()) {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.toLowerCase().endsWith(".sqlite")) continue;
			const path = join(dir, name);
			let size = 0;
			let modified = "";
			try {
				const s = statSync(path);
				if (!s.isFile()) continue;
				size = s.size;
				modified = s.mtime.toISOString();
			} catch {
				continue;
			}
			const match = /^([0-9a-f-]{36})@www\.mendeley\.com\.sqlite$/i.exec(name);
			out.push({
				path,
				account: match ? match[1]! : name.replace(/\.sqlite$/i, ""),
				sizeBytes: size,
				modified,
				encrypted: isEncryptedMendeleyDb(path),
				inUse: existsSync(`${path}-shm`) || existsSync(`${path}-wal`),
			});
		}
	}
	return out.sort((a, b) => (a.modified < b.modified ? 1 : -1));
}

// ---------------------------------------------------------------- decryption

const OBFUSCATED_KEY = "e5431aeb503dcf0ab92d3e936c0bbb40fc7e0a9448699a77dacd9cb6276d288bd";
const RESERVED_SIZE = 12;
const BLOCK_SIZE = 16;

/** Mendeley's compiled-in key, de-obfuscated (nibbles swapped, XOR 0x62). */
function baseKey(): Buffer {
	const obfuscated = Buffer.from(OBFUSCATED_KEY, "hex");
	const key = Buffer.alloc(32);
	for (let i = 0; i < 32; i++) {
		const byte = obfuscated[i]! ^ 0x62;
		key[i] = ((byte << 4) | (byte >> 4)) & 0xff;
	}
	return key;
}

/** The profile UUID in Windows GUID byte order (first three fields little-endian). */
function uuidBytes(uuid: string): Buffer {
	const m = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(uuid);
	if (!m) throw new Error(`invalid Mendeley profile UUID: ${uuid}`);
	const le = (hex: string) => Buffer.from(hex, "hex").reverse();
	return Buffer.concat([le(m[1]!), le(m[2]!), le(m[3]!), Buffer.from(m[4]! + m[5]!, "hex")]);
}

/** The database key: the base key XOR-folded with the profile UUID. */
function libraryKey(profileUuid: string): Buffer {
	const key = baseKey();
	const uuid = uuidBytes(profileUuid);
	for (let i = 0; i < 16; i++) {
		key[i] ^= uuid[i]!;
		key[31 - i] ^= uuid[i]!;
	}
	return key;
}

function decryptPage(key: Buffer, pageNumber: number, page: Buffer): void {
	const encryptedSize = page.length - RESERVED_SIZE;
	const iv = Buffer.alloc(BLOCK_SIZE);
	iv.writeUInt32LE(pageNumber, 0);
	page.copy(iv, 4, encryptedSize);
	const clearHeader = pageNumber === 1 ? Buffer.from(page.subarray(16, 24)) : null;
	const keystream = createCipheriv("aes-256-ofb", key, iv).update(Buffer.alloc(encryptedSize));
	for (let i = 0; i < encryptedSize; i++) page[i] ^= keystream[i]!;
	if (clearHeader) clearHeader.copy(page, 16);
}

function profileUuidOf(path: string): string | null {
	const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@www\.mendeley\.com\.sqlite$/i.exec(basename(path));
	return m ? m[1]! : null;
}

/** Decrypt an encrypted Mendeley database into `target`. Throws when the key cannot be derived. */
export function decryptMendeleyDb(source: string, target: string): void {
	const data = readFileSync(source);
	const pageSize = data.readUInt16BE(16) === 1 ? 65536 : data.readUInt16BE(16);
	if (data.length < 24 || data[20] !== RESERVED_SIZE || pageSize < 512 || data.length % pageSize) {
		throw new Error("unsupported Mendeley database encryption");
	}
	const profile = profileUuidOf(source);
	const candidates = profile ? [libraryKey(profile), baseKey()] : [baseKey()];
	const key = candidates.find((candidate) => {
		const first = Buffer.from(data.subarray(0, pageSize));
		decryptPage(candidate, 1, first);
		return first.subarray(0, 16).toString("latin1") === "SQLite format 3\0";
	});
	if (!key) throw new Error("cannot derive the Mendeley database key");
	for (let page = 1; page <= data.length / pageSize; page++) {
		decryptPage(key, page, data.subarray((page - 1) * pageSize, page * pageSize));
	}
	writeFileSync(target, data);
}

// ---------------------------------------------------------------- schema map

const ITEM_TYPES: Record<string, string> = {
	Bill: "bill", Book: "book", BookSection: "bookSection", Case: "case", ComputerProgram: "computerProgram",
	ConferenceProceedings: "conferencePaper", EncyclopediaArticle: "encyclopediaArticle", Film: "film",
	Generic: "document", Hearing: "hearing", JournalArticle: "journalArticle", MagazineArticle: "magazineArticle",
	NewspaperArticle: "newspaperArticle", Patent: "patent", Report: "report", Statute: "statute",
	TelevisionBroadcast: "tvBroadcast", Thesis: "thesis", WebPage: "webpage", WorkingPaper: "report",
};

const CREATOR_TYPES: Record<string, string> = { DocumentAuthor: "author", DocumentEditor: "editor", DocumentTranslator: "translator" };

/** Documents column -> Zotero field (the map Zotero ships for schema 83); "" means handled elsewhere. */
const FIELD_MAP: Record<string, string> = {
	publisher: "publisher", series: "seriesTitle", seriesNumber: "seriesNumber", sections: "section",
	pages: "pages", publication: "publicationTitle", publicLawNumber: "publicLawNumber", shortTitle: "shortTitle",
	volume: "volume", userType: "type", dateAccessed: "accessDate", committee: "committee", doi: "DOI",
	edition: "edition", codeSection: "section", codeVolume: "codeVolume", code: "code", codeNumber: "codeNumber",
	issue: "issue", language: "language", isbn: "ISBN", issn: "ISSN", medium: "medium", legalStatus: "legalStatus",
	institution: "publisher", genre: "genre", applicationNumber: "applicationNumber", abstract: "abstractNote",
	title: "title", pmid: "PMID", citationKey: "Citation Key", arxivId: "arXiv", country: "place", city: "place",
	session: "session",
};

const EXTRA_FIELDS: Record<string, string> = { PMID: "PMID", "Citation Key": "Citation Key", arXiv: "arXiv" };

/** Mendeley's own markup in notes becomes HTML. */
function convertNote(note: string): string {
	return note
		.replace(/<br\s*\/>/g, "<br/>\n")
		.replace(/<m:linebreak><\/m:linebreak>/g, "<br/>")
		.replace(/<(\/)?m:bold>/g, "<$1b>")
		.replace(/<(\/)?m:italic>/g, "<$1i>")
		.replace(/<m:center>/g, '<p style="text-align: center;">')
		.replace(/<\/m:center>/g, "</p>")
		.replace(/<m:underline>/g, '<span style="text-decoration: underline;">')
		.replace(/<\/m:underline>/g, "</span>");
}

const unixDate = (v: unknown): string => {
	const n = Number(v);
	if (!Number.isFinite(n) || n <= 0) return "";
	const d = new Date(n * 1000);
	return Number.isNaN(d.getTime()) ? "" : d.toISOString();
};

function guessItemType(row: Row): string {
	const type = ITEM_TYPES[String(row.type ?? "")];
	if (type && type !== "document") return type;
	if (row.issn || row.issue) return "journalArticle";
	if (row.isbn) return "book";
	return type ?? "document";
}

type Row = Record<string, any>;

/** Rows of a query, or [] when the table does not exist in this Mendeley version. */
function rows(db: Database, sql: string, ...params: (string | number)[]): Row[] {
	try {
		return db.query(sql).all(...params) as Row[];
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------- import

export interface MendeleyImportOptions {
	path: string; // the .sqlite to read
	collectionName?: string | null;
	collectionKey?: string;
	/** Link to the PDFs where they are instead of copying them into the library. */
	linkFiles?: boolean;
}

export interface MendeleyImportResult {
	created: number;
	skipped: number; // documents already imported (same Mendeley UUID)
	errors: string[];
	collectionKey: string | null;
	format: "mendeley";
	collections: number; // folders turned into collections (the import collection itself is not counted)
	attachments: number;
	missingFiles: number;
}

export function importMendeley(db: Database, opts: MendeleyImportOptions): MendeleyImportResult {
	if (!opts.path || !existsSync(opts.path)) throw new HttpError(404, "Mendeley database not found");
	if (opts.collectionKey && !getCollection(db, opts.collectionKey)) throw new HttpError(404, "collection not found");
	const result: MendeleyImportResult = {
		created: 0, skipped: 0, errors: [], collectionKey: null,
		format: "mendeley", collections: 0, attachments: 0, missingFiles: 0,
	};

	// every document goes into this collection; its Mendeley folders are created underneath it
	let root = opts.collectionKey ?? null;
	if (!root && opts.collectionName !== null) {
		const name = (opts.collectionName ?? "").trim() || `Imported ${new Date().toISOString().slice(0, 10)}`;
		root = createCollection(db, name).key;
	}
	result.collectionKey = root;

	// an import that brings nothing must not leave an empty collection behind
	const dropEmptyRoot = () => {
		if (!root || opts.collectionKey) return;
		const used = db
			.query(
				`SELECT (SELECT count(*) FROM collection_items WHERE collection_key = ?1)
				      + (SELECT count(*) FROM collections WHERE parent_key = ?1) AS n`,
			)
			.get(root) as { n: number };
		if (used.n > 0) return;
		db.query("DELETE FROM collections WHERE key = ?").run(root);
		result.collectionKey = null;
		root = null;
	};

	// work on a copy: the user's database is never opened for writing, and a running Mendeley cannot lock us out
	const work = mkdtempSync(join(tmpdir(), "zn-mendeley-"));
	const source = join(work, "mendeley.sqlite");
	let src: Database | null = null;
	try {
		for (const ext of ["", "-wal", "-shm"]) {
			const from = opts.path + ext;
			if (existsSync(from)) copyFileSync(from, source + ext);
		}
		const encrypted = isEncryptedMendeleyDb(source);
		if (encrypted) decryptMendeleyDb(source, join(work, "decrypted.sqlite"));
		src = new Database(encrypted ? join(work, "decrypted.sqlite") : source);
		readLibrary(db, src, opts, root, result, dirname(opts.path));
		dropEmptyRoot();
		return result;
	} catch (e) {
		dropEmptyRoot();
		if (e instanceof HttpError) throw e;
		throw new HttpError(400, `could not read the Mendeley database: ${e instanceof Error ? e.message : e}`);
	} finally {
		try {
			src?.close();
		} catch {
			// already closed
		}
		rmSync(work, { recursive: true, force: true });
	}
}

function readLibrary(db: Database, src: Database, opts: MendeleyImportOptions, root: string | null, result: MendeleyImportResult, dataDir: string): void {
	if (!rows(src, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'Documents'").length) {
		throw new Error("the file is not a Mendeley Desktop library (no Documents table)");
	}
	const documents = rows(src, "SELECT * FROM Documents").filter((d) => {
		const trashed = d.inTrash;
		return !(trashed === "true" || trashed === 1 || trashed === "1");
	});

	const contributors = new Map<number, { creatorType: string; firstNames: string; lastName: string }[]>();
	for (const r of rows(src, "SELECT documentId, contribution, firstNames, lastName FROM DocumentContributors")) {
		const list = contributors.get(r.documentId as number) ?? [];
		list.push({ creatorType: CREATOR_TYPES[r.contribution as string] ?? "author", firstNames: r.firstNames ?? "", lastName: r.lastName ?? "" });
		contributors.set(r.documentId as number, list);
	}
	const tags = new Map<number, { tag: string; type: number }[]>();
	const tagRows = [
		...rows(src, "SELECT documentId, tag AS tag, 0 AS type FROM DocumentTags"),
		...rows(src, "SELECT documentId, keyword AS tag, 1 AS type FROM DocumentKeywords"),
	];
	for (const r of tagRows) {
		const name = String(r.tag ?? "").trim();
		if (!name) continue;
		const list = tags.get(r.documentId as number) ?? [];
		list.push({ tag: name, type: Number(r.type) === 1 ? 1 : 0 });
		tags.set(r.documentId as number, list);
	}
	const urls = new Map<number, string[]>();
	for (const r of rows(src, "SELECT documentId, CAST(url AS TEXT) AS url FROM DocumentUrls ORDER BY position")) {
		const list = urls.get(r.documentId as number) ?? [];
		if (r.url) list.push(String(r.url));
		urls.set(r.documentId as number, list);
	}
	const files = new Map<number, { path: string; name: string }[]>();
	for (const r of rows(src, "SELECT DF.documentId AS documentId, F.localUrl AS localUrl FROM DocumentFiles DF JOIN Files F ON F.hash = DF.hash")) {
		if (typeof r.localUrl !== "string") continue;
		let path: string;
		try {
			path = r.localUrl.startsWith("file:") ? fileURLToPath(r.localUrl) : r.localUrl;
		} catch {
			continue;
		}
		if (!existsSync(path)) {
			// files under Mendeley's Downloaded folder can sit next to a copied database instead
			const alternative = join(dataDir, "Downloaded", basename(path));
			if (existsSync(alternative)) path = alternative;
			else {
				result.missingFiles++;
				continue;
			}
		}
		const list = files.get(r.documentId as number) ?? [];
		list.push({ path, name: basename(path) });
		files.set(r.documentId as number, list);
	}
	const folders = rows(
		src,
		`SELECT F.id AS id, F.name AS name, CASE WHEN F.parentId = 0 THEN -1 ELSE F.parentId END AS parentId
		 FROM Folders F`,
	);
	const documentFolders = new Map<number, number[]>();
	for (const r of rows(src, "SELECT documentId, folderId FROM DocumentFolders")) {
		const list = documentFolders.get(r.documentId as number) ?? [];
		list.push(r.folderId as number);
		documentFolders.set(r.documentId as number, list);
	}

	// folders as collections: create parents before children
	const folderKeys = new Map<number, string>();
	const folderById = new Map<number, Row>(folders.map((f) => [f.id as number, f]));
	const ensureFolder = (id: number, depth = 0): string | null => {
		const known = folderKeys.get(id);
		if (known) return known;
		const row = folderById.get(id);
		if (!row || depth > 50) return null;
		const parent = Number(row.parentId) > 0 ? ensureFolder(Number(row.parentId), depth + 1) : root;
		const key = createCollection(db, String(row.name ?? "Folder"), parent).key;
		result.collections++;
		folderKeys.set(id, key);
		return key;
	};

	const existing = new Set<string>();
	for (const r of rows(db, "SELECT json_extract(data, '$.relations.\"mendeleyDB:documentUUID\"') AS uuid FROM items WHERE data LIKE '%mendeleyDB:documentUUID%'")) {
		if (r.uuid) existing.add(String(r.uuid));
	}

	db.transaction(() => {
		for (const doc of documents) {
			const uuid = String(doc.uuid ?? "").replace(/^\{|\}$/g, "");
			if (uuid && existing.has(uuid)) {
				result.skipped++;
				continue;
			}
			try {
				createDocument(db, doc, {
					contributors: contributors.get(doc.id as number) ?? [],
					tags: tags.get(doc.id as number) ?? [],
					urls: urls.get(doc.id as number) ?? [],
					files: files.get(doc.id as number) ?? [],
					collections: (documentFolders.get(doc.id as number) ?? []).map(ensureFolder).filter((k): k is string => !!k),
					uuid,
				}, opts, root, result);
				if (uuid) existing.add(uuid);
				result.created++;
			} catch (e) {
				result.errors.push(`document ${doc.id}${doc.title ? ` (${String(doc.title).slice(0, 60)})` : ""}: ${e instanceof Error ? e.message : e}`);
			}
		}
	})();
}

function createDocument(
	db: Database,
	doc: Row,
	extra: {
		contributors: { creatorType: string; firstNames: string; lastName: string }[];
		tags: { tag: string; type: number }[];
		urls: string[];
		files: { path: string; name: string }[];
		collections: string[];
		uuid: string;
	},
	opts: MendeleyImportOptions,
	root: string | null,
	result: MendeleyImportResult,
): void {
	const itemType = guessItemType(doc);
	const data: Partial<ZoteroItemData> & { itemType: string } = { itemType };

	for (const [column, field] of Object.entries(FIELD_MAP)) {
		const value = doc[column];
		if (value === null || value === undefined || value === "") continue;
		const text = String(value).trim();
		if (!text) continue;
		if (field === "place") {
			const current = typeof data.place === "string" ? data.place : "";
			data.place = column === "city" ? (current ? `${text}, ${current}` : text) : current ? `${current}, ${text}` : text;
			continue;
		}
		if (EXTRA_FIELDS[field]) {
			appendExtra(data, `${EXTRA_FIELDS[field]}: ${text}`);
			continue;
		}
		if (hasField(itemType, field)) data[field] = text;
		else appendExtra(data, `${zoteroLabel(field)}: ${text}`);
	}

	// the date is three columns (empty padded strings in some versions)
	const year = String(doc.year ?? "").trim();
	if (year) {
		let date = year.slice(0, 4);
		const month = String(doc.month ?? "").trim();
		if (month && month !== "0") {
			date += `-${month.padStart(2, "0").slice(0, 2)}`;
			const day = String(doc.day ?? "").trim();
			if (day && day !== "0") date += `-${day.padStart(2, "0").slice(0, 2)}`;
		}
		data.date = date;
	}
	const added = unixDate(doc.added);
	if (added) data.dateAdded = added;

	const creators: Creator[] = extra.contributors
		.filter((c) => c.lastName || c.firstNames)
		.map((c) => (c.firstNames ? { creatorType: c.creatorType, firstName: c.firstNames, lastName: c.lastName } : { creatorType: c.creatorType, name: c.lastName }));
	if (creators.length) data.creators = creators;
	if (extra.tags.length) data.tags = extra.tags;
	// favourites are a star tag in Zotero
	if (doc.favourite === "true" || doc.favourite === true) data.tags = [...(data.tags ?? []), { tag: "\u2605" }];
	if (extra.uuid) data.relations = { "mendeleyDB:documentUUID": extra.uuid };
	if (doc.remoteUuid) data.relations = { ...data.relations, "mendeleyDB:remoteDocumentUUID": String(doc.remoteUuid) };

	// the first non-PDF URL is the item's link; PDF URLs become child links
	const pdfUrls = extra.urls.filter((u) => u.includes("pdf"));
	const plainUrl = extra.urls.find((u) => !u.includes("pdf"));
	if (plainUrl) data.url = plainUrl;
	// every document is in the import's root collection, plus the Mendeley folders it was filed in
	const collections = [...(root ? [root] : []), ...extra.collections];

	if (!data.title && !creators.length && !data.date) throw new Error("no title, author or date");
	const detail = createItem(db, { ...data, collections: [...new Set(collections)] });
	const parentKey = detail.data.key;

	const note = String(doc.note ?? "").trim();
	if (note) createItem(db, { itemType: "note", note: convertNote(note), parentItem: parentKey });

	for (const file of extra.files) {
		try {
			addFile(db, {
				mode: opts.linkFiles ? "linked_file" : "imported_file",
				path: file.path,
				parentKey,
				name: file.name,
			});
			result.attachments++;
		} catch (e) {
			result.errors.push(`file ${file.name}: ${e instanceof Error ? e.message : e}`);
		}
	}
	// PDF URLs stay as links next to the file (or on their own when the file was not found)
	for (const url of pdfUrls) {
		try {
			addLink(db, { parentKey, url, title: "PDF" });
			result.attachments++;
		} catch {
			// not a usable URL
		}
	}
}

/** "publicLawNumber" -> "Public Law Number" for Extra lines. */
function zoteroLabel(field: string): string {
	return field
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/^./, (c) => c.toUpperCase());
}
