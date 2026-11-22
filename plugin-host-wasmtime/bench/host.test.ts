// Comprehensive Phase 3 test suite for `zhw` (`plugin-host-wasmtime`) over its NDJSON stdio protocol (`protocol-ndjson.md`).
// Run: cd plugin-host-wasmtime && bun test bench/host.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WtHost, now, prefsHostModule, scratch, zhwBin } from "./lib";
import { fixturesDir, prepareAll } from "./prepare";

// Keep any `os.tmpdir()` / `APPDATA` writes from imported handlers (`attachments.host.ts`, `core-fixture.ts`) strictly inside `%TEMP%\zn-p3-runner\b1\tmp`.
const isolatedTmp = join(scratch, "tmp");
mkdirSync(isolatedTmp, { recursive: true });
process.env.TEMP = isolatedTmp;
process.env.TMP = isolatedTmp;
process.env.TMPDIR = isolatedTmp;
process.env.APPDATA = join(isolatedTmp, "appdata");

import netHandler from "../../plugin-host/src/imports/net.host";
import attachmentsHandler from "../../plugin-host/src/imports/attachments.host";

const dir = (n: string) => join(fixturesDir, n);
const viewCtx = { view: "main", surface: "popover", params: "{}", theme: "light", width: 400, height: 600, locale: "en" };
const uiEvent = {
	handler: "clicked",
	nodeKey: "btn",
	kind: "press",
	modifiers: { shift: false, ctrl: false, alt: false, meta: false },
	payload: { tag: "none" },
	rev: 1n,
};

beforeAll(async () => {
	await prepareAll({ quiet: true });
}, 180_000);

const open: WtHost[] = [];
async function host(o: ConstructorParameters<typeof WtHost>[0] = {}) {
	const h = new WtHost({ aot: true, onImport: () => undefined, ...o });
	open.push(h);
	await h.start();
	return h;
}

afterEach(async () => {
	for (const h of open.splice(0)) await h.close().catch(() => {});
});

afterAll(() => {
	try {
		rmSync(join(isolatedTmp, "zinc-plugin-import"), { recursive: true, force: true });
	} catch {}
});

function findResult(h: WtHost, prefix: string): string {
	for (let i = h.logs.length - 1; i >= 0; i--) {
		const msg = String(h.logs[i]?.message ?? "");
		if (msg.startsWith(`RESULT:${prefix}:`)) return msg.slice(`RESULT:${prefix}:`.length);
	}
	throw new Error(`missing RESULT:${prefix} in logs: ${JSON.stringify(h.logs.slice(-15))}`);
}

