// The per-user standard folders of the operating system, in one place, so no program assumes Windows' %APPDATA%.
//
//   config / data     Windows: %APPDATA% (<home>\AppData\Roaming) for both
//                     macOS:   ~/Library/Application Support for both
//                     Linux:   $XDG_CONFIG_HOME (~/.config) for settings, $XDG_DATA_HOME (~/.local/share) for data
//   local data        Windows: %LOCALAPPDATA% (<home>\AppData\Local); macOS and Linux: the same as data
//
// An explicit APPDATA (and LOCALAPPDATA for local data) in the environment wins on EVERY platform: test scripts and isolated runs
// point it at a scratch folder and rely on that on Linux and macOS too.
//
// Pure node:os / node:path. Platform, environment and home are injectable so tests can resolve linux and darwin paths from Windows.
import { homedir } from "node:os";
import { join } from "node:path";

export interface DirInput {
	/** Default: process.platform. */
	platform?: NodeJS.Platform;
	/** Default: process.env. */
	env?: Record<string, string | undefined>;
	/** The user's home folder. Default: %USERPROFILE% on Windows, $HOME elsewhere, else os.homedir(). */
	home?: string;
	/** Replaces the config and data folders outright (callers that already resolved or injected an APPDATA). */
	appData?: string;
}

const platformOf = (o: DirInput): NodeJS.Platform => o.platform ?? process.platform;
const envOf = (o: DirInput): Record<string, string | undefined> => o.env ?? process.env;
const nonEmpty = (v: string | undefined): string | undefined => (v ? v : undefined);

export function homeDir(o: DirInput = {}): string {
	if (o.home) return o.home;
	const env = envOf(o);
	return nonEmpty(platformOf(o) === "win32" ? env.USERPROFILE : env.HOME) ?? homedir();
}

/** Where small settings and state files go. */
export function configDir(o: DirInput = {}): string {
	const env = envOf(o);
	const explicit = o.appData ?? nonEmpty(env.APPDATA);
	if (explicit) return explicit;
	const home = homeDir(o);
	switch (platformOf(o)) {
		case "win32":
			return join(home, "AppData", "Roaming");
		case "darwin":
			return join(home, "Library", "Application Support");
		default:
			return nonEmpty(env.XDG_CONFIG_HOME) ?? join(home, ".config");
	}
}

/** Where user data (the default library) goes. */
export function dataDir(o: DirInput = {}): string {
	const env = envOf(o);
	const explicit = o.appData ?? nonEmpty(env.APPDATA);
	if (explicit) return explicit;
	const home = homeDir(o);
	switch (platformOf(o)) {
		case "win32":
			return join(home, "AppData", "Roaming");
		case "darwin":
			return join(home, "Library", "Application Support");
		default:
			return nonEmpty(env.XDG_DATA_HOME) ?? join(home, ".local", "share");
	}
}

/** Machine-local data that must not roam (updates, helper binaries). */
export function localDataDir(o: DirInput = {}): string {
	const env = envOf(o);
	const explicit = nonEmpty(env.LOCALAPPDATA);
	if (explicit) return explicit;
	if (platformOf(o) === "win32") return join(homeDir(o), "AppData", "Local");
	return dataDir({ ...o, appData: undefined, env: { ...env, APPDATA: undefined } });
}

/** The folder that holds Zotero's profile folders (each with a prefs.js); profiles.ini sits beside them or one level up. */
export function zoteroProfilesDir(o: DirInput = {}): string {
	const platform = platformOf(o);
	// Zotero keeps its profile in a fixed per-OS place that does not follow XDG, so only an explicit APPDATA moves it (and only on Windows
	// and in test runs, which set APPDATA to a scratch folder on every OS).
	const explicit = o.appData ?? nonEmpty(envOf(o).APPDATA);
	if (platform === "win32") return join(explicit ?? join(homeDir(o), "AppData", "Roaming"), "Zotero", "Zotero", "Profiles");
	if (explicit) return join(explicit, "Zotero", "Zotero", "Profiles");
	if (platform === "darwin") return join(homeDir(o), "Library", "Application Support", "Zotero", "Profiles");
	return join(homeDir(o), ".zotero", "zotero");
}

/** Places Mendeley Desktop may keep its data, most likely first (the caller keeps the ones that exist). */
export function mendeleyDataDirs(o: DirInput = {}): string[] {
	const env = envOf(o);
	const platform = platformOf(o);
	const dirs: string[] = [];
	// %LOCALAPPDATA%\Mendeley Ltd\Mendeley Desktop is the Windows place; an explicit LOCALAPPDATA is honoured everywhere (test runs).
	const local = nonEmpty(env.LOCALAPPDATA) ?? (platform === "win32" ? join(homeDir(o), "AppData", "Local") : undefined);
	if (local) dirs.push(join(local, "Mendeley Ltd", "Mendeley Desktop"), join(local, "Mendeley Ltd.", "Mendeley Desktop"));
	if (platform === "darwin") dirs.push(join(homeDir(o), "Library", "Application Support", "Mendeley Desktop"));
	else if (platform !== "win32")
		dirs.push(join(nonEmpty(env.XDG_DATA_HOME) ?? join(homeDir(o), ".local", "share"), "data", "Mendeley Ltd.", "Mendeley Desktop"));
	return dirs;
}
