// bun:sqlite's Database, enough of it for the core, on SQLite compiled to WebAssembly (@sqlite.org/sqlite-wasm), for the browser
// demo of the app (web/main.tsx). The demo build maps `bun:sqlite` to this module. Call initSqlite() and registerDatabase() before
// anything opens a database: `new Database(path)` then opens an in-memory copy of the bytes registered for that path.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
type Value = string | number | bigint | boolean | null | undefined | Uint8Array;
type Params = Value[] | [Record<string, Value>];

let sqlite3: Sqlite3 | null = null;
const images = new Map<string, Uint8Array>();

/** The opfs-sahpool VFS, once installPool() ran (inside the browser library's DB worker): databases under /opfs/zinc/ then live in it. */
let pool: { OpfsSAHPoolDb: new (name: string, flags?: string) => any } | null = null;

export async function initSqlite(): Promise<void> {
	sqlite3 ??= await sqlite3InitModule();
}

/**
 * Install the opfs-sahpool VFS (browser library, web/browser-db/db-worker.ts; needs a dedicated worker, no SharedArrayBuffer). After it,
 * `new Database("/opfs/zinc/<name>.sqlite")` opens the pool database "/zinc/<name>.sqlite" (library.sqlite, and files.sqlite for the
 * durable file store); `db.filename` stays the /opfs/ path the core builds its storage paths from. The pool belongs to one context at a
 * time: right after a reload the previous owner may still hold it, so a failed install is retried for a few seconds.
 */
export async function installPool(directory = ".zinc-sahpool"): Promise<void> {
	await initSqlite();
	let last: unknown;
	for (let i = 0; i < 40; i++) {
		try {
			pool = await (lib() as any).installOpfsSAHPoolVfs({ directory, name: "opfs-sahpool", initialCapacity: 12, clearOnInit: false, forceReinitIfPreviouslyFailed: true });
			return;
		} catch (e) { last = e; await new Promise((r) => setTimeout(r, 250)); }
	}
	throw new Error(`cannot open the browser library's storage: ${last instanceof Error ? last.message : last}`);
}

const POOL_PREFIX = "/opfs/zinc/";

/** The bytes `new Database(path)` opens (as an in-memory copy; nothing is written back). */
export function registerDatabase(path: string, bytes: Uint8Array): void {
	images.set(norm(path), bytes);
}

const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
const lib = (): Sqlite3 => {
	if (!sqlite3) throw new Error("bun:sqlite shim: initSqlite() was not awaited");
	return sqlite3;
};

const toBind = (v: Value): string | number | bigint | null | Uint8Array => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);

export class Statement {
	private stmt: any;
	private names: string[] = [];
	constructor(private db: Database, readonly sql: string) {
		this.stmt = db.raw.prepare(sql);
		const n = lib().capi.sqlite3_bind_parameter_count(this.stmt.pointer);
		for (let i = 1; i <= n; i++) this.names.push(lib().capi.sqlite3_bind_parameter_name(this.stmt.pointer, i) ?? "");
	}
	get columnNames(): string[] { return this.stmt.getColumnNames(); }
	private bind(params: Params): void {
		this.stmt.reset(true);
		if (params.length === 0) return;
		const one = params[0];
		if (params.length === 1 && one !== null && typeof one === "object" && !(one instanceof Uint8Array)) {
			// named: bun accepts {$id: 1} and, in strict mode, {id: 1}; bind by the statement's own parameter names
			const o = one as Record<string, Value>;
			this.names.forEach((name, i) => {
				if (!name) return;
				const key = name in o ? name : name.slice(1);
				if (key in o) this.stmt.bind(i + 1, toBind(o[key]));
			});
			return;
		}
		params.forEach((v, i) => this.stmt.bind(i + 1, toBind(v as Value)));
	}
	all(...params: Params): Record<string, unknown>[] {
		this.bind(params);
		const rows: Record<string, unknown>[] = [];
		while (this.stmt.step()) rows.push(this.stmt.get({}));
		this.stmt.reset();
		return rows;
	}
	get(...params: Params): Record<string, unknown> | null {
		this.bind(params);
		const row = this.stmt.step() ? this.stmt.get({}) : null;
		this.stmt.reset();
		return row;
	}
	values(...params: Params): unknown[][] {
		this.bind(params);
		const rows: unknown[][] = [];
		while (this.stmt.step()) rows.push(this.stmt.get([]));
		this.stmt.reset();
		return rows;
	}
	*iterate(...params: Params): IterableIterator<Record<string, unknown>> {
		this.bind(params);
		try { while (this.stmt.step()) yield this.stmt.get({}); } finally { this.stmt.reset(); }
	}
	run(...params: Params): { changes: number; lastInsertRowid: number } {
		this.bind(params);
		this.stmt.step();
		this.stmt.reset();
		return { changes: this.db.raw.changes(), lastInsertRowid: Number(lib().capi.sqlite3_last_insert_rowid(this.db.raw.pointer)) };
	}
	as(): this { return this; }
	finalize(): void { this.stmt.finalize(); }
	toString(): string { return this.sql; }
}