async function waitUntil(cond: () => boolean, timeoutMs = 3000, label = "condition") {
	const t0 = performance.now();
	while (!cond()) {
		if (performance.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(10);
	}
}

// =====================================================================================================================
// 1. CLI (`version`, `precompile`, `inspect`), `.cwasm` load + corrupt/missing JIT fallback, `unload`
// =====================================================================================================================

describe("1. CLI, precompile, .cwasm load and JIT fallback", () => {
	test("zhw binary exists and `zhw version` returns compatibility metadata", async () => {
		expect(existsSync(zhwBin)).toBe(true);
		const p = Bun.spawn([zhwBin, "version"], { stdout: "pipe", stderr: "pipe" });
		const text = await new Response(p.stdout).text();
		expect(await p.exited).toBe(0);
		const v = JSON.parse(text);
		expect(v.version).toBe("0.1.0");
		expect(v.wasmtime).toBe("50.0.2");
		expect(["windows", "macos", "linux"]).toContain(v.os);
		expect(typeof v.arch).toBe("string");
		expect(v.opt).toBe("default");
		expect(v.cacheKey).toBe(`zhw-${v.version}-wt50.0.2-${v.os}-${v.arch}-${v.opt}`);
	});

	test("`zhw precompile` writes atomically and exits non-zero on invalid component; `inspect` lists exports", async () => {
		const tmpDir = join(isolatedTmp, "precompile-test");
		mkdirSync(tmpDir, { recursive: true });
		const badWasm = join(tmpDir, "bad.wasm");
		writeFileSync(badWasm, "not a wasm component");

		const bad = Bun.spawn([zhwBin, "precompile", badWasm, join(tmpDir, "bad.cwasm")], { stdout: "pipe", stderr: "pipe" });
		expect(await bad.exited).not.toBe(0);
		expect(existsSync(join(tmpDir, "bad.cwasm"))).toBe(false);

		const outCwasm = join(tmpDir, "atomic.cwasm");
		const good = Bun.spawn([zhwBin, "precompile", join(dir("hello-rust"), "plugin.wasm"), outCwasm], { stdout: "pipe", stderr: "pipe" });
		const meta = JSON.parse(await new Response(good.stdout).text());
		expect(await good.exited).toBe(0);
		expect(existsSync(outCwasm)).toBe(true);
		expect(meta.cwasmBytes).toBeGreaterThan(meta.wasmBytes);
		// No leftover `.tmp.<pid>` files
		expect(readdirSync(tmpDir).some((f) => f.includes(".tmp."))).toBe(false);

		const ins = Bun.spawn([zhwBin, "inspect", join(dir("hello-rust"), "plugin.wasm")], { stdout: "pipe", stderr: "pipe" });
		const info = JSON.parse(await new Response(ins.stdout).text());
		expect(await ins.exited).toBe(0);
		expect(info.exports.some((e: any) => String(e.name).includes("lifecycle"))).toBe(true);
	});

	test("explicit `plugin.cwasm` loads fast; corrupt or missing `cwasm` logs warning and falls back to JIT", async () => {
		const jitHost = await host({ aot: false });
		const jitLoad = await jitHost.load(dir("bench-guest"));
		expect(jitLoad.detail.fromCwasm).toBe(false);

		const cwasmHost = await host({ aot: false });
		const cwasmLoad = await cwasmHost.load(dir("bench-guest"), {
			cwasm: join(dir("bench-guest"), "plugin.cwasm"),
		});
		expect(cwasmLoad.detail.fromCwasm).toBe(true);
		expect(cwasmLoad.detail.compileMs).toBeLessThan(jitLoad.detail.compileMs);

		// Corrupt .cwasm -> warn + JIT fallback
		const corruptPath = join(isolatedTmp, "corrupt.cwasm");
		writeFileSync(corruptPath, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
		const corruptLoad = await cwasmHost.load(dir("hello-rust"), { cwasm: corruptPath });
		expect(corruptLoad.detail.fromCwasm).toBe(false);
		expect(cwasmHost.logs.some((l) => l.level === "warn" && String(l.message).includes("falling back to JIT"))).toBe(true);
		expect((await cwasmHost.startup(corruptLoad.id)).ok).toBe(true);

		// Missing .cwasm -> warn + JIT fallback
		cwasmHost.logs.length = 0;
		const missingLoad = await cwasmHost.load(dir("hello-js"), { cwasm: join(isolatedTmp, "does-not-exist.cwasm") });
		expect(missingLoad.detail.fromCwasm).toBe(false);
		expect(cwasmHost.logs.some((l) => l.level === "warn" && String(l.message).includes("missing; falling back to JIT"))).toBe(true);
		expect((await cwasmHost.startup(missingLoad.id)).ok).toBe(true);

		// Unload removes slot cleanly
		const u = await cwasmHost.unload(missingLoad.id);
		expect(u).toEqual({ ok: true, value: null });
		expect(((await cwasmHost.call(missingLoad.id, "events", "on-timer", [1, "timeout"])) as any).error.kind).toBe("not-loaded");
	});

	test("`init.native` overrides CLI `--native` (including `[]` to forward all imports)", async () => {
		const hDefault = await host();
		expect(hDefault.readyInfo.interfaces).toEqual(["log", "prefs", "timers", "l10n", "app", "util"]);

		const seen: string[] = [];
		const hEmpty = await host({
			initNative: [],
			hostModules: [prefsHostModule],
			onImport: (m) => {
				seen.push(`${m.iface}#${m.fn}`);
				return undefined;
			},
		});
		expect(hEmpty.readyInfo.interfaces).toEqual([]);
		const l = await hEmpty.load(dir("hello-rust"));
		await hEmpty.startup(l.id);
		expect(seen).toContain("zinc:plugin/log#write");
		expect(seen).toContain("zinc:plugin/timers#set-timeout");
		const s = await hEmpty.stats();
		expect(s.plugins[0].nativeCalls).toBe(0);
		expect(s.plugins[0].forwardedCalls).toBeGreaterThan(0);
	});
});

// =====================================================================================================================
// 2. All 6 Native Import Families (`log`, `prefs`, `timers`, `l10n`, `app`, `util`)
// =====================================================================================================================

describe("2. Native import families (1:1 parity with TypeScript services)", () => {
	test("native `log`: debug-enabled push, write-error + stack + isError, 8 KiB UTF-8 truncation, batching & 200/s rate limit", async () => {
		const h = await host({ debugEnabled: false });
		const l = await h.load(dir("bench-guest"));
		await h.startup(l.id);
		h.logs.length = 0;
		h.logBatches.length = 0;

		await h.call(l.id, "events", "on-locale-changed", ["log-suite"]);
		expect(findResult(h, "log-suite")).toBe("dbg=false");
		// debug line was dropped when debugEnabled=false
		expect(h.logs.some((x) => x.message === "dbg-msg")).toBe(false);
		expect(h.logs.some((x) => x.message === "info-msg" && !x.isError)).toBe(true);
		expect(h.logs.some((x) => x.message === "err-from-write" && x.isError === true)).toBe(true);
		expect(h.logs.some((x) => x.message === "boom-msg\nat guest.rs:42" && x.isError === true && x.stack === "at guest.rs:42")).toBe(true);
		expect(h.logs.some((x) => x.message === "nostack-msg" && x.isError === true && x.stack === undefined)).toBe(true);

		const truncated = h.logs.find((x) => String(x.message).endsWith("... [truncated]"));
		expect(truncated).toBeDefined();
		expect(String(truncated.message).includes("\ufffd")).toBe(false);
		expect(Buffer.byteLength(truncated.message, "utf8")).toBeLessThanOrEqual(8192 + "... [truncated]".length);

		// Enable debug logs dynamically via `{t: "log-config"}`
		h.pushLogConfig(true);
		const l2 = await h.load(dir("bench-guest"), { id: "bench-log2@zinc.test" });
		await h.call(l2.id, "events", "on-locale-changed", ["log-suite"]);
		expect(findResult(h, "log-suite")).toBe("dbg=true");
		expect(h.logs.some((x) => x.plugin === l2.id && x.level === "debug" && x.message === "dbg-msg")).toBe(true);

		// Burst 350 lines on a fresh plugin id -> batched at >=64 entries and rate-limited at 200 lines/s!
		const l3 = await h.load(dir("bench-guest"), { id: "bench-rate@zinc.test" });
		h.logs.length = 0;
		h.logBatches.length = 0;
		await h.call(l3.id, "events", "on-locale-changed", ["log-burst\n350"]);
		const burstLogs = h.logs.filter((x) => x.plugin === l3.id && String(x.message).startsWith("burst-"));
		expect(burstLogs.length).toBe(200);
		expect(h.logBatches.length).toBeGreaterThanOrEqual(3); // 64 + 64 + 64 + 8
		expect(h.logBatches.some((b) => b.entries.length === 64)).toBe(true);
	});

	test("native `prefs`: defaults, user, secrets, `get-all`, forwarded mutations + push before reply, and live `grants` for `get-app`", async () => {
		const forwardedPrefs: string[] = [];
		const h = await host({
			onImport: (m) => {
				if (m.iface === "zinc:plugin/prefs" && m.fn === "set") {
					const [key, val] = m.args as [string, { tag: string; val: string }];
					forwardedPrefs.push(`${key}=${val.val}`);
					// Just like Zinc's `prefs.zinc.ts`, push updated prefs cache BEFORE returning `import-reply`!
					h.pushPrefs({ plugin: m.plugin, user: { [key]: val.val, starts: 3, "u.alpha": "a" } });
					return null;
				}
				return undefined;
			},
		});

		h.pushPrefs({ appPrefs: { "ui.theme.mode": "dark", "ui.locale": "en-US" } });
		const l = await h.load(dir("bench-guest"), {
			grants: { capabilities: [], netHosts: [] },
			prefs: {
				defaults: { greeting: "hello", count: 42, enabled: true, apiKey: "should-hide" },
				user: { starts: 3, "u.alpha": "a" },
				secrets: ["apiKey"],
			},
		});

		await h.call(l.id, "events", "on-locale-changed", ["prefs-suite"]);
		const res1 = findResult(h, "prefs");
		expect(res1).toContain("g=text:hello|c=int:42|e=flag:true|sec=none|hug=false|hus=true");
		expect(res1).toContain("all=count:int:42:false,enabled:flag:true:false,greeting:text:hello:false,starts:int:3:true,u.alpha:text:a:true");
		expect(res1).toContain("u=u.alpha");
		expect(res1).toContain("theme=err:permission-denied:prefs.app-read");

		// Grant `prefs.app-read` live via `{t: "grants"}` -> next `get-app` succeeds immediately!
		h.pushGrants(l.id, { capabilities: ["prefs.app-read"], netHosts: [] });
		await h.call(l.id, "events", "on-locale-changed", ["prefs-suite"]);
		const res2 = findResult(h, "prefs");
		expect(res2).toContain("theme=ok:text:dark");
		expect(res2).toContain("bad=err:not-found:");

		// Mutating `prefs.set` forwards to Zinc, updates cache before `import-reply`, and `prefs.get` inside the SAME call sees the new value!
		await h.call(l.id, "events", "on-locale-changed", ["prefs-mutate\ngreeting\nupdated-live"]);
		expect(forwardedPrefs).toEqual(["greeting=updated-live"]);
		expect(findResult(h, "prefs-mutate")).toBe("ok|after=text:updated-live");
	});

	test("native `timers`: clock/sleep pauses deadline, timeout/interval/idle/clear, 10 ms floor, hidden 1 s floor, 64-limit & `timers-clear`", async () => {
		const h = await host();
		const l = await h.load(dir("bench-guest"));
		await h.call(l.id, "events", "on-locale-changed", ["trace-timers:on"]);

		// `timers.sleep(30)` advances monotonic clock AND pauses epoch deadline (30 ms sleep under 20 ms budget succeeds!)
		const cr = await h.call(l.id, "events", "on-locale-changed", ["timers-clock"], 20);
		expect(cr.ok).toBe(true);
		const clockRes = findResult(h, "clock");
		const [nowPart, dmPart] = clockRes.split("|");
		expect(Number(nowPart.split("=")[1])).toBeGreaterThan(1_700_000_000_000);
		expect(Number(dmPart.split("=")[1])).toBeGreaterThanOrEqual(20);

		// Schedule timeout, interval (1 ms raised to 10 ms floor), idle, and cancelled timeout
		await h.call(l.id, "events", "on-locale-changed", ["timers-schedule\ntimeout\n15"]);
		const tId = Number(findResult(h, "timer-id").split(":")[1]);
		await h.call(l.id, "events", "on-locale-changed", ["timers-schedule\ninterval\n1"]);
		const iId = Number(findResult(h, "timer-id").split(":")[1]);
		await h.call(l.id, "events", "on-locale-changed", ["timers-schedule\nidle\n200"]);
		const idleId = Number(findResult(h, "timer-id").split(":")[1]);
		await h.call(l.id, "events", "on-locale-changed", ["timers-schedule\ntimeout\n40"]);
		const cancelId = Number(findResult(h, "timer-id").split(":")[1]);
		await h.call(l.id, "events", "on-locale-changed", [`timers-clear-one\n${cancelId}`]);

		await Bun.sleep(95);
		await h.call(l.id, "events", "on-locale-changed", [`timers-clear-one\n${iId}`]);

		const fired = h.logs.map((x) => String(x.message)).filter((m) => m.startsWith("RESULT:timer-fired:"));
		expect(fired).toContain(`RESULT:timer-fired:${tId}:timeout`);
		expect(fired).toContain(`RESULT:timer-fired:${idleId}:idle`); // fired within ~50 ms idle delay, not 200 ms!
		expect(fired).not.toContain(`RESULT:timer-fired:${cancelId}:timeout`);
		const intervalTicks = fired.filter((m) => m === `RESULT:timer-fired:${iId}:interval`).length;
		expect(intervalTicks).toBeGreaterThanOrEqual(2);
		expect(intervalTicks).toBeLessThanOrEqual(12); // enforced >= 10 ms floor
		expect(h.timerCounts.some((c) => c.plugin === l.id && c.count > 0)).toBe(true);

		// Hidden windows raise short timers to 1000 ms floor
		h.pushApp({ windowsHidden: true });
		const beforeHidden = h.logs.length;
		await h.call(l.id, "events", "on-locale-changed", ["timers-schedule\ntimeout\n10"]);
		const hiddenId = Number(findResult(h, "timer-id").split(":")[1]);
		await Bun.sleep(80);
		expect(h.logs.slice(beforeHidden).some((x) => x.message === `RESULT:timer-fired:${hiddenId}:timeout`)).toBe(false);
		h.clearTimers(l.id);
		h.pushApp({ windowsHidden: false });

		// 64-timer cap + `timers-clear`
		await h.call(l.id, "events", "on-locale-changed", ["timers-fill-64"]);
		expect(findResult(h, "timers-64")).toContain("ok=64|err=limit-exceeded:at most 64 timers per plugin");
		expect((await h.stats()).plugins.find((p: any) => p.plugin === l.id).activeTimers).toBe(64);
		h.clearTimers(l.id);
		await waitUntil(() => h.timerCounts.some((c) => c.plugin === l.id && c.count === 0), 1000, "timers-count 0");
		expect((await h.stats()).plugins.find((p: any) => p.plugin === l.id).activeTimers).toBe(0);
	});

	test("native `l10n`: disk fallback, Fluent bundle & locale push (`fr-CA` -> `fr`), warn-once, `format-number` & `format-date` (`1/1/70`)", async () => {
		const h = await host({
			app: {
				info: { locale: "en-US", timeZone: "UTC" },
				isUiReady: true,
			},
		});
		// Load WITHOUT `l10n` push -> lazy disk fallback from `<dir>/locale/<tag>/*.ftl`!
		const l = await h.load(dir("bench-guest"));
		await h.call(l.id, "events", "on-locale-changed", ["l10n-disk"]);
		expect(findResult(h, "l10n-disk")).toBe("From disk en-US");

		await h.call(l.id, "events", "on-locale-changed", ["l10n-suite"]);
		const en = findResult(h, "l10n");
		expect(en).toContain("loc=en-US|plocs=en-US,fr|hm=true,true,false");
		expect(en).toContain("hello=Hello, Ada!");
		expect(en).toContain("many=No items / One item / 5 items / About Zinc / Save the file");
		expect(en).toContain("miss1=Fallback Text|miss2=missing-msg");
		expect(en).toContain("num2=1,234.50|numd=42|dt0=1/1/70");

		// Missing message logged warn ONCE even though formatted twice!
		const missWarns = h.logs.filter((x) => x.level === "warn" && x.message === '[l10n] missing message "missing-msg"');
		expect(missWarns.length).toBe(1);

		// Push `fr-CA` locale + updated Fluent bundles via `{t: "l10n"}` -> resolves `fr` bundle & French formatting (`1\u202f234,50`)!
		h.pushL10n({
			plugin: l.id,
			locale: "fr-CA",
			timeZone: "UTC",
			defaultLocale: "en-US",
			bundles: [
				{ tag: "en-US", ftl: "hello = Hi { $name }\nitems =\n  { $count ->\n    [one] 1 item\n   *[other] { $count } items\n  }\n-brand = Zinc\nabout = About { -brand }\nbutton = Save\n  .tooltip = Tip\n" },
				{ tag: "fr", ftl: "hello = Salut, { $name } !\nitems =\n  { $count ->\n    [one] { $count } élément\n   *[other] { $count } éléments\n  }\n-brand = Zinc\nabout = À propos de { -brand }\nbutton = Enregistrer\n  .tooltip = Info-bulle\n" },
			],
		});
		await h.call(l.id, "events", "on-locale-changed", ["l10n-suite"]);
		const fr = findResult(h, "l10n");
		expect(fr).toContain("loc=fr-CA");
		expect(fr).toContain("hello=Salut, Ada !");
		// In French CLDR plurals, BOTH 0 and 1 use category `[one]`!
		expect(fr).toContain("many=0 élément / 1 élément / 5 éléments / À propos de Zinc / Info-bulle");
		expect(fr).toContain("num2=1\u202f234,50");
	});

	test("native `app`: `get-info`, windows, and `wait-ui-ready` wakeup when `{t: 'app', isUiReady: true}` arrives", async () => {
		const h = await host({
			app: {
				info: {
					name: "Zinc",
					version: "0.9.0",
					apiVersion: "0.1.0",
					zoteroVersion: "10.0.0",
					platform: "windows",
					arch: "x86_64",
					locale: "en-US",
					timeZone: "UTC",
					devBuild: true,
					features: ["extend.menubar", "ui.canvas"],
				},
				isUiReady: false,
				mainWindows: [10, 20],
				activeWindow: 20,
				windowsHidden: false,
			},
		});
		const l = await h.load(dir("bench-guest"));
		await h.call(l.id, "events", "on-locale-changed", ["app-suite"]);
		expect(findResult(h, "app")).toBe(
			"name=Zinc|ver=0.9.0|loc=en-US|tz=UTC|dev=true|feat=extend.menubar,ui.canvas|ready=false|wins=10,20|act=20",
		);

		// Start `wait-ui-ready` while `isUiReady == false`: must suspend until `{t: "app", isUiReady: true}` is pushed!
		let resolved = false;
		const waiting = h.call(l.id, "events", "on-locale-changed", ["app-wait-ui"], 500).then((r) => {
			resolved = true;
			return r;
		});
		await Bun.sleep(60);
		expect(resolved).toBe(false);

		h.pushApp({ isUiReady: true, activeWindow: null });
		const wr = await waiting;
		expect(wr.ok).toBe(true);
		expect(h.logs.some((x) => x.message === "RESULT:wait-ui:after")).toBe(true);

		await h.call(l.id, "events", "on-locale-changed", ["app-suite"]);
		expect(findResult(h, "app")).toContain("ready=true|wins=10,20|act=none");
	});

	test("native `util`: CSPRNG random-bytes + >64KiB trap, UUIDv4, MD5/SHA1/SHA256/SHA512, semver, DOI/ISBN/ISSN, HTML & Title Case", async () => {
		const h = await host();
		const l = await h.load(dir("bench-guest"));
		await h.call(l.id, "events", "on-locale-changed", ["util-suite"]);
		const u = Object.fromEntries(
			findResult(h, "util")
				.split("|")
				.map((kv) => {
					const eq = kv.indexOf("=");
					return [kv.slice(0, eq), kv.slice(eq + 1)];
				}),
		);
		expect(u.r0).toBe("0");
		expect(u.r32).toBe("32");
		expect(u.r32_nonzero).toBe("true");
		expect(u.u1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(u.u_diff).toBe("true");
		expect(u.md5).toBe("900150983cd24fb0d6963f7d28e17f72");
		expect(u.sha1).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
		expect(u.sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		expect(u.sha512).toBe(
			"ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
		);
		expect(u.sv).toBe("-1,0,1");
		expect(u.doi).toBe("10.1000/xyz123,true");
		expect(u.isbn).toBe("0306406152,9780306406157,true");
		expect(u.issn).toBe("0378-5955,true");
		expect(u.h2t).toBe("a & b\\nc\\nd");
		expect(u.t2ha).toBe("<p>a &lt; b</p><p>c<br />d</p>");
		expect(u.t2hb).toBe("<p>a</p><p>b</p>");
		expect(u.cap1).toBe("The Art of War and Peace: A Study in the Details");
		expect(u.cap2).toBe("The Art of War");

		// `random-bytes(65537)` traps the plugin!
		const trap = (await h.call(l.id, "events", "on-locale-changed", ["util-random-trap"])) as any;
		expect(trap.ok).toBe(false);
		expect(trap.error.kind).toBe("trap");
		expect(trap.error.message).toContain("65536");
	});
});

// =====================================================================================================================
// 3. Forwarded Resources (`net.body-reader` & `attachments.file-writer`) against REAL TS Handlers
// =====================================================================================================================

describe("3. Forwarded WIT resources against real net.host.ts & attachments.host.ts", () => {
	test("`net.body-reader` via `send-streamed` (read, close, and early `[resource-drop]`) against real `net.host.ts` + local Bun.serve", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const u = new URL(req.url);
				if (u.pathname === "/stream") {
					const stream = new ReadableStream({
						async start(controller) {
							controller.enqueue(new TextEncoder().encode("chunk-one:"));
							await Bun.sleep(10);
							controller.enqueue(new TextEncoder().encode("chunk-two"));
							controller.close();
						},
					});
					return new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
				}
				return new Response("abcdefghijkl", { status: 200 });
			},
		});

		try {
			let bodyDrops = 0;
			const wrappedNet = {
				...netHandler,
				resources: {
					"body-reader": {
						...netHandler.resources!["body-reader"],
						drop: (ctx: any, self: any) => {
							bodyDrops++;
							return netHandler.resources!["body-reader"].drop?.(ctx, self);
						},
					},
				},
			};

			const h = await host({ handlers: [wrappedNet] });
			const allowed = [`http://127.0.0.1:${server.port}`];
			const l = await h.load(dir("bench-guest"), {
				grants: { capabilities: [], netHosts: allowed },
			});

			await h.call(l.id, "events", "on-locale-changed", [`net-stream\nhttp://127.0.0.1:${server.port}/stream`]);
			expect(findResult(h, "net-stream")).toBe("status=200|chunks=4|text=chunk-one:chunk-two");
			expect(bodyDrops).toBe(1); // `[resource-drop]body-reader` forwarded when `res` went out of scope!

			// Early drop WITHOUT calling `res.body.close()` -> `[resource-drop]body-reader` still runs `drop` on the host!
			await h.call(l.id, "events", "on-locale-changed", [`net-stream-drop-early\nhttp://127.0.0.1:${server.port}/slow`]);
			expect(findResult(h, "net-drop-early")).toBe("first=abcd");
			expect(bodyDrops).toBe(2);
		} finally {
			await server.stop(true);
		}
	});

	test("`attachments.file-writer` (ctor, append with empty & non-empty Uint8Array, finish, drop, rejected ctor) against real `attachments.host.ts` + throwaway core", async () => {
		const { startCore } = await import("../../plugin-host/test/data/core-fixture");
		const core = await startCore();
		try {
			const createdDirs: string[] = [];
			let writerDrops = 0;
			const wrappedAttachments = {
				...attachmentsHandler,
				resources: {
					"file-writer": {
						...attachmentsHandler.resources!["file-writer"],
						create: async (ctx: any, req: any) => {
							// Verify empty `list<u8>` inside `ImportBytesRequest` arrived as a real `Uint8Array(0)` (`{"$bytes": ""}`)!
							expect(req.data).toBeInstanceOf(Uint8Array);
							expect(req.data.byteLength).toBe(0);
							const st: any = await attachmentsHandler.resources!["file-writer"].create!(ctx, req);
							createdDirs.push(st.dir);
							return st;
						},
						drop: async (ctx: any, self: any) => {
							writerDrops++;
							return attachmentsHandler.resources!["file-writer"].drop?.(ctx, self);
						},
					},
				},
			};

			const h = await host({ handlers: [wrappedAttachments], coreUrl: core.url });
			const grants = {
				capabilities: ["library.read", "library.write", "library.files.read", "library.files.write"],
				netHosts: [],
			};
			const rust = await h.load(dir("bench-guest"), { grants });

			// 1. Construct -> append("hello ") -> append("") -> append("wasmtime!") -> finish() -> read back from core!
			await h.call(rust.id, "events", "on-locale-changed", ["att-writer-finish\nnote.txt"]);
			const writerRes = findResult(h, "att-writer");
			expect(writerRes).toMatch(/^ok:[A-Z0-9]{8}\|empty_len=0\|full=hello wasmtime!$/);
			expect(writerDrops).toBe(1);

			// 2. Construct -> append -> drop WITHOUT finish(): `[resource-drop]file-writer` deletes the staging folder!
			await h.call(rust.id, "events", "on-locale-changed", ["att-writer-drop\nabandoned.txt"]);
			expect(findResult(h, "att-writer-drop")).toBe("done");
			expect(writerDrops).toBe(2);
			const abandonedDir = createdDirs[createdDirs.length - 1]!;
			expect(existsSync(abandonedDir)).toBe(false);

			// 3. QuickJS guest (`hello-js`): `timer === 100` (valid FileWriter) and `timer === 102` (invalid filename -> error surfaces on first method call)
			const js = await h.load(dir("hello-js"), { grants });
			await h.startup(js.id);
			expect((await h.call(js.id, "events", "on-timer", [100, "timeout"])).ok).toBe(true);
			expect(h.logs.some((x) => x.plugin === js.id && /^writer key=[A-Z0-9]{8}$/.test(String(x.message)))).toBe(true);

			expect((await h.call(js.id, "events", "on-timer", [102, "timeout"])).ok).toBe(true);
			expect(h.logs.some((x) => x.plugin === js.id && x.message === "writer error=invalid-argument")).toBe(true);
		} finally {
			core.stop();
		}
	}, 30_000);
});

