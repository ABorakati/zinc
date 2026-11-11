// Fuzz: the hand-written ZIP reader for web snapshots (core/src/websync/zip.ts) and how its entries reach the disk.
//
// Properties: no entry name can write outside the target folder (zip-slip: "..", absolute, drive letters, UNC, backslashes,
// NUL, Windows tricks, Unicode lookalikes); unpacked size is bounded (bombs, overlapping entries, lying size fields); corrupt
// or truncated archives fail with a ZipError and never hang or crash. Files are only ever written under a temp folder.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { UNSTORABLE_NAME } from "../../src/websync/files";
import { entryTarget, readZip, safeEntryName, ZipError } from "../../src/websync/zip";
import { zipOf } from "../websync/zip";
import { describeError, fc, fuzz, messyText, mutatedBytes } from "./harness";

const sandboxes: string[] = [];
function sandbox(): { root: string; dir: string } {
	const root = mkdtempSync(join(tmpdir(), "zn-zipfuzz-"));
	sandboxes.push(root);
	const dir = join(root, "target");
	mkdirSync(dir);
	writeFileSync(join(root, "canary.txt"), "canary");
	return { root, dir };
}
afterAll(() => {
	for (const s of sandboxes) rmSync(s, { recursive: true, force: true });
});

/** Every file and folder under `dir` as relative paths. */
function listAll(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const n of readdirSync(d)) {
			const p = join(d, n);
			out.push(path.relative(dir, p));
			if (statSync(p).isDirectory()) walk(p);
		}
	};
	walk(dir);
	return out.sort();
}

// ---------------------------------------------------------------- names

const PIECES = ["..", ".", "...", ".. ", " ..", "..\\", "a", "b.html", "C:", "c:foo", "con", "NUL.txt", "aux", "com1", "LPT9.x", "~", "%2e%2e", "..%2f", "\u202e", "\uff0e\uff0e", "\u2025", "\ufe52\ufe52", "\uff0f", "\uff3c", "x:y", "page.html:stream", "\u0000", "\u0001", "", "//", "\\\\server\\share", "\\\\?\\C:", "/etc/passwd", "C:\\Windows", "..."];
const SEPS = ["/", "\\", "//", "\\/", "/\\", "\u0000/", "/ ", ". /", "\uff0f", "\uff3c"];
const attackName = fc
  .tuple(fc.array(fc.oneof(fc.constantFrom(...PIECES), fc.string({ maxLength: 5 })), { minLength: 1, maxLength: 7 }), fc.array(fc.constantFrom(...SEPS), { minLength: 7, maxLength: 7 }), fc.boolean())
	.map(([parts, seps, lead]) => (lead ? seps[0]! : "") + parts.map((p, i) => p + (i < parts.length - 1 ? seps[i + 1]! : "")).join(""));
const anyName = fc.oneof({ weight: 4, arbitrary: attackName }, { weight: 1, arbitrary: messyText(40) });

