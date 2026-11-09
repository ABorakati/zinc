// Pull side: apply changes read from Zotero into the zotero-next database.
// Everything happens in one transaction with the 'suppress' flag set so triggers stay quiet.

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ZoteroItemData } from "../api-types";
import { deriveColumns, nowIso } from "../db";
import { storedFormForNewLink } from "../files/paths";
import { indexItem } from "../search";
import type { EntityType, ZoteroJson } from "./protocol";

export interface RemoteChanges {
	upserts: { type: EntityType; key: string; data: ZoteroJson; dateModified: string }[];
	deletes: { type: EntityType; key: string }[];
}

export interface ApplyReport {
	applied: number;
	skipped: number;
	conflicts: number;
	deleted: number;
	/** Objects whose key is already used by another library in this file (skipped, never merged). Absent when none. */
	collisions?: number;
	/**
	 * Objects that could not be applied and are not in the database at all afterwards (a parent that is not here yet, an
	 * object that threw). Callers keep them out of their checkpoint and fetch them again. Absent when none.
	 */
	failed?: { type: EntityType; key: string }[];
}

/** Milliseconds for Zotero's "YYYY-MM-DD HH:MM:SS" (UTC) and ISO timestamps; 0 when unparseable. */
export function ms(s: unknown): number {
	if (typeof s !== "string" || !s) return 0;
	let t = s.trim();
	if (/^\d{4}-\d{2}-\d{2} \d/.test(t)) t = t.replace(" ", "T");
	if (/T/.test(t) && !/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(t)) t += "Z";
	const v = Date.parse(t);
	return Number.isNaN(v) ? 0 : v;
}

