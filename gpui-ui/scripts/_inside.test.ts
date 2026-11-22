// isInside (scripts/_inside.ts): the check that keeps the release signing key out of the repository.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInside } from "./_inside";

const base = mkdtempSync(join(tmpdir(), "zinc-inside-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const repo = join(base, "repo");
mkdirSync(join(repo, "sub"), { recursive: true });
mkdirSync(join(base, "elsewhere"));

describe("isInside", () => {
	test("the folder itself and what is under it", () => {
		expect(isInside(repo, repo)).toBe(true);
		expect(isInside(repo, join(repo, "sub"))).toBe(true);
		expect(isInside(repo, join(repo, "sub", "not", "yet", "there"))).toBe(true);
		expect(isInside(repo, join(repo, "sub", "..", "sub2"))).toBe(true);
	});
	test("outside, including a sibling whose name starts like the folder", () => {
		expect(isInside(repo, join(base, "elsewhere"))).toBe(false);
		expect(isInside(repo, join(base, "repo2"))).toBe(false);
		expect(isInside(repo, join(repo, ".."))).toBe(false);
		expect(isInside(repo, base)).toBe(false);
	});
	test("a folder whose name starts with two dots is inside, not outside", () => {
		expect(isInside(repo, join(repo, "..keys"))).toBe(true);
		expect(isInside(repo, join(repo, "..keys", "release-key.private.json"))).toBe(true);
	});
	test("a link into the folder is inside, also for a path under it that does not exist yet", () => {
		const link = join(base, "link-into-repo");
		symlinkSync(join(repo, "sub"), link, "junction");
		expect(isInside(repo, link)).toBe(true);
		expect(isInside(repo, join(link, "new-folder"))).toBe(true);
	});
	test("a link out of the folder is outside", () => {
		const link = join(repo, "link-out");
		symlinkSync(join(base, "elsewhere"), link, "junction");
		expect(isInside(repo, link)).toBe(false);
		expect(isInside(repo, join(link, "new-folder"))).toBe(false);
	});
});
