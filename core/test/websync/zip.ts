// Test helper: build a ZIP (stored or deflated entries) the way zotero.org stores a web snapshot.

import { deflateRawSync } from "node:zlib";

export function zipOf(entries: { name: string; data: string | Uint8Array; deflate?: boolean }[]): Uint8Array {
	const enc = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const e of entries) {
		const name = enc.encode(e.name);
		const raw = typeof e.data === "string" ? enc.encode(e.data) : e.data;
		const comp = e.deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
		const crc = Bun.hash.crc32(raw) >>> 0;
		const local = new Uint8Array(30 + name.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(8, e.deflate ? 8 : 0, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, comp.length, true);
		lv.setUint32(22, raw.length, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);
		const c = new Uint8Array(46 + name.length);
		const cv = new DataView(c.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(10, e.deflate ? 8 : 0, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, comp.length, true);
		cv.setUint32(24, raw.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		c.set(name, 46);
		chunks.push(local, comp);
		central.push(c);
		offset += local.length + comp.length;
	}
	const cdSize = central.reduce((n, c) => n + c.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, cdSize, true);
	ev.setUint32(16, offset, true);
	return new Uint8Array(Buffer.concat([...chunks, ...central, end]));
}
