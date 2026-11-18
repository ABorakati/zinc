// Binds the extend handler to the running app: the selection / view / tab context for plugins, navigation calls, the mirrors of
// plugin menu entries and shortcuts into the app's registries (registry.ts), and the debounced `on-event` stream.
// Imported lazily by wasmplugins/index.ts, so the default app does not load it.
import { createEffect, createRoot, on } from "solid-js";
import { api } from "../../api";
import type { ItemRow } from "../../contracts";
import { isDocTab, isWebTab } from "../../contracts";
import { registerAppAction, registerCollectionAction, registerItemAction, unregisterAppAction, unregisterCollectionAction, unregisterItemAction } from "../../registry";
import { SETTINGS_TAB, openSettings, setLeftOpen, setRightOpen } from "../../shell/layout";
import { gotoSection } from "../../settings/SettingsPage";
import { store } from "../../store";
import { openItem } from "../../cards/actions";
import { callPlugin } from "../host";
import { buildContext, conditionContext, currentTabRef, itemTypes, viewRow } from "./context";
import { conditionHolds } from "./conditions";
import { resolveEntries, runMenuCommand, type ResolvedEntry } from "./menus";
import { bindExtendHostImpl, getExtendHost, type ExtendHost } from "./navigation";
import { registries, subscriptions } from "./registry";
import { setItemsRevGetter } from "./columns";
import { startPaneMirror } from "./settings";
import { iconName, lstr } from "./text";
import type { Context, MenuEntry, TabInfo, TabRef, ViewState } from "./wit";

// ---- the host the handler talks to ------------------------------------------------------------------------------------------

function builtinTabs(): TabInfo[] {
	const out: TabInfo[] = [{ ref: { id: "library", kind: "library" }, window: 1, title: "Library", pinned: true }];
	for (const t of store.tabs().filter(isDocTab))
		out.push({
			ref: { id: t.id, kind: "reader", subtype: isWebTab(t) ? (/epub/i.test(t.contentType) ? "epub" : "snapshot") : "pdf" },
			window: 1,
			title: t.title,
			pinned: false,
			item: t.itemKey,
		});
	if (store.activeTab() === SETTINGS_TAB) out.push({ ref: { id: SETTINGS_TAB, kind: "settings" }, window: 1, title: "Settings", pinned: false });
	return out;
}

const host: ExtendHost = {
	getContext: () => buildContext(),
	listSelected: (offset, limit) => [...store.selected()].slice(offset, offset + limit),
	getView(): ViewState {
		return {
			row: viewRow(),
			searchText: store.filter() || undefined,
			tagFilter: [...store.tagFilter()],
			sort: store.sortLevels().map((l) => ({ key: l.key, descending: l.dir === "desc" })),
			itemCount: store.total(),
		};
	},
	async listViewItems(offset, limit) {
		const page = await api.items(store.query(), offset, limit);
		return { keys: page.items.map((i: ItemRow) => i.key), total: page.total };
	},
	async selectItems(keys, options) {
		if (options.focusLibraryTab) store.setActiveTab("library");
		if (options.clearFilters) {
			store.setFilter("");
			store.setTagFilter([]);
		}
		let n = 0;
		for (const k of keys) if (await store.revealItem(k)) n++;
		if (keys.length > 1) store.setSelected(new Set(keys));
		return n;
	},
	selectRow(row) {
		const v = row.kind;
		if (v === "collection" && row.key) store.setView({ kind: "collection", key: row.key });
		else if (v === "saved-search" && row.key) store.setView({ kind: "savedSearch", key: row.key });
		else if (v === "unfiled" || v === "trash" || v === "duplicates" || v === "publications") store.setView({ kind: v });
		else if (v === "library" || v === "group-library") {
			store.selectLibrary(row.library);
			store.setView({ kind: "library" });
		}
	},
	setSearch: (text) => store.setFilter(text),
	setPanelVisible(panel, visible) {
		if (panel === "collections-sidebar") setLeftOpen(visible);
		else setRightOpen(visible);
	},
	openSettings(sectionId) {
		openSettings();
		if (sectionId) gotoSection(sectionId);
	},
	async openItem(key, mode) {
		if (mode === "show-in-folder" || mode === "external-app") throw new Error("not available in this build");
		const i = store.indexOfKey(key);
		const it = i >= 0 ? store.peek(i) : undefined;
		if (it) await openItem(it);
		else await store.revealItem(key);
	},
	setActiveTab: (id) => store.setActiveTab(id),
	activeTabId: () => store.activeTab(),
	builtinTabs,
	itemTypes,
};

