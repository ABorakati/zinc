// The durable backend of the node:fs shim (web/shims/fs.ts): files and directories kept in a SQLite database, one row per file.
// The caller opens the database (the sqlite-wasm one in the DB worker, bun:sqlite in tests) and passes the handle.
//
//   installDurableFs(createBlobBackend(db))   // paths under /opfs/ now live in `db`
//
// Case: paths are looked up case-insensitively (as on Windows and macOS), but names keep the case they were first written with.
// `path` is the lower-cased lookup key and the primary key; `name` is the same path in its original case. The shim passes both
// (k = key, o = original); lookups, ranges and prefixes use `path`, and readdir answers with the last segment of `name`. An existing
// entry keeps its name when it is overwritten, as a file system does; a rename (including one that only changes case) sets the new name.
// A database made before `name` existed gets the column added on open, with `path` as the name (it was lower-case then).
// Names are assumed to be as long as their keys (true for every character but a few exotic ones such as U+0130), which lets a
// directory rename rewrite `name` with the same substr offsets as `path`.
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
CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, data BLOB NOT NULL, mtime INTEGER NOT NULL, name TEXT);
CREATE TABLE IF NOT EXISTS dirs (path TEXT PRIMARY KEY, name TEXT);
`;

const EMPTY = new Uint8Array(0);
const bytesOf = (v: unknown): Uint8Array =>
	v instanceof Uint8Array
		? v.constructor === Uint8Array
			? v
			: new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
		: v == null
			? EMPTY
			: typeof v === "string"
				? new TextEncoder().encode(v)
				: new Uint8Array(v as ArrayBuffer);
/** The proper ancestors of an original-case path as [key, name] pairs ("/a/B/c" gives ["/a", "/a"], ["/a/b", "/a/B"]). */
const ancestors = (o: string): [string, string][] => {
	const out: [string, string][] = [];
	for (let i = o.indexOf("/", 1); i !== -1; i = o.indexOf("/", i + 1)) {
		const n = o.slice(0, i);
		out.push([n.toLowerCase(), n]);
	}
	return out;
};
const lastPart = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export function createBlobBackend(db: BlobDb): DurableBackend {
	db.exec(SCHEMA);
	const q = (sql: string) => db.query(sql);
	// a database from before `name` existed: add the column, and the lower-cased path is the best name there is
	for (const table of ["files", "dirs"]) {
		let has = true;
		try {
			q(`SELECT name FROM ${table} LIMIT 0`).all();
		} catch {
			has = false;
		}
		if (!has)
			db.transaction(() => {
				db.exec(`ALTER TABLE ${table} ADD COLUMN name TEXT`);
				q(`UPDATE ${table} SET name = path WHERE name IS NULL`).run();
			})();
	}
	// directories known to exist in the dirs table, so a write does not re-insert its parents every time
	const known = new Set<string>();
	/** Make the ancestors of `o` (and `o` itself when `self`) exist; a directory that exists keeps its name. */
	const ensureDirs = (o: string, self = false) => {
		const list = self ? [...ancestors(o), [o.toLowerCase(), o] as [string, string]] : ancestors(o);
		for (const [d, name] of list) {
			if (known.has(d)) continue;
			q("INSERT OR IGNORE INTO dirs(path, name) VALUES (?, ?)").run(d, name);
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
	const write = db.transaction((k: string, data: Uint8Array, o: string) => {
		ensureDirs(o);
		q(
			"INSERT INTO files(path, data, mtime, name) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET data = excluded.data, mtime = excluded.mtime",
		).run(k, data, now(), o);
	});
	const append = db.transaction((k: string, data: Uint8Array, o: string) => {
		// `||` on blobs gives TEXT (length() would stop at a NUL byte); CAST back to BLOB keeps every byte
		const r: any = q("UPDATE files SET data = CAST(data || ? AS BLOB), mtime = ? WHERE path = ?").run(data, now(), k);
		if (!r.changes) write(k, data, o);
	});
	const rm = db.transaction((k: string) => {
		q("DELETE FROM files WHERE path = ? OR (path > ? AND path < ?)").run(k, lo(k), hi(k));
		q("DELETE FROM dirs WHERE path = ? OR (path > ? AND path < ?)").run(k, lo(k), hi(k));
		known.clear();
	});
	const rename = db.transaction((from: string, to: string, toName: string): boolean => {
		const isFile = !!q("SELECT 1 AS x FROM files WHERE path = ?").get(from);
		const isDir = !isFile && !!q("SELECT 1 AS x FROM dirs WHERE path = ?").get(from);
		if (!isFile && !isDir) return false;
		const cut = from.length + 1; // substr is 1-based: keep from the character at index from.length
		if (from === to) {
			// only the case changes: the key stays, the names are rewritten
			if (isFile) {
				q("UPDATE files SET name = ? WHERE path = ?").run(toName, from);
				return true;
			}
			q("UPDATE dirs SET name = ? WHERE path = ?").run(toName, from);
			q("UPDATE files SET name = ? || substr(name, ?) WHERE path > ? AND path < ?").run(toName, cut, lo(from), hi(from));
			q("UPDATE dirs SET name = ? || substr(name, ?) WHERE path > ? AND path < ?").run(toName, cut, lo(from), hi(from));
			return true;
		}
		if (isFile) {
			rm(to);
			ensureDirs(toName);
			q("UPDATE files SET path = ?, name = ?, mtime = mtime WHERE path = ?").run(to, toName, from);
			return true;
		}
		rm(to);
		ensureDirs(toName, true);
		q("UPDATE files SET path = ? || substr(path, ?), name = ? || substr(name, ?) WHERE path > ? AND path < ?").run(
			to,
			cut,
			toName,
			cut,
			lo(from),
			hi(from),
		);
		q(
			"INSERT OR IGNORE INTO dirs(path, name) SELECT ? || substr(path, ?), ? || substr(name, ?) FROM dirs WHERE path > ? AND path < ?",
		).run(to, cut, toName, cut, lo(from), hi(from));
		q("DELETE FROM dirs WHERE path = ? OR (path > ? AND path < ?)").run(from, lo(from), hi(from));
		known.clear();
		return true;
	});
	const copy = db.transaction((from: string, to: string, toName: string): boolean => {
		if (!q("SELECT 1 AS x FROM files WHERE path = ?").get(from)) return false;
		if (from === to) return true;
		ensureDirs(toName);
		q(
			"INSERT INTO files(path, data, mtime, name) SELECT ?, data, ?, ? FROM files WHERE path = ? ON CONFLICT(path) DO UPDATE SET data = excluded.data, mtime = excluded.mtime",
		).run(to, now(), toName, from);
		return true;
	});
	const truncate = db.transaction((k: string, len: number, o: string) => {
		const st = q("SELECT length(data) AS size FROM files WHERE path = ?").get(k);
		if (!st) {
			write(k, new Uint8Array(len), o);
			return;
		}
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
			const r =
				len === undefined
					? q("SELECT substr(data, ?) AS d FROM files WHERE path = ?").get(start + 1, k)
					: q("SELECT substr(data, ?, ?) AS d FROM files WHERE path = ?").get(start + 1, len, k);
			return r ? bytesOf(r.d) : undefined;
		},
		write(k, data, o) {
			write(k, data, o ?? k);
		},
		append(k, data, o) {
			append(k, data, o ?? k);
		},
		truncate(k, len, o) {
			truncate(k, len, o ?? k);
		},
		mkdir(k, o) {
			if (k !== "/") db.transaction(() => ensureDirs(o ?? k, true))();
		},
		readdir(k) {
			if (!q("SELECT 1 AS x FROM dirs WHERE path = ?").get(k)) return undefined;
			const from = k.length + 2; // the first character after "<k>/"
			const direct = (table: string) =>
				q(`SELECT COALESCE(name, path) AS name FROM ${table} WHERE path > ? AND path < ? AND instr(substr(path, ?), '/') = 0`).all(
					lo(k),
					hi(k),
					from,
				) as { name: string }[];
			return [
				...direct("dirs").map((r) => ({ name: lastPart(r.name), isDir: true })),
				...direct("files").map((r) => ({ name: lastPart(r.name), isDir: false })),
			];
		},
		rm(k) {
			rm(k);
		},
		rename(from, to, o) {
			return rename(from, to, o ?? to);
		},
		copy(from, to, o) {
			return copy(from, to, o ?? to);
		},
		utimes(k, mtimeMs) {
			q("UPDATE files SET mtime = ? WHERE path = ?").run(Math.floor(mtimeMs), k);
		},
	};
}
