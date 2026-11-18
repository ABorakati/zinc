// Benchmark: native Wasmtime host (`zhw`, JIT vs `.cwasm` AOT) and optional Bun Worker baseline on the prepared fixtures.
// Usage: bun bench/run.ts [--only cold,steady,import,safety] [--plugins bench-guest,hello-rust,hello-js,ui-fixture,quick-tags] [--reps 5] [--out result.json]
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BunHost, WtHost, type Runner, type WireResult, now, prefsHostModule, scratch, stats, workingSet, zhwBin } from "./lib";

const argv = process.argv.slice(2);
const opt = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const only = new Set((opt("--only") ?? "cold,steady,import,safety").split(","));
const reps = Number(opt("--reps") ?? 5);
const fixtures = join(scratch, "fixtures");
const result: Record<string, any> = { zhw: zhwBin, date: new Date().toISOString() };

type Call = [iface: string, fn: string, args: unknown[]];
const timer: Call = ["events", "on-timer", [5, "timeout"]];
const viewCtx = { view: "main", surface: "popover", params: "{}", theme: "light", width: 400, height: 600, locale: "en" };
const uiEvent = {
	handler: "clicked",
	nodeKey: "btn",
	kind: "press",
	modifiers: { shift: false, ctrl: false, alt: false, meta: false },
	payload: { tag: "none" },
	rev: 1n,
};

interface PluginDef {
	name: string;
	calls: Call[];
	steady: Call;
}
const defs: PluginDef[] = [
	{ name: "bench-guest", calls: [timer], steady: timer },
	{ name: "hello-rust", calls: [timer], steady: timer },
	{ name: "hello-js", calls: [timer], steady: timer },
	{
		name: "ui-fixture",
		calls: [
			["ui-events", "mount", [1, viewCtx]],
			["ui-events", "update-context", [1, viewCtx]],
			["ui-events", "on-event", [1, uiEvent]],
			["ui-events", "resync", [1]],
		],
		steady: ["ui-events", "update-context", [1, viewCtx]],
	},
	{ name: "quick-tags", calls: [["events", "on-locale-changed", ["en"]]], steady: ["events", "on-locale-changed", ["en"]] },
];

const wantedVariants = opt("--variants") ? new Set(opt("--variants")!.split(",")) : undefined;
const wanted = new Set((opt("--plugins") ?? defs.map((d) => d.name).join(",")).split(","));
const present = defs.filter((d) => wanted.has(d.name) && existsSync(join(fixtures, d.name, "plugin.wasm")));
for (const d of defs) if (wanted.has(d.name) && !present.includes(d)) console.log(`(skipped ${d.name}: not in ${fixtures})`);

type Variant = { name: string; make: () => Runner };
const variants: Variant[] = [
	{ name: "wt-aot", make: () => new WtHost({ aot: true }) },
	{ name: "wt-jit", make: () => new WtHost({ aot: false }) },
	{ name: "bun", make: () => new BunHost() },
];
const sel = (xs: Variant[]) => xs.filter((v) => !wantedVariants || wantedVariants.has(v.name));
const bunHasTranspiled = (d: PluginDef) => existsSync(join(fixtures, d.name, "transpiled", "plugin.js"));
const fmt = (ms: number) => (ms >= 1000 ? (ms / 1000).toFixed(2) + " s" : ms.toFixed(1) + " ms");
const mb = (b: number) => (b / 1048576).toFixed(1) + " MB";

function okOr(label: string, r: WireResult) {
	if (!r.ok) throw new Error(`${label}: ${JSON.stringify(r.error).slice(0, 300)}`);
}

