// Stored attachment paths and the linked-attachment base directory.
//
// attachments.path in the zotero-next database is either an absolute path or, for linked files under the base
// directory, Zotero's own relative form "attachments:<relative path>". resolveStoredPath() is the one place that turns
// a stored value into a file-system path; every reader of attachments.path goes through it.
//
// Sync with Zotero is separate: the Zotero writer relativises against *Zotero's* baseAttachmentPath pref (what Zotero
// itself resolves "attachments:" against), and sync/build.ts hands it the resolved absolute path, so the base directory
// chosen here never leaks into zotero.sqlite.
import type { Database } from "bun:sqlite";
import { dirname, join, resolve } from "node:path";
import { findBaseAttachmentPath } from "../zotero-db/env";
import { dbFileOf, readConfig, updateConfig } from "./config";

export const RELATIVE_PREFIX = "attachments:";

let profilesDirOverride: string | undefined;
/** Tests: where Zotero's profiles live. Call with no argument to restore the default. */
export function setZoteroProfilesDir(dir?: string): void {
	profilesDirOverride = dir;
	prefCache = undefined;
}
export const zoteroProfilesDir = (): string | undefined => profilesDirOverride;

let prefCache: { at: number; value: string | null } | undefined;
function zoteroBasePref(): string | null {
	const now = Date.now();
	if (prefCache && now - prefCache.at < 5000) return prefCache.value;
	let value: string | null = null;
	try {
		value = findBaseAttachmentPath(profilesDirOverride);
	} catch {
		value = null;
	}
	prefCache = { at: now, value };
	return value;
}

export type BaseDirMode = "zotero" | "custom" | "none";

export interface BaseDirInfo {
	mode: BaseDirMode;
	/** Folder chosen here (mode custom). */
	configured: string | null;
	/** Zotero's own extensions.zotero.baseAttachmentPath. */
	zotero: string | null;
	/** The folder "attachments:" paths resolve against right now. */
	effective: string | null;
}

export function baseDirInfo(db: Database): BaseDirInfo {
	const cfg = readConfig(db);
	const zotero = zoteroBasePref();
	if (cfg.baseDir === null) return { mode: "none", configured: null, zotero, effective: null };
	if (typeof cfg.baseDir === "string" && cfg.baseDir) return { mode: "custom", configured: cfg.baseDir, zotero, effective: cfg.baseDir };
	return { mode: "zotero", configured: null, zotero, effective: zotero };
}

export function effectiveBaseDir(db: Database): string | null {
	return baseDirInfo(db).effective;
}

const WIN = process.platform === "win32";
const fold = (p: string) => (WIN ? p.toLowerCase() : p);

/** Path of `file` below `dir` with forward slashes, or null when `file` is not inside `dir`. */
export function relativeUnder(file: string, dir: string): string | null {
	const f = resolve(file).replaceAll("\\", "/");
	const d = resolve(dir).replaceAll("\\", "/").replace(/\/+$/, "");
	if (!d || fold(f).length <= fold(d).length + 1 || fold(f).slice(0, d.length + 1) !== `${fold(d)}/`) return null;
	return f.slice(d.length + 1);
}

/** The file-system path a stored attachments.path value points at (null: no path, the base directory is unset, or the relative path would leave it). */
export function resolveStoredPath(db: Database, raw: string | null | undefined, base?: string | null): string | null {
	if (!raw) return null;
	if (!raw.startsWith(RELATIVE_PREFIX)) return raw;
	const b = base === undefined ? effectiveBaseDir(db) : base;
	if (!b) return null;
	const full = join(b, raw.slice(RELATIVE_PREFIX.length).replaceAll("\\", "/"));
	// "attachments:../x" must not climb out of the base directory
	return relativeUnder(full, b) === null ? null : full;
}

/** How a linked file's absolute path should be stored: relative to the base directory when it is inside it. */
export function toStoredPath(db: Database, abs: string, base?: string | null): string {
	if (abs.startsWith(RELATIVE_PREFIX)) return abs;
	const b = base === undefined ? effectiveBaseDir(db) : base;
	const rel = b ? relativeUnder(abs, b) : null;
	return rel ? `${RELATIVE_PREFIX}${rel}` : abs;
}

/** The stored form for a linked-file path arriving from outside (Zotero sync): relative only once the user opted in. */
export function storedFormForNewLink(db: Database, abs: string): string {
	return readConfig(db).storeRelative ? toStoredPath(db, abs) : abs;
}

