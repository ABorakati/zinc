// node:fs for the browser build: an in-memory file system. Settings the app writes stay in this tab; files the demo needs (fonts,
// collection styles) are seeded by web/main.tsx with seedFile(). A path is looked up by its full form first, then by its last
// part, so seeded files are found wherever the app's code builds their path from.
//
// Durable paths: installDurableFs(backend) sends every path under a prefix (default "/opfs/") to a DurableBackend instead of the
// Map (see browser-db/blobfs.ts, which keeps them in a SQLite database). The calls stay synchronous. Every other path stays in memory.
type Data = Uint8Array;
const files = new Map<string, Data>();
const dirs = new Set<string>(["/"]);
const enc = new TextEncoder();
const dec = new TextDecoder();

/** What a durable backend answers for a path. `k` is always the shim's normalised key (lower-case, forward slashes, no trailing slash).
 * Methods that can create a name also get `o`: the same path with the caller's case kept, for the backend to remember and list. */
export interface DurableStat { size: number; mtimeMs: number; isDir: boolean }
export interface DurableBackend {
	/** undefined when nothing is there */
	stat(k: string): DurableStat | undefined;
	/** The bytes of a file (all of them, or `len` bytes from `pos`); undefined when there is no such file. Past the end gives fewer bytes. */
	read(k: string, pos?: number, len?: number): Uint8Array | undefined;
	/** Create or replace a file; the parent directories are implied. */
	write(k: string, data: Uint8Array, o?: string): void;
	/** Add to the end of a file (created when missing). */
	append(k: string, data: Uint8Array, o?: string): void;
	/** Cut a file to `len` bytes, or extend it with zeros (created when missing). */
	truncate(k: string, len: number, o?: string): void;
	/** Create a directory and its parents. */
	mkdir(k: string, o?: string): void;
	/** The direct children, or undefined when `k` is not a directory. */
	readdir(k: string): { name: string; isDir: boolean }[] | undefined;
	/** Remove a file, or a directory with everything under it. Nothing there is not an error. */
	rm(k: string): void;
	/** Move a file or a directory (with everything under it), replacing what is at `to`. Returns false when `from` does not exist. */
	rename(from: string, to: string, o?: string): boolean;
	/** Copy one file, replacing what is at `to`. Returns false when `from` is not a file. */
	copy(from: string, to: string, o?: string): boolean;
	utimes(k: string, mtimeMs: number): void;
}
let backend: DurableBackend | null = null;
let prefix = "/opfs/";
let prefixBare = "/opfs";

/** Send the paths under `prefix` (matched after key() lower-cases them) to `be`. Pass null to switch back to memory only. */
export function installDurableFs(be: DurableBackend | null, pfx = "/opfs/"): void {
	backend = be;
	prefix = pfx.endsWith("/") ? pfx.toLowerCase() : pfx.toLowerCase() + "/";
	prefixBare = prefix.slice(0, -1);
}
const dur = (k: string): DurableBackend | null => (backend && (k.startsWith(prefix) || k === prefixBare) ? backend : null);

