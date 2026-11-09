// Package the GPUI app: `bun scripts/package.ts [--zip] [--aot]`
//
// --aot assembles the ahead-of-time compiled exe (Bun canary, compile.aot; see build.ts) into out/package-aot/zotero-next-gpui/ instead.
// Everything that is code is inside that exe (PDF extraction, document-structure and translation workers, the Zotero translate framework,
// jsdom, Zotero's document worker, the structured-document-text reader), so the folder has no docworker-entry.ts / pdf-worker.ts /
// translate-worker.js, no vendor/zotero/{translate,utilities}, no vendor/reader and no document-worker/build/worker.js: only data
// (cmaps, fonts, wasm, models, translators, schema), the two native DLLs and the web reader / note editor pages. It is never installed
// anywhere by this script.
//
// Builds the compiled exe (bytecode, console hidden, app icon) and assembles a self-contained folder:
//   out/package/zotero-next-gpui/
//     zotero-next-gpui.exe          the app (UI, fonts, icons, Solid runtime and the GPUI addon embedded)
//     zn_pdf.dll                    the native PDF renderer (native/pdf: PDFium rasteriser, hayro text layer / fallback)
//     pdfium.dll                    PDFium (bblanchon/pdfium-binaries, pinned in native/pdf/vendor/fetch-pdfium.ts); zn_pdf.dll looks for it next to itself
//     pdfium-licenses/              PDFium's LICENSE + the licences of what it bundles
//     docworker-entry.ts            entry of the document-structure worker (citations, figures, reading view)
//     pdf-worker.ts                 entry of the PDF full-text extraction worker (core/src/extract/pdf-worker.ts, a copy)
//     translate-worker.js           the Zotero translation worker, pre-bundled with jsdom (scripts/translate-worker.ts)
//     vendor/zotero                 translate framework, utilities, zotero-schema and the translators (+ COPYING/README)
//     vendor/document-worker/build  Zotero's document worker (pdf.js + models)
//     vendor/reader/structured-document-text/src
//     reader-host/dist              Zotero's web reader page (snapshot / EPUB tabs), served by the in-process core at /reader-host/
//     note-host/dist                the note editor page (/note-host/)
//     README.txt
// The exe finds these next to itself (src/packaged.ts). It is standalone: it runs the core in its own process on the library
// (after a one-time backup) and the same services as zotero-next (API on 23120, Zotero port 23119, Zotero sync, PDF extraction;
// src/services.ts). --zip also writes out/package/zotero-next-gpui-<date>.zip.
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { BUILD_VERSION } from "./_version";
import { signFiles } from "./sign";

const root = resolve(import.meta.dir, "..");
const repo = resolve(root, "..");
const aot = process.argv.includes("--aot");
const pkgDir = join(root, "out", aot ? "package-aot" : "package");
const app = join(pkgDir, "zotero-next-gpui");

