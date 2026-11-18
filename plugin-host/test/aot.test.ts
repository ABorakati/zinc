// The AOT runner (src/package/aot.ts, worker.ts runner "aot-process"; phase2-aot.md): install builds aot/plugin.exe and records its hash, a
// stale executable is deleted, a failed or unrunnable executable falls back to a Worker, and a plugin really runs as an AOT child process.
// The tests that compile need the Bun canary (compile.aot); they are skipped when it is not on the machine.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AOT_EXE, aotEntrySource, findCanary } from "../src/package/aot";
import type { SupervisorEvents } from "../src/supervisor";
import { buildFixtures, newSupervisor, until } from "./helpers";
import { buildE2e, newRuntime, pack, rmTree, scratch } from "./pkg/helpers";

const canary = await findCanary().then(
	(p) => (existsSync(p) ? p : undefined),
	() => undefined,
);
const real = canary ? test : test.skip;

let fixtures: Awaited<ReturnType<typeof buildFixtures>>;
let e2e: string;
const roots: string[] = [];
beforeAll(async () => {
	fixtures = await buildFixtures();
	e2e = await buildE2e();
}, 180_000);
afterAll(() => {
	for (const r of roots) rmTree(r);
});

/** A copy of a built plugin folder (the tests add and break files in it). */
function copyOf(dir: string): string {
	const to = scratch("aot");
	roots.push(to);
	cpSync(dir, to, { recursive: true });
	return to;
}

async function runOnce(dir: string) {
	const lines: string[] = [];
	const logs: SupervisorEvents["log"][] = [];
	const sup = newSupervisor(lines, { runner: "aot-process" });
	sup.on("log", (l) => logs.push(l));
	const info = await sup.load(dir);
	await sup.start(info.id);
	await sup.call(info.id, "events", "on-timer", [3, "interval"]);
	const ok = lines.includes(`${info.id}: timer 3 fired`);
	await sup.shutdown();
	return { ok, warnings: logs.filter((l) => l.level === "warn").map((l) => l.message) };
}

describe("AOT entry", () => {
	test("the generated entry imports the glue and every core module statically", async () => {
		const { source, wasmModules } = await aotEntrySource(fixtures["hello-js"]);
		const cores = readdirSync(join(fixtures["hello-js"], "transpiled")).filter((f) => f.endsWith(".wasm"));
		expect(wasmModules).toBe(cores.length);
		expect(wasmModules).toBeGreaterThan(1);
		for (const f of cores) expect(source).toContain(`"${f}": w`);
		expect(source).toContain("plugin-runtime.ts");
		expect(source).not.toContain("__GLUE__");
		expect(source).not.toContain("//__WASM");
	});
});

describe("fallback to a Worker", () => {
	test("runner aot-process without an executable runs the plugin in a Worker and says so", async () => {
		const r = await runOnce(copyOf(fixtures["hello-rust"]));
		expect(r.ok).toBe(true);
		expect(r.warnings.some((w) => w.includes("is missing; running in a Worker"))).toBe(true);
	}, 30_000);

	test("an executable that cannot run (garbage bytes) falls back to a Worker and says so", async () => {
		const dir = copyOf(fixtures["hello-rust"]);
		mkdirSync(join(dir, "aot"));
		writeFileSync(join(dir, AOT_EXE), "this is not an executable");
		const r = await runOnce(dir);
		expect(r.ok).toBe(true);
		expect(r.warnings.some((w) => w.includes("running in a Worker"))).toBe(true);
	}, 30_000);
});

