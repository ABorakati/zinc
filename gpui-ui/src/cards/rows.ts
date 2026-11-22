// Header + item rows over the store's year groups (ui/src/groups.ts createGroupedRows, with the groups coming from the store).
// Group g covers item indexes [start, start + count); a collapsed group shows only its header row.
import { createEffect, createMemo, createSignal, on } from "solid-js";
import type { ChildSummary } from "../api";
import { store } from "../store";
import { childrenOf, hasChildren, openKeys } from "./children";
import { flatten, sameOpened, type Opened } from "./flatten";

export interface Group {
	value: string | null;
	label: string;
	count: number;
	start: number;
}
type BaseRow = { kind: "header"; group: Group } | { kind: "item"; index: number };
/** A child row of an opened item: `child` is null until the item's children have loaded (a placeholder row meanwhile). */
export type ChildRow = {
	kind: "child";
	parentKey: string;
	parentIndex: number;
	pos: number;
	last: boolean;
	child: ChildSummary | null;
};
export type Row = BaseRow | ChildRow;

/** Same row content: a memo over a row keeps its value (and the row stays mounted) while nothing it shows changed. */
export function sameRow(a: Row | undefined, b: Row | undefined): boolean {
	if (!a || !b) return a === b;
	if (a.kind === "item") return b.kind === "item" && a.index === b.index;
	if (a.kind === "child")
		return (
			b.kind === "child" &&
			a.parentKey === b.parentKey &&
			a.parentIndex === b.parentIndex &&
			a.pos === b.pos &&
			a.last === b.last &&
			a.child === b.child
		);
	// by what it shows: the groups are new objects after every refresh, and a header must not be mounted again for that
	return (
		b.kind === "header" &&
		a.group.value === b.group.value &&
		a.group.label === b.group.label &&
		a.group.count === b.group.count &&
		a.group.start === b.group.start
	);
}

