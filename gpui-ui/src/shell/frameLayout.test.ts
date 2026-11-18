import { describe, expect, test } from "bun:test";
import {
	drawnColumns,
	drawnStacks,
	migrateLegacyLibrary,
	normalizeLayout,
	resetSizes,
	setLeftShown,
	setPaneHidden,
	stackFace,
	standardLibrary,
	STANDARD_SIZES,
	type KnownPanes,
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
