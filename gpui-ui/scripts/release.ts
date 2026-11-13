// Release script: sign a built installer into the update feed and (optionally) publish it.
//
//   bun gpui-ui/scripts/release.ts --keygen <folder-outside-the-repo>
//       Generate the Ed25519 key pair: <folder>/release-key.private.json (KEEP SECRET, back it up, never commit) and
//       <folder>/release-key.public.txt (embed in builds: ZN_UPDATE_PUBKEY_FILE=<that file>, or save it as gpui-ui/update-pubkey.txt).
//
//   ZN_UPDATE_KEY=<path to release-key.private.json> \
//   bun gpui-ui/scripts/release.ts --installer <Zinc-Setup-....exe> (ZoteroNext-Setup-....exe also accepted) [options]
//       --version <stamp>      "0.2.0+1a2b3c4d-20261201" (default: parsed from the installer's file name, else the package's version.txt)
//       --notes <file|text>    release notes, Markdown (a file path, or the text itself; default "Zinc <version>")
//       --url <https url>      where users download the installer (default with --publish: the GitHub release asset URL)
//       --min-version <v>      older installs cannot update in place and are told to install by hand
//       --out <dir>            where latest.json goes (default gpui-ui/out/release)
//       --publish <owner/repo> then run `gh release create` on that repo with the installer and latest.json
//       --tag <tag>            the release tag (default v<version>)
//       --dry-run              with --publish: print the gh command instead of running it
//       --force                skip the "key matches the public key built into the app" check
//       --extension-zip <zip>  also write latest-extension.json, the signed feed of the Zinc Connector's unpacked install (the file is
//                              Zinc-Connector-<version>.zip: the unpacked zip with the pinned key). With --publish the zip and the feed are
//                              uploaded too. --installer may then be left out (a connector-only release).
//       --extension-url <url>  where the zip is downloaded from (default with --publish: the GitHub release asset URL)
//   Writes <out>/latest.json: { version, releasedAt, notes, url, sha256, size, minVersion?, signature }, signed with the private key, then
//   verifies its own output. latest-extension.json has the same fields (no minVersion), the same key and the same signing. Nothing is uploaded unless --publish is given, and `--publish --dry-run` shows the command only.
//
// The private key is read from the path in ZN_UPDATE_KEY and refused if that path is inside this repo. See gpui-ui/UPDATES.md.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { generateKeyPair, publicKeyOf, signManifest, verifyManifest, type PrivateJwk } from "../../core/src/update/manifest";
import { parseVersion } from "../../core/src/update/version";
import { updatePubkey } from "./_update-key";

const root = resolve(import.meta.dir, "..");
const repo = resolve(root, "..");
const args = process.argv.slice(2);
const arg = (n: string): string | undefined => { const i = args.indexOf(`--${n}`); const v = i >= 0 ? args[i + 1] : undefined; return v && !v.startsWith("--") ? v : undefined; };
const flag = (n: string) => args.includes(`--${n}`);
const die = (m: string): never => { console.error(`release: ${m}`); process.exit(1); };

const insideRepo = (p: string) => { const r = relative(repo, resolve(p)); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };

// ------------------------------------------------------------------------------------------------------------ --keygen

if (flag("keygen")) {
	const dir = arg("keygen") ?? die("--keygen needs a folder (outside the repo)");
	if (insideRepo(dir)) die(`${resolve(dir)} is inside the repository. The private key must live outside it (and be backed up).`);
	mkdirSync(dir, { recursive: true });
	const priv = join(dir, "release-key.private.json"), pub = join(dir, "release-key.public.txt");
	if (existsSync(priv) || existsSync(pub)) die(`${priv} or ${pub} already exists; not overwriting a signing key`);
	const kp = await generateKeyPair();
	writeFileSync(priv, JSON.stringify(kp.privateJwk, null, 2) + "\n", { flag: "wx" });
	writeFileSync(pub, kp.publicKey + "\n", { flag: "wx" });
	console.log(`private key: ${priv}   (secret: back it up, never commit it)`);
	console.log(`public key:  ${pub}`);
	console.log(`             ${kp.publicKey}`);
	console.log(`Embed the public key in builds with  ZN_UPDATE_PUBKEY_FILE=${pub}  (or save it as gpui-ui/update-pubkey.txt and commit that file).`);
	process.exit(0);
}

// ------------------------------------------------------------------------------------------------------------ sign

const extZip = arg("extension-zip");
const installer = arg("installer") ?? (extZip ? undefined : die("usage: bun gpui-ui/scripts/release.ts --installer <setup.exe> [--extension-zip <zip>] (see the header of this file); --keygen <folder> makes the key pair"));
if (installer && !existsSync(installer)) die(`no such installer: ${installer}`);
if (extZip && !existsSync(extZip)) die(`no such extension zip: ${extZip}`);
const keyPath = process.env.ZN_UPDATE_KEY ?? die("ZN_UPDATE_KEY (path to release-key.private.json) is not set");
if (insideRepo(keyPath)) die(`ZN_UPDATE_KEY points inside the repository (${resolve(keyPath)}). Keep the private key outside it.`);
const jwk: PrivateJwk = (() => { try { return JSON.parse(readFileSync(keyPath, "utf8")) as PrivateJwk; } catch (e) { return die(`cannot read the private key ${keyPath}: ${e instanceof Error ? e.message : e}`); } })();
if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d || !jwk.x) die("the private key file is not an Ed25519 JWK");
const publicKey = publicKeyOf(jwk);

