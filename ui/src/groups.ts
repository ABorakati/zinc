// Group headers for the item list and the table. The server lists items sorted with the group field first, and
// /api/items/groups gives each group's size in the same order, so group g covers item indexes
// [start[g], start[g] + count[g]). Views render "rows": a header row per group, then that group's items
// (none while the group is collapsed). Row <-> item index mapping is a binary search over the group starts.
import { createEffect, createMemo, createSignal, on } from "solid-js";
import { api } from "./api";
import { store } from "./store";

export interface Group { value: string | null; label: string; count: number; start: number }
export type Row = { kind: "header"; group: Group; gi: number } | { kind: "item"; index: number };

const label = (by: string, v: string | null) =>
	v === null || v === "" ? (by === "year" ? "No date" : by === "publication" ? "No publication" : "Other") : by === "itemType" ? typeLabel(v) : v;
const typeLabel = (t: string) => t.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

/** Grouped rows over a list of `total()` items; plain item rows when the store is not grouped. */
export function createGroupedRows(total: () => number) {
	const [groups, setGroups] = createSignal<Group[]>([]);
	const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
	const by = () => store.groupBy();
	let seq = 0;

	createEffect(on(() => [store.query(), store.itemsRev(), by()] as const, ([q, , b]) => {
		const s = ++seq;
		if (b === "none" || q.sort !== b) { setGroups([]); return; }
		api.itemGroups(q, b).then((r) => {
			if (s !== seq) return;
			let start = 0;
			setGroups(r.groups.map((g) => { const x = { value: g.value, label: label(b, g.value), count: g.count, start }; start += g.count; return x; }));
		}).catch(() => { if (s === seq) setGroups([]); });
	}));
	// a new grouping starts with every group open
	createEffect(on(by, () => setCollapsed(new Set<string>()), { defer: true }));

	const keyOf = (g: Group) => String(g.value);
	/** The groups only count when they cover the whole list (a stale or failed fetch falls back to plain rows). */
	const active = createMemo(() => {
		const gs = groups();
		return gs.length > 0 && gs[gs.length - 1].start + gs[gs.length - 1].count === total() ? gs : null;
	});
	// rowStart[g] = row of group g's header
	const rowStart = createMemo(() => {
		const gs = active();
		if (!gs) return [] as number[];
		const c = collapsed();
		const out: number[] = [];
		let r = 0;
		for (const g of gs) { out.push(r); r += 1 + (c.has(keyOf(g)) ? 0 : g.count); }
		out.push(r);
		return out;
	});

	/** Last g with a[g] <= x. */
	const floor = (a: number[], x: number, n: number) => {
		let lo = 0, hi = n - 1;
		while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m] <= x) lo = m; else hi = m - 1; }
		return lo;
	};

	return {
		groups: () => active() ?? [],
		grouped: () => !!active(),
		count: () => (active() ? rowStart()[rowStart().length - 1] : total()),
		row(r: number): Row {
			const gs = active();
			if (!gs) return { kind: "item", index: r };
			const gi = floor(rowStart(), r, gs.length);
			const off = r - rowStart()[gi];
			return off === 0 ? { kind: "header", group: gs[gi], gi } : { kind: "item", index: gs[gi].start + off - 1 };
		},
		/** Row showing item `index`, or -1 while its group is collapsed. */
		rowOf(index: number): number {
			const gs = active();
			if (!gs) return index;
			const gi = floor(gs.map((g) => g.start), index, gs.length);
			return collapsed().has(keyOf(gs[gi])) ? -1 : rowStart()[gi] + 1 + index - gs[gi].start;
		},
		isCollapsed: (g: Group) => collapsed().has(keyOf(g)),
		toggle(g: Group) {
			const s = new Set(collapsed());
			if (!s.delete(keyOf(g))) s.add(keyOf(g));
			setCollapsed(s);
		},
	};
}
export type GroupedRows = ReturnType<typeof createGroupedRows>;
