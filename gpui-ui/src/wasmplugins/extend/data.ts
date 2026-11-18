// Plugin-provided data that the lists draw: column cells, row styles, collection decorations and info row values. Every read goes
// through a BatchCache, so a screen of rows costs one plugin call per column (extend.wit: "the host never calls per row").
// Caches are invalidated by `invalidate-*` calls (registry.invalidate), by `itemsRev` (the app's data-changed counter) and when the
// plugin's registrations are cleared. Pure TS: the UI passes `itemsRev` in.
import { callPlugin } from "../host";
import { BatchCache } from "./cache";
import { invalidationRev, registries, takeInvalidated } from "./registry";
import type { Cell, Decoration, InfoRowValue, RowStyle, TabRef, TreeRow } from "./wit";

interface Entry<V> {
	cache: BatchCache<V>;
	rev: number;
	itemsRev: number;
}

const maps = new Map<string, Map<string, Entry<any>>>();

function entryFor<V>(
	kind: string,
	plugin: string,
	id: string,
	itemsRev: number,
	make: () => BatchCache<V>,
	dependsOnItems = true,
): BatchCache<V> {
	let m = maps.get(kind);
	if (!m) maps.set(kind, (m = new Map()));
	const mk = `${plugin}\u0000${id}`;
	let e = m.get(mk) as Entry<V> | undefined;
	if (!e) m.set(mk, (e = { cache: make(), rev: 0, itemsRev }));
	const rev = invalidationRev(kind, plugin, id); // reactive: re-runs readers on an invalidate-* call
	if (rev !== e.rev) {
		e.rev = rev;
		const keys = takeInvalidated(kind, plugin, id);
		const c = e.cache;
		queueMicrotask(() => (keys === "all" || keys === undefined ? c.invalidate() : c.invalidate(keys)));
	}
	if (dependsOnItems && itemsRev !== e.itemsRev) {
		e.itemsRev = itemsRev;
		const c = e.cache;
		queueMicrotask(() => c.invalidate());
	}
	return e.cache;
}

/** Forget caches of a plugin (all plugins when undefined). */
export function dropDataCaches(plugin?: string): void {
	for (const m of maps.values()) {
		for (const [k, e] of [...m]) {
			if (plugin === undefined || k.startsWith(`${plugin}\u0000`)) {
				e.cache.clear();
				m.delete(k);
			}
		}
	}
}

/** The calls made by the caches of a kind (tests). */
export function cacheStats(kind: string, plugin: string, id: string): { calls: number; sizes: number[] } | undefined {
	const e = maps.get(kind)?.get(`${plugin}\u0000${id}`);
	return e ? { calls: e.cache.calls, sizes: e.cache.callSizes } : undefined;
}

const unwrap = <T>(v: unknown): T => v as T;

// ---- columns ----------------------------------------------------------------------------------------------------------------

/** The cell of a plugin column for an item, or undefined until the batch arrives. */
export function columnCell(plugin: string, dataKey: string, itemKey: string, itemsRev = 0): Cell | undefined {
	return entryFor<Cell>("column", plugin, dataKey, itemsRev, () => {
		return new BatchCache<Cell>({
			batch: 200,
			fetch: async (keys) => unwrap<Cell[]>(await callPlugin(plugin, "extend-handlers", "on-column-values", [dataKey, keys])),
		});
	}).get(itemKey);
}

/** Text a cell shows in a plain text column (chips joined, a bar as a percentage, a rating as stars). */
export function cellText(c: Cell | undefined): string {
	const b = c?.body;
	if (!b) return "";
	switch (b.tag) {
		case "text":
			return b.val;
		case "bar":
			return `${Math.round(Math.max(0, Math.min(1, b.val)) * 100)}%`;
		case "rating":
			return "★".repeat(Math.max(0, Math.round(b.val.value))).slice(0, b.val.max);
		case "chips":
			return b.val.map((x) => x.text).join(", ");
		default:
			return "";
	}
}

