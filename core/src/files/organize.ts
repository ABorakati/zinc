// The ZotMoov commands on selected items, on top of storage.ts:
//   move      attachment files go to the storage folder (subfolder pattern, rename, tag, linked or imported)
//   copy      copies go to the storage folder (or another folder); the attachments are not changed
//   to-stored linked files become stored files in zotero-next's own storage ("Convert linked to stored file")
//   attach newest: import the newest file of a folder (Downloads) as an attachment of an item, then take it out of that folder
// Each file is copied, checked (size and SHA-256) and recorded before the original is removed; a different file that is
// already at the destination is never overwritten (the new file gets a numbered name); a file another program has open is
// skipped.
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { addFile } from "../additems/files";
import type { ItemDetail } from "../api-types";
import { HttpError, patchItem } from "../db";
import { indexItem } from "../search";
import { isInside } from "../maintenance/erase";
import { resolveStoredPath } from "./paths";
import { cleanSegment } from "./pattern";
import {
	extAllowed,
	isFileLocked,
	isOnlineOnly,
	planRelocate,
	plannedName,
	runMove,
	storageView,
	type MovePlan,
	type MoveReport,
} from "./storage";

export type OrganizeAction = "move" | "copy" | "to-stored";

export interface OrganizeRequest {
	action: OrganizeAction;
	/** Items or attachments. An item stands for its attachments. */
	keys: string[];
	/** Another folder than the storage folder ("Move to folder…", "Copy to folder…"). */
	dir?: string;
	/** The collection the user is looking at (for the %c wildcard). */
	collectionKey?: string | null;
}

/** The attachment keys behind a selection: an attachment is itself, any other item stands for its (not trashed) attachments. */
export function attachmentKeysOf(db: Database, keys: string[]): string[] {
	const out = new Set<string>();
	for (const k of new Set(keys)) {
		const row = db.query("SELECT item_type FROM items WHERE key = ?").get(k) as { item_type: string } | null;
		if (!row) continue;
		if (row.item_type === "attachment") out.add(k);
		else
			for (const c of db
				.query("SELECT key FROM items WHERE parent_key = ? AND item_type = 'attachment' AND deleted = 0 ORDER BY date_added, key")
				.all(k) as { key: string }[])
				out.add(c.key);
	}
	return [...out];
}

export function planOrganize(db: Database, req: OrganizeRequest): MovePlan {
	const keys = attachmentKeysOf(db, req.keys);
	if (!keys.length) throw new HttpError(400, "none of the selected items has an attachment");
	if (req.dir !== undefined && (typeof req.dir !== "string" || !req.dir.trim())) throw new HttpError(400, "dir must be a folder path");
	if (req.dir && existsSync(req.dir) && !statSync(req.dir).isDirectory()) throw new HttpError(400, "that path is a file, not a folder");
	try {
		return planRelocate(db, {
			keys,
			dir: req.dir,
			collectionKey: req.collectionKey,
			...(req.action === "to-stored" ? { toOwn: true } : { behavior: req.action === "copy" ? "copy" : "move" }),
		});
	} catch (e) {
		throw new HttpError(400, e instanceof Error ? e.message : String(e));
	}
}

export async function runOrganize(db: Database, req: OrganizeRequest): Promise<MoveReport> {
	return runMove(db, planOrganize(db, req));
}

// ---------------------------------------------------------------- attach the newest file of a folder

/** Names of files that are not finished or not real content. */
const PARTIAL = /\.(crdownload|part|partial|tmp|download|opdownload|filepart)$/i;
const JUNK = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

export interface NewestFile {
	path: string;
	size: number;
	modified: string;
}

/** The most recently modified regular file of `dir` of an allowed type (never a download in progress, an Office lock file or an online-only placeholder). */
export function findNewestFile(dir: string, allowedExt: string[]): NewestFile | null {
	let best: { path: string; size: number; ms: number } | null = null;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (!e.isFile()) continue;
		const name = e.name;
		if (name.startsWith(".") || name.startsWith("~$") || JUNK.has(name.toLowerCase()) || PARTIAL.test(name)) continue;
		if (!extAllowed(name, allowedExt)) continue;
		const path = join(dir, name);
		let st;
		try {
			st = statSync(path);
		} catch {
			continue;
		}
		if (st.size === 0 || isOnlineOnly(path)) continue;
		if (!best || st.mtimeMs > best.ms) best = { path, size: st.size, ms: st.mtimeMs };
	}
	return best ? { path: best.path, size: best.size, modified: new Date(best.ms).toISOString() } : null;
}

