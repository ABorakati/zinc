// Two-way sync between zotero-next and the user's LOCAL Zotero library: zotero.sqlite + the
// storage folder, on this machine. No Zotero plugin, no zotero.org. Works while Zotero is closed.
//
// Zotero holds an exclusive lock on zotero.sqlite while it runs, so:
//   Zotero closed  -> zotero-next writes queued changes straight into zotero.sqlite (ZoteroWriter)
//                     and copies new attachment files into <Zotero data dir>/storage/<KEY>/.
//   Zotero running -> writes stay queued in zotero-next's outbox; Zotero's changes are read from a
//                     snapshot copy (zotero.sqlite + -wal + -shm copied together) every few seconds.
// Writes mimic Zotero exactly (same tables, triggers fire, clientDateModified, synced = 0, version
// untouched, deletedItems for trash, syncDeleteLog for erased objects) so Zotero — and Zotero's own
// zotero.org sync, if the user uses it — sees them as ordinary local edits.
// Safety: never write while Zotero runs (lock probe + zotero.exe process check); back up
// zotero.sqlite (VACUUM INTO <dataDir>/zotero-next-backups/) before each write session, keep the
// last 5; one transaction per session; PRAGMA integrity_check + foreign_key_check after; on any
// error roll back and pause sync with a visible error.
// Item/collection keys are Zotero's own keys on both sides (the importer already uses them).

/** Zotero Web API JSON for one object (what items.data holds in zotero-next). */
export type ZoteroJson = Record<string, unknown>;

export type EntityType = "item" | "collection" | "annotation";

/** One change to write into Zotero. Items/collections use Zotero Web API JSON (as items.data). */
export interface ZoteroWrite {
	type: EntityType;
	op: "upsert" | "trash" | "restore" | "erase";
	key: string;
	// upsert: full JSON. Annotations: the reader annotation JSON plus {parentItem: <attachment key>}.
	data?: ZoteroJson;
	// Attachments created in zotero-next: the file to copy into storage/<key>/ (imported_url/imported_file).
	file?: { path: string; filename: string; contentType: string };
}

export interface ZoteroWriteResult {
	key: string;
	ok: boolean;
	error?: string;
	// Absolute path of the attachment file inside Zotero's storage after the write (attachments).
	path?: string;
}

/** Writes into a CLOSED Zotero library. Implemented in core/src/zotero-db/writer.ts. */
export interface ZoteroWriter {
	/** True if zotero.sqlite can be opened for writing right now (Zotero not running, no lock). */
	canWrite(): Promise<boolean>;
	/**
	 * Apply writes in one transaction after a backup; returns per-write results. Throws
	 * ZoteroLockedError if Zotero started meanwhile (nothing written).
	 */
	apply(writes: ZoteroWrite[]): Promise<{ backupPath: string; results: ZoteroWriteResult[] }>;
}

/** Reads Zotero's library (directly when closed, from a snapshot copy when running). */
export interface ZoteroReader {
	/** Objects changed since a point (Zotero's clientDateModified/dateModified), plus deletions. */
	changesSince(since: string | null): Promise<{
		at: string; // pass as `since` next time
		upserts: { type: EntityType; key: string; data: ZoteroJson; dateModified: string }[];
		deletes: { type: EntityType; key: string }[]; // erased in Zotero
	}>;
}

export class ZoteroLockedError extends Error {
	constructor() {
		super("Zotero is running; zotero.sqlite is locked");
		this.name = "ZoteroLockedError";
	}
}

// zotero-next sync state (core/src/sync/schema.sql, applied by openDb):
//   sync_outbox(seq INTEGER PRIMARY KEY, type, key, op, at)  -- filled by SQLite triggers on items,
//       collections, collection_items, item_tags, annotations, attachments (every writer: UI, MCP,
//       Find Full Text, references add…); coalesced per (type, key) when pushed
//   sync_flags(name PRIMARY KEY)          -- row 'suppress' while applying Zotero's changes (triggers skip)
//   sync_state(name PRIMARY KEY, value)   -- last_pull_at, last_push_at, last_error, paused
//   sync_base(type, key, date_modified)   -- Zotero's dateModified last seen per object (conflicts)
//   sync_conflicts(id INTEGER PRIMARY KEY, type, key, local TEXT, remote TEXT, resolved TEXT, at)
// Conflict rule: both sides changed since sync_base -> the newer dateModified wins; the loser is
// kept in sync_conflicts for the UI.
//
// HTTP API additions (zotero-next core):
//   GET  /api/sync/status     -> SyncStatus
//   POST /api/sync/now        -> SyncStatus   (pull, then push if Zotero is closed)
//   POST /api/sync/enable     {enabled: boolean} -> SyncStatus   (writing into Zotero starts disabled)
//   GET  /api/sync/conflicts  -> {conflicts: {id, type, key, title, local, remote, resolved, at}[]}

export interface SyncStatus {
	enabled: boolean; // writing into Zotero (reading Zotero's changes is always on)
	zotero: "closed" | "running" | "missing" | "error";
	dataDir: string;
	pending: number; // outbox entries waiting for Zotero to close
	lastPullAt?: string;
	lastPushAt?: string;
	lastBackup?: string;
	lastError?: string;
	conflicts: number; // unresolved
}
