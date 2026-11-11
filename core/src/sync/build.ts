// Push side: turn the outbox into ZoteroWrite[] from the current zotero-next state.

import type { Database } from "bun:sqlite";
import { existsSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import { nowIso } from "../db";
import { resolveStoredPath } from "../files/paths";
import { BASELINE_CHANGED, type EntityType, type ZoteroJson, type ZoteroWrite, type ZoteroWriteResult } from "./protocol";

export interface Group {
	type: EntityType;
	key: string;
	maxSeq: number;
	ops: Set<string>;
}

export interface PushPlan {
	writes: ZoteroWrite[];
	groups: Group[]; // outbox groups that produced writes
	dropped: Group[]; // groups with nothing to write (created and erased before ever reaching Zotero)
	base: Map<string, string>; // `${type}:${key}` -> dateModified to record in sync_base after success
	baseRemove: Set<string>; // `${type}:${key}` erased in Zotero
	files: Map<string, string>; // attachment key -> local path that was handed to the writer
}

/** The queued changes of one library (My Library by default: the local-Zotero sync never sees a group's changes). */
export function readGroups(db: Database, libraryId = 1): Group[] {
	const rows = db.query("SELECT seq, type, key, op FROM sync_outbox WHERE library_id = ? ORDER BY seq").all(libraryId) as {
		seq: number;
		type: EntityType;
		key: string;
		op: string;
	}[];
	const map = new Map<string, Group>();
	for (const r of rows) {
		const id = `${r.type}:${r.key}`;
		let g = map.get(id);
		if (!g) map.set(id, (g = { type: r.type, key: r.key, maxSeq: 0, ops: new Set() }));
		g.maxSeq = Math.max(g.maxSeq, r.seq);
		g.ops.add(r.op);
	}
	return [...map.values()];
}

export function pendingCount(db: Database, libraryId = 1): number {
	return (db.query("SELECT count(*) AS n FROM (SELECT 1 FROM sync_outbox WHERE library_id = ? GROUP BY type, key)").get(libraryId) as { n: number }).n;
}

/** A path with its symbolic links resolved when it exists, else as given (resolved). */
const real = (p: string): string => {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
};

/**
 * True when `file` lies inside `dir`, compared as real paths: on macOS the temp folder /var/... is /private/var/..., and SQLite reports
 * the second form, so a plain resolve() took Zinc's own stored copy for a file outside storage and kept it (found by the macOS CI job).
 * A link inside `dir` that points outside it is outside.
 */
export function isInside(file: string, dir: string): boolean {
	const rel = relative(real(dir), real(file));
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

interface ItemRow {
	key: string;
	parent_key: string | null;
	item_type: string;
	data: string;
	date_modified: string;
	deleted: number;
}

function depth(db: Database, table: "items" | "collections", key: string): number {
	let d = 0;
	let cur: string | null = key;
	for (let i = 0; i < 64 && cur; i++) {
		const r = db.query(`SELECT parent_key FROM ${table} WHERE key = ?`).get(cur) as { parent_key: string | null } | null;
		cur = r?.parent_key ?? null;
		if (cur) d++;
	}
	return d;
}

export function buildPush(db: Database, dataDir: string, libraryId = 1): PushPlan {
	const plan: PushPlan = { writes: [], groups: [], dropped: [], base: new Map(), baseRemove: new Set(), files: new Map() };
	const storageDir = join(dataDir, "storage");
	const hasBase = db.query("SELECT 1 FROM sync_base WHERE type = ? AND key = ?");
	const baseQ = db.query("SELECT date_modified FROM sync_base WHERE type = ? AND key = ?");
	const baseOf = (type: string, key: string): string | undefined => (baseQ.get(type, key) as { date_modified: string } | null)?.date_modified || undefined;
	const upserts: { rank: number; sort: number; writes: ZoteroWrite[] }[] = [];
	const erases: { rank: number; sort: number; write: ZoteroWrite }[] = [];

	for (const g of readGroups(db, libraryId)) {
		const id = `${g.type}:${g.key}`;
		if (g.type === "item") {
			const row = db.query("SELECT key, parent_key, item_type, data, date_modified, deleted FROM items WHERE key = ?").get(g.key) as ItemRow | null;
			if (!row) {
				if (!hasBase.get("item", g.key)) plan.dropped.push(g);
				else {
					plan.groups.push(g);
					erases.push({ rank: 1, sort: 0, write: { type: "item", op: "erase", key: g.key } });
					plan.baseRemove.add(id);
				}
				continue;
			}
			const data = JSON.parse(row.data) as ZoteroJson;
			data.key = row.key;
			data.dateModified = row.date_modified;
			data.tags = (db.query("SELECT tag, type FROM item_tags WHERE item_key = ? ORDER BY tag").all(row.key) as { tag: string; type: number }[]).map(
				(t) => (t.type ? { tag: t.tag, type: t.type } : { tag: t.tag }),
			);
			if (row.parent_key) {
				data.parentItem = row.parent_key;
				delete data.collections;
			} else {
				delete data.parentItem;
				data.collections = (
					db.query("SELECT collection_key FROM collection_items WHERE item_key = ? ORDER BY collection_key").all(row.key) as {
						collection_key: string;
					}[]
				).map((r) => r.collection_key);
			}
			if (row.deleted) data.deleted = 1;
			else delete data.deleted;
			const write: ZoteroWrite = { type: "item", op: "upsert", key: row.key, data };
			const base = baseOf("item", row.key);
			if (base) write.baseline = base;
			if (row.item_type === "attachment") {
				const att = db.query("SELECT link_mode, content_type, path FROM attachments WHERE item_key = ?").get(row.key) as {
					link_mode: string;
					content_type: string | null;
					path: string | null;
				} | null;
				// Zotero expects an absolute path in data.path (its writer relativises it against Zotero's own base directory)
				if (att?.path && att.link_mode === "linked_file") data.path = resolveStoredPath(db, att.path) ?? data.path;
				if (att?.path && att.link_mode.startsWith("imported_") && existsSync(att.path) && !isInside(att.path, storageDir)) {
					const filename = basename(att.path);
					data.filename = filename;
					write.file = {
						path: att.path,
						filename,
						contentType: att.content_type || (typeof data.contentType === "string" && data.contentType) || "application/octet-stream",
					};
					plan.files.set(row.key, att.path);
				}
			}
			const writes: ZoteroWrite[] = [write];
			if (row.deleted) writes.push({ type: "item", op: "trash", key: row.key });
			else if (g.ops.has("restore")) writes.push({ type: "item", op: "restore", key: row.key });
			upserts.push({ rank: 1, sort: depth(db, "items", row.key), writes });
			plan.groups.push(g);
			plan.base.set(id, row.date_modified);
		} else if (g.type === "collection") {
			const row = db.query("SELECT key, name, parent_key FROM collections WHERE key = ?").get(g.key) as {
				key: string;
				name: string;
				parent_key: string | null;
			} | null;
			if (!row) {
				if (!hasBase.get("collection", g.key)) plan.dropped.push(g);
				else {
					plan.groups.push(g);
					erases.push({ rank: 2, sort: 0, write: { type: "collection", op: "erase", key: g.key } });
					plan.baseRemove.add(id);
				}
				continue;
			}
			upserts.push({
				rank: 0,
				sort: depth(db, "collections", row.key),
				writes: [{ type: "collection", op: "upsert", key: row.key, data: { key: row.key, name: row.name, parentCollection: row.parent_key ?? false, relations: {} } }],
			});
			plan.groups.push(g);
			plan.base.set(id, nowIso());
		} else {
			const row = db.query("SELECT key, attachment_key, data, date_modified FROM annotations WHERE key = ?").get(g.key) as {
				key: string;
				attachment_key: string;
				data: string;
				date_modified: string;
			} | null;
			if (!row) {
				if (!hasBase.get("annotation", g.key)) plan.dropped.push(g);
				else {
					plan.groups.push(g);
					erases.push({ rank: 0, sort: 0, write: { type: "annotation", op: "erase", key: g.key } });
					plan.baseRemove.add(id);
				}
				continue;
			}
			const data = { ...(JSON.parse(row.data) as ZoteroJson), key: row.key, parentItem: row.attachment_key };
			const annBase = baseOf("annotation", row.key);
			upserts.push({ rank: 2, sort: 0, writes: [{ type: "annotation", op: "upsert", key: row.key, data, ...(annBase ? { baseline: annBase } : {}) }] });
			plan.groups.push(g);
			plan.base.set(id, row.date_modified);
		}
	}
	// collections, then items (parents first), then annotations; erases last (annotations, items, collections)
	upserts.sort((a, b) => a.rank - b.rank || a.sort - b.sort);
	erases.sort((a, b) => a.rank - b.rank);
	for (const u of upserts) plan.writes.push(...u.writes);
	for (const e of erases) plan.writes.push(e.write);
	return plan;
}

/** Outcome of applying a plan's results to the zotero-next database. */
export interface Completion {
	done: number;
	failed: { key: string; error: string }[];
}

export function completePush(db: Database, plan: PushPlan, results: ZoteroWriteResult[], ownStorageDir: string | null): Completion {
	const failedKeys = new Map<string, string>();
	const pathByKey = new Map<string, string>();
	for (const r of results) {
		if (!r.ok) failedKeys.set(r.key, r.error ?? "write failed");
		else if (r.path) pathByKey.set(r.key, r.path);
	}
	const out: Completion = { done: 0, failed: [] };
	const handoffs: { key: string; oldPath: string }[] = [];
	db.transaction(() => {
		db.run("INSERT OR IGNORE INTO sync_flags(name) VALUES('suppress')");
		try {
			for (const g of plan.groups) {
				const err = failedKeys.get(g.key);
				if (err !== undefined) {
					out.failed.push({ key: g.key, error: err });
					if (err.startsWith(BASELINE_CHANGED)) {
						// Zotero's copy was left alone: the local change stays queued, and the user can see what was held back
						const t = g.type === "item" ? "items" : g.type === "annotation" ? "annotations" : null;
						const r = t ? (db.query(`SELECT data FROM ${t} WHERE key = ?`).get(g.key) as { data: string } | null) : null;
						db.query("INSERT INTO sync_conflicts(type, key, local, remote, resolved) VALUES(?, ?, ?, ?, 'remote')").run(
							g.type,
							g.key,
							r ? r.data : null,
							JSON.stringify({ note: "Zotero changed this after the last sync; the local change was not written" }),
						);
					}
					continue;
				}
				db.query("DELETE FROM sync_outbox WHERE type = ? AND key = ? AND seq <= ?").run(g.type, g.key, g.maxSeq);
				const id = `${g.type}:${g.key}`;
				const dm = plan.base.get(id);
				if (dm) db.query("INSERT OR REPLACE INTO sync_base(type, key, date_modified) VALUES(?, ?, ?)").run(g.type, g.key, dm);
				if (plan.baseRemove.has(id)) db.query("DELETE FROM sync_base WHERE type = ? AND key = ?").run(g.type, g.key);
				const newPath = pathByKey.get(g.key);
				const oldPath = plan.files.get(g.key);
				if (newPath && oldPath) {
					db.query("UPDATE attachments SET path = ? WHERE item_key = ?").run(newPath, g.key);
					handoffs.push({ key: g.key, oldPath });
				}
				out.done++;
			}
			for (const g of plan.dropped) db.query("DELETE FROM sync_outbox WHERE type = ? AND key = ? AND seq <= ?").run(g.type, g.key, g.maxSeq);
		} finally {
			db.run("DELETE FROM sync_flags WHERE name = 'suppress'");
		}
	})();
	// Zotero now has its own copy: drop zotero-next's (only files inside zotero-next's own storage).
	for (const h of handoffs) {
		const newPath = pathByKey.get(h.key);
		if (!ownStorageDir || !newPath || resolve(newPath) === resolve(h.oldPath) || !isInside(h.oldPath, ownStorageDir)) continue;
		try {
			rmSync(h.oldPath, { force: true });
			const dir = dirname(h.oldPath);
			if (isInside(dir, ownStorageDir)) rmdirSync(dir); // only succeeds when empty
		} catch {
			// not empty or already gone
		}
	}
	return out;
}
