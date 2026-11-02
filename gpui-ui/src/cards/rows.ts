// Header + item rows over the store's year groups (ui/src/groups.ts createGroupedRows, with the groups coming from the store).
// Group g covers item indexes [start, start + count); a collapsed group shows only its header row.
import { createEffect, createMemo, createSignal, on } from "solid-js";
import { store } from "../store";

export interface Group { value: string | null; label: string; count: number; start: number }
export type Row = { kind: "header"; group: Group } | { kind: "item"; index: number };

const typeLabel = (t: string) => t.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
/** Group header text (ui/src/groups.ts label): depends on what the list is grouped by. */
const label = (by: string, v: string | null) =>
	v === null || v === "" ? (by === "year" ? "No date" : by === "publication" ? "No publication" : "Other") : by === "itemType" ? typeLabel(v) : v;
const keyOf = (g: Group) => String(g.value);

export function createRows() {
	const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
	// a new grouping starts with every group open
	createEffect(on(() => store.groupBy(), () => setCollapsed(new Set<string>()), { defer: true }));

	/** Groups only count when they cover the whole list (a stale / missing fetch falls back to plain item rows). */
	const active = createMemo<Group[] | null>(() => {
		const raw = store.groups();
		store.listVersion();
		if (!raw.length) return null;
		const by = store.groupBy();
		let start = 0;
		const gs = raw.map((g) => { const x = { value: g.value, label: label(by, g.value), count: g.count, start }; start += g.count; return x; });
		return start === store.total() ? gs : null;
	});
	/** rowStart[g] = row index of group g's header; last entry = total rows. */
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
		while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m]! <= x) lo = m; else hi = m - 1; }
		return lo;
	};
	const starts = createMemo(() => (active() ?? []).map((g) => g.start));

	return {
		count: () => { const rs = rowStart(); return active() ? rs[rs.length - 1]! : store.total(); },
		row(r: number): Row | undefined {
			const gs = active();
			if (!gs) return r >= 0 && r < store.total() ? { kind: "item", index: r } : undefined;
			const rs = rowStart();
			if (r < 0 || r >= rs[rs.length - 1]!) return undefined;
			const gi = floor(rs, r, gs.length);
			const off = r - rs[gi]!;
			return off === 0 ? { kind: "header", group: gs[gi]! } : { kind: "item", index: gs[gi]!.start + off - 1 };
		},
		isCollapsed: (g: Group) => collapsed().has(keyOf(g)),
		toggle(g: Group) {
			const s = new Set(collapsed());
			if (!s.delete(keyOf(g))) s.add(keyOf(g));
			setCollapsed(s);
		},
		/** Row showing item `index`, or -1 while its group is collapsed. */
		rowOf(index: number): number {
			const gs = active();
			if (!gs) return index;
			const gi = floor(starts(), index, gs.length);
			return collapsed().has(keyOf(gs[gi]!)) ? -1 : rowStart()[gi]! + 1 + index - gs[gi]!.start;
		},
	};
}
export type Rows = ReturnType<typeof createRows>;
