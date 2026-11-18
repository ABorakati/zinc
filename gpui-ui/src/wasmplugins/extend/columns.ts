// Plugin columns in the Classic table. A plugin column has the id `plugin:<plugin id>:<data key>`; table/defs.ts asks `pluginColumn(id)`
// for its definition. The cell text comes from the batch cache (data.ts): one plugin call per screenful, never per row.
// Sorting by a plugin column is not wired to the core's server-side sort (see phase2-extend.md): `sort` is "" and the header ignores clicks.
import type { Column } from "../../table/defs";
import { cellText, columnCell } from "./data";
import { registries } from "./registry";
import { lstr } from "./text";
import type { Cell } from "./wit";

export const pluginColumnId = (plugin: string, dataKey: string) => `plugin:${plugin}:${dataKey}`;
export const isPluginColumn = (id: string) => id.startsWith("plugin:");

/** The app's data-changed counter (store.itemsRev), set when plugins bind; cells re-read when it changes. */
let itemsRev: () => number = () => 0;
export function setItemsRevGetter(f: () => number): void {
	itemsRev = f;
}

const parse = (id: string): { plugin: string; dataKey: string } | undefined => {
	const m = /^plugin:(.+?):([^:]+)$/.exec(id);
	return m ? { plugin: m[1]!, dataKey: m[2]! } : undefined;
};

/** The plugin columns offered in the column picker ("main" list or every list). Reactive. */
export function pluginColumns(): { id: string; label: string }[] {
	return registries.columns
		.list()
		.filter((c) => c.reg.showInPicker !== false && (!c.reg.trees?.length || c.reg.trees.some((t) => t === "main" || t === "*")))
		.map((c) => ({ id: pluginColumnId(c.plugin, c.id), label: lstr(c.reg.label, c.id) }));
}

const cache = new Map<string, Column>();

/** The column definition for a `plugin:` id (a blank column while its plugin is not running). */
export function pluginColumn(id: string): Column {
	let c = cache.get(id);
	if (c) return c;
	const p = parse(id);
	const reg = () => (p ? registries.columns.lookup(p.plugin, p.dataKey)?.reg : undefined);
	const cell = (it: { key: string }): Cell | undefined => (p ? columnCell(p.plugin, p.dataKey, it.key, itemsRev()) : undefined);
	const base: Column = {
		id,
		label: "",
		sort: "",
		width: 120,
		get: (it) => cellText(cell(it)),
		cellStyle: (it) => {
			const x = cell(it);
			return x ? { color: x.color ?? undefined, style: x.style, tooltip: x.tooltip ?? undefined, chips: x.body.tag === "chips" ? x.body.val : undefined } : undefined;
		},
	};
	c = Object.defineProperties(base, {
		label: { get: () => lstr(reg()?.label, p?.dataKey ?? id), enumerable: true },
		width: { get: () => reg()?.width ?? (reg()?.flex ? Math.round(reg()!.flex! * 160) : 120), enumerable: true },
		align: { get: () => (reg()?.align === "end" ? "right" : reg()?.align === "center" ? "center" : undefined), enumerable: true },
	}) as Column;
	cache.set(id, c);
	return c;
}
