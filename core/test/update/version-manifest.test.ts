import { describe, expect, test } from "bun:test";
import {
	UpdateError,
	canonicalBytes,
	generateKeyPair,
	publicKeyOf,
	signManifest,
	verifyManifest,
	type UnsignedManifest,
} from "../../src/update/manifest";
import { compareVersions, displayVersion, isNewer, parseVersion } from "../../src/update/version";

describe("version compare", () => {
	test("parses the build stamp", () => {
		expect(parseVersion("0.1.0+b7cd9fc4-20261106")).toMatchObject({ release: [0, 1, 0], commit: "b7cd9fc4", date: 20261106, pre: [] });
		expect(parseVersion("dev")).toBeNull();
		expect(parseVersion("")).toBeNull();
		expect(parseVersion("1.x")).toBeNull();
	});
	test("release part is numeric, not textual", () => {
		expect(isNewer("1.10.0", "1.9.0")).toBe(true);
		expect(isNewer("1.9.0", "1.10.0")).toBe(false);
		expect(isNewer("0.2.0", "0.1.99")).toBe(true);
		expect(compareVersions("1.0", "1.0.0")).toBe(0);
		expect(isNewer("1.0.1", "1.0")).toBe(true);
	});
	test("same release: the +commit-date suffix decides by date, commit ids are not ordered", () => {
		expect(isNewer("0.1.0+aaaaaaaa-20261107", "0.1.0+b7cd9fc4-20261106")).toBe(true);
		expect(isNewer("0.1.0+aaaaaaaa-20261105", "0.1.0+b7cd9fc4-20261106")).toBe(false);
		expect(isNewer("0.1.0+ffffffff-20261106", "0.1.0+00000000-20261106")).toBe(false);
		expect(compareVersions("0.1.0+ffffffff-20261106", "0.1.0+00000000-20261106")).toBe(0);
		expect(isNewer("0.1.0+aaaaaaaa-20261106", "0.1.0")).toBe(true); // a dated build is newer than an undated one
	});
	test("a higher release beats a later date", () => {
		expect(isNewer("0.2.0+aaaaaaaa-20260101", "0.1.0+bbbbbbbb-20261231")).toBe(true);
	});
	test("pre-releases sort below the final release", () => {
		expect(isNewer("0.2.0", "0.2.0-beta.1")).toBe(true);
		expect(isNewer("0.2.0-beta.2", "0.2.0-beta.1")).toBe(true);
		expect(isNewer("0.2.0-beta.10", "0.2.0-beta.9")).toBe(true);
		expect(isNewer("0.2.0-rc.1", "0.2.0-beta.9")).toBe(true);
		expect(isNewer("0.2.0-beta.1", "0.1.9")).toBe(true);
	});
	test("a development build is never offered an update", () => {
		expect(isNewer("9.9.9", "dev")).toBe(false);
		expect(isNewer("dev", "0.1.0")).toBe(false);
		expect(() => compareVersions("dev", "0.1.0")).toThrow();
	});
	test("display", () => {
		expect(displayVersion("0.1.0+b7cd9fc4-20261106")).toBe("0.1.0 (2026-11-06)");
		expect(displayVersion("dev")).toBe("dev");
	});
});

const base: UnsignedManifest = {
	version: "0.2.0+1a2b3c4d-20261201",
	releasedAt: "2026-12-01T09:00:00Z",
	notes: "# 0.2.0\n- faster\n- café ☕",
	url: "https://example.org/rel/zotero-next-0.2.0-setup.exe",
	sha256: "ab".repeat(32),
	size: 1234,
};