/** zotero-next's own storage folder (imported files live in <storage>/<KEY>/<name>), next to the database file. */
export function ownStorageDir(db: Database): string | null {
	const f = dbFileOf(db);
	return f ? join(dirname(f), "storage") : null;
}

// ---------------------------------------------------------------- converting stored paths

export type ConvertDirection = "relative" | "absolute";

export interface ConvertPlan {
	direction: ConvertDirection;
	base: string | null;
	/** Rows that would change. */
	count: number;
	/** Linked files with an absolute path outside the base directory (direction relative only). */
	outside: number;
	sample: { key: string; from: string; to: string }[];
	rows: { key: string; to: string }[];
}

export function planConversion(db: Database, direction: ConvertDirection, sampleSize = 8): ConvertPlan {
	const base = effectiveBaseDir(db);
	const plan: ConvertPlan = { direction, base, count: 0, outside: 0, sample: [], rows: [] };
	if (direction === "relative") {
		if (!base) return plan;
		const rows = db
			.query("SELECT item_key AS key, path FROM attachments WHERE link_mode = 'linked_file' AND path IS NOT NULL AND path NOT LIKE 'attachments:%'")
			.all() as { key: string; path: string }[];
		for (const r of rows) {
			const rel = relativeUnder(r.path, base);
			if (!rel) {
				plan.outside++;
				continue;
			}
			const to = `${RELATIVE_PREFIX}${rel}`;
			plan.rows.push({ key: r.key, to });
			if (plan.sample.length < sampleSize) plan.sample.push({ key: r.key, from: r.path, to });
		}
	} else {
		const rows = db.query("SELECT item_key AS key, path FROM attachments WHERE path LIKE 'attachments:%'").all() as { key: string; path: string }[];
		for (const r of rows) {
			const to = resolveStoredPath(db, r.path, base);
			if (!to) continue;
			plan.rows.push({ key: r.key, to });
			if (plan.sample.length < sampleSize) plan.sample.push({ key: r.key, from: r.path, to });
		}
	}
	plan.count = plan.rows.length;
	return plan;
}

/** Rewrite the stored form of many paths. Sync is told nothing: the file each row points at does not change. */
export function applyConversion(db: Database, direction: ConvertDirection): { converted: number } {
	const plan = planConversion(db, direction, 0);
	if (direction === "absolute") {
		// every "attachments:" row must resolve, or converting would lose its path
		const unresolved = (db.query("SELECT count(*) AS n FROM attachments WHERE path LIKE 'attachments:%'").get() as { n: number }).n - plan.count;
		if (unresolved > 0) throw new Error(`${unresolved} relative paths cannot be resolved because no base directory is set`);
	}
	updateConfig(db, { storeRelative: direction === "relative" }); // later arrivals follow the user's last choice
	if (!plan.rows.length) return { converted: 0 };
	db.transaction(() => {
		db.run("INSERT OR IGNORE INTO sync_flags(name) VALUES('suppress')");
		try {
			const up = db.query("UPDATE attachments SET path = ? WHERE item_key = ?");
			for (const r of plan.rows) up.run(r.to, r.key);
		} finally {
			db.run("DELETE FROM sync_flags WHERE name = 'suppress'");
		}
	})();
	return { converted: plan.rows.length };
}

export function countStoredForms(db: Database): { absolute: number; relative: number } {
	const r = db
		.query(
			`SELECT sum(CASE WHEN path LIKE 'attachments:%' THEN 1 ELSE 0 END) AS rel,
			        sum(CASE WHEN link_mode = 'linked_file' AND path IS NOT NULL AND path NOT LIKE 'attachments:%' THEN 1 ELSE 0 END) AS abs
			 FROM attachments`,
		)
		.get() as { rel: number | null; abs: number | null };
	return { relative: r.rel ?? 0, absolute: r.abs ?? 0 };
}

/** Choose where "attachments:" paths resolve against. mode zotero follows Zotero's pref. */
export function setBaseDir(db: Database, mode: BaseDirMode, path?: string): BaseDirInfo {
	if (mode === "custom") {
		if (!path || !resolve(path)) throw new Error("a folder is required");
		updateConfig(db, { baseDir: resolve(path) });
	} else if (mode === "none") {
		updateConfig(db, { baseDir: null });
	} else {
		updateConfig(db, { baseDir: undefined });
	}
	return baseDirInfo(db);
}
