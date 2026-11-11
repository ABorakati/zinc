// Fetch the pinned PDFium build for this OS and CPU into native/pdf/vendor/pdfium (the library is gitignored; LICENSE, licenses/,
// VERSION, args.gn are kept).
//   bun native/pdf/vendor/fetch-pdfium.ts           # no-op when the library is already there
//   bun native/pdf/vendor/fetch-pdfium.ts --force
// Source: github.com/bblanchon/pdfium-binaries, release chromium/8125 (PDFium 158.0.8125.0), asset pdfium-<os>-<cpu>.tgz (no V8, no XFA):
//   Windows x64   bin/pdfium.dll        Linux x64 / arm64   lib/libpdfium.so        macOS arm64 / x64   lib/libpdfium.dylib
// The archive is checked against the sha256 GitHub publishes for the release asset before anything is extracted.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TAG = "chromium/8125";
/** asset -> sha256, from the release's asset digests */
const ASSETS: Record<string, string> = {
	"pdfium-win-x64.tgz": "9a964261760cff52570aabf038ab346d3a5034dd8b30d0d5fe8861235d356b8b",
	"pdfium-linux-x64.tgz": "e1c3ce6e270cb5e0c20816b379ad9f2c1309972697c505f508de92bf5e7d6659",
	"pdfium-linux-arm64.tgz": "8b8818f2ec57d1b213d952ca6d7f0ffeca9d0110487d0e20ad83ba918bc92efa",
	"pdfium-mac-arm64.tgz": "4939bd935ac83ddc09a3a4f038bc43a19cea1660316a3667f26cb07a070e139d",
	"pdfium-mac-x64.tgz": "8a5193535b80c7215d8932f6647ae5097465b6dba2811602c21e120c2af112b0",
};

const os = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
const ASSET = `pdfium-${os}-${process.arch}.tgz`;
const SHA256 = ASSETS[ASSET];
if (!SHA256) throw new Error(`no pinned PDFium build for ${process.platform} ${process.arch} (have: ${Object.keys(ASSETS).join(", ")})`);
/** where the library sits in the archive (and in vendor/pdfium); native/pdf/src/pdfium.rs looks in the same place */
const LIB = os === "win" ? join("bin", "pdfium.dll") : join("lib", os === "mac" ? "libpdfium.dylib" : "libpdfium.so");
const dest = join(import.meta.dir, "pdfium");

if (existsSync(join(dest, LIB)) && !process.argv.includes("--force")) {
	console.log("PDFium present:", join(dest, LIB));
	process.exit(0);
}
const url = `https://github.com/bblanchon/pdfium-binaries/releases/download/${TAG}/${ASSET}`;
console.log("downloading", url);
const res = await fetch(url, { redirect: "follow" });
if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
const bytes = new Uint8Array(await res.arrayBuffer());
const sum = createHash("sha256").update(bytes).digest("hex");
if (sum !== SHA256) throw new Error(`sha256 mismatch for ${ASSET}: got ${sum}, expected ${SHA256}`);
const tmp = mkdtempSync(join(tmpdir(), "pdfium-"));
try {
	await Bun.write(join(tmp, ASSET), bytes);
	const r = Bun.spawnSync(["tar", "xzf", ASSET], { cwd: tmp, stdout: "inherit", stderr: "inherit" });
	if (r.exitCode !== 0) throw new Error("tar failed");
	mkdirSync(join(dest, LIB, ".."), { recursive: true });
	cpSync(join(tmp, LIB), join(dest, LIB));
	for (const f of ["licenses", "LICENSE", "VERSION", "args.gn"]) cpSync(join(tmp, f), join(dest, f), { recursive: true });
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log("PDFium installed:", join(dest, LIB));
