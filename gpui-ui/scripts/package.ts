// Package the GPUI app: `bun scripts/package.ts [--zip]`
//
// Builds the compiled exe (bytecode, console hidden, app icon) and assembles a self-contained folder:
//   out/package/zotero-next-gpui/
//     zotero-next-gpui.exe          the app (UI, fonts, icons, Solid runtime and the GPUI addon embedded)
//     zn_pdf.dll                    the native PDF renderer (native/pdf, hayro)
//     docworker-entry.ts            entry of the document-structure worker (citations, figures, reading view)
//     vendor/document-worker/build  Zotero's document worker (pdf.js + models)
//     vendor/reader/structured-document-text/src
//     README.txt
// The exe finds these next to itself (src/packaged.ts) and uses the running zotero-next's core on 127.0.0.1:23120; it never
// opens a library database itself. --zip also writes out/package/zotero-next-gpui-<date>.zip.
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

// 2. the exe
run(["bun", "scripts/build.ts", "--variant", "bytecode", "--hide-console"]);
const exe = join(root, "out", "zotero-next-gpui-bytecode.exe");

// 3. assemble
rmSync(app, { recursive: true, force: true });
mkdirSync(app, { recursive: true });
cpSync(exe, join(app, "zotero-next-gpui.exe"));
cpSync(dll, join(app, "zn_pdf.dll"));
cpSync(join(root, "src", "reader", "structure", "docworker-entry.ts"), join(app, "docworker-entry.ts"));
cpSync(join(repo, "vendor", "document-worker", "build"), join(app, "vendor", "document-worker", "build"), { recursive: true });
cpSync(join(repo, "vendor", "reader", "structured-document-text", "src"), join(app, "vendor", "reader", "structured-document-text", "src"), { recursive: true });
writeFileSync(join(app, "README.txt"), [
	"zotero-next (GPUI)",
	"",
	"Start zotero-next-gpui.exe. It shows the library of the zotero-next that is running on this computer (its core on",
	"127.0.0.1:23120), so start zotero-next first. It never opens a library database itself.",
	"",
	"Environment overrides: ZN_URL (another core), ZN_PDF_DLL, ZN_ROOT, ZN_DOCWORKER_ENTRY, ZN_TRACE=1 (start-up timings).",
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
