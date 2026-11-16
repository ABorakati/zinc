// Child rows (attachments / notes) of opened items, flattened into the list's rows. Pure: rows.ts feeds it the rows the list has
// without children (headers + items, "base rows") and the opened items; the views' <virtual-list> then gets exactly one entry per
// row, children included (its children must be exactly the entries, see sidebar/parts.tsx Entry).
//
//   base rows:  H  a  b  c  H  d          opened: b (2 children)
//   rows:       H  a  b  b1 b2 c  H  d

/** One opened item: its item index, its base row and how many child rows follow it. */
export interface Opened<K = unknown> {
	key: string;
	index: number;
	base: number;
	count: number;
	/** the children once loaded (null: placeholder rows meanwhile) */
	kids: readonly K[] | null;
}

export type FlatAt<K = unknown> = { base: number } | { opened: Opened<K>; pos: number };

export interface Flat<K = unknown> {
	/** rows including the child rows */
	count: number;
	/** What row `r` is: base row `base`, or child `pos` of an opened item. */
	at(r: number): FlatAt<K>;
	/** Row of base row `b`. */
	fromBase(b: number): number;
	/** Row of the opened item `key` (its own row, the children follow it), or -1. */
	rowOfOpened(key: string): number;
}

/** Last i with f(i) true for a monotone f (true..true false..false), or -1. */
function lastTrue(n: number, f: (i: number) => boolean): number {
	let lo = 0,
		hi = n - 1,
		ans = -1;
	while (lo <= hi) {
		const m = (lo + hi) >> 1;
		if (f(m)) {
			ans = m;
			lo = m + 1;
		} else hi = m - 1;
	}
	return ans;
}

/**
 * Rows of a list with `baseCount` base rows and the opened items `opened` (any order; entries with count 0 or a base row
 * outside the list are ignored). Lookups are O(log n) in the number of opened items.
 */
export function flatten<K>(baseCount: number, opened: readonly Opened<K>[]): Flat<K> {
	const os = opened.filter((o) => o.count > 0 && o.base >= 0 && o.base < baseCount).sort((a, b) => a.base - b.base);
	// before[i]: child rows above opened item i; top(i): its own row
	const before: number[] = [];
	let sum = 0;
	for (const o of os) {
		before.push(sum);
		sum += o.count;
	}
	const top = (i: number) => os[i]!.base + before[i]!;
	return {
		count: baseCount + sum,
		at(r) {
			// the last opened item whose own row is above r
			const i = lastTrue(os.length, (j) => top(j) < r);
			if (i < 0) return { base: r };
			const o = os[i]!,
				d = r - top(i);
			if (d <= o.count) return { opened: o, pos: d - 1 };
			return { base: r - before[i]! - o.count };
		},
		fromBase(b) {
			const i = lastTrue(os.length, (j) => os[j]!.base < b);
			return i < 0 ? b : b + before[i]! + os[i]!.count;
		},
		rowOfOpened(key) {
			const i = os.findIndex((o) => o.key === key);
			return i < 0 ? -1 : top(i);
		},
	};
}

/** What the focused row is, for the tree keys. */
export type TreeFocus = { kind: "item"; key: string; hasKids: boolean; open: boolean } | { kind: "child"; parentKey: string } | null;
export type TreeAction =
	| { kind: "open"; key: string }
	| { kind: "close"; key: string }
	| { kind: "firstChild"; key: string }
	| { kind: "parent"; key: string }
	| { kind: "openAll" }
	| { kind: "closeAll" };

/**
 * Zotero's tree keys: Right opens the item (or, when open, moves to its first child), Left closes it (or, on a child, moves to
 * the parent), + opens every item in view, - closes them all. null: not a tree key here.
 */
export function treeKeyAction(key: string, keyChar: string | undefined, focus: TreeFocus): TreeAction | null {
	const k = key.toLowerCase();
	if (k === "+" || keyChar === "+" || k === "plus" || k === "=" || k === "equals" || k === "add") return { kind: "openAll" };
	if (k === "-" || keyChar === "-" || k === "minus" || k === "subtract") return { kind: "closeAll" };
	if (!focus) return null;
	if (k === "right") {
		if (focus.kind !== "item" || !focus.hasKids) return null;
		return focus.open ? { kind: "firstChild", key: focus.key } : { kind: "open", key: focus.key };
	}
	if (k === "left") {
		if (focus.kind === "child") return { kind: "parent", key: focus.parentKey };
		return focus.open ? { kind: "close", key: focus.key } : null;
	}
	return null;
}

/** Same opened items, counts and loaded children (a memo keeps its value, so the rows do not re-mount on unrelated page loads). */
export function sameOpened<K>(a: readonly Opened<K>[], b: readonly Opened<K>[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i]!,
			y = b[i]!;
		if (x.key !== y.key || x.index !== y.index || x.base !== y.base || x.count !== y.count || x.kids !== y.kids) return false;
	}
	return true;
}
