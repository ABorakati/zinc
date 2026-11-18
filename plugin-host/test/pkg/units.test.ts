import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WitError } from "../../src/imports/registry";
import { createLayout, assertSafeId } from "../../src/package/layout";
import { CwasmCache, sanitizeCacheKey } from "../../src/package/cwasm-cache";
import { decodeWire, decodeWireResult, encodeWire, encodeWireResult } from "../../src/transport-wasmtime";
import { semverCompare, apiCompatible } from "../../src/package/semver";
import { badEntryName, readZip, writeZip, ZipError } from "../../src/package/zip";
import { validateManifest } from "../../src/package/validate";
import { PrefStore, PrefError } from "../../src/package/prefs-store";
import { SecretStore, fileKeyProvider, windowsKeyProvider, MAX_SECRET_BYTES } from "../../src/package/secrets-store";
import { parseFluent, formatMessage } from "../../src/package/fluent";
import { LogRing } from "../../src/package/log-ring";
import { TimerService } from "../../src/package/timers";
import { capitalizeTitle, cleanDOI, cleanISBN, cleanISSN, hashBytes, htmlToText, textToHtml } from "../../src/package/util-fns";
import { GrantStore, listPermissions, permissionState } from "../../src/permissions/store";
import { capabilityTier, isKnownCapability, KNOWN_CAPABILITIES } from "../../src/permissions/ids";
import { describePermissions, isPrivateHost, netHostTier, permissionTier } from "../../src/permissions/risk";
import { matchNetHost, requireNetHost, requirePermission } from "../../src/permissions/check";
import { PermissionService } from "../../src/permissions/service";
import { rmTree, scratch } from "./helpers";

const ctxOf = (caps: string[], hosts: string[] = []) => {
	const grants = { capabilities: caps, netHosts: hosts };
	return { grants, has: (p: string) => grants.capabilities.includes(p) };
};

