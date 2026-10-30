// Finding an existing Zotero installation: its profile(s), data folder, zotero.sqlite and base attachment path.
// Everything here is read-only: prefs.js is parsed, zotero.sqlite is opened read-only (never written, never locked for
// writing) and nothing is copied.
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defaultProfilesDir, isZoteroProcessRunning, listZoteroProfiles, type ZoteroProfileInfo } from "../zotero-db/env";

export interface DataDirInfo {
	dir: string;
	exists: boolean;
	databasePath: string;
	hasDatabase: boolean;
	sizeBytes: number | null;
	/** Regular (top-level) items that are not in the Zotero trash; null when the database could not be read. */
	itemCount: number | null;
	collectionCount: number | null;
	attachmentCount: number | null;
	/** Newest item modification time inside the database, else the file's modification time (ISO). */
	lastModified: string | null;
	hasStorageFolder: boolean;
	readable: boolean;
	/** Why the database could not be read (e.g. Zotero has it locked). */
	error?: string;
}

const NOT_REGULAR = "('attachment','note','annotation')";

/** Open zotero.sqlite read-only and count what is in it. Never throws. */
export function inspectDataDir(dir: string): DataDirInfo {
	const d = resolve(dir);
	const databasePath = join(d, "zotero.sqlite");
	const info: DataDirInfo = {
		dir: d,
		exists: existsSync(d),
		databasePath,
		hasDatabase: existsSync(databasePath),
		sizeBytes: null,
		itemCount: null,
		collectionCount: null,
		attachmentCount: null,
		lastModified: null,
		hasStorageFolder: existsSync(join(d, "storage")),
		readable: false,
	};
	if (!info.hasDatabase) return info;
	try {
		const st = statSync(databasePath);
		info.sizeBytes = st.size;
		info.lastModified = st.mtime.toISOString();
		const wal = `${databasePath}-wal`;
		if (existsSync(wal)) {
			const w = statSync(wal).mtime;
			if (w > st.mtime) info.lastModified = w.toISOString();
		}
	} catch {
		// size/mtime stay null
	}
	let db: Database | null = null;
	try {
		db = new Database(databasePath, { readonly: true });
		db.exec("PRAGMA busy_timeout = 400");
		const one = (sql: string) => (db!.query(sql).get() as { n: number | null } | null)?.n ?? 0;
		info.itemCount = one(
			`SELECT count(*) AS n FROM items WHERE itemID NOT IN (SELECT itemID FROM deletedItems)
			   AND itemTypeID NOT IN (SELECT itemTypeID FROM itemTypes WHERE typeName IN ${NOT_REGULAR})`,
		);
		info.attachmentCount = one(`SELECT count(*) AS n FROM itemAttachments WHERE itemID NOT IN (SELECT itemID FROM deletedItems)`);
		info.collectionCount = one(`SELECT count(*) AS n FROM collections WHERE collectionID NOT IN (SELECT collectionID FROM deletedCollections)`);
		const lm = (db.query("SELECT max(clientDateModified) AS m FROM items").get() as { m: string | null } | null)?.m;
		if (lm) info.lastModified = `${lm.replace(" ", "T")}Z`;
		info.readable = true;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		info.error = /lock|busy/i.test(msg) ? "Zotero has the database locked. Close Zotero to read it." : `Could not read the database: ${msg}`;
	} finally {
		try {
			db?.close(true);
		} catch {
			// ignore
		}
	}
	return info;
}

export interface ZoteroCandidate extends DataDirInfo {
	source: "profile" | "default" | "environment" | "documents" | "configured";
	/** Profile folder whose prefs name this data folder. */
	profile?: string;
}

export interface LocateResult {
	running: boolean;
	profilesDir: string;
	profiles: ZoteroProfileInfo[];
	/** Zotero's extensions.zotero.baseAttachmentPath (first profile that sets it). */
	baseAttachmentPath: string | null;
	candidates: ZoteroCandidate[];
	/** The data folder Zotero itself uses (the best candidate that holds a database). */
	recommended: string | null;
	installedExe: string | null;
}

export interface LocateOptions {
	profilesDir?: string;
	home?: string;
	/** Folder chosen in Settings (listed first). */
	configured?: string;
	env?: Record<string, string | undefined>;
	isRunning?: () => Promise<boolean>;
	/** Extra install locations to look for zotero.exe (tests pass none). */
	exeCandidates?: string[];
}

const key = (p: string) => resolve(p).replaceAll("\\", "/").toLowerCase();

export async function locateZotero(opts: LocateOptions = {}): Promise<LocateResult> {
	const profilesDir = opts.profilesDir ?? defaultProfilesDir();
	const home = opts.home ?? process.env.USERPROFILE ?? homedir();
	const env = opts.env ?? process.env;
	const profiles = listZoteroProfiles(profilesDir);
	const seen = new Set<string>();
	const candidates: ZoteroCandidate[] = [];
	const add = (dir: string | null | undefined, source: ZoteroCandidate["source"], profile?: string) => {
		if (!dir) return;
		const k = key(dir);
		if (seen.has(k)) return;
		seen.add(k);
		const info = inspectDataDir(dir);
		// guesses are listed only when something is there; folders named by the user or by Zotero's prefs always are
		if (!info.hasDatabase && (source === "default" || source === "documents" || source === "environment")) return;
		candidates.push({ ...info, source, profile });
	};
	add(opts.configured, "configured");
	for (const p of profiles) if (p.useDataDir !== false) add(p.dataDir, "profile", p.name);
	add(env.ZOTERO_DATA_DIR, "environment");
	add(join(home, "Zotero"), "default");
	add(join(home, "Documents", "Zotero"), "documents");
	add(join(home, "OneDrive", "Documents", "Zotero"), "documents");

	// what Zotero itself would open: a profile's pref when that folder has a database, else ~/Zotero
	const profileDirs = profiles.filter((p) => p.useDataDir !== false && p.dataDir).map((p) => key(p.dataDir!));
	const recommended =
		candidates.find((c) => c.hasDatabase && profileDirs.includes(key(c.dir)))?.dir ??
		candidates.find((c) => c.hasDatabase && c.source === "default")?.dir ??
		candidates.find((c) => c.hasDatabase)?.dir ??
		null;

	const exes = opts.exeCandidates ?? [
		join(env.ProgramFiles ?? "C:\\Program Files", "Zotero", "zotero.exe"),
		join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Zotero", "zotero.exe"),
		join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Zotero", "zotero.exe"),
	];
	return {
		running: await (opts.isRunning ?? isZoteroProcessRunning)(),
		profilesDir,
		profiles,
		baseAttachmentPath: profiles.find((p) => p.baseAttachmentPath)?.baseAttachmentPath ?? null,
		candidates,
		recommended,
		installedExe: exes.find((e) => existsSync(e)) ?? null,
	};
}
