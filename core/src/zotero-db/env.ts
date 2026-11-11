// Locating the Zotero data directory, detecting a running Zotero, and probing the SQLite write lock.
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zoteroProfilesDir } from "../platform-dirs";

export interface ZoteroDbOptions {
	/** Zotero data directory (contains zotero.sqlite and storage/). Default: prefs.js dataDir, else ~/Zotero. */
	dataDir?: string;
	/** Override the Zotero profiles folder (%APPDATA%\Zotero\Zotero\Profiles on Windows; for tests). */
	profilesDir?: string;
	/** Override the zotero.exe process check (tests that work on database copies). */
	isRunning?: () => Promise<boolean>;
	/** Library to read/write; default: the first type='user' library. */
	libraryID?: number;
	/** Zotero's baseAttachmentPath pref; default: read from prefs.js. */
	baseAttachmentPath?: string | null;
	/** Number of backups kept in <dataDir>/zotero-next-backups (default 5). */
	keepBackups?: number;
}

export function defaultProfilesDir(): string {
	return zoteroProfilesDir();
}

/** Value of one `user_pref("name", value)` line of a prefs.js text; null when absent or malformed. */
export function parsePref(prefsText: string, name: string): string | boolean | number | null {
	const re = new RegExp(`user_pref\\("${name.replaceAll(".", "\\.")}",\\s*("(?:[^"\\\\]|\\\\.)*"|true|false|-?\\d+)\\)`);
	const m = re.exec(prefsText);
	if (!m) return null;
	try {
		return JSON.parse(m[1]);
	} catch {
		return null;
	}
}

/** Read a string/boolean pref from the first profile's prefs.js that sets it. */
export function readZoteroPref(name: string, profilesDir: string = defaultProfilesDir()): string | boolean | number | null {
	if (!existsSync(profilesDir)) return null;
	for (const d of readdirSync(profilesDir)) {
		const p = join(profilesDir, d, "prefs.js");
		if (!existsSync(p)) continue;
		const v = parsePref(readFileSync(p, "utf8"), name);
		if (v !== null) return v;
	}
	return null;
}

export interface ZoteroProfileInfo {
	/** Profile folder name, e.g. "y1hq89n6.default". */
	name: string;
	dir: string;
	prefsPath: string;
	/** extensions.zotero.dataDir (null: not set, Zotero uses ~/Zotero). */
	dataDir: string | null;
	useDataDir: boolean | null;
	baseAttachmentPath: string | null;
	saveRelativeAttachmentPath: boolean | null;
}

/** Every Zotero profile that has a prefs.js, with the file-location prefs read from it. */
export function listZoteroProfiles(profilesDir: string = defaultProfilesDir()): ZoteroProfileInfo[] {
	if (!existsSync(profilesDir)) return [];
	const out: ZoteroProfileInfo[] = [];
	for (const name of readdirSync(profilesDir)) {
		const prefsPath = join(profilesDir, name, "prefs.js");
		if (!existsSync(prefsPath)) continue;
		let text: string;
		try {
			text = readFileSync(prefsPath, "utf8");
		} catch {
			continue;
		}
		const str = (n: string) => {
			const v = parsePref(text, n);
			return typeof v === "string" && v ? v : null;
		};
		const bool = (n: string) => {
			const v = parsePref(text, n);
			return typeof v === "boolean" ? v : null;
		};
		out.push({
			name,
			dir: join(profilesDir, name),
			prefsPath,
			dataDir: str("extensions.zotero.dataDir"),
			useDataDir: bool("extensions.zotero.useDataDir"),
			baseAttachmentPath: str("extensions.zotero.baseAttachmentPath"),
			saveRelativeAttachmentPath: bool("extensions.zotero.saveRelativeAttachmentPath"),
		});
	}
	return out;
}