describe("versions", () => {
	test("semverCompare", () => {
		expect(semverCompare("1.2.0", "1.10.0")).toBe(-1);
		expect(semverCompare("2.0.0", "2.0")).toBe(0);
		expect(semverCompare("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
		expect(semverCompare("1.0.0", "1.0.0-rc.1")).toBe(1);
		expect(semverCompare("1.0.0+build5", "1.0.0")).toBe(0);
	});
	test("api version rule: same major, minor >= required; equal minor before 1.0", () => {
		expect(apiCompatible("0.1", "0.1.0")).toBe(true);
		expect(apiCompatible("0.1", "0.2.0")).toBe(false);
		expect(apiCompatible("1.2", "1.3.0")).toBe(true);
		expect(apiCompatible("1.3", "1.2.0")).toBe(false);
		expect(apiCompatible("1.0", "2.0.0")).toBe(false);
	});
});

describe("zip", () => {
	test("round trip, stored and deflated", () => {
		const big = new TextEncoder().encode("hello ".repeat(1000));
		const zip = writeZip([
			{ name: "manifest.json", data: new TextEncoder().encode("{}") },
			{ name: "locale/en-US/a.ftl", data: big },
			{ name: "x.bin", data: new Uint8Array([1, 2, 3]), store: true },
		]);
		const files = readZip(zip);
		expect(files.map((f) => f.name)).toEqual(["manifest.json", "locale/en-US/a.ftl", "x.bin"]);
		expect(files[1].data).toEqual(big);
		expect(zip.length).toBeLessThan(big.length); // deflated
	});

	test("entry names that would escape or confuse a file system are refused", () => {
		for (const bad of ["../x", "a/../../x", "/abs", "C:/x", "a\\b", "con", "a/NUL.txt", "a/b ", "a//b", "a/./b", "x:y"]) {
			expect(badEntryName(bad)).toBeDefined();
		}
		for (const ok of ["a.txt", "locale/fr/x.ftl", "icons/", "a b/c d.png"]) expect(badEntryName(ok)).toBeUndefined();
		// a hostile archive: patch the name of an innocent one ("aa/x" -> "../x", same length) in both headers
		const evil = writeZip([{ name: "aa/x", data: new Uint8Array([1]), store: true }]).slice();
		const needle = new TextEncoder().encode("aa/x");
		let hits = 0;
		for (let i = 0; i + 4 <= evil.length; i++) {
			if (needle.every((b, j) => evil[i + j] === b)) {
				evil.set(new TextEncoder().encode("../x"), i);
				hits++;
			}
		}
		expect(hits).toBe(2);
		expect(() => readZip(evil)).toThrow(/unsafe entry name/);
	});

	test("corruption, size caps, duplicates", () => {
		const zip = writeZip([{ name: "a.txt", data: new TextEncoder().encode("hello hello hello hello"), store: true }]);
		const flipped = zip.slice();
		flipped[30 + "a.txt".length] ^= 1; // first data byte
		expect(() => readZip(flipped)).toThrow(/CRC/);
		expect(() => readZip(new Uint8Array(10))).toThrow(ZipError);
		expect(() => readZip(new TextEncoder().encode("not a zip at all, just text padding.."))).toThrow(/not a zip/);
		const big = writeZip([{ name: "a.bin", data: new Uint8Array(100_000) }]);
		expect(() => readZip(big, { maxEntryBytes: 1000 })).toThrow(/too large/);
		expect(() => readZip(big, { maxTotalBytes: 1000 })).toThrow(/expands/);
		expect(() => readZip(writeZip([{ name: "a", data: new Uint8Array(3) }, { name: "A", data: new Uint8Array(3) }]))).toThrow(/duplicate/);
	});
});

describe("manifest validation", () => {
	const good = () => ({
		manifest_version: 1,
		id: "x@example.org",
		name: "X",
		version: "1.0.0",
		zinc: { api_version: "0.1" },
		main: { wasm: "plugin.wasm" },
		permissions: { capabilities: ["library.read"], net: { hosts: ["https://api.example.org", "*.example.com"] } },
		default_prefs: { a: true, b: 3, c: "t" },
	});
	test("a good manifest passes", () => expect(validateManifest(good())).toEqual([]));
	test("the e2e fixture manifest passes", () => {
		expect(validateManifest(JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "e2e-js", "manifest.json"), "utf8")))).toEqual([]);
	});
	const bad = (mut: (m: any) => void) => {
		const m: any = good();
		mut(m);
		return validateManifest(m);
	};
	test("rejections", () => {
		expect(bad((m) => delete m.zinc)).toEqual(expect.arrayContaining([expect.stringContaining('missing "zinc"')]));
		expect(bad((m) => (m.id = "no-at-sign"))[0]).toContain("/id");
		expect(bad((m) => (m.version = "1.0"))[0]).toContain("/version");
		expect(bad((m) => (m.extra = 1))[0]).toContain("unknown property");
		expect(bad((m) => (m.main.wasm = "../evil.wasm"))[0]).toContain("/main/wasm");
		expect(bad((m) => (m.main.wasm = "a\\b.wasm"))[0]).toContain("/main/wasm");
		expect(bad((m) => (m.permissions.capabilities = ["library.read", "made.up"]))[0]).toContain("unknown permission");
		expect(bad((m) => (m.permissions.capabilities = ["annotations:read"]))[0]).toContain("/permissions/capabilities/0");
		expect(bad((m) => (m.permissions.net.hosts = ["https://a.com/path"]))[0]).toContain("net/hosts");
		expect(bad((m) => (m.default_prefs.b = 1.5))[0]).toBeDefined();
		expect(bad((m) => (m.default_prefs["bad key"] = true))[0]).toContain("name");
		expect(bad((m) => (m.optional_permissions = { capabilities: ["library.read"] }))[0]).toContain("both required and optional");
		expect(bad((m) => (m.update_url = "http://x.test/u.json"))[0]).toContain("update_url");
		expect(bad((m) => (m.permissions.shell = { schemes: ["file"] }))[0]).toBeDefined();
		expect(bad((m) => (m.main.sha256 = "ABC"))[0]).toContain("sha256");
	});
});

