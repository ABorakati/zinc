// Where the zotero-next library database is, for every program that opens it (the GPUI app, the Electrobun app, the browser
// connector host; word/addin/Settings.cs implements the same rule in C#). Nothing here names a user: every location comes from the
// per-user standard folders (%APPDATA%, the home folder) or an environment variable.
//
// Order (resolveLibrary):
//   1. ZN_DB, then ZN_LIBRARY (environment overrides)
//   2. the saved setting: %APPDATA%\zotero-next-gpui\library.json  {"path": "<library.sqlite>"}
//   3. the legacy location <home>\zotero-next\data\library.sqlite (where the library lived while zotero-next was only a checkout in the
//      home folder) when it exists: it is ADOPTED, i.e. written to the setting, so the library keeps opening from there for good
//   4. the default %APPDATA%\zotero-next\library.sqlite when it exists
//   5. nothing: path is null, the caller starts the first-run flow (or falls back to defaultLibraryPath)
//
// Pure node:fs / node:path, so the GPUI app can import it before anything else; every input is injectable for tests.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configDir, dataDir, homeDir } from "./platform-dirs";

export type LibrarySource = "env" | "setting" | "legacy" | "default" | "none";

export interface LocationInput {
	/** Default: process.env. */
	env?: Record<string, string | undefined>;
	/** The user's home folder. Default: %USERPROFILE% on Windows, $HOME elsewhere, else os.homedir(). */
	home?: string;
	/** Replaces the config and data folders. Default: %APPDATA% if set, else the OS standard folder (platform-dirs.ts). */
	appData?: string;
	/** Default: process.platform. */
	platform?: NodeJS.Platform;
	/** Default: fs.existsSync. */
	exists?: (path: string) => boolean;
}

export interface ResolvedLibrary {
	/** The library database to open; null when nothing is configured or found (first run). */
	path: string | null;
	source: LibrarySource;
	/** The file at `path` exists (false for a saved setting whose file is gone, e.g. an unplugged drive). */
	exists: boolean;
	/** The legacy location was just written to the setting. */
	adopted: boolean;
	/** Where a new library goes by default. */
	defaultPath: string;
}

const homeOf = (o: LocationInput): string => homeDir(o);
// Settings live in the OS config folder, the default library in the OS data folder (the same folder on Windows and macOS).
const configOf = (o: LocationInput): string => configDir(o);
const dataOf = (o: LocationInput): string => dataDir(o);
const existsOf = (o: LocationInput) => o.exists ?? existsSync;

/** The folder the GPUI app keeps its small state files in (ui-state.json, startup.json, library.json). */
export const settingsDir = (o: LocationInput = {}): string => join(configOf(o), "zotero-next-gpui");
/** The shared "library path" setting; the Word add-in reads the same file. */
export const settingsFile = (o: LocationInput = {}): string => join(settingsDir(o), "library.json");
/** Where a new library is created when the user has not chosen a place. */
export const defaultLibraryPath = (o: LocationInput = {}): string => join(dataOf(o), "zotero-next", "library.sqlite");
/** Where the library lived while zotero-next was a checkout in the home folder (<home>\zotero-next\data\library.sqlite). */
export const legacyLibraryPath = (o: LocationInput = {}): string => join(homeOf(o), "zotero-next", "data", "library.sqlite");

/** Where a NEW library goes: the default path, or library-2.sqlite, library-3.sqlite ... beside it when that name is taken (never overwrites). */
export function freshLibraryPath(o: LocationInput = {}): string {
	const exists = existsOf(o);
	const base = defaultLibraryPath(o);
	if (!exists(base)) return base;
	for (let i = 2; ; i++) {
		const p = join(dirname(base), `library-${i}.sqlite`);
		if (!exists(p)) return p;
	}
}

/** The saved library path, or null (no file, unreadable, no path in it). */
export function readLibrarySetting(o: LocationInput = {}): string | null {
	try {
		const v = JSON.parse(readFileSync(settingsFile(o), "utf8")) as { path?: unknown };
		return typeof v?.path === "string" && v.path.trim() ? v.path : null;
	} catch {
		return null;
	}
}

/** Save the library path (atomically). Other keys of the file are kept. */
export function saveLibrarySetting(path: string, o: LocationInput = {}): void {
	const file = settingsFile(o);
	let cur: Record<string, unknown> = {};
	try {
		const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (v && typeof v === "object" && !Array.isArray(v)) cur = v as Record<string, unknown>;
	} catch {
		// none yet
	}
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify({ ...cur, path }, null, 1));
	try {
		renameSync(tmp, file);
	} catch (e) {
		rmSync(tmp, { force: true });
		throw e;
	}
}

export interface ResolveOptions extends LocationInput {
	/** Write the legacy location to the setting when it is what was found (default true). false: only look (tests, read-only callers). */
	adopt?: boolean;
	/** Further places an older install may have kept the library; used like the legacy location, after it. */
	alsoLegacy?: string[];
}

/** Which library to open. See the order at the top of this file. */
export function resolveLibrary(o: ResolveOptions = {}): ResolvedLibrary {
	const env = o.env ?? process.env;
	const exists = existsOf(o);
	const defaultPath = defaultLibraryPath(o);
	const found = (path: string | null, source: LibrarySource, adopted = false): ResolvedLibrary => ({ path, source, exists: path ? exists(path) : false, adopted, defaultPath });

	const fromEnv = env.ZN_DB || env.ZN_LIBRARY;
	if (fromEnv) return found(fromEnv, "env");

	const saved = readLibrarySetting(o);
	if (saved) return found(saved, "setting");

	for (const legacy of [legacyLibraryPath(o), ...(o.alsoLegacy ?? [])]) {
		if (!exists(legacy)) continue;
		let adopted = false;
		if (o.adopt !== false) {
			try {
				saveLibrarySetting(legacy, o);
				adopted = true;
			} catch {
				// read-only profile: still open it, adopt next time
			}
		}
		return found(legacy, "legacy", adopted);
	}

	if (exists(defaultPath)) return found(defaultPath, "default");
	return found(null, "none");
}

const norm = (p: string) => p.replaceAll("\\", "/").toLowerCase();

/** True when `path` is one of the user's real libraries (the saved one, the legacy one or the default), which a development run must not open by accident. */
export function isRealLibrary(path: string, o: LocationInput = {}): boolean {
	const real = [readLibrarySetting(o), legacyLibraryPath(o), defaultLibraryPath(o)];
	return real.some((r) => r && norm(r) === norm(path));
}
