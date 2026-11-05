// Deleting files that zotero-next manages in the attachment storage folder: used when a linked attachment is deleted
// permanently (ZotMoov's "delete files") and when a move leaves folders behind that are empty.
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { readConfig } from "./config";
import { relativeUnder, resolveStoredPath } from "./paths";

/** Files an operating system leaves in a folder that do not count as content. */
const JUNK = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

/** Remove `dir` and its parents up to (not including) `root` while they hold nothing but system junk files. Returns the folders removed. */
export function pruneEmptyDirs(dir: string, root: string): string[] {
	const removed: string[] = [];
	let cur = dir;
	while (relativeUnder(cur, root) !== null) {
		try {
			if (existsSync(cur)) {
				const names = readdirSync(cur);
				if (names.some((n) => !JUNK.has(n.toLowerCase()))) break;
				for (const n of names) rmSync(join(cur, n), { force: true });
				rmdirSync(cur);
				removed.push(cur);
			}
		} catch {
			break;
		}
		cur = dirname(cur);
	}
	return removed;
}

/** Linked files of these attachments that sit inside the storage folder (call before the rows are deleted; null when the feature is off). */
export function managedLinkedFiles(db: Database, keys: string[]): string[] | null {
	const cfg = readConfig(db).storage;
	if (!cfg?.dir || !cfg.deleteFiles || !keys.length) return null;
	const out: string[] = [];
	for (let i = 0; i < keys.length; i += 500) {
		const chunk = keys.slice(i, i + 500);
		const rows = db
			.query(`SELECT path FROM attachments WHERE link_mode = 'linked_file' AND path IS NOT NULL AND item_key IN (${chunk.map(() => "?").join(",")})`)
			.all(...chunk) as { path: string }[];
		for (const r of rows) {
			const p = resolveStoredPath(db, r.path);
			if (p && relativeUnder(p, cfg.dir)) out.push(p);
		}
	}
	return out;
}

/**
 * Delete those files after their rows are gone. A file another attachment still points at is kept, and so is anything
 * that cannot be deleted.
 */
export function deleteManagedFiles(db: Database, files: string[]): { removed: number; kept: number } {
	const cfg = readConfig(db).storage;
	if (!cfg?.dir) return { removed: 0, kept: files.length };
	const stillUsed = new Set<string>();
	for (const r of db.query("SELECT path FROM attachments WHERE path IS NOT NULL").all() as { path: string }[]) {
		const p = resolveStoredPath(db, r.path);
		if (p) stillUsed.add(p.replaceAll("\\", "/").toLowerCase());
	}
	let removed = 0;
	let kept = 0;
	const dirs = new Set<string>();
	for (const f of new Set(files)) {
		try {
			if (stillUsed.has(f.replaceAll("\\", "/").toLowerCase()) || !existsSync(f) || !statSync(f).isFile()) {
				kept++;
				continue;
			}
			rmSync(f);
			removed++;
			dirs.add(dirname(f));
		} catch {
			kept++;
		}
	}
	if (cfg.pruneEmptyDirs !== false) for (const d of dirs) pruneEmptyDirs(d, cfg.dir);
	return { removed, kept };
}
