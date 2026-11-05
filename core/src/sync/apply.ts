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
	if (filename) {
		const candidate = join(dataDir, "storage", key, filename);
		if (existsSync(candidate)) return candidate;
	}
	return existing;
}

interface Ctx {
	db: Database;
	dataDir: string;
	report: ApplyReport;
	reindex: Set<string>; // top-level item keys to re-index
	unindex: number[]; // search rowids of removed top-level items
	batchItems: Set<string>;
	batchCollections: Set<string>;
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
	const remoteMs = ms(dm);
	if (decide(c, "collection", key, data, remoteMs) === "skip") {
		c.report.skipped++;
		if (hasOutbox(db, "collection", key)) setBase(db, "collection", key, dm || nowIso());
		return;
	}
	const name = typeof data.name === "string" ? data.name : "";
	let parent = typeof data.parentCollection === "string" && data.parentCollection ? data.parentCollection : null;
	if (parent && parent !== key && !c.batchCollections.has(parent) && !db.query("SELECT 1 FROM collections WHERE key = ?").get(parent)) parent = null;
	if (parent === key) parent = null;
	const version = typeof data.version === "number" ? data.version : 0;
	db.query(
		`INSERT INTO collections(key, name, parent_key, version) VALUES(?, ?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET name = excluded.name, parent_key = excluded.parent_key, version = excluded.version`,
	).run(key, name, parent, version);
	setBase(db, "collection", key, dm || nowIso());
	c.report.applied++;
}

function upsertItem(c: Ctx, key: string, data: ZoteroJson, dm: string): void {
	const db = c.db;
	const parent = typeof data.parentItem === "string" && data.parentItem ? data.parentItem : null;
	if (parent && !c.batchItems.has(parent) && !db.query("SELECT 1 FROM items WHERE key = ?").get(parent)) {
		c.report.skipped++; // parent unknown here (e.g. in a group library)
		return;
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
	const itemType = String(itemData.itemType ?? "document");
	const cols = deriveColumns(itemData as unknown as ZoteroItemData);
	const deleted = itemData.deleted ? 1 : 0;
	const added = (typeof data.dateAdded === "string" && data.dateAdded) || nowIso();
	const version = Number(data.version) || 0;
	itemData.dateModified = modified;
	db.query(
		`INSERT INTO items(key, item_type, parent_key, title, creators_summary, year, publication, data, date_added, date_modified, version, deleted)
		 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET item_type = excluded.item_type, parent_key = excluded.parent_key, title = excluded.title,
			creators_summary = excluded.creators_summary, year = excluded.year, publication = excluded.publication,
			data = excluded.data, date_added = excluded.date_added, date_modified = excluded.date_modified,
			version = excluded.version, deleted = excluded.deleted`,
	).run(key, itemType, parent, cols.title, cols.creators_summary, cols.year, cols.publication, JSON.stringify(itemData), added, modified, version, deleted);

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
			"INSERT OR IGNORE INTO collection_items(collection_key, item_key) SELECT key, ? FROM collections WHERE key = ?",
		);
		for (const ck of data.collections) if (typeof ck === "string") insC.run(key, ck);
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
	if (!att || !db.query("SELECT 1 FROM items WHERE key = ?").get(att)) {
		c.report.skipped++;
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

function deleteRemote(c: Ctx, type: EntityType, key: string): void {
	const db = c.db;
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
		if (!db.query("DELETE FROM collections WHERE key = ?").run(key).changes) return;
		for (const a of affected) refreshCollectionsJson(db, a.item_key);
		c.report.deleted++;
	}
}

export function applyChanges(db: Database, ch: RemoteChanges, dataDir: string): ApplyReport {
	const report: ApplyReport = { applied: 0, skipped: 0, conflicts: 0, deleted: 0 };
	const c: Ctx = {
		db,
		dataDir,
		report,
		reindex: new Set(),
		unindex: [],
		batchItems: new Set(ch.upserts.filter((u) => u.type === "item").map((u) => u.key)),
		batchCollections: new Set(ch.upserts.filter((u) => u.type === "collection").map((u) => u.key)),
	};
	db.transaction(() => {
		db.run("INSERT OR IGNORE INTO sync_flags(name) VALUES('suppress')");
		db.run("PRAGMA defer_foreign_keys = ON");
		try {
			for (const u of ch.upserts) if (u.type === "collection") upsertCollection(c, u.key, u.data, u.dateModified);
			for (const u of ch.upserts) if (u.type === "item") upsertItem(c, u.key, u.data, u.dateModified);
			for (const u of ch.upserts) if (u.type === "annotation") upsertAnnotation(c, u.key, u.data, u.dateModified);
			for (const d of ch.deletes) if (d.type === "annotation") deleteRemote(c, d.type, d.key);
			for (const d of ch.deletes) if (d.type === "item") deleteRemote(c, d.type, d.key);
			for (const d of ch.deletes) if (d.type === "collection") deleteRemote(c, d.type, d.key);
		} finally {
			db.run("DELETE FROM sync_flags WHERE name = 'suppress'");
		}
	})();
	if (c.unindex.length || c.reindex.size) {
		db.transaction(() => {
			for (const r of c.unindex) db.query("DELETE FROM search WHERE rowid = ?").run(r);
			for (const k of c.reindex) indexItem(db, k);
		})();
	}
	return report;
}
