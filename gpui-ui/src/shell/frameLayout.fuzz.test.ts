// Fuzz: the layout model (frameLayout.ts). Any stored value (a hand-edited or older ui-state.json) must normalise to one valid
// layout without throwing: every pane once, required panes placed and shown, sizes that sum to 1, a non-empty centre, and
// normalising again changing nothing. Edits (show/hide, sizes) must keep those rules after normalising.
import { describe, expect } from "bun:test";
import { fc, fuzz } from "../fuzzHarness";
import {
	drawnColumns,
	migrateLegacyLibrary,
	normalizeLayout,
	setLeftShown,
	setPaneHidden,
	type KnownPanes,
	type ViewLayout,
} from "./frameLayout";

const KNOWN: KnownPanes = { ids: ["items", "item", "notes", "section:tags"], required: ["items"] };
// registered ids, plugin ghosts, unknown built-ins, and names that collide with Object.prototype members
const ID_POOL = [...KNOWN.ids, "plugin:a:graph", "section:plug:a:refs", "gone", "", "__proto__", "constructor", "toString"];

const id = fc.oneof(fc.constantFrom(...ID_POOL), fc.string({ maxLength: 4 }));
const num = fc.oneof(fc.double({ noNaN: false }), fc.constantFrom(0, -1, 0.01, 0.5, 1, 1e308, Infinity), fc.integer());
const junk = fc.oneof(fc.constant(null), fc.constant(undefined), fc.string({ maxLength: 3 }), fc.boolean(), num);
const stackArb = fc.oneof(fc.record({ panes: fc.array(fc.oneof(id, junk), { maxLength: 4 }), active: fc.oneof(id, junk) }, { requiredKeys: [] }), junk);
const columnArb = fc.oneof(
	fc.record({ stacks: fc.oneof(fc.array(stackArb, { maxLength: 4 }), junk), sizes: fc.oneof(fc.array(num, { maxLength: 5 }), junk) }, { requiredKeys: [] }),
	junk,
);
const layoutArb = fc.oneof(
	fc.record(
		{
			left: fc.oneof(fc.record({ shown: fc.oneof(fc.boolean(), junk) }), junk),
			centre: columnArb,
			right: columnArb,
			sizes: fc.oneof(fc.array(num, { maxLength: 4 }), junk),
			hidden: fc.oneof(fc.array(fc.oneof(id, junk), { maxLength: 5 }), junk),
		},
		{ requiredKeys: [] },
	),
	junk,
	fc.anything(),
);

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

function checkValid(l: ViewLayout): void {
	const placed = [...l.centre.stacks, ...l.right.stacks].flatMap((s) => s.panes);
	expect(new Set(placed).size).toBe(placed.length);
	for (const pid of placed) expect(KNOWN.ids.includes(pid) || pid.startsWith("plugin:") || pid.startsWith("section:plug:")).toBe(true);
	for (const r of KNOWN.required) {
		expect(placed).toContain(r);
		expect(l.hidden).not.toContain(r);
	}
	expect(l.centre.stacks.length).toBeGreaterThan(0);
	for (const c of [l.centre, l.right]) {
		expect(c.sizes.length).toBe(c.stacks.length);
		for (const s of c.stacks) {
			expect(s.panes.length).toBeGreaterThan(0);
			expect(s.panes).toContain(s.active);
		}
		if (c.sizes.length) {
			expect(c.sizes.every((n) => Number.isFinite(n) && n > 0)).toBe(true);
			expect(Math.abs(sum(c.sizes) - 1)).toBeLessThan(2e-3);
		}
	}
	expect(l.sizes).toHaveLength(3);
	expect(l.sizes.every((n) => Number.isFinite(n) && n > 0)).toBe(true);
	expect(Math.abs(sum(l.sizes) - 1)).toBeLessThan(2e-3);
	for (const h of l.hidden) expect(placed).toContain(h);
	expect(typeof l.left.shown).toBe("boolean");
	expect(drawnColumns(l, new Set(KNOWN.ids))).toContain("centre");
}

describe("frame layout fuzz", () => {
	fuzz("any stored value normalises to a valid layout, and normalising again changes nothing", [layoutArb], (v) => {
		const l = normalizeLayout(v, KNOWN);
		checkValid(l);
		expect(normalizeLayout(l, KNOWN)).toEqual(l);
		expect(normalizeLayout(JSON.parse(JSON.stringify(l)), KNOWN)).toEqual(l); // survives the ui-state.json round trip
	});

	fuzz(
		"show/hide edits and size changes stay valid",
		[layoutArb, fc.array(fc.tuple(fc.constantFrom(...ID_POOL, "left"), fc.boolean()), { maxLength: 8 })],
		(v, edits) => {
			let l = normalizeLayout(v, KNOWN);
			for (const [target, on] of edits) {
				l = normalizeLayout(target === "left" ? setLeftShown(l, on) : setPaneHidden(l, target, !on), KNOWN);
				checkValid(l);
			}
		},
	);

	fuzz("migration from any old keys gives a valid layout", [junk, junk, fc.oneof(fc.array(num, { maxLength: 4 }), junk)], (left, right, cols) => {
		const keys: Record<string, unknown> = { "shell.panelLeft": left, "shell.panelRight": right };
		for (const k of ["11", "10", "01", "00"]) keys[`shell.cols.${k}`] = cols;
		const l = migrateLegacyLibrary((k) => keys[k]);
		checkValid(normalizeLayout(l, KNOWN));
		expect(normalizeLayout(l, KNOWN)).toEqual(l);
	});
});
