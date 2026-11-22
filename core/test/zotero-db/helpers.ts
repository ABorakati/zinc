// Test helpers: work ONLY on temp copies of the Zotero database that ZN_TEST_ZOTERO_DIR names (opt-in). The original is never opened
// for writing and nothing is ever written under its storage/ folder.
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEY_CHARS } from "../../src/zotero-db/mapping";
import { optInZoteroDir } from "../real-data";

export const REAL_ZOTERO_DIR = optInZoteroDir();
export const HAVE_REAL_DB = REAL_ZOTERO_DIR !== null;

export function genKey(): string {
	let k = "";
	for (let i = 0; i < 8; i++) k += KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)];
	return k;
}

/** Copy zotero.sqlite (+ -wal/-shm) from the real data dir into a fresh temp data dir. */
export function makeDataDir(prefix = "zn-zotero-"): string {
	if (!REAL_ZOTERO_DIR) throw new Error("set ZN_TEST_ZOTERO_DIR to run the tests on a copy of a Zotero library");
	const dir = mkdtempSync(join(tmpdir(), prefix));
	for (const ext of ["", "-wal", "-shm"]) {
		const src = join(REAL_ZOTERO_DIR, `zotero.sqlite${ext}`);
		if (existsSync(src)) copyFileSync(src, join(dir, `zotero.sqlite${ext}`));
	}
	mkdirSync(join(dir, "storage"), { recursive: true });
	return dir;
}

export function removeDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

export function openRO(dataDir: string): Database {
	return new Database(join(dataDir, "zotero.sqlite"), { readonly: true });
}

export function writeTempFile(name: string, content: string | Uint8Array): string {
	const dir = mkdtempSync(join(tmpdir(), "zn-file-"));
	const p = join(dir, name);
	writeFileSync(p, content);
	return p;
}

/** Strip volatile keys so reader JSON can be compared with what was written. */
export function stable(data: Record<string, unknown>): Record<string, unknown> {
	const { version: _v, dateAdded: _a, dateModified: _m, ...rest } = data;
	return rest;
}

export const noRunning = async () => false;