describe("manifest signature", () => {
	test("good signature verifies; canonical bytes ignore key order and the signature field", async () => {
		const kp = await generateKeyPair();
		const m = await signManifest(base, kp.privateJwk);
		const ok = await verifyManifest(JSON.parse(JSON.stringify(m)), kp.publicKey);
		expect(ok.version).toBe(base.version);
		const shuffled = Object.fromEntries(Object.entries(m).reverse());
		expect(canonicalBytes(shuffled)).toEqual(canonicalBytes(m));
		expect((await verifyManifest(shuffled, kp.publicKey)).sha256).toBe(base.sha256);
		expect(publicKeyOf(kp.privateJwk)).toBe(kp.publicKey);
		expect(Buffer.from(kp.publicKey, "base64").length).toBe(32);
	});
	test("optional minVersion is signed too", async () => {
		const kp = await generateKeyPair();
		const m = await signManifest({ ...base, minVersion: "0.1.0" }, kp.privateJwk);
		expect((await verifyManifest(m, kp.publicKey)).minVersion).toBe("0.1.0");
		const { minVersion: _drop, ...without } = m;
		await expect(verifyManifest(without, kp.publicKey)).rejects.toMatchObject({ code: "bad-signature" });
	});
	test("a signature from another key is rejected", async () => {
		const a = await generateKeyPair(),
			b = await generateKeyPair();
		const m = await signManifest(base, a.privateJwk);
		await expect(verifyManifest(m, b.publicKey)).rejects.toMatchObject({ code: "bad-signature" });
	});
	test("a tampered field is rejected (url, hash, size, version, notes, date)", async () => {
		const kp = await generateKeyPair();
		const m = await signManifest(base, kp.privateJwk);
		const tampered: Record<string, unknown>[] = [
			{ ...m, url: "https://evil.example/setup.exe" },
			{ ...m, sha256: "cd".repeat(32) },
			{ ...m, size: m.size + 1 },
			{ ...m, version: "9.9.9" },
			{ ...m, notes: m.notes + " " },
			{ ...m, releasedAt: "2027-01-01T00:00:00Z" },
		];
		for (const t of tampered)
			await expect(verifyManifest(t, kp.publicKey)).rejects.toMatchObject({ name: "UpdateError", code: "bad-signature" });
	});
	test("a corrupted or truncated signature is rejected", async () => {
		const kp = await generateKeyPair();
		const m = await signManifest(base, kp.privateJwk);
		const flipped = Buffer.from(m.signature, "base64");
		flipped[0] = flipped[0]! ^ 1;
		await expect(verifyManifest({ ...m, signature: flipped.toString("base64") }, kp.publicKey)).rejects.toBeInstanceOf(UpdateError);
		await expect(verifyManifest({ ...m, signature: m.signature.slice(0, 20) }, kp.publicKey)).rejects.toBeInstanceOf(UpdateError);
	});
	test("missing key, unknown fields, bad values and insecure URLs are refused", async () => {
		const kp = await generateKeyPair();
		const m = await signManifest(base, kp.privateJwk);
		await expect(verifyManifest(m, "")).rejects.toMatchObject({ code: "no-key" });
		await expect(verifyManifest(m, "AAAA")).rejects.toMatchObject({ code: "no-key" });
		await expect(verifyManifest({ ...m, extra: 1 }, kp.publicKey)).rejects.toMatchObject({ code: "malformed" });
		await expect(verifyManifest({ ...m, size: -1 }, kp.publicKey)).rejects.toMatchObject({ code: "malformed" });
		await expect(verifyManifest({ ...m, sha256: "xyz" }, kp.publicKey)).rejects.toMatchObject({ code: "malformed" });
		await expect(verifyManifest("nope", kp.publicKey)).rejects.toMatchObject({ code: "malformed" });
		await expect(signManifest({ ...base, url: "http://example.org/a.exe" }, kp.privateJwk)).rejects.toMatchObject({
			code: "insecure-url",
		});
		// plain http to loopback is allowed (tests, local mirror)
		await expect(signManifest({ ...base, url: "http://127.0.0.1:1234/a.exe" }, kp.privateJwk)).resolves.toBeTruthy();
	});
});
