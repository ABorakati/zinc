// Fuzz: the layout model (frameLayout.ts). Any stored value (a hand-edited or older ui-state.json) must normalise to one valid
// layout without throwing: every pane once, required panes placed and shown, sizes that sum to 1, a non-empty centre, and
// normalising again changing nothing. Edits (show/hide, sizes) must keep those rules after normalising. Random sequences of
// moves, activations and hides keep them too: movePane / setStackActive give a valid layout without normalising, a move that
// canMove refuses returns the very same object, and nothing ever changes its input.
import { describe, expect } from "bun:test";
import { fc, fuzz } from "../fuzzHarness";
import {
	canMove,
	drawnColumns,
	locatePane,
	migrateLegacyLibrary,
	movePane,
	normalizeLayout,
	setLeftShown,
	setPaneHidden,
	setStackActive,
	type DropTarget,
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

// ---- moves, activations and hides ------------------------------------------------------------------------------------------

const POOL_PANES = [...KNOWN.ids, "plugin:a:graph", "section:plug:a:refs"];
const poolPane = fc.constantFrom(...POOL_PANES);
const richStack = fc.tuple(fc.array(poolPane, { minLength: 1, maxLength: 3 }), fc.nat(2)).map(([panes, i]) => ({ panes, active: panes[i % panes.length]! }));
const richColumn = fc.array(richStack, { maxLength: 3 }).chain((stacks) =>
	fc
		.array(fc.double({ min: 0.02, max: 1, noNaN: true }), { minLength: stacks.length, maxLength: stacks.length })
		.map((sizes) => ({ stacks, sizes })),
);
/** layouts with several stacks of several panes, which the arbitrary junk above rarely builds */
const richLayoutArb = fc.record({ centre: richColumn, right: richColumn, hidden: fc.array(poolPane, { maxLength: 4 }) });

// mostly real columns; sometimes a column that is not one (the left frame column, Object.prototype names)
const colId = fc.oneof(
	{ weight: 8, arbitrary: fc.constantFrom<"centre" | "right">("centre", "right") },
	{ weight: 1, arbitrary: fc.constantFrom("left", "constructor", "__proto__") as unknown as fc.Arbitrary<"centre"> },
);
const place = fc.oneof({ weight: 8, arbitrary: fc.nat(3) }, { weight: 1, arbitrary: fc.constantFrom(-1, 4, NaN, 0.5, -0.5, Infinity) });
const targetArb: fc.Arbitrary<DropTarget> = fc.oneof(
	fc
		.tuple(colId, place, fc.option(place, { nil: undefined }))
		.map(([column, stack, index]): DropTarget => (index === undefined ? { kind: "tab", column, stack } : { kind: "tab", column, stack, index })),
	fc.tuple(colId, place).map(([column, at]): DropTarget => ({ kind: "split", column, at })),
	fc.constant<DropTarget>({ kind: "section" }),
);
const paneId = fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...POOL_PANES) }, { weight: 1, arbitrary: fc.constantFrom(...ID_POOL) });
type Op = { op: "move"; id: string; to: DropTarget } | { op: "activate"; id: string } | { op: "hide"; id: string; hide: boolean };
const opArb: fc.Arbitrary<Op> = fc.oneof(
	{ weight: 5, arbitrary: fc.tuple(paneId, targetArb).map(([id, to]): Op => ({ op: "move", id, to })) },
	{ weight: 2, arbitrary: paneId.map((id): Op => ({ op: "activate", id })) },
	{ weight: 2, arbitrary: fc.tuple(paneId, fc.boolean()).map(([id, hide]): Op => ({ op: "hide", id, hide })) },
);

const placedIds = (l: ViewLayout): string[] => [...l.centre.stacks, ...l.right.stacks].flatMap((s) => s.panes);
const isKnownId = (pid: string) => KNOWN.ids.includes(pid) || pid.startsWith("plugin:") || pid.startsWith("section:plug:");
function deepFreeze<T>(v: T): T {
	if (v && typeof v === "object") for (const x of Object.values(v)) deepFreeze(x);
	return Object.freeze(v);
}

