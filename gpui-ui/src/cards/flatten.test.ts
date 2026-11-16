import { describe, expect, test } from "bun:test";
import { flatten, sameOpened, treeKeyAction, type Opened } from "./flatten";

const op = (key: string, base: number, count: number, kids: string[] | null = null): Opened<string> => ({
	key,
	index: base,
	base,
	count,
	kids,
});
/** Every row of a flat list, as "b<base>" or "<key>.<pos>". */
const rowsOf = (n: number, opened: Opened<string>[]) => {
	const f = flatten(n, opened);
	return Array.from({ length: f.count }, (_, r) => {
		const a = f.at(r);
		return "base" in a ? `b${a.base}` : `${a.opened.key}.${a.pos}`;
	});
};

describe("flatten", () => {
	test("nothing opened: the base rows", () => {
		const f = flatten(4, []);
		expect(f.count).toBe(4);
		expect(rowsOf(4, [])).toEqual(["b0", "b1", "b2", "b3"]);
		expect(f.fromBase(3)).toBe(3);
	});

	test("children follow their item", () => {
		expect(rowsOf(4, [op("b", 1, 2)])).toEqual(["b0", "b1", "b.0", "b.1", "b2", "b3"]);
	});

	test("several opened items, given out of order", () => {
		const opened = [op("d", 3, 1), op("a", 0, 2)];
		expect(rowsOf(5, opened)).toEqual(["b0", "a.0", "a.1", "b1", "b2", "b3", "d.0", "b4"]);
		const f = flatten(5, opened);
		expect(f.count).toBe(8);
		expect([0, 1, 2, 3, 4].map((b) => f.fromBase(b))).toEqual([0, 3, 4, 5, 7]);
		expect(f.rowOfOpened("a")).toBe(0);
		expect(f.rowOfOpened("d")).toBe(5);
		expect(f.rowOfOpened("x")).toBe(-1);
	});

	test("the last row opened", () => {
		expect(rowsOf(3, [op("c", 2, 3)])).toEqual(["b0", "b1", "b2", "c.0", "c.1", "c.2"]);
	});

	test("fromBase and at agree on every base row", () => {
		const opened = [op("x", 2, 3), op("y", 5, 1), op("z", 9, 4)];
		const f = flatten(10, opened);
		for (let b = 0; b < 10; b++) expect(f.at(f.fromBase(b))).toEqual({ base: b });
	});

	test("empty or out-of-range openings are ignored", () => {
		expect(rowsOf(3, [op("a", 0, 0), op("q", 7, 2), op("n", -1, 2)])).toEqual(["b0", "b1", "b2"]);
	});

	test("loaded children ride along", () => {
		const f = flatten(2, [op("a", 0, 2, ["pdf", "note"])]);
		const a = f.at(2);
		expect("opened" in a && a.opened.kids?.[a.pos]).toBe("note");
	});

	test("10k rows, 200 opened: lookups stay consistent", () => {
		const opened = Array.from({ length: 200 }, (_, i) => op(`k${i}`, i * 50 + 7, (i % 4) + 1));
		const f = flatten(10_000, opened);
		expect(f.count).toBe(10_000 + opened.reduce((n, o) => n + o.count, 0));
		let base = 0;
		for (let r = 0; r < f.count; r++) {
			const a = f.at(r);
			if ("base" in a) expect(a.base).toBe(base++);
		}
		expect(base).toBe(10_000);
	});
});

describe("sameOpened", () => {
	test("compares keys, rows, counts and children identity", () => {
		const kids = ["a"];
		expect(sameOpened([op("a", 1, 1, kids)], [op("a", 1, 1, kids)])).toBe(true);
		expect(sameOpened([op("a", 1, 1, kids)], [op("a", 1, 1, ["a"])])).toBe(false);
		expect(sameOpened([op("a", 1, 1)], [op("a", 2, 1)])).toBe(false);
		expect(sameOpened([op("a", 1, 1)], [])).toBe(false);
	});
});

describe("treeKeyAction", () => {
	const closed = { kind: "item" as const, key: "K", hasKids: true, open: false };
	const open = { ...closed, open: true };
	const leaf = { ...closed, hasKids: false };
	const child = { kind: "child" as const, parentKey: "K" };

	test("Right opens, then moves into the children", () => {
		expect(treeKeyAction("right", undefined, closed)).toEqual({ kind: "open", key: "K" });
		expect(treeKeyAction("right", undefined, open)).toEqual({ kind: "firstChild", key: "K" });
		expect(treeKeyAction("right", undefined, leaf)).toBeNull();
		expect(treeKeyAction("right", undefined, child)).toBeNull();
	});

	test("Left closes, or goes up from a child", () => {
		expect(treeKeyAction("left", undefined, open)).toEqual({ kind: "close", key: "K" });
		expect(treeKeyAction("left", undefined, closed)).toBeNull();
		expect(treeKeyAction("left", undefined, child)).toEqual({ kind: "parent", key: "K" });
	});

	test("+ / - open and close all, whatever has the focus", () => {
		expect(treeKeyAction("+", undefined, null)).toEqual({ kind: "openAll" });
		expect(treeKeyAction("=", "+", leaf)).toEqual({ kind: "openAll" });
		expect(treeKeyAction("-", undefined, null)).toEqual({ kind: "closeAll" });
		expect(treeKeyAction("subtract", undefined, open)).toEqual({ kind: "closeAll" });
	});

	test("other keys and no focus", () => {
		expect(treeKeyAction("right", undefined, null)).toBeNull();
		expect(treeKeyAction("x", undefined, open)).toBeNull();
	});
});
