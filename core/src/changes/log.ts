// The change log (migration 5, core/src/migrations/change-log.ts): reading it, and the transaction helper that tags writes.
import type { Database } from "bun:sqlite";

export interface ChangeRow {
	seq: number;
	at: string;
	object: string;
	kind: string;
	key: string;
	library: number | null;
	origin: string;
	silent: boolean;
}

export interface ChangePage {
	/** The newest seq in the log (0 for an empty log). */
	head: number;
	/** Pass this as `since` next time. The last returned seq, or `head` when nothing is newer. */
	cursor: number;
	/** The cursor was ahead of the log (a different library file) or older than what is kept: the reader must rescan. */
	reset: boolean;
	changes: ChangeRow[];
}

const KEEP = 100_000;
const PRUNE_AT = 200_000;

export function changeHead(db: Database): number {
	const r = db.query("SELECT seq FROM sqlite_sequence WHERE name = 'change_log'").get() as { seq: number } | null;
	return r?.seq ?? 0;
}

/** Keeps the log bounded: past PRUNE_AT rows the oldest are dropped. A reader whose cursor is older gets `reset`. */
export function pruneChangeLog(db: Database): void {
	const head = changeHead(db);
	const min = (db.query("SELECT min(seq) AS m FROM change_log").get() as { m: number | null }).m;
	if (min !== null && head - min > PRUNE_AT) db.query("DELETE FROM change_log WHERE seq <= ?").run(head - KEEP);
}

export function changesSince(db: Database, since: number, limit = 1000, library?: number): ChangePage {
	const head = changeHead(db);
	limit = Math.min(Math.max(Math.floor(limit) || 1000, 1), 5000);
	if (since > head) return { head, cursor: head, reset: true, changes: [] };
	const min = (db.query("SELECT min(seq) AS m FROM change_log").get() as { m: number | null }).m;
	const reset = min !== null && since > 0 && since < min - 1;
	const rows = (
		library === undefined
			? db.query("SELECT * FROM change_log WHERE seq > ? ORDER BY seq LIMIT ?").all(since, limit)
			: db.query("SELECT * FROM change_log WHERE seq > ? AND (library_id = ? OR library_id IS NULL) ORDER BY seq LIMIT ?").all(since, library, limit)
	) as {
		seq: number;
		at: string;
		object: string;
		kind: string;
		key: string;
		library_id: number | null;
		origin: string;
		silent: number;
	}[];
	const changes = rows.map((r) => ({
		seq: r.seq,
		at: r.at,
		object: r.object,
		kind: r.kind,
		key: r.key,
		library: r.library_id,
		origin: r.origin,
		silent: !!r.silent,
	}));
	// with a library filter the scan can skip rows: the cursor still advances past what was looked at
	const cursor = changes.length === limit ? changes[changes.length - 1].seq : head;
	return { head, cursor, reset, changes };
}

const ORIGIN_RE = /^[A-Za-z0-9:@._+-]{1,200}$/;

/**
 * Runs `fn` in one write transaction in which every change-log row gets `origin` (and `silent`). The context rows live
 * only inside the transaction, so a rollback leaves nothing behind.
 */
export function withOrigin<T>(db: Database, origin: string | undefined, silent: boolean, fn: () => T): T {
	const o = origin && ORIGIN_RE.test(origin) ? origin : "unknown";
	return db.transaction(() => {
		db.query("INSERT OR REPLACE INTO change_ctx(name, value) VALUES('origin', ?)").run(o);
		if (silent) db.query("INSERT OR REPLACE INTO change_ctx(name, value) VALUES('silent', '1')").run();
		try {
			return fn();
		} finally {
			db.query("DELETE FROM change_ctx WHERE name IN ('origin', 'silent')").run();
		}
	}).immediate();
}
