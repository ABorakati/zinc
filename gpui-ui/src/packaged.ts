// Defaults for the packaged app (out/package, built by scripts/package.ts): when running as the compiled zotero-next-gpui.exe,
// look for the runtime files next to the exe, and find a library:
//   - zotero-next running (its core answers on 127.0.0.1:23120): use it;
//   - otherwise run the core inside this process on the library database zotero-next uses (ZN_LIBRARY, default
//     C:\Users\abora\zotero-next\data\library.sqlite), after making ONE backup copy of it the first time (VACUUM INTO, next to the
//     database: library.backup-gpui-<date>.sqlite). The in-process core serves on its own port (ZN_PORT, default 23161) and
//     runs no Zotero sync or connector port; zotero-next started later keeps doing those.
// Imported first by main.tsx (top-level await), before any module reads these variables. Explicit environment variables win.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const exe = process.execPath;
export const packaged = /^zotero-next-gpui.*\.exe$/i.test(basename(exe));

/** What packaged start-up decided, for the UI (e.g. the "no library" message). */
export const startup: { library: "external" | "in-process" | "none"; url?: string; db?: string; backup?: string; error?: string } = { library: "none" };

const ZN_CORE_URL = "http://127.0.0.1:23120";
const DEFAULT_LIBRARY = "C:\\Users\\abora\\zotero-next\\data\\library.sqlite";

async function answers(url: string): Promise<boolean> {
	try {
		const r = await fetch(url + "/api/collections", { signal: AbortSignal.timeout(700) });
		return r.ok;
	} catch {
		return false;
	}
}

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
	if (existsSync(join(dir, "zn_pdf.dll"))) set("ZN_PDF_DLL", join(dir, "zn_pdf.dll"));

	if (process.env.ZN_DB) startup.library = "in-process";
	else if (process.env.ZN_URL) startup.library = "external";
	else {
		const url = ZN_CORE_URL;
		if (await answers(url)) {
			process.env.ZN_URL = url;
			Object.assign(startup, { library: "external", url });
		} else {
			const db = process.env.ZN_LIBRARY || DEFAULT_LIBRARY;
			if (!existsSync(db)) {
				Object.assign(startup, { library: "none", error: `zotero-next is not running and no library was found at ${db}` });
				process.env.ZN_URL = url;
			} else {
				try {
					const backup = backupOnce(db);
					process.env.ZN_DB = db;
					process.env.ZN_ALLOW_REAL_DB = "1"; // the user agreed (2026-11-03): the packaged app may open the real library, after a backup
					set("ZN_PORT", "23161");
					Object.assign(startup, { library: "in-process", db, backup });
					try {
						const logDir = join(process.env.APPDATA ?? dir, "zotero-next-gpui");
						mkdirSync(logDir, { recursive: true });
						writeFileSync(join(logDir, "startup.json"), JSON.stringify({ at: new Date().toISOString(), ...startup }, null, 1));
					} catch { /* best effort */ }
				} catch (e) {
					// no backup, no write access: never open the library without the backup
					Object.assign(startup, { library: "none", error: `could not back up the library before opening it: ${(e as Error).message}` });
					process.env.ZN_URL = url;
				}
			}
		}
	}
}
