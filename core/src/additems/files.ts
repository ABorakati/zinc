// Attachments: imported files (copied into <db dir>/storage/<KEY>/<name>, same layout as Zotero), linked files
// (absolute path kept as is) and linked URLs; plus moving a standalone attachment under a parent item.
import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import type { ItemDetail, ZoteroItemData } from "../api-types";
import { HttpError, clearFileCache, createItem, deriveColumns, generateKey, getItemDetail, nowIso } from "../db";
import { extractFulltext } from "../extract";
import { storageTargetFor } from "../files/storage";
import { indexItem } from "../search";

export const hooks = {
	/** Runs after an attachment is stored: full-text extraction + indexing, best effort (tests replace it). */
	afterImport: (db: Database, attachmentKey: string): void => {
		void extractFulltext(db, attachmentKey).catch((e) => console.error("full-text extraction failed:", e instanceof Error ? e.message : e));
	},
};

const MIME: Record<string, string> = {
	".pdf": "application/pdf",
	".epub": "application/epub+zip",
	".html": "text/html",
	".htm": "text/html",
	".txt": "text/plain",
	".md": "text/markdown",
	".csv": "text/csv",
	".json": "application/json",
	".xml": "text/xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".ppt": "application/vnd.ms-powerpoint",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".zip": "application/zip",
	".mp4": "video/mp4",
	".mp3": "audio/mpeg",
};

export function guessContentType(name: string): string {
	return MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
}

export function storageRoot(db: Database): string {
	const file = (db as unknown as { filename?: string }).filename;
	const base = file && file !== ":memory:" ? dirname(file) : join(process.env.TEMP ?? ".", "zotero-next-fulltext");
	return join(base, "storage");
}

export function safeFileName(s: string): string {
	const cleaned = s
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "")
		.replace(/[. ]+$/, "");
	if (!cleaned) return "file";
	if (cleaned.length <= 120) return cleaned;
	const ext = extname(cleaned);
	return cleaned.slice(0, 120 - ext.length) + ext;
}

function checkParent(db: Database, parentKey: string): void {
	const p = db.query("SELECT parent_key, item_type FROM items WHERE key = ?").get(parentKey) as { parent_key: string | null; item_type: string } | null;
	if (!p) throw new HttpError(404, "parent item not found");
	if (p.parent_key || p.item_type === "attachment" || p.item_type === "note") throw new HttpError(400, "parent item must be a regular top-level item");
}

function checkCollection(db: Database, key: string): void {
	if (!db.query("SELECT 1 FROM collections WHERE key = ?").get(key)) throw new HttpError(404, `collection not found: ${key}`);
}

export interface AddFileRequest {
	mode?: "imported_file" | "linked_file";
	name?: string;
	contentType?: string;
	/** file bytes, base64 (the API is JSON-only because of the CSRF guard) */
	dataBase64?: string;
	/** local file: copied for imported_file, referenced for linked_file */
	path?: string;
	parentKey?: string;
	collectionKey?: string;
}