describe("installer", () => {
	type Rt = Awaited<ReturnType<typeof newRuntime>>;
	let rt: Rt | undefined;
	afterAll(async () => {
		rt?.services.dispose();
		await rt?.supervisor.shutdown().catch(() => {});
	});
	const fastTranspile = async (_wasm: Uint8Array, out: string) => void cpSync(join(e2e, "transpiled"), out, { recursive: true });
	const start = async (manager: Record<string, unknown>, supervisor: Record<string, unknown> = {}) => {
		if (rt) {
			rt.services.dispose();
			await rt.supervisor.shutdown().catch(() => {});
		}
		const root = scratch("aot-rt");
		roots.push(root);
		rt = await newRuntime(root, { manager: { transpile: fastTranspile, zincVersion: "0.5.0", ...manager } as never, supervisor: supervisor as never });
		return rt;
	};
	const id = "e2e-js@zinc.test";
	const mgr = (r: Rt) => r.services.manager as unknown as { records: Map<string, { entry: { aotHash?: string } }>; checkAot(id: string, dir: string, e: unknown): Promise<void>; layout: { installed(id: string): string } };

	test("the step runs for a plugin over the size threshold, records the hash, and skips a small one", async () => {
		const built: string[] = [];
		const build = async (dir: string) => {
			built.push(dir);
			mkdirSync(join(dir, "aot"), { recursive: true });
			writeFileSync(join(dir, AOT_EXE), "fake executable");
		};
		let r = await start({ aot: { minBytes: 1, build } });
		let res = await r.services.manager.installPackage(pack(e2e));
		expect(res.error).toBeUndefined();
		expect(built.length).toBe(1);
		expect(existsSync(join(mgr(r).layout.installed(id), AOT_EXE))).toBe(true);
		expect(mgr(r).records.get(id)!.entry.aotHash).toMatch(/^[0-9a-f]{64}$/);

		built.length = 0;
		r = await start({ aot: { minBytes: 10 ** 12, build } });
		res = await r.services.manager.installPackage(pack(e2e));
		expect(res.error).toBeUndefined();
		expect(built.length).toBe(0);
		expect(existsSync(join(mgr(r).layout.installed(id), "aot"))).toBe(false);
		expect(mgr(r).records.get(id)!.entry.aotHash).toBeUndefined();
	}, 120_000);

	test("a failed build does not fail the install", async () => {
		const r = await start({
			aot: {
				minBytes: 1,
				build: async (dir: string) => {
					mkdirSync(join(dir, "aot"), { recursive: true });
					writeFileSync(join(dir, "aot", "plugin.exe.part"), "half");
					throw new Error("canary exploded");
				},
			},
		});
		const res = await r.services.manager.installPackage(pack(e2e));
		expect(res.error).toBeUndefined();
		expect(res.started).toBe(true);
		expect(existsSync(join(mgr(r).layout.installed(id), "aot"))).toBe(false);
		expect(mgr(r).records.get(id)!.entry.aotHash).toBeUndefined();
	}, 120_000);

	test("an executable that no longer matches its hash is deleted at load", async () => {
		const r = await start({
			aot: {
				minBytes: 1,
				build: async (dir: string) => {
					mkdirSync(join(dir, "aot"), { recursive: true });
					writeFileSync(join(dir, AOT_EXE), "original");
				},
			},
		});
		await r.services.manager.installPackage(pack(e2e));
		const dir = mgr(r).layout.installed(id);
		const exe = join(dir, AOT_EXE);
		await mgr(r).checkAot(id, dir, mgr(r).records.get(id)!.entry);
		expect(existsSync(exe)).toBe(true); // untouched: matches
		writeFileSync(exe, "tampered");
		await mgr(r).checkAot(id, dir, mgr(r).records.get(id)!.entry);
		expect(existsSync(join(dir, "aot"))).toBe(false);
	}, 120_000);

	real("a real install compiles aot/plugin.exe and the plugin then runs as an AOT child process", async () => {
		const r = await start({ aot: { minBytes: 1 } }, { runner: "aot-process", callTimeoutMs: 20_000 });
		const logs: string[] = [];
		r.supervisor.on("log", (l) => logs.push(l.message));
		const res = await r.services.manager.installPackage(pack(e2e));
		expect(res.error).toBeUndefined();
		expect(res.started).toBe(true);
		const exe = join(mgr(r).layout.installed(id), AOT_EXE);
		expect(existsSync(exe)).toBe(true);
		expect(mgr(r).records.get(id)!.entry.aotHash).toMatch(/^[0-9a-f]{64}$/);
		expect(logs.filter((l) => l.includes("running in a Worker"))).toEqual([]);
		await r.services.manager.callPlugin(id, "events", "on-timer", [1, "timeout"]);
		// the executable is a running child of the host
		const ps = Bun.spawnSync(["pwsh", "-NoProfile", "-Command", `(Get-Process -Name plugin -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe.replace(/\//g, "\\")}' }).Count`]);
		if (process.platform === "win32") expect(Number(ps.stdout.toString().trim())).toBe(1);
	}, 180_000);

	real("a timeout kills the host and the AOT child with it", async () => {
		const dir = copyOf(fixtures["spin-rust"]);
		const { buildAot } = await import("../src/package/aot");
		await buildAot(dir);
		const lines: string[] = [];
		const sup = newSupervisor(lines, { runner: "aot-process", callTimeoutMs: 800 });
		const info = await sup.load(dir);
		await sup.start(info.id).catch(() => {});
		const pidBefore = sup.hostPid;
		const err = (await sup.call(info.id, "events", "on-timer", [999, "timeout"]).catch((e) => e)) as { kind?: string };
		expect(err?.kind ?? "").toBeOneOf(["timeout", "host-restarting"]);
		await until(() => sup.hostPid !== pidBefore, 8000, "host restart");
		await sup.shutdown();
		if (process.platform === "win32") {
			await Bun.sleep(1500);
			const ps = Bun.spawnSync(["pwsh", "-NoProfile", "-Command", `(Get-Process -Name plugin -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${dir.replace(/\//g, "\\")}*' }).Count`]);
			expect(Number(ps.stdout.toString().trim())).toBe(0);
		}
	}, 120_000);
});