describe("permissions", () => {
	test("ids and tiers come from the schema (37 known)", () => {
		expect(KNOWN_CAPABILITIES.length).toBe(37);
		expect(capabilityTier("library.read")).toBe("low");
		expect(capabilityTier("library.write")).toBe("medium");
		expect(capabilityTier("clipboard.read")).toBe("high");
		expect(isKnownCapability("nope.nope")).toBe(false);
	});
	test("net host risk", () => {
		expect(netHostTier("https://api.openalex.org")).toBe("medium");
		expect(netHostTier("*.crossref.org")).toBe("medium");
		expect(netHostTier("*")).toBe("high");
		expect(netHostTier("http://localhost:11434")).toBe("high");
		expect(netHostTier("192.168.1.5")).toBe("high");
		expect(permissionTier("net.hosts:*")).toBe("high");
		expect(permissionTier("shell.open-file")).toBe("high");
		for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.9", "169.254.1.1", "::1", "[fe80::1]", "foo.localhost"]) expect(isPrivateHost(h)).toBe(true);
		for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "2001:db8::1"]) expect(isPrivateHost(h)).toBe(false);
	});
	test("describePermissions groups by tier with reasons", () => {
		const m: any = { id: "a@b.c", permissions: { capabilities: ["library.read", "library.write", "clipboard.read"], net: { hosts: ["*", "https://x.org"] } }, optional_permissions: { capabilities: ["shell.reveal"] }, permission_reasons: { "library.write": "writes", "net.hosts": "fetches" } };
		const g = describePermissions(m);
		expect(g.map((x) => x.tier)).toEqual(["low", "medium", "high"]);
		expect(g[0].items.map((i) => [i.id, i.optional])).toEqual([["library.read", false], ["shell.reveal", true]]);
		expect(g[1].items.map((i) => i.id)).toEqual(["library.write", "net.hosts:https://x.org"]);
		expect(g[1].items[0].reason).toBe("writes");
		expect(g[1].items[1].reason).toBe("fetches");
		expect(g[2].items.map((i) => i.id)).toEqual(["clipboard.read", "net.hosts:*"]);
	});
	test("requirePermission: denied, granted, unknown id is a bug", () => {
		const ctx = ctxOf(["library.read"]);
		expect(() => requirePermission(ctx, "library.read")).not.toThrow();
		try {
			requirePermission(ctx, "library.write");
			throw new Error("should throw");
		} catch (e) {
			expect(e).toBeInstanceOf(WitError);
			expect((e as WitError).payload).toEqual({ tag: "permission-denied", val: "library.write" });
		}
		expect(() => requirePermission(ctx, "typo.read")).toThrow(/unknown permission id/);
		ctx.grants.capabilities.push("library.write"); // live
		expect(() => requirePermission(ctx, "library.write")).not.toThrow();
	});
	test("matchNetHost: scheme, subdomain, port, wildcard, private hosts", () => {
		const hosts = ["https://api.example.org", "*.cdn.example.com", "http://localhost:11434", "http://plain.example.net"];
		expect(matchNetHost(hosts, "https://api.example.org/v1?q=1")?.entry).toBe("https://api.example.org");
		expect(matchNetHost(hosts, "http://api.example.org/")).toBeUndefined(); // http not listed
		expect(matchNetHost(hosts, "https://api.example.org:8443/")).toBeUndefined(); // port
		expect(matchNetHost(hosts, "https://a.b.cdn.example.com/x")?.entry).toBe("*.cdn.example.com");
		expect(matchNetHost(hosts, "https://cdn.example.com/x")).toBeUndefined(); // bare domain is not a subdomain
		expect(matchNetHost(hosts, "http://localhost:11434/api")).toEqual({ entry: "http://localhost:11434", privateHost: true });
		expect(matchNetHost(hosts, "http://localhost:3000/")).toBeUndefined();
		expect(matchNetHost(hosts, "http://plain.example.net/")?.entry).toBe("http://plain.example.net");
		expect(matchNetHost(["*"], "https://anything.example/")?.entry).toBe("*");
		expect(matchNetHost(["*"], "http://anything.example/")).toBeUndefined();
		expect(matchNetHost(["*"], "https://127.0.0.1/")).toBeUndefined(); // * never covers private hosts
		expect(matchNetHost(["*"], "https://[::1]/")).toBeUndefined();
		expect(matchNetHost(["*"], "ftp://x.org/")).toBeUndefined();
		expect(() => requireNetHost(ctxOf([], ["https://a.org"]), "https://b.org/")).toThrow(WitError);
	});
	test("permissionState and listPermissions", () => {
		const m: any = { id: "a@b.c", permissions: { capabilities: ["library.read", "prefs.app-read"], net: { hosts: ["https://x.org"] } }, optional_permissions: { capabilities: ["library.write"], net: { hosts: ["https://y.org"] } } };
		const g = { capabilities: ["library.read"], netHosts: ["https://x.org"] };
		expect(permissionState(m, g, "library.read")).toBe("granted");
		expect(permissionState(m, g, "prefs.app-read")).toBe("denied");
		expect(permissionState(m, g, "library.write")).toBe("optional");
		expect(permissionState(m, g, "library.erase")).toBe("undeclared");
		expect(permissionState(m, g, "net.hosts")).toBe("granted");
		expect(permissionState(m, g, "net.hosts:https://x.org")).toBe("granted");
		expect(permissionState(m, g, "net.hosts:https://y.org")).toBe("optional");
		expect(permissionState(m, { capabilities: [], netHosts: [] }, "net.hosts")).toBe("denied");
		expect(listPermissions(m, g).map(([k, s]) => `${k}=${s}`)).toEqual(["library.read=granted", "prefs.app-read=denied", "net.hosts:https://x.org=granted", "library.write=optional", "net.hosts:https://y.org=optional"]);
	});
	test("GrantStore persists, and grantsFor drops what the manifest no longer declares", () => {
		const root = scratch("grants");
		try {
			const file = join(root, "grants.json");
			const m: any = { id: "a@b.c", permissions: { capabilities: ["library.read"], net: { hosts: ["https://x.org"] } }, optional_permissions: { capabilities: ["library.write"] } };
			const s = new GrantStore(file);
			expect(s.grantsFor(m)).toEqual({ capabilities: [], netHosts: [] }); // no record: nothing
			s.set("a@b.c", { granted: ["library.read", "net.hosts:https://x.org", "library.write", "library.erase"], seen: [] });
			expect(s.grantsFor(m)).toEqual({ capabilities: ["library.read", "library.write"], netHosts: ["https://x.org"] }); // erase is not declared
			s.revoke("a@b.c", "library.write");
			expect(new GrantStore(file).grantsFor(m).capabilities).toEqual(["library.read"]);
		} finally {
			rmTree(root);
		}
	});
	test("PermissionService.request", async () => {
		const m: any = { id: "a@b.c", name: "A", permissions: { capabilities: ["library.read", "prefs.app-read"] }, optional_permissions: { capabilities: ["library.write"] } };
		const granted: string[] = [];
		const asked: any[] = [];
		const svc = new PermissionService({ grant: async (_id, p) => void granted.push(p), resolveReason: (_id, r: any) => r.val, prompt: (r) => (asked.push(r), r.permission === "library.write") });
		const g = { capabilities: ["library.read"], netHosts: [] };
		expect(await svc.request(m, g, "library.read", { tag: "plain", val: "x" })).toBe(true); // already granted: no prompt
		expect(asked.length).toBe(0);
		await expect(svc.request(m, g, "library.erase", { tag: "plain", val: "x" })).rejects.toMatchObject({ payload: { tag: "permission-denied" } });
		await expect(svc.request(m, g, "prefs.app-read", { tag: "plain", val: "x" })).rejects.toMatchObject({ payload: { tag: "invalid-argument" } });
		expect(await svc.request(m, g, "library.write", { tag: "plain", val: "because" })).toBe(true);
		expect(asked[0]).toMatchObject({ pluginId: "a@b.c", permission: "library.write", tier: "medium", reason: "because" });
		expect(granted).toEqual(["library.write"]);
		svc.canPrompt = () => false;
		await expect(svc.request(m, g, "library.write", { tag: "plain", val: "x" })).rejects.toMatchObject({ payload: { tag: "permission-denied" } });
		const none = new PermissionService({ grant: async () => {}, resolveReason: () => "" });
		await expect(none.request(m, g, "library.write", { tag: "plain", val: "x" })).rejects.toMatchObject({ payload: { tag: "unavailable" } });
	});
});

