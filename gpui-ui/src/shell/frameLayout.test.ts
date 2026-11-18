import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appActions } from "../registry";
import type * as LayoutStore from "./layout";
import {
	canMove,
	drawnColumns,
	drawnStacks,
	isSectionPane,
	locatePane,
	migrateLegacyLibrary,
	movePane,
	normalizeLayout,
	paneShown,
	resetSizes,
	sectionIdOf,
	sectionPaneId,
	setLeftShown,
	setPaneHidden,
	setStackActive,
	stackFace,
	standardLibrary,
	STANDARD_SIZES,
	type Column,
	type DropTarget,
	type KnownPanes,
	type Stack,
	type ViewLayout,
} from "./frameLayout";

const KNOWN: KnownPanes = { ids: ["items", "item", "notes"], required: ["items"] };
const REG = new Set(KNOWN.ids);
const norm = (v: unknown) => normalizeLayout(v, KNOWN);
const st = (...panes: string[]) => ({ panes, active: panes[0]! });

describe("normalizeLayout", () => {
	test("a missing or broken value gives builtin:standard", () => {
		expect(norm(undefined)).toEqual(standardLibrary());
		expect(norm("x")).toEqual(standardLibrary());
		expect(norm([1, 2])).toEqual(standardLibrary());
	});
	test("unknown built-in ids are dropped, duplicates keep their first place (centre first)", () => {
		const l = norm({ centre: { stacks: [st("items", "gone")], sizes: [1] }, right: { stacks: [st("items"), st("item", "items")], sizes: [1, 1] } });
		expect(l.centre.stacks).toEqual([st("items")]);
		expect(l.right.stacks).toEqual([st("item")]);
	});
	test("unregistered plugin panes are kept as ghosts, not drawn", () => {
		const l = norm({ centre: { stacks: [st("items")] }, right: { stacks: [st("plugin:x:graph"), st("section:plug:x:refs")] } });
		expect(l.right.stacks.map((s) => s.panes[0])).toEqual(["plugin:x:graph", "section:plug:x:refs"]);
		expect(drawnStacks(l, l.right, REG)).toEqual([]);
		expect(drawnColumns(l, REG)).toEqual(["left", "centre"]);
	});
	test("a missing required pane goes on top of the centre column", () => {
		const l = norm({ centre: { stacks: [st("notes")], sizes: [1] }, right: { stacks: [st("item")], sizes: [1] } });
		expect(l.centre.stacks).toEqual([st("items"), st("notes")]);
		expect(l.centre.sizes).toEqual([0.5, 0.5]);
	});
	test("required panes are never hidden; unknown and duplicate hidden ids are dropped", () => {
		const l = norm({ ...standardLibrary(), hidden: ["items", "item", "item", "nope", 3] });
		expect(l.hidden).toEqual(["item"]);
	});
	test("an empty centre takes the right column's first stack", () => {
		const l = normalizeLayout({ centre: { stacks: [] }, right: { stacks: [st("item"), st("notes")] } }, { ids: KNOWN.ids, required: [] });
		expect(l.centre.stacks).toEqual([st("item")]);
		expect(l.right.stacks).toEqual([st("notes")]);
		expect(l.right.sizes).toEqual([1]);
	});
	test("a stack's active pane is one of its panes", () => {
		const l = norm({ centre: { stacks: [st("items")] }, right: { stacks: [{ panes: ["item", "notes"], active: "zzz" }] } });
		expect(l.right.stacks[0]!.active).toBe("item");
	});
	test("bad sizes are replaced, good ones scaled to sum to 1", () => {
		const l = norm({ ...standardLibrary(), sizes: [2, 6, 2], centre: { stacks: [st("items"), st("notes")], sizes: [-1, 1] } });
		expect(l.sizes).toEqual([0.2, 0.6, 0.2]);
		expect(l.centre.sizes).toEqual([0.5, 0.5]);
		expect(norm({ ...standardLibrary(), sizes: [1, 1] }).sizes).toEqual(STANDARD_SIZES);
		expect(norm({ ...standardLibrary(), sizes: [1e308, 1e308, 1e308] }).sizes.every((n) => n > 0 && n < 1)).toBe(true);
	});
	test("normalising twice changes nothing", () => {
		const once = norm({ ...standardLibrary(), sizes: [0.3, 0.3, 0.3], hidden: ["item"] });
		expect(norm(once)).toEqual(once);
	});
});

describe("what is drawn", () => {
	test("standard: three columns", () => {
		expect(drawnColumns(standardLibrary(), REG)).toEqual(["left", "centre", "right"]);
	});
	test("hiding the item pane empties the right column; hiding the sidebar drops the left", () => {
		let l: ViewLayout = setPaneHidden(standardLibrary(), "item", true);
		expect(drawnColumns(l, REG)).toEqual(["left", "centre"]);
		l = setLeftShown(l, false);
		expect(drawnColumns(l, REG)).toEqual(["centre"]);
		expect(drawnColumns(setPaneHidden(l, "item", false), REG)).toEqual(["centre", "right"]);
	});
	test("a stack shows its active pane, or its first shown one", () => {
		const l = norm({ centre: { stacks: [st("items")] }, right: { stacks: [{ panes: ["item", "notes"], active: "notes" }] } });
		const s = l.right.stacks[0]!;
		expect(stackFace(l, s, REG)).toBe("notes");
		expect(stackFace(setPaneHidden(l, "notes", true), s, REG)).toBe("item");
		expect(stackFace(setPaneHidden(setPaneHidden(l, "notes", true), "item", true), s, REG)).toBeNull();
	});
	test("drawn stacks share the column between them", () => {
		const l = norm({ centre: { stacks: [st("items"), st("item"), st("notes")], sizes: [0.5, 0.25, 0.25] }, right: { stacks: [] } });
		expect(drawnStacks(setPaneHidden(l, "item", true), l.centre, REG)).toEqual([
			{ face: "items", size: 0.5 / 0.75 },
			{ face: "notes", size: 0.25 / 0.75 },
		]);
	});
	test("resetSizes keeps the panes and evens the columns", () => {
		const l = norm({ centre: { stacks: [st("items"), st("notes")], sizes: [0.9, 0.1] }, right: { stacks: [st("item")] }, sizes: [0.4, 0.4, 0.2] });
		const r = resetSizes(l);
		expect(r.sizes).toEqual(STANDARD_SIZES);
		expect(r.centre).toEqual({ stacks: l.centre.stacks, sizes: [0.5, 0.5] });
	});
});

