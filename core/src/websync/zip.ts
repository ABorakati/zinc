// Minimal ZIP reader for zotero.org web snapshots (the page plus its resources, stored or deflated; no ZIP64,
// no encryption). There is no zip library in core, and snapshots only need reading.

import { inflateRawSync } from "node:zlib";

export interface ZipFile {
	/** Path inside the archive, forward slashes, never absolute and never containing "..". */
	name: string;
	data: Uint8Array;
}

const MAX_ENTRY = 1024 * 1024 * 1024;

export function isZip(b: Uint8Array): boolean {
	return b.length > 22 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/** A safe relative path for an archive entry, or null when it would escape the target folder. */
export function safeEntryName(raw: string): string | null {
	const n = raw.replaceAll("\\", "/");
	if (!n || n.startsWith("/") || /^[A-Za-z]:/.test(n) || n.includes("\0")) return null;
	const parts = n.split("/").filter((p) => p !== "" && p !== ".");
	if (parts.length === 0 || parts.includes("..")) return null;
	return parts.join("/");
}

/** All file entries of the archive. Directories and entries with unsafe names are left out. */
export function readZip(bytes: Uint8Array): ZipFile[] {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let eocd = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
		if (v.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("not a zip file");
	const count = v.getUint16(eocd + 10, true);
	let p = v.getUint32(eocd + 16, true);
	if (count === 0xffff || p === 0xffffffff) throw new Error("zip64 archives are not supported");
	const out: ZipFile[] = [];
	for (let i = 0; i < count; i++) {
		if (v.getUint32(p, true) !== 0x02014b50) throw new Error("corrupt zip directory");
		const method = v.getUint16(p + 10, true);
		const compSize = v.getUint32(p + 20, true);
		const size = v.getUint32(p + 24, true);
		const nameLen = v.getUint16(p + 28, true);
		const extraLen = v.getUint16(p + 30, true);
		const commentLen = v.getUint16(p + 32, true);
		const local = v.getUint32(p + 42, true);
		const rawName = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
		p += 46 + nameLen + extraLen + commentLen;
		if (rawName.endsWith("/")) continue;
		const name = safeEntryName(rawName);
		if (!name) continue;
		if (size > MAX_ENTRY) throw new Error("zip entry too large");
		if (v.getUint32(local, true) !== 0x04034b50) throw new Error("corrupt zip entry");
		const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
		const comp = bytes.subarray(start, start + compSize);
		let data: Uint8Array;
		if (method === 0) data = comp;
		else if (method === 8) data = inflateRawSync(comp, { maxOutputLength: Math.max(size, 1) });
		else throw new Error(`unsupported zip compression method ${method}`);
		out.push({ name, data });
	}
	return out;
}