// =====================================================================================================================
// 4. Per-Plugin Call Serialization & Re-entrancy Refusal (`kind: "reentrant"`)
// =====================================================================================================================

describe("4. Per-plugin call lock serialization & re-entrancy refusal", () => {
	test("re-entrant `call` while waiting on a forwarded import is immediately refused (`kind: 'reentrant'`), while calling another plugin succeeds", async () => {
		let releaseImport!: () => void;
		let inImportResolve!: () => void;
		const inImport = new Promise<void>((r) => (inImportResolve = r));

		const h = await host({
			onImport: async (m) => {
				if (m.iface === "zinc:plugin/prefs" && m.fn === "set") {
					inImportResolve();
					await new Promise<void>((r) => (releaseImport = r));
					return null;
				}
				return undefined;
			},
		});

		const a = await h.load(dir("bench-guest"));
		const b = await h.load(dir("hello-rust"));
		await h.startup(a.id);
		await h.startup(b.id);

		// Start call on plugin `a` that suspends inside forwarded `prefs.set`
		const outerCall = h.call(a.id, "events", "on-locale-changed", ["forwarded-wait\nhold"]);
		await inImport;

		// Calling `a` again from parent while `a` waits on `import-reply` MUST return `reentrant` immediately (no deadlock!)
		const t0 = now();
		const reentrant = (await h.call(a.id, "events", "on-timer", [1, "timeout"])) as any;
		expect(now() - t0).toBeLessThan(100);
		expect(reentrant.ok).toBe(false);
		expect(reentrant.error.kind).toBe("reentrant");
		expect(reentrant.error.plugin).toBe(a.id);

		// Meanwhile calling plugin `b` on the SAME `zhw` host succeeds concurrently!
		const other = await h.call(b.id, "events", "on-timer", [5, "timeout"]);
		expect(other).toEqual({ ok: true, value: null });

		// Release the held import -> `a`'s outer call finishes cleanly, and subsequent calls to `a` work!
		releaseImport();
		expect((await outerCall).ok).toBe(true);
		expect((await h.call(a.id, "events", "on-timer", [1, "timeout"])).ok).toBe(true);
	});

	test("non-reentrant overlapping calls (and `ctx.callExport` from an async callback) serialize cleanly through the per-plugin lock", async () => {
		let callbackPromise: Promise<unknown> | undefined;
		const h = await host({
			initNative: ["log", "prefs", "l10n", "app", "util"], // forward `timers` so TS handler calls `ctx.callExport`
			handlers: [
				{
					interface: "zinc:plugin/timers",
					where: "zinc",
					functions: {
						"set-timeout": (ctx, _ms: number) => {
							// Schedule `ctx.callExport` right after `set-timeout` returns while `startup` may still be finishing
							callbackPromise = new Promise((r) => setTimeout(r, 5)).then(() => ctx.callExport("events", "on-timer", [77, "timeout"]));
							return 77;
						},
					},
				},
			],
		});

		const l = await h.load(dir("hello-rust"));
		const [s1, c1, c2] = await Promise.all([
			h.startup(l.id),
			h.call(l.id, "events", "on-timer", [11, "timeout"]),
			h.call(l.id, "events", "on-timer", [12, "timeout"]),
		]);
		expect(s1.ok).toBe(true);
		expect(c1.ok).toBe(true);
		expect(c2.ok).toBe(true);
		await callbackPromise;
		const msgs = h.logs.map((x) => String(x.message));
		expect(msgs).toContain("timer 11 fired");
		expect(msgs).toContain("timer 12 fired");
		expect(msgs).toContain("timer 77 fired");
	});
});

