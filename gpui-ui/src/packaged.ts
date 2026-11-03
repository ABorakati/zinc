// Defaults for the packaged app (out/package, built by scripts/package.ts): when running as the compiled zotero-next-gpui.exe,
// look for the runtime files next to the exe, and open the library. The packaged app is standalone, it does not need the Electrobun
// zotero-next: it ALWAYS runs the core inside this process on the library database zotero-next uses (ZN_LIBRARY, default
// C:/Users/abora/zotero-next/data/library.sqlite), after making ONE backup copy of it the first time (VACUUM INTO, next to the
// database: library.backup-gpui-<date>.sqlite), and runs the same services as zotero-next's main process (src/services.ts: HTTP API
// on 23120, Zotero port 23119, Zotero sync, PDF extraction). If 23120 is already taken (zotero-next is running) the core takes another
// port and leaves sync and the Zotero port to the app that has them.
// Imported first by main.tsx (top-level await), before any module reads these variables. Explicit environment variables win:
// ZN_DB (another database, in-process), ZN_URL (an external core, nothing in-process).
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const exe = process.execPath;
export const packaged = /^zotero-next-gpui.*\.exe$/i.test(basename(exe));

/** What packaged start-up decided, for the UI (e.g. the "no library" message). */
export const startup: { library: "external" | "in-process" | "none"; url?: string; db?: string; backup?: string; error?: string } = { library: "none" };

const DEFAULT_LIBRARY = "C:\\Users\\abora\\zotero-next\\data\\library.sqlite";

/** One backup before this app first writes to the library: skipped when a library.backup-gpui-* file already exists. */
function backupOnce(db: string): string | undefined {
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

if (packaged) {
	const dir = dirname(exe);
	const set = (k: string, v: string) => { if (!process.env[k]) process.env[k] = v; };
	// vendor/document-worker and vendor/reader/structured-document-text are copied under the package folder
	if (existsSync(join(dir, "vendor"))) set("ZN_ROOT", dir);
	if (existsSync(join(dir, "docworker-entry.ts"))) set("ZN_DOCWORKER_ENTRY", join(dir, "docworker-entry.ts"));
	if (existsSync(join(dir, "pdf-worker.ts"))) set("ZN_PDF_WORKER_ENTRY", join(dir, "pdf-worker.ts")); // PDF full-text extraction worker
	if (existsSync(join(dir, "zn_pdf.dll"))) set("ZN_PDF_DLL", join(dir, "zn_pdf.dll"));
	// the web reader (snapshots, EPUBs) and note editor pages the in-process core serves at /reader-host/ and /note-host/ (src/webview/mounts.ts)
	if (existsSync(join(dir, "reader-host", "dist", "index.html"))) set("ZN_READER_HOST", join(dir, "reader-host", "dist"));
	if (existsSync(join(dir, "note-host", "dist", "editor.html"))) set("ZN_NOTE_HOST", join(dir, "note-host", "dist"));

	if (process.env.ZN_DB) startup.library = "in-process";
	else if (process.env.ZN_URL) Object.assign(startup, { library: "external", url: process.env.ZN_URL });
	else {
		const db = process.env.ZN_LIBRARY || DEFAULT_LIBRARY;
		if (!existsSync(db)) {
			Object.assign(startup, { library: "none", error: `no library was found at ${db}` });
			process.env.ZN_URL = "http://127.0.0.1:23120";
		} else {
			try {
				const backup = backupOnce(db);
				process.env.ZN_DB = db;
				process.env.ZN_ALLOW_REAL_DB = "1"; // the user agreed (2026-11-03): the packaged app may open the real library, after a backup
				Object.assign(startup, { library: "in-process", db, backup });
				try {
					const logDir = join(process.env.APPDATA ?? dir, "zotero-next-gpui");
					mkdirSync(logDir, { recursive: true });
					writeFileSync(join(logDir, "startup.json"), JSON.stringify({ at: new Date().toISOString(), ...startup }, null, 1));
				} catch { /* best effort */ }
			} catch (e) {
				// no backup, no write access: never open the library without the backup
				Object.assign(startup, { library: "none", error: `could not back up the library before opening it: ${(e as Error).message}` });
				process.env.ZN_URL = "http://127.0.0.1:23120";
			}
		}
	}
}
