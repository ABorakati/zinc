import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { optInLibrary, optInZoteroDir } from "./real-data";

const home = mkdtempSync(join(tmpdir(), "zn-optin-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
mkdirSync(join(home, "Zotero"));
mkdirSync(join(home, "zotero-next", "data"), { recursive: true });
const library = join(home, "zotero-next", "data", "library.sqlite");
writeFileSync(join(home, "Zotero", "zotero.sqlite"), "");
writeFileSync(library, "");

test("a library in the home folder is not used unless its variable names it", () => {
	const env = { USERPROFILE: home, HOME: home };
	expect(optInZoteroDir(env)).toBeNull();
	expect(optInLibrary(env)).toBeNull();
	expect(optInZoteroDir({ ...env, ZN_TEST_ZOTERO_DIR: "" })).toBeNull();
	expect(optInZoteroDir({ ...env, ZN_TEST_ZOTERO_DIR: join(home, "Zotero") })).toBe(join(home, "Zotero"));
	expect(optInLibrary({ ...env, ZN_TEST_LIBRARY: library })).toBe(library);
});

test("no core test file falls back to a personal path", () => {
	const personal = /\?\?\s*["'`][A-Za-z]:[\\/]+Users[\\/]|USERPROFILE\s*\?\?|homedir\(\)/;
	const files = (readdirSync(import.meta.dir, { recursive: true }) as string[]).filter((f) => /\.ts$/.test(f) && !f.endsWith("real-data.test.ts"));
	expect(files.filter((f) => personal.test(readFileSync(join(import.meta.dir, f), "utf8")))).toEqual([]);
});
