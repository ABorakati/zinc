// ZoteroReader: reads changes out of Zotero's zotero.sqlite (directly when Zotero is closed, from a
// snapshot copy of db + -wal + -shm when it is running).
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntityType, ZoteroJson, ZoteroReader } from "../sync/protocol";
import {
	findBaseAttachmentPath,
	findZoteroDataDir,
	fromRelativeAttachmentPath,
	isBusyError,
	isZoteroProcessRunning,
	snapshotCopy,
	type ZoteroDbOptions,
} from "./env";
import { type LoadedItem, loadItems, loadLookups, userLibraryID } from "./load";
import { buildAnnotationData, buildItemData, isoToSql, type Row, toIso } from "./mapping";

/** Keys the caller already knows, so erased objects can be found even when syncDeleteLog is empty. */
export interface KnownKeys {
	item?: Iterable<string>;
	collection?: Iterable<string>;
	annotation?: Iterable<string>;
}

export interface ZoteroChanges {
	at: string;
	upserts: { type: EntityType; key: string; data: ZoteroJson; dateModified: string }[];
	deletes: { type: EntityType; key: string }[];
}

const SYNC_OBJECT_COLLECTION = 1;
const SYNC_OBJECT_ITEM = 3;

function maxSql(a: string, b: string): string {
	return a >= b ? a : b;
}

export class ZoteroDbReader implements ZoteroReader {
	readonly dataDir: string;
	readonly dbPath: string;
	private baseAttach: string | null;

	constructor(private opts: ZoteroDbOptions = {}) {
		this.dataDir = opts.dataDir ?? findZoteroDataDir(opts.profilesDir);
		this.dbPath = join(this.dataDir, "zotero.sqlite");
		this.baseAttach =
			opts.baseAttachmentPath !== undefined ? opts.baseAttachmentPath : findBaseAttachmentPath(opts.profilesDir);
	}

	private async running(): Promise<boolean> {
		return (this.opts.isRunning ?? isZoteroProcessRunning)();
	}

	/** Run fn against a read-only view of the library (live file if closed, snapshot copy otherwise). */
	async withDb<T>(fn: (db: Database) => T): Promise<T> {
		let tmp: string | null = null;
		let db: Database | null = null;
		const openCopy = () => {
			tmp = mkdtempSync(join(tmpdir(), "zotero-next-snap-"));
			return new Database(snapshotCopy(this.dbPath, tmp), { readonly: true });
		};
		try {
			if (await this.running()) {
				db = openCopy();
			} else {
				try {
					db = new Database(this.dbPath, { readonly: true });
					db.exec("PRAGMA busy_timeout = 500");
					db.query("SELECT 1 FROM libraries LIMIT 1").get();
				} catch (e) {
					if (!isBusyError(e)) throw e;
					db?.close(true);
					db = openCopy();
				}
			}
			return fn(db);
		} finally {
			try {
				db?.close(true);
			} catch {
				// ignore
			}
			if (tmp) rmSync(tmp, { recursive: true, force: true });
		}
	}

	async changesSince(since: string | null, extra: { knownKeys?: KnownKeys } = {}): Promise<ZoteroChanges> {
		// Zotero timestamps have 1 s resolution: report a point slightly in the past so a change in the
		// same second as this read is picked up next time (duplicates are harmless; callers dedupe).
		const at = new Date(Date.now() - 2000).toISOString().replace(/\.\d+Z$/, "Z");
		const sinceSql = since ? isoToSql(since) : null;
		return this.withDb((db) => this.read(db, at, sinceSql, extra.knownKeys));
	}

	private resolveAttachmentPath(item: LoadedItem, storageDir: string): string | null {
		const a = item.attRow;
		if (!a || a.linkMode === 3) return null;
		if (a.linkMode === 2) {
			return a.path ? fromRelativeAttachmentPath(a.path, this.baseAttach) : null;
		}
		const name = a.path?.startsWith("storage:") ? a.path.slice("storage:".length) : null;
		return name ? join(storageDir, item.key, name) : null;
	}