// =====================================================================================================================
// 5. Import-Call Counter (`maxImportCalls`)
// =====================================================================================================================

describe("5. Import-call counter stops runaway import loops", () => {
	test("exceeding `maxImportCalls` over cheap native imports traps the plugin (`kind: 'trap'`) and emits `plugin-exit`", async () => {
		const h = await host({ maxImportCalls: 500 });
		const a = await h.load(dir("bench-guest"));
		const b = await h.load(dir("hello-rust"));
		await h.startup(a.id);
		await h.startup(b.id);

		// 200 calls under 500 limit -> succeeds
		expect((await h.call(a.id, "events", "on-timer", [6_000_200, "timeout"])).ok).toBe(true);

		// 600 calls over 500 limit -> traps!
		const r = (await h.call(a.id, "events", "on-timer", [6_000_600, "timeout"])) as any;
		expect(r.ok).toBe(false);
		expect(r.error.kind).toBe("trap");
		expect(r.error.message).toContain("import call limit");
		expect(h.exits.some((e) => e.plugin === a.id && e.kind === "trap")).toBe(true);

		// Other plugin is unaffected
		expect((await h.call(b.id, "events", "on-timer", [5, "timeout"])).ok).toBe(true);
	});

	test("exceeding `maxImportCalls` over forwarded imports also traps", async () => {
		const h = await host();
		const a = await h.load(dir("bench-guest"));
		await h.startup(a.id);

		const r = (await h.call(a.id, "events", "on-locale-changed", ["forwarded-loop\n80"], 5000, 50)) as any;
		expect(r.ok).toBe(false);
		expect(r.error.kind).toBe("trap");
		expect(r.error.message).toContain("import call limit (50)");
	});
});

