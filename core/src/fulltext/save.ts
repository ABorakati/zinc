// Effect::SavePdf: move the downloaded PDF into <dataDir>/storage/<KEY>/<name>.pdf and create the attachment rows
// (items + attachments, imported_url / application/pdf) under the parent item. Same storage layout as Zotero.

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ZoteroItemData } from "../api-types";
import { addTags, clearFileCache, deriveColumns, generateKey, nowIso } from "../db";
import { storedFormForNewLink } from "../files/paths";
import { assertFilesWritable } from "../libraries";
import { copyVerifiedSync, storageTargetFor } from "../files/storage";
import type { BodyStore } from "./bodies";
import { OpError } from "./http";
import type { BodyRef } from "./proto";

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

const TITLES: Record<string, string> = {
	published: "Full Text PDF",
	unknown: "Full Text PDF",
	accepted: "Accepted Version",
	submitted: "Submitted Version",
};

/** Refuse to store proxied / sign-in URLs: only the canonical article URL belongs on the attachment. */
export function isStorableUrl(url: string, ezproxySuffix = ""): boolean {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return false;
	const lower = url.toLowerCase();
	if (lower.includes("login?qurl=") || lower.includes("/redirector/") || lower.includes("samlrequest")) return false;
	const suffix = ezproxySuffix.trim().toLowerCase().replace(/^\.+/, "");
	if (suffix) {
		const host = u.hostname.toLowerCase();
		if (host === suffix || host.endsWith(`.${suffix}`)) return false;
	}
	return true;
}

function safeFilename(s: string): string {
	return s
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 100)
		.trim();
}

/** "Smith - 2020 - Title" like Zotero's default attachment file name. */
export function baseNameFor(data: ZoteroItemData): string {
	const c = data.creators?.find((x) => x.creatorType === "author") ?? data.creators?.[0];
	const who = c ? c.lastName || c.name || "" : "";
	const m = typeof data.date === "string" ? data.date.match(/(?<!\d)(\d{4})(?!\d)/) : null;
	const parts = [who, m ? m[1] : "", typeof data.title === "string" ? data.title : ""].map((p) => p.trim()).filter(Boolean);
	return safeFilename(parts.join(" - ")) || "document";
}

export interface SaveDeps {
	db: Database;
	dataDir: string;
	bodies: BodyStore;
	/** item id of the run -> library key */
	keyOfItem: (item: number) => string | undefined;
	ezproxySuffix: string;
	/** called after the rows exist (text extraction and search indexing); never awaited by the save */
	afterSave?: (attachmentKey: string) => void;
}

export interface SaveReq {
	item: number;
	body: BodyRef;
	trim_prefix: number;
	version: string;
	url_to_store: string;
	route: string;
	source: string;
}