describe("layout", () => {
	test("ids are checked at every path build", () => {
		const l = createLayout("/r");
		expect(l.installed("a@b.c")).toContain("installed");
		expect(l.cacheRoot).toContain("cache");
		for (const bad of ["..", "../x@y.z", "a/b@c.d", "a\\b@c.d", "x"]) expect(() => assertSafeId(bad)).toThrow();
		expect(() => l.data("..")).toThrow();
	});
});

describe("wasmtime wire codec & cwasm cache", () => {
	test("encodeWire and decodeWire round-trip bigint, Uint8Array, and null <-> undefined", () => {
		const raw = {
			n: 1234567890123456789n,
			neg: -42n,
			bytes: new Uint8Array([1, 2, 3, 255]),
			empty: new Uint8Array(0),
			opt: undefined,
			arr: [1n, undefined, new Uint8Array([9])],
			res: { "$zinc-resource": "body-reader", id: -1 },
		};
		const encoded = JSON.parse(JSON.stringify(encodeWire(raw)));
		expect(encoded.n).toEqual({ $big: "1234567890123456789" });
		expect(encoded.neg).toEqual({ $big: "-42" });
		expect(encoded.bytes).toEqual({ $bytes: "AQID/w==" });
		expect(encoded.empty).toEqual({ $bytes: "" });
		expect("opt" in encoded).toBe(false);
		expect(encoded.arr[1]).toBeNull();

		const decoded = decodeWire({ ...encoded, opt: null }) as any;
		expect(decoded.n).toBe(1234567890123456789n);
		expect(decoded.neg).toBe(-42n);
		expect(decoded.bytes).toBeInstanceOf(Uint8Array);
		expect([...decoded.bytes]).toEqual([1, 2, 3, 255]);
		expect(decoded.empty).toBeInstanceOf(Uint8Array);
		expect(decoded.empty.length).toBe(0);
		expect(decoded.opt).toBeUndefined();
		expect(decoded.arr).toEqual([1n, undefined, new Uint8Array([9])]);
		expect(decoded.res).toEqual({ "$zinc-resource": "body-reader", id: -1 });

		expect(decodeWireResult(JSON.parse(JSON.stringify(encodeWireResult({ ok: true, value: undefined }))))).toEqual({ ok: true, value: undefined });
		expect(
			decodeWireResult(JSON.parse(JSON.stringify(encodeWireResult({ ok: false, error: { kind: "wit", payload: { tag: "cancelled", val: undefined } } })))),
		).toEqual({ ok: false, error: { kind: "wit", payload: { tag: "cancelled" } } });
	});

	test("CwasmCache: cacheKey sanitization, getIfFresh, and prune across version bumps", () => {
		const root = scratch("cwasm");
		try {
			const layout = createLayout(root);
			expect(sanitizeCacheKey("zhw-0.1.0/wt:50")).toBe("zhw-0.1.0_wt_50");
			expect(sanitizeCacheKey("..")).toBe("default");

			const c1 = new CwasmCache({ cacheRoot: layout.cacheRoot, zhwVersionOverride: "zhw-v1" });
			expect(c1.cacheKey()).toBe("zhw-v1");
			expect(c1.getIfFresh("aaaa")).toBeUndefined();

			mkdirSync(join(layout.cacheRoot, "zhw-v1"), { recursive: true });
			writeFileSync(join(layout.cacheRoot, "zhw-v1", "aaaa.cwasm"), "compiled-aaaa");
			writeFileSync(join(layout.cacheRoot, "zhw-v1", "dead.cwasm"), "compiled-dead");
			expect(c1.getIfFresh("aaaa")).toBe(join(layout.cacheRoot, "zhw-v1", "aaaa.cwasm"));

			c1.prune(new Set(["aaaa"]));
			expect(readdirSync(join(layout.cacheRoot, "zhw-v1"))).toEqual(["aaaa.cwasm"]);

			// Simulate a zhw upgrade: zhw-v1 folder is pruned, zhw-v2 is active
			const c2 = new CwasmCache({ cacheRoot: layout.cacheRoot, zhwVersionOverride: "zhw-v2" });
			mkdirSync(join(layout.cacheRoot, "zhw-v2"), { recursive: true });
			writeFileSync(join(layout.cacheRoot, "zhw-v2", "aaaa.cwasm"), "compiled-v2");
			c2.prune(new Set(["aaaa"]));
			expect(readdirSync(layout.cacheRoot)).toEqual(["zhw-v2"]);
			expect(c2.getIfFresh("aaaa")).toBe(join(layout.cacheRoot, "zhw-v2", "aaaa.cwasm"));
		} finally {
			rmTree(root);
		}
	});
});

