// Extension points for features, mirroring ui/src/lib/registry.ts: a feature registers its menu entries, dialogs,
// sidebar sections and settings sections from its own src/<feature>/register.ts(x) (`export function register()`),
// called once from src/features.ts; the shell renders them. This keeps features out of each other's files.
// Icons are lucide kebab-case names (see icons.tsx).
import { createSignal, type JSX } from "solid-js";
import type { ItemRow, View } from "./contracts";

export interface ItemActionContext {
	keys: string[]; // selected top-level item keys (at least the right-clicked one)
	item: ItemRow; // the right-clicked item
	view: View;
}

export interface ItemAction {
	id: string;
	label: string | ((ctx: ItemActionContext) => string);
	icon?: string;
	/** Menu section, in this order: "open", "cite", "export", "edit", "maintain", "plugins" (WASM plugin entries, last before Trash) */
	group?: "open" | "cite" | "export" | "edit" | "maintain" | "plugins";
	shortcut?: string; // display, e.g. "Ctrl+Shift+C"
	submenu?: string; // actions of a group sharing this label are shown under one submenu
	visible?: (ctx: ItemActionContext) => boolean;
	/** Shown dimmed and not run while this returns true. */
	disabled?: (ctx: ItemActionContext) => boolean;
	run: (ctx: ItemActionContext) => void;
}

export interface CollectionAction {
	id: string;
	label: string | (() => string);
	icon?: string;
	/** Left out of the menu while this returns false. */
	visible?: (ctx: { collectionKey: string; name: string }) => boolean;
	run: (ctx: { collectionKey: string; name: string }) => void;
}

/** Entries in the toolbar's "+" (add) menu or "Tools" menu; `shortcut` is also bound globally by the shell. */
export interface AppAction {
	id: string;
	label: string | (() => string);
	icon?: string;
	menu: "add" | "tools" | "none";
	shortcut?: string; // e.g. "Ctrl+Shift+N" ("Ctrl" = Cmd on macOS)
	/** Left out of its menu and not bound to its shortcut while this returns false (adding to a read-only library). */
	when?: () => boolean;
	run: () => void;
}

/** A section of the Settings tab (rendered by the settings feature, contributed by any feature). */
export interface SettingsSection {
	id: string;
	label: string;
	icon?: string;
	order: number;
	render: () => JSX.Element;
}

const [itemActions, setItemActions] = createSignal<ItemAction[]>([]);
const [collectionActions, setCollectionActions] = createSignal<CollectionAction[]>([]);
const [appActions, setAppActions] = createSignal<AppAction[]>([]);
const [overlays, setOverlays] = createSignal<{ id: string; render: () => JSX.Element }[]>([]);
const [sidebarSections, setSidebarSections] = createSignal<{ id: string; order: number; render: () => JSX.Element }[]>([]);
const [settingsSections, setSettingsSections] = createSignal<SettingsSection[]>([]);

const upsert = <T extends { id: string }>(list: T[], x: T) => [...list.filter((y) => y.id !== x.id), x];

export const registerItemAction = (a: ItemAction) => setItemActions((l) => upsert(l, a));
export const registerCollectionAction = (a: CollectionAction) => setCollectionActions((l) => upsert(l, a));
export const registerAppAction = (a: AppAction) => setAppActions((l) => upsert(l, a));
// Removal, for registrations that come and go (WASM plugins: src/wasmplugins). `prefix` removes every id that starts with it.
const dropId = <T extends { id: string }>(l: T[], id: string, prefix: boolean) => l.filter((y) => !(prefix ? y.id.startsWith(id) : y.id === id));
export const unregisterItemAction = (id: string, prefix = false) => setItemActions((l) => dropId(l, id, prefix));
export const unregisterCollectionAction = (id: string, prefix = false) => setCollectionActions((l) => dropId(l, id, prefix));
export const unregisterAppAction = (id: string, prefix = false) => setAppActions((l) => dropId(l, id, prefix));
export const unregisterSettingsSection = (id: string, prefix = false) => setSettingsSections((l) => dropId(l, id, prefix));
/** Always-mounted UI such as a dialog that controls its own open state. */
export const registerOverlay = (id: string, render: () => JSX.Element) => setOverlays((l) => upsert(l, { id, render }));
/** A section under the collections tree in the left pane (e.g. saved searches, tags). Lower order first. */
export const registerSidebarSection = (id: string, order: number, render: () => JSX.Element) =>
	setSidebarSections((l) => upsert(l, { id, order, render }).sort((a, b) => a.order - b.order));
export const registerSettingsSection = (s: SettingsSection) => setSettingsSections((l) => upsert(l, s).sort((a, b) => a.order - b.order));

export { itemActions, collectionActions, appActions, overlays, sidebarSections, settingsSections };