export interface AttachNewestRequest {
	parentKey: string;
	/** File name (with or without the extension) to use instead of the proposed one. */
	name?: string;
	/** Only report which file would be attached and under which name. */
	preview?: boolean;
}

export interface AttachNewestPreview {
	source: string;
	size: number;
	modified: string;
	/** The file name it would get in the storage folder. */
	proposedName: string;
	dir: string;
}

export interface AttachNewestResult extends AttachNewestPreview {
	attachment: ItemDetail;
	/** The original was taken out of the folder once the copy was verified. */
	sourceRemoved: boolean;
	note?: string;
}

function newestFor(db: Database, parentKey: string): { file: NewestFile; dir: string; proposed: string; renamed: boolean } {
	const s = storageView(db);
	if (!s.attachDir) throw new HttpError(400, "choose the folder to attach files from first (Settings > Files and folders)");
	const dir = resolve(s.attachDir);
	if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new HttpError(404, `${dir} is not a folder`);
	const parent = db.query("SELECT item_type, parent_key FROM items WHERE key = ? AND deleted = 0").get(parentKey) as {
		item_type: string;
		parent_key: string | null;
	} | null;
	if (!parent) throw new HttpError(404, "item not found");
	if (parent.parent_key || parent.item_type === "attachment" || parent.item_type === "note")
		throw new HttpError(400, "choose a regular top-level item");
	const file = findNewestFile(dir, s.allowedExt);
	if (!file)
		throw new HttpError(404, `no file to attach in ${dir}${s.allowedExt.length ? ` (allowed types: ${s.allowedExt.join(", ")})` : ""}`);
	const p = plannedName(db, s, basename(file.path), parentKey);
	return { file, dir, proposed: p.name, renamed: p.renamed };
}

export function previewAttachNewest(db: Database, parentKey: string): AttachNewestPreview {
	const n = newestFor(db, parentKey);
	return { source: n.file.path, size: n.file.size, modified: n.file.modified, proposedName: n.proposed, dir: n.dir };
}

export function attachNewest(db: Database, req: AttachNewestRequest): AttachNewestResult {
	const s = storageView(db);
	const n = newestFor(db, req.parentKey);
	const source = n.file.path;
	if (isFileLocked(source)) throw new HttpError(409, "the newest file is open in another program (is it still downloading?)");
	const ext = extname(source);
	let name = n.proposed;
	let renamed = n.renamed;
	if (req.name !== undefined && req.name.trim()) {
		const base = cleanSegment(
			req.name.trim().toLowerCase().endsWith(ext.toLowerCase()) ? req.name.trim().slice(0, -ext.length) : req.name.trim(),
			150,
		);
		if (!base) throw new HttpError(400, "that is not a usable file name");
		name = base + ext;
		renamed = name !== basename(source);
	}
	// A verified copy goes into the storage folder (or zotero-next's storage when no folder is set or the type is not allowed)...
	const detail = addFile(db, { mode: "imported_file", path: source, parentKey: req.parentKey, name, forceStorage: true, keepName: true });
	const stored = detail.data.filename ?? name;
	if (renamed && s.renameTitle && detail.data.linkMode === "linked_file") {
		patchItem(db, detail.data.key, { title: stored });
		indexItem(db, detail.data.key);
	}
	const result: AttachNewestResult = {
		attachment: detail,
		source,
		size: n.file.size,
		modified: n.file.modified,
		proposedName: name,
		dir: n.dir,
		sourceRemoved: false,
	};
	// ...and only then does the original leave the folder it was downloaded to.
	const copy = resolveStoredPath(
		db,
		(db.query("SELECT path FROM attachments WHERE item_key = ?").get(detail.data.key) as { path: string } | null)?.path,
	);
	if (s.dir && isInside(source, s.dir)) {
		result.note = "the file already was in the storage folder";
		return result;
	}
	try {
		if (!copy || !existsSync(copy)) throw new Error("the stored copy could not be found");
		rmSync(source, { force: true });
		result.sourceRemoved = true;
	} catch (e) {
		result.note = `the original stays in ${n.dir}: ${e instanceof Error ? e.message : String(e)}`;
	}
	return result;
}