// norm(): forward slashes, no trailing slash, case kept (what durable files are listed and exported as).
// key(): norm() lower-cased, for every lookup (memory paths, and the durable backend's primary key).
const norm = (p: unknown): string => {
	let s = p instanceof URL ? decodeURIComponent(p.pathname) : String(p);
	if (s.startsWith("file:")) s = decodeURIComponent(new URL(s).pathname);
	s = s.replace(/\\/g, "/").replace(/^\/([a-zA-Z]:)/, "$1");
	return s.length > 1 ? s.replace(/\/+$/, "") : s;
};
const key = (p: unknown): string => norm(p).toLowerCase();
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const find = (p: unknown): string | undefined => {
	const k = key(p);
	if (files.has(k)) return k;
	const b = base(k);
	for (const f of files.keys()) if (base(f) === b && seededByName.has(b)) return f;
	return undefined;
};
const seededByName = new Set<string>();
const err = (code: string, errno: number, text: string, op: string, p: unknown) => Object.assign(new Error(`${code}: ${text}, ${op} '${String(p)}'`), { code, errno, syscall: op, path: String(p) });
const enoent = (op: string, p: unknown) => err("ENOENT", -2, "no such file or directory", op, p);
const eisdir = (op: string, p: unknown) => err("EISDIR", -21, "illegal operation on a directory", op, p);
const enotdir = (op: string, p: unknown) => err("ENOTDIR", -20, "not a directory", op, p);
const eexist = (op: string, p: unknown) => err("EEXIST", -17, "file already exists", op, p);
const enotempty = (op: string, p: unknown) => err("ENOTEMPTY", -39, "directory not empty", op, p);
const toBytes = (d: unknown): Data => (typeof d === "string" ? enc.encode(d) : d instanceof Uint8Array ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : enc.encode(String(d)));
const out = (d: Data, o?: unknown) => {
	const encoding = typeof o === "string" ? o : (o as { encoding?: string } | undefined)?.encoding;
	return encoding ? dec.decode(d) : asBuffer(d);
};
// callers use Buffer methods on what readFileSync returns (toString, length): give them a Uint8Array that decodes on toString
const asBuffer = (d: Data) => Object.assign(d.slice(), { toString: (e?: string) => (e === "base64" ? b64(d) : dec.decode(d)) });
const b64 = (d: Data): string => { let s = ""; for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000)); return btoa(s); };
const mkdirs = (k: string) => { const parts = k.split("/"); for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/") || "/"); };
const parentOf = (k: string) => k.slice(0, k.lastIndexOf("/")) || "/";
const mkStat = (size: number, isDir: boolean, mtimeMs: number) => {
	const t = new Date(mtimeMs);
	return { size, isFile: () => !isDir, isDirectory: () => isDir, isSymbolicLink: () => false, mode: isDir ? 0o40755 : 0o100644, mtimeMs, atimeMs: mtimeMs, ctimeMs: mtimeMs, birthtimeMs: mtimeMs, mtime: t, atime: t, ctime: t, birthtime: t } as any;
};
const dirent = (name: string, isDir: boolean) => ({ name, isFile: () => !isDir, isDirectory: () => isDir, isSymbolicLink: () => false });

/** Put a file in the in-memory file system (by full path; `byName` also finds it by its file name from any directory). */
export function seedFile(path: string, data: Uint8Array | string, byName = false): void {
	const k = key(path);
	files.set(k, toBytes(data));
	mkdirs(k.slice(0, k.lastIndexOf("/")) || "/");
	if (byName) seededByName.add(base(k));
}

export function existsSync(p: unknown): boolean { const k = key(p); const d = dur(k); if (d) return !!d.stat(k); return !!find(p) || dirs.has(k); }
export function readFileSync(p: unknown, o?: unknown) {
	const k = key(p);
	const d = dur(k);
	if (d) {
		const st = d.stat(k);
		if (!st) throw enoent("open", p);
		if (st.isDir) throw eisdir("read", p);
		return out(d.read(k) ?? new Uint8Array(), o) as any;
	}
	const f = find(p);
	if (!f) throw enoent("open", p);
	return out(files.get(f)!, o) as any;
}
const flagOf = (o: unknown): string | undefined => (o && typeof o === "object" ? (o as { flag?: string }).flag : undefined);
export function writeFileSync(p: unknown, data: unknown, o?: unknown): void {
	const k = key(p);
	const d = dur(k);
	const flag = flagOf(o);
	if (d) {
		const st = d.stat(k);
		if (st?.isDir) throw eisdir("open", p);
		if (flag === "wx" && st) throw eexist("open", p);
		if (flag?.startsWith("a")) d.append(k, toBytes(data), norm(p)); else d.write(k, toBytes(data), norm(p));
		return;
	}
	if (flag === "wx" && files.has(k)) throw eexist("open", p);
	if (flag?.startsWith("a")) return appendFileSync(p, data);
	files.set(k, toBytes(data));
	mkdirs(parentOf(k));
}
export function appendFileSync(p: unknown, data: unknown): void {
	const k = key(p);
	const d = dur(k);
	if (d) { if (d.stat(k)?.isDir) throw eisdir("open", p); d.append(k, toBytes(data), norm(p)); return; }
	const prev = files.get(k) ?? new Uint8Array();
	const add = toBytes(data);
	const n = new Uint8Array(prev.length + add.length);
	n.set(prev);
	n.set(add, prev.length);
	files.set(k, n);
	mkdirs(parentOf(k));
}
export function mkdirSync(p: unknown, _o?: unknown): undefined { const k = key(p); const d = dur(k); if (d) d.mkdir(k, norm(p)); else mkdirs(k); return undefined; }
export function mkdtempSync(prefixStr: unknown): string { const p = `${String(prefixStr)}${Math.random().toString(36).slice(2, 8)}`; mkdirSync(p); return p; }
export function readdirSync(p: unknown, o?: { withFileTypes?: boolean }): any[] {
	const k = key(p);
	const d = dur(k);
	if (d) {
		const list = d.readdir(k);
		if (!list) throw d.stat(k) ? enotdir("scandir", p) : enoent("scandir", p);
		list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		return o?.withFileTypes ? list.map((e) => dirent(e.name, e.isDir)) : list.map((e) => e.name);
	}
	if (!dirs.has(k)) throw enoent("scandir", p);
	const pre = k === "/" ? "/" : k + "/";
	const names = new Set<string>();
	for (const f of [...files.keys(), ...dirs]) if (f.startsWith(pre) && f !== k) names.add(f.slice(pre.length).split("/")[0]!);
	const list = [...names].sort();
	return o?.withFileTypes ? list.map((n) => ({ name: n, isFile: () => files.has(pre + n), isDirectory: () => dirs.has(pre + n), isSymbolicLink: () => false })) : list;
}
export function statSync(p: unknown, o?: { throwIfNoEntry?: boolean }) {
	const k = key(p);
	const d = dur(k);
	if (d) {
		const st = d.stat(k);
		if (!st) { if (o?.throwIfNoEntry === false) return undefined as any; throw enoent("stat", p); }
		return mkStat(st.size, st.isDir, st.mtimeMs);
	}
	const f = find(p);
	if (!f && !dirs.has(k)) { if (o?.throwIfNoEntry === false) return undefined as any; throw enoent("stat", p); }
	const size = f ? files.get(f)!.length : 0;
	return mkStat(size, !f, 0);
}
export const lstatSync = statSync;
export function rmSync(p: unknown, _o?: unknown): void {
	const k = key(p);
	const d = dur(k);
	if (d) { d.rm(k); return; }
	files.delete(k);
	for (const f of [...files.keys()]) if (f.startsWith(k + "/")) files.delete(f);
	for (const f of [...dirs]) if (f === k || f.startsWith(k + "/")) dirs.delete(f);
}
export const unlinkSync = rmSync;
export function rmdirSync(p: unknown, _o?: unknown): void {
	const k = key(p);
	const d = dur(k);
	if (d) {
		const list = d.readdir(k);
		if (!list) { if (d.stat(k)) throw enotdir("rmdir", p); throw enoent("rmdir", p); }
		if (list.length) throw enotempty("rmdir", p);
		d.rm(k);
		return;
	}
	rmSync(p);
}
export function renameSync(a: unknown, b: unknown): void {
	const ka = key(a);
	const kb = key(b);
	const da = dur(ka);
	const db = dur(kb);
	if (da && db) { if (!da.rename(ka, kb, norm(b))) throw enoent("rename", a); return; }
	if (da || db) {
		// across the boundary: copy the bytes, then remove the source
		cpSync(a, b, { recursive: true });
		rmSync(a);
		return;
	}
	const f = find(a);
	if (!f) {
		if (!dirs.has(ka)) throw enoent("rename", a);
		for (const x of [...files.keys()]) if (x.startsWith(ka + "/")) { files.set(kb + x.slice(ka.length), files.get(x)!); files.delete(x); }
		for (const x of [...dirs]) if (x === ka || x.startsWith(ka + "/")) { dirs.delete(x); mkdirs(kb + x.slice(ka.length)); }
		return;
	}
	writeFileSync(b, files.get(f)!);
	files.delete(f);
}
export function copyFileSync(a: unknown, b: unknown): void {
	const ka = key(a);
	const kb = key(b);
	const da = dur(ka);
	const db = dur(kb);
	if (da && db) { if (!da.copy(ka, kb, norm(b))) throw enoent("copyfile", a); return; }
	if (da) { const bytes = da.read(ka); if (!bytes || da.stat(ka)?.isDir) throw enoent("copyfile", a); writeFileSync(b, bytes); return; }
	const f = find(a);
	if (!f) throw enoent("copyfile", a);
	writeFileSync(b, files.get(f)!);
}
export function utimesSync(p?: unknown, _atime?: unknown, mtime?: unknown): void {
	if (p === undefined) return;
	const k = key(p);
	const d = dur(k);
	if (!d) return;
	const ms = mtime instanceof Date ? mtime.getTime() : typeof mtime === "number" ? mtime * 1000 : Date.now();
	d.utimes(k, ms);
}
export function fsyncSync(): void {}

// file descriptors: open, positional or sequential read, append-style write, close. Memory and durable paths alike.
interface Fd { k: string; o: string; flags: string; pos: number }
const fds = new Map<number, Fd>();
let nextFd = 10;
export function openSync(p: unknown, flags: unknown = "r"): number {
	const k = key(p);
	const fl = typeof flags === "string" ? flags : "r";
	const d = dur(k);
	const reading = fl.startsWith("r");
	if (d) {
		const st = d.stat(k);
		if (st?.isDir && !reading) throw eisdir("open", p);
		if (reading && (!st || st.isDir)) throw st ? eisdir("read", p) : enoent("open", p);
		if (fl.includes("x") && st) throw eexist("open", p);
		if (fl.startsWith("w") || (!st && !reading)) d.write(k, new Uint8Array(), norm(p));
	} else if (reading) {
		if (!find(p)) throw enoent("open", p);
	} else {
		if (fl.includes("x") && files.has(k)) throw eexist("open", p);
		if (fl.startsWith("w") || !files.has(k)) writeFileSync(p, "");
	}
	const fd = nextFd++;
	fds.set(fd, { k: reading && !d ? find(p)! : k, o: norm(p), flags: fl, pos: 0 });
	return fd;
}
const badFd = (op: string) => err("EBADF", -9, "bad file descriptor", op, "");
export function writeSync(fd: number, data: unknown, a?: unknown, b?: unknown, c?: unknown): number {
	const f = fds.get(fd);
	if (!f) throw badFd("write");
	let bytes: Uint8Array;
	let at: number | null = null;
	if (typeof data === "string") { bytes = enc.encode(data); at = typeof a === "number" ? a : null; }
	else {
		const all = toBytes(data);
		const off = typeof a === "number" ? a : 0;
		const len = typeof b === "number" ? b : all.length - off;
		bytes = all.subarray(off, off + len);
		at = typeof c === "number" ? c : null;
	}
	const d = dur(f.k);
	const size = d ? (d.stat(f.k)?.size ?? 0) : (files.get(f.k)?.length ?? 0);
	if (at !== null && at < size && !f.flags.startsWith("a")) {
		// a write inside the file: splice it in
		const cur = d ? (d.read(f.k) ?? new Uint8Array()) : files.get(f.k)!;
		const merged = new Uint8Array(Math.max(size, at + bytes.length));
		merged.set(cur);
		merged.set(bytes, at);
		if (d) d.write(f.k, merged, f.o); else files.set(f.k, merged);
	} else {
		if (at !== null && at > size) { const pad = new Uint8Array(at - size); if (d) d.append(f.k, pad, f.o); else appendFileSync(f.k, pad); }
		if (d) d.append(f.k, bytes, f.o); else appendFileSync(f.k, bytes);
	}
	f.pos = (at ?? size) + bytes.length;
	return bytes.length;
}
export function readSync(fd: number, buf: Uint8Array, off?: unknown, len?: unknown, pos?: unknown): number {
	const f = fds.get(fd);
	if (!f) throw badFd("read");
	let o = typeof off === "number" ? off : 0;
	let n = typeof len === "number" ? len : buf.length - o;
	if (off && typeof off === "object") { const opt = off as { offset?: number; length?: number; position?: number | null }; o = opt.offset ?? 0; n = opt.length ?? buf.length - o; pos = opt.position; }
	const at = typeof pos === "number" ? pos : pos === undefined || pos === null ? f.pos : Number(pos);
	const d = dur(f.k);
	const part = d ? (d.read(f.k, at, n) ?? new Uint8Array()) : (files.get(f.k) ?? new Uint8Array()).subarray(at, at + n);
	buf.set(part, o);
	if (typeof pos !== "number") f.pos = at + part.length;
	return part.length;
}
export function closeSync(fd: number): void { fds.delete(fd); }
export function ftruncateSync(fd?: number, len = 0): void { const f = fd === undefined ? undefined : fds.get(fd); if (f) truncateSync(f.k, len); }
export function fstatSync(fd: number) { return statSync(fds.get(fd)?.k ?? "/"); }
export function truncateSync(p: unknown, len = 0): void {
	const k = key(p);
	const d = dur(k);
	if (d) { if (d.stat(k)?.isDir) throw eisdir("open", p); d.truncate(k, len, norm(p)); return; }
	const cur = files.get(k) ?? new Uint8Array();
	const n = new Uint8Array(len);
	n.set(cur.subarray(0, len));
	files.set(k, n);
}

// a minimal event emitter for the streams below
type Listener = (...a: unknown[]) => void;
const emitter = () => {
	const l = new Map<string, Listener[]>();
	const on = (e: string, f: Listener) => { (l.get(e) ?? l.set(e, []).get(e)!).push(f); };
	const emit = (e: string, ...a: unknown[]) => { for (const f of l.get(e) ?? []) f(...a); };
	return { on, emit };
};
export function createWriteStream(p: unknown, o?: unknown) {
	const em = emitter();
	let closed = false;
	let failed = false;
	const fail = (e: unknown) => { if (!failed) { failed = true; queueMicrotask(() => em.emit("error", e)); } };
	try {
		if (flagOf(o)?.startsWith("a")) { if (!existsSync(p)) writeFileSync(p, ""); } else writeFileSync(p, "");
	} catch (e) { fail(e); }
	const s = {
		write(d: unknown, enc2?: unknown, cb?: unknown) {
			const f = typeof enc2 === "function" ? enc2 : typeof cb === "function" ? cb : undefined;
			try { appendFileSync(p, d); (f as ((e?: unknown) => void) | undefined)?.(); } catch (e) { fail(e); (f as ((e?: unknown) => void) | undefined)?.(e); }
			return true;
		},
		end(d?: unknown, enc2?: unknown, cb?: unknown) {
			const f = [d, enc2, cb].find((x) => typeof x === "function") as (() => void) | undefined;
			if (d !== undefined && d !== null && typeof d !== "function") s.write(d);
			if (!closed) { closed = true; queueMicrotask(() => { if (!failed) { em.emit("finish"); em.emit("close"); } }); }
			if (f) queueMicrotask(f);
			return s;
		},
		close(cb?: () => void) { s.end(); if (cb) queueMicrotask(cb); },
		destroy() { closed = true; return s; },
		on(e: string, f: Listener) { em.on(e, f); return s; },
		once(e: string, f: Listener) { em.on(e, f); return s; },
		off() { return s; },
		removeListener() { return s; },
		get writable() { return !closed; },
		path: String(p),
	};
	return s;
}
export function createReadStream(p: unknown, o?: unknown) {
	const em = emitter();
	const opt = (typeof o === "object" && o ? o : {}) as { start?: number; end?: number; highWaterMark?: number; encoding?: string };
	const chunk = opt.highWaterMark ?? 1024 * 1024;
	let started = false;
	const run = () => {
		if (started) return;
		started = true;
		// the data and end events come after the caller has attached its listeners
		setTimeout(() => {
			try {
				const st = statSync(p);
				if (st.isDirectory()) throw eisdir("read", p);
				const fd = openSync(p, "r");
				try {
					const end = opt.end === undefined ? st.size : Math.min(st.size, opt.end + 1);
					for (let pos = opt.start ?? 0; pos < end; pos += chunk) {
						const buf = new Uint8Array(Math.min(chunk, end - pos));
						const n = readSync(fd, buf, 0, buf.length, pos);
						if (!n) break;
						em.emit("data", opt.encoding ? dec.decode(buf.subarray(0, n)) : asBuffer(buf.subarray(0, n)));
					}
				} finally { closeSync(fd); }
				em.emit("end");
				em.emit("close");
			} catch (e) { em.emit("error", e); }
		}, 0);
	};
	const s = {
		on(e: string, f: Listener) { em.on(e, f); if (e === "data" || e === "end" || e === "readable") run(); return s; },
		once(e: string, f: Listener) { return s.on(e, f); },
		pipe(dest: { write(d: unknown): unknown; end(): unknown }) { s.on("data", (c) => dest.write(c)); s.on("end", () => dest.end()); return dest; },
		destroy() { started = true; return s; },
		close(cb?: () => void) { started = true; if (cb) queueMicrotask(cb); },
		path: String(p),
		async *[Symbol.asyncIterator]() {
			const bytes = readFileSync(p) as Uint8Array;
			for (let pos = opt.start ?? 0; pos < (opt.end === undefined ? bytes.length : opt.end + 1); pos += chunk) yield bytes.subarray(pos, Math.min(pos + chunk, opt.end === undefined ? bytes.length : opt.end + 1));
		},
	};
	return s;
}
export function watch() { return { close() {}, on() { return this; } }; }
export function realpathSync(p: unknown): string { return String(p); }
export function accessSync(p: unknown): void { if (!existsSync(p)) throw enoent("access", p); }
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };
export function statfsSync() { return { bsize: 4096, blocks: 2 ** 24, bfree: 2 ** 23, bavail: 2 ** 23 }; }
export class FSWatcher { close() {} on() { return this; } }
export function linkSync(a: unknown, b: unknown): void { copyFileSync(a, b); }
export const symlinkSync = linkSync;
export function readlinkSync(p: unknown): string { return String(p); }
export function chmodSync(): void {}
/** Copy a file, or with `recursive` a directory and everything under it (either side may be durable). */
export function cpSync(a: unknown, b: unknown, o?: { recursive?: boolean }): void {
	const st = statSync(a, { throwIfNoEntry: false });
	if (!st) throw enoent("cp", a);
	if (!st.isDirectory()) { copyFileSync(a, b); return; }
	if (!o?.recursive) throw err("ERR_FS_EISDIR", -21, "Recursive option is required to copy a directory", "cp", a);
	mkdirSync(b);
	for (const name of readdirSync(a) as string[]) cpSync(`${norm(a)}/${name}`, `${norm(b)}/${name}`, o);
}
export function opendirSync(p: unknown) { const list = readdirSync(p, { withFileTypes: true }); let i = 0; return { readSync: () => list[i++] ?? null, closeSync() {}, close: async () => {} }; }

