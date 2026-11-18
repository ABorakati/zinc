// Unit tests of src/prelude.js on a sandbox global (no QuickJS): the logic of each polyfill.
import { describe, expect, test } from "bun:test";
import { installPrelude } from "../src/prelude.js";

const WALL = 1_700_000_000_000n;
const quiet = { timers: { now: () => 0n, monotonicMs: () => 0n }, log: { write() {} } };

function sandbox(over: Record<string, unknown> = {}) {
	const logs: [string, string][] = [];
	const cleared: number[] = [];
	let id = 1;
	// like QuickJS without a clock: the no-argument forms fail
	const RealDate = Date;
	function TrapDate(this: any, ...a: any[]) {
		if (a.length === 0) throw new Error("wasm unreachable");
		return Reflect.construct(RealDate, a, new.target ?? TrapDate);
	}
	Object.setPrototypeOf(TrapDate, RealDate);
	TrapDate.prototype = RealDate.prototype;
	(TrapDate as any).now = () => { throw new Error("wasm unreachable"); };
	const g: any = { Date: TrapDate, performance: { now: () => { throw new Error("wasm unreachable"); } }, ...over };
	const host = {
		timers: { now: () => WALL, monotonicMs: () => 5000n, setTimeout: () => id++, setInterval: () => id++, clear: (t: number) => void cleared.push(t) },
		log: { write: (l: string, m: string) => void logs.push([l, m]) },
	};
	installPrelude(g, host);
	return { g, logs, cleared };
}
const bare = () => {
	const g: any = { Date, performance: {} };
	installPrelude(g, quiet);
	return g;
};

describe("Date", () => {
	test("no-argument forms read timers.now()", () => {
		const { g } = sandbox();
		expect(g.Date.now()).toBe(Number(WALL));
		expect(new g.Date().getTime()).toBe(Number(WALL));
		expect(typeof g.Date()).toBe("string");
	});
	test("other forms, statics, instanceof, subclass", () => {
		const { g } = sandbox();
		expect(new g.Date(5).getTime()).toBe(5);
		expect(new g.Date(2024, 2, 5).getTime()).toBe(new Date(2024, 2, 5).getTime());
		expect(g.Date.parse("2024-03-05T10:00:00Z")).toBe(1709632800000);
		expect(g.Date.UTC(2024, 2, 5)).toBe(1709596800000);
		const d = new g.Date();
		expect(d instanceof g.Date).toBe(true);
		expect(d.constructor).toBe(g.Date);
		class X extends g.Date { y() { return this.getUTCFullYear(); } }
		const x = new X();
		expect([x instanceof X, x instanceof g.Date, x.y()]).toEqual([true, true, 2023]);
		expect(g.Date.name).toBe("TrapDate");
	});
	test("installing twice does not stack proxies", () => {
		const { g } = sandbox();
		const first = g.Date;
		installPrelude(g, { timers: { now: () => 1n, monotonicMs: () => 0n }, log: { write() {} } });
		expect(g.Date).toBe(first);
		expect(g.Date.now()).toBe(Number(WALL));
	});
});

describe("performance", () => {
	test("now() counts from first use, from the monotonic clock", () => {
		let t = 100n;
		const g: any = { Date, performance: {} };
		installPrelude(g, { timers: { now: () => WALL, monotonicMs: () => (t += 5n) }, log: { write() {} } });
		expect(g.performance.now()).toBe(0);
		expect(g.performance.now()).toBe(5);
	});
	test("is created when missing", () => {
		const g: any = { Date };
		installPrelude(g, quiet);
		expect(typeof g.performance.now()).toBe("number");
	});
});