// =====================================================================================================================
// 6. Runtime Heartbeat
// =====================================================================================================================

describe("6. Runtime heartbeat", () => {
	test("`heartbeat` messages arrive at `heartbeatMs` intervals even while a plugin spins CPU", async () => {
		const h = await host({ heartbeatMs: 60 });
		const a = await h.load(dir("bench-guest"));
		await h.startup(a.id);

		const stuck = h.call(a.id, "events", "on-timer", [3_000_000, "timeout"], 250);
		await stuck;
		expect(h.heartbeats.length).toBeGreaterThanOrEqual(2);
		expect(h.heartbeats[0].ts).toBeGreaterThan(1_700_000_000_000);
	});
});

// =====================================================================================================================
// 7. Fault Isolation: Epoch Timeout & Memory Cap
// =====================================================================================================================

describe("7. Epoch timeout & memory cap fault isolation", () => {
	test("epoch timeout stops a spinning plugin (`kind: 'timeout'`, `plugin-exit` kind `'timeout'`), while other plugins keep working", async () => {
		const h = await host();
		const a = await h.load(dir("bench-guest"));
		const b = await h.load(dir("hello-rust"));
		await h.startup(a.id);
		await h.startup(b.id);

		const t0 = now();
		const stuck = h.call(a.id, "events", "on-timer", [3_000_000, "timeout"], 400);
		await Bun.sleep(100);
		const during = now();
		expect((await h.call(b.id, "events", "on-timer", [5, "timeout"])).ok).toBe(true);
		expect(now() - during).toBeLessThan(300);

		const r = (await stuck) as any;
		const took = now() - t0;
		expect(r.ok).toBe(false);
		expect(r.error.kind).toBe("timeout");
		expect(r.error.ms).toBe(400);
		expect(took).toBeGreaterThan(360);
		expect(took).toBeLessThan(1500);
		expect(h.exits.some((e) => e.plugin === a.id && e.kind === "timeout")).toBe(true);
		expect(((await h.call(a.id, "events", "on-timer", [0, "timeout"])) as any).error.kind).toBe("disabled");
		expect((await h.call(b.id, "events", "on-timer", [6, "timeout"])).ok).toBe(true);

		// Reloading a fresh instance of the timed-out plugin on the same host works
		const a2 = await h.load(dir("bench-guest"));
		expect((await h.call(a2.id, "events", "on-timer", [0, "timeout"])).ok).toBe(true);
	});

	test("time spent awaiting forwarded imports does not count against the active CPU epoch budget", async () => {
		const h = await host({
			initNative: ["log"],
			onImport: async (m) => {
				if (m.iface === "zinc:plugin/prefs" && m.fn === "get") {
					await Bun.sleep(25);
					return { tag: "text", val: "slow" };
				}
				return undefined;
			},
		});
		const a = await h.load(dir("bench-guest"));
		await h.startup(a.id);
		const t0 = now();
		// 10 calls * 25 ms = 250+ ms of host wait, under a 100 ms active CPU budget!
		const r = await h.call(a.id, "events", "on-timer", [2_000_010, "timeout"], 100);
		expect(r.ok).toBe(true);
		expect(now() - t0).toBeGreaterThan(200);
	});

	test("memory cap (64 MiB): unbounded allocation traps with `plugin-exit` kind `'trap'`; 20 MiB allocation succeeds; other plugins unaffected", async () => {
		const h = await host({ maxMemoryMb: 64 });
		const a = await h.load(dir("bench-guest"));
		const b = await h.load(dir("hello-rust"));
		await h.startup(a.id);
		await h.startup(b.id);

		// 20 MiB under 64 MiB cap succeeds
		expect((await h.call(a.id, "events", "on-timer", [4_000_020, "timeout"])).ok).toBe(true);

		// Unbounded allocation traps at 64 MiB cap
		const r = (await h.call(a.id, "events", "on-timer", [5_000_000, "timeout"], 30_000)) as any;
		expect(r.ok).toBe(false);
		expect(r.error.kind).toBe("trap");
		expect(r.error.message).toContain("memory limit");
		expect(h.exits.some((e) => e.plugin === a.id && e.kind === "trap")).toBe(true);
		expect((await h.call(b.id, "events", "on-timer", [5, "timeout"])).ok).toBe(true);

		const s = await h.stats();
		const peak = s.plugins.find((p: any) => p.plugin === a.id).peakMemoryBytes;
		expect(peak).toBeLessThanOrEqual(64 << 20);
		expect(peak).toBeGreaterThan(32 << 20);
	});

	test("WASI isolation: empty env, no filesystem, stderr captured as warn log", async () => {
		const h = await host();
		const l = await h.load(dir("hello-rust"));
		await h.startup(l.id);
		const msgs = h.logs.map((x) => String(x.message));
		expect(msgs).toContain("env_vars=0");
		expect(msgs).toContain("fs_read=err");
		expect(msgs.some((m) => m.includes("[stderr] hello-rust stderr line"))).toBe(true);
	});

	test("unknown export, unknown plugin, and bad caller arguments keep plugin usable", async () => {
		const h = await host();
		const l = await h.load(dir("hello-rust"));
		expect(((await h.call(l.id, "events", "nope", [])) as any).error.kind).toBe("no-such-export");
		expect(((await h.call("zz", "events", "on-timer", [1, "timeout"])) as any).error.kind).toBe("not-loaded");
		const bad = (await h.call(l.id, "events", "on-timer", ["x", "timeout"])) as any;
		expect(bad.ok).toBe(false);
		expect((await h.call(l.id, "events", "on-timer", [1, "timeout"])).ok).toBe(true);
	});
});

