// The layout model of docs/developer-guide/layouts.md: a fixed frame per view (left | centre | right), where the left column has
// fixed content (the sidebar) and the centre and right columns hold stacks of panes, one above the other. Pure TS, no UI imports,
// so it is unit- and fuzz-tested on its own (frameLayout.test.ts, frameLayout.fuzz.test.ts). shell/layout.ts persists it.
//
// Phase 1 draws today's window from this model; tab stacks, dragging and presets come later (layouts.md, section 13), but the
// shapes they need (several stacks per column, several panes per stack, hidden panes keeping their place) are already valid here.

export type ViewKind = "library" | "reader";

/** One or more panes sharing a place (drawn as tabs from phase 2; phase 1 draws only the active one). */
export interface Stack {
	panes: string[];
	active: string;
}
/** Stacks top to bottom; `sizes` are their height fractions. */
export interface Column {
	stacks: Stack[];
	sizes: number[];
}
export interface ViewLayout {
	left: { shown: boolean };
	centre: Column;
	right: Column;
	/** left, centre, right: fractions of the width left after the gutters (a hidden column's share is kept for when it returns) */
	sizes: [number, number, number];
	/** pane ids kept in place but not drawn */
	hidden: string[];
}

/** What normalizeLayout needs to know about the registered panes. */
export interface KnownPanes {
	/** every registered pane id for this view */
	ids: readonly string[];
	/** panes the view cannot do without ("items" in the library); they are never hidden or dropped */
	required: readonly string[];
}

/** Ids owned by plugins. When such a pane is not registered (plugin off or not loaded yet) it is kept as a ghost: not drawn, but
 * its place is kept so the pane comes back there. */
export const isPluginPane = (id: string): boolean => id.startsWith("plugin:") || id.startsWith("section:plug:");

export const COLUMN_IDS = ["left", "centre", "right"] as const;
export type ColumnId = (typeof COLUMN_IDS)[number];

/** Sizes of builtin:standard, today's 0.18 / 0.54 / 0.28. */
export const STANDARD_SIZES: [number, number, number] = [0.18, 0.54, 0.28];

const stack = (id: string): Stack => ({ panes: [id], active: id });

