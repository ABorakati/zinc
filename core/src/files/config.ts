// zotero-next's small per-library settings file: <folder of library.sqlite>/zotero-next.config.json.
// Holds the Zotero data folder chosen in Settings, the linked-attachment base directory and the attachment
// storage location. Environment variables (ZN_ZOTERO_DIR) still win over it, for tests and development.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface StorageConfig {
	/** Custom folder for new/moved attachments; absent: zotero-next's own <db folder>/storage/<KEY>/ layout. */
	dir?: string;
	/** Subfolder pattern under `dir`, e.g. "{%a}/{%y}". */
	subfolder?: string;
	/** Store files in the custom folder as linked files (ZotMoov style) instead of imported files. */
	linked?: boolean;
}

export interface FilesConfig {
	/** Zotero data folder (contains zotero.sqlite); absent: auto-detected from Zotero's prefs. */
	zoteroDataDir?: string;
	/** Linked-attachment base directory. undefined: follow Zotero's pref; null: none; string: custom folder. */
	baseDir?: string | null;
	/** New linked-file paths (arriving from Zotero sync) are stored as "attachments:<relative>" when inside the base directory. Off until the user converts. */
	storeRelative?: boolean;
	storage?: StorageConfig;
}

export function dbFileOf(db: Database): string | null {
	const f = (db as unknown as { filename?: string }).filename;
	return f && f !== ":memory:" ? f : null;
}

export function configFileFor(dbFile: string): string {
	return join(dirname(dbFile), "zotero-next.config.json");
}

const memory = new WeakMap<Database, FilesConfig>(); // in-memory databases have no file to keep a config in
const cache = new Map<string, { cfg: FilesConfig; at: number }>();
const TTL_MS = 2000;

export function readConfigFile(file: string): FilesConfig {
	try {
		const v = JSON.parse(readFileSync(file, "utf8"));
		return v && typeof v === "object" && !Array.isArray(v) ? (v as FilesConfig) : {};
	} catch {
		return {};
	}
}

export function readConfig(db: Database): FilesConfig {
	const f = dbFileOf(db);
	if (!f) return memory.get(db) ?? {};
	const hit = cache.get(f);
	const now = Date.now();
	if (hit && now - hit.at < TTL_MS) return hit.cfg;
	const cfg = readConfigFile(configFileFor(f));
	cache.set(f, { cfg, at: now });
	return cfg;
}

/** Merge `patch` into the config (keys set to undefined are removed) and write it atomically. */
export function updateConfig(db: Database, patch: Partial<FilesConfig>): FilesConfig {
	const next: Record<string, unknown> = { ...readConfig(db) };
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) delete next[k];
		else next[k] = v;
	}
	const cfg = next as FilesConfig;
	const f = dbFileOf(db);
	if (!f) {
		memory.set(db, cfg);
		return cfg;
	}
	const file = configFileFor(f);
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify(cfg, null, 2));
	renameSync(tmp, file);
	cache.set(f, { cfg, at: Date.now() });
	return cfg;
}

export function clearConfigCache(): void {
	cache.clear();
}

/**
 * The Zotero data folder to use for sync and import, as the app should call it at start-up:
 * ZN_ZOTERO_DIR, else the folder chosen in Settings, else undefined (zotero-db then reads Zotero's prefs.js).
 */
export function configuredZoteroDataDir(dbFile: string, env: Record<string, string | undefined> = process.env): string | undefined {
	if (env.ZN_ZOTERO_DIR) return env.ZN_ZOTERO_DIR;
	const f = configFileFor(dbFile);
	const dir = existsSync(f) ? readConfigFile(f).zoteroDataDir : undefined;
	return typeof dir === "string" && dir ? dir : undefined;
}
