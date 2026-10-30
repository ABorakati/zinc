// Files the extension uploads (or that we fetch for it): stored like Zotero does for web saves, as imported_url
// attachments (the file lives in storage/<KEY>/, the source URL is kept) via the same addFile the UI uses.
import type { Database } from "bun:sqlite";
import { extname } from "node:path";
import type { ZoteroItemData } from "../api-types";
import { addFile, guessContentType, safeFileName } from "../additems/files";
import { HttpError, nowIso, patchItem } from "../db";
import { indexItem } from "../search";

const EXT: Record<string, string> = {
	"application/pdf": ".pdf",
	"application/epub+zip": ".epub",
	"text/html": ".html",
	"application/xhtml+xml": ".xhtml",
	"text/plain": ".txt",
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/svg+xml": ".svg",
	"application/zip": ".zip",
	"application/json": ".json",
	"video/mp4": ".mp4",
	"audio/mpeg": ".mp3",
};

function urlName(url: string): string {
	try {
		const last = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
		return last;
	} catch {
		return "";
	}
}

/** Zotero's default attachment base name: "Smith - 2020 - Title", "Smith and Jones - ...", "Smith et al. - ...". */
export function zoteroBaseName(data: ZoteroItemData): string {
	const authors = (data.creators ?? []).filter((c) => c.creatorType === "author");
	const list = authors.length ? authors : (data.creators ?? []).slice(0, 1);
	const last = (c: { lastName?: string; name?: string }) => (c.lastName || c.name || "").trim();
	const who = list.length === 0 ? "" : list.length === 1 ? last(list[0]) : list.length === 2 ? `${last(list[0])} and ${last(list[1])}` : `${last(list[0])} et al.`;
	const year = typeof data.date === "string" ? data.date.match(/(?<!\d)(\d{4})(?!\d)/)?.[1] ?? "" : "";
	const title = typeof data.title === "string" ? data.title.trim().slice(0, 100) : "";
	return [who, year, title].filter(Boolean).join(" - ");
}

/** File name for a downloaded attachment: "Author - Year - Title.pdf" under a parent, else from the title / URL. */
export function attachmentFileName(opts: { parent?: ZoteroItemData | null; title?: string; url?: string; contentType: string }): string {
	const ct = opts.contentType.split(";")[0].trim().toLowerCase();
	const fromUrl = opts.url ? urlName(opts.url) : "";
	let ext = EXT[ct] ?? (extname(fromUrl) || "");
	if (ct === "application/octet-stream" || !ct) ext = extname(fromUrl) || ext;
	let base = opts.parent ? zoteroBaseName(opts.parent) : "";
	if (!base) base = (opts.title ?? "").trim() || fromUrl.replace(/\.[A-Za-z0-9]{1,5}$/, "") || "file";
	base = base.replace(/\.[A-Za-z0-9]{1,5}$/, (m) => (m.toLowerCase() === ext.toLowerCase() ? "" : m));
	return safeFileName(base + ext);
}

export interface StoreOpts {
	parentKey?: string;
	collectionKey?: string | null;
	bytes: Uint8Array;
	url: string;
	title?: string;
	contentType: string;
	/** override of the generated file name */
	filename?: string;
}

/** Store `bytes` as an imported_url attachment (under `parentKey`, or standalone in `collectionKey`). Returns its key. */
export function storeWebAttachment(db: Database, o: StoreOpts): string {
	if (!o.bytes || o.bytes.byteLength === 0) throw new HttpError(400, "empty attachment");
	const contentType = (o.contentType || guessContentType(o.filename || urlName(o.url))).split(";")[0].trim() || "application/octet-stream";
	let parent: ZoteroItemData | null = null;
	if (o.parentKey) {
		const row = db.query("SELECT data FROM items WHERE key = ?").get(o.parentKey) as { data: string } | null;
		if (!row) throw new HttpError(404, "parent item not found");
		parent = JSON.parse(row.data) as ZoteroItemData;
	}
	const name = o.filename || attachmentFileName({ parent, title: o.title, url: o.url, contentType });
	const detail = addFile(
		db,
		{ mode: "imported_file", name, contentType, parentKey: o.parentKey, collectionKey: o.parentKey ? undefined : o.collectionKey || undefined },
		o.bytes,
	);
	const key = detail.data.key;
	const title = (o.title ?? "").trim() || detail.data.title || name;
	// addFile made an imported_file; a web save keeps its source URL: imported_url.
	patchItem(db, key, {
		linkMode: "imported_url",
		url: o.url,
		accessDate: nowIso(),
		title,
		...(contentType === "text/html" || contentType === "application/xhtml+xml" ? { charset: "utf-8" } : {}),
	});
	db.query("UPDATE attachments SET link_mode = 'imported_url', url = ? WHERE item_key = ?").run(o.url, key);
	indexItem(db, key);
	if (o.parentKey) indexItem(db, o.parentKey);
	return key;
}
