// Fix the icon of a Bun-compiled Windows exe: point its first icon group at the full size list.
//   bun scripts/fix-exe-icon.ts <exe>        (also run by scripts/build.ts after every compile)
//
// Bun's exe template carries an RT_GROUP_ICON named "IDI_MYICON" with ONE entry (256 px -> RT_ICON #1). `compile.windows.icon`
// writes our .ico's images as RT_ICON #1..#n plus a NEW group (id 0) listing all of them, but leaves IDI_MYICON as it was, so it
// now claims RT_ICON #1, our 16 px image, is 256 px. Windows takes the first icon group for the exe's icon (named entries sort
// before numeric ids), so the taskbar, Start menu and shortcuts showed a 16 px picture stretched up: blurry.
// The fix rewrites, in place, IDI_MYICON's 16-byte resource data entry to point at group 0's data (same RVA/size fields, no
// bytes added or moved), so both groups list every size. Nothing else in the file changes.
import { readFileSync, writeFileSync } from "node:fs";

const RT_GROUP_ICON = 14;

export function fixExeIcon(exe: string): "fixed" | "already" | "skipped" {
	const b = readFileSync(exe);
	const pe = b.readUInt32LE(0x3c);
	if (b.toString("latin1", pe, pe + 4) !== "PE\0\0") return "skipped";
	const nsec = b.readUInt16LE(pe + 6), optSize = b.readUInt16LE(pe + 20), opt = pe + 24;
	const dd = opt + (b.readUInt16LE(opt) === 0x20b ? 112 : 96);
	const rsrcRva = b.readUInt32LE(dd + 2 * 8);
	const secs = Array.from({ length: nsec }, (_, i) => {
		const s = opt + optSize + i * 40;
		return { va: b.readUInt32LE(s + 12), vs: b.readUInt32LE(s + 8), raw: b.readUInt32LE(s + 20) };
	});
	const off = (rva: number) => {
		const s = secs.find((x) => rva >= x.va && rva < x.va + Math.max(x.vs, 1));
		return s ? rva - s.va + s.raw : -1;
	};
	const base = off(rsrcRva);
	if (!rsrcRva || base < 0) return "skipped";
	const entries = (o: number) => {
		const n = b.readUInt16LE(o + 12) + b.readUInt16LE(o + 14);
		return Array.from({ length: n }, (_, i) => ({ id: b.readUInt32LE(o + 16 + i * 8), to: b.readUInt32LE(o + 20 + i * 8) }));
	};
	const nameOf = (id: number) => {
		if (!(id & 0x80000000)) return String(id);
		const p = base + (id & 0x7fffffff);
		return b.toString("utf16le", p + 2, p + 2 + 2 * b.readUInt16LE(p));
	};
	const type = entries(base).find((e) => e.id === RT_GROUP_ICON);
	if (!type) return "skipped";
	// each group -> its first language's data entry (file offset of the 16-byte IMAGE_RESOURCE_DATA_ENTRY) and image count
	const groups = entries(base + (type.to & 0x7fffffff)).map((g) => {
		const lang = entries(base + (g.to & 0x7fffffff))[0]!;
		const de = base + lang.to;
		const data = off(b.readUInt32LE(de));
		return { name: nameOf(g.id), de, count: data >= 0 ? b.readUInt16LE(data + 4) : 0 };
	});
	const first = groups[0], full = groups.reduce((a, g) => (g.count > a.count ? g : a), groups[0]!);
	if (!first || first === full || first.count >= full.count) return "already";
	b.copy(b, first.de, full.de, full.de + 8); // OffsetToData (RVA) + Size; CodePage/Reserved stay
	writeFileSync(exe, b);
	return "fixed";
}

if (import.meta.main) {
	const exe = process.argv[2];
	if (!exe) {
		console.error("usage: bun scripts/fix-exe-icon.ts <exe>");
		process.exit(2);
	}
	console.log(`${exe}: icon ${fixExeIcon(exe)}`);
}