export const promises = {
	readFile: async (p: unknown, o?: unknown) => readFileSync(p, o),
	writeFile: async (p: unknown, d: unknown, o?: unknown) => writeFileSync(p, d, o),
	appendFile: async (p: unknown, d: unknown) => appendFileSync(p, d),
	mkdir: async (p: unknown, o?: unknown) => mkdirSync(p, o),
	mkdtemp: async (p: unknown) => mkdtempSync(p),
	copyFile: async (a: unknown, b: unknown) => copyFileSync(a, b),
	cp: async (a: unknown, b: unknown, o?: { recursive?: boolean }) => cpSync(a, b, o),
	rename: async (a: unknown, b: unknown) => renameSync(a, b),
	stat: async (p: unknown, o?: { throwIfNoEntry?: boolean }) => statSync(p, o),
	lstat: async (p: unknown, o?: { throwIfNoEntry?: boolean }) => statSync(p, o),
	readdir: async (p: unknown, o?: { withFileTypes?: boolean }) => readdirSync(p, o),
	unlink: async (p: unknown) => rmSync(p),
	rm: async (p: unknown, o?: unknown) => rmSync(p, o),
	rmdir: async (p: unknown) => rmdirSync(p),
	access: async (p: unknown) => accessSync(p),
	truncate: async (p: unknown, len?: number) => truncateSync(p, len),
	utimes: async (p: unknown, a?: unknown, m?: unknown) => utimesSync(p, a, m),
	realpath: async (p: unknown) => realpathSync(p),
	open: async (p: unknown, flags: string = "r") => {
		const fd = openSync(p, flags);
		const handle = {
			fd,
			// a positional read: only the requested range is fetched (substr on the blob for a durable file)
			read: async (buf: Uint8Array, off?: number, len?: number, pos?: number | null) => {
				const n = readSync(fd, buf, off ?? 0, len ?? buf.length - (off ?? 0), pos ?? null);
				return { bytesRead: n, buffer: buf };
			},
			readFile: async (o?: unknown) => readFileSync(fds.get(fd)!.k, o),
			write: async (d: unknown, a?: unknown, b?: unknown, c?: unknown) => { const n = writeSync(fd, d, a, b, c); return { bytesWritten: n, buffer: d }; },
			writeFile: async (d: unknown) => { writeSync(fd, d); },
			appendFile: async (d: unknown) => { writeSync(fd, d); },
			truncate: async (len?: number) => ftruncateSync(fd, len),
			stat: async () => fstatSync(fd),
			sync: async () => {},
			datasync: async () => {},
			close: async () => closeSync(fd),
			[Symbol.asyncDispose]: async () => closeSync(fd),
		};
		return handle;
	},
};

