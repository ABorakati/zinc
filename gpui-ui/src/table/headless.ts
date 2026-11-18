// The Classic table's column engine: @tanstack/table-core (headless, no DOM) resolves column order, visibility, sizing (min / max
// clamps) and the sort indicators; rows are NOT handed to it (the list is a sparse server-side cache of up to 100k items), only
// the columns. The state lives in our signals (column layout in table/layout.ts, sort levels in the store); this module feeds
// it to the table and writes the table's change requests back.
import { createComputed, createMemo, createSignal } from "solid-js";
import {
	createTable,
	getCoreRowModel,
	type ColumnDef,
	type ColumnOrderState,
	type ColumnSizingInfoState,
	type ColumnSizingState,
	type SortingState,
	type Table,
	type TableOptionsResolved,
	type VisibilityState,
} from "@tanstack/table-core";
import type { ItemRow } from "../contracts";
import { store } from "../store";
import { getColumn, MENU_COLUMNS, moreColumns, pluginColumns, schema } from "./defs";
import { columnLayout as layout } from "./layout";

const EMPTY_SIZING_INFO: ColumnSizingInfoState = {
	startOffset: null,
	startSize: null,
	deltaOffset: null,
	deltaPercentage: null,
	isResizingColumn: false,
	columnSizingStart: [],
};

export function createColumnTable() {
	const [rev, setRev] = createSignal(0);
	const [sizingInfo, setSizingInfo] = createSignal<ColumnSizingInfoState>(EMPTY_SIZING_INFO);

	/** Every column the table knows: the visible ones in order, then the picker's list and the schema's other fields. */
	const allIds = createMemo(() => {
		schema(); // more columns appear once the schema has loaded
		return [...new Set([...layout.ids(), ...MENU_COLUMNS, ...moreColumns().map((c) => c.id), ...pluginColumns().map((c) => c.id)])];
	});
	const defs = createMemo<ColumnDef<ItemRow>[]>(() =>
		allIds().map((id) => {
			const c = getColumn(id);
			return {
				id,
				header: c.label,
				accessorFn: (row: ItemRow) => c.get(row),
				size: c.width,
				minSize: id === "title" ? 80 : 28,
				maxSize: 4000,
				enableSorting: true,
				enableHiding: id !== "title",
			} satisfies ColumnDef<ItemRow>;
		}),
	);
	/** Sort levels that belong to a column, as the table's SortingState (levels of columns that are not shown are left out). */
	const sorting = createMemo<SortingState>(() => {
		const out: SortingState = [];
		for (const l of store.sortLevels()) {
			const id = allIds().find((i) => getColumn(i).sort === l.key);
			if (id) out.push({ id, desc: l.dir === "desc" });
		}
		return out;
	});

	const state = () => ({
		columnVisibility: Object.fromEntries(allIds().map((id) => [id, layout.has(id)])) as VisibilityState,
		columnOrder: layout.ids().concat(allIds().filter((i) => !layout.has(i))) as ColumnOrderState,
		columnSizing: Object.fromEntries(allIds().map((id) => [id, layout.widthOf(id)])) as ColumnSizingState,
		columnSizingInfo: sizingInfo(),
		sorting: sorting(),
	});

	const options = (): TableOptionsResolved<ItemRow> =>
		({
			data: [], // rows come from the store's page cache
			columns: defs(),
			getCoreRowModel: getCoreRowModel(),
			manualSorting: true,
			columnResizeMode: "onChange",
			state: state(),
			onStateChange: () => {},
			renderFallbackValue: "",
			onColumnVisibilityChange: (u) => {
				const cur = state().columnVisibility;
				const next = typeof u === "function" ? u(cur) : u;
				for (const id of allIds())
					if (id !== "title" && (next[id] !== false) !== layout.has(id)) layout.toggle(id, next[id] !== false);
			},
			onColumnOrderChange: (u) => {
				const cur = state().columnOrder;
				const next = typeof u === "function" ? u(cur) : u;
				next.filter((id) => layout.has(id)).forEach((id, i) => layout.move(id, i));
			},
			onColumnSizingChange: (u) => {
				const cur = state().columnSizing;
				const next = typeof u === "function" ? u(cur) : u;
				for (const [id, w] of Object.entries(next)) if (w !== cur[id]) layout.setWidth(id, w);
			},
			onColumnSizingInfoChange: (u) => setSizingInfo(typeof u === "function" ? u(sizingInfo()) : u),
		}) as TableOptionsResolved<ItemRow>;

	const table: Table<ItemRow> = createTable(options());
	// keep the table's options (state + columns) in step with the signals, then tell readers
	createComputed(() => {
		const o = options();
		table.setOptions((prev) => ({ ...prev, ...o }));
		setRev((n) => n + 1);
	});
	/** The table; reading it in a reactive scope subscribes to state changes. */
	const t = (): Table<ItemRow> => {
		rev();
		return table;
	};

	return {
		table: t,
		/** Visible columns in order, with their clamped widths. */
		columns: () =>
			t()
				.getVisibleLeafColumns()
				.map((c) => ({ id: c.id, def: getColumn(c.id), width: c.getSize(), sorted: c.getIsSorted(), sortIndex: c.getSortIndex() })),
		/** Ask the table to size a column (clamped by min / max on read). */
		setWidth: (id: string, w: number) => table.setColumnSizing((old) => ({ ...old, [id]: w })),
		/** Move a column to a position of the visible order. */
		moveTo: (id: string, index: number) => layout.move(id, index),
		toggle: (id: string, on: boolean) => table.getColumn(id)?.toggleVisibility(on),
		sizingInfo,
	};
}
