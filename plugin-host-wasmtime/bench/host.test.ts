// Tests of the Wasmtime host through its stdio protocol. Run: cd plugin-host-wasmtime && bun test bench/host.test.ts
// Needs `bun bench/prepare.ts` first (plugin folders + .cwasm under %TEMP%\zn-wasm-wasmtime\fixtures) and `cargo build --release`
// (or ZHW=<path to zhw.exe>).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WtHost, prefsHostModule, scratch, zhwBin } from "./lib";

const fixtures = join(scratch, "fixtures");
const has = (n: string) => existsSync(join(fixtures, n, "plugin.wasm"));
const dir = (n: string) => join(fixtures, n);
const viewCtx = { view: "main", surface: "popover", params: "{}", theme: "light", width: 400, height: 600, locale: "en" };

const open: WtHost[] = [];
async function host(o: ConstructorParameters<typeof WtHost>[0] = {}) {
	const h = new WtHost({ aot: true, hostModules: [prefsHostModule], onImport: () => undefined, ...o });
	open.push(h);
	await h.start();
	return h;
}
afterEach(async () => {
	for (const h of open.splice(0)) await h.close().catch(() => {});
});

test("zhw binary exists", () => expect(existsSync(zhwBin)).toBe(true));

describe.skipIf(!has("hello-rust"))("protocol and imports (Rust guest)", () => {
	test("ready lists the bridge's host-side interfaces; load, startup, call work", async () => {
		const h = await host();
		expect(h.readyInfo.interfaces).toContain("zinc:plugin/prefs");
		const l = await h.load(dir("hello-rust"));
		expect((await h.startup(l.id)).ok).toBe(true);
		const r = await h.call(l.id, "events", "on-timer", [5, "timeout"]);
		expect(r).toEqual({ ok: true, value: null });
		// kebab and camel names both work
		expect((await h.call(l.id, "events", "onTimer", [5, "timeout"])).ok).toBe(true);
	});

	test("a bridged import runs the existing TypeScript handler (prefs.get, host-side) and a native one runs in Rust (log.write)", async () => {
		const h = await host();
		const l = await h.load(dir("hello-rust"));
		await h.startup(l.id);
		const msgs = h.logs.map((x) => x.message as string);
		expect(msgs.some((m) => /pref greeting=hello-from-host-\d+/.test(m))).toBe(true); // answered by prefs.host.ts in the bridge process
		expect(msgs).toContain(`hello-rust startup ${l.id} 0.1.0`); // log.write, native
		const s = await h.stats();
		expect(s.plugins[0].nativeCalls).toBeGreaterThan(0);
		expect(s.plugins[0].bridgedCalls).toBeGreaterThan(0);
	});

	test("an import with no host-side handler is forwarded to the parent as an `import` message", async () => {
		const seen: string[] = [];
		const h = await host({ native: "", onImport: (m) => (seen.push(`${m.iface}#${m.fn}`), undefined) });
		const l = await h.load(dir("hello-rust"));
		await h.startup(l.id);
		expect(seen).toContain("zinc:plugin/log#write");
		expect(seen).toContain("zinc:plugin/timers#set-timeout");
	});

	test("no WASI: the guest sees an empty environment and no files, stderr is captured as a log line", async () => {
		const h = await host();
		const l = await h.load(dir("hello-rust"));
		await h.startup(l.id);
		const msgs = h.logs.map((x) => x.message as string);
		expect(msgs).toContain("env_vars=0");
		expect(msgs).toContain("fs_read=err");
		expect(msgs.some((m) => m.includes("[stderr] hello-rust stderr line"))).toBe(true);
	});

	test("unknown export, unknown plugin, bad arguments", async () => {
		const h = await host();
		const l = await h.load(dir("hello-rust"));
		expect(((await h.call(l.id, "events", "nope", [])) as any).error.kind).toBe("no-such-export");
		expect(((await h.call("zz", "events", "on-timer", [1, "timeout"])) as any).error.kind).toBe("not-loaded");
		const bad = (await h.call(l.id, "events", "on-timer", ["x", "timeout"])) as any;
		expect(bad.ok).toBe(false);
		// a bad argument is the caller's error: the plugin is still usable
		expect((await h.call(l.id, "events", "on-timer", [1, "timeout"])).ok).toBe(true);
	});
});

describe.skipIf(!has("hello-js"))("QuickJS guest", () => {
	test("hello-js loads, starts and answers", async () => {
		const h = await host();
		const l = await h.load(dir("hello-js"));
		expect((await h.startup(l.id)).ok).toBe(true);
		expect((await h.call(l.id, "events", "on-timer", [5, "timeout"])).ok).toBe(true);
	});
});