// =====================================================================================================================
// 8. Cold Start of `ui-fixture` (< 150 ms)
// =====================================================================================================================

describe("8. Cold start of `ui-fixture` (< 150 ms)", () => {
	test("spawn `zhw` + `.cwasm` load + `startup` + `mount` + `update-context` + `on-event` + `resync` completes in < 150 ms", async () => {
		// Run 3 cold starts and assert median (and best/typical) < 150 ms
		const samples: number[] = [];
		let lastMount: any;
		for (let i = 0; i < 3; i++) {
			const h = new WtHost({ aot: true, onImport: () => undefined });
			const t0 = now();
			try {
				await h.start();
				const l = await h.load(dir("ui-fixture"), { cwasm: join(dir("ui-fixture"), "plugin.cwasm") });
				expect(l.detail.fromCwasm).toBe(true);
				expect((await h.startup(l.id)).ok).toBe(true);
				const m = (await h.call(l.id, "ui-events", "mount", [1, viewCtx])) as any;
				expect(m.ok).toBe(true);
				lastMount = m;
				expect((await h.call(l.id, "ui-events", "update-context", [1, viewCtx])).ok).toBe(true);
				expect((await h.call(l.id, "ui-events", "on-event", [1, uiEvent])).ok).toBe(true);
				expect((await h.call(l.id, "ui-events", "resync", [1])).ok).toBe(true);
				samples.push(now() - t0);
			} finally {
				await h.close().catch(() => {});
			}
		}
		samples.sort((a, b) => a - b);
		expect(["json", "tree"]).toContain(lastMount.value.content.tag);
		expect(JSON.stringify(lastMount.value).length).toBeGreaterThan(5000);
		expect(samples[1]).toBeLessThan(150);
	});
});