	private read(db: Database, at: string, sinceSql: string | null, known?: KnownKeys): ZoteroChanges {
		const lib = userLibraryID(db, this.opts.libraryID);
		const lk = loadLookups(db);
		const storageDir = join(this.dataDir, "storage");

		// changed items (any type, incl. annotations)
		const rows = (
			sinceSql
				? db.query("SELECT itemID FROM items WHERE libraryID = ? AND clientDateModified > ?").all(lib, sinceSql)
				: db.query("SELECT itemID FROM items WHERE libraryID = ?").all(lib)
		) as Row[];
		const loaded = loadItems(
			db,
			lk,
			rows.map((r) => r.itemID as number),
		);

		const upserts: ZoteroChanges["upserts"] = [];
		for (const it of loaded.values()) {
			if (it.typeName === "feed" || it.typeName === "feedItem") continue;
			const dateModified = toIso(maxSql(it.dateModified, it.clientDateModified));
			if (it.annotation) {
				const data = buildAnnotationData(it.annotation);
				if (!data || !it.annotation.parentKey) continue;
				data.parentItem = it.annotation.parentKey;
				if (it.deleted) data.deleted = 1;
				upserts.push({ type: "annotation", key: it.key, data, dateModified });
				continue;
			}
			if (!it.input) continue;
			const data = buildItemData({
				...it.input,
				attachment: it.input.attachment
					? { ...it.input.attachment, resolvedPath: this.resolveAttachmentPath(it, storageDir) }
					: undefined,
			});
			// Reader contract: attachments carry the resolved absolute file path in data.path.
			const path = this.resolveAttachmentPath(it, storageDir);
			if (it.input.attachment && path) data.path = path;
			if (it.deleted) data.deleted = 1;
			upserts.push({ type: "item", key: it.key, data, dateModified });
		}

		// changed collections
		const collRows = (
			sinceSql
				? db
						.query(
							"SELECT collectionID, collectionName, parentCollectionID, key, version, clientDateModified FROM collections WHERE libraryID = ? AND clientDateModified > ?",
						)
						.all(lib, sinceSql)
				: db
						.query(
							"SELECT collectionID, collectionName, parentCollectionID, key, version, clientDateModified FROM collections WHERE libraryID = ?",
						)
						.all(lib)
		) as Row[];
		if (collRows.length) {
			const allColl = new Map<number, string>(
				(db.query("SELECT collectionID, key FROM collections WHERE libraryID = ?").all(lib) as Row[]).map((r) => [
					r.collectionID,
					r.key,
				]),
			);
			const trashed = new Set(
				(db.query("SELECT collectionID FROM deletedCollections").all() as Row[]).map((r) => r.collectionID as number),
			);
			for (const c of collRows) {
				const data: Record<string, unknown> = {
					key: c.key,
					version: c.version,
					name: c.collectionName,
					parentCollection: c.parentCollectionID ? (allColl.get(c.parentCollectionID) ?? false) : false,
					relations: {},
				};
				if (trashed.has(c.collectionID)) data.deleted = 1;
				upserts.push({ type: "collection", key: c.key, data, dateModified: toIso(c.clientDateModified) });
			}
		}

		// deletions: syncDeleteLog entries (cleared by Zotero after a successful sync), plus anything in
		// the caller's known-key sets that no longer exists.
		const deletes: ZoteroChanges["deletes"] = [];
		const seen = new Set<string>();
		const push = (type: EntityType, key: string) => {
			const id = `${type}:${key}`;
			if (seen.has(id)) return;
			seen.add(id);
			deletes.push({ type, key });
		};
		const knownAnnotations = known?.annotation ? new Set(known.annotation) : null;
		let log: Row[] = [];
		try {
			log = (
				sinceSql
					? db
							.query("SELECT syncObjectTypeID, key FROM syncDeleteLog WHERE libraryID = ? AND dateDeleted > ?")
							.all(lib, sinceSql)
					: []
			) as Row[];
		} catch {
			// no syncDeleteLog in very old schemas
		}
		const existingItems = new Set(
			(db.query("SELECT key FROM items WHERE libraryID = ?").all(lib) as Row[]).map((r) => r.key as string),
		);
		const existingColls = new Set(
			(db.query("SELECT key FROM collections WHERE libraryID = ?").all(lib) as Row[]).map((r) => r.key as string),
		);
		for (const r of log) {
			if (r.syncObjectTypeID === SYNC_OBJECT_COLLECTION) {
				if (!existingColls.has(r.key)) push("collection", r.key);
			} else if (r.syncObjectTypeID === SYNC_OBJECT_ITEM) {
				// syncDeleteLog does not say whether an erased item was an annotation
				if (!existingItems.has(r.key)) push(knownAnnotations?.has(r.key) ? "annotation" : "item", r.key);
			}
		}
		if (known?.item) for (const k of known.item) if (!existingItems.has(k)) push("item", k);
		if (known?.collection) for (const k of known.collection) if (!existingColls.has(k)) push("collection", k);
		if (knownAnnotations) for (const k of knownAnnotations) if (!existingItems.has(k)) push("annotation", k);

		return { at, upserts, deletes };
	}
}