// ---- cold start --------------------------------------------------------------------------------------------------------
if (only.has("cold")) {
	console.log("\n== cold start (fresh host process per run; ms) ==");
	result.cold = {};
	for (const d of present) {
		for (const v of sel(variants)) {
			if (v.name === "bun" && !bunHasTranspiled(d)) continue;
			const runs: any[] = [];
			for (let i = 0; i < reps; i++) {
				const r = v.make();
				try {
					const up = await r.start();
					const idle = await workingSet(r.pids());
					const l = await r.load(join(fixtures, d.name));
					const s0 = now();
					okOr("startup", await r.startup(l.id));
					const startup = now() - s0;
					const first: number[] = [];
					for (const [iface, fn, args] of d.calls) {
						const c0 = now();
						okOr(`${iface}.${fn}`, await r.call(l.id, iface, fn, args, 600_000));
						first.push(now() - c0);
					}
					const total = up + l.ms + startup + first.reduce((a, b) => a + b, 0);
					const ws = await workingSet(r.pids());
					runs.push({ up, load: l.ms, loadDetail: l.detail, startup, first, total, idleWs: idle, ws });
				} catch (e) {
					runs.push({ error: String((e as Error).message ?? e) });
					console.log(`${d.name} ${v.name} run ${i}: ${(e as Error).message}`);
				} finally {
					await r.close().catch(() => {});
				}
				if (v.name === "bun" && d.name === "ui-fixture") break;
			}
			const good = runs.filter((x) => !x.error);
			result.cold[`${d.name}/${v.name}`] = runs;
			if (!good.length) continue;
			const med = (f: (x: any) => number) => stats(good.map(f)).median;
			console.log(
				`${d.name.padEnd(14)} ${v.name.padEnd(10)} up ${fmt(med((x) => x.up))}  load ${fmt(med((x) => x.load))}  startup ${fmt(med((x) => x.startup))}  first-calls ${good[0].first.map((_: number, i: number) => fmt(stats(good.map((x) => x.first[i])).median)).join(" / ")}  TOTAL ${fmt(med((x) => x.total))}  ws idle ${mb(med((x) => x.idleWs))} -> ${mb(med((x) => x.ws))}`,
			);
		}
	}
}

// ---- steady state ------------------------------------------------------------------------------------------------------
if (only.has("steady")) {
	console.log("\n== steady-state call time (sequential round trips, microseconds) ==");
	result.steady = {};
	const N = Number(opt("--n") ?? 300);
	for (const d of present) {
		for (const v of sel(variants.filter((x) => x.name !== "wt-jit"))) {
			if (v.name === "bun" && !bunHasTranspiled(d)) continue;
			const r = v.make();
			try {
				await r.start();
				const l = await r.load(join(fixtures, d.name));
				okOr("startup", await r.startup(l.id));
				for (const [iface, fn, args] of d.calls) okOr(fn, await r.call(l.id, iface, fn, args, 600_000));
				const [iface, fn, args] = d.steady;
				const xs: number[] = [];
				for (let i = 0; i < N; i++) {
					const t = now();
					okOr(fn, await r.call(l.id, iface, fn, args));
					xs.push((now() - t) * 1000);
				}
				const s = stats(xs);
				result.steady[`${d.name}/${v.name}`] = s;
				console.log(
					`${d.name.padEnd(14)} ${v.name.padEnd(10)} ${iface}.${fn}: median ${s.median.toFixed(0)} us  p95 ${s.p95.toFixed(0)} us  max ${s.max.toFixed(0)} us`,
				);
			} catch (e) {
				console.log(`${d.name} ${v.name}: ${(e as Error).message}`);
			} finally {
				await r.close().catch(() => {});
			}
		}
	}
}

