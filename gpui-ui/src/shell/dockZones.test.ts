import { describe, expect, test } from "bun:test";
import { createDockZones, EMPTY_RIGHT_STRIP, hitDockZone, type DropHostSpec, type Rect } from "./dockZones";

const WIN = { width: 1000, height: 800 };
const host = (spec: DropHostSpec, bounds: Rect) => ({ spec, bounds });
const stack = (column: "centre" | "right", n: number): DropHostSpec => ({ kind: "stack", column, stack: n });
const hit = (hosts: Parameters<typeof createDockZones>[0], x: number, y: number, section = false) =>
	hitDockZone(createDockZones(hosts, WIN, section), { x, y });

// y 100..500: top quarter 100..200, middle 200..400, bottom 400..500
const S = host(stack("centre", 2), { x: 100, y: 100, width: 200, height: 400 });

describe("stack zones", () => {
	test("one host gives three zones that tile its bounds", () => {
		const zones = createDockZones([S], WIN, false);
		expect(zones.map((z) => z.rect)).toEqual([
			{ x: 100, y: 100, width: 200, height: 100 },
			{ x: 100, y: 200, width: 200, height: 200 },
			{ x: 100, y: 400, width: 200, height: 100 },
		]);
		expect(zones.map((z) => z.target)).toEqual([
			{ kind: "split", column: "centre", at: 2 },
			{ kind: "tab", column: "centre", stack: 2 },
			{ kind: "split", column: "centre", at: 3 },
		]);
		expect(zones.map((z) => z.hostKind)).toEqual(["stack", "stack", "stack"]);
	});

	test("exact quarter boundaries are half-open", () => {
		expect(hit([S], 150, 100)?.target).toEqual({ kind: "split", column: "centre", at: 2 });
		expect(hit([S], 150, 199.999)?.target).toEqual({ kind: "split", column: "centre", at: 2 });
		expect(hit([S], 150, 200)?.target).toEqual({ kind: "tab", column: "centre", stack: 2 });
		expect(hit([S], 150, 399.999)?.target).toEqual({ kind: "tab", column: "centre", stack: 2 });
		expect(hit([S], 150, 400)?.target).toEqual({ kind: "split", column: "centre", at: 3 });
		expect(hit([S], 150, 499.999)?.target).toEqual({ kind: "split", column: "centre", at: 3 });
		expect(hit([S], 150, 500)).toBeNull();
	});

	test("left and right edges: left in, right out", () => {
		expect(hit([S], 100, 300)?.target.kind).toBe("tab");
		expect(hit([S], 299.999, 300)?.target.kind).toBe("tab");
		expect(hit([S], 300, 300)).toBeNull();
		expect(hit([S], 99.999, 300)).toBeNull();
	});

	test("split indexes follow the stack index and column", () => {
		const hosts = [
			host(stack("right", 0), { x: 600, y: 0, width: 400, height: 400 }),
			host(stack("right", 1), { x: 600, y: 400, width: 400, height: 400 }),
		];
		expect(hit(hosts, 700, 10)?.target).toEqual({ kind: "split", column: "right", at: 0 });
		expect(hit(hosts, 700, 200)?.target).toEqual({ kind: "tab", column: "right", stack: 0 });
		expect(hit(hosts, 700, 390)?.target).toEqual({ kind: "split", column: "right", at: 1 });
		expect(hit(hosts, 700, 410)?.target).toEqual({ kind: "split", column: "right", at: 1 });
		expect(hit(hosts, 700, 600)?.target).toEqual({ kind: "tab", column: "right", stack: 1 });
		expect(hit(hosts, 700, 790)?.target).toEqual({ kind: "split", column: "right", at: 2 });
	});

	test("stack zones carry no before", () => {
		for (const z of createDockZones([S], WIN, true)) expect("before" in z).toBe(false);
	});
});

