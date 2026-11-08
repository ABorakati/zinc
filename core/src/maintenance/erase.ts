// Permanent deletion of items (the Trash's "Empty Trash" / "Delete Permanently").
// Everything goes through normal table writes, so the sync triggers record the deletes in sync_outbox.

import type { Database } from "bun:sqlite";
import { assertItemWritable } from "../libraries";
import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { deleteManagedFiles, managedLinkedFiles } from "../files/cleanup";
import { indexItem } from "../search";

/** True when `file` is strictly inside `dir` (path comparison only; case-insensitive on Windows). */
export function isInside(file: string, dir: string): boolean {
	let rel = relative(resolve(dir), resolve(file));
	if (process.platform === "win32") rel = relative(resolve(dir).toLowerCase(), resolve(file).toLowerCase());
	return rel !== "" && !rel.startsWith("..") && !rel.includes(`..${sep}`) && !/^[a-zA-Z]:/.test(rel) && !rel.startsWith(sep);
}

export interface EraseReport {
	/** Items removed, including child attachments and notes. */
	erased: number;
	topLevel: number;
	/** Imported attachment files removed from zotero-next's own storage. */
	filesRemoved: number;
	/** Files left alone (outside zotero-next's storage, linked, ...). */
	filesKept: number;
	/** Linked files deleted from the attachment storage folder (only with "delete files with their items" on). */
	linkedFilesRemoved?: number;
	/** Requested keys that do not exist. */
	missing: string[];
}

/** Keys plus all their descendants (child attachments, notes, nested). */
export function withDescendants(db: Database, keys: string[]): string[] {
	const all = new Set<string>();
	for (let i = 0; i < keys.length; i += 500) {
		const chunk = keys.slice(i, i + 500);
		const rows = db
			.query(
				`WITH RECURSIVE d(key) AS (
					SELECT key FROM items WHERE key IN (${chunk.map(() => "?").join(",")})
					UNION SELECT i.key FROM items i JOIN d ON i.parent_key = d.key
				) SELECT key FROM d`,
			)
			.all(...chunk) as { key: string }[];
		for (const r of rows) all.add(r.key);
	}
	return [...all];
}

