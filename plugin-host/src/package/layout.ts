// Where plugins live on disk. Under Zinc's data folder (the config/data folder of core/src/platform-dirs.ts, in the
// "zotero-next-gpui" subfolder that gpui-ui uses for library.json and ui-state.json):
//
//   <root>/                     %APPDATA%\zotero-next-gpui\plugins   (override: ZN_PLUGINS_DIR)
//     installed/<id>/           the loadable folder of phase2-core: manifest.json, plugin.wasm, transpiled/plugin.js (+ core wasm),
//                               locale/, icons/, anything else the package shipped. Read only for the plugin (fs root `bundled`).
//     data/<id>/                the plugin's private folder (fs root `data`); removed on uninstall unless the user keeps it
//     temp/                     scratch for fs root `temp` (emptied at start)
//     prefs/<id>.json           user-set prefs of the plugin
//     secrets/<id>.json         encrypted secrets; secrets/master.key* is the wrapped key
//     state.json                installed plugins: version, enabled, hash of the transpiled output
//     grants.json               what the user granted each plugin
//     .staging/, .trash/        work folders of the installer
import { homedir } from "node:os";
import { join } from "node:path";

export interface Layout {
	root: string;
	installed(id: string): string;
	installedRoot: string;
	data(id: string): string;
	dataRoot: string;
	tempRoot: string;
	prefsFile(id: string): string;
	secretsFile(id: string): string;
	secretsDir: string;
	stateFile: string;
	grantsFile: string;
	staging: string;
	trash: string;
}

/** Zinc's data folder for plugins. Explicit ZN_PLUGINS_DIR wins; APPDATA is honoured on every platform (test runs set it). */
export function pluginsRoot(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string {
	if (env.ZN_PLUGINS_DIR) return env.ZN_PLUGINS_DIR;
	const home = (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
	let base = env.APPDATA;
	if (!base) {
		if (platform === "win32") base = join(home, "AppData", "Roaming");
		else if (platform === "darwin") base = join(home, "Library", "Application Support");
		else base = env.XDG_DATA_HOME || join(home, ".local", "share");
	}
	return join(base, "zotero-next-gpui", "plugins");
}

/** A plugin id is safe as a folder name once the manifest schema accepted it; this is the second check at every path build. */
export function assertSafeId(id: string): void {
	if (!/^[A-Za-z0-9._+@{}-]{3,128}$/.test(id) || id === "." || id === ".." || id.includes("..")) throw new Error(`unsafe plugin id "${id}"`);
}

export function createLayout(root: string): Layout {
	const byId = (dir: string, ext = "") => (id: string) => {
		assertSafeId(id);
		return join(dir, id + ext);
	};
	return {
		root,
		installedRoot: join(root, "installed"),
		installed: byId(join(root, "installed")),
		dataRoot: join(root, "data"),
		data: byId(join(root, "data")),
		tempRoot: join(root, "temp"),
		prefsFile: byId(join(root, "prefs"), ".json"),
		secretsDir: join(root, "secrets"),
		secretsFile: byId(join(root, "secrets"), ".json"),
		stateFile: join(root, "state.json"),
		grantsFile: join(root, "grants.json"),
		staging: join(root, ".staging"),
		trash: join(root, ".trash"),
	};
}
