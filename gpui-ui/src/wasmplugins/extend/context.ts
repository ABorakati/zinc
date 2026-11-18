// The context plugins see (extend.wit `context`) and the condition context, built from the app's store. Light: used by the item pane,
// the toolbar and the menus, so it imports only the store and the registry.
import type { ReaderTab, WebTab } from "../../contracts";
import { isDocTab, isWebTab } from "../../contracts";
import { SETTINGS_TAB } from "../../shell/layout";
import { store } from "../../store";
import type { CondCtx } from "./conditions";
import { registries } from "./registry";
import type { Context, RowKind, TabRef, TreeRow } from "./wit";


export const pluginTabId = (plugin: string, tab: string) => `plugin:${plugin}:${tab}`;

export function currentTabRef(): TabRef {
	const id = store.activeTab();
	if (id === "library") return { id, kind: "library" };
	if (id === SETTINGS_TAB) return { id, kind: "settings" };
	if (id.startsWith("plugin:")) {
		const t = registries.tabs.list().find((x) => pluginTabId(x.plugin, x.id) === id);
		if (t) return { id, kind: t.reg.kind };
	}
	const tab = store.tabs().find((t) => t.id === id);
	if (tab && isDocTab(tab)) return { id, kind: "reader", subtype: isWebTab(tab) ? (/epub/i.test((tab as WebTab).contentType) ? "epub" : "snapshot") : "pdf" };
	return { id, kind: "library" };
}

export function viewRow(): TreeRow {
	const v = store.view();
	const library = store.libraryId();
	switch (v.kind) {
		case "collection":
			return { kind: "collection", library, key: v.key };
		case "savedSearch":
			return { kind: "saved-search", library, key: v.key };
		case "unfiled":
			return { kind: "unfiled", library };
		case "trash":
			return { kind: "trash", library };
		case "duplicates":
			return { kind: "duplicates", library };
		case "publications":
			return { kind: "publications", library };
		default:
			return { kind: library === 1 ? "library" : "group-library", library };
	}
}

const MAX_CONTEXT_ITEMS = 2000;

/** The context handlers get (extend.wit `context`). */
export function buildContext(overrideItems?: string[]): Context {
	const tab = currentTabRef();
	let keys: string[];
	if (overrideItems) keys = overrideItems;
	else if (tab.kind === "library") keys = [...store.selected()];
	else if (tab.kind === "reader") keys = [(store.tabs().find((t) => t.id === tab.id) as ReaderTab | undefined)?.itemKey ?? ""].filter(Boolean);
	else keys = [];
	return {
		window: 1,
		tab,
		library: store.libraryId(),
		rows: tab.kind === "library" ? [viewRow()] : [],
		items: keys.slice(0, MAX_CONTEXT_ITEMS),
		itemCount: keys.length,
		itemsTruncated: keys.length > MAX_CONTEXT_ITEMS,
		editable: store.canEdit(),
		field: undefined,
	};
}

export function itemTypes(keys: string[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const k of keys) {
		const i = store.indexOfKey(k);
		const it = i >= 0 ? store.peek(i) : undefined;
		if (it) out.set(k, it.itemType);
	}
	return out;
}

/** The condition context for the current selection (reactive: reads the store). */
export function conditionContext(overrideItems?: string[]): CondCtx {
	const c = buildContext(overrideItems);
	return {
		tab: c.tab,
		itemCount: c.itemCount,
		itemTypes: [...itemTypes(c.items).values()],
		rowKinds: c.rows.map((r) => r.kind as RowKind),
		editable: c.editable,
	};
}