describe("migration from the fixed layout", () => {
	const from = (keys: Record<string, unknown>) => migrateLegacyLibrary((k) => keys[k]);
	test("nothing stored: builtin:standard", () => {
		expect(from({})).toEqual(standardLibrary());
	});
	test("both panels shown: the stored column sizes", () => {
		expect(from({ "shell.cols.11": [0.25, 0.5, 0.25] }).sizes).toEqual([0.25, 0.5, 0.25]);
	});
	test("item pane hidden: hidden in place, its share kept", () => {
		const l = from({ "shell.panelRight": false, "shell.cols.10": [0.25, 0.75], "shell.cols.11": [0.3, 0.3, 0.4] });
		expect(l.hidden).toEqual(["item"]);
		expect(l.sizes).toEqual([0.18, 0.54, 0.28]);
		expect(drawnColumns(l, REG)).toEqual(["left", "centre"]);
	});
	test("sidebar hidden: left column off, the drawn columns as stored", () => {
		const l = from({ "shell.panelLeft": false, "shell.cols.01": [0.6, 0.4] });
		expect(l.left.shown).toBe(false);
		expect(l.sizes[1]! / (l.sizes[1]! + l.sizes[2]!)).toBeCloseTo(0.6, 3);
	});
	test("broken stored sizes fall back to the defaults", () => {
		expect(from({ "shell.cols.11": [0.5, "x", 0.5] }).sizes).toEqual(STANDARD_SIZES);
		expect(from({ "shell.cols.11": [0.5, 0.5] }).sizes).toEqual(STANDARD_SIZES);
	});
	test("the result is already normal", () => {
		const l = from({ "shell.panelRight": false, "shell.cols.10": [0.3, 0.7] });
		expect(norm(l)).toEqual(l);
	});
});

// ---- moving panes (phase 2) ------------------------------------------------------------------------------------------------

