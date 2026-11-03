// Package the GPUI app: `bun scripts/package.ts [--zip]`
//
// Builds the compiled exe (bytecode, console hidden, app icon) and assembles a self-contained folder:
//   out/package/zotero-next-gpui/
//     zotero-next-gpui.exe          the app (UI, fonts, icons, Solid runtime and the GPUI addon embedded)
//     zn_pdf.dll                    the native PDF renderer (native/pdf: PDFium rasteriser, hayro text layer / fallback)
//     pdfium.dll                    PDFium (bblanchon/pdfium-binaries, pinned in native/pdf/vendor/fetch-pdfium.ts); zn_pdf.dll looks for it next to itself
//     pdfium-licenses/              PDFium's LICENSE + the licences of what it bundles
//     docworker-entry.ts            entry of the document-structure worker (citations, figures, reading view)
//     pdf-worker.ts                 entry of the PDF full-text extraction worker (core/src/extract/pdf-worker.ts, a copy)
//     vendor/document-worker/build  Zotero's document worker (pdf.js + models)
//     vendor/reader/structured-document-text/src
//     reader-host/dist              Zotero's web reader page (snapshot / EPUB tabs), served by the in-process core at /reader-host/
//     note-host/dist                the note editor page (/note-host/)
//     README.txt
// The exe finds these next to itself (src/packaged.ts). It is standalone: it runs the core in its own process on the library
// (after a one-time backup) and the same services as zotero-next (API on 23120, Zotero port 23119, Zotero sync, PDF extraction;
// src/services.ts). --zip also writes out/package/zotero-next-gpui-<date>.zip.
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const repo = resolve(root, "..");
const pkgDir = join(root, "out", "package");
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
run(["bun", "scripts/build.ts", "--variant", "bytecode", "--hide-console"]);
const exe = join(root, "out", "zotero-next-gpui-bytecode.exe");

// 3. assemble
rmSync(app, { recursive: true, force: true });
mkdirSync(app, { recursive: true });
cpSync(exe, join(app, "zotero-next-gpui.exe"));
cpSync(dll, join(app, "zn_pdf.dll"));
cpSync(join(pdfiumDir, "bin", "pdfium.dll"), join(app, "pdfium.dll"));
cpSync(join(pdfiumDir, "licenses"), join(app, "pdfium-licenses"), { recursive: true });
cpSync(join(pdfiumDir, "LICENSE"), join(app, "pdfium-licenses", "PDFIUM-LICENSE.txt"));
cpSync(join(root, "src", "reader", "structure", "docworker-entry.ts"), join(app, "docworker-entry.ts"));
cpSync(join(repo, "core", "src", "extract", "pdf-worker.ts"), join(app, "pdf-worker.ts")); // PDF full-text extraction (the pool's Worker entry)
cpSync(join(repo, "vendor", "document-worker", "build"), join(app, "vendor", "document-worker", "build"), { recursive: true });
cpSync(join(repo, "vendor", "reader", "structured-document-text", "src"), join(app, "vendor", "reader", "structured-document-text", "src"), { recursive: true });
// the web reader and note editor builds (reader-host/build.sh, note-host/build.sh); without them snapshots/EPUBs open in their default app
for (const [name, index] of [["reader-host", "index.html"], ["note-host", "editor.html"]] as const) {
	const dist = join(repo, name, "dist");
	if (existsSync(join(dist, index))) cpSync(dist, join(app, name, "dist"), { recursive: true });
	else console.warn(`package: ${name}/dist not built (bash ${name}/build.sh); web tabs will be off`);
}
writeFileSync(join(app, "README.txt"), [
	"zotero-next (GPUI)",
	"",
	"Start zotero-next-gpui.exe. It does not need zotero-next: it opens the library itself (ZN_LIBRARY, default",
	"C:/Users/abora/zotero-next/data/library.sqlite), after making one backup copy (library.backup-gpui-*.sqlite next to it), and runs",
	"the same services: HTTP API on 127.0.0.1:23120 (Word add-in, MCP), Zotero Connector port 23119, two-way sync with",
	"Zotero (reading always, writing opt-in) and PDF full-text extraction.",
	"",
	"Do not run it together with zotero-next on the same library for sync: if port 23120 is taken, this app still opens the",
	"library but leaves Zotero sync and port 23119 to the other app (the sync indicator says so). Institution sign-in for",
	"Find Full Text needs zotero-next.",
	"",
	"Environment overrides: ZN_LIBRARY, ZN_DB (another database), ZN_URL (use an external core, run nothing here), ZN_PORT,",
	"ZN_SYNC=0, ZN_ZPORT=0|<port>, ZN_ZOTERO_DIR, ZN_PDF_DLL, ZN_PDFIUM_DLL, ZN_PDF_BACKEND=hayro (render with hayro instead of PDFium), ZN_ROOT, ZN_DOCWORKER_ENTRY, ZN_TRACE=1 (start-up timings).",
	"ZN_READER_HOST / ZN_NOTE_HOST point the core at other reader-host / note-host builds.",
	"HTML snapshots and EPUBs open in a web tab (Zotero's reader in a WebView2 window over the tab; needs the Microsoft Edge WebView2 runtime,",
	"preinstalled on Windows 11; its profile is %APPDATA%\zotero-next-gpui.exe\EBWebView).",
	"Settings and window state: %APPDATA%\\zotero-next-gpui\\",
	"",
].join("\r\n"));

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