describe("section gaps", () => {
	const gap = (before: string | null, y: number) => host({ kind: "section-gap", before }, { x: 100, y, width: 200, height: 20 });

	test("only exist when section is true", () => {
		const hosts = [gap("notes", 120)];
		expect(createDockZones(hosts, WIN, false)).toEqual([]);
		expect(createDockZones(hosts, WIN, true)).toEqual([
			{ rect: { x: 100, y: 120, width: 200, height: 20 }, target: { kind: "section" }, hostKind: "section-gap", before: "notes" },
		]);
	});

	test("before is kept, including null", () => {
		const zones = createDockZones([gap("a", 0), gap(null, 40)], WIN, true);
		expect(zones.map((z) => z.before)).toEqual(["a", null]);
		expect(zones.every((z) => "before" in z)).toBe(true);
	});

	test("win over stacks regardless of registration order", () => {
		const hosts = [S, gap("notes", 120)];
		expect(hit(hosts, 150, 130, true)?.target).toEqual({ kind: "section" });
		expect(hit(hosts, 150, 130, true)?.before).toBe("notes");
		// not a section drag: the stack under the gap answers
		expect(hit(hosts, 150, 130, false)?.target).toEqual({ kind: "split", column: "centre", at: 2 });
		// outside the gap the stack still answers
		expect(hit(hosts, 150, 150, true)?.target).toEqual({ kind: "split", column: "centre", at: 2 });
	});

	test("win over the empty-right strip, which wins over stacks", () => {
		const overlap = host({ kind: "section-gap", before: null }, { x: 960, y: 0, width: 40, height: 40 });
		const right = host({ kind: "empty-right" }, { x: 952, y: 0, width: 48, height: 800 });
		const under = host(stack("right", 0), { x: 900, y: 0, width: 100, height: 800 });
		const hosts = [under, right, overlap];
		expect(hit(hosts, 970, 20, true)?.target).toEqual({ kind: "section" });
		expect(hit(hosts, 970, 100, true)?.target).toEqual({ kind: "split", column: "right", at: 0 });
		expect(hit(hosts, 920, 400, true)?.target).toEqual({ kind: "tab", column: "right", stack: 0 });
	});

	test("the first registered gap wins an overlap", () => {
		const hosts = [gap("a", 100), host({ kind: "section-gap", before: "b" }, { x: 100, y: 110, width: 200, height: 20 })];
		expect(hit(hosts, 150, 115, true)?.before).toBe("a");
		expect(hit(hosts, 150, 125, true)?.before).toBe("b");
	});
});

describe("empty-right strip", () => {
	const E = host({ kind: "empty-right" }, { x: 900, y: 50, width: 100, height: 100 });

	test("registered gives a 48px strip at the window's right edge, full height, split right at 0", () => {
		expect(EMPTY_RIGHT_STRIP).toBe(48);
		expect(createDockZones([E], WIN, false)).toEqual([
			{ rect: { x: 952, y: 0, width: 48, height: 800 }, target: { kind: "split", column: "right", at: 0 }, hostKind: "empty-right" },
		]);
	});

	test("the strip edges", () => {
		expect(hit([E], 951.999, 400)).toBeNull();
		expect(hit([E], 952, 0)?.target).toEqual({ kind: "split", column: "right", at: 0 });
		expect(hit([E], 999.999, 799.999)?.target).toEqual({ kind: "split", column: "right", at: 0 });
		expect(hit([E], 1000, 400)).toBeNull();
		expect(hit([E], 975, 800)).toBeNull();
	});

	test("a missing host gives no strip", () => {
		expect(createDockZones([S], WIN, false).some((z) => z.rect.x === 952)).toBe(false);
	});

	test("two registrations give one strip", () => {
		expect(createDockZones([E, E], WIN, false)).toHaveLength(1);
	});

	test("a window narrower than the strip is clipped", () => {
		const zones = createDockZones([E], { width: 30, height: 100 }, false);
		expect(zones.map((z) => z.rect)).toEqual([{ x: 0, y: 0, width: 30, height: 100 }]);
	});
});

describe("no target", () => {
	test("no hosts, no zones", () => {
		expect(createDockZones([], WIN, true)).toEqual([]);
		expect(hitDockZone([], { x: 1, y: 1 })).toBeNull();
	});

	test("points outside every zone and the window", () => {
		expect(hit([S], 0, 0)).toBeNull();
		expect(hit([S], 150, 600)).toBeNull();
		expect(hit([S], -1, 150)).toBeNull();
		expect(hit([S], 150, -1)).toBeNull();
		expect(hit([S], 1000, 1000)).toBeNull();
		expect(hit([S], Number.NaN, 150)).toBeNull();
		expect(hit([S], 150, Number.NaN)).toBeNull();
	});

	test("an invalid window gives no zones", () => {
		for (const win of [{ width: 0, height: 800 }, { width: 1000, height: -1 }, { width: Number.NaN, height: 800 }]) {
			expect(createDockZones([S, host({ kind: "empty-right" }, S.bounds)], win, true)).toEqual([]);
		}
	});
});

