// The host side of `zinc:plugin/extend`: what a plugin's calls do in the app. Runs in the Zinc process. Registrations go into
// ./registry (the UI reads them there); navigation goes through the host the UI bound (./navigation).
// Pure TS (no UI imports) so it also loads in tests and under plugin-host's typecheck.
import { defineHandler, witError, type HandlerContext } from "../../../../plugin-host/src/imports/registry";
import { getExtendHost } from "./navigation";
import {
	buttonStates,
	invalidate,
	menuPatches,
	panelOpen,
	prefRows,
	Reg,
	registries,
	registryOfKind,
	RegistryConflict,
	subscribe,
	toggled,
} from "./registry";
import type {
	BannerSpec,
	ButtonState,
	ColumnRegistration,
	Context,
	DragFormatRegistration,
	DropRegistration,
	EntryPatch,
	InfoRowRegistration,
	MenuEntry,
	MenuRegistration,
	OpenModeName,
	PrefPaneRegistration,
	RegistrationKind,
	RowStyleRegistration,
	SectionRegistration,
	SelectOptions,
	SettingRow,
	ShortcutRegistration,
	SidePanelRegistration,
	SubscribedEvents,
	TabInfo,
	TabSpec,
	ToolbarButtonRegistration,
	ToolbarViewRegistration,
	TreeRow,
	VirtualCollectionRegistration,
	DecorationRegistration,
} from "./wit";

const BUILTIN_TAB_KINDS = new Set(["library", "reader", "settings"]);
const MAX_PAGE = 2000;

const nz = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

function need(ctx: HandlerContext, permission: string): void {
	ctx.require(permission);
}

function needHost() {
	const h = getExtendHost();
	if (!h) throw witError("unavailable", "the main window is not ready");
	return h;
}

/** Add to a registry; a duplicate id is `conflict`. */
function add<T>(reg: Reg<T>, ctx: HandlerContext, id: string, value: T, what: string): void {
	if (!id) throw witError("invalid-argument", `${what}: empty id`);
	try {
		reg.add(ctx.pluginId, id, value);
	} catch (e) {
		if (e instanceof RegistryConflict) throw witError("conflict", `${what} ${id} is already registered`);
		throw e;
	}
}

function checkEntries(entries: MenuEntry[], where: string): void {
	const ids = new Set<string>();
	for (const e of entries) {
		if (!e.id) throw witError("invalid-argument", `${where}: entry without id`);
		if (ids.has(e.id)) throw witError("invalid-argument", `${where}: duplicate entry id ${e.id}`);
		ids.add(e.id);
	}
	for (const e of entries) if (nz(e.parent) && !ids.has(e.parent!)) throw witError("invalid-argument", `${where}: entry ${e.id} names an unknown parent ${e.parent}`);
}

function sectionCheck(reg: SectionRegistration): void {
	for (const b of reg.buttons ?? []) if (b.id.includes(",")) throw witError("invalid-argument", `section button id ${b.id} contains ","`);
}

const tabInfoOf = (plugin: string, spec: TabSpec): TabInfo => ({
	ref: { id: `plugin:${plugin}:${spec.tabId}`, kind: spec.kind },
	window: 1,
	title: spec.title.tag === "plain" ? spec.title.val : (spec.title.val.fallback ?? spec.title.val.id),
	pinned: spec.pinned,
	item: nz(spec.item),
});