/** builtin:standard for the library: sidebar | items | item. */
export function standardLibrary(): ViewLayout {
	return {
		left: { shown: true },
		centre: { stacks: [stack("items")], sizes: [1] },
		right: { stacks: [stack("item")], sizes: [1] },
		sizes: [...STANDARD_SIZES],
		hidden: [],
	};
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Least stored share of a frame column: a sliver is treated as a broken value. */
const MIN_COLUMN = 0.02;
const goodNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > MIN_COLUMN;

/** Positive numbers scaled to sum to 1 (4 decimals); values that already do are only rounded, so normalising twice changes nothing. */
function unit(v: readonly number[]): number[] {
	const sum = v.reduce((a, b) => a + b, 0);
	if (!Number.isFinite(sum) || sum <= 0) return v.map(() => +(1 / v.length).toFixed(4));
	const k = Math.abs(sum - 1) < 1e-3 ? 1 : sum;
	return v.map((x) => +(x / k).toFixed(4));
}

/** `v` scaled to sum to 1, when it is `n` finite numbers above `min` that stay above it once scaled; else null. */
function scaled(v: unknown, n: number, min: number): number[] | null {
	if (!Array.isArray(v) || v.length !== n || !v.every((x) => typeof x === "number" && Number.isFinite(x) && x > min)) return null;
	const u = unit(v as number[]);
	return u.every((x) => x > min) ? u : null;
}

/** Fractions that sum to 1, `n` long; anything invalid gives equal parts. */
function fractions(v: unknown, n: number): number[] {
	if (n === 0) return [];
	return scaled(v, n, 0) ?? Array.from({ length: n }, () => +(1 / n).toFixed(4));
}

/**
 * Any stored value -> a valid layout. Rules (layouts.md, section 5):
 *  - every pane id at most once per view (the centre column is read first); unknown built-in ids are dropped, unregistered
 *    plugin ids kept as ghosts;
 *  - empty stacks are removed; a stack's `active` is one of its panes;
 *  - a missing required pane is added at the top of the centre column, and required panes are never hidden;
 *  - the centre column is never empty while any pane is placed (the right column's first stack moves over);
 *  - sizes are positive fractions summing to 1, one per stack / column.
 */
export function normalizeLayout(value: unknown, known: KnownPanes, fallback: () => ViewLayout = standardLibrary): ViewLayout {
	if (!isObj(value)) value = fallback();
	const v = value as Record<string, unknown>;
	const registered = new Set(known.ids);
	const seen = new Set<string>();
	const keep = (id: unknown): id is string => {
		if (typeof id !== "string" || seen.has(id)) return false;
		if (!registered.has(id) && !isPluginPane(id)) return false;
		seen.add(id);
		return true;
	};
	const column = (c: unknown): Column => {
		const cv = isObj(c) ? c : {};
		const rawStacks = Array.isArray(cv.stacks) ? cv.stacks : [];
		const rawSizes = Array.isArray(cv.sizes) ? cv.sizes : [];
		const stacks: Stack[] = [];
		const sizes: unknown[] = [];
		rawStacks.forEach((s, i) => {
			const sv = isObj(s) ? s : {};
			const panes = (Array.isArray(sv.panes) ? sv.panes : []).filter(keep);
			if (!panes.length) return;
			const active = typeof sv.active === "string" && panes.includes(sv.active) ? sv.active : panes[0]!;
			stacks.push({ panes, active });
			sizes.push(rawSizes[i]);
		});
		return { stacks, sizes: sizes as number[] };
	};
	const centre = column(v.centre);
	const right = column(v.right);

	// required panes that are missing go on top of the centre column
	const missing = known.required.filter((id) => registered.has(id) && !seen.has(id));
	for (const id of [...missing].reverse()) {
		seen.add(id);
		centre.stacks.unshift(stack(id));
	}
	if (missing.length) centre.sizes = []; // re-split evenly below
	if (!centre.stacks.length && right.stacks.length) {
		centre.stacks.push(right.stacks.shift()!);
		centre.sizes = [];
		right.sizes = [];
	}
	centre.sizes = fractions(centre.sizes, centre.stacks.length);
	right.sizes = fractions(right.sizes, right.stacks.length);

	const required = new Set(known.required);
	const hidden = [...new Set((Array.isArray(v.hidden) ? v.hidden : []).filter((h): h is string => typeof h === "string"))].filter(
		(h) => seen.has(h) && !required.has(h),
	);
	const left = isObj(v.left) && typeof v.left.shown === "boolean" ? { shown: v.left.shown } : { shown: true };
	const sizes = (scaled(v.sizes, 3, MIN_COLUMN) ?? fallback().sizes) as [number, number, number];
	return { left, centre, right, sizes, hidden };
}

// ---- what is drawn ---------------------------------------------------------------------------------------------------------

/** A pane is drawn when it is registered (not a ghost) and not hidden. */
export function paneShown(l: ViewLayout, id: string, registered: ReadonlySet<string>): boolean {
	return registered.has(id) && !l.hidden.includes(id);
}

/** The pane a stack shows: its active one when that is shown, else its first shown pane; null when none is. */
export function stackFace(l: ViewLayout, s: Stack, registered: ReadonlySet<string>): string | null {
	if (paneShown(l, s.active, registered)) return s.active;
	return s.panes.find((id) => paneShown(l, id, registered)) ?? null;
}

/** The stacks of a column that draw something, with their faces and height fractions (renormalised over those drawn). */
export function drawnStacks(l: ViewLayout, c: Column, registered: ReadonlySet<string>): { face: string; size: number }[] {
	const out: { face: string; size: number }[] = [];
	c.stacks.forEach((s, i) => {
		const face = stackFace(l, s, registered);
		if (face) out.push({ face, size: c.sizes[i] ?? 0 });
	});
	const sum = out.reduce((a, b) => a + b.size, 0) || 1;
	return out.map((x) => ({ ...x, size: x.size / sum }));
}

/** The frame columns that are drawn, left to right. The centre is always drawn. */
export function drawnColumns(l: ViewLayout, registered: ReadonlySet<string>): ColumnId[] {
	const out: ColumnId[] = [];
	if (l.left.shown) out.push("left");
	out.push("centre");
	if (drawnStacks(l, l.right, registered).length) out.push("right");
	return out;
}

// ---- edits (each returns a new layout; callers normalise what they store) ---------------------------------------------------

export function setLeftShown(l: ViewLayout, shown: boolean): ViewLayout {
	return { ...l, left: { shown } };
}

/** Show or hide a pane in place. Required panes stay shown (normalizeLayout enforces it). */
export function setPaneHidden(l: ViewLayout, id: string, hide: boolean): ViewLayout {
	const hidden = l.hidden.filter((h) => h !== id);
	if (hide) hidden.push(id);
	return { ...l, hidden };
}

/** The same panes, with the frame and every column back to the preset's sizes (equal heights in a column). */
export function resetSizes(l: ViewLayout, sizes: [number, number, number] = STANDARD_SIZES): ViewLayout {
	const even = (c: Column): Column => ({ ...c, sizes: fractions(undefined, c.stacks.length) });
	return { ...l, sizes: [...sizes], centre: even(l.centre), right: even(l.right) };
}

// ---- migration from the fixed layout ---------------------------------------------------------------------------------------

/**
 * The library layout from the keys the fixed layout stored (layouts.md, section 12): `shell.panelLeft` / `shell.panelRight`
 * (sidebar / item pane shown) and `shell.cols.<11|10|01|00>` (column fractions per visibility combination; only the current
 * combination's sizes are carried over). `get` reads a stored key.
 */
export function migrateLegacyLibrary(get: (key: string) => unknown): ViewLayout {
	const l = standardLibrary();
	const leftShown = get("shell.panelLeft") !== false;
	const rightShown = get("shell.panelRight") !== false;
	l.left.shown = leftShown;
	if (!rightShown) l.hidden.push("item");
	const k = `${+leftShown}${+rightShown}`;
	const want = { "11": 3, "10": 2, "01": 2, "00": 1 }[k]!;
	const cols = get(`shell.cols.${k}`);
	if (!(Array.isArray(cols) && cols.length === want && cols.every(goodNum))) return l;
	const c = unit(cols as number[]);
	const [l0, , r0] = STANDARD_SIZES;
	if (k === "11") l.sizes = [c[0]!, c[1]!, c[2]!];
	// a hidden column keeps its default share; the drawn ones split the rest as they were stored
	else if (k === "10") l.sizes = [c[0]! * (1 - r0), c[1]! * (1 - r0), r0];
	else if (k === "01") l.sizes = [l0, c[0]! * (1 - l0), c[1]! * (1 - l0)];
	l.sizes = unit(l.sizes) as [number, number, number];
	if (!l.sizes.every(goodNum)) l.sizes = [...STANDARD_SIZES]; // a sliver normalizeLayout would reject anyway
	return l;
}

// ---- moving panes (phase 2) -------------------------------------------------------------------------------------------------

/** Where a pane can be put. Indexes refer to the layout as it is BEFORE the move. */
export type DropTarget =
	/** into an existing stack as a tab, at `index` among its panes (default: last) */
	| { kind: "tab"; column: "centre" | "right"; stack: number; index?: number }
	/** a new stack of its own, inserted at position `at` of the column (0 = top; stacks.length = bottom) */
	| { kind: "split"; column: "centre" | "right"; at: number }
	/** back into the item pane (only for `section:` panes): the pane leaves the layout */
	| { kind: "section" };

export interface PaneLocation {
	column: "centre" | "right";
	stack: number;
	index: number;
}

/** Item pane sections as panes: "section:<section id>" (built-in ids from shell/sidebarLayout.ts RIGHT_PARTS, or "plug:<plugin>:<id>"). */
export const sectionPaneId = (sectionId: string): string => `section:${sectionId}`;
export const isSectionPane = (id: string): boolean => id.startsWith("section:");
export const sectionIdOf = (paneId: string): string | null => (isSectionPane(paneId) ? paneId.slice("section:".length) : null);

/** Where a pane is placed, or null when it is not in the layout. */
export function locatePane(l: ViewLayout, id: string): PaneLocation | null {
	for (const column of ["centre", "right"] as const) {
		const stacks = l[column].stacks;
		for (let stack = 0; stack < stacks.length; stack++) {
			const index = stacks[stack]!.panes.indexOf(id);
			if (index >= 0) return { column, stack, index };
		}
	}
	return null;
}

/** Whether `movePane` would do anything for this move. */
export function canMove(l: ViewLayout, id: string, to: DropTarget): boolean {
	const from = locatePane(l, id);
	if (to.kind === "section") return isSectionPane(id) && from !== null;
	const col = l[to.column];
	if (to.kind === "tab" && !col.stacks[to.stack]) return false;
	if (to.kind === "split" && (to.at < 0 || to.at > col.stacks.length)) return false;
	if (!from) return true; // a pane placed for the first time (a section being detached)
	// the centre column is never left empty
	if (from.column === "centre" && to.column !== "centre") {
		const centre = l.centre.stacks;
		if (centre.length === 1 && centre[0]!.panes.length === 1) return false;
	}
	// a pane alone in its stack, dropped next to itself, changes nothing
	const alone = l[from.column].stacks[from.stack]!.panes.length === 1;
	if (to.kind === "split" && alone && to.column === from.column && (to.at === from.stack || to.at === from.stack + 1)) return false;
	if (to.kind === "tab" && to.column === from.column && to.stack === from.stack && alone) return false;
	return true;
}

/**
 * The layout with pane `id` moved to `to` (or placed there, if it was not in the layout). The moved pane becomes its stack's
 * active pane and is shown. A stack left empty is removed and its height goes to the others; a new stack takes an equal share.
 * Returns `l` itself when the move is not allowed (canMove). Callers store the result through normalizeLayout.
 */
export function movePane(l: ViewLayout, id: string, to: DropTarget): ViewLayout {
	if (!canMove(l, id, to)) return l;
	const from = locatePane(l, id);
	const cols = {
		centre: { stacks: l.centre.stacks.map((s) => ({ panes: [...s.panes], active: s.active })), sizes: [...l.centre.sizes] },
		right: { stacks: l.right.stacks.map((s) => ({ panes: [...s.panes], active: s.active })), sizes: [...l.right.sizes] },
	};
	// the target stack, by reference, so removing the source stack does not shift it
	const targetStack = to.kind === "tab" ? cols[to.column].stacks[to.stack]! : null;
	let splitAt = to.kind === "split" ? to.at : 0;
	let tabIndex = to.kind === "tab" ? (to.index ?? targetStack!.panes.length) : 0;

	if (from) {
		const col = cols[from.column];
		const s = col.stacks[from.stack]!;
		s.panes.splice(from.index, 1);
		if (targetStack === s && from.index < tabIndex) tabIndex--;
		if (s.active === id) s.active = s.panes[Math.min(from.index, s.panes.length - 1)] ?? "";
		if (!s.panes.length) {
			col.stacks.splice(from.stack, 1);
			col.sizes.splice(from.stack, 1);
			if (to.kind === "split" && to.column === from.column && from.stack < to.at) splitAt--;
		}
	}
	if (to.kind === "tab") {
		targetStack!.panes.splice(Math.max(0, Math.min(tabIndex, targetStack!.panes.length)), 0, id);
		targetStack!.active = id;
	} else if (to.kind === "split") {
		const col = cols[to.column];
		const n = col.stacks.length;
		const share = 1 / (n + 1);
		const sum = col.sizes.reduce((a, b) => a + b, 0) || 1;
		col.sizes = col.sizes.map((x) => (x / sum) * (1 - share));
		col.stacks.splice(splitAt, 0, { panes: [id], active: id });
		col.sizes.splice(splitAt, 0, share);
	}
	return { ...l, centre: cols.centre, right: cols.right, hidden: l.hidden.filter((h) => h !== id) };
}

/** The layout with `id` the active (shown) pane of its stack. */
export function setStackActive(l: ViewLayout, id: string): ViewLayout {
	const at = locatePane(l, id);
	if (!at) return l;
	const col = l[at.column];
	const stacks = col.stacks.map((s, i) => (i === at.stack ? { ...s, active: id } : s));
	return { ...l, [at.column]: { ...col, stacks } };
}