describe("console", () => {
	test("maps to log levels and formats values", () => {
		const { g, logs } = sandbox();
		g.console.log("a", { b: 1 }, 3, null, undefined);
		g.console.warn("w");
		g.console.error(new Error("e"));
		g.console.debug("d");
		g.console.assert(true, "no");
		g.console.assert(false, "yes");
		expect(logs[0]).toEqual(["info", 'a {"b":1} 3 null undefined']);
		expect(logs[1]).toEqual(["warn", "w"]);
		expect(logs[2][0]).toBe("error");
		expect(logs[2][1]).toContain("Error: e");
		expect(logs[3]).toEqual(["debug", "d"]);
		expect(logs[4]).toEqual(["error", "Assertion failed: yes"]);
	});
	test("an existing console is kept", () => {
		const mine = { log() {} };
		const { g } = sandbox({ console: mine });
		expect(g.console).toBe(mine);
	});
	test("a failing log import does not throw", () => {
		const g: any = { Date, performance: {} };
		installPrelude(g, { timers: quiet.timers, log: { write() { throw { tag: "permission-denied" }; } } });
		expect(() => g.console.log("x")).not.toThrow();
	});
});

describe("timers", () => {
	test("setTimeout fires once with arguments; setInterval repeats; clear forwards", () => {
		const { g, cleared } = sandbox();
		const seen: string[] = [];
		const a = g.setTimeout((x: string, y: string) => seen.push(x + y), 10, "p", "q");
		const b = g.setInterval(() => seen.push("i"), 10);
		expect(g.__zincTimerFire(a, "timeout")).toBe(true);
		expect(g.__zincTimerFire(a, "timeout")).toBe(false);
		expect(g.__zincTimerFire(b, "interval")).toBe(true);
		expect(g.__zincTimerFire(b, "interval")).toBe(true);
		expect(g.__zincTimerFire(999, "timeout")).toBe(false);
		expect(seen).toEqual(["pq", "i", "i"]);
		g.clearInterval(b);
		g.clearTimeout(a); // already fired: no host call
		expect(cleared).toEqual([b]);
		expect(g.__zincTimerFire(b, "interval")).toBe(false);
	});
	test("a throwing callback is logged, not propagated", () => {
		const { g, logs } = sandbox();
		const t = g.setTimeout(() => { throw new Error("boom"); }, 0);
		expect(g.__zincTimerFire(t, "timeout")).toBe(true);
		expect(logs.some(([l, m]) => l === "error" && m.includes("boom"))).toBe(true);
	});
});

describe("TextEncoder / TextDecoder", () => {
	const samples = ["", "abc", "héllo", "€", "😀 x", "\u0000\u007f\u0080߿ࠀ￿"];
	test("match the platform implementation", () => {
		const g2 = bare();
		for (const s of samples) {
			const mine = new g2.TextEncoder().encode(s);
			expect([...mine]).toEqual([...new TextEncoder().encode(s)]);
			expect(new g2.TextDecoder().decode(mine)).toBe(s);
		}
		expect([...new g2.TextEncoder().encode("\ud800")]).toEqual([0xef, 0xbf, 0xbd]);
	});
	test("decoder: invalid input, BOM, fatal, views, labels", () => {
		const D = bare().TextDecoder;
		const bytes = [0x61, 0xff, 0x62, 0xe2, 0x82, 0xc0, 0x80, 0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80];
		expect(new D().decode(new Uint8Array(bytes))).toBe(new TextDecoder().decode(new Uint8Array(bytes)));
		expect(new D().decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("a");
		expect(new D("utf-8", { ignoreBOM: true }).decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("﻿a");
		expect(() => new D("utf-8", { fatal: true }).decode(new Uint8Array([0xff]))).toThrow(TypeError);
		expect(new D().decode(new Uint8Array([0, 0x68, 0x69, 0]).subarray(1, 3))).toBe("hi");
		expect(new D().decode(new Uint8Array([0x68, 0x69]).buffer)).toBe("hi");
		expect(new D().decode()).toBe("");
		expect(() => new D("latin1")).toThrow(RangeError);
	});
	test("existing implementations are kept", () => {
		const g: any = { Date, performance: {}, TextEncoder: class A {}, TextDecoder: class B {} };
		installPrelude(g, quiet);
		expect(g.TextEncoder.name).toBe("A");
	});
});