const typeLabel = (t: string) => t.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
/** Group header text (ui/src/groups.ts label): depends on what the list is grouped by. */
const NONE_LABEL: Record<string, string> = {
	year: "No date",
	publication: "No publication",
	firstAuthor: "No author",
	hasPdf: "No file",
	language: "No language",
	publisher: "No publisher",
	dateAdded: "Unknown",
	dateModified: "Unknown",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2024-03" -> "Mar 2024" (the core's month groups). */
const monthLabel = (v: string) => {
	const m = /^(\d{4})-(\d{2})$/.exec(v);
	return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : v;
};
const label = (by: string, v: string | null) => {
	if (v === null || v === "") return NONE_LABEL[by] ?? "Other";
	if (by === "itemType") return typeLabel(v);
	if (by === "dateAdded" || by === "dateModified") return monthLabel(v);
	if (by === "hasPdf") return v === "0" ? "Has PDF" : "Other file";
	return v;
};
const keyOf = (g: Group) => String(g.value);

export function createRows() {
	const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
	// a new grouping starts with every group open
	createEffect(
		on(
			() => store.groupBy(),
			() => setCollapsed(new Set<string>()),
			{ defer: true },
		),
	);

	/** Groups only count when they cover the whole list (a stale / missing fetch falls back to plain item rows). */
	const active = createMemo<Group[] | null>(() => {
		const raw = store.groups();
		store.listVersion();
		if (!raw.length) return null;
		const by = store.groupBy();
		let start = 0;
		const gs = raw.map((g) => {
			const x = { value: g.value, label: label(by, g.value), count: g.count, start };
			start += g.count;
			return x;
		});
		return start === store.total() ? gs : null;
	});
	/** rowStart[g] = row index of group g's header; last entry = total rows. */
	const rowStart = createMemo(() => {
		const gs = active();
		if (!gs) return [] as number[];
		const c = collapsed();
		const out: number[] = [];
		let r = 0;
		for (const g of gs) {
			out.push(r);
			r += 1 + (c.has(keyOf(g)) ? 0 : g.count);
		}
		out.push(r);
		return out;
	});
	/** Last g with a[g] <= x. */
	const floor = (a: number[], x: number, n: number) => {
		let lo = 0,
			hi = n - 1;
		while (lo < hi) {
			const m = (lo + hi + 1) >> 1;
			if (a[m]! <= x) lo = m;
			else hi = m - 1;
		}
		return lo;
	};
	const starts = createMemo(() => (active() ?? []).map((g) => g.start));

	// ---- base rows: headers + items, before the opened items' children are added ----
	const baseCount = () => {
		const rs = rowStart();
		return active() ? rs[rs.length - 1]! : store.total();
	};
	function baseRow(r: number): BaseRow | undefined {
		const gs = active();
		if (!gs) return r >= 0 && r < store.total() ? { kind: "item", index: r } : undefined;
		const rs = rowStart();
		if (r < 0 || r >= rs[rs.length - 1]!) return undefined;
		const gi = floor(rs, r, gs.length);
		const off = r - rs[gi]!;
		return off === 0 ? { kind: "header", group: gs[gi]! } : { kind: "item", index: gs[gi]!.start + off - 1 };
	}
	function baseRowOf(index: number): number {
		const gs = active();
		if (!gs) return index;
		const gi = floor(starts(), index, gs.length);
		return collapsed().has(keyOf(gs[gi]!)) ? -1 : rowStart()[gi]! + 1 + index - gs[gi]!.start;
	}

	// ---- opened items (children.ts): their child rows follow them ----
	// Re-read when a page arrives (an opened item's row may only now be known) but kept equal unless something it shows changed, so
	// page loads elsewhere do not re-mount the rows.
	const opened = createMemo<Opened<ChildSummary>[]>(
		() => {
			const keys = openKeys();
			if (!keys.size) return [];
			store.pagesLoaded();
			store.listVersion();
			const out: Opened<ChildSummary>[] = [];
			for (const key of keys) {
				const index = store.indexOfKey(key);
				if (index < 0) continue;
				const base = baseRowOf(index);
				const it = store.peek(index);
				if (base < 0 || !it || !hasChildren(it)) continue;
				const kids = childrenOf(key);
				out.push({ key, index, base, count: kids ? kids.length : (it.attachmentCount ?? 0) + (it.noteCount ?? 0), kids });
			}
			return out.sort((a, b) => a.base - b.base);
		},
		[],
		{ equals: sameOpened },
	);
	const flat = createMemo(() => flatten(baseCount(), opened()));
	const toBase = (r: number): number => {
		const a = flat().at(r);
		return "base" in a ? a.base : a.opened.base;
	};

	/** Row of child `pos` of the opened item `parentKey`, or -1. */
	const childRow = (parentKey: string, pos: number): number => {
		const r = flat().rowOfOpened(parentKey);
		return r < 0 ? -1 : r + 1 + pos;
	};

	return {
		count: () => flat().count,
		row(r: number): Row | undefined {
			if (r < 0 || r >= flat().count) return undefined;
			const a = flat().at(r);
			if ("base" in a) return baseRow(a.base);
			const o = a.opened;
			return {
				kind: "child",
				parentKey: o.key,
				parentIndex: o.index,
				pos: a.pos,
				last: a.pos === o.count - 1,
				child: o.kids?.[a.pos] ?? null,
			};
		},
		/** The group row `r` belongs to (its header, one of its items or their children); undefined when the list is not grouped. */
		groupAt(r: number): Group | undefined {
			const gs = active();
			if (!gs) return undefined;
			const b = toBase(r);
			const rs = rowStart();
			if (b < 0 || b >= rs[rs.length - 1]!) return undefined;
			return gs[floor(rs, b, gs.length)];
		},
		isCollapsed: (g: Group) => collapsed().has(keyOf(g)),
		toggle(g: Group) {
			const s = new Set(collapsed());
			if (!s.delete(keyOf(g))) s.add(keyOf(g));
			setCollapsed(s);
		},
		/** Row showing item `index`, or -1 while its group is collapsed. */
		rowOf(index: number): number {
			const b = baseRowOf(index);
			return b < 0 ? -1 : flat().fromBase(b);
		},
		childRow,
		/** Row of the child with key `childKey` under `parentKey` (once its children have loaded), or -1. */
		childRowByKey(parentKey: string, childKey: string): number {
			const o = opened().find((x) => x.key === parentKey);
			const pos = o?.kids?.findIndex((c) => c.key === childKey) ?? -1;
			return pos < 0 ? -1 : childRow(parentKey, pos);
		},
	};
}
export type Rows = ReturnType<typeof createRows>;