describe("prefs store", () => {
	const mk = () => {
		const root = scratch("prefs");
		const layout = createLayout(root);
		const store = new PrefStore(layout, () => ({ greeting: "hello", limit: 10, on: true }));
		return { root, layout, store };
	};
	test("defaults, user values, types, observers, persistence", () => {
		const { root, layout, store } = mk();
		try {
			const id = "p@x.test";
			const changes: string[] = [];
			store.onChange((c) => changes.push(`${c.key}=${c.value}`));
			expect(store.get(id, "greeting")).toBe("hello");
			expect(store.hasUserValue(id, "greeting")).toBe(false);
			store.set(id, "greeting", "hi");
			expect(store.get(id, "greeting")).toBe("hi");
			expect(store.hasUserValue(id, "greeting")).toBe(true);
			expect(() => store.set(id, "greeting", 5)).toThrow(PrefError); // type of the default
			expect(() => store.set(id, "limit", 2 ** 31)).toThrow(/32-bit/);
			expect(() => store.set(id, "limit", 1.5)).toThrow(/32-bit/);
			expect(() => store.set(id, "bad key", "x")).toThrow(/bad pref key/);
			expect(() => store.set(id, "t", "x".repeat(65 * 1024))).toThrow(/64 KiB/);
			// all or none
			expect(() => store.setMany(id, [["limit", 20], ["on", "no" as never]])).toThrow(PrefError);
			expect(store.get(id, "limit")).toBe(10);
			store.setMany(id, [["limit", 20], ["free", "any type"], ["greeting", "hi"]]); // "greeting" unchanged: no notification
			expect(changes).toEqual(["greeting=hi", "limit=20", "free=any type"]);
			expect(store.getAll(id).map((e) => `${e.key}:${e.userSet}`)).toEqual(["free:true", "greeting:true", "limit:true", "on:false"]);
			expect(store.getAll(id, "g").map((e) => e.key)).toEqual(["greeting"]);
			changes.length = 0;
			store.clear(id, "greeting");
			expect(store.get(id, "greeting")).toBe("hello");
			store.clear(id, "free");
			expect(store.get(id, "free")).toBeUndefined();
			expect(changes).toEqual(["greeting=hello", "free=undefined"]);
			store.reset(id, undefined, ["limit"]);
			expect(store.get(id, "limit")).toBe(20);
			// persistence: a new store reads the file; defaults are never written
			const again = new PrefStore(layout, () => ({ greeting: "hello", limit: 10, on: true }));
			expect(JSON.parse(readFileSync(layout.prefsFile(id), "utf8"))).toEqual({ limit: 20 });
			expect(again.get(id, "limit")).toBe(20);
			expect(again.get(id, "on")).toBe(true);
			store.deleteAll(id);
			expect(existsSync(layout.prefsFile(id))).toBe(false);
		} finally {
			rmTree(root);
		}
	});
	test("a plugin cannot reach another plugin's prefs", () => {
		const { root, store } = mk();
		try {
			store.set("a@x.test", "free", "A");
			expect(store.get("b@x.test", "free")).toBeUndefined();
		} finally {
			rmTree(root);
		}
	});
	test("1000 keys", () => {
		const { root, store } = mk();
		try {
			store.setMany("a@x.test", Array.from({ length: 1000 }, (_, i) => [`k${i}`, i] as [string, number]));
			expect(() => store.set("a@x.test", "one-more", 1)).toThrow(/1000/);
			store.set("a@x.test", "k5", 6); // an existing key is fine
		} finally {
			rmTree(root);
		}
	});
});

