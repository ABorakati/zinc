// Wrap the packaged Linux app in an AppImage: `bun scripts/appimage.ts [--aot] [--no-package] [--package <dir>] [--out <dir>]` (Linux x64 only).
//
// --aot wraps the ahead-of-time compiled package (scripts/package.ts --aot, out/package-aot/zotero-next-gpui; the Bun canary is fetched by
// scripts/_bun-canary.ts) instead of the bytecode one. The AppImage is named and laid out the same either way.
//
//   out/appimage/Zinc-<version>-x86_64.AppImage     one file: chmod +x, then run it (also .sha256, and .version: the build stamp for release.ts)
//
// Steps: scripts/package.ts (unless --no-package / --package), then an AppDir
//   Zinc.AppDir/AppRun                 starts usr/lib/zinc/zotero-next-gpui
//   Zinc.AppDir/zinc.desktop, zinc.png, .DirIcon
//   Zinc.AppDir/usr/lib/zinc/          the package folder (exe, libzn_pdf.so, libpdfium.so, vendor/, reader-host/, note-host/ ...)
//   Zinc.AppDir/usr/share/applications/zinc.desktop, usr/share/icons/hicolor/256x256/apps/zinc.png
// and appimagetool with a pinned runtime. Both tools are downloaded once into out/appimage/tools and checked against the sha256 GitHub
// publishes for the release asset; ZN_APPIMAGETOOL points at another appimagetool. appimagetool runs with --appimage-extract-and-run, so
// building needs no FUSE (WSL2, containers).
//
// Not bundled: the system libraries every desktop has (glibc, X11, Vulkan, fontconfig) and, for snapshots, EPUBs and the note editor,
// GTK 4 + WebKitGTK 6 (libwebkitgtk-6.0-4). Without WebKitGTK those open in the default app instead; the library, the PDF reader and sync
// do not need it. The AppImage does not integrate itself into the menu; AppImageLauncher or Gear Lever do that.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { BUILD_VERSION } from "./_version";

if (process.platform !== "linux" || process.arch !== "x64") throw new Error("appimage.ts builds on Linux x64 only");

const root = resolve(import.meta.dir, "..");
const arg = (name: string): string | undefined => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const aot = process.argv.includes("--aot");
const outDir = resolve(arg("out") ?? join(root, "out", "appimage"));
const pkg = resolve(arg("package") ?? join(root, "out", aot ? "package-aot" : "package", "zotero-next-gpui"));

const run = (cmd: string[], cwd = root, env: Record<string, string> = {}) => {
	const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } });
	if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${r.exitCode})`);
};

// 1. the package
if (!process.argv.includes("--no-package") && !arg("package")) run(["bun", "scripts/package.ts", ...(aot ? ["--aot"] : [])]);
if (!existsSync(join(pkg, "zotero-next-gpui")))
	throw new Error(`no packaged Linux app in ${pkg}: run  bun scripts/package.ts${aot ? " --aot" : ""}  first`);

// 2. tools (pinned; sha256 from the release asset digests)
const TOOLS = {
	appimagetool: {
		url: "https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage",
		sha256: "ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0",
	},
	runtime: {
		url: "https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64",
		sha256: "2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d",
	},
} as const;
const toolsDir = join(outDir, "tools");
mkdirSync(toolsDir, { recursive: true });
async function tool(name: keyof typeof TOOLS): Promise<string> {
	const { url, sha256 } = TOOLS[name];
	const file = join(toolsDir, url.slice(url.lastIndexOf("/") + 1));
	const sum = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
	if (!existsSync(file) || sum(readFileSync(file)) !== sha256) {
		console.log("downloading", url);
		const res = await fetch(url, { redirect: "follow" });
		if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${url}`);
		const bytes = new Uint8Array(await res.arrayBuffer());
		if (sum(bytes) !== sha256) throw new Error(`sha256 mismatch for ${url}`);
		writeFileSync(file, bytes);
	}
	chmodSync(file, 0o755);
	return file;
}
const appimagetool = process.env.ZN_APPIMAGETOOL ?? (await tool("appimagetool"));
const runtime = await tool("runtime");

// 3. the AppDir
const appDir = join(outDir, "Zinc.AppDir");
rmSync(appDir, { recursive: true, force: true });
const lib = join(appDir, "usr", "lib", "zinc");
mkdirSync(lib, { recursive: true });
cpSync(pkg, lib, { recursive: true, verbatimSymlinks: true });
chmodSync(join(lib, "zotero-next-gpui"), 0o755);
if (existsSync(join(lib, "zhw"))) chmodSync(join(lib, "zhw"), 0o755);

