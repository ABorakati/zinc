// Defaults for the packaged app (out/package, built by scripts/package.ts): when running as the compiled zotero-next-gpui.exe,
// look for the runtime files next to the exe, and open the library. The packaged app is standalone, it does not need the Electrobun
// zotero-next: it ALWAYS runs the core inside this process on the library database chosen by core/src/library-location.ts
// (ZN_DB / ZN_LIBRARY, else the library path saved in %APPDATA%\zotero-next-gpui\library.json, else the legacy
// <home>\zotero-next\data\library.sqlite, which is then adopted into that setting, else %APPDATA%\zotero-next\library.sqlite),
// after making ONE backup copy of it the first time (VACUUM INTO, next to the database: library.backup-gpui-<date>.sqlite), and runs the same services as zotero-next's main process (src/services.ts: HTTP API
// on 23120, Zotero port 23119, Zotero sync, PDF extraction). If 23120 is already taken (zotero-next is running) the core takes another
// port and leaves sync and the Zotero port to the app that has them.
// Imported first by main.tsx (top-level await), before any module reads these variables. Explicit environment variables win:
// ZN_DB (another database, in-process), ZN_URL (an external core, nothing in-process).
// When no library is configured or found, startup.firstRun is set instead and main.tsx shows the first-run screen (src/firstrun/),
// which saves the choice and continues the start-up. ZN_RESOLVE_LIBRARY=1 does the library part for an unpackaged run too (tests with
// a temporary APPDATA).
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveLibrary } from "../../core/src/library-location";
import { configDir } from "../../core/src/platform-dirs";
import { leftByOtherPackage } from "./packagedEnv";
import { mark } from "./trace";

mark("boot");

const exe = process.execPath;
// zotero-next-gpui(-<variant>).exe on Windows; zotero-next-gpui with no extension on Linux and macOS (AppImage, .app bundle)
export const packaged = /^zotero-next-gpui(-[\w-]+)?(\.exe)?$/i.test(basename(exe));

/** What packaged start-up decided, for the UI (e.g. the "no library" message). */
export const startup: {
	library: "external" | "in-process" | "none";
	url?: string;
	db?: string;
	backup?: string;
	error?: string;
	/** No usable library: the first-run screen must run before anything opens a database. */
	firstRun?: boolean;
	/** Where a new library goes by default (set with firstRun). */
	defaultPath?: string;
	/** How the library was chosen (env / setting / legacy / default / none). */
	source?: string;
	/** The legacy library was adopted into the saved setting by this start. */
	adopted?: boolean;
} = { library: "none" };

/** One backup before this app first writes to the library: skipped when a library.backup-gpui-* file already exists. */
export function backupOnce(db: string): string | undefined {
	const dir = dirname(db);
	const existing = readdirSync(dir).find((f) => /^library\.backup-gpui-.*\.sqlite$/i.test(f));
	if (existing) return join(dir, existing);
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
	const out = join(dir, `library.backup-gpui-${stamp}.sqlite`);
	const src = new Database(db, { readonly: true });
	try {
		src.run("VACUUM INTO ?", [out]);
	} finally {
		src.close();
	}
	return out;
}

/** The packaged app, or an unpackaged run asked to choose its library like one (ZN_RESOLVE_LIBRARY=1). */
const chooseLibrary = packaged || process.env.ZN_RESOLVE_LIBRARY === "1";

/** Where the packaged app's data files are: next to the exe, or Zinc.app/Contents/Resources in the macOS app bundle (scripts/dmg.ts),
 *  which keeps only code (the exe and the two dylibs) in Contents/MacOS. */
export const packageDataDir = (): string => {
	const res = join(dirname(exe), "..", "Resources");
	return process.platform === "darwin" && existsSync(join(res, "vendor")) ? res : dirname(exe);
};

if (packaged) {
	const exeDir = dirname(exe);
	const dir = packageDataDir();
	// an explicit value wins, unless it points into ANOTHER Zinc package (the previous version left it when it relaunched us after a
	// self-update, packagedEnv.ts) or at nothing (that install was removed since)
	const set = (k: string, v: string) => {
		const cur = process.env[k];
		if (!cur || (cur !== v && (!existsSync(cur) || leftByOtherPackage(cur, exeDir)))) process.env[k] = v;
	};
	// vendor/document-worker and vendor/reader/structured-document-text are copied under the package folder
	if (existsSync(join(dir, "vendor"))) set("ZN_ROOT", dir);
	if (existsSync(join(dir, "docworker-entry.ts"))) set("ZN_DOCWORKER_ENTRY", join(dir, "docworker-entry.ts"));
	if (existsSync(join(dir, "pdf-worker.ts"))) set("ZN_PDF_WORKER_ENTRY", join(dir, "pdf-worker.ts")); // PDF full-text extraction worker
	const pdfLib = process.platform === "win32" ? "zn_pdf.dll" : process.platform === "darwin" ? "libzn_pdf.dylib" : "libzn_pdf.so";
	if (existsSync(join(exeDir, pdfLib))) set("ZN_PDF_DLL", join(exeDir, pdfLib));
	// Zotero translators: the pre-bundled worker (jsdom inside) and the framework + translators + schema it reads from disk
	if (existsSync(join(dir, "translate-worker.js"))) set("ZN_TRANSLATE_WORKER", join(dir, "translate-worker.js"));
	if (existsSync(join(dir, "vendor", "zotero", "translators"))) set("ZN_ZOTERO_VENDOR", join(dir, "vendor", "zotero"));
	// the web reader (snapshots, EPUBs) and note editor pages the in-process core serves at /reader-host/ and /note-host/ (src/webview/mounts.ts)
	if (existsSync(join(dir, "reader-host", "dist", "index.html"))) set("ZN_READER_HOST", join(dir, "reader-host", "dist"));
	if (existsSync(join(dir, "note-host", "dist", "editor.html"))) set("ZN_NOTE_HOST", join(dir, "note-host", "dist"));
}

if (chooseLibrary) {
	const dir = dirname(exe);
	if (process.env.ZN_DB) startup.library = "in-process";
	else if (process.env.ZN_URL) Object.assign(startup, { library: "external", url: process.env.ZN_URL });
	else {
		const loc = resolveLibrary(); // ZN_LIBRARY, the saved path, the legacy library (adopted here, once), the default location
		Object.assign(startup, { source: loc.source, adopted: loc.adopted });
		if (!loc.path || !loc.exists) {
			// nothing configured, or the configured file is gone (moved drive, deleted): ask the user, never create over a path they chose
			Object.assign(startup, {
				library: "none",
				firstRun: true,
				defaultPath: loc.defaultPath,
				error: loc.path ? `no library was found at ${loc.path}` : undefined,
			});
		} else {
			const db = loc.path;
			try {
				const backup = backupOnce(db);
				process.env.ZN_DB = db;
				process.env.ZN_ALLOW_REAL_DB = "1"; // the user agreed (2026-11-03): the packaged app may open the real library, after a backup
				Object.assign(startup, { library: "in-process", db, backup });
				try {
					const logDir = join(configDir(), "zotero-next-gpui");
					mkdirSync(logDir, { recursive: true });
					writeFileSync(join(logDir, "startup.json"), JSON.stringify({ at: new Date().toISOString(), ...startup }, null, 1));
				} catch {
					/* best effort */
				}
			} catch (e) {
				// no backup, no write access: never open the library without the backup
				Object.assign(startup, {
					library: "none",
					error: `could not back up the library before opening it: ${(e as Error).message}`,
				});
				process.env.ZN_URL = "http://127.0.0.1:23120";
			}
		}
	}
}
mark("packaged-done");