describe("secrets store", () => {
	test("encrypts at rest, namespaced per plugin, limits, delete", () => {
		const root = scratch("secrets");
		try {
			const layout = createLayout(root);
			const s = new SecretStore(layout, fileKeyProvider(layout.secretsDir));
			s.set("a@x.test", "token", "s3cret-é");
			expect(s.get("a@x.test", "token")).toBe("s3cret-é");
			expect(s.get("b@x.test", "token")).toBeUndefined();
			expect(readFileSync(layout.secretsFile("a@x.test"), "utf8")).not.toContain("s3cret");
			expect(s.listNames("a@x.test")).toEqual(["token"]);
			// a value moved to another name does not decrypt (authenticated data)
			const f = JSON.parse(readFileSync(layout.secretsFile("a@x.test"), "utf8"));
			f.items.other = f.items.token;
			writeFileSync(layout.secretsFile("a@x.test"), JSON.stringify(f));
			expect(() => s.get("a@x.test", "other")).toThrow(/cannot be decrypted/);
			expect(() => s.set("a@x.test", "big", "y".repeat(MAX_SECRET_BYTES + 1))).toThrow(/at most/);
			expect(() => s.set("a@x.test", "bad name", "y")).toThrow(/bad secret name/);
			s.delete("a@x.test", "token");
			expect(s.get("a@x.test", "token")).toBeUndefined();
			s.deleteAll("a@x.test");
			expect(existsSync(layout.secretsFile("a@x.test"))).toBe(false);
			// 64 names
			for (let i = 0; i < 64; i++) s.set("c@x.test", `n${i}`, "v");
			expect(() => s.set("c@x.test", "n64", "v")).toThrow(/at most 64/);
			// a second store with the same key file reads the same data
			expect(new SecretStore(layout, fileKeyProvider(layout.secretsDir)).get("c@x.test", "n3")).toBe("v");
		} finally {
			rmTree(root);
		}
	});
	test.if(process.platform === "win32")("Windows: the master key is wrapped with DPAPI and survives a restart", () => {
		const root = scratch("dpapi");
		try {
			const layout = createLayout(root);
			const a = windowsKeyProvider(layout.secretsDir);
			const k1 = a.key();
			expect(k1.length).toBe(32);
			const wrapped = readFileSync(join(layout.secretsDir, "master.key.dpapi"));
			expect(wrapped.includes(Buffer.from(k1))).toBe(false);
			expect(Buffer.from(windowsKeyProvider(layout.secretsDir).key()).equals(Buffer.from(k1))).toBe(true);
			const s = new SecretStore(layout, a);
			s.set("a@x.test", "t", "v");
			expect(s.get("a@x.test", "t")).toBe("v");
		} finally {
			rmTree(root);
		}
	});
});

