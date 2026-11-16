// Release script: sign built packages into the update feed (one manifest per platform) and (optionally) publish them.
//
//   bun gpui-ui/scripts/release.ts --keygen <folder-outside-the-repo>
//       Generate the Ed25519 key pair: <folder>/release-key.private.json (KEEP SECRET, back it up, never commit) and
//       <folder>/release-key.public.txt (embed in builds: ZN_UPDATE_PUBKEY_FILE=<that file>, or save it as gpui-ui/update-pubkey.txt).
//
//   ZN_UPDATE_KEY=<path to release-key.private.json> \
//   bun gpui-ui/scripts/release.ts [--installer <Zinc-Setup-....exe>] [--appimage <Zinc-...-x86_64.AppImage>] [--mac-app <Zinc-...-arm64.app.zip>] [options]
//       At least one package. Each gets its own manifest in <out>:
//         --installer  Windows   latest.json               (no "platform" field: every Windows build reads this file)
//         --appimage   Linux     latest-linux-x64.json     ("platform": "linux-x64")
//         --mac-app    macOS     latest-darwin-arm64.json  ("platform": "darwin-arm64"; darwin-x64 when the file name says -x64)
//       --version <stamp>      "0.2.0+1a2b3c4d-20261201" for every package. Default per package: the installer's file name; for the
//                              AppImage and the zip the "<file>.version" next to them (appimage.ts / dmg.ts write it); else the package's
//                              version.txt. The version MUST be the one built into that package, or the updated app is offered it again.
//       --notes <file|text>    release notes, Markdown (a file path, or the text itself; default "Zinc <version>")
//       --url <https url>      where users download the package (one package only; default with --publish: the GitHub release asset URL)
//       --base-url <https url> where users download the packages: <base-url>/<file name> (any number of packages)
//       --min-version <v>      older installs cannot update in place and are told to install by hand
//       --out <dir>            where the manifests go (default gpui-ui/out/release)
//       --publish <owner/repo> then run `gh release create` on that repo with the packages, the manifests and any --attach files
//       --attach <file>        another file for the release (the .dmg, .sha256 files); may be repeated
//       --tag <tag>            the release tag (default v<version>)
//       --dry-run              with --publish: print the gh command instead of running it
//       --force                skip the "key matches the public key built into the app" check
//       --extension-zip <zip>  also write latest-extension.json, the signed feed of the Zinc Connector's unpacked install (the file is
//                              Zinc-Connector-<version>.zip: the unpacked zip with the pinned key). With --publish the zip and the feed are
//                              uploaded too. The app packages may then be left out (a connector-only release).
//       --extension-url <url>  where the zip is downloaded from (default with --publish: the GitHub release asset URL)
//   Each manifest: { version, releasedAt, notes, url, sha256, size, minVersion?, platform?, signature }, signed with the private key, then
//   verified. latest-extension.json has the same fields (no minVersion or platform), key and signing. Nothing is uploaded unless
//   --publish is given, and `--publish --dry-run` shows the command only.
//
// The private key is read from the path in ZN_UPDATE_KEY and refused if that path is inside this repo. See gpui-ui/UPDATES.md.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { generateKeyPair, publicKeyOf, signManifest, verifyManifest, type PrivateJwk } from "../../core/src/update/manifest";
import { feedFileName, type UpdatePlatform } from "../../core/src/update/platform";
import { compareVersions, parseVersion } from "../../core/src/update/version";
import { updatePubkey } from "./_update-key";

const root = resolve(import.meta.dir, "..");
const repo = resolve(root, "..");
const args = process.argv.slice(2);
const arg = (n: string): string | undefined => {
	const i = args.indexOf(`--${n}`);
	const v = i >= 0 ? args[i + 1] : undefined;
	return v && !v.startsWith("--") ? v : undefined;
};
const all = (n: string): string[] =>
	args.flatMap((a, i) => (a === `--${n}` && args[i + 1] && !args[i + 1]!.startsWith("--") ? [args[i + 1]!] : []));
