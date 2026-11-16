// Re-resolve attachment files for an existing library DB without re-importing.
// Updates ONLY attachments.path, and only for rows whose file is currently unresolved
// (path NULL, or path pointing at a file that no longer exists). Dry-run unless --apply.
//
// Usage:
//   bun core/scripts/relink-files.ts --db data/library.sqlite [--zotero C:/Users/abora/Zotero]
//        [--base "C:/Users/abora/OneDrive/Zotero Library"] [--root <extra search dir>]...
//        [--no-fuzzy] [--apply] [--report out.json]
//
// Matching order: canonical Zotero location -> storage/<KEY>/ rename -> exact file name ->
// normalised file name -> parent-title match (see src/import/resolve-files.ts). Ambiguous matches are
// skipped, not guessed. Directory listings only: OneDrive cloud-only placeholders are never hydrated.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildFileIndex,
	defaultSearchRoots,
	type FileIndex,
	resolveAttachmentFile,
	zoteroRawPathFilename,
} from "../src/import/resolve-files";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const multi = (name: string): string[] => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));

const dbPath = opt("db");
if (!dbPath) {
	console.error(
		"usage: bun core/scripts/relink-files.ts --db <library.sqlite> [--zotero <dir>] [--base <dir>] [--root <dir>]... [--no-fuzzy] [--apply] [--report <file.json>]",
	);
	process.exit(2);
}
const apply = args.includes("--apply");
const fuzzy = !args.includes("--no-fuzzy");
const zoteroDir = opt("zotero") ?? "C:/Users/abora/Zotero";
const storageDir = join(zoteroDir, "storage");

function prefBase(): string | null {
	const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Roaming");
	const profiles = join(appData, "Zotero", "Zotero", "Profiles");
	if (!existsSync(profiles)) return null;
	for (const d of readdirSync(profiles)) {
		const p = join(profiles, d, "prefs.js");
		if (!existsSync(p)) continue;
		const m = /user_pref\("extensions\.zotero\.baseAttachmentPath",\s*("(?:[^"\\]|\\.)*")\)/.exec(readFileSync(p, "utf8"));
		if (m) {
			try {
				return JSON.parse(m[1]);
			} catch {
				/* ignore */
			}
		}
	}
	return null;
}
const baseAttach = opt("base") ?? prefBase();

const db = new Database(dbPath);
db.exec("PRAGMA busy_timeout = 5000");

interface Row {
	item_key: string;
	link_mode: string;
	path: string | null;
	data: string;
	parent_title: string | null;
	parent_author: string | null;
}
const rows = db
	.query(
		`SELECT a.item_key, a.link_mode, a.path, i.data, p.title AS parent_title, p.creators_summary AS parent_author
		 FROM attachments a JOIN items i ON i.key = a.item_key LEFT JOIN items p ON p.key = i.parent_key
		 WHERE a.link_mode <> 'linked_url'`,
	)
	.all() as Row[];

let index: FileIndex | null = null;
const getIndex = () => {
	if (!index) {
		const roots = [...multi("root"), ...defaultSearchRoots({ zoteroDir, baseAttachmentPath: baseAttach })];
		console.log(`[relink] indexing ${roots.join(" | ")}`);
		index = buildFileIndex(roots);
		console.log(`[relink] ${index.files.length} candidate files`);
	}
	return index;
};

const by: Record<string, number> = {};
const bump = (k: string) => (by[k] = (by[k] ?? 0) + 1);
const updates: { key: string; path: string; how: string; was: string | null }[] = [];
const unresolved: { key: string; filename?: string; link_mode: string }[] = [];
let alreadyOk = 0;

for (const r of rows) {
	if (r.path && existsSync(r.path)) {
		alreadyOk++;
		continue;
	}
	let d: Record<string, any> = {};
	try {
		d = JSON.parse(r.data);
	} catch {
		/* keep empty */
	}
	// raw Zotero path: linked_file keeps it in data.path; imported files only keep the file name
	const rawPath: string | undefined = d.path ?? (d.filename ? `storage:${d.filename}` : undefined);
	if (!rawPath) {
		bump("no filename recorded");
		unresolved.push({ key: r.item_key, link_mode: r.link_mode });
		continue;
	}
	const m = resolveAttachmentFile(
		{
			key: r.item_key,
			rawPath,
			filename: zoteroRawPathFilename(rawPath),
			md5: d.md5,
			parentTitle: r.parent_title,
			parentAuthor: r.parent_author,
		},
		{ storageDir, baseAttach, index: getIndex, fuzzy },
	);
	if (!m) {
		bump("unresolved");
		unresolved.push({ key: r.item_key, filename: zoteroRawPathFilename(rawPath), link_mode: r.link_mode });
		continue;
	}
	bump(`found:${m.how}`);
	updates.push({ key: r.item_key, path: m.path, how: m.how, was: r.path });
}

if (apply) {
	const upd = db.prepare("UPDATE attachments SET path = ? WHERE item_key = ?");
	db.exec("BEGIN");
	for (const u of updates) upd.run(u.path, u.key);
	db.exec("COMMIT");
}
db.close(true);

const summary = { db: dbPath, apply, rows: rows.length, alreadyOk, toUpdate: updates.length, by, unresolved: unresolved.length };
console.log(JSON.stringify(summary, null, 2));
const report = opt("report");
if (report) writeFileSync(report, JSON.stringify({ summary, updates, unresolved }, null, 1));
if (!apply) console.log("[relink] dry run; re-run with --apply to write attachments.path");
