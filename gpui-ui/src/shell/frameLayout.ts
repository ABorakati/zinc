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