export function savePdf(deps: SaveDeps, req: SaveReq): { attachment_key: string; filename: string } {
	const { db, dataDir, bodies } = deps;
	const info = bodies.get(req.body.handle);
	if (!isStorableUrl(req.url_to_store, deps.ezproxySuffix)) throw new OpError("internal", "refusing to store a non-canonical URL");
	if (!info || info.kind !== "pdf" || !info.path) throw new OpError("internal", "the staged PDF is not a file-backed body");
	const parentKey = deps.keyOfItem(req.item);
	if (!parentKey) throw new OpError("parent_gone", "unknown item");
	const parentRow = db.query("SELECT data, deleted, library_id FROM items WHERE key = ? AND parent_key IS NULL").get(parentKey) as {
		data: string;
		deleted: number;
		library_id: number;
	} | null;
	if (!parentRow || parentRow.deleted) throw new OpError("parent_gone", "the parent item no longer exists");
	// the permission can change while a job runs, so it is checked again here, at save time
	try {
		assertFilesWritable(db, parentRow.library_id);
	} catch (e) {
		throw new OpError("not_editable", e instanceof Error ? e.message : "the library does not allow file changes");
	}
	const hasPdf = db
		.query(
			`SELECT 1 FROM items i JOIN attachments a ON a.item_key = i.key
			 WHERE i.parent_key = ? AND i.deleted = 0 AND a.content_type = 'application/pdf' AND a.link_mode <> 'linked_url'
			 AND (a.path IS NOT NULL)`,
		)
		.get(parentKey);
	if (hasPdf) throw new OpError("already_has_pdf", "the item already has a PDF attachment");

	const parent = JSON.parse(parentRow.data) as ZoteroItemData;
	try {
		const trim = Number(req.trim_prefix) || 0;
		if (trim > 0) {
			const bytes = readFileSync(info.path);
			for (let i = 0; i < PDF_MAGIC.length; i++)
				if (bytes[trim + i] !== PDF_MAGIC[i]) throw new OpError("internal", "trim_prefix does not point at %PDF-");
			writeFileSync(info.path, bytes.subarray(trim));
		}
		let key = generateKey();
		while (db.query("SELECT 1 FROM items WHERE key = ?").get(key)) key = generateKey();
		// The attachment storage folder (when the user chose one) takes the file like any new attachment: renamed, sorted into
		// its subfolder, a linked file, tagged. Otherwise it goes to <dataDir>/storage/<KEY>/ like Zotero.
		const plainName = `${baseNameFor(parent)}.pdf`;
		const target = storageTargetFor(db, { key, name: plainName, parentKey });
		const managed = target.custom;
		const dir = managed ? target.dir : join(dataDir, "storage", key);
		const dest = managed ? target.path : join(dir, plainName);
		const filename = basename(dest);
		mkdirSync(dir, { recursive: true });
		if (managed) {
			copyVerifiedSync(info.path, dest); // never overwrites: the target name is unique; the staged file goes once the copy is verified
			rmSync(info.path, { force: true });
		} else {
			try {
				renameSync(info.path, dest);
			} catch {
				copyFileSync(info.path, dest);
				rmSync(info.path, { force: true });
			}
		}
		if (target.copyTo) {
			try {
				mkdirSync(target.copyTo.dir, { recursive: true });
				copyVerifiedSync(dest, target.copyTo.path);
			} catch (e) {
				console.error("could not copy the full text PDF to the storage folder:", e instanceof Error ? e.message : e);
			}
		}
		const linked = managed && target.mode === "linked_file";
		const now = nowIso();
		const title = (managed && target.title) || (TITLES[req.version] ?? TITLES.published);
		const data: ZoteroItemData = {
			key,
			itemType: "attachment",
			parentItem: parentKey,
			linkMode: linked ? "linked_file" : "imported_url",
			title,
			accessDate: now,
			url: req.url_to_store,
			contentType: "application/pdf",
			charset: "",
			filename,
			tags: [],
			relations: {},
			dateAdded: now,
			dateModified: now,
		};
		if (linked) data.path = dest;
		const cols = deriveColumns(data);
		try {
			db.transaction(() => {
				db.query(
					`INSERT INTO items(key, item_type, parent_key, title, creators_summary, year, publication, data, date_added, date_modified)
					 VALUES(?, 'attachment', ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(key, parentKey, cols.title, cols.creators_summary, cols.year, cols.publication, JSON.stringify(data), now, now);
				db.query("INSERT INTO attachments(item_key, link_mode, content_type, path, url) VALUES(?, ?, 'application/pdf', ?, ?)").run(
					key,
					linked ? "linked_file" : "imported_url",
					linked ? storedFormForNewLink(db, dest) : dest,
					req.url_to_store,
				);
			})();
		} catch (e) {
			if (managed) rmSync(dest, { force: true });
			throw e;
		}
		if (managed && target.tag) {
			try {
				addTags(db, key, [target.tag]);
			} catch {
				/* the tag is a convenience */
			}
		}
		clearFileCache();
		bodies.release(req.body.handle); // the temp dir is empty now; nothing else to keep
		try {
			deps.afterSave?.(key);
		} catch {
			/* extraction is best effort */
		}
		return { attachment_key: key, filename };
	} catch (e) {
		bodies.release(req.body.handle);
		if (e instanceof OpError) throw e;
		throw new OpError("io", e instanceof Error ? e.message : String(e));
	}
}

export function pdfExists(path: string | null): boolean {
	return !!path && existsSync(path);
}