const flag = (n: string) => args.includes(`--${n}`);
const die = (m: string): never => {
	console.error(`release: ${m}`);
	process.exit(1);
};

const insideRepo = (p: string) => {
	const r = relative(repo, resolve(p));
	return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

// ------------------------------------------------------------------------------------------------------------ --keygen

if (flag("keygen")) {
	const dir = arg("keygen") ?? die("--keygen needs a folder (outside the repo)");
	if (insideRepo(dir)) die(`${resolve(dir)} is inside the repository. The private key must live outside it (and be backed up).`);
	mkdirSync(dir, { recursive: true });
	const priv = join(dir, "release-key.private.json"),
		pub = join(dir, "release-key.public.txt");
	if (existsSync(priv) || existsSync(pub)) die(`${priv} or ${pub} already exists; not overwriting a signing key`);
	const kp = await generateKeyPair();
	writeFileSync(priv, JSON.stringify(kp.privateJwk, null, 2) + "\n", { flag: "wx" });
	writeFileSync(pub, kp.publicKey + "\n", { flag: "wx" });
	console.log(`private key: ${priv}   (secret: back it up, never commit it)`);
	console.log(`public key:  ${pub}`);
	console.log(`             ${kp.publicKey}`);
	console.log(
		`Embed the public key in builds with  ZN_UPDATE_PUBKEY_FILE=${pub}  (or save it as gpui-ui/update-pubkey.txt and commit that file).`,
	);
	process.exit(0);
}

// ------------------------------------------------------------------------------------------------------------ the packages

interface Pkg {
	file: string;
	platform: UpdatePlatform;
	version: string;
}

const packageVersion = (): string | undefined => {
	for (const d of ["package-aot", "package"]) {
		const stamp = join(root, "out", d, "zotero-next-gpui", "version.txt");
		if (existsSync(stamp)) return readFileSync(stamp, "utf8").trim();
	}
	return undefined;
};
const sidecar = (file: string): string | undefined =>
	existsSync(`${file}.version`) ? readFileSync(`${file}.version`, "utf8").trim() : undefined;

const pkgs: Pkg[] = [];
const installer = arg("installer");
if (installer) {
	const m = /^(?:Zinc|ZoteroNext)-Setup-(\d+(?:\.\d+)*)-([0-9a-f]{8})-(\d{8})(?:-TEST)?\.exe$/i.exec(basename(installer));
	pkgs.push({
		file: installer,
		platform: "win-x64",
		version:
			arg("version") ??
			(m ? `${m[1]}+${m[2]}-${m[3]}` : packageVersion()) ??
			die(`cannot tell the version of ${installer}: pass --version <stamp>`),
	});
}
const appimage = arg("appimage");
if (appimage)
	pkgs.push({
		file: appimage,
		platform: "linux-x64",
		version:
			arg("version") ??
			sidecar(appimage) ??
			die(`cannot tell the version of ${appimage}: no ${basename(appimage)}.version next to it; pass --version <stamp>`),
	});
const macApp = arg("mac-app");
if (macApp) {
	if (!/\.zip$/i.test(macApp))
		die(`--mac-app wants the zipped Zinc.app (dmg.ts writes Zinc-<version>-<arch>.app.zip), not ${basename(macApp)}`);
	pkgs.push({
		file: macApp,
		platform: /-x64\b/i.test(basename(macApp)) ? "darwin-x64" : "darwin-arm64",
		version:
			arg("version") ??
			sidecar(macApp) ??
			die(`cannot tell the version of ${macApp}: no ${basename(macApp)}.version next to it; pass --version <stamp>`),
	});
}
const extZip = arg("extension-zip");
if (!pkgs.length && !extZip)
	die(
		"usage: bun gpui-ui/scripts/release.ts --installer <setup.exe> | --appimage <file> | --mac-app <file.app.zip> [--extension-zip <zip>] (see the header of this file); --keygen <folder> makes the key pair",
	);
for (const p of pkgs) {
	if (!existsSync(p.file)) die(`no such file: ${p.file}`);
	if (!parseVersion(p.version)) die(`not a version: ${p.version} (${basename(p.file)})`);
}
if (extZip && !existsSync(extZip)) die(`no such extension zip: ${extZip}`);
// The connector's own version: the zip's name (Zinc-Connector-<version>.zip, the version the extension reports), else --version, else
// the app package's. latest-extension.json must carry exactly this: the extension compares it with its manifest version, and an app
// stamp (0.1.11+1a2b3c4d-20261116) would count as newer than its own 0.1.11 for ever.
const extVersion = (): string => {
	const z = extZip ? /^Zinc-Connector-(.+)\.zip$/i.exec(basename(extZip)) : null;
	const v = (z && parseVersion(z[1]!) ? z[1]! : undefined) ?? arg("version") ?? packageVersion();
	return v ?? die(`cannot tell the version of ${extZip}: pass --version <stamp>`);
};

const keyPath = process.env.ZN_UPDATE_KEY ?? die("ZN_UPDATE_KEY (path to release-key.private.json) is not set");
if (insideRepo(keyPath)) die(`ZN_UPDATE_KEY points inside the repository (${resolve(keyPath)}). Keep the private key outside it.`);
const jwk: PrivateJwk = (() => {
	try {
		return JSON.parse(readFileSync(keyPath, "utf8")) as PrivateJwk;
	} catch (e) {
		return die(`cannot read the private key ${keyPath}: ${e instanceof Error ? e.message : e}`);
	}
})();
if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d || !jwk.x) die("the private key file is not an Ed25519 JWK");
const publicKey = publicKeyOf(jwk);