/** movePane on `l`: the same object when canMove refuses; otherwise a valid layout, with the pane where `to` says, without normalising */
function checkMove(l: ViewLayout, pid: string, to: DropTarget): ViewLayout {
	const allowed = canMove(l, pid, to);
	const r = movePane(l, pid, to);
	if (!allowed) {
		expect(r).toBe(l);
		return r;
	}
	expect(r).not.toBe(l);
	expect(r.hidden).toEqual(l.hidden.filter((h) => h !== pid));
	expect(r.left).toEqual(l.left);
	expect(r.sizes).toEqual(l.sizes);
	if (!isKnownId(pid) && !placedIds(l).includes(pid)) return r; // normalizeLayout will drop a pane it does not know
	checkValid(r);
	const was = placedIds(l);
	const want = to.kind === "section" ? was.filter((x) => x !== pid) : [...new Set([...was, pid])];
	expect([...placedIds(r)].sort()).toEqual([...want].sort());
	if (to.kind === "section") expect(locatePane(r, pid)).toBeNull();
	else {
		const at = locatePane(r, pid)!;
		expect(at.column).toBe(to.column);
		expect(r[at.column].stacks[at.stack]!.active).toBe(pid);
		if (to.kind === "split") expect(r[at.column].stacks[at.stack]!.panes).toEqual([pid]);
	}
	// the result is where normalizeLayout would leave it
	const n = normalizeLayout(r, KNOWN);
	expect(n.centre.stacks).toEqual(r.centre.stacks);
	expect(n.right.stacks).toEqual(r.right.stacks);
	return r;
}

/** setStackActive on `l`: the same object when it has nothing to do; otherwise only the active pane and the hidden list change */
function checkActivate(l: ViewLayout, pid: string): ViewLayout {
	const at = locatePane(l, pid);
	const r = setStackActive(l, pid);
	if (!at) {
		expect(r).toBe(l);
		return r;
	}
	const already = l[at.column].stacks[at.stack]!.active === pid && !l.hidden.includes(pid);
	if (already) expect(r).toBe(l);
	else expect(r).not.toBe(l);
	expect(r[at.column].stacks[at.stack]!.active).toBe(pid);
	expect(r.hidden).toEqual(l.hidden.filter((h) => h !== pid));
	expect(locatePane(r, pid)).toEqual(at);
	for (const c of ["centre", "right"] as const) {
		expect(r[c].stacks.map((s) => s.panes)).toEqual(l[c].stacks.map((s) => s.panes));
		expect(r[c].sizes).toEqual(l[c].sizes);
	}
	checkValid(r);
	return r;
}

describe("frame layout fuzz: moving panes", () => {
	fuzz(
		"moves, activations and hides from any normalised layout stay valid; a refused move returns the same object; the input never changes",
		[fc.oneof(layoutArb, richLayoutArb), fc.array(opArb, { maxLength: 12 })],
		(v, ops) => {
			let l = normalizeLayout(v, KNOWN);
			checkValid(l);
			for (const op of ops) {
				deepFreeze(l); // a mutation of the input throws
				const before = structuredClone(l);
				const next =
					op.op === "move" ? checkMove(l, op.id, op.to) : op.op === "activate" ? checkActivate(l, op.id) : setPaneHidden(l, op.id, op.hide);
				expect(l).toEqual(before);
				l = normalizeLayout(next, KNOWN);
				checkValid(l);
			}
		},
	);

	fuzz("every target on every layout: canMove never throws and agrees with movePane", [fc.oneof(layoutArb, richLayoutArb), paneId, targetArb], (v, pid, to) => {
		const l = normalizeLayout(v, KNOWN);
		const r = movePane(l, pid, to);
		expect(r === l).toBe(!canMove(l, pid, to));
		expect(movePane(l, pid, to)).toEqual(r); // deterministic
	});
});
