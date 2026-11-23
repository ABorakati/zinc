// release.ts --extension-zip: the Zinc Connector's signed feed (latest-extension.json). Runs the real script with a throw-away key pair
// in the temp folder (never a real signing key). Run: bun test gpui-ui/scripts/release.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { UpdateError, generateKeyPair, verifyManifest } from "../../core/src/update/manifest";

const script = resolve(import.meta.dir, "release.ts");
let dir: string, keyFile: string, pub: string, zip: string;
const zipBytes = new TextEncoder().encode("PK fake connector zip ".repeat(50));

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "zinc-release-test-"));
	const kp = await generateKeyPair();
	pub = kp.publicKey;
	keyFile = join(dir, "release-key.private.json");
	writeFileSync(keyFile, JSON.stringify(kp.privateJwk));
	zip = join(dir, "Zinc-Connector-0.2.0+abcdef12-20261201.zip");
	writeFileSync(zip, zipBytes);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[], out: string) => {
	mkdirSync(out, { recursive: true });
	return Bun.spawnSync(["bun", script, ...args, "--out", out], {
		env: { ...process.env, ZN_UPDATE_KEY: keyFile, ZN_UPDATE_PUBKEY: pub },
		stdout: "pipe",
		stderr: "pipe",
	});
};

/** A package folder with a version.txt and an exe, and (unless `record` is false) the record of a UI run that passed on it. */
const testedPackage = (name: string, version: string, o: { record?: boolean; recordVersion?: string; rebuilt?: boolean } = {}) => {
	const base = join(dir, name);
	const app = join(base, "zotero-next-gpui");
	mkdirSync(app, { recursive: true });
	writeFileSync(join(app, "version.txt"), version);
	writeFileSync(join(app, "zotero-next-gpui.exe"), "the app");
	const record = join(base, "ui-pass.json");
	if (o.record !== false) {
		const sha = createHash("sha256").update("the app").digest("hex");
		writeFileSync(record, JSON.stringify({ version: o.recordVersion ?? version, exeSha256: sha, passed: 1, knownBugs: 0, inProcess: 0 }));
	}
	if (o.rebuilt) writeFileSync(join(app, "zotero-next-gpui.exe"), "the app, built again");
	return record;
};

describe("release.ts --extension-zip", () => {
	test("writes a signed latest-extension.json, and no latest.json without an installer", async () => {
		const out = join(dir, "out1");
		const r = run(
			["--extension-zip", zip, "--notes", "Fixes the popup.", "--extension-url", "https://example.com/Zinc-Connector-0.2.0.zip"],
			out,
		);
		expect(r.exitCode).toBe(0);
		expect(existsSync(join(out, "latest.json"))).toBe(false);
		const feed = JSON.parse(readFileSync(join(out, "latest-extension.json"), "utf8"));
		expect(feed).toMatchObject({
			version: "0.2.0+abcdef12-20261201",
			notes: "Fixes the popup.",
			url: "https://example.com/Zinc-Connector-0.2.0.zip",
			size: zipBytes.length,
		});
		expect(feed.sha256).toBe(createHash("sha256").update(zipBytes).digest("hex"));
		expect(Object.keys(feed).sort()).toEqual(["notes", "releasedAt", "sha256", "signature", "size", "url", "version"]);
		expect((await verifyManifest(feed, pub)).version).toBe(feed.version);
	});

	test("a tampered feed fails verification, and so does another key", async () => {
		const feed = JSON.parse(readFileSync(join(dir, "out1", "latest-extension.json"), "utf8"));
		for (const change of [
			{ url: "https://evil.example/Zinc-Connector.zip" },
			{ version: "9.9.9" },
			{ sha256: "0".repeat(64) },
			{ notes: "x" },
		]) {
			await expect(verifyManifest({ ...feed, ...change }, pub)).rejects.toMatchObject({ code: "bad-signature" });
		}
		const other = await generateKeyPair();
		await expect(verifyManifest(feed, other.publicKey)).rejects.toBeInstanceOf(UpdateError);
	});

	test("with an installer too, both feeds are written; --publish --dry-run lists both uploads", () => {
		const out = join(dir, "out2");
		const exe = join(dir, "Zinc-Setup-0.2.0-abcdef12-20261201.exe");
		writeFileSync(exe, "installer");
		const pass = testedPackage("pkg-ok", "0.2.0+abcdef12-20261201");
		const r = run(["--installer", exe, "--extension-zip", zip, "--publish", "o/r", "--dry-run", "--ui-pass", pass], out);
		expect(r.exitCode).toBe(0);
		expect(existsSync(join(out, "latest.json"))).toBe(true);
		const feed = JSON.parse(readFileSync(join(out, "latest-extension.json"), "utf8"));
		expect(feed.url).toBe(
			"https://github.com/o/r/releases/download/v0.2.0%2Babcdef12-20261201/Zinc-Connector-0.2.0%2Babcdef12-20261201.zip",
		);
		const text = r.stdout.toString();
		expect(text).toContain("latest-extension.json");
		expect(text).toContain("Zinc-Connector-0.2.0+abcdef12-20261201.zip");
	});

	test("refuses a zip without a URL", () => {
		const r = run(["--extension-zip", zip], join(dir, "out3"));
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString()).toContain("--extension-url");
	});
});

