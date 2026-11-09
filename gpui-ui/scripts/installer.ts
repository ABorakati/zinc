// Build the Windows installer: `bun gpui-ui/scripts/installer.ts` -> gpui-ui/out/installer/Zinc-Setup-<version>.exe
//
// Inno Setup 7 (installer/zotero-next.iss) over the packaged AOT folder (bun gpui-ui/scripts/package.ts --aot). Per user, no admin.
// See installer/README.md for what the installer does, the silent commands and the signing setup.
//
//   --package <dir>    the app folder to install (default out/package-aot/zotero-next-gpui)
//   --version <stamp>  the build stamp (default: <package>/version.txt, else scripts/_version.ts)
//   --out <dir>        output folder (default out/installer)
//   --no-word          leave the Word add-in out (default: build it into out/installer/word-stage with word/build.ps1 -OutDir and offer it)
//   --reuse-word       use the add-in already in out/installer/word-stage instead of rebuilding it
//   --no-connector     leave the browser connector out (default: build connector-host and the extension and stage them in out/installer/connector-stage)
//   --reuse-connector  use the staged connector (and its already built host and extension) instead of rebuilding
//   --test             a differently identified installer ("Zinc (installer test)", own AppId), file name ending -TEST: for sandbox runs
//
// Inno Setup is found via ZN_ISCC, then C:/Users/abora/zn-ws/_tmp/installer/inno, %LOCALAPPDATA%/Programs/Inno Setup 7, Program Files, PATH.
// Signing (scripts/sign.ts): with a certificate configured the add-in dll, the setup and the uninstaller are signed through ISCC's
// SignTool hook, and the package's exe and zn_pdf.dll are signed first if they are not yet; without one, "unsigned: ..." is printed.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const outName = `Zinc-Setup-${version.replace("+", "-")}${test ? "-TEST" : ""}`;

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

// ---- the browser connector: connector-host (native-messaging host) and the Chrome MV3 extension, staged together -------------------------
// The extension lives in its own repo (ZN_CONNECTOR_DIR, default ../zotero-next-connector, branch zotero-next) and is built with its Bun build.
const connDir = resolve(process.env.ZN_CONNECTOR_DIR ?? join(repo, "..", "zotero-next-connector"));
const connStage = join(root, "out", "installer", "connector-stage");
let connectorDir: string | null = null;
if (!flag("no-connector")) {
	const hostDir = join(repo, "connector-host");
	const stagedExe = join(connStage, "zotero-next-host.exe");
	if (!flag("reuse-connector") || !existsSync(stagedExe) || !existsSync(join(connStage, "extension", "manifest.json"))) {
		if (!existsSync(join(connDir, "scripts", "build-win.ts"))) throw new Error(`browser connector sources not found in ${connDir} (set ZN_CONNECTOR_DIR, or pass --no-connector)`);
		// the same command as connector-host's `bun run build`, but straight into the staging folder: connector-host/dist/zotero-next-host.exe is
		// the exe a browser may be running right now (the dev registration points there), and a running exe cannot be overwritten
		rmSync(connStage, { recursive: true, force: true });
		mkdirSync(connStage, { recursive: true });
		run(["bun", "build", "--compile", "src/main.ts", "--outfile", stagedExe], hostDir); // embeds core/src/connector
		run(["bun", "run", "build"], connDir); // -> zotero-next-connector/build/manifestv3
		// the same command as connector-host's `bun run build`, but straight into the staging folder: connector-host/dist/zotero-next-host.exe is
		// the exe a browser may be running right now (the dev registration points there), and a running exe cannot be overwritten
		rmSync(connStage, { recursive: true, force: true });
		mkdirSync(connStage, { recursive: true });
		run(["bun", "build", "--compile", "src/main.ts", "--outfile", stagedExe], hostDir); // embeds core/src/connector
		run(["bun", "run", "build"], connDir); // -> zotero-next-connector/build/manifestv3
		for (const f of ["install.ps1", "uninstall.ps1"]) copyFileSync(join(hostDir, f), join(connStage, f));
		copyFileSync(join(root, "installer", "connector-howto.html"), join(connStage, "connector-howto.html"));
		// _metadata is written by Chrome into a folder it loads (generated_indexed_rulesets); Chrome also rejects other "_" names, so it is not shipped
		cpSync(join(connDir, "build", "manifestv3"), join(connStage, "extension"), { recursive: true, filter: (s) => !/[\\/]_metadata$/.test(s) });
	}
	// The extension id is fixed by the manifest "key" (sha256 of the public key, first 16 bytes, hex digits 0-f written as a-p). install.ps1 allows exactly this id.
	const man = JSON.parse(readFileSync(join(connStage, "extension", "manifest.json"), "utf8"));
	if (!man.key) throw new Error("the extension manifest has no \"key\": its id would change on every machine");
	const hex = new Bun.CryptoHasher("sha256").update(new Uint8Array(Buffer.from(man.key, "base64"))).digest("hex").slice(0, 32);
	const extId = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
	const psId = /\$ExtensionId = "([a-p]{32})"/.exec(readFileSync(join(connStage, "install.ps1"), "utf8"))?.[1];
	if (extId !== psId) throw new Error(`extension id from the manifest key (${extId}) differs from install.ps1's default (${psId})`);
	console.log(`browser connector: extension ${man.name} ${man.version}, id ${extId}, host ${(statSync(join(connStage, "zotero-next-host.exe")).size / 1048576).toFixed(0)} MB`);
	connectorDir = win(connStage);
}

// ---- signing: package files (if not yet), the add-in dll; the setup and uninstaller go through ISCC's SignTool hook ----------------------
const cfg = signConfig();
if (cfg) {
	const ours = [join(pkg, "zotero-next-gpui.exe"), join(pkg, "zn_pdf.dll"), ...(wordDir ? [join(wordDir, "addin", "ZoteroNextWord.dll")] : []), ...(connectorDir ? [join(connectorDir, "zotero-next-host.exe")] : [])];
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
	StampFile: win(join(stampDir, "version.txt")), AppVer: version, NumVer: numeric, Publisher: publisher, PkgDir: pkg, IconFile: win(join(repo, "gpui-ui", "assets", "icon.ico")),
	OutDir: outDir, OutName: outName, WordScripts: win(join(repo, "word")),
};
if (wordDir) defs.WordDir = wordDir;
if (connectorDir) defs.ConnDir = connectorDir;
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
	version, numericVersion: numeric, file: `${outName}.exe`, size: statSync(setup).size, sha256, signed: !!cfg, word: !!wordDir, connector: !!connectorDir, test,
	silentInstall: `"${outName}.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART`,
};
writeFileSync(join(outDir, `${outName}.json`), JSON.stringify(info, null, 2) + "\n");
console.log(`installer: ${setup}  (${(info.size / 1048576).toFixed(0)} MB, ${((performance.now() - t0) / 1000).toFixed(0)} s, version ${version} = ${numeric}, ${cfg ? "signed" : "unsigned"}, sha256 ${sha256.slice(0, 16)}...)`);