describe("fluent", () => {
	const src = [
		"# comment",
		"hello = Hello, { $name }!",
		"items =",
		"    { $count ->",
		"        [0] No items",
		"        [one] One item",
		"       *[other] { $count } items",
		"    }",
		"multi =",
		"    first",
		"    second",
		"-brand = Zinc",
		"about = About { -brand }",
		'lit = { "{" }braces{ "}" } and { 42 }',
		"ref = See { hello }",
		"button = Save",
		"    .tooltip = Save the file",
		"num = { NUMBER($n, minimumFractionDigits: 2) }",
		"broken = { $x",
		"after = still parsed",
	].join("\n");
	const res = parseFluent(src);
	const fmt = (id: string, args: Record<string, any> = {}, locale = "en-US") => formatMessage({ locale, lookup: (i) => res.messages.get(i), term: (i) => res.terms.get(i) }, id, args);
	test("messages, placeables, selects, terms, attributes, functions", () => {
		expect(fmt("hello", { name: "Ada" })).toBe("Hello, Ada!");
		expect(fmt("items", { count: 0 })).toBe("No items");
		expect(fmt("items", { count: 1 })).toBe("One item");
		expect(fmt("items", { count: 5 })).toBe("5 items");
		expect(fmt("multi")).toBe("first\nsecond");
		expect(fmt("about")).toBe("About Zinc");
		expect(fmt("lit")).toBe("{braces} and 42");
		expect(fmt("ref", { name: "B" })).toBe("See Hello, B!");
		expect(fmt("button")).toBe("Save");
		expect(fmt("button.tooltip")).toBe("Save the file");
		expect(fmt("num", { n: 3 })).toBe("3.00");
		expect(fmt("hello")).toBe("Hello, {$name}!"); // missing argument
		expect(fmt("nope")).toBeUndefined();
		expect(fmt("after")).toBe("still parsed"); // the broken entry before it did not stop the parse
		expect(res.errors.some((e) => e.startsWith("broken"))).toBe(true);
	});
	test("plural categories of another language", () => {
		const r = parseFluent("n =\n    { $c ->\n        [one] un\n        [many] beaucoup\n       *[other] autres\n    }");
		const f = (c: number) => formatMessage({ locale: "fr", lookup: (i) => r.messages.get(i), term: () => undefined }, "n", { c });
		expect(f(1)).toBe("un");
		expect(f(3)).toBe("autres");
	});
});

describe("log ring", () => {
	test("limits: 8 KiB a line, 200 lines a second, debug only when enabled", () => {
		const ring = new LogRing(10);
		const debugEvents: boolean[] = [];
		ring.onDebugChange = (v) => debugEvents.push(v);
		expect(ring.accept("p", "debug", "x")).toBeUndefined();
		ring.debugEnabled = true;
		ring.debugEnabled = true; // idempotent: no duplicate callback
		expect(debugEvents).toEqual([true]);
		expect(ring.accept("p", "debug", "x")).toBe("x");
		const long = ring.accept("p", "info", "é".repeat(10000))!;
		expect(Buffer.byteLength(long)).toBeLessThan(9000);
		expect(long.endsWith("[truncated]")).toBe(true);
		const t = 1_000_000;
		let kept = 0;
		for (let i = 0; i < 500; i++) if (ring.accept("q", "info", "l", t + i) !== undefined) kept++;
		expect(kept).toBe(200);
		expect(ring.droppedCount("q")).toBe(300);
		expect(ring.accept("q", "info", "l", t + 1000)).toBe("l"); // a new second
		for (let i = 0; i < 20; i++) ring.push("p", "info", `m${i}`);
		expect(ring.recent().length).toBe(10);
		ring.recordError("p", "boom", "stack");
		expect(ring.lastError("p")?.message).toBe("boom");
	});
});