// does the app trust this key? (the key built into the app is the one checked-in/env public key)
const built = (() => {
	const w = console.warn;
	console.warn = () => {};
	try {
		return updatePubkey();
	} finally {
		console.warn = w;
	}
})();
if (built && built !== publicKey && !flag("force"))
	die(
		`this private key does not match the public key builds embed (${built}); apps would reject the manifest. Use the right key, or --force.`,
	);
if (!built)
	console.warn(
		"release: note - no public key is configured for builds here (ZN_UPDATE_PUBKEY_FILE / gpui-ui/update-pubkey.txt); make sure the app you ship embeds " +
			publicKey,
	);

const minVersion = arg("min-version");
if (minVersion && !parseVersion(minVersion)) die(`not a version: ${minVersion}`);

// the release is named after its newest package (they are usually the same stamp, or the same release built on different days)
const version = pkgs.length ? pkgs.map((p) => p.version).reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b)) : extVersion();
const notesArg = arg("notes");
const notes = notesArg === undefined ? `Zinc ${version}` : existsSync(notesArg) ? readFileSync(notesArg, "utf8") : notesArg;

const publishRepo = arg("publish");
const tag = arg("tag") ?? `v${version}`;
const urlArg = arg("url"),
	baseUrl = arg("base-url");
if (urlArg && pkgs.length > 1) die("--url names one package's download; with several packages use --base-url or --publish");
const urlOf = (file: string): string =>
	urlArg ??
	(baseUrl
		? `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(basename(file))}`
		: publishRepo
			? `https://github.com/${publishRepo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(basename(file))}`
			: die("--url / --base-url <https url> is required (or --publish <owner/repo>, which implies the GitHub release URL)"));

const sha256Of = (file: string) =>
	new Promise<string>((res, rej) => {
		const h = createHash("sha256");
		createReadStream(file)
			.on("data", (d) => h.update(d))
			.on("error", rej)
			.on("end", () => res(h.digest("hex")));
	});