function stable(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
	if (v && typeof v === "object") {
		const o = v as Record<string, unknown>;
		return `{${Object.keys(o)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(v);
}

const IGNORED = new Set(["dateModified", "version", "key", "deleted", "synced"]);

/** True when two versions of an object differ only in bookkeeping fields. */
export function sameContent(a: unknown, b: unknown): boolean {
	const strip = (v: unknown) => {
		if (!v || typeof v !== "object" || Array.isArray(v)) return v;
		const o: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!IGNORED.has(k)) o[k] = x;
		// tags / collections order carries no meaning
		for (const k of ["tags", "collections"]) if (Array.isArray(o[k])) o[k] = (o[k] as unknown[]).map(stable).sort();
		return o;
	};
	return stable(strip(a)) === stable(strip(b));
}

const ABS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

function localInPublications(db: Database, key: string): boolean {
	const r = db.query("SELECT json_extract(data, '$.inPublications') AS p FROM items WHERE key = ?").get(key) as { p: unknown } | null;
	return !!r?.p;
}

function attachmentPath(dataDir: string, key: string, data: ZoteroJson, existing: string | null): string | null {
	const linkMode = String(data.linkMode ?? "");
	if (linkMode === "linked_url") return null;
	const raw = typeof data.path === "string" ? data.path : "";
	if (linkMode === "linked_file") return ABS_PATH.test(raw) ? raw : existing;
	let filename = typeof data.filename === "string" ? data.filename : "";
	if (!filename && raw.startsWith("storage:")) filename = raw.slice("storage:".length);
	// the name comes from the server: a path separator or ".." would point outside storage/<key>/
	if (filename && filename !== "." && filename !== ".." && !/[\\/\0]/.test(filename)) {
		const candidate = join(dataDir, "storage", key, filename);
		if (existsSync(candidate)) return candidate;
	}
	return existing;
}

interface Ctx {
	db: Database;
	/** The library every object of this batch belongs to (1 = My Library). */
	libraryId: number;
	dataDir: string;
	report: ApplyReport;
	reindex: Set<string>; // top-level item keys to re-index
	unindex: number[]; // search rowids of removed top-level items
	batchItems: Set<string>;
	batchCollections: Set<string>;
	/** parentItem of each item in this batch (null = top level) */
	batchParent: Map<string, string | null>;
}

/** Keys come from the server and end up in file paths and SQL parameters: Zotero keys are 8 letters/digits, allow a little more. */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const validKey = (k: unknown): k is string => typeof k === "string" && SAFE_KEY.test(k);

/** One bad object (wrong types, an unexpected shape) is skipped on its own savepoint; it must not abort the whole pull. */
function safely(c: Ctx, f: () => void): void {
	try {
		c.db.transaction(f)();
	} catch {
		c.report.skipped++;
	}
}

/**
 * Keys are unique across the whole file (every table points at items by key alone). A pull that meets a key which another
 * library already uses skips that object and counts it, so one library can never overwrite another's data.
 */
function collides(c: Ctx, table: "items" | "collections", key: string): boolean {
	const r = c.db.query(`SELECT library_id AS lib FROM ${table} WHERE key = ?`).get(key) as { lib: number } | null;
	if (!r || r.lib === c.libraryId) return false;
	c.report.skipped++;
	c.report.collisions = (c.report.collisions ?? 0) + 1;
	return true;
}

/** Break parent loops among the collections of this batch: the collection that closes a loop becomes top level. */
function breakCollectionLoops(c: Ctx): void {
	const db = c.db;
	db.run("UPDATE collections SET parent_key = NULL WHERE parent_key IS NOT NULL AND parent_key NOT IN (SELECT key FROM collections)");
	for (const start of c.batchCollections) {
		const seen = new Set<string>();
		let cur: string | null = start;
		while (cur) {
			if (seen.has(cur)) {
				db.query("UPDATE collections SET parent_key = NULL WHERE key = ?").run(start);
				break;
			}
			seen.add(cur);
			cur = (db.query("SELECT parent_key FROM collections WHERE key = ?").get(cur) as { parent_key: string | null } | null)?.parent_key ?? null;
		}
	}
}

function setBase(db: Database, type: string, key: string, dm: string): void {
	db.query("INSERT OR REPLACE INTO sync_base(type, key, date_modified) VALUES(?, ?, ?)").run(type, key, dm);
}

function hasOutbox(db: Database, type: string, key: string): boolean {
	return !!db.query("SELECT 1 FROM sync_outbox WHERE type = ? AND key = ? LIMIT 1").get(type, key);
}

function clearOutbox(db: Database, type: string, key: string): void {
	db.query("DELETE FROM sync_outbox WHERE type = ? AND key = ?").run(type, key);
}

function baseMs(db: Database, type: string, key: string): number {
	const r = db.query("SELECT date_modified FROM sync_base WHERE type = ? AND key = ?").get(type, key) as { date_modified: string } | null;
	return r ? ms(r.date_modified) : 0;
}

function recordConflict(db: Database, type: string, key: string, local: unknown, remote: unknown, resolved: "local" | "remote"): void {
	db.query("INSERT INTO sync_conflicts(type, key, local, remote, resolved) VALUES(?, ?, ?, ?, ?)").run(
		type,
		key,
		local === null ? null : JSON.stringify(local),
		remote === null ? null : JSON.stringify(remote),
		resolved,
	);
}

function localSnapshot(db: Database, type: EntityType, key: string): { json: unknown; ms: number } | null {
	if (type === "item") {
		const r = db.query("SELECT data, date_modified FROM items WHERE key = ?").get(key) as { data: string; date_modified: string } | null;
		return r ? { json: JSON.parse(r.data), ms: ms(r.date_modified) } : null;
	}
	if (type === "annotation") {
		const r = db.query("SELECT data, date_modified FROM annotations WHERE key = ?").get(key) as { data: string; date_modified: string } | null;
		return r ? { json: JSON.parse(r.data), ms: ms(r.date_modified) } : null;
	}
	const r = db.query("SELECT key, name, parent_key FROM collections WHERE key = ?").get(key) as {
		key: string;
		name: string;
		parent_key: string | null;
	} | null;
	if (!r) return null;
	const at = db.query("SELECT max(at) AS at FROM sync_outbox WHERE type = 'collection' AND key = ?").get(key) as { at: string | null };
	return { json: { key: r.key, name: r.name, parentCollection: r.parent_key ?? false }, ms: ms(at.at) };
}

/**
 * Decide what to do with one remote upsert. 'apply' writes it; 'skip' keeps the local version.
 * Conflicts (both sides changed since sync_base): the newer dateModified wins, the loser is recorded.
 */
function decide(c: Ctx, type: EntityType, key: string, data: ZoteroJson, remoteMs: number): "apply" | "skip" {
	const db = c.db;
	if (!hasOutbox(db, type, key)) return "apply";
	const base = baseMs(db, type, key);
	if (base > 0 && remoteMs <= base) return "skip"; // Zotero did not change it: our edit stays queued
	const local = localSnapshot(db, type, key);
	if (!local) {
		// we erased it locally while Zotero changed it: Zotero's version wins unless the erase is newer
		const at = db.query("SELECT max(at) AS at FROM sync_outbox WHERE type = ? AND key = ?").get(type, key) as { at: string | null };
		if (ms(at.at) > remoteMs) {
			recordConflict(db, type, key, null, data, "local");
			c.report.conflicts++;
			setBase(db, type, key, nowIso());
			return "skip";
		}
		recordConflict(db, type, key, null, data, "remote");
		c.report.conflicts++;
		clearOutbox(db, type, key);
		return "apply";
	}
	if (sameContent(local.json, data)) {
		clearOutbox(db, type, key);
		return "apply";
	}
	c.report.conflicts++;
	if (remoteMs > local.ms) {
		recordConflict(db, type, key, local.json, data, "remote");
		clearOutbox(db, type, key);
		return "apply";
	}
	recordConflict(db, type, key, local.json, data, "local");
	return "skip";
}

function refreshCollectionsJson(db: Database, itemKey: string): void {
	const rows = db.query("SELECT collection_key FROM collection_items WHERE item_key = ? ORDER BY collection_key").all(itemKey) as {
		collection_key: string;
	}[];
	// membership changed, the item's own dateModified did not
	db.query("UPDATE items SET data = json_set(data, '$.collections', json(?)) WHERE key = ?").run(
		JSON.stringify(rows.map((r) => r.collection_key)),
		itemKey,
	);
}

function upsertCollection(c: Ctx, key: string, data: ZoteroJson, dm: string): void {
	const db = c.db;
	if (collides(c, "collections", key)) return;
	const remoteMs = ms(dm);
	if (decide(c, "collection", key, data, remoteMs) === "skip") {
		c.report.skipped++;
		if (hasOutbox(db, "collection", key)) setBase(db, "collection", key, dm || nowIso());
		return;
	}
	const name = typeof data.name === "string" ? data.name : "";
	let parent = typeof data.parentCollection === "string" && data.parentCollection ? data.parentCollection : null;
	if (parent && parent !== key && !c.batchCollections.has(parent) && !db.query("SELECT 1 FROM collections WHERE key = ? AND library_id = ?").get(parent, c.libraryId)) parent = null;
	if (parent === key) parent = null;
	const version = typeof data.version === "number" ? data.version : 0;
	db.query(
		`INSERT INTO collections(key, name, parent_key, version, library_id) VALUES(?, ?, ?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET name = excluded.name, parent_key = excluded.parent_key, version = excluded.version`,
	).run(key, name, parent, version, c.libraryId);
	setBase(db, "collection", key, dm || nowIso());
	c.report.applied++;
}

function upsertItem(c: Ctx, key: string, data: ZoteroJson, dm: string): void {
	const db = c.db;
	if (collides(c, "items", key)) return;
	const parent = typeof data.parentItem === "string" && data.parentItem ? data.parentItem : null;
	if (parent && !c.batchItems.has(parent) && !db.query("SELECT 1 FROM items WHERE key = ? AND library_id = ?").get(parent, c.libraryId)) {
		c.report.skipped++; // parent unknown in this library
		return;
	}
	// children hang off top-level items only: not off themselves, and not off another child (that also rules out loops)
	if (parent) {
		const parentsParent = c.batchParent.has(parent)
			? c.batchParent.get(parent)
			: (db.query("SELECT parent_key FROM items WHERE key = ?").get(parent) as { parent_key: string | null } | null)?.parent_key;
		// an item that already has children cannot become a child itself (their parent would be a child)
		const hasChildren = !!db.query("SELECT 1 FROM items WHERE parent_key = ? LIMIT 1").get(key);
		if (parent === key || parentsParent || hasChildren) {
			c.report.skipped++;
			return;
		}
	}
	const modified = (typeof data.dateModified === "string" && data.dateModified) || dm || nowIso();
	const remoteMs = ms(dm || modified);
	const existing = db.query("SELECT date_modified, version FROM items WHERE key = ?").get(key) as {
		date_modified: string;
		version: number;
	} | null;
	// Fast path for the first full pull: identical modification time and nothing queued locally. Not when My Publications
	// differs: older imports dropped that flag, and Zotero does not bump dateModified when it is set, so only a full apply fixes it.
	if (
		existing && !hasOutbox(db, "item", key) && ms(existing.date_modified) === ms(modified) && existing.version === (Number(data.version) || 0) &&
		!!data.inPublications === localInPublications(db, key)
	) {
		setBase(db, "item", key, dm || modified);
		c.report.skipped++;
		return;
	}
	if (decide(c, "item", key, data, remoteMs) === "skip") {
		c.report.skipped++;
		if (hasOutbox(db, "item", key)) setBase(db, "item", key, dm || modified);
		return;
	}
	const itemData: Record<string, unknown> = { ...data, key };
	// zotero.org sends every field of the item type, empty ones as "": store only the filled ones, as the local import does
	for (const [f, v] of Object.entries(itemData)) if (v === "" && f !== "title" && f !== "itemType") delete itemData[f];
	if (parent) itemData.parentItem = parent;
	else delete itemData.parentItem;
	const itemType = typeof itemData.itemType === "string" && itemData.itemType ? itemData.itemType : "document";
	itemData.itemType = itemType;
	const cols = deriveColumns(itemData as unknown as ZoteroItemData);
	const deleted = itemData.deleted ? 1 : 0;
	const added = (typeof data.dateAdded === "string" && data.dateAdded) || nowIso();
	const version = Number(data.version) || 0;
	itemData.dateModified = modified;
	db.query(
		`INSERT INTO items(key, item_type, parent_key, title, creators_summary, year, publication, data, date_added, date_modified, version, deleted, library_id)
		 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET item_type = excluded.item_type, parent_key = excluded.parent_key, title = excluded.title,
			creators_summary = excluded.creators_summary, year = excluded.year, publication = excluded.publication,
			data = excluded.data, date_added = excluded.date_added, date_modified = excluded.date_modified,
			version = excluded.version, deleted = excluded.deleted`,
	).run(key, itemType, parent, cols.title, cols.creators_summary, cols.year, cols.publication, JSON.stringify(itemData), added, modified, version, deleted, c.libraryId);

	// tags
	db.query("DELETE FROM item_tags WHERE item_key = ?").run(key);
	const ins = db.query("INSERT OR IGNORE INTO item_tags(item_key, tag, type) VALUES(?, ?, ?)");
	for (const t of (Array.isArray(data.tags) ? data.tags : []) as { tag?: unknown; type?: unknown }[]) {
		const tag = typeof t === "string" ? t : typeof t?.tag === "string" ? t.tag : "";
		if (tag) ins.run(key, tag, Number((t as { type?: unknown })?.type) || 0);
	}
	// collection membership (top-level items only)
	db.query("DELETE FROM collection_items WHERE item_key = ?").run(key);
	if (!parent && Array.isArray(data.collections)) {
		const insC = db.query(
			"INSERT OR IGNORE INTO collection_items(collection_key, item_key) SELECT key, ? FROM collections WHERE key = ? AND library_id = ?",
		);
		for (const ck of data.collections) if (typeof ck === "string") insC.run(key, ck, c.libraryId);
		refreshCollectionsJson(db, key);
	}
	// attachment row
	if (itemType === "attachment") {
		const old = db.query("SELECT path FROM attachments WHERE item_key = ?").get(key) as { path: string | null } | null;
		const abs = attachmentPath(c.dataDir, key, itemData, old?.path ?? null);
		// linked files under the base directory may be kept in Zotero's "attachments:<relative>" form (files/paths.ts)
		const path = abs && itemData.linkMode === "linked_file" ? storedFormForNewLink(db, abs) : abs;
		db.query(
			`INSERT INTO attachments(item_key, link_mode, content_type, path, url) VALUES(?, ?, ?, ?, ?)
			 ON CONFLICT(item_key) DO UPDATE SET link_mode = excluded.link_mode, content_type = excluded.content_type,
				path = excluded.path, url = excluded.url`,
		).run(
			key,
			String(itemData.linkMode ?? "imported_file"),
			typeof itemData.contentType === "string" && itemData.contentType ? itemData.contentType : null,
			path,
			typeof itemData.url === "string" && itemData.url ? itemData.url : null,
		);
	} else {
		db.query("DELETE FROM attachments WHERE item_key = ?").run(key);
	}
	setBase(db, "item", key, dm || modified);
	c.reindex.add(parent ?? key);
	c.report.applied++;
}

function upsertAnnotation(c: Ctx, key: string, data: ZoteroJson, dm: string): void {
	const db = c.db;
	const att = typeof data.parentItem === "string" ? data.parentItem : "";
	// the attachment must be in this library, and the annotation key must not already belong to another library's attachment
	if (!att || !db.query("SELECT 1 FROM items WHERE key = ? AND library_id = ?").get(att, c.libraryId)) {
		c.report.skipped++;
		return;
	}
	if (db.query("SELECT 1 FROM annotations a JOIN items i ON i.key = a.attachment_key WHERE a.key = ? AND i.library_id <> ?").get(key, c.libraryId)) {
		c.report.skipped++;
		c.report.collisions = (c.report.collisions ?? 0) + 1;
		return;
	}
	const modified = (typeof data.dateModified === "string" && data.dateModified) || dm || nowIso();
	if (decide(c, "annotation", key, data, ms(dm || modified)) === "skip") {
		c.report.skipped++;
		if (hasOutbox(db, "annotation", key)) setBase(db, "annotation", key, dm || modified);
		return;
	}
	const { parentItem: _p, ...ann } = data;
	ann.id = key;
	ann.dateModified = modified;
	db.query(
		`INSERT INTO annotations(key, attachment_key, data, date_modified) VALUES(?, ?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET attachment_key = excluded.attachment_key, data = excluded.data, date_modified = excluded.date_modified`,
	).run(key, att, JSON.stringify(ann), modified);
	setBase(db, "annotation", key, dm || modified);
	c.report.applied++;
}

/**
 * Deleting an item removes its notes, attachments and annotations with it. When any of those (anywhere in the descendant
 * tree) still has an unsent local change, the deletion is not applied: the whole tree stays, one conflict is recorded for
 * the item, and the item is queued again so a push re-creates it for the surviving children. Returns true when blocked.
 */
function deletionBlockedByChildren(c: Ctx, key: string): boolean {
	const db = c.db;
	const row = db.query("SELECT 1 FROM items WHERE key = ? AND library_id = ?").get(key, c.libraryId);
	if (!row) return false;
	const kids = (db.query("SELECT key FROM items WHERE parent_key = ?").all(key) as { key: string }[]).map((r) => r.key);
	const pendingKids = kids.filter((k) => hasOutbox(db, "item", k));
	const owners = [key, ...kids];
	const anns = db
		.query(`SELECT key FROM annotations WHERE attachment_key IN (SELECT value FROM json_each(?))`)
		.all(JSON.stringify(owners)) as { key: string }[];
	const pendingAnns = anns.filter((a) => hasOutbox(db, "annotation", a.key));
	if (pendingKids.length === 0 && pendingAnns.length === 0) return false;
	const local = localSnapshot(db, "item", key);
	recordConflict(db, "item", key, { ...((local?.json as object) ?? {}), pendingChildren: [...pendingKids, ...pendingAnns.map((a) => a.key)] }, null, "local");
	c.report.conflicts++;
	db.query("DELETE FROM sync_base WHERE type = 'item' AND key = ?").run(key);
	db.query("INSERT INTO sync_outbox(type, key, op, library_id) VALUES('item', ?, 'upsert', ?) ON CONFLICT(type, key, op) DO NOTHING").run(key, c.libraryId);
	return true;
}

function deleteRemote(c: Ctx, type: EntityType, key: string): void {
	const db = c.db;
	// an erase in one library never touches an object of another that happens to share the key
	if (type !== "annotation" && (db.query(`SELECT 1 FROM ${type === "item" ? "items" : "collections"} WHERE key = ? AND library_id <> ?`).get(key, c.libraryId))) return;
	// an annotation is only ever removed through its own library: its attachment must be in this library
	if (type === "annotation" && !db.query("SELECT 1 FROM annotations a JOIN items i ON i.key = a.attachment_key WHERE a.key = ? AND i.library_id = ?").get(key, c.libraryId)) return;
	if (type === "item" && deletionBlockedByChildren(c, key)) return;
	if (hasOutbox(db, type, key)) {
		// edited here while erased there: keep our version (it is written back on the next push)
		const local = localSnapshot(db, type, key);
		if (local) {
			recordConflict(db, type, key, local.json, null, "local");
			c.report.conflicts++;
			db.query("DELETE FROM sync_base WHERE type = ? AND key = ?").run(type, key);
			return;
		}
		clearOutbox(db, type, key);
	}
	db.query("DELETE FROM sync_base WHERE type = ? AND key = ?").run(type, key);
	if (type === "item") {
		const row = db.query("SELECT rowid, parent_key FROM items WHERE key = ?").get(key) as { rowid: number; parent_key: string | null } | null;
		if (!row) return;
		db.query("DELETE FROM items WHERE key = ?").run(key);
		if (row.parent_key) c.reindex.add(row.parent_key);
		else c.unindex.push(row.rowid);
		c.report.deleted++;
	} else if (type === "annotation") {
		if (db.query("DELETE FROM annotations WHERE key = ?").run(key).changes) c.report.deleted++;
	} else {
		const affected = db
			.query(
				`WITH RECURSIVE d(key) AS (SELECT ? UNION ALL SELECT c.key FROM collections c JOIN d ON c.parent_key = d.key)
				 SELECT DISTINCT ci.item_key FROM collection_items ci JOIN d ON d.key = ci.collection_key`,
			)
			.all(key) as { item_key: string }[];
		if (!db.query("DELETE FROM collections WHERE key = ? AND library_id = ?").run(key, c.libraryId).changes) return;
		for (const a of affected) refreshCollectionsJson(db, a.item_key);
		c.report.deleted++;
	}
}

/** Applies changes read from Zotero (or zotero.org) to one library (default: My Library). */
export function applyChanges(db: Database, changes: RemoteChanges, dataDir: string, libraryId = 1): ApplyReport {
	const report: ApplyReport = { applied: 0, skipped: 0, conflicts: 0, deleted: 0 };
	// objects with a key that is not a plain key never touch the database (the key becomes a folder name for attachments)
	const ch: RemoteChanges = {
		upserts: changes.upserts.filter((u) => validKey(u.key) && u.data !== null && typeof u.data === "object"),
		deletes: changes.deletes.filter((d) => validKey(d.key)),
	};
	report.skipped += changes.upserts.length - ch.upserts.length;
	const c: Ctx = {
		db,
		libraryId,
		dataDir,
		report,
		reindex: new Set(),
		unindex: [],
		batchItems: new Set(ch.upserts.filter((u) => u.type === "item").map((u) => u.key)),
		batchCollections: new Set(ch.upserts.filter((u) => u.type === "collection").map((u) => u.key)),
		batchParent: new Map(ch.upserts.filter((u) => u.type === "item").map((u) => [u.key, typeof u.data.parentItem === "string" && u.data.parentItem ? u.data.parentItem : null])),
	};
	db.transaction(() => {
		db.run("INSERT OR IGNORE INTO sync_flags(name) VALUES('suppress')");
		db.run("PRAGMA defer_foreign_keys = ON");
		try {
			for (const u of ch.upserts) if (u.type === "collection") safely(c, () => upsertCollection(c, u.key, u.data, u.dateModified));
			breakCollectionLoops(c);
			for (const u of ch.upserts) if (u.type === "item") safely(c, () => upsertItem(c, u.key, u.data, u.dateModified));
			// a child whose parent was skipped above must not stay behind with a dangling parent
			db.run("DELETE FROM items WHERE parent_key IS NOT NULL AND parent_key NOT IN (SELECT key FROM items)");
			// ... and none may end up under another child (a parent that kept its local state because of a conflict, ...)
			db.query(
				"DELETE FROM items WHERE key IN (SELECT value FROM json_each(?)) AND parent_key IN (SELECT key FROM items WHERE parent_key IS NOT NULL)",
			).run(JSON.stringify([...c.batchItems]));
			for (const u of ch.upserts) if (u.type === "annotation") safely(c, () => upsertAnnotation(c, u.key, u.data, u.dateModified));
			for (const d of ch.deletes) if (d.type === "annotation") safely(c, () => deleteRemote(c, d.type, d.key));
			for (const d of ch.deletes) if (d.type === "item") safely(c, () => deleteRemote(c, d.type, d.key));
			for (const d of ch.deletes) if (d.type === "collection") safely(c, () => deleteRemote(c, d.type, d.key));
		} finally {
			db.run("DELETE FROM sync_flags WHERE name = 'suppress'");
		}
	})();
	// what is not stored anywhere (no row in any library, nothing queued about it) was not applied: report it for a retry
	const failed: { type: EntityType; key: string }[] = [];
	const exists: Record<EntityType, string> = { item: "items", collection: "collections", annotation: "annotations" };
	const erased = new Set(ch.deletes.map((d) => `${d.type}:${d.key}`));
	for (const u of ch.upserts) {
		if (erased.has(`${u.type}:${u.key}`)) continue;
		if (db.query(`SELECT 1 FROM ${exists[u.type]} WHERE key = ?`).get(u.key)) continue;
		if (hasOutbox(db, u.type, u.key)) continue;
		failed.push({ type: u.type, key: u.key });
	}
	if (failed.length) report.failed = failed;
	if (c.unindex.length || c.reindex.size) {
		db.transaction(() => {
			for (const r of c.unindex) db.query("DELETE FROM search WHERE rowid = ?").run(r);
			for (const k of c.reindex) {
				try {
					indexItem(db, k);
				} catch {
					// the item is stored; a search row that cannot be built must not fail the whole pull
				}
			}
		})();
	}
	return report;
}
