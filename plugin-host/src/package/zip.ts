// A small zip reader and writer for .zplugin packages. No dependency: node:zlib does the deflate. Zip64, encryption and spanned
// archives are refused. The reader is written for hostile input: entry names are checked, sizes are capped before anything is
// inflated, and every inflated entry must match its declared size and CRC-32.
import { deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipLimits {
	/** Entries in the archive. Default 5000. */
	maxEntries: number;
	/** Total uncompressed bytes. Default 256 MiB. */
	maxTotalBytes: number;
	/** One entry, uncompressed. Default 128 MiB. */
	maxEntryBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 5000, maxTotalBytes: 256 * 1024 * 1024, maxEntryBytes: 128 * 1024 * 1024 };

export class ZipError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ZipError";
	}
}

export interface ZipFile {
	/** "/"-separated, relative, checked by `safeEntryName`. Directories are not returned. */
	name: string;
	data: Uint8Array;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Returns why an archive path is not allowed, or undefined if it is fine. A trailing "/" (a directory entry) is allowed. */
export function badEntryName(name: string): string | undefined {
	if (!name) return "empty name";
	if (name.includes("\0")) return "NUL in name";
	if (name.includes("\\")) return "backslash in name";
	if (name.startsWith("/")) return "absolute path";
	if (/^[A-Za-z]:/.test(name)) return "drive letter";
	const parts = name.replace(/\/$/, "").split("/");
	for (const p of parts) {
		if (p === "") return "empty path segment";
		if (p === "." || p === "..") return `"${p}" segment`;
		if (/[:*?"<>|]/.test(p)) return "character not allowed in a file name";
		if (/[. ]$/.test(p)) return "name ends with a dot or space";
		if (WINDOWS_RESERVED.test(p)) return `reserved name "${p}"`;
		if (/[\u0000-\u001f]/.test(p)) return "control character in name";
	}
	return undefined;
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function readZip(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): ZipFile[] {
	const lim = { ...DEFAULT_ZIP_LIMITS, ...limits };
	if (bytes.length < 22) throw new ZipError("not a zip file (too short)");
	// End of central directory: the last 0x06054b50 within the final 64 KiB + 22 bytes.
	let eocd = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
		if (u32(bytes, i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new ZipError("not a zip file (no end-of-central-directory record)");
	const diskNo = u16(bytes, eocd + 4);
	const cdDisk = u16(bytes, eocd + 6);
	const count = u16(bytes, eocd + 10);
	const cdSize = u32(bytes, eocd + 12);
	const cdOffset = u32(bytes, eocd + 16);
	if (diskNo !== 0 || cdDisk !== 0) throw new ZipError("spanned zip files are not supported");
	if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("zip64 is not supported");
	if (count > lim.maxEntries) throw new ZipError(`too many entries (${count}, limit ${lim.maxEntries})`);
	if (cdOffset + cdSize > bytes.length) throw new ZipError("central directory is outside the file");

	const dec = new TextDecoder("utf-8", { fatal: false });
	const out: ZipFile[] = [];
	const seen = new Set<string>();
	let pos = cdOffset;
	let total = 0;
	for (let n = 0; n < count; n++) {
		if (pos + 46 > bytes.length || u32(bytes, pos) !== 0x02014b50) throw new ZipError("bad central directory entry");
		const madeBy = u16(bytes, pos + 4);
		const flags = u16(bytes, pos + 8);
		const method = u16(bytes, pos + 10);
		const crc = u32(bytes, pos + 16);
		const csize = u32(bytes, pos + 20);
		const usize = u32(bytes, pos + 24);
		const nlen = u16(bytes, pos + 28);
		const elen = u16(bytes, pos + 30);
		const clen = u16(bytes, pos + 32);
		const eattr = u32(bytes, pos + 38);
		const lofs = u32(bytes, pos + 42);
		const name = dec.decode(bytes.subarray(pos + 46, pos + 46 + nlen));
		pos += 46 + nlen + elen + clen;

		const why = badEntryName(name);
		if (why) throw new ZipError(`unsafe entry name "${name}": ${why}`);
		const isDir = name.endsWith("/");
		if (flags & 1) throw new ZipError(`"${name}" is encrypted`);
		if (madeBy >> 8 === 3) {
			const mode = eattr >>> 16;
			if ((mode & 0o170000) === 0o120000) throw new ZipError(`"${name}" is a symbolic link`);
		}
		if (isDir) continue;
		const key = name.toLowerCase();
		if (seen.has(key)) throw new ZipError(`duplicate entry "${name}"`);
		seen.add(key);
		if (usize > lim.maxEntryBytes) throw new ZipError(`"${name}" is too large (${usize} bytes)`);
		total += usize;
		if (total > lim.maxTotalBytes) throw new ZipError(`archive expands to more than ${lim.maxTotalBytes} bytes`);

		if (lofs + 30 > bytes.length || u32(bytes, lofs) !== 0x04034b50) throw new ZipError(`bad local header for "${name}"`);
		const start = lofs + 30 + u16(bytes, lofs + 26) + u16(bytes, lofs + 28);
		if (start + csize > bytes.length) throw new ZipError(`"${name}" data is outside the file`);
		const raw = bytes.subarray(start, start + csize);
		let data: Uint8Array;
		if (method === 0) {
			if (csize !== usize) throw new ZipError(`"${name}": stored size mismatch`);
			data = raw;
		} else if (method === 8) {
			try {
				data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) }));
			} catch (e) {
				throw new ZipError(`"${name}": cannot inflate (${(e as Error).message})`);
			}
		} else throw new ZipError(`"${name}": compression method ${method} is not supported`);
		if (data.length !== usize) throw new ZipError(`"${name}": size does not match the archive's record`);
		if ((Bun.hash.crc32(data) as number) >>> 0 !== crc) throw new ZipError(`"${name}": CRC mismatch`);
		out.push({ name, data: data.slice() });
	}
	return out;
}

export interface ZipWriteEntry {
	name: string;
	data: Uint8Array;
	/** Store without compressing. Default: deflate. */
	store?: boolean;
}

/** Writes a zip with UTF-8 names. Names must pass `badEntryName`. */
export function writeZip(entries: ZipWriteEntry[]): Uint8Array {
	const chunks: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	const enc = new TextEncoder();
	const dosTime = 0;
	const dosDate = (1 << 5) | 1 | ((2026 - 1980) << 9);
	for (const e of entries) {
		const why = badEntryName(e.name);
		if (why) throw new ZipError(`unsafe entry name "${e.name}": ${why}`);
		const name = enc.encode(e.name);
		const crc = (Bun.hash.crc32(e.data) as number) >>> 0;
		const body = e.store ? e.data : new Uint8Array(deflateRawSync(e.data));
		const useStore = e.store || body.length >= e.data.length;
		const method = useStore ? 0 : 8;
		const payload = useStore ? e.data : body;
		const local = new Uint8Array(30 + name.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(6, 0x0800, true);
		lv.setUint16(8, method, true);
		lv.setUint16(10, dosTime, true);
		lv.setUint16(12, dosDate, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, payload.length, true);
		lv.setUint32(22, e.data.length, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);
		const cd = new Uint8Array(46 + name.length);
		const cv = new DataView(cd.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(8, 0x0800, true);
		cv.setUint16(10, method, true);
		cv.setUint16(12, dosTime, true);
		cv.setUint16(14, dosDate, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, payload.length, true);
		cv.setUint32(24, e.data.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		cd.set(name, 46);
		chunks.push(local, payload);
		central.push(cd);
		offset += local.length + payload.length;
	}
	const cdSize = central.reduce((n, c) => n + c.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, cdSize, true);
	ev.setUint32(16, offset, true);
	const all = [...chunks, ...central, end];
	const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
	let p = 0;
	for (const c of all) {
		out.set(c, p);
		p += c.length;
	}
	return out;
}