function insideOn(flavour: typeof path.win32 | typeof path.posix, root: string, name: string): boolean {
	const target = flavour.resolve(root, name);
	const rel = flavour.relative(root, target);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${flavour.sep}`) && !flavour.isAbsolute(rel);
}

describe("entry names", () => {
	fuzz("safeEntryName is null or a relative path that stays inside the folder on Windows and POSIX, also after NFKC", [anyName], (raw) => {
		const safe = safeEntryName(raw);
		if (safe === null) return;
		for (const form of [safe, safe.normalize("NFKC"), safe.normalize("NFC")]) {
			expect(form.includes("\0")).toBe(false);
			expect(form.split(/[\\/]/).some((p) => p.replace(/[. ]+$/, "") === "..")).toBe(false);
			expect(insideOn(path.win32, "C:\\snap\\ABCD1234", form)).toBe(true);
			expect(insideOn(path.posix, "/snap/ABCD1234", form)).toBe(true);
			expect(path.win32.isAbsolute(form) || path.posix.isAbsolute(form)).toBe(false);
		}
	}, { normal: 400 });

	fuzz("entryTarget is null or a path strictly inside the real temp folder", [anyName], (raw) => {
		const { dir } = sandbox0;
		const t = entryTarget(dir, raw);
		if (t === null) return;
		const rel = path.relative(dir, t);
		expect(rel === "" || rel.split(path.sep)[0] === ".." || path.isAbsolute(rel)).toBe(false);
	}, { normal: 400 });

	test.each([
		"../evil", "..\\evil", "a/../../evil", "/abs", "\\abs", "C:\\x", "c:/x", "C:x", "\\\\server\\share\\x", "//server/share/x", "a\0b", ".. /x", "... /x", "a/.. /x",
		"con", "NUL.txt", "dir/aux.html", "x.html:stream", "\uff0e\uff0e/x", "..\uff0fx", "\u2025/x", "./\uff0f/!",
	])("regression: %j is refused", (raw) => {
		expect(safeEntryName(raw)).toBeNull();
	});
	test.each([["a/b.html", "a/b.html"], ["a\\b.html", "a/b.html"], ["./a//b", "a/b"], ["caf%C3%A9.html", "caf%C3%A9.html"], ["dir/..file", "dir/..file"], ["a.b.c", "a.b.c"], ["console.log", "console.log"], ["*", "_"], ["page.html?v=2", "page.html_v=2"]])(
		"regression: %j stays usable as %j",
		(raw, want) => {
			expect(safeEntryName(raw)).toBe(want);
		},
	);
});
const sandbox0 = (() => {
	const root = mkdtempSync(join(tmpdir(), "zn-zipfuzz-"));
	sandboxes.push(root);
	const dir = join(root, "target");
	mkdirSync(dir);
	return { root, dir };
})();

// ---------------------------------------------------------------- end to end writes

function extractLikeDownloader(dir: string, zip: Uint8Array): void {
	// the same loop as websync/files.ts downloadOne
	for (const e of readZip(zip)) {
		const file = entryTarget(dir, e.name);
		if (!file) continue;
		try {
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, e.data);
		} catch (err) {
			// a file and a folder of one name in the same archive: the download of that attachment fails, which is fine; a name the file
			// system cannot store (macOS: EILSEQ for an unassigned code point) is skipped by downloadOne
			const code = (err as NodeJS.ErrnoException).code ?? "";
			if (!["EEXIST", "ENOTDIR", "EISDIR"].includes(code) && !UNSTORABLE_NAME.has(code)) throw err;
		}
	}
}

describe("writing entries", () => {
	fuzz("hostile names never create a file outside the target folder", [fc.array(anyName, { minLength: 1, maxLength: 6 })], (names) => {
		const { root, dir } = sandbox();
		const before = listAll(root);
		const entries = [{ name: "index.html", data: "ok" }, ...names.map((name) => ({ name, data: "payload" }))];
		extractLikeDownloader(dir, zipOf(entries));
		const after = listAll(root);
		const created = after.filter((p) => !before.includes(p));
		expect(created.filter((p) => p !== "target" && !p.startsWith(`target${path.sep}`))).toEqual([]);
		expect(readdirSync(root).sort()).toEqual(["canary.txt", "target"]);
		expect(existsSync(join(dir, "index.html"))).toBe(true);
	}, { normal: 120 });
});

// ---------------------------------------------------------------- bounds

/** A ZIP whose central directory lists `n` entries that all point at one local header holding `data` (deflated). */
function overlapping(n: number, data: Uint8Array, claimedSize: number, method = 8): Uint8Array {
	const comp = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
	const local = new Uint8Array(30 + 1);
	const lv = new DataView(local.buffer);
	lv.setUint32(0, 0x04034b50, true);
	lv.setUint16(8, method, true);
	lv.setUint32(18, comp.length, true);
	lv.setUint32(22, claimedSize, true);
	lv.setUint16(26, 1, true);
	local[30] = 0x61;
	const central: Uint8Array[] = [];
	for (let i = 0; i < n; i++) {
		const name = new TextEncoder().encode(`f${i}.bin`);
		const c = new Uint8Array(46 + name.length);
		const cv = new DataView(c.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(10, method, true);
		cv.setUint32(20, comp.length, true);
		cv.setUint32(24, claimedSize, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, 0, true);
		c.set(name, 46);
		central.push(c);
	}
	const cdSize = central.reduce((s, c) => s + c.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, n, true);
	ev.setUint16(10, n, true);
	ev.setUint32(12, cdSize, true);
	ev.setUint32(16, local.length + comp.length, true);
	return new Uint8Array(Buffer.concat([local, comp, ...central, end]));
}

const totalBytes = (files: { data: Uint8Array }[]) => files.reduce((s, f) => s + f.data.length, 0);

describe("size bounds", () => {
	const LIMITS = { maxEntry: 200_000, maxTotal: 500_000, maxEntries: 50 };
	fuzz("a zip bomb of overlapping or oversized entries is refused or stays under the limits", [fc.integer({ min: 1, max: 2000 }), fc.integer({ min: 1000, max: 150_000 }), fc.integer({ min: 0, max: 2 })], (n, size, fudge) => {
		const claimed = fudge === 0 ? size : fudge === 1 ? size * 10 : size - Math.floor(size / 2);
		const zip = overlapping(n, new Uint8Array(size), claimed);
		let files: { data: Uint8Array }[] = [];
		try {
			files = readZip(zip, LIMITS);
		} catch (e) {
			if (!(e instanceof ZipError)) throw new Error(`threw ${describeError(e)} instead of a ZipError`);
			return;
		}
		expect(files.length).toBeLessThanOrEqual(LIMITS.maxEntries);
		expect(totalBytes(files)).toBeLessThanOrEqual(LIMITS.maxTotal);
	});
	test("regression: thousands of entries sharing one 1 MB deflated block are refused (default limits)", () => {
		// 1 MiB of zeros deflates to ~1 KB; 20000 central entries claiming 1 MiB each would unpack to 20 GB from a ~1.2 MB file
		const zip = overlapping(20000, new Uint8Array(1024 * 1024), 1024 * 1024);
		expect(() => readZip(zip)).toThrow(ZipError);
	});
	test("regression: a deflated entry claiming more than 1032:1 is refused", () => {
		const zip = overlapping(1, new Uint8Array(100_000), 900_000_000);
		expect(() => readZip(zip)).toThrow(ZipError);
	});
	test("regression: an entry that is cut off by the end of the file is an error, not a short file", () => {
		const whole = zipOf([{ name: "a.bin", data: new Uint8Array(500).fill(7) }]);
		const cdStart = whole.length - 22 - (46 + 5);
		// keep the directory but drop 100 bytes of the data
		const cut = new Uint8Array(Buffer.concat([whole.subarray(0, cdStart - 100), whole.subarray(cdStart)]));
		new DataView(cut.buffer).setUint32(cut.length - 22 + 16, cdStart - 100, true);
		expect(() => readZip(cut)).toThrow(ZipError);
	});
});

// ---------------------------------------------------------------- corrupt archives

const VALID = zipOf([
	{ name: "index.html", data: "<html><body>page</body></html>" },
	{ name: "img/a.png", data: new Uint8Array(300).map((_, i) => i * 7) , deflate: true },
	{ name: "css/site.css", data: "body { color: red }".repeat(50), deflate: true },
	{ name: "caf%C3%A9.html", data: "<html>x</html>" },
]);

describe("corrupt archives", () => {
	const check = (zip: Uint8Array) => {
		let files: { name: string; data: Uint8Array }[];
		try {
			files = readZip(zip);
		} catch (e) {
			if (!(e instanceof ZipError)) throw new Error(`threw ${describeError(e)} instead of a ZipError`, { cause: e });
			return;
		}
		expect(totalBytes(files)).toBeLessThanOrEqual(64 * 1024 * 1024);
		for (const f of files) expect(safeEntryName(f.name)).toBe(f.name);
	};
	test("the valid seed reads fine", () => {
		expect(readZip(VALID).map((f) => f.name)).toEqual(["index.html", "img/a.png", "css/site.css", "caf%C3%A9.html"]);
	});
	fuzz("mutated zip bytes fail only with a ZipError", [mutatedBytes(VALID, 8)], check, { normal: 400 });
	fuzz("every truncation fails only with a ZipError", [fc.integer({ min: 0, max: VALID.length })], (n) => check(VALID.subarray(0, n)), { normal: 200 });
	fuzz("random bytes fail only with a ZipError", [fc.uint8Array({ maxLength: 400 })], check);
	fuzz("random bytes behind a real end-of-directory record", [fc.uint8Array({ maxLength: 200 }), fc.integer({ min: 0, max: 0xffff }), fc.integer({ min: 0, max: 0xffffffff })], (junk, count, off) => {
		const end = new Uint8Array(22);
		const ev = new DataView(end.buffer);
		ev.setUint32(0, 0x06054b50, true);
		ev.setUint16(8, count, true);
		ev.setUint16(10, count, true);
		ev.setUint32(16, off, true);
		check(new Uint8Array(Buffer.concat([junk, end])));
	});
});