// GPUI's addon links libxkbcommon-x11 and libxcb-xkb, which minimal systems (WSL, some server images with a desktop added) lack;
// without them the addon does not load at all. Both are small and only depend on libxkbcommon / libxcb, so they ship in usr/lib/zinc/lib
// as a fallback (AppRun puts that folder AFTER the system's, so a system copy wins). Found with ldconfig, or in ZN_APPIMAGE_LIB_DIRS.
const FALLBACK_LIBS = ["libxkbcommon-x11.so.0", "libxcb-xkb.so.1"];
const libDirs = (process.env.ZN_APPIMAGE_LIB_DIRS ?? "").split(":").filter(Boolean);
const ldconfig = Bun.spawnSync(["sh", "-c", "ldconfig -p 2>/dev/null || /sbin/ldconfig -p"], { stdout: "pipe" }).stdout.toString();
mkdirSync(join(lib, "lib"), { recursive: true });
for (const so of FALLBACK_LIBS) {
	const found = [
		...libDirs.map((d) => join(d, so)),
		...[...ldconfig.matchAll(new RegExp(`${so.replace(/\./g, "\\.")} \\(libc6,x86-64\\) => (\\S+)`, "g"))].map((m) => m[1]!),
	].find((p) => existsSync(p));
	if (found) cpSync(found, join(lib, "lib", so), { dereference: true });
	else
		console.warn(
			`appimage: ${so} not found on this machine (install it or set ZN_APPIMAGE_LIB_DIRS); the AppImage then needs it on the user's system`,
		);
}

writeFileSync(
	join(appDir, "AppRun"),
	[
		"#!/bin/sh",
		"# Zinc AppImage entry point: start the app from the mounted image. APPIMAGE (set by the runtime) is the .AppImage file itself.",
		'HERE="$(dirname "$(readlink -f "$0")")"',
		"# the bundled X11 keyboard libraries are a fallback: the system's own come first",
		'export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:+$LD_LIBRARY_PATH:}/usr/lib/x86_64-linux-gnu:/usr/lib64:/usr/lib:$HERE/usr/lib/zinc/lib"',
		'exec "$HERE/usr/lib/zinc/zotero-next-gpui" "$@"',
		"",
	].join("\n"),
);
chmodSync(join(appDir, "AppRun"), 0o755);

const desktop = [
	"[Desktop Entry]",
	"Type=Application",
	"Name=Zinc",
	"GenericName=Reference manager",
	"Comment=A fast reference manager that works with your Zotero library",
	"Exec=zotero-next-gpui %U",
	"Icon=zinc",
	"Terminal=false",
	"Categories=Office;",
	"Keywords=zotero;references;citations;bibliography;pdf;",
	"",
].join("\n");
writeFileSync(join(appDir, "zinc.desktop"), desktop);
mkdirSync(join(appDir, "usr", "share", "applications"), { recursive: true });
writeFileSync(join(appDir, "usr", "share", "applications", "zinc.desktop"), desktop);
const icon = join(root, "assets", "icon.png");
cpSync(icon, join(appDir, "zinc.png"));
mkdirSync(join(appDir, "usr", "share", "icons", "hicolor", "256x256", "apps"), { recursive: true });
cpSync(icon, join(appDir, "usr", "share", "icons", "hicolor", "256x256", "apps", "zinc.png"));
symlinkSync("zinc.png", join(appDir, ".DirIcon"));

// 4. the AppImage
const outFile = join(outDir, `Zinc-${BUILD_VERSION.split("+")[0]}-x86_64.AppImage`);
rmSync(outFile, { force: true });
run([appimagetool, "--appimage-extract-and-run", "--no-appstream", "--runtime-file", runtime, appDir, outFile], outDir, { ARCH: "x86_64" });
chmodSync(outFile, 0o755);
const sha = createHash("sha256").update(readFileSync(outFile)).digest("hex");
writeFileSync(`${outFile}.sha256`, `${sha}  ${outFile.slice(outFile.lastIndexOf("/") + 1)}\n`);
// the exact build stamp, for scripts/release.ts to sign into latest-linux-x64.json (the file name only has the release number)
writeFileSync(
	`${outFile}.version`,
	`${existsSync(join(pkg, "version.txt")) ? readFileSync(join(pkg, "version.txt"), "utf8").trim() : BUILD_VERSION}\n`,
);
console.log(`appimage: ${outFile}  (${(statSync(outFile).size / 1048576).toFixed(0)} MB, sha256 ${sha})`);