const run = (cmd: string[], cwd = root) => {
	const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
	if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${r.exitCode})`);
};

// 1. native PDF renderer (uses the user's normal cargo setup: shared target dir + kache)
run(["cargo", "build", "--release"], join(root, "native", "pdf"));
const dllCands = [
	process.env.CARGO_TARGET_DIR && join(process.env.CARGO_TARGET_DIR, "release", "zn_pdf.dll"),
	join(root, "native", "pdf", "target", "release", "zn_pdf.dll"),
].filter(Boolean) as string[];
const dll = dllCands.find((p) => existsSync(p));
if (!dll) throw new Error("zn_pdf.dll not found after cargo build (tried " + dllCands.join(", ") + ")");

// 1b. PDFium (the rasteriser zn_pdf.dll loads at run time; hayro renders instead when it is missing). Fetched once, sha256-checked.
const pdfiumDir = join(root, "native", "pdf", "vendor", "pdfium");
if (!existsSync(join(pdfiumDir, "bin", "pdfium.dll"))) run(["bun", join(root, "native", "pdf", "vendor", "fetch-pdfium.ts")]);
if (!existsSync(join(pdfiumDir, "bin", "pdfium.dll"))) throw new Error("pdfium.dll missing in " + pdfiumDir);

// 2. the exe
run(aot ? ["bun", "scripts/build.ts", "--aot", "--variant", "aot", "--hide-console"] : ["bun", "scripts/build.ts", "--variant", "bytecode", "--hide-console"]);
const exe = join(root, "out", aot ? "zotero-next-gpui-aot.exe" : "zotero-next-gpui-bytecode.exe");

// 2b. the Zotero translation worker, pre-bundled (jsdom and friends inside; see scripts/translate-worker.ts)
const translateWorker = join(root, "out", "translate-worker.js");
if (!aot) run(["bun", "scripts/translate-worker.ts", translateWorker]);

// 3. assemble
rmSync(app, { recursive: true, force: true });
mkdirSync(app, { recursive: true });
cpSync(exe, join(app, "zotero-next-gpui.exe"));
cpSync(dll, join(app, "zn_pdf.dll"));
cpSync(join(root, "assets", "icon.ico"), join(app, "icon.ico")); // the window's title-bar/taskbar icon (src/shell/windowIcon.ts)
cpSync(join(pdfiumDir, "bin", "pdfium.dll"), join(app, "pdfium.dll"));
cpSync(join(pdfiumDir, "licenses"), join(app, "pdfium-licenses"), { recursive: true });
cpSync(join(pdfiumDir, "LICENSE"), join(app, "pdfium-licenses", "PDFIUM-LICENSE.txt"));
if (!aot) {
	cpSync(join(root, "src", "reader", "structure", "docworker-entry.ts"), join(app, "docworker-entry.ts"));
	cpSync(join(repo, "core", "src", "extract", "pdf-worker.ts"), join(app, "pdf-worker.ts")); // PDF full-text extraction (the pool's Worker entry)
	cpSync(translateWorker, join(app, "translate-worker.js"));
}
// Zotero translate framework + utilities + schema + translators (core/vendor/zotero; the worker reads them from disk), with their licences
for (const part of aot ? ["zotero-schema", "translators"] : ["translate", "utilities", "zotero-schema", "translators"]) cpSync(join(repo, "core", "vendor", "zotero", part), join(app, "vendor", "zotero", part), { recursive: true });
cpSync(join(repo, "core", "vendor", "zotero", "README.md"), join(app, "vendor", "zotero", "README.md"));
cpSync(join(repo, "core", "vendor", "zotero", "translation-server", "COPYING"), join(app, "vendor", "zotero", "translation-server", "COPYING"));
// aot: worker.js (the engine) and the structured-document-text reader are compiled into the exe; the build folder keeps the data the engine fetches
cpSync(join(repo, "vendor", "document-worker", "build"), join(app, "vendor", "document-worker", "build"), { recursive: true, filter: (src) => !(aot && basename(src) === "worker.js") });
if (!aot) cpSync(join(repo, "vendor", "reader", "structured-document-text", "src"), join(app, "vendor", "reader", "structured-document-text", "src"), { recursive: true });
// the web reader and note editor builds (reader-host/build.sh, note-host/build.sh); without them snapshots/EPUBs open in their default app
for (const [name, index] of [["reader-host", "index.html"], ["note-host", "editor.html"]] as const) {
	const dist = join(repo, name, "dist");
	if (existsSync(join(dist, index))) cpSync(dist, join(app, name, "dist"), { recursive: true });
	else console.warn(`package: ${name}/dist not built (bash ${name}/build.sh); web tabs will be off`);
}
writeFileSync(join(app, "README.txt"), [
	"Zinc (GPUI)",
	"",
	"Start zotero-next-gpui.exe. It does not need another Zinc: it opens the library itself (ZN_LIBRARY, default",
	"C:/Users/abora/zotero-next/data/library.sqlite), after making one backup copy (library.backup-gpui-*.sqlite next to it), and runs",
	"the same services: HTTP API on 127.0.0.1:23120 (Word add-in, MCP), Zotero Connector port 23119, two-way sync with",
	"Zotero (reading always, writing opt-in) and PDF full-text extraction.",
	"",
	"Do not run it together with another Zinc on the same library for sync: if port 23120 is taken, this app still opens the",
	"library but leaves Zotero sync and port 23119 to the other app (the sync indicator says so). Institution sign-in for",
	"Find Full Text opens a sign-in window of its own (a helper process started from a link to this exe, zotero-next-signin.exe in",
		"%LOCALAPPDATA%\\zotero-next-gpui\\signin; its WebView2 profile is %APPDATA%\\zotero-next-signin.exe\\EBWebView). ZN_SIGNIN=0 turns it off.",
	"",
	"Environment overrides: ZN_LIBRARY, ZN_DB (another database), ZN_URL (use an external core, run nothing here), ZN_PORT,",
	"ZN_SYNC=0, ZN_ZPORT=0|<port>, ZN_ZOTERO_DIR, ZN_PDF_DLL, ZN_PDFIUM_DLL, ZN_PDF_BACKEND=hayro (render with hayro instead of PDFium), ZN_ROOT, ZN_DOCWORKER_ENTRY, ZN_TRACE=1 (start-up timings).",
	"ZN_TRANSLATE_WORKER / ZN_ZOTERO_VENDOR / ZN_TRANSLATORS_DIR point the Zotero translators (import, export, web capture) at other copies.",
	"ZN_READER_HOST / ZN_NOTE_HOST point the core at other reader-host / note-host builds.",
	"HTML snapshots and EPUBs open in a web tab (Zotero's reader in a WebView2 window over the tab; needs the Microsoft Edge WebView2 runtime,",
	"preinstalled on Windows 11; its profile is %APPDATA%\zotero-next-gpui.exe\EBWebView).",
	"Settings and window state: %APPDATA%\\zotero-next-gpui\\",
	"",
].join("\r\n"));

writeFileSync(join(app, "version.txt"), BUILD_VERSION + "\n"); // the stamp scripts/installer.ts and the updater read
// Authenticode (scripts/sign.ts): signs the exe and our native DLL when a certificate is configured, else prints "unsigned: ..." and moves on
signFiles([join(app, "zotero-next-gpui.exe"), join(app, "zn_pdf.dll")]);

const size = (p: string): number => {
	const s = statSync(p);
	if (!s.isDirectory()) return s.size;
	let n = 0;
	for (const e of new Bun.Glob("**/*").scanSync({ cwd: p, onlyFiles: true })) n += statSync(join(p, e)).size;
	return n;
};
console.log(`package: ${app}  (${(size(app) / 1048576).toFixed(0)} MB)`);

if (process.argv.includes("--zip")) {
	const zip = join(pkgDir, `zotero-next-gpui-${new Date().toISOString().slice(0, 10)}.zip`);
	rmSync(zip, { force: true });
	run(["pwsh", "-NoProfile", "-Command", `Compress-Archive -Path '${app}' -DestinationPath '${zip}' -CompressionLevel Optimal`]);
	console.log(`zip: ${zip}  (${(statSync(zip).size / 1048576).toFixed(0)} MB)`);
}