const out = resolve(arg("out") ?? join(root, "out", "release"));
mkdirSync(out, { recursive: true });
const releasedAt = new Date().toISOString();
const manifests: string[] = [];
for (const p of pkgs) {
	const sha256 = await sha256Of(p.file);
	const size = statSync(p.file).size;
	const url = urlOf(p.file);
	const manifest = await signManifest(
		{
			version: p.version,
			releasedAt,
			notes,
			url,
			sha256,
			size,
			...(minVersion ? { minVersion } : {}),
			...(p.platform === "win-x64" ? {} : { platform: p.platform }), // latest.json stays readable by older Windows builds
		},
		jwk,
	);
	await verifyManifest(JSON.parse(JSON.stringify(manifest)), publicKey); // our own output must verify
	const dest = join(out, feedFileName(p.platform));
	writeFileSync(dest, JSON.stringify(manifest, null, 2) + "\n");
	manifests.push(dest);
	console.log(
		`wrote ${dest}\n  ${p.platform}  version ${p.version}\n  ${basename(p.file)}  ${size} bytes  sha256 ${sha256}\n  url ${url}`,
	);
}
// The Zinc Connector's feed: the same fields, key and signing, for the unpacked zip. The extension checks it once a day (browserExt/updateNotice.js).
const extFiles: string[] = [];
if (extZip) {
	const url =
		arg("extension-url") ??
		(baseUrl
			? `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(basename(extZip))}`
			: publishRepo
				? `https://github.com/${publishRepo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(basename(extZip))}`
				: die(
						"--extension-url / --base-url <https url> is required (or --publish <owner/repo>, which implies the GitHub release URL)",
					));
	const sha256 = await sha256Of(extZip);
	const size = statSync(extZip).size;
	const extV = extVersion();
	const manifest = await signManifest({ version: extV, releasedAt, notes, url, sha256, size }, jwk);
	await verifyManifest(JSON.parse(JSON.stringify(manifest)), publicKey);
	const feed = join(out, "latest-extension.json");
	writeFileSync(feed, JSON.stringify(manifest, null, 2) + "\n");
	extFiles.push(resolve(extZip), feed);
	console.log(`wrote ${feed}\n  extension  version ${extV}\n  ${basename(extZip)}  ${size} bytes  sha256 ${sha256}\n  url ${url}`);
}
console.log(`signed with public key ${publicKey}`);

// ------------------------------------------------------------------------------------------------------------ --publish

const attach = all("attach");
for (const f of attach) if (!existsSync(f)) die(`no such file to attach: ${f}`);
if (publishRepo) {
	const notesFile = join(out, "release-notes.md");
	writeFileSync(notesFile, notes.endsWith("\n") ? notes : notes + "\n");
	const cmd = [
		"gh",
		"release",
		"create",
		tag,
		...pkgs.map((p) => resolve(p.file)),
		...manifests,
		...extFiles,
		...attach.map((f) => resolve(f)),
		"--repo",
		publishRepo,
		"--title",
		`Zinc ${version}`,
		"--notes-file",
		notesFile,
		"--latest",
	];
	if (flag("dry-run")) {
		console.log(`dry run, not publishing. Would run:\n  ${cmd.map((c) => (/\s/.test(c) ? `"${c}"` : c)).join(" ")}`);
	} else {
		console.log(`publishing to ${publishRepo} as ${tag} ...`);
		const r = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
		if (r.exitCode !== 0) die(`gh release create failed (${r.exitCode})`);
		console.log(
			`published. Feed URL (if the repo is public): https://github.com/${publishRepo}/releases/latest/download/${pkgs.length ? "latest.json" : "latest-extension.json"}`,
		);
		if (pkgs.length)
			console.log("  (Linux and macOS builds read latest-linux-x64.json / latest-darwin-arm64.json from the same place.)");
	}
} else {
	console.log(
		`not published. Upload ${[...pkgs.map((p) => resolve(p.file)), ...manifests, ...extFiles].map((f) => basename(f)).join(", ")} yourself, or re-run with --publish <owner/repo> (add --dry-run to preview).`,
	);
}
