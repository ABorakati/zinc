// pathBox / buildCanvas on hostile input. The loops run in a child process with a time limit: a regression fails here and does not
// freeze the UI thread (or this suite).
import { describe, expect, test } from "bun:test";
import { buildCanvas, pathBox } from "./canvasSvg";

const child = (mode: "cases" | "fuzz", timeoutMs: number) => {
	const r = Bun.spawnSync([process.execPath, `${import.meta.dir}/test/canvasChild.ts`, mode], { timeout: timeoutMs, killSignal: "SIGKILL", stdout: "pipe", stderr: "pipe" });
	return { ok: r.exitCode === 0 && r.stdout.toString().trim() === "OK", exitCode: r.exitCode, signal: r.signalCode, out: r.stdout.toString().slice(-600), err: r.stderr.toString().slice(-1500) };
};

describe("pathBox", () => {
	test("a token after Z or after an unknown command is skipped, the rest still counts", () => {
		expect(pathBox("M 0 0 B 1 L 5 6")).toEqual({ x: 0, y: 0, w: 5, h: 6 });
		expect(pathBox("M 1 2 L 4 6 Z 9 L 7 8")).toEqual({ x: 1, y: 2, w: 6, h: 6 });
	});
	test("ordinary paths keep their box", () => {
		expect(pathBox("M 10 20 L 30 40 L 5 60 Z")).toEqual({ x: 5, y: 20, w: 25, h: 40 });
		expect(pathBox("M10 10 h 20 v 30")).toEqual({ x: 10, y: 10, w: 20, h: 30 });
		expect(pathBox("M 0 0 C 10 10 20 -5 30 30")).toEqual({ x: 0, y: -5, w: 30, h: 35 });
		expect(pathBox("")).toBeUndefined();
		expect(pathBox("Z")).toBeUndefined();
	});
	test("non-finite numbers give no box", () => {
		expect(pathBox("M 1e999 0")).toBeUndefined();
		expect(pathBox("M 0 0 L -1e999 5")).toEqual({ x: 0, y: 0, w: 0, h: 0 }); // reading stops at the bad number
		expect(pathBox("M 1e308 0 L -1e308 0")).toBeUndefined(); // the width overflows
	});
});

describe("canvas hit shapes", () => {
	const opts = { mode: "light" as const, txt: () => "", image: () => undefined };
	const view = { x: 0, y: 0, width: 100, height: 100 };
	test("a polyline with more points than a spread call takes still gets its box", () => {
		const points = Array.from({ length: 400_000 }, (_, i) => i % 100);
		const r = buildCanvas({ ops: [{ tag: "polyline", val: { points, closed: false, style: { hit: "p" } } }] }, view, opts);
		expect(r.hits[0]).toMatchObject({ x: 0, y: 1, w: 98, h: 98 }); // x from the even slots, y from the odd ones
	});
	test("a malformed op is skipped, the others are drawn", () => {
		const r = buildCanvas({ ops: [{ tag: "rect", val: null }, { tag: "rect", val: { x: 1, y: 2, width: 3, height: 4, style: { hit: "ok" } } }] }, view, opts);
		expect(r.svg).toContain(`<rect x="1" y="2" width="3" height="4"`);
		expect(r.hits.map((h) => h.id)).toEqual(["ok"]);
	});
});

describe("hang and overflow guards (child process)", () => {
	test("adversarial path strings and points", () => {
		const r = child("cases", 60_000);
		if (!r.ok) throw new Error(`child: exit ${r.exitCode} signal ${r.signal}\n${r.out}\n${r.err}`);
	}, 90_000);
	test("fuzz: random path data and draw lists", () => {
		const r = child("fuzz", 90_000);
		if (!r.ok) throw new Error(`child: exit ${r.exitCode} signal ${r.signal}\n${r.out}\n${r.err}`);
	}, 120_000);
});