export const extendHandler = defineHandler({
	interface: "zinc:plugin/extend",
	where: "zinc",
	functions: {
		// ---- menus ----
		"register-menu"(ctx, reg: MenuRegistration) {
			checkEntries(reg.entries, `menu ${reg.menuId}`);
			add(registries.menus, ctx, reg.menuId, reg, "menu");
		},
		"replace-menu-entries"(ctx, menuId: string, entries: MenuEntry[]) {
			const cur = registries.menus.lookup(ctx.pluginId, menuId);
			if (!cur) throw witError("not-found", `menu ${menuId}`);
			checkEntries(entries, `menu ${menuId}`);
			registries.menus.replace(ctx.pluginId, menuId, { ...cur.reg, entries });
		},
		"patch-menu"(ctx, menuId: string, patches: EntryPatch[]) {
			if (!registries.menus.lookup(ctx.pluginId, menuId) && !registries.toolbarButtons.lookup(ctx.pluginId, menuId))
				throw witError("not-found", `menu ${menuId}`);
			const m = new Map(menuPatches.get(ctx.pluginId, menuId));
			for (const p of patches) m.set(p.id, { ...m.get(p.id), ...p });
			menuPatches.set(ctx.pluginId, menuId, m);
		},

		// ---- item pane ----
		"register-section"(ctx, reg: SectionRegistration) {
			sectionCheck(reg);
			add(registries.sections, ctx, reg.paneId, reg, "section");
		},
		"register-info-row"(ctx, reg: InfoRowRegistration) {
			add(registries.infoRows, ctx, reg.rowId, reg, "info row");
		},
		"refresh-info-row"(ctx, rowId: string, item: string | undefined) {
			invalidate("info-row", ctx.pluginId, rowId, nz(item) ? [item!] : undefined);
		},

		// ---- columns and row styles ----
		"register-column"(ctx, reg: ColumnRegistration) {
			add(registries.columns, ctx, reg.dataKey, reg, "column");
		},
		"register-columns"(ctx, regs: ColumnRegistration[]) {
			const seen = new Set<string>();
			for (const r of regs) {
				if (seen.has(r.dataKey) || registries.columns.lookup(ctx.pluginId, r.dataKey))
					throw witError("conflict", `column ${r.dataKey} is already registered`);
				seen.add(r.dataKey);
			}
			for (const r of regs) add(registries.columns, ctx, r.dataKey, r, "column");
		},
		"invalidate-columns"(ctx, dataKey: string | undefined, keys: string[] | undefined) {
			if (nz(dataKey)) invalidate("column", ctx.pluginId, dataKey!, nz(keys));
			else for (const c of registries.columns.list()) if (c.plugin === ctx.pluginId) invalidate("column", ctx.pluginId, c.id, nz(keys));
		},
		"register-row-style"(ctx, reg: RowStyleRegistration) {
			add(registries.rowStyles, ctx, reg.styleId, reg, "row style");
		},
		"invalidate-row-styles"(ctx, styleId: string, keys: string[] | undefined) {
			invalidate("row-style", ctx.pluginId, styleId, nz(keys));
		},

		// ---- collection tree ----
		"register-collection-decoration"(ctx, reg: DecorationRegistration) {
			add(registries.decorations, ctx, reg.decorationId, reg, "collection decoration");
		},
		"invalidate-collection-decorations"(ctx, id: string) {
			invalidate("decoration", ctx.pluginId, id);
		},
		"register-virtual-collection"(ctx, reg: VirtualCollectionRegistration) {
			add(registries.virtuals, ctx, reg.viewId, reg, "virtual collection");
		},
		"invalidate-virtual-collection"(ctx, viewId: string) {
			invalidate("virtual", ctx.pluginId, viewId);
		},

		// ---- toolbar, side panels, shortcuts ----
		"register-toolbar-button"(ctx, reg: ToolbarButtonRegistration) {
			if (reg.menu?.length) checkEntries(reg.menu, `toolbar button ${reg.buttonId}`);
			add(registries.toolbarButtons, ctx, reg.buttonId, reg, "toolbar button");
			if (nz(reg.toggle) !== undefined) toggled.set(ctx.pluginId, reg.buttonId, !!reg.toggle);
		},
		"set-toolbar-button-state"(ctx, buttonId: string, state: ButtonState) {
			if (!registries.toolbarButtons.lookup(ctx.pluginId, buttonId)) throw witError("not-found", `toolbar button ${buttonId}`);
			buttonStates.set(ctx.pluginId, buttonId, { ...buttonStates.get(ctx.pluginId, buttonId), ...state });
			if (nz(state.toggled) !== undefined) toggled.set(ctx.pluginId, buttonId, !!state.toggled);
		},
		"register-toolbar-view"(ctx, reg: ToolbarViewRegistration) {
			add(registries.toolbarViews, ctx, reg.viewId, reg, "toolbar view");
		},
		"register-side-panel"(ctx, reg: SidePanelRegistration) {
			need(ctx, "ui.windows");
			add(registries.sidePanels, ctx, reg.panelId, reg, "side panel");
			panelOpen.set(ctx.pluginId, reg.panelId, reg.defaultOpen);
		},
		"set-side-panel-open"(ctx, panelId: string, open: boolean) {
			if (!registries.sidePanels.lookup(ctx.pluginId, panelId)) throw witError("not-found", `side panel ${panelId}`);
			panelOpen.set(ctx.pluginId, panelId, open);
		},
		"register-shortcut"(ctx, reg: ShortcutRegistration) {
			add(registries.shortcuts, ctx, reg.shortcutId, reg, "shortcut");
		},

		// ---- preference panes ----
		"register-pref-pane"(ctx, reg: PrefPaneRegistration) {
			if (nz(reg.parent) && !registries.prefPanes.lookup(ctx.pluginId, reg.parent!))
				throw witError("invalid-argument", `parent pane ${reg.parent} is not registered`);
			add(registries.prefPanes, ctx, reg.paneId, reg, "preference pane");
		},
		"replace-pref-rows"(ctx, paneId: string, rows: SettingRow[]) {
			const p = registries.prefPanes.lookup(ctx.pluginId, paneId);
			if (!p) throw witError("not-found", `preference pane ${paneId}`);
			if (p.reg.content.tag !== "rows") throw witError("invalid-argument", `pane ${paneId} is a view pane`);
			prefRows.set(ctx.pluginId, paneId, rows);
		},

		// ---- tabs ----
		"open-tab"(ctx, spec: TabSpec) {
			need(ctx, "ui.windows");
			if (BUILTIN_TAB_KINDS.has(spec.kind)) throw witError("invalid-argument", `"${spec.kind}" is a built-in tab kind`);
			add(registries.tabs, ctx, spec.tabId, spec, "tab");
			if (spec.select) needHost().setActiveTab(`plugin:${ctx.pluginId}:${spec.tabId}`);
		},
		"select-tab"(ctx, tab: string) {
			const t = registries.tabs.lookup(ctx.pluginId, tab);
			if (!t) throw witError("not-found", `tab ${tab}`);
			needHost().setActiveTab(`plugin:${ctx.pluginId}:${tab}`);
		},
		"close-tab"(ctx, tab: string) {
			if (!registries.tabs.remove(ctx.pluginId, tab)) throw witError("not-found", `tab ${tab}`);
			const h = getExtendHost();
			if (h?.activeTabId() === `plugin:${ctx.pluginId}:${tab}`) h.setActiveTab("library");
		},
		"rename-tab"(ctx, tab: string, title: TabSpec["title"]) {
			const t = registries.tabs.lookup(ctx.pluginId, tab);
			if (!t) throw witError("not-found", `tab ${tab}`);
			registries.tabs.replace(ctx.pluginId, tab, { ...t.reg, title });
		},
		"set-tab-pinned"(ctx, tab: string, pinned: boolean) {
			const t = registries.tabs.lookup(ctx.pluginId, tab);
			if (!t) throw witError("not-found", `tab ${tab}`);
			registries.tabs.replace(ctx.pluginId, tab, { ...t.reg, pinned });
		},
		"move-tab"(ctx, tab: string, index: number) {
			const t = registries.tabs.lookup(ctx.pluginId, tab);
			if (!t) throw witError("not-found", `tab ${tab}`);
			registries.tabs.replace(ctx.pluginId, tab, { ...t.reg, index });
		},
		"list-tabs"(_ctx, _window: number | undefined): TabInfo[] {
			const built = getExtendHost()?.builtinTabs() ?? [];
			const plugin = registries.tabs.list().map((t) => tabInfoOf(t.plugin, t.reg));
			return [...built, ...plugin];
		},
		"selected-tab"(_ctx, _window: number | undefined): TabInfo | undefined {
			const id = getExtendHost()?.activeTabId();
			if (!id) return undefined;
			return [...(getExtendHost()?.builtinTabs() ?? []), ...registries.tabs.list().map((t) => tabInfoOf(t.plugin, t.reg))].find(
				(t) => t.ref.id === id,
			);
		},

		// ---- banners ----
		"show-banner"(ctx, spec: BannerSpec) {
			const cur = registries.banners.lookup(ctx.pluginId, spec.bannerId);
			if (cur) registries.banners.replace(ctx.pluginId, spec.bannerId, spec);
			else add(registries.banners, ctx, spec.bannerId, spec, "banner");
		},
		"hide-banner"(ctx, bannerId: string) {
			registries.banners.remove(ctx.pluginId, bannerId);
		},

		// ---- selection and navigation ----
		"get-context"(ctx, _window: number | undefined): Context {
			need(ctx, "library.read");
			return needHost().getContext();
		},
		"list-selected-items"(ctx, _window: number | undefined, offset: number, limit: number): string[] {
			need(ctx, "library.read");
			return needHost().listSelected(offset, Math.min(limit, MAX_PAGE));
		},
		"get-view"(ctx, _window: number | undefined) {
			need(ctx, "library.read");
			return needHost().getView();
		},
		async "list-view-items"(ctx, _window: number | undefined, offset: number, limit: number) {
			need(ctx, "library.read");
			return needHost().listViewItems(offset, Math.min(limit, MAX_PAGE));
		},
		async "select-items"(ctx, keys: string[], options: SelectOptions) {
			need(ctx, "ui.navigate");
			return needHost().selectItems(keys, options);
		},
		"select-row"(ctx, row: TreeRow) {
			need(ctx, "ui.navigate");
			needHost().selectRow(row);
		},
		"set-search"(ctx, text: string) {
			need(ctx, "ui.navigate");
			needHost().setSearch(text);
		},
		"set-panel-visible"(ctx, panel: "collections-sidebar" | "item-pane", visible: boolean) {
			need(ctx, "ui.navigate");
			needHost().setPanelVisible(panel, visible);
		},
		"open-settings"(ctx, paneId: string | undefined) {
			need(ctx, "ui.navigate");
			const id = nz(paneId);
			if (id && !registries.prefPanes.lookup(ctx.pluginId, id)) throw witError("not-found", `preference pane ${id}`);
			needHost().openSettings(id ? `plugin:${ctx.pluginId}:${id}` : undefined);
		},
		async "open-item"(ctx, key: string, mode: OpenModeName) {
			need(ctx, "ui.navigate");
			await needHost().openItem(key, mode);
		},

		// ---- drag and drop ----
		"register-drop-target"(ctx, reg: DropRegistration) {
			need(ctx, "ui.drop");
			add(registries.dropTargets, ctx, reg.dropId, reg, "drop target");
		},
		"register-drag-format"(ctx, reg: DragFormatRegistration) {
			need(ctx, "ui.drop");
			add(registries.dragFormats, ctx, reg.formatId, reg, "drag format");
		},

		// ---- events and unregister ----
		"subscribe-events"(ctx, events: SubscribedEvents) {
			subscribe(ctx.pluginId, events);
		},
		unregister(ctx, kind: RegistrationKind, id: string) {
			const reg = registryOfKind[kind];
			if (!reg) throw witError("invalid-argument", `unknown registration kind ${kind}`);
			if (!reg.remove(ctx.pluginId, id)) throw witError("not-found", `${kind} ${id}`);
		},
	},
});

export default extendHandler;
