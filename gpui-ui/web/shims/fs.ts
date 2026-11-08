// node:fs for the browser demo: an in-memory file system. Settings the app writes stay in this tab; files the demo needs (fonts,
// collection styles) are seeded by web/main.tsx with seedFile(). A path is looked up by its full form first, then by its last
// part, so seeded files are found wherever the app's code builds their path from.
type Data = Uint8Array;
const files = new Map<string, Data>();
const dirs = new Set<string>(["/"]);
const enc = new TextEncoder();
const dec = new TextDecoder();

const key = (p: unknown): string => {
	let s = p instanceof URL ? decodeURIComponent(p.pathname) : String(p);
	if (s.startsWith("file:")) s = decodeURIComponent(new URL(s).pathname);
	s = s.replace(/\\/g, "/").replace(/^\/([a-zA-Z]:)/, "$1").toLowerCase();
	return s.length > 1 ? s.replace(/\/+$/, "") : s;
};
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const find = (p: unknown): string | undefined => {
	const k = key(p);
	if (files.has(k)) return k;
	const b = base(k);
	for (const f of files.keys()) if (base(f) === b && seededByName.has(b)) return f;
	return undefined;
};
const seededByName = new Set<string>();
const enoent = (op: string, p: unknown) => Object.assign(new Error(`ENOENT: no such file or directory, ${op} '${String(p)}'`), { code: "ENOENT", errno: -2, syscall: op, path: String(p) });
const toBytes = (d: unknown): Data => (typeof d === "string" ? enc.encode(d) : d instanceof Uint8Array ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : enc.encode(String(d)));
const out = (d: Data, o?: unknown) => {
	const encoding = typeof o === "string" ? o : (o as { encoding?: string } | undefined)?.encoding;
	return encoding ? dec.decode(d) : asBuffer(d);
};
// callers use Buffer methods on what readFileSync returns (toString, length): give them a Uint8Array that decodes on toString
const asBuffer = (d: Data) => Object.assign(d.slice(), { toString: (e?: string) => (e === "base64" ? btoa(String.fromCharCode(...d)) : dec.decode(d)) });
const mkdirs = (k: string) => { const parts = k.split("/"); for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/") || "/"); };

/** Put a file in the in-memory file system (by full path; `byName` also finds it by its file name from any directory). */
export function seedFile(path: string, data: Uint8Array | string, byName = false): void {
	const k = key(path);
	files.set(k, toBytes(data));
	mkdirs(k.slice(0, k.lastIndexOf("/")) || "/");
	if (byName) seededByName.add(base(k));
}

export function existsSync(p: unknown): boolean { const k = key(p); return !!find(p) || dirs.has(k); }
export function readFileSync(p: unknown, o?: unknown) { const f = find(p); if (!f) throw enoent("open", p); return out(files.get(f)!, o) as any; }
export function writeFileSync(p: unknown, d: unknown): void { const k = key(p); files.set(k, toBytes(d)); mkdirs(k.slice(0, k.lastIndexOf("/")) || "/"); }
export function appendFileSync(p: unknown, d: unknown): void { const k = key(p); const prev = files.get(k) ?? new Uint8Array(); const add = toBytes(d); const n = new Uint8Array(prev.length + add.length); n.set(prev); n.set(add, prev.length); files.set(k, n); }
export function mkdirSync(p: unknown): undefined { mkdirs(key(p)); return undefined; }
export function mkdtempSync(prefix: unknown): string { const p = `${String(prefix)}${Math.random().toString(36).slice(2, 8)}`; mkdirs(key(p)); return p; }
export function readdirSync(p: unknown, o?: { withFileTypes?: boolean }): any[] {
	const k = key(p);
	if (!dirs.has(k)) throw enoent("scandir", p);
	const pre = k === "/" ? "/" : k + "/";
	const names = new Set<string>();
	for (const f of [...files.keys(), ...dirs]) if (f.startsWith(pre) && f !== k) names.add(f.slice(pre.length).split("/")[0]!);
	const list = [...names].sort();
	return o?.withFileTypes ? list.map((n) => ({ name: n, isFile: () => files.has(pre + n), isDirectory: () => dirs.has(pre + n), isSymbolicLink: () => false })) : list;
}
export function statSync(p: unknown, o?: { throwIfNoEntry?: boolean }) {
	const f = find(p);
	const k = key(p);
	if (!f && !dirs.has(k)) { if (o?.throwIfNoEntry === false) return undefined as any; throw enoent("stat", p); }
	const size = f ? files.get(f)!.length : 0;
	return { size, isFile: () => !!f, isDirectory: () => !f, isSymbolicLink: () => false, mtimeMs: 0, mtime: new Date(0), ctimeMs: 0, birthtimeMs: 0 } as any;
}
export const lstatSync = statSync;
export function rmSync(p: unknown): void { const k = key(p); files.delete(k); for (const f of [...files.keys()]) if (f.startsWith(k + "/")) files.delete(f); dirs.delete(k); }
export const unlinkSync = rmSync;
export const rmdirSync = rmSync;
export function renameSync(a: unknown, b: unknown): void { const f = find(a); if (!f) throw enoent("rename", a); writeFileSync(b, files.get(f)!); files.delete(f); }
export function copyFileSync(a: unknown, b: unknown): void { const f = find(a); if (!f) throw enoent("copyfile", a); writeFileSync(b, files.get(f)!); }
export function utimesSync(): void {}
export function fsyncSync(): void {}
// file descriptors: enough for append-only logs (open, write, close)
const fds = new Map<number, string>();
let nextFd = 10;
export function openSync(p: unknown): number { const fd = nextFd++; fds.set(fd, key(p)); if (!files.has(key(p))) writeFileSync(p, ""); return fd; }
export function writeSync(fd: number, d: unknown): number { const k = fds.get(fd); if (k) appendFileSync(k, d); return toBytes(d).length; }
export function readSync(): number { return 0; }
export function closeSync(fd: number): void { fds.delete(fd); }
export function createWriteStream(p: unknown) { writeFileSync(p, ""); return { write: (d: unknown) => (appendFileSync(p, d), true), end: (cb?: () => void) => cb?.(), on() { return this; }, once() { return this; }, close: (cb?: () => void) => cb?.() }; }
export function createReadStream(p: unknown): never { throw enoent("open", p); }
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
export function truncateSync(p: unknown): void { writeFileSync(p, ""); }
export function ftruncateSync(): void {}
export function fstatSync(fd: number) { return statSync(fds.get(fd) ?? "/"); }
export function cpSync(a: unknown, b: unknown): void { if (find(a)) copyFileSync(a, b); }
export function opendirSync(p: unknown) { const list = readdirSync(p, { withFileTypes: true }); let i = 0; return { readSync: () => list[i++] ?? null, closeSync() {}, close: async () => {} }; }

export const promises = {
	readFile: async (p: unknown, o?: unknown) => readFileSync(p, o),
	writeFile: async (p: unknown, d: unknown) => writeFileSync(p, d),
	appendFile: async (p: unknown, d: unknown) => appendFileSync(p, d),
	mkdir: async (p: unknown) => mkdirSync(p),
	copyFile: async (a: unknown, b: unknown) => copyFileSync(a, b),
	rename: async (a: unknown, b: unknown) => renameSync(a, b),
	stat: async (p: unknown) => statSync(p),
	readdir: async (p: unknown, o?: { withFileTypes?: boolean }) => readdirSync(p, o),
	unlink: async (p: unknown) => rmSync(p),
	rm: async (p: unknown) => rmSync(p),
	access: async (p: unknown) => accessSync(p),
	open: async (p: unknown) => { const fd = openSync(p); return { write: async (d: unknown) => writeSync(fd, d), close: async () => closeSync(fd), sync: async () => {} }; },
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

export default { readFile, writeFile, appendFile, mkdir, stat, lstat, readdir, unlink, rm, copyFile, rename, access, exists, existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, lstatSync, rmSync, unlinkSync, rmdirSync, renameSync, copyFileSync, utimesSync, fsyncSync, openSync, writeSync, readSync, closeSync, createWriteStream, createReadStream, watch, realpathSync, accessSync, constants, promises };
