// Defaults for the packaged app (out/package, built by scripts/package.ts): when running as the compiled zotero-next-gpui.exe,
// look for the runtime files next to the exe and talk to the installed zotero-next's core. Imported first by main.tsx, before
// any module reads these variables. Every default yields to an explicit environment variable.
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const exe = process.execPath;
export const packaged = /^zotero-next-gpui.*\.exe$/i.test(basename(exe));

if (packaged) {
	const dir = dirname(exe);
	const set = (k: string, v: string) => { if (!process.env[k]) process.env[k] = v; };
	// vendor/document-worker and vendor/reader/structured-document-text are copied under the package folder
	if (existsSync(join(dir, "vendor"))) set("ZN_ROOT", dir);
	if (existsSync(join(dir, "docworker-entry.ts"))) set("ZN_DOCWORKER_ENTRY", join(dir, "docworker-entry.ts"));
	if (existsSync(join(dir, "zn_pdf.dll"))) set("ZN_PDF_DLL", join(dir, "zn_pdf.dll"));
	// no ZN_DB: the packaged app never opens a library database itself; it uses the running zotero-next on its usual port
	if (!process.env.ZN_DB) set("ZN_URL", "http://127.0.0.1:23120");
}
