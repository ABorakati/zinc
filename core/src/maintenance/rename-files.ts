// "Rename File from Parent Metadata": {firstCreator} - {year} - {title}.ext (Zotero's default pattern).
// Only imported files inside zotero-next's own storage are touched.

import type { Database } from "bun:sqlite";
import { existsSync, renameSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { nowIso } from "../db";
import { readConfig } from "../files/config";
import { RELATIVE_PREFIX, resolveStoredPath, toStoredPath } from "../files/paths";
import { indexItem } from "../search";
import { isInside } from "./erase";

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Make a string safe as a Windows/Unix file name component. */
export function sanitizeFileName(s: string, keepDots = false): string {
	let out = s
		// eslint-disable-next-line no-control-regex
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/[\\/:*?"<>|]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	out = keepDots ? out : out.replace(/^[.\s]+|[.\s]+$/g, "");
	if (RESERVED.test(out)) out = "_" + out;
	return out;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	const cut = s.slice(0, max);
	const sp = cut.lastIndexOf(" ");
	return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
}

/** Base file name (no extension) from parent metadata; null when there is nothing useful. */
export function baseNameFor(parent: { creators_summary: string | null; year: number | null; title: string | null }): string | null {
	const parts: string[] = [];
	if (parent.creators_summary) parts.push(truncate(sanitizeFileName(parent.creators_summary, true), 50));
	if (parent.year) parts.push(String(parent.year));
	if (parent.title) parts.push(truncate(sanitizeFileName(parent.title, true), 100));
	const name = sanitizeFileName(parts.filter(Boolean).join(" - "));
	return name || null;
}

export interface RenameResult {
	key: string;
	status: "renamed" | "skipped";
	reason?: string;
	path?: string;
}

export function renameFiles(db: Database, attachmentKeys: string[], ownStorageDir: string | null): RenameResult[] {
	const out: RenameResult[] = [];
	for (const key of [...new Set(attachmentKeys)]) {
		const skip = (reason: string): void => void out.push({ key, status: "skipped", reason });
		const att = db
			.query(
				`SELECT a.link_mode, a.path, i.parent_key, i.data FROM attachments a JOIN items i ON i.key = a.item_key WHERE a.item_key = ?`,
			)
			.get(key) as { link_mode: string; path: string | null; parent_key: string | null; data: string } | null;
		if (!att) {
			skip("not an attachment");
			continue;
		}
		if (!att.parent_key) {
			skip("standalone attachment has no parent item");
			continue;
		}
		// a linked file is renamed only inside the attachment storage folder (the one zotero-next manages, like ZotMoov)
		const managedDir = readConfig(db).storage?.dir ?? null;
		const linked = att.link_mode === "linked_file";
		if (!linked && !att.link_mode.startsWith("imported_")) {
			skip("linked URL (no file)");
			continue;
		}
		const wasRelative = !!att.path?.startsWith(RELATIVE_PREFIX);
		const current = resolveStoredPath(db, att.path);
		if (!current || !existsSync(current)) {
			skip("file is missing");
			continue;
		}
		if (linked && !(managedDir && isInside(current, managedDir))) {
			skip("linked file outside the attachment storage folder (not managed by Zinc)");
			continue;
		}
		if (!linked && (!ownStorageDir || !isInside(current, ownStorageDir))) {
			skip("file is not in Zinc's own storage (Zotero-owned files are renamed later via sync)");
			continue;
		}
		const parent = db.query("SELECT creators_summary, year, title FROM items WHERE key = ?").get(att.parent_key) as {
			creators_summary: string | null;
			year: number | null;
			title: string | null;
		} | null;
		const base = parent && baseNameFor(parent);
		if (!base) {
			skip("parent item has no creator, year or title");
			continue;
		}
		const ext = extname(current);
		const dir = dirname(current);
		let name = base + ext;
		if (name === basename(current)) {
			skip("already named from parent metadata");
			continue;
		}
		for (let n = 2; existsSync(join(dir, name)) && n < 100; n++) name = `${base} (${n})${ext}`;
		const target = join(dir, name);
		if (existsSync(target)) {
			skip("target name already exists");
			continue;
		}
		try {
			renameSync(current, target);
		} catch (e) {
			skip(`rename failed: ${e instanceof Error ? e.message : String(e)}`);
			continue;
		}
		const data = JSON.parse(att.data) as Record<string, unknown>;
		const now = nowIso();
		db.transaction(() => {
			db.query("UPDATE attachments SET path = ? WHERE item_key = ?").run(wasRelative ? toStoredPath(db, target) : target, key);
			if (linked) data.path = target; // sync hands Zotero the absolute path
			data.filename = name;
			data.dateModified = now;
			db.query("UPDATE items SET data = ?, date_modified = ? WHERE key = ?").run(JSON.stringify(data), now, key);
			indexItem(db, key);
		})();
		out.push({ key, status: "renamed", path: target });
	}
	return out;
}
