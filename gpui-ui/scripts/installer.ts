// Build the Windows installer: `bun gpui-ui/scripts/installer.ts` -> gpui-ui/out/installer/ZoteroNext-Setup-<version>.exe
//
// Inno Setup 7 (installer/zotero-next.iss) over the packaged AOT folder (bun gpui-ui/scripts/package.ts --aot). Per user, no admin.
// See installer/README.md for what the installer does, the silent commands and the signing setup.
//
//   --package <dir>    the app folder to install (default out/package-aot/zotero-next-gpui)
//   --version <stamp>  the build stamp (default: <package>/version.txt, else scripts/_version.ts)
//   --out <dir>        output folder (default out/installer)
//   --no-word          leave the Word add-in out (default: build it into out/installer/word-stage with word/build.ps1 -OutDir and offer it)
//   --reuse-word       use the add-in already in out/installer/word-stage instead of rebuilding it
//   --test             a differently identified installer ("Zotero Next (installer test)", own AppId), file name ending -TEST: for sandbox runs
//
// Inno Setup is found via ZN_ISCC, then C:/Users/abora/zn-ws/_tmp/installer/inno, %LOCALAPPDATA%/Programs/Inno Setup 7, Program Files, PATH.
// Signing (scripts/sign.ts): with a certificate configured the add-in dll, the setup and the uninstaller are signed through ISCC's
// SignTool hook, and the package's exe and zn_pdf.dll are signed first if they are not yet; without one, "unsigned: ..." is printed.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUILD_VERSION, numericVersion } from "./_version";
import { signConfig, signFiles, verifySignature } from "./sign";

const root = resolve(import.meta.dir, "..");
const repo = resolve(root, "..");
const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); const v = i >= 0 ? process.argv[i + 1] : undefined; return v && !v.startsWith("--") ? v : undefined; };
const flag = (name: string) => process.argv.includes(`--${name}`);
const win = (p: string) => resolve(p).replaceAll("/", "\\");

const pkg = win(arg("package") ?? join(root, "out", "package-aot", "zotero-next-gpui"));
const outDir = win(arg("out") ?? join(root, "out", "installer"));
const test = flag("test");
const publisher = process.env.ZN_PUBLISHER ?? "Aditya Borakati";

if (!existsSync(join(pkg, "zotero-next-gpui.exe"))) throw new Error(`no packaged app in ${pkg}: run  bun gpui-ui/scripts/package.ts --aot  first`);
const stampFile = join(pkg, "version.txt");
const version = arg("version") ?? (existsSync(stampFile) ? readFileSync(stampFile, "utf8").trim() : BUILD_VERSION);
const numeric = numericVersion(version);
const outName = `ZoteroNext-Setup-${version.replace("+", "-")}${test ? "-TEST" : ""}`;

const run = (cmd: string[], cwd = root) => {
	const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
	if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${r.exitCode})`);
};

function findIscc(): string {
	const cands = [
		process.env.ZN_ISCC,
		"C:/Users/abora/zn-ws/_tmp/installer/inno/ISCC.exe",
		process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "Inno Setup 7", "ISCC.exe"),
		"C:/Program Files (x86)/Inno Setup 7/ISCC.exe",
		"C:/Program Files/Inno Setup 7/ISCC.exe",
		Bun.which("ISCC") ?? undefined,
	].filter(Boolean) as string[];
	const hit = cands.find((p) => existsSync(p));
	if (!hit) throw new Error("Inno Setup 7 (ISCC.exe) not found. Install it without admin: download innosetup-7.1.1-x64.exe from https://github.com/jrsoftware/issrc/releases and run it with /VERYSILENT /CURRENTUSER /PORTABLE=1 /NOICONS /DIR=<folder>, then set ZN_ISCC=<folder>\\ISCC.exe");
	return hit;
}

// ---- the Word add-in, built into staging (never word/dist) ------------------------------------------------------------------------
const wordStage = join(root, "out", "installer", "word-stage");
let wordDir: string | null = null;
if (!flag("no-word")) {
	if (!flag("reuse-word") || !existsSync(join(wordStage, "addin", "ZoteroNextWord.dll"))) {
		rmSync(wordStage, { recursive: true, force: true });
		run(["pwsh", "-NoProfile", "-File", join(repo, "word", "build.ps1"), "-OutDir", wordStage]);
	}
	if (!existsSync(join(wordStage, "addin", "ZoteroNextWord.dll")) || !existsSync(join(wordStage, "addin", "sidebar", "index.html"))) throw new Error(`Word add-in build incomplete in ${wordStage}`);
	wordDir = win(wordStage);
}

// ---- signing: package files (if not yet), the add-in dll; the setup and uninstaller go through ISCC's SignTool hook ----------------------
const cfg = signConfig();
if (cfg) {
	const ours = [join(pkg, "zotero-next-gpui.exe"), join(pkg, "zn_pdf.dll"), ...(wordDir ? [join(wordDir, "addin", "ZoteroNextWord.dll")] : [])];
	const todo = ours.filter((f) => { try { return !verifySignature(f).present; } catch { return true; } });
	if (todo.length) signFiles(todo);
} else console.log("unsigned: no certificate configured");

// ---- compile ------------------------------------------------------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const setup = join(outDir, `${outName}.exe`);
rmSync(setup, { force: true });
// {app}\version.txt comes from here, so it always matches this installer whatever the package folder holds
const stampDir = join(outDir, ".stamp");
mkdirSync(stampDir, { recursive: true });
writeFileSync(join(stampDir, "version.txt"), version + "\n");
const defs: Record<string, string> = {
	StampFile: win(join(stampDir, "version.txt")), AppVer: version, NumVer: numeric, Publisher: publisher, PkgDir: pkg, IconFile: win(join(repo, "app", "assets", "icon.ico")),
	OutDir: outDir, OutName: outName, WordScripts: win(join(repo, "word")),
};
if (wordDir) defs.WordDir = wordDir;
if (cfg) defs.Signed = "1";
if (test) defs.TestMode = "1";
const args = [findIscc(), "/Q", ...Object.entries(defs).map(([k, v]) => `/D${k}=${v}`)];
if (cfg) args.push(`/Sznsign=$q${win(process.execPath)}$q $q${win(join(import.meta.dir, "sign.ts"))}$q $q$f$q`);
args.push(win(join(root, "installer", "zotero-next.iss")));
const t0 = performance.now();
run(args);
if (!existsSync(setup)) throw new Error(`ISCC reported success but ${setup} is missing`);

const bytes = new Uint8Array(readFileSync(setup));
const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const info = {
	version, numericVersion: numeric, file: `${outName}.exe`, size: statSync(setup).size, sha256, signed: !!cfg, word: !!wordDir, test,
	silentInstall: `"${outName}.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART`,
};
writeFileSync(join(outDir, `${outName}.json`), JSON.stringify(info, null, 2) + "\n");
console.log(`installer: ${setup}  (${(info.size / 1048576).toFixed(0)} MB, ${((performance.now() - t0) / 1000).toFixed(0)} s, version ${version} = ${numeric}, ${cfg ? "signed" : "unsigned"}, sha256 ${sha256.slice(0, 16)}...)`);