// ---- import cost -------------------------------------------------------------------------------------------------------
if (only.has("import") && existsSync(join(fixtures, "bench-guest", "plugin.wasm"))) {
	console.log("\n== import call cost, bench-guest (events.on-timer loops N imports inside one export call) ==");
	result.imports = {};
	const dir = join(fixtures, "bench-guest");
	const cases: { label: string; make: () => Runner; mode: number; n: number }[] = [
		{
			label: "debug-enabled  wasmtime NATIVE (Rust atomic bool)",
			make: () => new WtHost({ aot: true }),
			mode: 6,
			n: 200_000,
		},
		{
			label: "debug-enabled  wasmtime FORWARDED (stdio NDJSON -> Zinc)",
			make: () => new WtHost({ aot: true, initNative: [], onImport: (m) => (m.fn === "debug-enabled" ? false : undefined) }),
			mode: 6,
			n: 5_000,
		},
		{
			label: "prefs.get      wasmtime NATIVE (Rust cached prefs)",
			make: () => new WtHost({ aot: true }),
			mode: 2,
			n: 100_000,
		},
		{
			label: "prefs.get      wasmtime FORWARDED (stdio NDJSON -> in-process TS handler)",
			make: () => new WtHost({ aot: true, initNative: ["log", "timers"], hostModules: [prefsHostModule] }),
			mode: 2,
			n: 5_000,
		},
		{
			label: "log.write      wasmtime NATIVE (Rust batched + rate-limited)",
			make: () => new WtHost({ aot: true }),
			mode: 1,
			n: 50_000,
		},
	];
	for (const c of cases) {
		const r = c.make();
		try {
			await r.start();
			const l = await r.load(dir);
			okOr("startup", await r.startup(l.id));
			okOr("warm", await r.call(l.id, "events", "on-timer", [c.mode * 1_000_000 + 100, "timeout"], 120_000));
			const base: number[] = [];
			for (let i = 0; i < 20; i++) {
				const t = now();
				await r.call(l.id, "events", "on-timer", [0, "timeout"]);
				base.push(now() - t);
			}
			const t = now();
			const res = await r.call(l.id, "events", "on-timer", [c.mode * 1_000_000 + c.n, "timeout"], 300_000);
			const el = now() - t;
			okOr("run", res);
			const per = ((el - stats(base).median) / c.n) * 1000;
			result.imports[c.label] = { n: c.n, totalMs: el, perCallUs: per };
			console.log(`${c.label.padEnd(76)} n=${String(c.n).padEnd(7)} ${fmt(el).padStart(9)}  ${per.toFixed(2)} us/call`);
		} catch (e) {
			console.log(`${c.label}: ${(e as Error).message}`);
		} finally {
			await r.close().catch(() => {});
		}
	}
}

// ---- safety timing -----------------------------------------------------------------------------------------------------
if (only.has("safety") && existsSync(join(fixtures, "bench-guest", "plugin.wasm")) && existsSync(join(fixtures, "hello-rust", "plugin.wasm"))) {
	console.log("\n== safety: a stuck plugin (spin forever, 500 ms budget) and a memory hog ==");
	result.safety = {};
	const r = new WtHost({ aot: true, onImport: () => undefined });
	await r.start();
	const a = await r.load(join(fixtures, "bench-guest"));
	const b = await r.load(join(fixtures, "hello-rust"));
	okOr("a", await r.startup(a.id));
	okOr("b", await r.startup(b.id));
	const t = now();
	const stuck = r.call(a.id, "events", "on-timer", [3_000_000, "timeout"], 500);
	await Bun.sleep(100);
	const o0 = now();
	const other = await r.call(b.id, "events", "on-timer", [5, "timeout"]);
	const otherMs = now() - o0;
	const sr = await stuck;
	const stuckMs = now() - t;
	const again = await r.call(a.id, "events", "on-timer", [0, "timeout"]);
	console.log(
		`wasmtime: stuck call returned ${JSON.stringify(sr.ok ? "ok" : (sr as any).error)} after ${fmt(stuckMs)}; other plugin answered ok=${other.ok} in ${fmt(otherMs)} while it spun; stuck plugin afterwards: ${JSON.stringify((again as any).error?.kind)}`,
	);
	result.safety.wasmtimeTimeout = { stuckMs, otherMs, otherOk: other.ok, error: (sr as any).error };
	await r.close();

	const mem = new WtHost({ aot: true, maxMemoryMb: 64, onImport: () => undefined });
	await mem.start();
	const m = await mem.load(join(fixtures, "bench-guest"));
	const h = await mem.load(join(fixtures, "hello-rust"));
	okOr("m", await mem.startup(m.id));
	okOr("h", await mem.startup(h.id));
	const t2 = now();
	const hog = await mem.call(m.id, "events", "on-timer", [5_000_000, "timeout"], 30_000);
	const hogMs = now() - t2;
	const o2 = await mem.call(h.id, "events", "on-timer", [5, "timeout"]);
	console.log(
		`wasmtime: memory hog (64 MiB cap) -> ${JSON.stringify((hog as any).error?.message ?? "ok").slice(0, 140)} after ${fmt(hogMs)}; other plugin ok=${o2.ok}`,
	);
	result.safety.wasmtimeMemory = { hogMs, error: (hog as any).error, otherOk: o2.ok, stats: await mem.stats() };
	await mem.close();
}

await Bun.write(opt("--out") ?? join(scratch, "result.json"), JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log("\nresult written");
process.exit(0);
