// Column order / visibility / widths for the Classic table (ui/src/columns/layout.ts), persisted in ui-state.json ("columns").
import { createEffect, createMemo, createRoot, createSignal } from "solid-js";
import { uiState } from "../store";
import { DEFAULT_COLUMNS, MENU_COLUMNS, getColumn, isKnownColumn } from "./defs";

const MIN_WIDTH = 28;

interface Saved {
	cols: string[];
	widths: Record<string, number>;
}

function load(): Saved {
	const s = uiState.get<Partial<Saved> | null>("columns", null);
	if (s && Array.isArray(s.cols)) {
		const cols = [...new Set(s.cols.filter((c): c is string => typeof c === "string" && isKnownColumn(c)))];
		if (!cols.includes("title")) cols.unshift("title");
		const widths: Record<string, number> = {};
		for (const [k, w] of Object.entries(s.widths ?? {})) if (typeof w === "number" && w >= MIN_WIDTH && w < 4000) widths[k] = w;
		return { cols, widths };
	}
	return { cols: [...DEFAULT_COLUMNS], widths: {} };
}

export const columnLayout = createRoot(() => {
	const init = load();
	const [ids, setIds] = createSignal<string[]>(init.cols);
	const [widths, setWidths] = createSignal<Record<string, number>>(init.widths);

	createEffect(() => uiState.set("columns", { cols: ids(), widths: widths() } satisfies Saved));

	const columns = createMemo(() => ids().map(getColumn));
	const widthOf = (id: string) => widths()[id] ?? getColumn(id).width;
	/** Zotero data fields the visible columns need, as the `fields=` parameter. */
	const fieldsParam = createMemo(() =>
		[
			...new Set(
				columns()
					.map((c) => c.field)
					.filter((f): f is string => !!f),
			),
		]
			.sort()
			.join(","),
	);

	return {
		ids,
		columns,
		widthOf,
		fieldsParam,
		has: (id: string) => ids().includes(id),
		total: createMemo(() => ids().reduce((n, id) => n + widthOf(id), 0)),
		setWidth(id: string, w: number) {
			const min = id === "title" ? 80 : MIN_WIDTH;
			setWidths((m) => ({ ...m, [id]: Math.round(Math.max(min, w)) }));
		},
		toggle(id: string, on?: boolean) {
			if (id === "title") return; // the title column is always shown
			setIds((c) => {
				const has = c.includes(id);
				if (on === undefined ? has : !on) return has ? c.filter((x) => x !== id) : c;
				return has ? c : [...c, id];
			});
		},
		/** Move `id` so that it ends up at position `index` of the final list. */
		move(id: string, index: number) {
			setIds((c) => {
				const from = c.indexOf(id);
				if (from < 0) return c;
				const next = c.filter((x) => x !== id);
				next.splice(Math.max(0, Math.min(next.length, index)), 0, id);
				return next.every((x, i) => x === c[i]) ? c : next;
			});
		},
		restoreOrder() {
			const rank = (id: string) => {
				const i = MENU_COLUMNS.indexOf(id);
				return i < 0 ? 1e6 : i;
			};
			setIds((c) => [...c].sort((a, b) => rank(a) - rank(b)));
		},
	};
});
