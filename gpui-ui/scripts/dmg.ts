// Wrap the packaged macOS app in Zinc.app and a disk image: `bun scripts/dmg.ts [--no-package] [--package <dir>] [--out <dir>]` (macOS only:
// it uses sips, iconutil, codesign and hdiutil, which come with the system).
//
//   out/dmg/Zinc-<version>-<arm64|x64>.dmg      opens to Zinc.app and a link to Applications
//   out/dmg/Zinc-<version>-<arm64|x64>.app.zip  Zinc.app for the in-app updater (ditto -c -k --keepParent), with .version and .sha256
//
// Steps: scripts/package.ts (unless --no-package / --package), then the bundle
//   Zinc.app/Contents/Info.plist
//   Zinc.app/Contents/MacOS/zotero-next-gpui, libzn_pdf.dylib, libpdfium.dylib   the code (zn_pdf finds PDFium next to itself)
//   Zinc.app/Contents/Resources/                    everything else from the package folder (vendor/, reader-host/, note-host/, workers,
//                                                   README.txt, version.txt) and Zinc.icns; src/packaged.ts looks here for its data
// an ad-hoc signature (codesign --sign -; Apple Silicon runs no unsigned code), and a compressed UDZO image.
//
// Not notarised and not signed with a Developer ID: the first start needs right-click > Open (or System Settings > Privacy & Security >
// Open Anyway). With ZN_MAC_SIGN_IDENTITY set ("Developer ID Application: ...") the bundle is signed with that identity and the hardened
// runtime instead; notarising (xcrun notarytool) is not done here.
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { BUILD_VERSION } from "./_version";

if (process.platform !== "darwin") throw new Error("dmg.ts builds on macOS only (hdiutil, codesign, iconutil)");

const root = resolve(import.meta.dir, "..");
const arg = (name: string): string | undefined => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
};
const outDir = resolve(arg("out") ?? join(root, "out", "dmg"));
const pkg = resolve(arg("package") ?? join(root, "out", "package", "zotero-next-gpui"));
const version = BUILD_VERSION.split("+")[0]!;

const run = (cmd: string[], cwd = root) => {
	const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
	if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${r.exitCode})`);
};

// 1. the package
if (!process.argv.includes("--no-package") && !arg("package")) run(["bun", "scripts/package.ts"]);
if (!existsSync(join(pkg, "zotero-next-gpui"))) throw new Error(`no packaged macOS app in ${pkg}: run  bun scripts/package.ts  first`);

// 2. the bundle
rmSync(outDir, { recursive: true, force: true });
const app = join(outDir, "stage", "Zinc.app");
const macos = join(app, "Contents", "MacOS");
const res = join(app, "Contents", "Resources");
mkdirSync(macos, { recursive: true });
mkdirSync(res, { recursive: true });
const CODE = new Set(["zotero-next-gpui", "libzn_pdf.dylib", "libpdfium.dylib"]);
for (const name of readdirSync(pkg)) {
	if (name === "icon.png") continue;
	cpSync(join(pkg, name), join(CODE.has(name) ? macos : res, name), { recursive: true, verbatimSymlinks: true });
}
chmodSync(join(macos, "zotero-next-gpui"), 0o755);

// the icon: icon.png (1024 px or less) scaled into an .iconset, then iconutil
const iconset = join(outDir, "Zinc.iconset");
mkdirSync(iconset, { recursive: true });
const icon = join(root, "assets", "icon.png");
for (const s of [16, 32, 128, 256, 512]) {
	run(["sips", "-z", String(s), String(s), icon, "--out", join(iconset, `icon_${s}x${s}.png`)]);
	run(["sips", "-z", String(s * 2), String(s * 2), icon, "--out", join(iconset, `icon_${s}x${s}@2x.png`)]);
}
run(["iconutil", "-c", "icns", iconset, "-o", join(res, "Zinc.icns")]);

const plist = {
	CFBundleDevelopmentRegion: "en",
	CFBundleDisplayName: "Zinc",
	CFBundleExecutable: "zotero-next-gpui",
	CFBundleIconFile: "Zinc",
	CFBundleIdentifier: "io.github.aborakati.zinc",
	CFBundleInfoDictionaryVersion: "6.0",
	CFBundleName: "Zinc",
	CFBundlePackageType: "APPL",
	CFBundleShortVersionString: version,
	CFBundleVersion: BUILD_VERSION.replace(/[^0-9.]/g, ".")
		.replace(/\.+/g, ".")
		.replace(/^\.|\.$/g, "")
		.split(".")
		.slice(0, 3)
		.join("."),
	LSApplicationCategoryType: "public.app-category.productivity",
	LSMinimumSystemVersion: "13.0",
	NSHighResolutionCapable: true,
	NSHumanReadableCopyright: "AGPL-3.0. Not affiliated with the Zotero project.",
};
const xml = (v: unknown): string =>
	typeof v === "boolean" ? (v ? "<true/>" : "<false/>") : `<string>${String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`;
writeFileSync(
	join(app, "Contents", "Info.plist"),
	[
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		...Object.entries(plist).map(([k, v]) => `\t<key>${k}</key>\n\t${xml(v)}`),
		"</dict>",
		"</plist>",
		"",
	].join("\n"),
);

// 3. signature: the libraries first, then the exe and the bundle (codesign --deep is deprecated for signing)
const identity = process.env.ZN_MAC_SIGN_IDENTITY;
const signArgs = identity ? ["--sign", identity, "--options", "runtime", "--timestamp"] : ["--sign", "-"];
for (const lib of ["libzn_pdf.dylib", "libpdfium.dylib"]) run(["codesign", "--force", ...signArgs, join(macos, lib)]);
run(["codesign", "--force", ...signArgs, app]);
run(["codesign", "--verify", "--strict", "--verbose=2", app]);

// 4. the disk image: Zinc.app plus a link to /Applications, compressed
symlinkSync("/Applications", join(outDir, "stage", "Applications"));
const arch = process.arch === "arm64" ? "arm64" : "x64";
const dmg = join(outDir, `Zinc-${version}-${arch}.dmg`);
run(["hdiutil", "create", "-volname", "Zinc", "-srcfolder", join(outDir, "stage"), "-ov", "-format", "UDZO", "-fs", "HFS+", dmg]);
const sha = createHash("sha256")
	.update(await Bun.file(dmg).bytes())
	.digest("hex");
writeFileSync(`${dmg}.sha256`, `${sha}  Zinc-${version}-${arch}.dmg\n`);
console.log(`dmg: ${dmg}  (${(statSync(dmg).size / 1048576).toFixed(0)} MB, sha256 ${sha})`);

// 5. the update archive: Zinc.app zipped with ditto (keeps symlinks, modes and the signature), which the app's updater downloads and
//    unpacks (core/src/update/replace.ts). <zip>.version holds the exact build stamp, for scripts/release.ts to sign into latest-darwin-*.json.
const zip = join(outDir, `Zinc-${version}-${arch}.app.zip`);
run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
const stamp = existsSync(join(pkg, "version.txt")) ? (await Bun.file(join(pkg, "version.txt")).text()).trim() : BUILD_VERSION;
writeFileSync(`${zip}.version`, `${stamp}\n`);
const zipSha = createHash("sha256")
	.update(await Bun.file(zip).bytes())
	.digest("hex");
writeFileSync(`${zip}.sha256`, `${zipSha}  Zinc-${version}-${arch}.app.zip\n`);
console.log(`update archive: ${zip}  (${(statSync(zip).size / 1048576).toFixed(0)} MB, version ${stamp})`);
