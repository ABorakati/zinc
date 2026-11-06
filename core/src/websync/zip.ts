// Minimal ZIP reader for zotero.org web snapshots (the page plus its resources, stored or deflated; no ZIP64,
// no encryption). There is no zip library in core, and snapshots only need reading.
//
// The archive comes from the network, so it is untrusted: entry names are checked against zip-slip (see safeEntryName and
// entryTarget), the sizes it declares are bounded (per entry, in total, and against the deflate ratio), entries may not
// overlap, and every malformed or truncated archive fails with a ZipError instead of a bare RangeError.

import { isAbsolute, relative, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

export interface ZipFile {
	/** Path inside the archive, forward slashes, never absolute and never containing "..". */
	name: string;
	data: Uint8Array;
}

/** What readZip throws for an archive it cannot or will not read. */
export class ZipError extends Error {
	override name = "ZipError";
}

export interface ZipLimits {
	/** Largest single entry once inflated (declared size). */
	maxEntry: number;
	/** Largest sum of all entries once inflated. */
	maxTotal: number;
	/** Most file entries. */
	maxEntries: number;
}
export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntry: 1024 * 1024 * 1024, maxTotal: 1024 * 1024 * 1024, maxEntries: 20000 };

// deflate cannot expand more than 1032:1; anything claiming more is lying about its size
const MAX_RATIO = 1100;

export function isZip(b: Uint8Array): boolean {
	return b.length > 22 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

// Windows device names: opening "con.html" or "NUL" talks to the device instead of making a file
const DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

function unsafeParts(n: string): boolean {
	if (!n || n.startsWith("/") || /^[A-Za-z]:/.test(n)) return true;
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(n)) return true; // NUL and the other control characters
	const parts = n.split("/").filter((p) => p !== "" && p !== ".");
	if (parts.length === 0) return true;
	for (const p of parts) {
		// Windows drops trailing dots and spaces from a name, so ".. " and "..." are ".." and "." there
		const trimmed = p.replace(/[. ]+$/, "");
		if (p === ".." || trimmed === "" || trimmed === "..") return true;
		if (p.includes(":")) return true; // drive letters, alternate data streams ("page.html:evil")
		if (DEVICE.test(trimmed)) return true;
	}
	return false;
}

/** A safe relative path for an archive entry, or null when it would escape the target folder. */
export function safeEntryName(raw: string): string | null {
	// characters Windows cannot have in a file name would make the write fail; they become "_" like attachment file names do
	const n = raw.replaceAll("\\", "/").replace(/[<>"|?*]/g, "_");
	if (unsafeParts(n)) return null;
	// compatibility forms (fullwidth dots and slashes, ...) must not turn into a traversal on a file system that normalises them
	const k = n.normalize("NFKC").replaceAll("\\", "/");
	if (k !== n && unsafeParts(k)) return null;
	return n
		.split("/")
		.filter((p) => p !== "" && p !== ".")
		.join("/");
}

/**
 * The absolute path an entry would be written to under `dir`, or null when its name is unsafe or the resolved path is
 * not strictly inside `dir`. Writers use this, so the containment check holds even if safeEntryName has a gap.
 */
export function entryTarget(dir: string, name: string): string | null {
	const safe = safeEntryName(name);
	if (!safe) return null;
	const root = resolve(dir);
	const target = resolve(root, safe);
	const rel = relative(root, target);
	if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) return null;
	return target;
}

/** All file entries of the archive. Directories and entries with unsafe names are left out. */
export function readZip(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): ZipFile[] {
	const lim = { ...DEFAULT_ZIP_LIMITS, ...limits };
	try {
		return read(bytes, lim);
	} catch (e) {
		if (e instanceof ZipError) throw e;
		// RangeError from a read past the end of the buffer, zlib errors, ...
		throw new ZipError(e instanceof RangeError ? "truncated or corrupt zip" : `corrupt zip entry: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
	}
}

function read(bytes: Uint8Array, lim: ZipLimits): ZipFile[] {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let eocd = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
		if (v.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new ZipError("not a zip file");
	const count = v.getUint16(eocd + 10, true);
	let p = v.getUint32(eocd + 16, true);
	if (count === 0xffff || p === 0xffffffff) throw new ZipError("zip64 archives are not supported");
	if (count > lim.maxEntries) throw new ZipError("zip has too many entries");
	const out: ZipFile[] = [];
	let total = 0; // declared uncompressed bytes so far
	let packed = 0; // compressed bytes read so far: more than the archive holds means entries overlap
	for (let i = 0; i < count; i++) {
		if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw new ZipError("corrupt zip directory");
		const method = v.getUint16(p + 10, true);
		const compSize = v.getUint32(p + 20, true);
		const size = v.getUint32(p + 24, true);
		const nameLen = v.getUint16(p + 28, true);
		const extraLen = v.getUint16(p + 30, true);
		const commentLen = v.getUint16(p + 32, true);
		const local = v.getUint32(p + 42, true);
		if (p + 46 + nameLen > bytes.length) throw new ZipError("corrupt zip directory");
		const rawName = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
		p += 46 + nameLen + extraLen + commentLen;
		if (rawName.replaceAll("\\", "/").endsWith("/")) continue;
		const name = safeEntryName(rawName);
		if (!name) continue;
		if (size > lim.maxEntry) throw new ZipError("zip entry too large");
		total += size;
		if (total > lim.maxTotal) throw new ZipError("zip is too large when unpacked");
		if (method === 8 && size > compSize * MAX_RATIO + 64) throw new ZipError("zip entry claims an impossible compression ratio");
		packed += compSize;
		if (packed > bytes.length) throw new ZipError("zip entries overlap");
		if (local + 30 > bytes.length || v.getUint32(local, true) !== 0x04034b50) throw new ZipError("corrupt zip entry");
		const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
		if (start + compSize > bytes.length) throw new ZipError("truncated zip entry");
		const comp = bytes.subarray(start, start + compSize);
		let data: Uint8Array;
		if (method === 0) data = comp;
		else if (method === 8) data = inflateRawSync(comp, { maxOutputLength: Math.max(size, 1) });
		else throw new ZipError(`unsupported zip compression method ${method}`);
		out.push({ name, data });
	}
	return out;
}
