// release.ts --extension-zip: the Zinc Connector's signed feed (latest-extension.json). Runs the real script with a throw-away key pair
// in the temp folder (never a real signing key). Run: bun test gpui-ui/scripts/release.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		const r = run(["--installer", exe, "--extension-zip", zip, "--publish", "o/r", "--dry-run"], out);
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
