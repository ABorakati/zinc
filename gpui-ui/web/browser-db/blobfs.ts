// The durable backend of the node:fs shim (web/shims/fs.ts): files and directories kept in a SQLite database, one row per file.
// The caller opens the database (the sqlite-wasm one in the DB worker, bun:sqlite in tests) and passes the handle.
//
//   installDurableFs(createBlobBackend(db))   // paths under /opfs/ now live in `db`
//
// Costs (measured with bun:sqlite, in memory; see blobfs.test.ts "timings"): a whole-file write or read moves the bytes once
// across the JS/wasm boundary (20 MB: ~70 ms write, ~50 ms read). A range read uses substr(data, pos+1, len): only the slice
// crosses into JS, though SQLite itself loads the blob's pages to compute it (256 KB from the middle of 20 MB: ~20 ms).
// append is `data = CAST(data || ? AS BLOB)` in SQL: the old bytes never reach JS, but SQLite has no in-place growth of a
// blob, so the row is rewritten: ~60 ms per append to a 20 MB file, ~0.07 ms per 100-byte append to a small log. (On a file
// database the per-transaction journal sync dominates small appends, so the owner should open files.sqlite with
// synchronous=OFF or batch; opfs-sahpool does not pay that cost.) copy is one INSERT ... SELECT (no bytes in JS). rename of a
// file rewrites its row (the path is a column of the record).
import type { DurableBackend, DurableStat } from "../shims/fs";