// does the app trust this key? (the key built into the app is the one checked-in/env public key)
const built = (() => { const w = console.warn; console.warn = () => {}; try { return updatePubkey(); } finally { console.warn = w; } })();
if (built && built !== publicKey && !flag("force")) die(`this private key does not match the public key builds embed (${built}); apps would reject the manifest. Use the right key, or --force.`);
if (!built) console.warn("release: note - no public key is configured for builds here (ZN_UPDATE_PUBKEY_FILE / gpui-ui/update-pubkey.txt); make sure the app you ship embeds " + publicKey);

const version = (() => {
	const v = arg("version");
	if (v) return v;
	const m = installer ? /^(?:Zinc|ZoteroNext)-Setup-(\d+(?:\.\d+)*)-([0-9a-f]{8})-(\d{8})(?:-TEST)?\.exe$/i.exec(basename(installer)) : null;
	if (m) return `${m[1]}+${m[2]}-${m[3]}`;
	const z = extZip && !installer ? /^Zinc-Connector-(.+)\.zip$/i.exec(basename(extZip)) : null;
	if (z && parseVersion(z[1]!)) return z[1]!;
	const stamp = join(root, "out", "package-aot", "zotero-next-gpui", "version.txt");
	return existsSync(stamp) ? readFileSync(stamp, "utf8").trim() : die("cannot tell the version: pass --version <stamp>");
})();
if (!parseVersion(version)) die(`not a version: ${version}`);
const minVersion = arg("min-version");
if (minVersion && !parseVersion(minVersion)) die(`not a version: ${minVersion}`);

const notesArg = arg("notes");
const notes = notesArg === undefined ? `Zinc ${version}` : existsSync(notesArg) ? readFileSync(notesArg, "utf8") : notesArg;

const publishRepo = arg("publish");
const tag = arg("tag") ?? `v${version}`;
const assetUrl = (f: string) => `https://github.com/${publishRepo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(f)}`;
const sha256Of = (p: string) => new Promise<string>((res, rej) => {
	const h = createHash("sha256");
	createReadStream(p).on("data", (d) => h.update(d)).on("error", rej).on("end", () => res(h.digest("hex")));
});

const out = resolve(arg("out") ?? join(root, "out", "release"));
mkdirSync(out, { recursive: true });
const uploads: string[] = [];
let file = "";

if (installer) {
	file = basename(installer);
	const url = arg("url") ?? (publishRepo ? assetUrl(file) : die("--url <https url of the installer> is required (or --publish <owner/repo>, which implies the GitHub release URL)"));
	const sha256 = await sha256Of(installer);
	const size = statSync(installer).size;

	const manifest = await signManifest({ version, releasedAt: new Date().toISOString(), notes, url, sha256, size, ...(minVersion ? { minVersion } : {}) }, jwk);
	await verifyManifest(JSON.parse(JSON.stringify(manifest)), publicKey); // our own output must verify

	const latest = join(out, "latest.json");
	writeFileSync(latest, JSON.stringify(manifest, null, 2) + "\n");
	uploads.push(resolve(installer), latest);
	console.log(`wrote ${latest}`);
	console.log(`  version ${version}\n  installer ${file}  ${size} bytes  sha256 ${sha256}\n  url ${url}\n  signed with public key ${publicKey}`);
}

// The Zinc Connector's feed: the same fields, key and signing, for the unpacked zip. The extension checks it once a day (browserExt/updateNotice.js).
if (extZip) {
	const zipName = basename(extZip);
	const url = arg("extension-url") ?? (publishRepo ? assetUrl(zipName) : die("--extension-url <https url of the zip> is required (or --publish <owner/repo>, which implies the GitHub release URL)"));
	const sha256 = await sha256Of(extZip);
	const size = statSync(extZip).size;
	const manifest = await signManifest({ version, releasedAt: new Date().toISOString(), notes, url, sha256, size }, jwk);
	await verifyManifest(JSON.parse(JSON.stringify(manifest)), publicKey);
	const feed = join(out, "latest-extension.json");
	writeFileSync(feed, JSON.stringify(manifest, null, 2) + "\n");
	uploads.push(resolve(extZip), feed);
	console.log(`wrote ${feed}`);
	console.log(`  version ${version}\n  extension ${zipName}  ${size} bytes  sha256 ${sha256}\n  url ${url}\n  signed with public key ${publicKey}`);
}

// ------------------------------------------------------------------------------------------------------------ --publish

if (publishRepo) {
	const notesFile = join(out, "release-notes.md");
	writeFileSync(notesFile, notes.endsWith("\n") ? notes : notes + "\n");
	const cmd = ["gh", "release", "create", tag, ...uploads, "--repo", publishRepo, "--title", `Zinc ${version}`, "--notes-file", notesFile, "--latest"];
	if (flag("dry-run")) {
		console.log(`dry run, not publishing. Would run:\n  ${cmd.map((c) => (/\s/.test(c) ? `"${c}"` : c)).join(" ")}`);
	} else {
		console.log(`publishing to ${publishRepo} as ${tag} ...`);
		const r = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
		if (r.exitCode !== 0) die(`gh release create failed (${r.exitCode})`);
		console.log(`published. Feed URL (if the repo is public): https://github.com/${publishRepo}/releases/latest/download/${installer ? "latest.json" : "latest-extension.json"}`);
	}
} else {
	console.log(`not published. Upload ${uploads.map((u) => basename(u)).join(" and ")} yourself, or re-run with --publish <owner/repo> (add --dry-run to preview).`);
}