export function eraseItems(db: Database, requested: string[], ownStorageDir: string | null): EraseReport {
	const keys = [...new Set(requested)];
	for (const k of keys) assertItemWritable(db, k); // a read-only library's items are not erased
	const all = withDescendants(db, keys);
	const existing = new Set(
		keys.length ? (db.query(`SELECT key FROM items WHERE key IN (${keys.map(() => "?").join(",")})`).all(...keys) as { key: string }[]).map((r) => r.key) : [],
	);
	const missing = keys.filter((k) => !existing.has(k));
	if (all.length === 0) return { erased: 0, topLevel: 0, filesRemoved: 0, filesKept: 0, missing };

	const ph = (n: number) => Array(n).fill("?").join(",");
	// Files first (collected before rows vanish); deleted after the DB commit succeeds.
	const files: string[] = [];
	let filesKept = 0;
	for (let i = 0; i < all.length; i += 500) {
		const chunk = all.slice(i, i + 500);
		const rows = db
			.query(`SELECT link_mode, path FROM attachments WHERE item_key IN (${ph(chunk.length)})`)
			.all(...chunk) as { link_mode: string; path: string | null }[];
		for (const r of rows) {
			if (!r.path) continue;
			if (r.link_mode.startsWith("imported_") && ownStorageDir && isInside(r.path, ownStorageDir)) files.push(r.path);
			else filesKept++;
		}
	}
	const managed = managedLinkedFiles(db, all); // linked files in the storage folder, when the user wants them deleted too
	const parents = new Set<string>();
	db.transaction(() => {
		const inSet = new Set(all);
		for (let i = 0; i < all.length; i += 500) {
			const chunk = all.slice(i, i + 500);
			const p = ph(chunk.length);
			for (const r of db.query(`SELECT parent_key FROM items WHERE key IN (${p}) AND parent_key IS NOT NULL`).all(...chunk) as { parent_key: string }[]) {
				if (!inSet.has(r.parent_key)) parents.add(r.parent_key);
			}
			const rowids = (db.query(`SELECT rowid FROM items WHERE key IN (${p})`).all(...chunk) as { rowid: number }[]).map((r) => r.rowid);
			if (rowids.length) db.query(`DELETE FROM search WHERE rowid IN (${ph(rowids.length)})`).run(...rowids);
			// Explicit child rows first so each delete is recorded by its own trigger.
			db.query(`DELETE FROM annotations WHERE attachment_key IN (${p})`).run(...chunk);
			db.query(`DELETE FROM view_state WHERE attachment_key IN (${p})`).run(...chunk);
			db.query(`DELETE FROM fulltext WHERE attachment_key IN (${p})`).run(...chunk);
			db.query(`DELETE FROM attachments WHERE item_key IN (${p})`).run(...chunk);
			db.query(`DELETE FROM item_tags WHERE item_key IN (${p})`).run(...chunk);
			db.query(`DELETE FROM collection_items WHERE item_key IN (${p})`).run(...chunk);
		}
		// Children before parents (deepest first) so nothing relies on cascade order.
		const depth = new Map<string, number>();
		const parentOf = new Map<string, string | null>();
		for (let i = 0; i < all.length; i += 500) {
			const chunk = all.slice(i, i + 500);
			for (const r of db.query(`SELECT key, parent_key FROM items WHERE key IN (${ph(chunk.length)})`).all(...chunk) as { key: string; parent_key: string | null }[]) parentOf.set(r.key, r.parent_key);
		}
		const d = (k: string): number => {
			if (depth.has(k)) return depth.get(k)!;
			const p = parentOf.get(k);
			const v = p && parentOf.has(p) ? d(p) + 1 : 0;
			depth.set(k, v);
			return v;
		};
		for (const k of [...all].sort((a, b) => d(b) - d(a))) db.query("DELETE FROM items WHERE key = ?").run(k);
		// The cleanup deletes above fire "item upsert" triggers for items that no longer exist; drop those, keep 'delete'.
		for (let i = 0; i < all.length; i += 500) {
			const chunk = all.slice(i, i + 500);
			db.query(`DELETE FROM sync_outbox WHERE type = 'item' AND op <> 'delete' AND key IN (${ph(chunk.length)})`).run(...chunk);
		}
		for (const p of parents) indexItem(db, p);
	})();

	let filesRemoved = 0;
	const dirs = new Set<string>();
	for (const f of files) {
		try {
			if (existsSync(f)) {
				rmSync(f, { force: true });
				filesRemoved++;
			}
			dirs.add(dirname(f));
		} catch {
			filesKept++;
		}
	}
	for (const dir of dirs) {
		try {
			if (ownStorageDir && isInside(dir, ownStorageDir) && readdirSync(dir).length === 0) rmdirSync(dir);
		} catch {
			/* leave it */
		}
	}
	let linkedFilesRemoved: number | undefined;
	if (managed?.length) {
		try {
			linkedFilesRemoved = deleteManagedFiles(db, managed).removed;
			filesKept = Math.max(0, filesKept - linkedFilesRemoved);
		} catch {
			/* the rows are gone; a file that stays is harmless */
		}
	}
	const topLevel = keys.filter((k) => existing.has(k)).length;
	return { erased: all.length, topLevel, filesRemoved, filesKept, ...(linkedFilesRemoved !== undefined ? { linkedFilesRemoved } : {}), missing };
}

/** Top-level keys of everything in the trash (optionally only items trashed at least `olderThanDays` ago). */
export function trashedKeys(db: Database, olderThanDays?: number, libraryId = 1): string[] {
	const args: unknown[] = [libraryId];
	let where = "deleted = 1 AND library_id = ?";
	if (olderThanDays && olderThanDays > 0) {
		where += " AND date_modified <= ?";
		args.push(new Date(Date.now() - olderThanDays * 86400_000).toISOString().replace(/\.\d+Z$/, "Z"));
	}
	const rows = db.query(`SELECT key, parent_key FROM items WHERE ${where}`).all(...(args as never[])) as { key: string; parent_key: string | null }[];
	// A trashed child of a trashed parent is covered by the parent.
	const set = new Set(rows.map((r) => r.key));
	return rows.filter((r) => !r.parent_key || !set.has(r.parent_key)).map((r) => r.key);
}

export function trashCounts(db: Database, olderThanDays?: number, libraryId = 1): { items: number; total: number } {
	const keys = trashedKeys(db, olderThanDays, libraryId);
	return { items: keys.length, total: withDescendants(db, keys).length };
}