// ---- mirrors into the app's registries --------------------------------------------------------------------------------------

const idOf = (plugin: string, menuId: string, entryId: string) => `wp:${plugin}:${menuId}:${entryId}`;

/** Find an entry in a resolved tree (the context decides whether it is there). */
function findResolved(list: ResolvedEntry[], id: string): ResolvedEntry | undefined {
	for (const e of list) {
		if (e.id === id) return e;
		const c = findResolved(e.children, id);
		if (c) return c;
	}
	return undefined;
}

function entryLabel(plugin: string, menuId: string, e: MenuEntry): string {
	const live = findResolved(resolveEntries(plugin, menuId, registries.menus.lookup(plugin, menuId)?.reg.entries ?? [], conditionContext()), e.id);
	return live?.label || lstr(e.label, e.id);
}

type Leaf = { plugin: string; menuId: string; entry: MenuEntry; submenu?: string };
function leaves(entries: MenuEntry[], plugin: string, menuId: string): Leaf[] {
	const out: Leaf[] = [];
	for (const e of entries) {
		if (e.kind !== "item") continue;
		const parent = e.parent ? entries.find((p) => p.id === e.parent) : undefined;
		out.push({ plugin, menuId, entry: e, submenu: parent ? lstr(parent.label, parent.id) : undefined });
	}
	return out;
}

const stateOf = (l: Leaf, items?: string[]): { visible: boolean; disabled: boolean; resolved?: ResolvedEntry } => {
	const reg = registries.menus.lookup(l.plugin, l.menuId);
	if (!reg) return { visible: false, disabled: true };
	const r = findResolved(resolveEntries(l.plugin, l.menuId, reg.reg.entries, conditionContext(items)), l.entry.id);
	return { visible: !!r, disabled: r?.disabled ?? true, resolved: r };
};

function mirrorMenus(): void {
	const ITEM = "wp:";
	createEffect(() => {
		// rebuilt whenever a registration changes
		const menus = registries.menus.list();
		unregisterItemAction(ITEM, true);
		unregisterCollectionAction(ITEM, true);
		unregisterAppAction(ITEM, true);
		for (const m of menus) {
			for (const l of leaves(m.reg.entries, m.plugin, m.id)) {
				const id = idOf(m.plugin, m.id, l.entry.id);
				const run = (ctx: Context, checked?: boolean) => void runMenuCommand({ plugin: l.plugin, menuId: l.menuId, id: l.entry.id, checked: undefined }, ctx, checked);
				const label = () => entryLabel(l.plugin, l.menuId, l.entry);
				if (m.reg.target === "library-item" || m.reg.target === "library-add-attachment" || m.reg.target === "library-add-note") {
					if (m.reg.target === "library-item")
						registerItemAction({
							id,
							label,
							icon: iconName(l.entry.icon, "") || undefined,
							group: "plugins",
							submenu: l.submenu,
							visible: (c) => stateOf(l, c.keys).visible,
							disabled: (c) => stateOf(l, c.keys).disabled,
							run: (c) => run(buildContext(c.keys)),
						});
					else
						registerAppAction({
							id,
							label: () => `${m.reg.target === "library-add-note" ? "Note" : "Attachment"}: ${label()}`,
							menu: "add",
							when: () => stateOf(l).visible && !stateOf(l).disabled,
							run: () => run(buildContext()),
						});
				} else if (m.reg.target === "library-collection") {
					registerCollectionAction({
						id,
						label,
						visible: () => stateOf(l).visible,
						run: (c) => run({ ...buildContext(), rows: [{ kind: "collection", library: store.libraryId(), key: c.collectionKey }] }),
					});
				} else if (m.reg.target === "library-add") {
					registerAppAction({ id, label, menu: "add", when: () => stateOf(l).visible && !stateOf(l).disabled, run: () => run(buildContext()) });
				}
				// accelerators on any entry bind a global shortcut to the command
				if (l.entry.accelerator)
					registerAppAction({
						id: `${id}:key`,
						label,
						menu: "none",
						shortcut: l.entry.accelerator,
						when: () => stateOf(l).visible && !stateOf(l).disabled,
						run: () => run(buildContext()),
					});
			}
		}
	});
}

