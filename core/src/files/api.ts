// Routes under /api/files/: the Settings "Files and Folders" rows and "find my Zotero".
//   GET  /settings                 -> FilesSettingsView (library path, Zotero folder, base directory, storage location)
//   GET  /zotero                   -> LocateResult (profiles, candidate data folders with item counts, running?)
//   POST /zotero/validate {dir}    -> DataDirInfo of any folder
//   PUT  /zotero {dir|null}        -> FilesSettingsView; uses that Zotero data folder for sync and import (null: auto)
//   PUT  /base-dir {mode, path?}   -> FilesSettingsView; mode zotero (follow Zotero's pref) | custom | none
//   POST /base-dir/convert {direction: "relative"|"absolute", confirm?}
//                                  -> preview {count, outside, sample} without confirm; {converted} with confirm: true
//   PUT  /storage {dir?, subfolder?, linked?, auto?, behavior?, allowedExt?, rename?, renameTitle?, addTag?, tag?, stripDiacritics?,
//                  undefinedStr?, deleteFiles?, pruneEmptyDirs?, attachDir?, attachConfirm?}      -> FilesSettingsView
//   POST /storage/preset {dir}     -> FilesSettingsView; ZotMoov's defaults around that one folder
//   POST /storage/move {confirm?}  -> preview {count, totalBytes, sample, skipped...} without confirm; MoveReport with confirm: true
//   POST /organize {action: move|copy|to-stored, keys, dir?, collectionKey?, preview?}
//                                  -> the move/copy/convert commands on selected items; preview: what would happen; else MoveReport
//   POST /attach-newest {parentKey, name?, preview?}    -> attach the newest file of the "attach from" folder; preview: which file, which name
//   POST /pick-folder {start?}     -> {path|null}   (native folder dialog, supplied by the app)
//   POST /reveal {what: "library"|"zotero"|"baseDir"|"storage"}  -> {ok}
import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { HttpError, clearFileCache } from "../db";
import { getSyncService, startSyncService, stopSync } from "../sync";
import { createZoteroBackends, findZoteroDataDir } from "../zotero-db";
import { configFileFor, configuredZoteroDataDir, dbFileOf, readConfig, updateConfig } from "./config";
import {
	applyConversion,
	baseDirInfo,
	countStoredForms,
	planConversion,
	setBaseDir,
	zoteroProfilesDir,
	type BaseDirMode,
	type ConvertDirection,
} from "./paths";
import { attachNewest, planOrganize, previewAttachNewest } from "./organize";
import { applyZotMoovPreset, planMove, runMove, setStorage, storageView } from "./storage";
import { inspectDataDir, locateZotero } from "./zotero-locate";

// ---------------------------------------------------------------- app-supplied OS hooks

type FolderPicker = (startIn?: string) => Promise<string | null>;
type Revealer = (path: string) => void;

let picker: FolderPicker | null = null;
/** The app registers its native folder dialog here (core cannot import the UI toolkit). */
export function setFolderPicker(fn: FolderPicker | null): void {
	picker = fn;
}