const MK: KnownPanes = { ids: ["items", "item", "notes", "section:tags", "section:abstract"], required: ["items"] };
const MREG = new Set(MK.ids);
const col = (stacks: Stack[], sizes?: number[]): Column => ({ stacks, sizes: sizes ?? stacks.map(() => 1 / stacks.length) });
const mk = (centre: Column, right: Column, hidden: string[] = []): ViewLayout => ({
	left: { shown: true },
	centre,
	right,
	sizes: [...STANDARD_SIZES],
	hidden,
});
const panesOf = (c: Column) => c.stacks.map((s) => s.panes);
const activesOf = (c: Column) => c.stacks.map((s) => s.active);
/** a column's sizes are `want` (to 9 places) and sum to 1 */
function expectSizes(c: Column, want: number[]): void {
	expect(c.sizes).toHaveLength(want.length);
	want.forEach((w, i) => expect(c.sizes[i]).toBeCloseTo(w, 9));
	if (want.length) expect(c.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
}
/** a move result that normalizeLayout would leave alone: the panes stay where the move put them, once each, required ones included */
function expectSettled(l: ViewLayout): void {
	const n = normalizeLayout(l, MK);
	expect(n.centre.stacks).toEqual(l.centre.stacks);
	expect(n.right.stacks).toEqual(l.right.stacks);
	expect(n.hidden).toEqual(l.hidden);
	expect(normalizeLayout(n, MK)).toEqual(n);
	expect(locatePane(n, "items")).not.toBeNull();
	expect(n.hidden).not.toContain("items");
	expect(n.centre.stacks.length).toBeGreaterThan(0);
}
function deepFreeze<T>(v: T): T {
	if (v && typeof v === "object") for (const x of Object.values(v)) deepFreeze(x);
	return Object.freeze(v);
}
const tab = (column: "centre" | "right", stack: number, index?: number): DropTarget => ({ kind: "tab", column, stack, index });
const split = (column: "centre" | "right", at: number): DropTarget => ({ kind: "split", column, at });

describe("section pane ids", () => {
	test("round trip", () => {
		expect(sectionPaneId("tags")).toBe("section:tags");
		expect(sectionPaneId("plug:a:refs")).toBe("section:plug:a:refs");
		expect(isSectionPane("section:tags")).toBe(true);
		expect(isSectionPane("items")).toBe(false);
		expect(isSectionPane("plugin:a:graph")).toBe(false);
		expect(sectionIdOf("section:tags")).toBe("tags");
		expect(sectionIdOf("section:plug:a:refs")).toBe("plug:a:refs");
		expect(sectionIdOf("items")).toBeNull();
	});
});

describe("locatePane", () => {
	test("gives a pane's column, stack and place; null when it is not in the layout", () => {
		const l = mk(col([st("items")]), col([st("item"), st("notes", "section:tags")]));
		expect(locatePane(l, "items")).toEqual({ column: "centre", stack: 0, index: 0 });
		expect(locatePane(l, "item")).toEqual({ column: "right", stack: 0, index: 0 });
		expect(locatePane(l, "notes")).toEqual({ column: "right", stack: 1, index: 0 });
		expect(locatePane(l, "section:tags")).toEqual({ column: "right", stack: 1, index: 1 });
		expect(locatePane(l, "section:abstract")).toBeNull();
		expect(locatePane(l, "")).toBeNull();
		expect(locatePane(l, "__proto__")).toBeNull();
	});
	test("hidden panes and plugin ghosts have a place too", () => {
		const l = mk(col([st("items")]), col([st("plugin:a:graph", "notes")]), ["notes"]);
		expect(locatePane(l, "notes")).toEqual({ column: "right", stack: 0, index: 1 });
		expect(locatePane(l, "plugin:a:graph")).toEqual({ column: "right", stack: 0, index: 0 });
	});
});

describe("movePane: tab targets", () => {
	test("a pane joins another stack of its column as the last tab, and becomes active", () => {
		const l = mk(col([st("items"), st("notes")], [0.6, 0.4]), col([st("item")]));
		const r = movePane(l, "notes", tab("centre", 0));
		expect(r.centre.stacks).toEqual([{ panes: ["items", "notes"], active: "notes" }]);
		expectSizes(r.centre, [1]);
		expect(r.right).toEqual(l.right);
		expectSettled(r);
	});
	test("at an index (a gap, counted before the move)", () => {
		const l = mk(col([st("items"), st("notes")]), col([st("item")]));
		const r = movePane(l, "notes", tab("centre", 0, 0));
		expect(r.centre.stacks).toEqual([{ panes: ["notes", "items"], active: "notes" }]);
		const r2 = movePane(l, "notes", tab("centre", 0, 1));
		expect(r2.centre.stacks).toEqual([{ panes: ["items", "notes"], active: "notes" }]);
	});
	test("across columns: the source stack goes and its height is shared out again", () => {
		const l = mk(col([st("items"), st("notes")], [0.6, 0.4]), col([st("item")]));
		const r = movePane(l, "notes", tab("right", 0));
		expect(r.right.stacks).toEqual([{ panes: ["item", "notes"], active: "notes" }]);
		expect(r.centre.stacks).toEqual([st("items")]);
		expectSizes(r.centre, [1]);
		expectSizes(r.right, [1]);
		expectSettled(r);
	});
	test("leaving a stack of several panes keeps that stack and its height", () => {
		const l = mk(col([st("items"), st("notes", "section:tags")], [0.7, 0.3]), col([st("item")]));
		const r = movePane(l, "notes", tab("right", 0, 0));
		expect(r.right.stacks).toEqual([{ panes: ["notes", "item"], active: "notes" }]);
		expect(panesOf(r.centre)).toEqual([["items"], ["section:tags"]]);
		expect(r.centre.sizes).toEqual([0.7, 0.3]);
	});
	test("the source stack's active pane moves on only when the moved pane was the active one", () => {
		const l = mk(col([st("items")]), col([{ panes: ["item", "notes", "section:tags"], active: "notes" }]));
		expect(movePane(l, "item", tab("centre", 0)).right.stacks[0]!.active).toBe("notes");
		expect(movePane(l, "section:tags", tab("centre", 0)).right.stacks[0]!.active).toBe("notes");
		expect(movePane(l, "notes", tab("centre", 0)).right.stacks[0]).toEqual({ panes: ["item", "section:tags"], active: "section:tags" });
		const last = mk(col([st("items")]), col([{ panes: ["item", "notes", "section:tags"], active: "section:tags" }]));
		expect(movePane(last, "section:tags", tab("centre", 0)).right.stacks[0]).toEqual({ panes: ["item", "notes"], active: "notes" });
	});
	test("a stack that empties: the heights of the others scale back to 1", () => {
		const l = mk(col([st("items")]), col([st("item"), st("notes"), st("section:tags")], [0.5, 0.3, 0.2]));
		const r = movePane(l, "notes", tab("centre", 0));
		expect(panesOf(r.right)).toEqual([["item"], ["section:tags"]]);
		expectSizes(r.right, [0.5 / 0.7, 0.2 / 0.7]);
		expectSizes(r.centre, [1]);
	});
	test("the target stack is found by its place before the move, also when an earlier stack goes", () => {
		const l = mk(col([st("items")]), col([st("item"), st("notes"), st("section:tags")], [0.5, 0.3, 0.2]));
		const r = movePane(l, "item", tab("right", 2));
		expect(panesOf(r.right)).toEqual([["notes"], ["section:tags", "item"]]);
		expectSizes(r.right, [0.3 / 0.5, 0.2 / 0.5]);
	});
});

describe("movePane: reordering inside a stack", () => {
	const l = mk(col([st("items", "notes", "section:tags")]), col([st("item")]));
	const order = (id: string, index?: number) => movePane(l, id, tab("centre", 0, index)).centre.stacks[0]!;
	test("to the end (no index) and to any gap", () => {
		expect(order("items")).toEqual({ panes: ["notes", "section:tags", "items"], active: "items" });
		expect(order("section:tags", 0)).toEqual({ panes: ["section:tags", "items", "notes"], active: "section:tags" });
		expect(order("items", 2)).toEqual({ panes: ["notes", "items", "section:tags"], active: "items" });
		expect(order("notes", 0)).toEqual({ panes: ["notes", "items", "section:tags"], active: "notes" });
		expect(order("notes", 3)).toEqual({ panes: ["items", "section:tags", "notes"], active: "notes" });
		expect(order("section:tags", 1)).toEqual({ panes: ["items", "section:tags", "notes"], active: "section:tags" });
	});
	test("the stack, its height and the rest of the layout stay", () => {
		const r = movePane(l, "items", tab("centre", 0));
		expect(r.centre.sizes).toEqual([1]);
		expect(r.right).toEqual(l.right);
		expect(r.hidden).toEqual([]);
		expectSettled(r);
	});
	test("a drop into the pane's own place is no move (the gap before it, the gap after it, the end for the last pane)", () => {
		for (const [id, index] of [["items", 0], ["items", 1], ["notes", 1], ["notes", 2], ["section:tags", 2], ["section:tags", 3], ["section:tags", undefined]] as const) {
			const to = tab("centre", 0, index);
			expect(canMove(l, id, to)).toBe(false);
			expect(movePane(l, id, to)).toBe(l);
		}
	});
	test("a lone pane dropped on its own stack is no move", () => {
		const lone = mk(col([st("items"), st("notes")]), col([st("item")]));
		for (const index of [undefined, 0, 1]) {
			expect(canMove(lone, "notes", tab("centre", 1, index))).toBe(false);
			expect(movePane(lone, "notes", tab("centre", 1, index))).toBe(lone);
		}
	});
});

describe("movePane: split targets", () => {
	test("a new stack takes an equal share, the others scale to the rest", () => {
		const l = mk(col([st("items"), st("section:tags"), st("section:abstract")], [0.5, 0.25, 0.25]), col([st("item", "notes")]));
		const r = movePane(l, "notes", split("centre", 1));
		expect(panesOf(r.centre)).toEqual([["items"], ["notes"], ["section:tags"], ["section:abstract"]]);
		expect(r.centre.stacks[1]).toEqual(st("notes"));
		expectSizes(r.centre, [0.375, 0.25, 0.1875, 0.1875]);
		expect(r.right.stacks).toEqual([st("item")]);
		expectSettled(r);
	});
	test("at the top and at the bottom", () => {
		const l = mk(col([st("items")]), col([st("item", "notes")]));
		expect(panesOf(movePane(l, "notes", split("centre", 0)).centre)).toEqual([["notes"], ["items"]]);
		expect(panesOf(movePane(l, "notes", split("centre", 1)).centre)).toEqual([["items"], ["notes"]]);
		expectSizes(movePane(l, "notes", split("centre", 1)).centre, [0.5, 0.5]);
	});
	test("into an empty right column", () => {
		const l = mk(col([st("items", "notes")]), col([]));
		const r = movePane(l, "notes", split("right", 0));
		expect(r.right.stacks).toEqual([st("notes")]);
		expect(r.right.sizes).toEqual([1]);
		expect(r.centre.stacks).toEqual([st("items")]);
		expectSettled(r);
	});
	test("a lone stack moved to the other column: its old column scales back to 1, the new stack gets an equal share", () => {
		const l = mk(col([st("items"), st("notes"), st("section:tags")], [0.5, 0.3, 0.2]), col([st("item")]));
		const r = movePane(l, "section:tags", split("right", 1));
		expect(panesOf(r.centre)).toEqual([["items"], ["notes"]]);
		expectSizes(r.centre, [0.625, 0.375]);
		expect(panesOf(r.right)).toEqual([["item"], ["section:tags"]]);
		expectSizes(r.right, [0.5, 0.5]);
		expectSettled(r);
	});
	test("a pane leaving a stack of several, to the other column: the old column keeps its sizes", () => {
		const l = mk(col([st("items"), st("notes", "section:tags")], [0.7, 0.3]), col([st("item")]));
		const r = movePane(l, "section:tags", split("right", 0));
		expect(panesOf(r.centre)).toEqual([["items"], ["notes"]]);
		expect(r.centre.sizes).toEqual([0.7, 0.3]);
		expect(panesOf(r.right)).toEqual([["section:tags"], ["item"]]);
		expectSizes(r.right, [0.5, 0.5]);
	});
	test("the required pane may go to the right column while the centre keeps another stack", () => {
		const l = mk(col([st("items"), st("notes"), st("section:tags")], [0.5, 0.3, 0.2]), col([st("item")]));
		const r = movePane(l, "items", split("right", 0));
		expect(panesOf(r.centre)).toEqual([["notes"], ["section:tags"]]);
		expectSizes(r.centre, [0.6, 0.4]);
		expect(locatePane(r, "items")).toEqual({ column: "right", stack: 0, index: 0 });
		expectSettled(r);
	});
});

describe("movePane: splitting beside a pane's own stack", () => {
	test("a pane of a stack of several: above or below its own stack, both are moves", () => {
		const l = mk(col([st("items", "notes")]), col([st("item")]));
		expect(canMove(l, "notes", split("centre", 0))).toBe(true);
		expect(canMove(l, "notes", split("centre", 1))).toBe(true);
		const above = movePane(l, "notes", split("centre", 0));
		expect(panesOf(above.centre)).toEqual([["notes"], ["items"]]);
		expectSizes(above.centre, [0.5, 0.5]);
		const below = movePane(l, "notes", split("centre", 1));
		expect(panesOf(below.centre)).toEqual([["items"], ["notes"]]);
		expectSizes(below.centre, [0.5, 0.5]);
		expectSettled(above);
		expectSettled(below);
	});
	test("the stack in the middle of a column: above and below it", () => {
		const l = mk(col([st("items"), st("notes", "section:tags"), st("section:abstract")], [0.5, 0.3, 0.2]), col([st("item")]));
		const above = movePane(l, "section:tags", split("centre", 1));
		expect(panesOf(above.centre)).toEqual([["items"], ["section:tags"], ["notes"], ["section:abstract"]]);
		const below = movePane(l, "section:tags", split("centre", 2));
		expect(panesOf(below.centre)).toEqual([["items"], ["notes"], ["section:tags"], ["section:abstract"]]);
		expectSizes(above.centre, [0.375, 0.25, 0.225, 0.15]);
		expectSizes(below.centre, [0.375, 0.225, 0.25, 0.15]);
		expectSettled(above);
		expectSettled(below);
	});
	test("a lone stack dropped above or below itself is no move", () => {
		const l = mk(col([st("items"), st("notes"), st("section:tags")], [0.5, 0.3, 0.2]), col([st("item")]));
		for (const [id, at] of [["items", 0], ["items", 1], ["notes", 1], ["notes", 2], ["section:tags", 2], ["section:tags", 3]] as const) {
			expect(canMove(l, id, split("centre", at))).toBe(false);
			expect(movePane(l, id, split("centre", at))).toBe(l);
		}
		expect(canMove(l, "item", split("right", 0))).toBe(false);
		expect(canMove(l, "item", split("right", 1))).toBe(false);
	});
	test("a lone stack moved elsewhere in its column keeps its height", () => {
		const l = mk(col([st("items"), st("notes"), st("section:tags")], [0.5, 0.3, 0.2]), col([st("item")]));
		const to = (id: string, at: number) => movePane(l, id, split("centre", at)).centre;
		expect(panesOf(to("items", 3))).toEqual([["notes"], ["section:tags"], ["items"]]);
		expect(to("items", 3).sizes).toEqual([0.3, 0.2, 0.5]);
		expect(panesOf(to("section:tags", 0))).toEqual([["section:tags"], ["items"], ["notes"]]);
		expect(to("section:tags", 0).sizes).toEqual([0.2, 0.5, 0.3]);
		expect(panesOf(to("notes", 0))).toEqual([["notes"], ["items"], ["section:tags"]]);
		expect(to("notes", 0).sizes).toEqual([0.3, 0.5, 0.2]);
		expect(panesOf(to("notes", 3))).toEqual([["items"], ["section:tags"], ["notes"]]);
		expect(to("notes", 3).sizes).toEqual([0.5, 0.2, 0.3]);
		expect(panesOf(to("items", 2))).toEqual([["notes"], ["items"], ["section:tags"]]);
		expect(to("items", 2).sizes).toEqual([0.3, 0.5, 0.2]);
	});
});

describe("canMove: targets that do not exist", () => {
	const l = mk(col([st("items"), st("notes", "section:tags")], [0.6, 0.4]), col([st("item")]));
	const bad: [string, DropTarget][] = [
		["split below the bottom", split("centre", 3)],
		["split above the top", split("centre", -1)],
		["split at NaN", split("centre", NaN)],
		["split at a fraction", split("centre", 0.5)],
		["split at Infinity", split("right", Infinity)],
		["split at a string", split("centre", "1" as unknown as number)],
		["tab onto a stack that is not there", tab("centre", 2)],
		["tab onto a negative stack", tab("centre", -1)],
		["tab onto stack NaN", tab("centre", NaN)],
		["tab onto a fractional stack", tab("centre", 0.5)],
		["tab into an empty column", tab("right", 1)],
		["tab at a negative index", tab("right", 0, -1)],
		["tab beyond the last gap", tab("right", 0, 2)],
		["tab at index NaN", tab("right", 0, NaN)],
		["tab at a fractional index", tab("right", 0, 0.5)],
		["tab at Infinity", tab("right", 0, Infinity)],
		["the left column", { kind: "tab", column: "left", stack: 0 } as unknown as DropTarget],
		["a column that is not one", { kind: "split", column: "constructor", at: 0 } as unknown as DropTarget],
		["a kind that is not one", { kind: "float" } as unknown as DropTarget],
	];
	for (const [name, to] of bad)
		test(`${name}: not allowed, same layout back, no throw`, () => {
			expect(canMove(l, "notes", to)).toBe(false);
			expect(movePane(l, "notes", to)).toBe(l);
		});
	test("the last gap of a stack is allowed", () => {
		expect(canMove(l, "item", tab("centre", 1, 2))).toBe(true);
		expect(canMove(l, "item", tab("centre", 1, 0))).toBe(true);
	});
});

describe("the centre column is never left empty", () => {
	test("its last pane cannot go to the right column, by tab or split", () => {
		const l = standardLibrary();
		for (const to of [tab("right", 0), tab("right", 0, 0), split("right", 0), split("right", 1)]) {
			expect(canMove(l, "items", to)).toBe(false);
			expect(movePane(l, "items", to)).toBe(l);
		}
		expect(canMove(l, "items", split("centre", 0))).toBe(false);
	});
	test("a centre of one stack with two panes may give one of them, either one", () => {
		const l = mk(col([st("items", "notes")]), col([st("item")]));
		const r = movePane(l, "notes", tab("right", 0));
		expect(r.centre.stacks).toEqual([st("items")]);
		const r2 = movePane(l, "items", split("right", 1));
		expect(r2.centre.stacks).toEqual([st("notes")]);
		expect(r2.right.stacks).toEqual([st("item"), st("items")]);
		expectSettled(r);
		expectSettled(r2);
	});
	test("a centre of two stacks may give one of them", () => {
		const l = mk(col([st("items"), st("notes")]), col([st("item")]));
		const r = movePane(l, "notes", tab("right", 0));
		expect(r.centre.stacks).toEqual([st("items")]);
		expectSizes(r.centre, [1]);
		expect(panesOf(movePane(l, "items", split("right", 0)).centre)).toEqual([["notes"]]);
	});
	test("a pane may leave the right column empty", () => {
		const l = standardLibrary();
		const r = movePane(l, "item", tab("centre", 0));
		expect(r.centre.stacks).toEqual([{ panes: ["items", "item"], active: "item" }]);
		expect(r.right).toEqual({ stacks: [], sizes: [] });
		expectSettled(r);
	});
	test("a pane returning to the item pane cannot empty the centre either", () => {
		const l = mk(col([st("section:tags")]), col([st("items")]));
		expect(canMove(l, "section:tags", { kind: "section" })).toBe(false);
		expect(movePane(l, "section:tags", { kind: "section" })).toBe(l);
		expect(canMove(l, "section:tags", tab("right", 0))).toBe(false);
	});
	test("a section pane of a centre that has others returns to the item pane", () => {
		const one = mk(col([st("items", "section:tags")]), col([st("item")]));
		const r = movePane(one, "section:tags", { kind: "section" });
		expect(r.centre.stacks).toEqual([st("items")]);
		expect(locatePane(r, "section:tags")).toBeNull();
		expectSettled(r);
		const two = mk(col([st("items"), st("section:tags")], [0.6, 0.4]), col([st("item")]));
		const r2 = movePane(two, "section:tags", { kind: "section" });
		expect(r2.centre.stacks).toEqual([st("items")]);
		expectSizes(r2.centre, [1]);
		expectSettled(r2);
	});
});

describe("movePane: the section target", () => {
	test("takes a section pane out of the layout; its stack goes and the others scale to 1", () => {
		const l = mk(col([st("items")]), col([st("item"), st("section:tags"), st("section:abstract")], [0.5, 0.3, 0.2]));
		const r = movePane(l, "section:tags", { kind: "section" });
		expect(panesOf(r.right)).toEqual([["item"], ["section:abstract"]]);
		expectSizes(r.right, [0.5 / 0.7, 0.2 / 0.7]);
		expect(locatePane(r, "section:tags")).toBeNull();
		expect(r.centre).toEqual(l.centre);
		expectSettled(r);
	});
	test("out of a stack of several: the stack stays and another pane is active", () => {
		const l = mk(col([st("items")]), col([{ panes: ["item", "section:tags", "section:abstract"], active: "section:tags" }]));
		const r = movePane(l, "section:tags", { kind: "section" });
		expect(r.right.stacks).toEqual([{ panes: ["item", "section:abstract"], active: "section:abstract" }]);
		expect(r.right.sizes).toEqual([1]);
	});
	test("the last pane of the right column leaves it empty", () => {
		const l = mk(col([st("items")]), col([st("section:tags")]));
		const r = movePane(l, "section:tags", { kind: "section" });
		expect(r.right).toEqual({ stacks: [], sizes: [] });
		expect(drawnColumns(r, MREG)).toEqual(["left", "centre"]);
		expectSettled(r);
	});
	test("a hidden section pane that returns leaves no hidden entry behind", () => {
		const l = mk(col([st("items")]), col([st("item", "section:abstract")]), ["section:abstract"]);
		const r = movePane(l, "section:abstract", { kind: "section" });
		expect(r.hidden).toEqual([]);
		expectSettled(r);
	});
	test("only a placed section pane can go", () => {
		const l = mk(col([st("items", "notes")]), col([st("item", "section:tags")]));
		expect(canMove(l, "notes", { kind: "section" })).toBe(false);
		expect(canMove(l, "item", { kind: "section" })).toBe(false);
		expect(canMove(l, "section:abstract", { kind: "section" })).toBe(false);
		expect(canMove(l, "plugin:a:graph", { kind: "section" })).toBe(false);
		expect(movePane(l, "notes", { kind: "section" })).toBe(l);
		expect(canMove(l, "section:tags", { kind: "section" })).toBe(true);
	});
	test("a plugin section ghost returns too", () => {
		const l = mk(col([st("items")]), col([st("item", "section:plug:a:refs")]));
		const r = movePane(l, "section:plug:a:refs", { kind: "section" });
		expect(r.right.stacks).toEqual([st("item")]);
	});
});

describe("movePane: placing a pane that is not in the layout (a section detached)", () => {
	const l = mk(col([st("items")]), col([st("item")]));
	test("as a tab, at an index or last", () => {
		const r = movePane(l, "section:tags", tab("right", 0));
		expect(r.right.stacks).toEqual([{ panes: ["item", "section:tags"], active: "section:tags" }]);
		expect(movePane(l, "section:tags", tab("right", 0, 0)).right.stacks[0]!.panes).toEqual(["section:tags", "item"]);
		expect(movePane(l, "section:tags", tab("centre", 0, 1)).centre.stacks[0]!.panes).toEqual(["items", "section:tags"]);
		expect(r.centre).toEqual(l.centre);
		expectSettled(r);
	});
	test("as a new stack, with an equal share", () => {
		const r = movePane(l, "section:tags", split("centre", 0));
		expect(panesOf(r.centre)).toEqual([["section:tags"], ["items"]]);
		expectSizes(r.centre, [0.5, 0.5]);
		expect(r.right).toEqual(l.right);
		const s = movePane(mk(col([st("items")]), col([])), "section:tags", split("right", 0));
		expect(s.right).toEqual({ stacks: [st("section:tags")], sizes: [1] });
		expectSettled(r);
		expectSettled(s);
	});
	test("the same target checks apply", () => {
		expect(canMove(l, "section:tags", split("centre", 2))).toBe(false);
		expect(canMove(l, "section:tags", split("centre", NaN))).toBe(false);
		expect(canMove(l, "section:tags", tab("right", 1))).toBe(false);
		expect(canMove(l, "section:tags", tab("right", 0, 2))).toBe(false);
		expect(canMove(l, "section:tags", { kind: "section" })).toBe(false);
	});
});

describe("movePane: hidden panes", () => {
	const base = () => mk(col([st("items"), st("notes")], [0.5, 0.5]), col([st("item", "section:tags")]), ["notes", "section:tags"]);
	test("a hidden pane is shown by a move to a tab", () => {
		const r = movePane(base(), "notes", tab("right", 0));
		expect(r.hidden).toEqual(["section:tags"]);
		expect(paneShown(r, "notes", MREG)).toBe(true);
		expect(stackFace(r, r.right.stacks[0]!, MREG)).toBe("notes");
	});
	test("by a move to a split", () => {
		const r = movePane(base(), "section:tags", split("right", 0));
		expect(r.hidden).toEqual(["notes"]);
		expect(drawnStacks(r, r.right, MREG).map((d) => d.face)).toEqual(["section:tags", "item"]);
	});
	test("by a reorder inside its stack", () => {
		const l = mk(col([st("items")]), col([st("item", "section:tags")]), ["section:tags"]);
		const r = movePane(l, "section:tags", tab("right", 0, 0));
		expect(r.hidden).toEqual([]);
		expect(r.right.stacks).toEqual([{ panes: ["section:tags", "item"], active: "section:tags" }]);
	});
	test("moving a shown pane keeps the other hidden panes hidden", () => {
		const r = movePane(base(), "item", tab("centre", 0));
		expect(r.hidden).toEqual(["notes", "section:tags"]);
	});
	test("a hidden pane dropped where it already is stays hidden (no move)", () => {
		const l = mk(col([st("items"), st("notes")]), col([st("item")]), ["notes"]);
		expect(movePane(l, "notes", split("centre", 1))).toBe(l);
		expect(movePane(l, "notes", split("centre", 2))).toBe(l);
	});
});

describe("movePane: required panes through normalizeLayout", () => {
	test("a required pane moved anywhere stays placed once, shown, with a non-empty centre", () => {
		const l = mk(col([st("items"), st("notes"), st("section:tags")], [0.5, 0.3, 0.2]), col([st("item")]));
		const targets: DropTarget[] = [tab("centre", 1), tab("centre", 2, 0), split("centre", 3), split("right", 0), split("right", 1), tab("right", 0, 0)];
		for (const to of targets) {
			const r = movePane(l, "items", to);
			expect(r).not.toBe(l);
			expectSettled(r);
			expect(locatePane(normalizeLayout(r, MK), "items")).toEqual(locatePane(r, "items"));
		}
	});
	test("a required pane marked hidden is shown by moving it, and stays so after normalizing", () => {
		const l = mk(col([st("items"), st("notes")]), col([st("item")]), ["items"]);
		const r = movePane(l, "items", tab("right", 0));
		expect(r.hidden).toEqual([]);
		expectSettled(r);
	});
	test("moving the other panes never takes the required one out of the layout", () => {
		const l = mk(col([st("items", "notes")]), col([st("item", "section:tags")]));
		for (const id of ["notes", "item", "section:tags"]) {
			for (const to of [split("centre", 0), split("right", 1), tab("centre", 0, 0), { kind: "section" } as DropTarget]) {
				const r = movePane(l, id, to);
				expect(locatePane(r, "items")).not.toBeNull();
				expectSettled(r);
			}
		}
	});
});

describe("movePane and setStackActive never change their input", () => {
	const l = mk(col([st("items"), st("notes", "section:tags")], [0.6, 0.4]), col([st("item")]), ["section:tags"]);
	test("a frozen layout is moved without a throw, and still equals a copy taken before", () => {
		const copy = structuredClone(l);
		const frozen = deepFreeze(structuredClone(l));
		const targets: DropTarget[] = [tab("right", 0), tab("centre", 1, 0), split("centre", 0), split("right", 1), { kind: "section" }];
		for (const id of ["items", "notes", "section:tags", "item", "gone"]) {
			for (const to of targets) movePane(frozen, id, to);
			setStackActive(frozen, id);
		}
		expect(frozen).toEqual(copy);
	});
	test("the result shares no stack or pane list with the input", () => {
		const r = movePane(l, "item", tab("centre", 1));
		for (const [a, b] of [[r.centre.stacks, l.centre.stacks], [r.right.stacks, l.right.stacks]] as const) {
			for (const s of a) for (const t of b) expect(s).not.toBe(t);
			for (const s of a) for (const t of b) expect(s.panes).not.toBe(t.panes);
		}
		expect(r.centre.sizes).not.toBe(l.centre.sizes);
		expect(r.hidden).not.toBe(l.hidden);
	});
});

describe("setStackActive", () => {
	const l = mk(col([st("items", "notes")]), col([st("item", "section:tags"), st("section:abstract")], [0.4, 0.6]));
	test("makes a pane the active one of its stack", () => {
		const r = setStackActive(l, "notes");
		expect(r.centre.stacks).toEqual([{ panes: ["items", "notes"], active: "notes" }]);
		expect(r.right).toEqual(l.right);
		const s = setStackActive(l, "section:tags");
		expect(activesOf(s.right)).toEqual(["section:tags", "section:abstract"]);
		expect(s.right.sizes).toEqual([0.4, 0.6]);
		expect(s.centre).toEqual(l.centre);
	});
	test("does not move or reorder anything", () => {
		const r = setStackActive(l, "section:tags");
		expect(panesOf(r.right)).toEqual(panesOf(l.right));
		expect(locatePane(r, "section:tags")).toEqual(locatePane(l, "section:tags"));
	});
	test("shows a hidden pane", () => {
		const h = mk(col([st("items")]), col([st("item", "section:tags")]), ["section:tags", "notes"]);
		const r = setStackActive(h, "section:tags");
		expect(r.hidden).toEqual(["notes"]);
		expect(stackFace(r, r.right.stacks[0]!, MREG)).toBe("section:tags");
		expect(stackFace(h, h.right.stacks[0]!, MREG)).toBe("item");
	});
	test("a pane that is active and shown gives the same layout back", () => {
		expect(setStackActive(l, "items")).toBe(l);
		expect(setStackActive(l, "item")).toBe(l);
	});
	test("an active pane that is hidden is shown (the stack must not stay faceless)", () => {
		const h = mk(col([st("items")]), col([st("item")]), ["item"]);
		const r = setStackActive(h, "item");
		expect(r).not.toBe(h);
		expect(r.hidden).toEqual([]);
	});
	test("a pane that is not in the layout gives the same layout back", () => {
		expect(setStackActive(l, "gone")).toBe(l);
		expect(setStackActive(l, "")).toBe(l);
		expect(setStackActive(l, "__proto__")).toBe(l);
	});
	test("the result is already normal", () => {
		const h = mk(col([st("items", "notes")]), col([st("item")]), ["notes"]);
		const r = setStackActive(h, "notes");
		expect(normalizeLayout(r, MK)).toEqual(r);
	});
});

// ---- the library store: moveLibraryPane / hideLibraryPane / activateLibraryPane / undoLayout and the layout actions ----------
// layout.ts is imported inside beforeAll, after ZN_UI_STATE=off, so nothing reads or writes the user's ui-state.json.

describe("the library store", () => {
	let S: typeof LayoutStore;
	let saved: ViewLayout;
	let envBefore: string | undefined;
	/** undo everything; how many undos there were */
	const drain = (): number => {
		let n = 0;
		while (S.undoLayout()) n++;
		return n;
	};

	beforeAll(async () => {
		envBefore = process.env.ZN_UI_STATE;
		process.env.ZN_UI_STATE = "off";
		S = await import("./layout"); // dynamic on purpose: ZN_UI_STATE must be set before layout.ts (prefs.ts, store.ts) is first loaded
		saved = S.libraryLayout();
	});
	afterAll(() => {
		drain();
		S.setLibraryLayout(saved);
		if (envBefore === undefined) delete process.env.ZN_UI_STATE;
		else process.env.ZN_UI_STATE = envBefore;
	});
	beforeEach(() => {
		drain();
		S.setLibraryLayout(standardLibrary());
	});

	test("a move and its undo give back exactly the layout before", () => {
		const before = S.libraryLayout();
		expect(before).toEqual(standardLibrary());
		expect(S.moveLibraryPane("item", tab("centre", 0))).toBe(true);
		expect(S.libraryLayout().centre.stacks).toEqual([{ panes: ["items", "item"], active: "item" }]);
		expect(S.libraryLayout().right.stacks).toEqual([]);
		expect(S.libraryPaneLocation("item")).toEqual({ column: "centre", stack: 0, index: 1 });
		expect(S.canUndoLayout()).toBe(true);
		expect(S.undoLayout()).toBe(true);
		expect(S.libraryLayout()).toEqual(before);
		expect(S.canUndoLayout()).toBe(false);
		expect(S.undoLayout()).toBe(false);
		expect(S.libraryLayout()).toEqual(before);
	});

	test("detach a section, hide it, show it: each undo restores the step before, in order", () => {
		const s0 = S.libraryLayout();
		expect(S.moveLibraryPane("section:tags", split("right", 1))).toBe(true);
		const s1 = S.libraryLayout();
		expect(S.libraryPaneLocation("section:tags")).toEqual({ column: "right", stack: 1, index: 0 });
		S.hideLibraryPane("section:tags", true);
		const s2 = S.libraryLayout();
		expect(s2.hidden).toEqual(["section:tags"]);
		expect(S.libraryPaneLocation("section:tags")).toEqual({ column: "right", stack: 1, index: 0 });
		S.hideLibraryPane("section:tags", false);
		const s3 = S.libraryLayout();
		expect(s3.hidden).toEqual([]);
		expect(s3).toEqual(s1);
		expect(S.undoLayout()).toBe(true);
		expect(S.libraryLayout()).toEqual(s2);
		expect(S.undoLayout()).toBe(true);
		expect(S.libraryLayout()).toEqual(s1);
		expect(S.undoLayout()).toBe(true);
		expect(S.libraryLayout()).toEqual(s0);
		expect(S.libraryPaneLocation("section:tags")).toBeNull();
		expect(S.undoLayout()).toBe(false);
	});

	test("returning a section to the item pane is a move too, and undoes", () => {
		expect(S.moveLibraryPane("section:tags", tab("right", 0))).toBe(true);
		const placed = S.libraryLayout();
		expect(S.moveLibraryPane("section:tags", { kind: "section" })).toBe(true);
		expect(S.libraryPaneLocation("section:tags")).toBeNull();
		expect(S.libraryLayout()).toEqual(standardLibrary());
		expect(S.undoLayout()).toBe(true);
		expect(S.libraryLayout()).toEqual(placed);
	});

	test("a refused move (the centre's only pane) returns false and leaves no undo entry", () => {
		const before = S.libraryLayout();
		for (const to of [tab("right", 0), tab("right", 0, 0), split("right", 0), split("right", 1), split("centre", 0)]) {
			expect(S.moveLibraryPane("items", to)).toBe(false);
		}
		expect(S.moveLibraryPane("items", { kind: "section" })).toBe(false);
		expect(S.moveLibraryPane("item", split("centre", 5))).toBe(false); // a target that does not exist
		expect(S.moveLibraryPane("item", split("right", NaN))).toBe(false);
		expect(S.libraryLayout()).toEqual(before);
		expect(S.canUndoLayout()).toBe(false);
		expect(S.undoLayout()).toBe(false);
	});

	test("a pane the library does not know cannot be placed", () => {
		const before = S.libraryLayout();
		for (const id of ["gone", "notes", "", "section:nope", "__proto__"]) {
			expect(S.moveLibraryPane(id, tab("right", 0))).toBe(false);
			expect(S.moveLibraryPane(id, split("centre", 0))).toBe(false);
		}
		expect(S.libraryLayout()).toEqual(before);
		expect(S.canUndoLayout()).toBe(false);
	});

	test("a plugin pane that is not registered is placed as a ghost, and undoes", () => {
		expect(S.moveLibraryPane("plugin:x:graph", split("right", 1))).toBe(true);
		expect(S.libraryPaneLocation("plugin:x:graph")).toEqual({ column: "right", stack: 1, index: 0 });
		expect(S.undoLayout()).toBe(true);
		expect(S.libraryPaneLocation("plugin:x:graph")).toBeNull();
	});

	test("hiding what cannot be hidden, and showing what is shown, leave no undo entry", () => {
		const before = S.libraryLayout();
		S.hideLibraryPane("items", true); // required
		S.hideLibraryPane("items", false);
		S.hideLibraryPane("gone", true); // unknown
		S.hideLibraryPane("gone", false);
		S.hideLibraryPane("section:tags", true); // known but not in the layout
		S.hideLibraryPane("section:tags", false);
		S.hideLibraryPane("item", false); // already shown
		expect(S.canUndoLayout()).toBe(false);
		expect(S.libraryLayout()).toEqual(before);
		S.hideLibraryPane("item", true);
		expect(S.libraryLayout().hidden).toEqual(["item"]);
		expect(S.rightOpen()).toBe(false);
		S.hideLibraryPane("item", true); // already hidden
		expect(drain()).toBe(1);
		expect(S.libraryLayout()).toEqual(before);
	});

	test("hiding keeps the pane's place: column, stack and tab", () => {
		S.moveLibraryPane("section:tags", tab("right", 0));
		S.moveLibraryPane("section:abstract", split("centre", 1));
		const where = (id: string) => S.libraryPaneLocation(id);
		const stacks = () => structuredClone([S.libraryLayout().centre.stacks, S.libraryLayout().right.stacks]);
		const [tags, abstract, stacksBefore] = [where("section:tags"), where("section:abstract"), stacks()];
		S.hideLibraryPane("section:tags", true);
		S.hideLibraryPane("section:abstract", true);
		expect(S.libraryLayout().hidden).toEqual(["section:tags", "section:abstract"]);
		expect(where("section:tags")).toEqual(tags);
		expect(where("section:abstract")).toEqual(abstract);
		expect(stacks()).toEqual(stacksBefore);
		S.hideLibraryPane("section:tags", false);
		expect(where("section:tags")).toEqual(tags);
		expect(S.libraryLayout().hidden).toEqual(["section:abstract"]);
		expect(stacks()).toEqual(stacksBefore);
	});

	test("activating a pane is not undoable, and shows a hidden one (setStackActive)", () => {
		const s0 = S.libraryLayout();
		S.moveLibraryPane("section:tags", tab("right", 0));
		expect(S.libraryLayout().right.stacks).toEqual([{ panes: ["item", "section:tags"], active: "section:tags" }]);
		S.hideLibraryPane("item", true);
		expect(S.rightOpen()).toBe(false);
		S.activateLibraryPane("item");
		expect(S.libraryLayout().right.stacks).toEqual([{ panes: ["item", "section:tags"], active: "item" }]);
		expect(S.libraryLayout().hidden).toEqual([]);
		expect(S.rightOpen()).toBe(true);
		S.activateLibraryPane("gone"); // not in the layout
		S.activateLibraryPane("item"); // already active and shown
		expect(S.libraryLayout().right.stacks[0]!.active).toBe("item");
		expect(drain()).toBe(2); // the move and the hide; the activations left nothing
		expect(S.libraryLayout()).toEqual(s0);
	});

	test("activating changes the tab only: no move, no history", () => {
		S.moveLibraryPane("section:tags", tab("right", 0));
		const placed = S.libraryLayout();
		S.activateLibraryPane("item");
		expect(S.libraryLayout().right.stacks[0]).toEqual({ panes: ["item", "section:tags"], active: "item" });
		expect(S.libraryLayout().right.sizes).toEqual(placed.right.sizes);
		expect(S.libraryLayout().centre).toEqual(placed.centre);
		expect(drain()).toBe(1);
	});

	test("undo keeps the last 20 changes, no more", () => {
		const s0 = S.libraryLayout();
		expect(S.moveLibraryPane("section:tags", split("right", 1))).toBe(true); // change 1
		let afterFirstToggle: ViewLayout | null = null;
		for (let i = 0; i < 21; i++) {
			S.hideLibraryPane("item", i % 2 === 0); // changes 2 to 22, each one a real change
			afterFirstToggle ??= S.libraryLayout();
		}
		expect(drain()).toBe(20);
		// the move and the first toggle fell off the history: the oldest kept entry goes back to the state after that first toggle
		expect(S.libraryLayout()).toEqual(afterFirstToggle!);
		expect(S.libraryLayout()).not.toEqual(s0);
		expect(S.libraryPaneLocation("section:tags")).toEqual({ column: "right", stack: 1, index: 0 });
		expect(S.libraryLayout().hidden).toEqual(["item"]);
		expect(S.canUndoLayout()).toBe(false);
	});

	test("exactly 20 changes can all be undone", () => {
		const s0 = S.libraryLayout();
		for (let i = 0; i < 20; i++) S.hideLibraryPane("item", i % 2 === 0);
		expect(drain()).toBe(20);
		expect(S.libraryLayout()).toEqual(s0);
	});
});

describe("layout actions", () => {
	let S: typeof LayoutStore;
	let saved: ViewLayout;
	let envBefore: string | undefined;
	const action = (id: string) => appActions().find((a) => a.id === id)!;
	const drain = (): void => {
		while (S.undoLayout());
	};

	beforeAll(async () => {
		envBefore = process.env.ZN_UI_STATE;
		process.env.ZN_UI_STATE = "off";
		S = await import("./layout"); // dynamic on purpose: see above
		saved = S.libraryLayout();
	});
	afterAll(() => {
		drain();
		S.setLibraryLayout(saved);
		if (envBefore === undefined) delete process.env.ZN_UI_STATE;
		else process.env.ZN_UI_STATE = envBefore;
	});
	beforeEach(() => {
		drain();
		S.setLibraryLayout(standardLibrary());
	});

	test("the three actions are registered in the Tools menu, with no default shortcut", () => {
		for (const id of ["layout-undo", "layout-reset-sizes", "layout-reset-standard"]) {
			const a = action(id);
			expect(a).toBeDefined();
			expect(a.menu).toBe("tools");
			expect(a.shortcut).toBeUndefined();
			expect(typeof a.label === "function" ? a.label() : a.label).not.toBe("");
		}
	});

	test("Undo layout change: offered only while there is something to undo, and undoes the last change", () => {
		const a = action("layout-undo");
		expect(a.when!()).toBe(false);
		a.run(); // nothing to undo: no effect, no throw
		expect(S.libraryLayout()).toEqual(standardLibrary());
		S.moveLibraryPane("item", tab("centre", 0));
		S.hideLibraryPane("item", true);
		expect(a.when!()).toBe(true);
		a.run();
		expect(S.libraryLayout().hidden).toEqual([]);
		expect(S.libraryPaneLocation("item")).toEqual({ column: "centre", stack: 0, index: 1 });
		expect(a.when!()).toBe(true);
		a.run();
		expect(S.libraryLayout()).toEqual(standardLibrary());
		expect(a.when!()).toBe(false);
	});

	test("Undo layout change does not undo an activation", () => {
		S.moveLibraryPane("section:tags", tab("right", 0));
		S.activateLibraryPane("item");
		action("layout-undo").run();
		expect(S.libraryLayout()).toEqual(standardLibrary());
	});

	test("Reset pane sizes: sizes go back to the defaults, panes stay where they are", () => {
		S.moveLibraryPane("section:tags", split("right", 1));
		const l = S.libraryLayout();
		S.setLibraryLayout({ ...l, sizes: [0.3, 0.4, 0.3], right: { ...l.right, sizes: [0.8, 0.2] }, centre: { ...l.centre, sizes: [1] } });
		expect(S.libraryLayout().sizes).toEqual([0.3, 0.4, 0.3]);
		expect(S.libraryLayout().right.sizes).toEqual([0.8, 0.2]);
		action("layout-reset-sizes").run();
		const r = S.libraryLayout();
		expect(r.sizes).toEqual(STANDARD_SIZES);
		expect(r.right.sizes).toEqual([0.5, 0.5]);
		expect(r.right.stacks).toEqual(l.right.stacks);
		expect(r.centre.stacks).toEqual(l.centre.stacks);
		expect(r.hidden).toEqual(l.hidden);
	});

	test("Reset layout to Standard: panes, sizes, hidden panes and the sidebar all go back", () => {
		S.moveLibraryPane("section:tags", split("right", 1));
		S.moveLibraryPane("item", tab("centre", 0));
		S.hideLibraryPane("section:tags", true);
		S.setLeftOpen(false);
		const l = S.libraryLayout();
		S.setLibraryLayout({ ...l, sizes: [0.1, 0.7, 0.2] });
		expect(S.libraryLayout()).not.toEqual(standardLibrary());
		action("layout-reset-standard").run();
		expect(S.libraryLayout()).toEqual(standardLibrary());
		expect(S.leftOpen()).toBe(true);
		expect(S.rightOpen()).toBe(true);
		expect(S.libraryPaneLocation("section:tags")).toBeNull();
		expect(S.libraryPaneLocation("item")).toEqual({ column: "right", stack: 0, index: 0 });
	});

	test("the reset actions are always offered (no `when`)", () => {
		expect(action("layout-reset-sizes").when).toBeUndefined();
		expect(action("layout-reset-standard").when).toBeUndefined();
	});
});
