// Tests on COPIES of a real library are opt-in. There is no default path on purpose: a default once copied the real Zotero and
// Zinc libraries during an ordinary `bun test`. Never add one (not a literal, not the home folder, not APPDATA).
import { existsSync } from "node:fs";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

/** The Zotero data folder that ZN_TEST_ZOTERO_DIR names, when it holds a zotero.sqlite; else null (the tests skip). */
export function optInZoteroDir(env: Env = process.env): string | null {
	const dir = env.ZN_TEST_ZOTERO_DIR;
	return dir && existsSync(join(dir, "zotero.sqlite")) ? dir : null;
}

/** The library file that ZN_TEST_LIBRARY names, when it exists; else null (the tests skip). */
export function optInLibrary(env: Env = process.env): string | null {
	const file = env.ZN_TEST_LIBRARY;
	return file && existsSync(file) ? file : null;
}