describe("release.ts UI gate", () => {
	const version = "0.2.0+abcdef12-20261201";
	const installer = () => {
		const exe = join(dir, `Zinc-Setup-0.2.0-abcdef12-20261201.exe`);
		writeFileSync(exe, "installer");
		return exe;
	};
	const release = (pass: string, ...more: string[]) =>
		run(["--installer", installer(), "--url", "https://example.com/setup.exe", "--ui-pass", pass, ...more], join(dir, `gate-${Math.random()}`));

	test("an installer whose package passed the UI harness is released", () => {
		const r = release(testedPackage("gate-ok", version));
		expect(r.exitCode).toBe(0);
		expect(r.stdout.toString()).toContain("the UI harness passed");
	});

	test("refused without a recorded run, for another version, and when the package was built again", () => {
		for (const [name, o, says] of [
			["gate-none", { record: false }, "no passing UI run"],
			["gate-old", { recordVersion: "0.1.9+00000000-20261101" }, "not 0.2.0"],
			["gate-rebuilt", { rebuilt: true }, "built again"],
		] as const) {
			const r = release(testedPackage(name, version, o));
			expect(r.exitCode).toBe(1);
			expect(r.stderr.toString()).toContain(says);
		}
	});

	test("--skip-ui-gate releases anyway and says so", () => {
		const r = release(testedPackage("gate-skip", version, { record: false }), "--skip-ui-gate");
		expect(r.exitCode).toBe(0);
		expect(r.stderr.toString()).toContain("without a passing UI run");
	});
});

describe("release.ts --keygen", () => {
	const keygen = (folder: string) =>
		Bun.spawnSync(["bun", script, "--keygen", folder], { env: { ...process.env, ZN_UPDATE_KEY: "" }, stdout: "pipe", stderr: "pipe" });

	test("writes a key pair outside the repository and refuses to overwrite it", () => {
		const folder = join(dir, "keys");
		const r = keygen(folder);
		expect(r.exitCode).toBe(0);
		expect(existsSync(join(folder, "release-key.private.json"))).toBe(true);
		expect(existsSync(join(folder, "release-key.public.txt"))).toBe(true);
		expect(keygen(folder).exitCode).toBe(1);
	});

	// the mode only means something on Unix; on Windows the file takes the folder's access rules
	test.skipIf(process.platform === "win32")("the private key is readable by its owner only", () => {
		const folder = join(dir, "keys-mode");
		expect(keygen(folder).exitCode).toBe(0);
		expect(statSync(join(folder, "release-key.private.json")).mode & 0o777).toBe(0o600);
	});

	test("refuses a folder inside the repository, and creates nothing there", () => {
		const folder = join(resolve(import.meta.dir, "..", ".."), "gpui-ui", "out", "zinc-keygen-refused-" + process.pid);
		const r = keygen(folder);
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString()).toContain("inside the repository");
		expect(existsSync(folder)).toBe(false);
	});
});