// =====================================================================================================================
// 9. Panics, runaway waits, unload mid-call and stdout floods
// =====================================================================================================================

/** Fails (instead of hanging for ever) when `p` has not settled after `ms`. */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	return await Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`no answer to ${what} within ${ms} ms`)), ms))]);
}

describe("9. Contained failures", () => {
	test("util.html-to-text copes with a character across the 16 byte entity window, and the plugin stays usable", async () => {
		const h = await host();
		const a = await h.load(dir("bench-guest"));
		await h.startup(a.id);
		const text = `&${"a".repeat(14)}é tail AT&amp;T présente`;
		const r = (await within(h.call(a.id, "events", "on-locale-changed", [`html-to-text\n${text}`], 5000), 3000, "html-to-text")) as any;
		expect(r.ok).toBe(true);
		expect(findResult(h, "html-to-text")).toBe(`&${"a".repeat(14)}é tail AT&T présente`);
		expect(h.exits.some((e) => e.plugin === a.id)).toBe(false);
		expect((await h.call(a.id, "events", "on-timer", [5, "timeout"])).ok).toBe(true);
	});

	test("a sleep that cannot fit the call's allowance is refused at once as a timeout", async () => {
		const h = await host();
		const a = await h.load(dir("bench-guest"));
		await h.startup(a.id);
		const t0 = now();
		const r = (await within(h.call(a.id, "events", "on-locale-changed", ["sleep\n3600000"], 1000), 5000, "a sleep of an hour")) as any;
		expect(now() - t0).toBeLessThan(4000);
		expect(r.ok).toBe(false);
		expect(r.error.kind).toBe("timeout");
		expect(h.exits.some((e) => e.plugin === a.id && e.kind === "timeout")).toBe(true);
	});

	test("a short sleep still works and does not use up the CPU budget", async () => {
		const h = await host();
		const a = await h.load(dir("bench-guest"));
		await h.startup(a.id);
		const r = (await h.call(a.id, "events", "on-locale-changed", ["sleep\n400"], 100)) as any;
		expect(r.ok).toBe(true);
		expect(findResult(h, "sleep")).toBe("done");
	});

	test("unload ends a call that is parked in a sleep, without reporting an exit", async () => {
		const h = await host();
		const a = await h.load(dir("bench-guest"));
		await h.startup(a.id);
		const parked = h.call(a.id, "events", "on-locale-changed", ["sleep\n30000"], 5000);
		await Bun.sleep(200);
		const t0 = now();
		await h.unload(a.id);
		const r = (await within(parked, 5000, "the parked call after unload")) as any;
		expect(now() - t0).toBeLessThan(4000);
		expect(r.ok).toBe(false);
		expect(r.error.kind).toBe("not-loaded");
		expect(h.exits.some((e) => e.plugin === a.id)).toBe(false);
	});

	test("heartbeats keep coming while several plugins are compiled at once", async () => {
		// no `.cwasm` and no `--aot`: every load compiles the component in zhw
		const h = await host({ heartbeatMs: 50, aot: false });
		await Bun.sleep(200);
		const names = ["bench-guest", "hello-rust", "hello-js", "ui-fixture", "quick-tags", "hello-js", "ui-fixture", "quick-tags"];
		const from = h.heartbeats.length;
		const t0 = now();
		await Promise.all(names.map((n, i) => h.load(dir(n), { id: `${n}-${i}@zinc.test` })));
		const compileMs = now() - t0;
		await Bun.sleep(100);
		const ts: number[] = h.heartbeats.slice(Math.max(0, from - 1)).map((b) => b.ts);
		const gaps = ts.slice(1).map((v, i) => v - ts[i]!);
		const worst = Math.max(...gaps);
		expect(compileMs).toBeGreaterThan(300); // otherwise this does not exercise anything
		expect(worst).toBeLessThan(400);
	});

	test("a flood on stdout is rate limited and its lines are bounded", async () => {
		const h = await host();
		const a = await h.load(dir("bench-guest"));
		await h.startup(a.id);
		const before = h.logs.length;
		const r = (await h.call(a.id, "events", "on-locale-changed", ["stdout-flood\n3000\n300"], 10_000)) as any;
		expect(r.ok).toBe(true);
		const out = h.logs.slice(before).filter((l) => String(l.message).startsWith("[stdout]"));
		expect(out.length).toBeGreaterThan(0);
		expect(out.length).toBeLessThan(500);
		expect(out.every((l) => String(l.message).length <= 8 * 1024 + 64)).toBe(true);
	});
});
