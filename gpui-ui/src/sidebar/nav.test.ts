// bun test src/sidebar/nav.test.ts -- the sidebar's arrow keys over a fake list of rows.
import { describe, expect, test } from "bun:test";
import { currentIndex, navKeyName, navStep, type NavEntry } from "./nav";

/** Rows: a header, My Library, a tree A (open) > A1, B (closed, has children), a header, a saved search. */
function fixture(sel: string, open = new Set(["c:A"])) {
	const row = (id: string, extra: Partial<NavEntry["nav"]> = {}): NavEntry => ({
		id,
		nav: { selected: () => id === sel, activate: () => {}, ...extra },
	});
	const tree = (id: string) => ({ expanded: () => open.has(id), toggle: () => {} });
	return [
		{ id: "l:header" },
		row("l:library"),
		{ id: "c:header" },
		row("c:A", tree("c:A")),
		row("c:A1", { parent: "c:A" }),
		row("c:B", tree("c:B")),
		{ id: "ss:header" },
		row("ss:1"),
	] as NavEntry[];
}

describe("sidebar arrow keys", () => {
	test("Down / Up skip headers and stop at the ends", () => {
		const l = fixture("l:library");
		expect(navStep(l, 1, "down")).toEqual({ go: 3 });
		expect(navStep(l, 5, "ArrowDown")).toEqual({ go: 7 });
		expect(navStep(l, 7, "down")).toEqual({ go: 7 });
		expect(navStep(l, 3, "up")).toEqual({ go: 1 });
		expect(navStep(l, 1, "up")).toEqual({ go: 1 });
	});
	test("Home / End", () => {
		const l = fixture("c:A1");
		expect(navStep(l, 4, "home")).toEqual({ go: 1 });
		expect(navStep(l, 4, "end")).toEqual({ go: 7 });
	});
	test("no row selected: Down goes to the first, Up to the last", () => {
		const l = fixture("none");
		expect(currentIndex(l, null)).toBe(-1);
		expect(navStep(l, -1, "down")).toEqual({ go: 1 });
		expect(navStep(l, -1, "up")).toEqual({ go: 7 });
		expect(navStep(l, -1, "left")).toBeNull();
	});
	test("Left collapses an open row, else moves to the parent", () => {
		const l = fixture("c:A1");
		expect(navStep(l, 3, "left")).toEqual({ toggle: 3 });
		expect(navStep(l, 4, "left")).toEqual({ go: 3 });
		expect(navStep(l, 5, "left")).toEqual({ go: 5 }); // closed top-level row: stays
	});
	test("Right expands a closed row, else moves to its first child", () => {
		const l = fixture("c:A");
		expect(navStep(l, 5, "right")).toEqual({ toggle: 5 });
		expect(navStep(l, 3, "right")).toEqual({ go: 4 });
		expect(navStep(l, 1, "right")).toEqual({ go: 1 }); // no children
	});
	test("F2 renames and Delete deletes, where the row allows it", () => {
		const l = fixture("c:A");
		l[3]!.nav!.rename = () => {};
		l[3]!.nav!.remove = () => {};
		expect(navStep(l, 3, "f2")).toEqual({ rename: 3 });
		expect(navStep(l, 3, "delete")).toEqual({ remove: 3 });
		expect(navStep(l, 1, "f2")).toBeNull(); // My Library cannot be renamed
		expect(navStep(l, 1, "delete")).toBeNull();
	});
	test("other keys are not handled", () => {
		expect(navStep(fixture("c:A"), 3, "enter")).toBeNull();
		expect(navStep([{ id: "x" }], -1, "down")).toBeNull();
		expect(navKeyName("ArrowLeft")).toBe("left");
	});
	test("currentIndex prefers the row last moved to while it is selected (a pinned collection is listed twice)", () => {
		const l: NavEntry[] = [
			{ id: "p:A", nav: { selected: () => true, activate: () => {} } },
			{ id: "c:A", nav: { selected: () => true, activate: () => {} } },
		];
		expect(currentIndex(l, null)).toBe(0);
		expect(currentIndex(l, "c:A")).toBe(1);
		expect(currentIndex(l, "gone")).toBe(0);
	});
});
