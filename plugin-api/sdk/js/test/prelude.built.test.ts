// Builds test/fixtures/globals-probe with scripts/build.ts (real QuickJS component) and runs it through the supervisor, with a stub
// `timers` that answers like the host. Proves the prelude globals work inside a real guest. Slow (one componentize run).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createPluginSupervisor, defineHandler, type PluginSupervisor } from "../../../../plugin-host/src/index";
import { buildJsPlugin } from "../scripts/build";

const scratch = join(process.env.TEMP ?? process.env.TMPDIR ?? "/tmp", `zn-date-sdk-${process.pid}`);
const WALL = 1_700_000_000_000n;
let lines: string[] = [];
let mono = 1000n;
let nextTimer = 41;
const cleared: number[] = [];
let sup: PluginSupervisor;
let id: string;

const result = async (name: string) => {
	lines = [];
	await sup.call(id, "events", "on-locale-changed", [name]);
	const l = lines.find((x) => x.startsWith(`RESULT ${name} = `));
	if (!l) throw new Error(`${name}: ${lines.join(" | ")}`);
	return JSON.parse(l.slice(`RESULT ${name} = `.length));
};

beforeAll(async () => {
	await mkdir(scratch, { recursive: true });
	const out = join(scratch, "out");
	await buildJsPlugin({ dir: join(import.meta.dir, "fixtures", "globals-probe"), out });
	const h = (iface: string, functions: Record<string, (...a: any[]) => unknown>) =>
		defineHandler({ interface: `zinc:plugin/${iface}`, where: "zinc", functions: Object.fromEntries(Object.entries(functions).map(([k, f]) => [k, (_c: unknown, ...a: unknown[]) => f(...a)])) as any });
	sup = createPluginSupervisor({
		importHandlers: [
			h("log", { write: (_l: string, m: string) => void lines.push(m) }),
			h("timers", { now: () => WALL, "monotonic-ms": () => (mono += 7n), "set-timeout": () => nextTimer++, "set-interval": () => nextTimer++, clear: (t: number) => void cleared.push(t) }),
		],
		discoverHostHandlers: false,
		callTimeoutMs: 8000,
		lifecycleTimeoutMs: 15000,
		loadTimeoutMs: 60000,
	});
	const info = await sup.load(out);
	await sup.start(info.id);
	id = info.id;
}, 240_000);
afterAll(async () => {
	await sup?.shutdown();
	await rm(scratch, { recursive: true, force: true });
});

describe("prelude in a real built plugin", () => {
	test("Date.now() and new Date() read timers.now()", async () => {
		expect(await result("dateNow")).toBe(Number(WALL));
		expect(await result("newDate")).toBe(Number(WALL));
		expect(await result("dateCall")).toBe("string");
		expect(await result("dateArith")).toBe(2023 - 1970);
		expect(await result("dateJson")).toBe(JSON.stringify({ d: new Date(Number(WALL)) }).length);
	});
	test("instanceof, subclassing, constructor identity", async () => {
		expect(await result("dateInstance")).toEqual([true, "[object Date]", true]);
		expect(await result("dateSubclass")).toEqual([true, true, 2023]);
	});
	test("Date with arguments, Date.parse and Date.UTC are unchanged", async () => {
		expect(await result("dateWithArgs")).toEqual(["2023-11-14T22:13:20.000Z", 1709632800000, 1709596800000, 1709632800000, 1709596800000, true]);
	});
	test("performance.now() is monotonic ms since first use", async () => {
		const [a, b] = await result("perfNow");
		expect(a).toBe(0);
		expect(b).toBeGreaterThan(a);
	});
	test("console.* reaches log.write", async () => {
		expect(await result("consoleAll")).toBe("function");
		expect(lines).toContain('a {"b":1}');
		for (const m of ["i", "w", "boom", "d"]) expect(lines).toContain(m);
	});
	test("TextEncoder / TextDecoder", async () => {
		expect(await result("encode")).toEqual([...new TextEncoder().encode("hé€😀")]);
		expect(await result("decode")).toBe("hé€😀 ok");
		expect(await result("decodeBad")).toBe("a�b�");
	});
	test("setTimeout / setInterval / clearInterval go through timers and events.on-timer", async () => {
		expect(await result("types")).toEqual(["function", "function", "function", "function", "object", "function", "function", "function"]);
		expect(await result("timeoutSet")).toEqual([41, 42]);
		lines = [];
		await sup.call(id, "events", "on-timer", [41, "timeout"]);
		await sup.call(id, "events", "on-timer", [41, "timeout"]); // one-shot, already gone: the plugin's own onTimer gets it
		await sup.call(id, "events", "on-timer", [42, "interval"]);
		await sup.call(id, "events", "on-timer", [42, "interval"]);
		await sup.call(id, "events", "on-timer", [99, "timeout"]);
		expect(lines).toEqual(["FIRED xy", "OWN-TIMER 41 timeout", "TICK", "TICK", "OWN-TIMER 99 timeout"]);
		await result("timeoutClear");
		expect(cleared).toEqual([42]);
	}, 30_000);
});