// callback style: (args..., cb(err, value))
const cbify = <A extends unknown[]>(f: (...a: A) => unknown) => (...a: unknown[]) => {
	const cb = typeof a[a.length - 1] === "function" ? (a.pop() as (e: unknown, v?: unknown) => void) : undefined;
	queueMicrotask(() => { try { const v = f(...(a as A)); cb?.(null, v); } catch (e) { cb?.(e); } });
};
export const readFile = cbify(readFileSync);
export const writeFile = cbify(writeFileSync);
export const appendFile = cbify(appendFileSync);
export const mkdir = cbify(mkdirSync);
export const stat = cbify(statSync);
export const lstat = cbify(statSync);
export const readdir = cbify(readdirSync);
export const unlink = cbify(rmSync);
export const rm = cbify(rmSync);
export const copyFile = cbify(copyFileSync);
export const rename = cbify(renameSync);
export const access = cbify(accessSync);
export const exists = (p: unknown, cb: (ok: boolean) => void) => queueMicrotask(() => cb(existsSync(p)));

export default { readFile, writeFile, appendFile, mkdir, stat, lstat, readdir, unlink, rm, copyFile, rename, access, exists, existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, lstatSync, rmSync, unlinkSync, rmdirSync, renameSync, copyFileSync, cpSync, truncateSync, ftruncateSync, fstatSync, utimesSync, fsyncSync, openSync, writeSync, readSync, closeSync, createWriteStream, createReadStream, watch, realpathSync, accessSync, constants, promises };
