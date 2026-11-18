// What plugins registered in the main window, as reactive lists. Pure TS + solid-js signals: no UI imports, so the import handler
// (plugin-host/src/imports/extend.zinc.ts) and the UI components both use it. Ids are the plugin's own; the registry keys them
// by (plugin, id), which is the "host namespaces them with the plugin id" rule of extend.wit.
import { createSignal, type Accessor } from "solid-js";
import type {
	BannerSpec,
	ButtonState,
	ColumnRegistration,
	DecorationRegistration,
	DragFormatRegistration,
	DropRegistration,
	EntryPatch,
	InfoRowRegistration,
	MenuRegistration,
	PrefPaneRegistration,
	RegistrationKind,
	RowStyleRegistration,
	SectionRegistration,
	SettingRow,
	ShortcutRegistration,
	SidePanelRegistration,
	SubscribedEvents,
	TabSpec,
	ToolbarButtonRegistration,
	ToolbarViewRegistration,
	VirtualCollectionRegistration,
} from "./wit";

export interface Owned<T> {
	/** Plugin id. */
	plugin: string;
	/** The id the plugin chose. */
	id: string;
	reg: T;
}

export class RegistryConflict extends Error {}

export class Reg<T> {
	private read: Accessor<Owned<T>[]>;
	private write: (f: (l: Owned<T>[]) => Owned<T>[]) => void;
	constructor() {
		const [read, write] = createSignal<Owned<T>[]>([]);
		this.read = read;
		this.write = (f) => write(f(read()));
	}
	/** Reactive list in registration order. */
	list = (): Owned<T>[] => this.read();
	lookup = (plugin: string, id: string): Owned<T> | undefined => this.read().find((e) => e.plugin === plugin && e.id === id);
	/** Throws RegistryConflict when (plugin, id) exists. */
	add(plugin: string, id: string, reg: T): void {
		if (this.lookup(plugin, id)) throw new RegistryConflict(`${id} is already registered`);
		this.write((l) => [...l, { plugin, id, reg }]);
	}
	replace(plugin: string, id: string, reg: T): boolean {
		if (!this.lookup(plugin, id)) return false;
		this.write((l) => l.map((e) => (e.plugin === plugin && e.id === id ? { ...e, reg } : e)));
		return true;
	}
	remove(plugin: string, id: string): boolean {
		if (!this.lookup(plugin, id)) return false;
		this.write((l) => l.filter((e) => !(e.plugin === plugin && e.id === id)));
		return true;
	}
	clear(plugin?: string): void {
		this.write((l) => (plugin === undefined ? [] : l.filter((e) => e.plugin !== plugin)));
	}
}

export const registries = {
	menus: new Reg<MenuRegistration>(),
	sections: new Reg<SectionRegistration>(),
	infoRows: new Reg<InfoRowRegistration>(),
	columns: new Reg<ColumnRegistration>(),
	rowStyles: new Reg<RowStyleRegistration>(),
	decorations: new Reg<DecorationRegistration>(),
	virtuals: new Reg<VirtualCollectionRegistration>(),
	toolbarButtons: new Reg<ToolbarButtonRegistration>(),
	toolbarViews: new Reg<ToolbarViewRegistration>(),
	sidePanels: new Reg<SidePanelRegistration>(),
	shortcuts: new Reg<ShortcutRegistration>(),
	prefPanes: new Reg<PrefPaneRegistration>(),
	dropTargets: new Reg<DropRegistration>(),
	dragFormats: new Reg<DragFormatRegistration>(),
	tabs: new Reg<TabSpec>(),
	banners: new Reg<BannerSpec>(),
};

/** `unregister(kind, id)` of extend.wit. */
export const registryOfKind: Record<RegistrationKind, Reg<any>> = {
	menu: registries.menus,
	section: registries.sections,
	"info-row": registries.infoRows,
	column: registries.columns,
	"row-style": registries.rowStyles,
	"collection-decoration": registries.decorations,
	"virtual-collection": registries.virtuals,
	"toolbar-button": registries.toolbarButtons,
	"toolbar-view": registries.toolbarViews,
	"side-panel": registries.sidePanels,
	shortcut: registries.shortcuts,
	"pref-pane": registries.prefPanes,
	"drop-target": registries.dropTargets,
	"drag-format": registries.dragFormats,
};