/** What the backend needs of a database: bun:sqlite's `Database` and the shim `Database` in web/sqlite.ts both fit. */
export interface BlobDb {
	exec(sql: string, ...params: any[]): unknown;
	query(sql: string): { get(...params: any[]): any; all(...params: any[]): any[]; run(...params: any[]): unknown };
	transaction<A extends any[], R>(fn: (...args: A) => R): (...args: A) => R;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, data BLOB NOT NULL, mtime INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS dirs (path TEXT PRIMARY KEY);
`;

const EMPTY = new Uint8Array(0);
const bytesOf = (v: unknown): Uint8Array => (v instanceof Uint8Array ? (v.constructor === Uint8Array ? v : new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) : v == null ? EMPTY : typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v as ArrayBuffer));
const ancestors = (k: string): string[] => { const out: string[] = []; for (let i = k.indexOf("/", 1); i !== -1; i = k.indexOf("/", i + 1)) out.push(k.slice(0, i)); return out; };

export function createBlobBackend(db: BlobDb): DurableBackend {
	db.exec(SCHEMA);
	const q = (sql: string) => db.query(sql);
	// directories known to exist in the dirs table, so a write does not re-insert its parents every time
	const known = new Set<string>();
	const ensureDirs = (k: string, self = false) => {
		const list = self ? [...ancestors(k), k] : ancestors(k);
		for (const d of list) {
			if (known.has(d)) continue;
			q("INSERT OR IGNORE INTO dirs(path) VALUES (?)").run(d);
			known.add(d);
		}
	};
	// the rows under a directory: every path with the prefix "<k>/" (the range ["<k>/", "<k>0") since "0" follows "/")
	const lo = (k: string) => k + "/";
	const hi = (k: string) => k + "0";
	const now = () => Date.now();

	const stat = (k: string): DurableStat | undefined => {
		const f = q("SELECT length(data) AS size, mtime FROM files WHERE path = ?").get(k);
		if (f) return { size: Number(f.size), mtimeMs: Number(f.mtime), isDir: false };
		if (q("SELECT 1 AS x FROM dirs WHERE path = ?").get(k)) return { size: 0, mtimeMs: 0, isDir: true };
		return undefined;
	};
	const write = db.transaction((k: string, data: Uint8Array) => {
		ensureDirs(k);
		q("INSERT INTO files(path, data, mtime) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET data = excluded.data, mtime = excluded.mtime").run(k, data, now());
	});
	const append = db.transaction((k: string, data: Uint8Array) => {
		// `||` on blobs gives TEXT (length() would stop at a NUL byte); CAST back to BLOB keeps every byte
		const r: any = q("UPDATE files SET data = CAST(data || ? AS BLOB), mtime = ? WHERE path = ?").run(data, now(), k);
		if (!r.changes) write(k, data);
	});
	const rm = db.transaction((k: string) => {
		q("DELETE FROM files WHERE path = ? OR (path > ? AND path < ?)").run(k, lo(k), hi(k));
		q("DELETE FROM dirs WHERE path = ? OR (path > ? AND path < ?)").run(k, lo(k), hi(k));
		known.clear();
	});
	const rename = db.transaction((from: string, to: string): boolean => {
		if (from === to) return !!stat(from);
		const f = q("SELECT 1 AS x FROM files WHERE path = ?").get(from);
		if (f) {
			rm(to);
			ensureDirs(to);
			q("UPDATE files SET path = ?, mtime = mtime WHERE path = ?").run(to, from);
			return true;
		}
		if (!q("SELECT 1 AS x FROM dirs WHERE path = ?").get(from)) return false;
		rm(to);
		ensureDirs(to, true);
		const cut = from.length + 1; // substr is 1-based: keep from the character at index from.length
		q("UPDATE files SET path = ? || substr(path, ?) WHERE path > ? AND path < ?").run(to, cut, lo(from), hi(from));
		q("INSERT OR IGNORE INTO dirs(path) SELECT ? || substr(path, ?) FROM dirs WHERE path > ? AND path < ?").run(to, cut, lo(from), hi(from));
		q("DELETE FROM dirs WHERE path = ? OR (path > ? AND path < ?)").run(from, lo(from), hi(from));
		known.clear();
		return true;
	});
	const copy = db.transaction((from: string, to: string): boolean => {
		if (!q("SELECT 1 AS x FROM files WHERE path = ?").get(from)) return false;
		if (from === to) return true;
		ensureDirs(to);
		q("INSERT INTO files(path, data, mtime) SELECT ?, data, ? FROM files WHERE path = ? ON CONFLICT(path) DO UPDATE SET data = excluded.data, mtime = excluded.mtime").run(to, now(), from);
		return true;
	});
	const truncate = db.transaction((k: string, len: number) => {
		const st = q("SELECT length(data) AS size FROM files WHERE path = ?").get(k);
		if (!st) { write(k, new Uint8Array(len)); return; }
		const size = Number(st.size);
		if (len === size) return;
		if (len < size) q("UPDATE files SET data = substr(data, 1, ?), mtime = ? WHERE path = ?").run(len, now(), k);
		else q("UPDATE files SET data = CAST(data || zeroblob(?) AS BLOB), mtime = ? WHERE path = ?").run(len - size, now(), k);
	});

	return {
		stat,
		read(k, pos, len) {
			if (pos === undefined && len === undefined) {
				const r = q("SELECT data FROM files WHERE path = ?").get(k);
				return r ? bytesOf(r.data) : undefined;
			}
			const start = Math.max(0, pos ?? 0);
			if (len !== undefined && len <= 0) return q("SELECT 1 AS x FROM files WHERE path = ?").get(k) ? EMPTY : undefined;
			// substr on a blob counts bytes; without a length it runs to the end
			const r = len === undefined
				? q("SELECT substr(data, ?) AS d FROM files WHERE path = ?").get(start + 1, k)
				: q("SELECT substr(data, ?, ?) AS d FROM files WHERE path = ?").get(start + 1, len, k);
			return r ? bytesOf(r.d) : undefined;
		},
		write(k, data) { write(k, data); },
		append(k, data) { append(k, data); },
		truncate(k, len) { truncate(k, len); },
		mkdir(k) { if (k !== "/") db.transaction(() => ensureDirs(k, true))(); },
		readdir(k) {
			if (!q("SELECT 1 AS x FROM dirs WHERE path = ?").get(k)) return undefined;
			const from = k.length + 2; // the first character after "<k>/"
			const direct = (table: string) => q(`SELECT substr(path, ?) AS name FROM ${table} WHERE path > ? AND path < ? AND instr(substr(path, ?), '/') = 0`).all(from, lo(k), hi(k), from) as { name: string }[];
			return [...direct("dirs").map((r) => ({ name: r.name, isDir: true })), ...direct("files").map((r) => ({ name: r.name, isDir: false }))];
		},
		rm(k) { rm(k); },
		rename(from, to) { return rename(from, to); },
		copy(from, to) { return copy(from, to); },
		utimes(k, mtimeMs) { q("UPDATE files SET mtime = ? WHERE path = ?").run(Math.floor(mtimeMs), k); },
	};
}