describe("timers", () => {
	test("timeout, interval, clear, limit, clearAll, minimum interval", async () => {
		const fired: string[] = [];
		const svc = new TimerService({ deliver: async (p, _i, _f, a) => void fired.push(`${p}:${(a as unknown[]).join("/")}`), maxTimers: 3 });
		const t = svc.setTimeout("p", 5);
		const i = svc.setInterval("p", 1); // raised to 10 ms
		const c = svc.setTimeout("p", 5);
		expect(() => svc.setTimeout("p", 5)).toThrow(WitError);
		svc.setTimeout("other", 5);
		svc.clear("p", c);
		await Bun.sleep(80);
		expect(fired).toContain(`p:${t}/timeout`);
		expect(fired).not.toContain(`p:${c}/timeout`);
		const ticks = fired.filter((f) => f.endsWith(`${i}/interval`)).length;
		expect(ticks).toBeGreaterThanOrEqual(2);
		expect(ticks).toBeLessThanOrEqual(8); // not once per millisecond
		svc.clearAll("p");
		const n = fired.filter((f) => f.startsWith("p:")).length;
		await Bun.sleep(40);
		expect(fired.filter((f) => f.startsWith("p:")).length).toBe(n);
		expect(svc.count("p")).toBe(0);
	});
	test("hidden windows slow short timers to once a second, and remote counts sync with clearAll", async () => {
		const fired: number[] = [];
		const cleared: Array<string | undefined> = [];
		const svc = new TimerService({ deliver: async () => void fired.push(1), hidden: () => true, onClear: (p) => cleared.push(p) });
		svc.setTimeout("p", 5);
		svc.setRemoteCount("p", 3);
		expect(svc.count("p")).toBe(4);
		await Bun.sleep(100);
		expect(fired.length).toBe(0);
		svc.clearAll("p");
		expect(svc.count("p")).toBe(0);
		expect(cleared).toEqual(["p"]);
		svc.setRemoteCount("q", 2);
		svc.clearEverything();
		expect(svc.count("q")).toBe(0);
		expect(cleared).toEqual(["p", undefined]);
	});
});

describe("util functions", () => {
	test("DOI, ISBN, ISSN", () => {
		expect(cleanDOI("see https://doi.org/10.1000/xyz123.")).toBe("10.1000/xyz123");
		expect(cleanDOI("nothing here")).toBeUndefined();
		expect(cleanISBN("ISBN 0-306-40615-2", false)).toBe("0306406152");
		expect(cleanISBN("ISBN 0-306-40615-2", true)).toBe("9780306406157");
		expect(cleanISBN("978-0-306-40615-7", false)).toBe("9780306406157");
		expect(cleanISBN("0-306-40615-3", false)).toBeUndefined(); // bad check digit
		expect(cleanISSN("ISSN 0378-5955")).toBe("0378-5955");
		expect(cleanISSN("0378-5954")).toBeUndefined();
	});
	test("html and titles", () => {
		expect(htmlToText("<p>a &amp; b</p><p>c<br>d</p>")).toBe("a & b\nc\nd");
		expect(textToHtml("a < b\n\nc\nd", false)).toBe("<p>a &lt; b</p><p>c<br />d</p>");
		expect(textToHtml("a\nb", true)).toBe("<p>a</p><p>b</p>");
		expect(capitalizeTitle("the art of war and peace: a study in the details", false)).toBe("The Art of War and Peace: A Study in the Details");
		expect(capitalizeTitle("THE ART OF WAR", false)).toBe("The Art of War");
	});
	test("hashes", () => {
		const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
		const abc = new TextEncoder().encode("abc");
		expect(hex(hashBytes("sha256", abc))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		expect(hex(hashBytes("md5", abc))).toBe("900150983cd24fb0d6963f7d28e17f72");
		expect(hex(hashBytes("sha1", abc))).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
		expect(hashBytes("sha512", abc).length).toBe(64);
	});
});