const defaultRevealer: Revealer = (path) => {
	const p = Bun.spawn(["explorer.exe", "/select,", path], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	p.unref();
};
let revealer: Revealer = defaultRevealer;
/** Tests: replace the Explorer launcher. Call with no argument to restore it. */
export function setRevealer(fn?: Revealer): void {
	revealer = fn ?? defaultRevealer;
}

// ---------------------------------------------------------------- views

export function zoteroDataDirInUse(db: Database): { dir: string; source: "environment" | "settings" | "zotero" } {
	const f = dbFileOf(db);
	const configured = f ? configuredZoteroDataDir(f) : readConfig(db).zoteroDataDir;
	if (process.env.ZN_ZOTERO_DIR) return { dir: process.env.ZN_ZOTERO_DIR, source: "environment" };
	if (configured) return { dir: configured, source: "settings" };
	return { dir: findZoteroDataDir(zoteroProfilesDir()), source: "zotero" };
}

function sizeOf(path: string | null): number | null {
	try {
		return path ? statSync(path).size : null;
	} catch {
		return null;
	}
}

export function filesSettingsView(db: Database) {
	const f = dbFileOf(db);
	const z = zoteroDataDirInUse(db);
	return {
		library: { dbPath: f, configPath: f ? configFileFor(f) : null, sizeBytes: sizeOf(f) },
		zotero: { dataDir: z.dir, source: z.source, configured: readConfig(db).zoteroDataDir ?? null },
		baseDir: { ...baseDirInfo(db), stored: countStoredForms(db) },
		storage: storageView(db),
	};
}

// ---------------------------------------------------------------- sync restart

async function restartSync(db: Database, dir: string): Promise<void> {
	if (!getSyncService(db)) return; // sync is not running in this process (tests, headless core)
	await stopSync(db);
	await startSyncService(db, { dataDir: dir, ...createZoteroBackends(dir, { keepBackups: 2 }) });
}

// ---------------------------------------------------------------- handler

async function body(req: Request): Promise<Record<string, unknown>> {
	try {
		const b = await req.json();
		return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
	} catch {
		throw new HttpError(400, "invalid JSON body");
	}
}

const str = (v: unknown, name: string): string => {
	if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${name} is required`);
	return v.trim();
};

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export async function handleFilesApi(req: Request, db: Database): Promise<Response | null> {
	const { pathname } = new URL(req.url);
	if (!pathname.startsWith("/api/files/")) return null;
	try {
		return Response.json(await dispatch(req, db, pathname.slice("/api/files/".length).replace(/\/$/, "")));
	} catch (e) {
		if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
		console.error(e);
		return Response.json({ error: e instanceof Error ? e.message : "internal error" }, { status: 500 });
	}
}

async function dispatch(req: Request, db: Database, route: string): Promise<unknown> {
	const m = req.method;
	if (m === "GET" && route === "settings") return filesSettingsView(db);

	if (m === "GET" && route === "zotero") {
		const cfg = readConfig(db).zoteroDataDir;
		return { ...(await locateZotero({ configured: cfg, profilesDir: zoteroProfilesDir() })), inUse: zoteroDataDirInUse(db) };
	}
	if (m === "POST" && route === "zotero/validate") return inspectDataDir(str((await body(req)).dir, "dir"));
	if (m === "PUT" && route === "zotero") {
		const dir = (await body(req)).dir;
		if (dir === null || dir === undefined || dir === "") updateConfig(db, { zoteroDataDir: undefined });
		else {
			const info = inspectDataDir(str(dir, "dir"));
			if (!info.hasDatabase) throw new HttpError(400, `no zotero.sqlite in ${info.dir}`);
			updateConfig(db, { zoteroDataDir: info.dir });
		}
		await restartSync(db, zoteroDataDirInUse(db).dir);
		return filesSettingsView(db);
	}

	if (m === "PUT" && route === "base-dir") {
		const b = await body(req);
		const mode = b.mode as BaseDirMode;
		if (mode !== "zotero" && mode !== "custom" && mode !== "none") throw new HttpError(400, "mode must be zotero, custom or none");
		let path: string | undefined;
		if (mode === "custom") {
			path = str(b.path, "path");
			if (!isDir(path)) throw new HttpError(400, `${path} is not a folder`);
		}
		const before = baseDirInfo(db);
		const after = setBaseDir(db, mode, path);
		const stored = countStoredForms(db);
		if (!after.effective && stored.relative > 0) {
			setBaseDir(db, before.mode, before.configured ?? undefined); // put it back
			throw new HttpError(
				409,
				`${stored.relative} linked files are stored relative to the base directory. Convert them to absolute paths first.`,
			);
		}
		return filesSettingsView(db);
	}
	if (m === "POST" && route === "base-dir/convert") {
		const b = await body(req);
		const direction = b.direction as ConvertDirection;
		if (direction !== "relative" && direction !== "absolute") throw new HttpError(400, "direction must be relative or absolute");
		const plan = planConversion(db, direction);
		if (b.confirm !== true) return { direction, base: plan.base, count: plan.count, outside: plan.outside, sample: plan.sample };
		try {
			return { ...applyConversion(db, direction), ...filesSettingsView(db) };
		} catch (e) {
			throw new HttpError(409, e instanceof Error ? e.message : String(e));
		}
	}

	if (m === "PUT" && route === "storage") {
		const b = await body(req);
		const bool = (k: string) => (typeof b[k] === "boolean" ? (b[k] as boolean) : undefined);
		const text = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : undefined);
		const folder = (k: string) => (b[k] === null ? null : text(k));
		try {
			setStorage(db, {
				dir: folder("dir"),
				subfolder: text("subfolder"),
				linked: bool("linked"),
				auto: bool("auto"),
				behavior: b.behavior === "move" || b.behavior === "copy" ? b.behavior : undefined,
				allowedExt: Array.isArray(b.allowedExt) ? b.allowedExt.map(String) : undefined,
				rename: bool("rename"),
				renameTitle: bool("renameTitle"),
				addTag: bool("addTag"),
				tag: text("tag"),
				stripDiacritics: bool("stripDiacritics"),
				undefinedStr: text("undefinedStr"),
				deleteFiles: bool("deleteFiles"),
				pruneEmptyDirs: bool("pruneEmptyDirs"),
				attachDir: folder("attachDir"),
				attachConfirm: bool("attachConfirm"),
			});
		} catch (e) {
			throw new HttpError(400, e instanceof Error ? e.message : String(e));
		}
		return filesSettingsView(db);
	}
	if (m === "POST" && route === "storage/preset") {
		// ZotMoov's defaults around one folder: automatic move, linked files, rename from the parent, tag, pdf/epub/docx/djvu
		const dir = str((await body(req)).dir, "dir");
		try {
			applyZotMoovPreset(db, dir);
		} catch (e) {
			throw new HttpError(400, e instanceof Error ? e.message : String(e));
		}
		return filesSettingsView(db);
	}
	if (m === "POST" && route === "organize") {
		const b = await body(req);
		const action = b.action;
		if (action !== "move" && action !== "copy" && action !== "to-stored")
			throw new HttpError(400, "action must be move, copy or to-stored");
		if (!Array.isArray(b.keys) || !b.keys.length || b.keys.some((k) => typeof k !== "string"))
			throw new HttpError(400, "keys must be a list of item keys");
		const orgReq = {
			action,
			keys: b.keys as string[],
			dir: typeof b.dir === "string" ? b.dir : undefined,
			collectionKey: typeof b.collectionKey === "string" ? b.collectionKey : undefined,
		} as const;
		if (b.preview === true) {
			const plan = planOrganize(db, orgReq);
			const reasons = new Map<string, number>();
			for (const s of plan.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
			return {
				target: plan.target,
				count: plan.count,
				totalBytes: plan.totalBytes,
				onlineOnly: plan.onlineOnly,
				sample: plan.sample,
				skippedByReason: [...reasons].map(([reason, count]) => ({ reason, count })),
				skippedSample: plan.skipped.slice(0, 15),
			};
		}
		let report;
		try {
			report = await runMove(db, planOrganize(db, orgReq));
		} catch (e) {
			if (e instanceof HttpError) throw e;
			throw new HttpError(409, e instanceof Error ? e.message : String(e));
		}
		clearFileCache();
		return { ...report, skipped: report.skipped.length, skippedSample: report.skipped.slice(0, 15) };
	}
	if (m === "POST" && route === "attach-newest") {
		const b = await body(req);
		const parentKey = str(b.parentKey, "parentKey");
		if (b.preview === true) return previewAttachNewest(db, parentKey);
		const r = attachNewest(db, { parentKey, name: typeof b.name === "string" ? b.name : undefined });
		clearFileCache();
		return r;
	}
	if (m === "POST" && route === "storage/move") {
		const b = await body(req);
		let plan;
		try {
			plan = planMove(db);
		} catch (e) {
			throw new HttpError(400, e instanceof Error ? e.message : String(e));
		}
		if (b.confirm !== true) {
			const reasons = new Map<string, number>();
			for (const s of plan.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
			return {
				target: plan.target,
				count: plan.count,
				totalBytes: plan.totalBytes,
				onlineOnly: plan.onlineOnly,
				sample: plan.sample,
				skippedByReason: [...reasons].map(([reason, count]) => ({ reason, count })),
				skippedSample: plan.skipped.slice(0, 15),
			};
		}
		let report;
		try {
			report = await runMove(db, plan);
		} catch (e) {
			throw new HttpError(409, e instanceof Error ? e.message : String(e));
		}
		clearFileCache();
		return { ...report, skipped: report.skipped.length, skippedSample: report.skipped.slice(0, 15) };
	}

	if (m === "POST" && route === "pick-folder") {
		if (!picker) throw new HttpError(501, "no folder dialog is available here; type the folder path instead");
		const start = (await body(req)).start;
		return { path: await picker(typeof start === "string" && existsSync(start) ? start : undefined) };
	}
	if (m === "POST" && route === "reveal") {
		const what = (await body(req)).what;
		const v = filesSettingsView(db);
		const path =
			what === "library"
				? v.library.dbPath
				: what === "zotero"
					? v.zotero.dataDir
					: what === "baseDir"
						? v.baseDir.effective
						: what === "storage"
							? (v.storage.dir ?? v.storage.ownDir)
							: undefined;
		if (path === undefined) throw new HttpError(400, "what must be library, zotero, baseDir or storage");
		if (!path || !existsSync(path)) throw new HttpError(404, "that location does not exist yet");
		revealer(path);
		return { ok: true };
	}
	throw new HttpError(404, "not found");
}