const hasRealScope = (scope: string, tab: TabRef) => scope === "global" || (scope === "library" ? tab.kind === "library" : tab.kind === "reader");

function mirrorShortcuts(): void {
	createEffect(() => {
		const list = registries.shortcuts.list();
		unregisterAppAction("wp-sc:", true);
		for (const s of list)
			registerAppAction({
				id: `wp-sc:${s.plugin}:${s.id}`,
				label: lstr(s.reg.label, s.id),
				menu: "none",
				shortcut: s.reg.defaultAccelerator ?? undefined,
				when: () => hasRealScope(s.reg.scope, currentTabRef()) && conditionHolds(s.reg.enabledWhen, conditionContext()),
				run: () => void callPlugin(s.plugin, "extend-handlers", "on-shortcut", [s.id, buildContext()]).catch(() => {}),
			});
	});
	// toolbar button accelerators
	createEffect(() => {
		const list = registries.toolbarButtons.list();
		unregisterAppAction("wp-tb:", true);
		for (const b of list)
			if (b.reg.accelerator)
				registerAppAction({
					id: `wp-tb:${b.plugin}:${b.id}`,
					label: lstr(b.reg.tooltip, b.id),
					menu: "none",
					shortcut: b.reg.accelerator,
					when: () => conditionHolds(b.reg.enabledWhen, conditionContext()),
					run: () => void callPlugin(b.plugin, "extend-handlers", "on-toolbar-click", [b.id, undefined, buildContext()]).catch(() => {}),
				});
	});
}

// ---- events -----------------------------------------------------------------------------------------------------------------

type Ev = { tag: string; val: unknown };
function startEvents(): void {
	const pending = new Map<string, { ev: Ev; timer: ReturnType<typeof setTimeout> }>();
	const send = (kind: "selectionChanged" | "viewChanged" | "tabChanged" | "themeChanged", key: string, make: () => Ev) => {
		const prev = pending.get(key);
		if (prev) clearTimeout(prev.timer);
		const timer = setTimeout(() => {
			pending.delete(key);
			const ev = make();
			for (const [plugin, s] of subscriptions())
				if (s[kind]) void callPlugin(plugin, "extend-handlers", "on-event", [ev]).catch(() => {});
		}, 100);
		pending.set(key, { ev: { tag: key, val: undefined }, timer });
	};
	createEffect(
		on(
			() => [...store.selected()].join(","),
			() => send("selectionChanged", "selection-changed", () => ({ tag: "selection-changed", val: buildContext() })),
			{ defer: true },
		),
	);
	createEffect(
		on(
			() => [store.view(), store.filter(), store.tagFilter(), store.sortLevels(), store.total()],
			() => send("viewChanged", "view-changed", () => ({ tag: "view-changed", val: host.getView() })),
			{ defer: true },
		),
	);
	createEffect(
		on(
			() => store.activeTab(),
			() =>
				send("tabChanged", "tab-selected", () => ({
					tag: "tab-selected",
					val: [...builtinTabs(), ...[]].find((t) => t.ref.id === store.activeTab()) ?? { ref: currentTabRef(), window: 1, title: "", pinned: false },
				})),
			{ defer: true },
		),
	);
	createEffect(
		on(
			() => store.mode(),
			() => send("themeChanged", "theme-changed", () => ({ tag: "theme-changed", val: store.mode() })),
			{ defer: true },
		),
	);
}

// ---- entry point ------------------------------------------------------------------------------------------------------------

let disposer: (() => void) | undefined;

/** Bind the handler's host and start the mirrors. Idempotent. */
export function bindExtendUi(): void {
	if (disposer) return;
	bindExtendHostImpl(host);
	setItemsRevGetter(() => store.itemsRev());
	disposer = createRoot((dispose) => {
		mirrorMenus();
		mirrorShortcuts();
		startPaneMirror();
		startEvents();
		return dispose;
	});
}

export function unbindExtendUi(): void {
	disposer?.();
	disposer = undefined;
	if (getExtendHost() === host) bindExtendHostImpl(undefined);
	unregisterItemAction("wp:", true);
	unregisterCollectionAction("wp:", true);
	unregisterAppAction("wp:", true);
	unregisterAppAction("wp-sc:", true);
	unregisterAppAction("wp-tb:", true);
}

export { host as appExtendHost };