// ---- small state kept next to the registrations ----------------------------------------------------------------------------

const k = (plugin: string, id: string) => `${plugin}\u0000${id}`;

function keyedSignal<V>() {
	const [read, write] = createSignal<Map<string, V>>(new Map());
	return {
		get: (plugin: string, id: string): V | undefined => read().get(k(plugin, id)),
		set(plugin: string, id: string, v: V) {
			const m = new Map(read());
			m.set(k(plugin, id), v);
			write(m);
		},
		delete(plugin: string, id: string) {
			if (!read().has(k(plugin, id))) return;
			const m = new Map(read());
			m.delete(k(plugin, id));
			write(m);
		},
		clear(plugin?: string) {
			if (plugin === undefined) return void write(new Map());
			write(new Map([...read()].filter(([key]) => !key.startsWith(`${plugin}\u0000`))));
		},
	};
}

/** Latest `entry-patch`es per menu (from `on-menu-showing` and `patch-menu`), by entry id. */
export const menuPatches = keyedSignal<Map<string, EntryPatch>>();
export const buttonStates = keyedSignal<ButtonState>();
/** Rows replaced with `replace-pref-rows`. */
export const prefRows = keyedSignal<SettingRow[]>();
/** Side panels the user (or the plugin) opened or closed. */
export const panelOpen = keyedSignal<boolean>();
/** Toggle state of toggle buttons. */
export const toggled = keyedSignal<boolean>();
/** Banners the user dismissed. */
export const dismissedBanners = keyedSignal<true>();

/** Per-plugin `subscribe-events` flags. */
const [subs, setSubs] = createSignal<Map<string, SubscribedEvents>>(new Map());
export const subscriptions = (): Map<string, SubscribedEvents> => subs();
export function subscribe(plugin: string, ev: SubscribedEvents): void {
	const m = new Map(subs());
	m.set(plugin, ev);
	setSubs(m);
}

/** Bumped by `invalidate-*` calls: caches watch these. Key: kind + plugin + id. */
const [invalidations, setInvalidations] = createSignal<Map<string, number>>(new Map());
const ikey = (kind: string, plugin: string, id: string) => `${kind}\u0000${k(plugin, id)}`;
export const invalidationRev = (kind: string, plugin: string, id: string): number => invalidations().get(ikey(kind, plugin, id)) ?? 0;
/** Specific item keys to forget (undefined: all), consumed by the cache that owns the kind. */
const pendingKeys = new Map<string, Set<string> | "all">();
export function invalidate(kind: string, plugin: string, id: string, keys?: string[]): void {
	const key = ikey(kind, plugin, id);
	if (!keys) pendingKeys.set(key, "all");
	else if (pendingKeys.get(key) !== "all") {
		const s = (pendingKeys.get(key) as Set<string> | undefined) ?? new Set<string>();
		for (const x of keys) s.add(x);
		pendingKeys.set(key, s);
	}
	const m = new Map(invalidations());
	m.set(key, (m.get(key) ?? 0) + 1);
	setInvalidations(m);
}
export function takeInvalidated(kind: string, plugin: string, id: string): Set<string> | "all" | undefined {
	const key = ikey(kind, plugin, id);
	const v = pendingKeys.get(key);
	pendingKeys.delete(key);
	return v;
}

/** Remove everything one plugin registered (every plugin when undefined). Called on stop, disable and host restart. */
export function clearPluginRegistrations(plugin?: string): void {
	for (const r of Object.values(registries)) r.clear(plugin);
	menuPatches.clear(plugin);
	buttonStates.clear(plugin);
	prefRows.clear(plugin);
	panelOpen.clear(plugin);
	toggled.clear(plugin);
	dismissedBanners.clear(plugin);
	if (plugin === undefined) setSubs(new Map());
	else {
		const m = new Map(subs());
		m.delete(plugin);
		setSubs(m);
	}
}