describe("hidden or invalid hosts", () => {
	const bad: Rect[] = [
		{ x: 0, y: 0, width: 0, height: 0 },
		{ x: 0, y: 0, width: 0, height: 100 },
		{ x: 0, y: 0, width: 100, height: 0 },
		{ x: 0, y: 0, width: -100, height: 100 },
		{ x: 0, y: 0, width: 100, height: -100 },
		{ x: Number.NaN, y: 0, width: 100, height: 100 },
		{ x: 0, y: Number.POSITIVE_INFINITY, width: 100, height: 100 },
		{ x: 0, y: 0, width: Number.NaN, height: 100 },
		{ x: 0, y: 0, width: 100, height: Number.POSITIVE_INFINITY },
	];
	const specs: DropHostSpec[] = [stack("centre", 0), { kind: "section-gap", before: null }];

	test("stack and section-gap hosts give no zones", () => {
		for (const spec of specs) for (const bounds of bad) expect(createDockZones([host(spec, bounds)], WIN, true)).toEqual([]);
	});

	test("do not hide the valid hosts beside them", () => {
		const zones = createDockZones([host(stack("centre", 0), bad[0]!), S, host(specs[1]!, bad[5]!)], WIN, true);
		expect(zones).toHaveLength(3);
		expect(zones.every((z) => z.hostKind === "stack" && z.rect.x === 100)).toBe(true);
	});

	test("an empty-right host still gives the strip, whatever its bounds", () => {
		for (const bounds of bad) {
			const zones = createDockZones([host({ kind: "empty-right" }, bounds)], WIN, false);
			expect(zones).toEqual([
				{ rect: { x: 952, y: 0, width: 48, height: 800 }, target: { kind: "split", column: "right", at: 0 }, hostKind: "empty-right" },
			]);
		}
	});

	test("the strip is found by hostKind and keeps its priority over stacks", () => {
		const zones = createDockZones([S, host({ kind: "empty-right" }, bad[0]!)], WIN, false);
		expect(zones.find((z) => z.hostKind === "empty-right")?.rect).toEqual({ x: 952, y: 0, width: 48, height: 800 });
		expect(zones[0]?.hostKind).toBe("empty-right");
	});
});

describe("clipping to the window", () => {
	test("zones never leave the window", () => {
		const big = host(stack("centre", 0), { x: -100, y: -100, width: 1400, height: 1000 });
		for (const z of createDockZones([big], WIN, true)) {
			expect(z.rect.x).toBeGreaterThanOrEqual(0);
			expect(z.rect.y).toBeGreaterThanOrEqual(0);
			expect(z.rect.x + z.rect.width).toBeLessThanOrEqual(WIN.width);
			expect(z.rect.y + z.rect.height).toBeLessThanOrEqual(WIN.height);
		}
	});

	test("band boundaries come from the original bounds, not the clipped ones", () => {
		// original y -100..700: quarters at -100..100, 100..500, 500..700
		const h = host(stack("centre", 0), { x: 0, y: -100, width: 100, height: 800 });
		const zones = createDockZones([h], WIN, false);
		expect(zones.map((z) => z.rect)).toEqual([
			{ x: 0, y: 0, width: 100, height: 100 },
			{ x: 0, y: 100, width: 100, height: 400 },
			{ x: 0, y: 500, width: 100, height: 200 },
		]);
		expect(hit([h], 50, 99.999)?.target).toEqual({ kind: "split", column: "centre", at: 0 });
		expect(hit([h], 50, 100)?.target).toEqual({ kind: "tab", column: "centre", stack: 0 });
		expect(hit([h], 50, 500)?.target).toEqual({ kind: "split", column: "centre", at: 1 });
	});

	test("a band wholly outside the window is dropped", () => {
		// original y 700..1100: top 700..800 in, middle 800..1000 out, bottom 1000..1100 out
		const h = host(stack("right", 4), { x: 0, y: 700, width: 100, height: 400 });
		const zones = createDockZones([h], WIN, false);
		expect(zones).toHaveLength(1);
		expect(zones[0]).toEqual({ rect: { x: 0, y: 700, width: 100, height: 100 }, target: { kind: "split", column: "right", at: 4 }, hostKind: "stack" });
		expect(hit([h], 50, 800)).toBeNull();
	});

	test("a host wholly outside the window gives no zones", () => {
		expect(createDockZones([host(stack("centre", 0), { x: 1000, y: 0, width: 100, height: 100 })], WIN, false)).toEqual([]);
		expect(createDockZones([host(stack("centre", 0), { x: -100, y: 0, width: 100, height: 100 })], WIN, false)).toEqual([]);
	});

	test("a section gap is clipped", () => {
		const g = host({ kind: "section-gap", before: "a" }, { x: 950, y: 790, width: 100, height: 20 });
		expect(createDockZones([g], WIN, true)[0]?.rect).toEqual({ x: 950, y: 790, width: 50, height: 10 });
		expect(hitDockZone(createDockZones([g], WIN, true), { x: 1000, y: 795 })).toBeNull();
	});
});