export function findZoteroDataDir(profilesDir?: string): string {
	const dir = readZoteroPref("extensions.zotero.dataDir", profilesDir);
	const use = readZoteroPref("extensions.zotero.useDataDir", profilesDir);
	if (typeof dir === "string" && dir && use !== false && existsSync(join(dir, "zotero.sqlite"))) return dir;
	return join(homedir(), "Zotero");
}

export function findBaseAttachmentPath(profilesDir?: string): string | null {
	const v = readZoteroPref("extensions.zotero.baseAttachmentPath", profilesDir);
	return typeof v === "string" && v ? v : null;
}

/** True if any Zotero process exists (conservative: does not look at which profile it uses). */
export async function isZoteroProcessRunning(): Promise<boolean> {
	try {
		if (process.platform === "win32") {
			const p = Bun.spawn(["tasklist", "/FI", "IMAGENAME eq zotero.exe", "/FO", "CSV", "/NH"], {
				windowsHide: true, // a console-less parent (the packaged GPUI app) would otherwise flash a console window
				stdout: "pipe",
				stderr: "ignore",
			});
			const out = (await new Response(p.stdout).text()).toLowerCase();
			await p.exited;
			return out.includes('"zotero.exe"');
		}
		// "zotero" on macOS, "zotero-bin" from the Linux tarball; pgrep reads the name as a regular expression
		const p = Bun.spawn(["pgrep", "-xi", "zotero|zotero-bin"], { stdout: "pipe", stderr: "ignore" });
		const out = await new Response(p.stdout).text();
		await p.exited;
		return out.trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * True if the SQLite file can be locked for writing right now: open read-write and take
 * BEGIN IMMEDIATE (fails with SQLITE_BUSY while Zotero holds its exclusive lock), then roll back.
 */
export function probeWritable(dbPath: string): boolean {
	if (!existsSync(dbPath)) return false;
	let db: Database | null = null;
	try {
		db = new Database(dbPath, { readwrite: true });
		db.exec("PRAGMA busy_timeout = 250");
		db.exec("BEGIN IMMEDIATE");
		db.exec("ROLLBACK");
		return true;
	} catch {
		return false;
	} finally {
		try {
			db?.close(true);
		} catch {
			// ignore
		}
	}
}

export function isBusyError(e: unknown): boolean {
	const s = `${(e as { code?: string })?.code ?? ""} ${String((e as Error)?.message ?? e)}`.toUpperCase();
	return s.includes("SQLITE_BUSY") || s.includes("SQLITE_LOCKED") || s.includes("DATABASE IS LOCKED") || s.includes("SQLITE_CANTOPEN");
}

/** Copy zotero.sqlite + -wal + -shm together into destDir (a consistent-enough snapshot of a locked DB). */
export function snapshotCopy(dbPath: string, destDir: string): string {
	mkdirSync(destDir, { recursive: true });
	for (const ext of ["", "-wal", "-shm"]) {
		const f = dbPath + ext;
		if (!existsSync(f)) continue;
		try {
			copyFileSync(f, join(destDir, `zotero.sqlite${ext}`));
		} catch (e) {
			// The -shm is a memory-mapped index that SQLite rebuilds from the -wal; it may be locked.
			if (ext !== "-shm") throw e;
		}
	}
	return join(destDir, "zotero.sqlite");
}

export function mtimeMs(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/** Resolved absolute path -> Zotero raw path with 'attachments:' base-dir relativisation. */
export function toRelativeAttachmentPath(path: string, baseAttachmentPath: string | null): string {
	if (!baseAttachmentPath || path.startsWith("attachments:")) return path;
	const base = baseAttachmentPath.replaceAll("\\", "/").replace(/\/+$/, "");
	const p = path.replaceAll("\\", "/");
	if (p.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return `attachments:${p.slice(base.length + 1)}`;
	return path;
}

export function fromRelativeAttachmentPath(raw: string, baseAttachmentPath: string | null): string | null {
	if (!raw.startsWith("attachments:")) return raw;
	if (!baseAttachmentPath) return null;
	return join(baseAttachmentPath, raw.slice("attachments:".length));
}
