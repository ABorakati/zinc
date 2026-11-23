// isInside (erase.ts, shared by files/*) and the one in sync/build.ts: a file counts as inside a folder when it really is, and only then.
// Temp folders only; every path is under one.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInside as eraseInside } from "../../src/maintenance/erase";
import { isInside as buildInside } from "../../src/sync/build";

const root = mkdtempSync(join(tmpdir(), "zn-inside-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const storage = join(root, "storage");
mkdirSync(join(storage, "KEY00001"), { recursive: true });
mkdirSync(join(root, "storage2"), { recursive: true });
mkdirSync(join(storage, "a.."), { recursive: true });
writeFileSync(join(storage, "KEY00001", "..notes.pdf"), "x");
writeFileSync(join(storage, "a..", "x.pdf"), "x");
writeFileSync(join(storage, "..top.pdf"), "x");
writeFileSync(join(root, "outside.pdf"), "x");
writeFileSync(join(root, "storage2", "y.pdf"), "x");

describe.each([
	["maintenance/erase", eraseInside],
	["sync/build", buildInside],
])("isInside (%s)", (_name, isInside) => {
	test("files really inside count, including names that merely start or end with two dots", () => {
		expect(isInside(join(storage, "KEY00001", "paper.pdf"), storage)).toBe(true);
		expect(isInside(join(storage, "KEY00001", "..notes.pdf"), storage)).toBe(true);
		expect(isInside(join(storage, "..top.pdf"), storage)).toBe(true);
		expect(isInside(join(storage, "a..", "x.pdf"), storage)).toBe(true);
	});

	test("files outside never count", () => {
		expect(isInside(join(root, "outside.pdf"), storage)).toBe(false);
		expect(isInside(join(storage, "..", "outside.pdf"), storage)).toBe(false);
		expect(isInside(join(root, "storage2", "y.pdf"), storage)).toBe(false); // a sibling that shares the prefix
		expect(isInside(join(storage, "KEY00001", "..", "..", "..", "outside.pdf"), storage)).toBe(false);
		expect(isInside(root, storage)).toBe(false); // the parent
		expect(isInside(storage, storage)).toBe(false); // the folder itself
	});
});

// sync/build compares real paths. A file that does not exist (yet, or any more: the old path of a moved attachment) has no real path of its
// own, so its nearest existing folder is resolved instead. Without that, on macOS (/var is a link to /private/var) a missing file under
// the temp folder counted as outside. Reproduced on every system with a link to the storage folder (a junction on Windows: no rights needed).
describe("isInside (sync/build) through a linked folder", () => {
	const linked = join(root, "linked-storage");
	symlinkSync(storage, linked, process.platform === "win32" ? "junction" : "dir");

	test("a missing file under a link to the folder is inside", () => {
		expect(buildInside(join(linked, "KEY00001", "not-there-yet.pdf"), storage)).toBe(true);
		expect(buildInside(join(linked, "NEWKEY99", "deeper", "missing.pdf"), storage)).toBe(true);
	});

	test("a file that exists under the link is inside, and the link's own sibling is not", () => {
		expect(buildInside(join(linked, "KEY00001", "..notes.pdf"), storage)).toBe(true);
		expect(buildInside(join(root, "storage2", "missing.pdf"), storage)).toBe(false);
	});
});
