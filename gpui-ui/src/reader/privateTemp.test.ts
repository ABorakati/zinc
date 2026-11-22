// bun test src/reader/privateTemp.test.ts -- the PDF handed to a print dialog and the structure cache live in folders only this user can open.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateDir, writePrivateTemp } from "./privateTemp";

const posix = process.platform !== "win32";

describe("writePrivateTemp", () => {
	test("writes the bytes into a new folder of its own, never the same path twice, and remove() deletes the folder", () => {
		const bytes = new Uint8Array([37, 80, 68, 70, 45]);
		const a = writePrivateTemp(bytes),
			b = writePrivateTemp(bytes);
		try {
			expect(a.file).not.toBe(b.file);
			expect(a.file.startsWith(tmpdir())).toBe(true);
			expect(a.file).not.toMatch(/zinc-print-\d+-\d+\.pdf$/); // the old, predictable name
			expect(new Uint8Array(readFileSync(a.file))).toEqual(bytes);
			if (posix) {
				expect(statSync(a.file).mode & 0o077).toBe(0); // readable by this user only
				expect(statSync(join(a.file, "..")).mode & 0o077).toBe(0);
			}
		} finally {
			a.remove();
			b.remove();
		}
		expect(existsSync(a.file)).toBe(false);
		expect(existsSync(join(a.file, ".."))).toBe(false);
	});
});

describe("privateDir", () => {
	test("makes a missing folder (and its parents) and returns it", () => {
		const base = mkdtempSync(join(tmpdir(), "zn-private-"));
		try {
			const dir = join(base, "a", "b");
			expect(privateDir(dir)).toBe(dir);
			expect(existsSync(dir)).toBe(true);
			if (posix) expect(statSync(dir).mode & 0o077).toBe(0);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("refuses a folder that belongs to somebody else", () => {
		const base = mkdtempSync(join(tmpdir(), "zn-private-"));
		try {
			expect(privateDir(base, 424242)).toBeNull(); // (a real uid on Windows is undefined: the check is skipped there, so an owner is passed)
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test.skipIf(!posix)("refuses a folder others can enter, and a link", () => {
		const base = mkdtempSync(join(tmpdir(), "zn-private-"));
		try {
			const open = join(base, "open");
			mkdirSync(open, { mode: 0o777 });
			chmodSync(open, 0o777);
			expect(privateDir(open)).toBeNull();
			symlinkSync(base, join(base, "link"));
			expect(privateDir(join(base, "link"))).toBeNull();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
