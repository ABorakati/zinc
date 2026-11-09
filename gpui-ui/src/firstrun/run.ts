// Wires the first-run screen to the real app: Zotero detection and the importer (core/src/files/zotero-locate.ts,
// core/src/import/zotero.ts), the native dialogs, and the saved library setting (core/src/library-location.ts).
// main.tsx calls runFirstRun() when packaged.ts found no usable library; it resolves once the choice is saved and the
// environment (ZN_DB) points at the library, so the normal start-up (core, store, App) can go on in the same process.
import { createComponent, type Component } from "solid-js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { freshLibraryPath, saveLibrarySetting } from "../../../core/src/library-location";
import type { Mode } from "../contracts";
import { backupOnce, startup } from "../packaged";
import { canPickFolder, pickFile, pickFolder } from "../shell/native";
import { mark } from "../trace";
import { FirstRun, type FirstRunApi } from "./FirstRun";
import { inspectLibraryFile } from "./libraryFile";
import type { ZoteroFound } from "./logic";

interface DataDirInfo { dir: string; hasDatabase: boolean; readable: boolean; itemCount: number | null; collectionCount: number | null; attachmentCount: number | null; error?: string }
interface Locate { running: boolean; recommended: string | null; candidates: DataDirInfo[] }
// the core's modules are imported lazily by literal specifier (a bundler can follow them; `as string` keeps their sources out of this app's `bun check`)
const locateMod = () => import("../../../core/src/files/zotero-locate" as string) as Promise<{ locateZotero(): Promise<Locate>; inspectDataDir(dir: string): DataDirInfo }>;
const importMod = () => import("../../../core/src/import/zotero" as string) as Promise<{
	importZotero(o: { zoteroDir: string; targetDbPath: string; onProgress?: (p: { phase: string; done?: number; total?: number; message?: string }) => void }): Promise<unknown>;
}>;

const found = (i: DataDirInfo, running?: boolean): ZoteroFound => ({
	dir: i.dir, hasDatabase: i.hasDatabase, readable: i.readable, itemCount: i.itemCount, collectionCount: i.collectionCount, attachmentCount: i.attachmentCount, running, error: i.error,
});

/** The real implementation of the screen's API. `target` is where a new library is created (default: %APPDATA%\zotero-next\library.sqlite). */
export function realFirstRunApi(target: string = freshLibraryPath()): FirstRunApi {
	return {
		defaultPath: target,
		notice: startup.error ? `${startup.error}. Choose a library below; the missing file is left alone.` : undefined,
		get canPick() { return canPickFolder(); },
		async detectZotero() {
			const { locateZotero } = await locateMod();
			const r = await locateZotero();
			const c = r.candidates.find((x) => x.dir === r.recommended);
			return c ? found(c, r.running) : null;
		},
		async pickZoteroFolder() {
			const dir = await pickFolder("Choose your Zotero data folder (the one with zotero.sqlite)");
			if (!dir) return null;
			const { inspectDataDir } = await locateMod();
			return found(inspectDataDir(dir));
		},
		async importFromZotero(dir, onProgress) {
			mkdirSync(dirname(target), { recursive: true });
			const { importZotero } = await importMod();
			await importZotero({ zoteroDir: dir, targetDbPath: target, onProgress }); // refuses to overwrite: `target` is a name nothing uses
			return target;
		},
		async pickLibrary() {
			const path = await pickFile("Choose a Zinc library file (library.sqlite)");
			if (!path) return null;
			const info = inspectLibraryFile(path);
			if (info.kind !== "zotero-next") return { problem: info.problem ?? "That file is not a Zinc library." };
			try { backupOnce(path); } catch (e) { return { problem: `Could not make a backup copy of that library before opening it: ${(e as Error).message}` }; }
			return { path };
		},
		async createEmpty() {
			mkdirSync(dirname(target), { recursive: true });
			return target; // the core creates and migrates the database file when it opens it
		},
		done(path) {
			saveLibrarySetting(path);
			process.env.ZN_DB = path;
			process.env.ZN_ALLOW_REAL_DB = "1"; // the user just chose this library
			Object.assign(startup, { library: "in-process", db: path, firstRun: false, error: undefined });
		},
	};
}

/** Show the first-run screen in place of the app (via main.tsx's setApp); resolves with the chosen library's path once it is saved. */
export function runFirstRun(setApp: (c: Component | null) => void, mode: Mode, api: FirstRunApi = realFirstRunApi()): Promise<string> {
	return new Promise((resolve) => {
		const wrapped: FirstRunApi = Object.create(api, {
			done: { value: (path: string) => { api.done(path); setApp(null); resolve(path); } },
		});
		setApp(() => createComponent(FirstRun, { api: wrapped, mode }));
		mark("firstrun-shown");
	});
}