export class Database {
	readonly raw: any;
	readonly filename: string;
	private cache = new Map<string, Statement>();
	private depth = 0;
	private walless = false;
	constructor(filename = ":memory:", _options?: unknown) {
		const s = lib();
		this.filename = filename;
		// a database under /opfs/zinc/ goes to the sahpool VFS when it is installed (see installPool)
		if (pool && norm(filename).startsWith(POOL_PREFIX)) {
			this.raw = new pool.OpfsSAHPoolDb(`/zinc/${filename.replace(/\\/g, "/").slice(POOL_PREFIX.length)}`);
			// sahpool holds its files exclusively (no shared memory for a WAL index, no second connection): WAL does not apply to it
			this.walless = true;
			return;
		}
		this.raw = new s.oo1.DB(":memory:", "c");
		const image = images.get(norm(filename));
		if (image) {
			// a WAL-mode file (header bytes 18-19 = 2) cannot be opened from memory: mark the copy as rollback-journal mode
			const bytes = image.slice();
			if (bytes[18] === 2) bytes[18] = 1;
			if (bytes[19] === 2) bytes[19] = 1;
			const p = s.wasm.allocFromTypedArray(bytes);
			const flags = s.capi.SQLITE_DESERIALIZE_FREEONCLOSE | s.capi.SQLITE_DESERIALIZE_RESIZEABLE;
			this.raw.checkRc(s.capi.sqlite3_deserialize(this.raw.pointer, "main", p, bytes.byteLength, bytes.byteLength, flags));
		}
	}
	get inTransaction(): boolean { return this.depth > 0 || !lib().capi.sqlite3_get_autocommit(this.raw.pointer); }
	query(sql: string): Statement {
		let st = this.cache.get(sql);
		if (!st) { st = new Statement(this, sql); this.cache.set(sql, st); }
		return st;
	}
	prepare(sql: string): Statement { return new Statement(this, sql); }
	exec(sql: string, ...params: Params): { changes: number; lastInsertRowid: number } { return this.run(sql, ...params); }
	run(sql: string, ...params: Params): { changes: number; lastInsertRowid: number } {
		// the core's migrations ask for WAL; a sahpool database keeps its rollback journal
		if (this.walless) sql = sql.replace(/PRAGMA\s+journal_mode\s*=\s*WAL\s*;?/gi, "");
		if (params.length) return this.prepare(sql).run(...params);
		this.raw.exec(sql);
		return { changes: this.raw.changes(), lastInsertRowid: Number(lib().capi.sqlite3_last_insert_rowid(this.raw.pointer)) };
	}
	transaction<A extends unknown[], R>(fn: (...args: A) => R): ((...args: A) => R) & { deferred: (...args: A) => R; immediate: (...args: A) => R; exclusive: (...args: A) => R } {
		const wrap = (begin: string) => (...args: A): R => {
			const nested = this.depth > 0;
			const sp = `sp${this.depth}`;
			this.raw.exec(nested ? `SAVEPOINT ${sp}` : begin);
			this.depth++;
			try {
				const r = fn(...args);
				this.depth--;
				this.raw.exec(nested ? `RELEASE ${sp}` : "COMMIT");
				return r;
			} catch (e) {
				this.depth--;
				this.raw.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : "ROLLBACK");
				throw e;
			}
		};
		return Object.assign(wrap("BEGIN"), { deferred: wrap("BEGIN DEFERRED"), immediate: wrap("BEGIN IMMEDIATE"), exclusive: wrap("BEGIN EXCLUSIVE") });
	}
	serialize(): Uint8Array { return lib().capi.sqlite3_js_db_export(this.raw.pointer); }
	loadExtension(): void { throw new Error("extensions are not available in the browser demo"); }
	close(): void {
		for (const st of this.cache.values()) try { st.finalize(); } catch {}
		this.cache.clear();
		this.raw.close();
	}
}

export default Database;