// ---- row styles -------------------------------------------------------------------------------------------------------------

/** Row styles of every registered plugin for an item, merged (higher priority wins per property). */
export function rowStyleFor(itemKey: string, itemsRev = 0): RowStyle | undefined {
	const regs = registries.rowStyles.list();
	if (!regs.length) return undefined;
	const found: { priority: number; style: RowStyle }[] = [];
	for (const r of regs) {
		const cache = entryFor<RowStyle | undefined>("row-style", r.plugin, r.id, itemsRev, () => {
			return new BatchCache<RowStyle | undefined>({
				batch: 200,
				fetch: async (keys) => {
					const out = unwrap<(RowStyle | null | undefined)[]>(await callPlugin(r.plugin, "extend-handlers", "on-row-styles", [r.id, keys]));
					return out.map((x) => x ?? undefined);
				},
			});
		});
		const s = cache.get(itemKey);
		if (s) found.push({ priority: r.reg.priority, style: s });
	}
	if (!found.length) return undefined;
	found.sort((a, b) => a.priority - b.priority); // low first, so a higher priority overwrites
	const out: RowStyle = {};
	for (const { style } of found) for (const [k, v] of Object.entries(style)) if (v != null) (out as Record<string, unknown>)[k] = v;
	return out;
}

// ---- collection tree decorations --------------------------------------------------------------------------------------------

const rowId = (r: TreeRow) => `${r.kind}|${r.library}|${r.key ?? ""}`;
const rowOf = (id: string): TreeRow => {
	const [kind, lib, key] = id.split("|");
	return { kind: kind as TreeRow["kind"], library: Number(lib), key: key || undefined };
};

/** Decorations of every registered plugin for a collection tree row (the first plugin's badge wins; later ones fill the gaps). */
export function decorationFor(row: TreeRow, itemsRev = 0): Decoration | undefined {
	const regs = registries.decorations.list();
	if (!regs.length) return undefined;
	let out: Decoration | undefined;
	for (const r of regs) {
		const cache = entryFor<Decoration | undefined>("decoration", r.plugin, r.id, itemsRev, () => {
			return new BatchCache<Decoration | undefined>({
				batch: 200,
				fetch: async (ids) => {
					const res = unwrap<(Decoration | null | undefined)[]>(
						await callPlugin(r.plugin, "extend-handlers", "on-collection-decorations", [r.id, ids.map(rowOf)]),
					);
					return res.map((x) => x ?? undefined);
				},
			});
		});
		const d = cache.get(rowId(row));
		if (d) out = { ...d, ...out };
	}
	return out;
}

// ---- info rows --------------------------------------------------------------------------------------------------------------

/** The value of an Info row for an item, or undefined until the plugin has answered. */
export function infoRowValue(plugin: string, rowId_: string, itemKey: string, tab: TabRef, editable: boolean, itemsRev = 0): InfoRowValue | undefined {
	return entryFor<InfoRowValue>("info-row", plugin, rowId_, itemsRev, () => {
		return new BatchCache<InfoRowValue>({
			batch: 1,
			delayMs: 5,
			fetch: async (keys) => {
				const out: (InfoRowValue | undefined)[] = [];
				for (const k of keys)
					out.push(unwrap<InfoRowValue>(await callPlugin(plugin, "extend-handlers", "on-info-row-get", [rowId_, k, tab, editable])));
				return out;
			},
		});
	}).get(itemKey);
}

/** Tell the plugin the user edited an Info row, then re-read it. */
export async function setInfoRow(plugin: string, rowId_: string, itemKey: string, tab: TabRef, value: string): Promise<void> {
	await callPlugin(plugin, "extend-handlers", "on-info-row-set", [rowId_, itemKey, tab, value]);
	maps.get("info-row")?.get(`${plugin}\u0000${rowId_}`)?.cache.invalidate([itemKey]);
}
