// Files the extension uploads (or that we fetch for it): stored like Zotero does for web saves, as imported_url
// attachments (the file lives in storage/<KEY>/, the source URL is kept) via the same addFile the UI uses.
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { extname, join } from "node:path";
import type { ItemDetail, ZoteroItemData } from "../api-types";
import { addFile, guessContentType, safeFileName, storageRoot } from "../additems/files";
import { HttpError, nowIso, patchItem } from "../db";
import { neutraliseExecutableName } from "../io/dangerous";
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
	return neutraliseExecutableName(safeFileName(base + ext));
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
	// bytes from a web page never keep an executable / script extension ("setup.exe" is stored as "setup.exe.txt")
	const name = neutraliseExecutableName(o.filename ? safeFileName(o.filename) : attachmentFileName({ parent, title: o.title, url: o.url, contentType }));
	// One transaction for the new attachment and its web-save fields: if anything after addFile fails, no half-made
	// imported_file row is left behind, and the file addFile stored is removed again.
	let made: ItemDetail | undefined;
	try {
		return db.transaction(() => {
			made = addFile(
				db,
				{ mode: "imported_file", name, contentType, parentKey: o.parentKey, collectionKey: o.parentKey ? undefined : o.collectionKey || undefined },
				o.bytes,
			);
			return finishWebAttachment(db, made, o, name, contentType);
		})();
	} catch (e) {
		if (made) removeStoredFile(db, made);
		throw e;
	}
}

/** The file addFile stored for an attachment whose rows were rolled back: its own storage folder, or the one file it placed. */
function removeStoredFile(db: Database, d: ItemDetail): void {
	try {
		if (d.data.linkMode === "linked_file" && typeof d.data.path === "string") rmSync(d.data.path, { force: true });
		else rmSync(join(storageRoot(db), d.data.key), { recursive: true, force: true });
	} catch (e) {
		console.error("could not remove the file of a failed web attachment:", e instanceof Error ? e.message : e);
	}
}

function finishWebAttachment(db: Database, detail: ItemDetail, o: StoreOpts, name: string, contentType: string): string {
	const key = detail.data.key;
	// A file the storage folder took over (linked file, renamed to "Author - Year - Title") keeps that name as its title.
	const managed = detail.data.linkMode === "linked_file";
	const title = managed && detail.data.title && detail.data.title !== name ? detail.data.title : (o.title ?? "").trim() || detail.data.title || name;
	// addFile made an imported_file; a web save keeps its source URL: imported_url. In the storage folder it stays a linked file.
	const linkMode = managed ? "linked_file" : "imported_url";
	patchItem(db, key, {
		linkMode,
		url: o.url,
		accessDate: nowIso(),
		title,
		...(contentType === "text/html" || contentType === "application/xhtml+xml" ? { charset: "utf-8" } : {}),
	});
	db.query("UPDATE attachments SET link_mode = ?, url = ? WHERE item_key = ?").run(linkMode, o.url, key);
	indexItem(db, key);
	if (o.parentKey) indexItem(db, o.parentKey);
	return key;
}