export function addFile(db: Database, req: AddFileRequest, bytes?: Uint8Array): ItemDetail {
	const mode = req.mode ?? "imported_file";
	if (mode !== "imported_file" && mode !== "linked_file") throw new HttpError(400, "mode must be imported_file or linked_file");
	if (req.parentKey) checkParent(db, req.parentKey);
	const collectionKey = req.parentKey ? undefined : req.collectionKey || undefined;
	if (collectionKey) checkCollection(db, collectionKey);

	let source: string | undefined;
	if (req.path !== undefined) {
		if (typeof req.path !== "string" || !isAbsolute(req.path)) throw new HttpError(400, "path must be an absolute path");
		if (!existsSync(req.path) || !statSync(req.path).isFile()) throw new HttpError(404, "file not found");
		source = req.path;
	}
	if (mode === "linked_file" && !source) throw new HttpError(400, "linked_file requires a local path");
	if (mode === "imported_file" && !source && !bytes && typeof req.dataBase64 !== "string") throw new HttpError(400, "dataBase64 or path is required");

	const name = safeFileName(String(req.name || (source ? basename(source) : "") || "file"));
	const contentType = (typeof req.contentType === "string" && req.contentType && req.contentType !== "application/octet-stream" ? req.contentType : guessContentType(name)).split(";")[0];

	let key = generateKey();
	while (db.query("SELECT 1 FROM items WHERE key = ?").get(key)) key = generateKey();
	const now = nowIso();
	let stored: string;
	let dir: string | undefined;
	let finalMode: "imported_file" | "linked_file" = mode;
	let createdDir = false; // only a folder this call created is removed again on failure (a custom folder may hold other files)
	if (mode === "imported_file") {
		const t = storageTargetFor(db, { key, name, parentKey: req.parentKey });
		finalMode = t.mode;
		dir = t.dir;
		stored = t.path;
		createdDir = !t.custom;
		try {
			mkdirSync(t.dir, { recursive: true });
			if (source) copyFileSync(source, t.path);
			else writeFileSync(t.path, bytes ?? Buffer.from(req.dataBase64 as string, "base64"));
		} catch (e) {
			if (createdDir) rmSync(t.dir, { recursive: true, force: true });
			else rmSync(t.path, { force: true });
			throw new HttpError(500, `could not store the file: ${e instanceof Error ? e.message : e}`);
		}
	} else {
		stored = source as string;
	}
	const fileName = basename(stored);

	const data: ZoteroItemData = {
		key,
		itemType: "attachment",
		linkMode: finalMode,
		title: name,
		contentType,
		filename: fileName,
		tags: [],
		relations: {},
		collections: collectionKey ? [collectionKey] : [],
		dateAdded: now,
		dateModified: now,
	};
	if (req.parentKey) data.parentItem = req.parentKey;
	if (finalMode === "linked_file") data.path = stored;
	const cols = deriveColumns(data);
	try {
		db.transaction(() => {
			db.query(
				`INSERT INTO items(key, item_type, parent_key, title, creators_summary, year, publication, data, date_added, date_modified, deleted)
				 VALUES(?, 'attachment', ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
			).run(key, req.parentKey || null, cols.title, cols.creators_summary, cols.year, cols.publication, JSON.stringify(data), now, now);
			db.query("INSERT INTO attachments(item_key, link_mode, content_type, path, url) VALUES(?, ?, ?, ?, NULL)").run(key, finalMode, contentType, stored);
			if (collectionKey) db.query("INSERT INTO collection_items(collection_key, item_key) VALUES(?, ?)").run(collectionKey, key);
		})();
	} catch (e) {
		if (dir && createdDir) rmSync(dir, { recursive: true, force: true });
		else if (mode === "imported_file") rmSync(stored, { force: true });
		throw e;
	}
	clearFileCache();
	indexItem(db, key);
	try {
		hooks.afterImport(db, key);
	} catch (e) {
		console.error("after import failed:", e);
	}
	return getItemDetail(db, key)!;
}

export function addLink(db: Database, req: { parentKey?: string; url?: string; title?: string; collectionKey?: string }): ItemDetail {
	const raw = typeof req.url === "string" ? req.url.trim() : "";
	if (!raw) throw new HttpError(400, "url is required");
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new HttpError(400, "invalid url");
	}
	if (!/^[a-z][a-z0-9+.-]*:$/i.test(url.protocol) || url.protocol === "javascript:" || url.protocol === "data:") throw new HttpError(400, "unsupported url scheme");
	if (req.parentKey) checkParent(db, req.parentKey);
	const title = typeof req.title === "string" && req.title.trim() ? req.title.trim() : raw;
	const detail = createItem(db, {
		itemType: "attachment",
		linkMode: "linked_url",
		title,
		url: raw,
		accessDate: nowIso(),
		contentType: "",
		...(req.parentKey ? { parentItem: req.parentKey } : req.collectionKey ? { collections: [req.collectionKey] } : {}),
	});
	indexItem(db, detail.data.key);
	return detail;
}

/** Move a standalone attachment or note under a top-level parent item (it leaves any collections, like Zotero child items). */
export function reparentItem(db: Database, itemKey: string, parentKey: string): void {
	checkParent(db, parentKey);
	const row = db.query("SELECT data, parent_key, item_type FROM items WHERE key = ?").get(itemKey) as { data: string; parent_key: string | null; item_type: string } | null;
	if (!row || (row.item_type !== "attachment" && row.item_type !== "note")) throw new HttpError(404, "standalone attachment or note not found");
	if (row.parent_key) throw new HttpError(400, "the item already has a parent");
	const data = JSON.parse(row.data) as ZoteroItemData;
	data.parentItem = parentKey;
	data.collections = [];
	const modified = nowIso();
	data.dateModified = modified;
	db.transaction(() => {
		db.query("UPDATE items SET parent_key = ?, data = ?, date_modified = ? WHERE key = ?").run(parentKey, JSON.stringify(data), modified, itemKey);
		db.query("DELETE FROM collection_items WHERE item_key = ?").run(itemKey);
	})();
	clearFileCache();
	indexItem(db, parentKey);
	indexItem(db, itemKey);
}