describe.skipIf(!has("ui-fixture"))("UI plugin (QuickJS, big types)", () => {
	test("mount returns a render-result tree and on-event re-renders", async () => {
		const h = await host();
		const l = await h.load(dir("ui-fixture"));
		await h.startup(l.id);
		const r = (await h.call(l.id, "ui-events", "mount", [1, viewCtx])) as any;
		expect(r.ok).toBe(true);
		expect(["json", "tree"]).toContain(r.value.content.tag);
		expect(JSON.stringify(r.value).length).toBeGreaterThan(5000);
	});
});

describe.skipIf(!has("bench-guest"))("safety", () => {
	test("AOT: a .cwasm loads, and much faster than compiling the .wasm", async () => {
		const jit = await host({ aot: false });
		const a = await jit.load(dir("bench-guest"));
		const aot = await host({ aot: true });
		const b = await aot.load(dir("bench-guest"));
		expect(a.detail.fromCwasm).toBe(false);
		expect(b.detail.fromCwasm).toBe(true);
		expect(b.detail.compileMs).toBeLessThan(a.detail.compileMs);
	});

	test("epoch timeout: a stuck plugin is stopped by its budget, the other plugin keeps working", async () => {
		const h = await host();
		const a = await h.load(dir("bench-guest"));
		const b = await h.load(dir("hello-rust"));
		await h.startup(a.id);
		await h.startup(b.id);
		const t0 = performance.now();
		const stuck = h.call(a.id, "events", "on-timer", [3_000_000, "timeout"], 400);
		await Bun.sleep(100);
		const during = performance.now();
		expect((await h.call(b.id, "events", "on-timer", [5, "timeout"])).ok).toBe(true); // while a spins
		expect(performance.now() - during).toBeLessThan(300);
		const r = (await stuck) as any;
		const took = performance.now() - t0;
		expect(r.ok).toBe(false);
		expect(r.error.kind).toBe("timeout");
		expect(r.error.ms).toBe(400);
		expect(took).toBeGreaterThan(380);
		expect(took).toBeLessThan(1500);
		expect(h.exits.some((e) => e.plugin === a.id)).toBe(true); // `plugin-exit` like a died Worker
		expect(((await h.call(a.id, "events", "on-timer", [0, "timeout"])) as any).error.kind).toBe("disabled");
		expect((await h.call(b.id, "events", "on-timer", [6, "timeout"])).ok).toBe(true);
		// the same host runs a fresh instance of the stuck plugin after a reload
		const a2 = await h.load(dir("bench-guest"));
		expect((await h.call(a2.id, "events", "on-timer", [0, "timeout"])).ok).toBe(true);
	});

	test("time spent waiting for a host import does not count against the budget", async () => {
		// 10000 bridged prefs.get calls take far longer than the 100 ms budget in total but each wait is excluded
		const h = await host();
		const a = await h.load(dir("bench-guest"));
		await h.startup(a.id);
		const t0 = performance.now();
		const r = await h.call(a.id, "events", "on-timer", [2_010_000, "timeout"], 100);
		const took = performance.now() - t0;
		expect(r.ok).toBe(true);
		expect(took).toBeGreaterThan(100);
	}, 30_000);

	test("memory cap: a plugin that allocates without end traps at its cap; the other plugin and the host are fine", async () => {
		const h = await host({ maxMemoryMb: 64 });
		const a = await h.load(dir("bench-guest"));
		const b = await h.load(dir("hello-rust"));
		await h.startup(a.id);
		await h.startup(b.id);
		const r = (await h.call(a.id, "events", "on-timer", [5_000_000, "timeout"], 30_000)) as any;
		expect(r.ok).toBe(false);
		expect(r.error.kind).toBe("trap");
		expect(r.error.message).toContain("memory limit");
		expect((await h.call(b.id, "events", "on-timer", [5, "timeout"])).ok).toBe(true);
		const s = await h.stats();
		const peak = s.plugins.find((p: any) => p.plugin === a.id).peakMemoryBytes;
		expect(peak).toBeLessThanOrEqual(64 << 20);
		expect(peak).toBeGreaterThan(32 << 20);
	});

	test("memory cap: an allocation under the cap works", async () => {
		const h = await host({ maxMemoryMb: 64 });
		const a = await h.load(dir("bench-guest"));
		await h.startup(a.id);
		expect((await h.call(a.id, "events", "on-timer", [4_000_020, "timeout"])).ok).toBe(true); // holds 20 MiB
	});
});
