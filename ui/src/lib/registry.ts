// Extension points for features (citations, import/export, duplicates, search, add items…).
// A feature registers its menu entries, dialogs and sidebar sections from its own
// ui/src/<feature>/register.ts(x), imported once by ui/src/features.ts; the shell renders them.
// This keeps features out of each other's files (menus live in cards/shared.tsx, Collections.tsx, App.tsx).
import { createSignal, type Component, type JSX } from "solid-js";
import type { ItemSummary } from "../api";

type Icon = Component<{ class?: string }>;

export interface ItemActionContext {
	keys: string[]; // selected top-level item keys (at least the right-clicked one)
	item: ItemSummary; // the right-clicked item
	view: { kind: string; key?: string }; // current library view (library / collection / unfiled / trash / search…)
}

export interface ItemAction {
	id: string;
	label: string | ((ctx: ItemActionContext) => string);
	icon?: Icon;
	// Menu section, in this order: "open", "cite", "export", "edit", "maintain"
	group?: "open" | "cite" | "export" | "edit" | "maintain";
	shortcut?: string; // display only, e.g. "Ctrl+Shift+C"
	submenu?: string; // actions of a group sharing this label are shown under one submenu (e.g. "Add Attachment")
	visible?: (ctx: ItemActionContext) => boolean;
	run: (ctx: ItemActionContext) => void;
}

export interface CollectionAction {
	id: string;
	label: string;
	icon?: Icon;
	run: (ctx: { collectionKey: string; name: string }) => void;
}

/** Entries in the toolbar's "+" (add) menu or "Tools" menu. */
export interface AppAction {
	id: string;
	label: string;
	icon?: Icon;
	menu: "add" | "tools";
	shortcut?: string; // display only, e.g. "Ctrl+Shift+N"
	run: () => void;
}

const [itemActions, setItemActions] = createSignal<ItemAction[]>([]);
const [collectionActions, setCollectionActions] = createSignal<CollectionAction[]>([]);
const [appActions, setAppActions] = createSignal<AppAction[]>([]);
const [overlays, setOverlays] = createSignal<{ id: string; render: () => JSX.Element }[]>([]);
const [sidebarSections, setSidebarSections] = createSignal<{ id: string; order: number; render: () => JSX.Element }[]>([]);

const upsert = <T extends { id: string }>(list: T[], x: T) => [...list.filter((y) => y.id !== x.id), x];

export const registerItemAction = (a: ItemAction) => setItemActions((l) => upsert(l, a));
export const registerCollectionAction = (a: CollectionAction) => setCollectionActions((l) => upsert(l, a));
export const registerAppAction = (a: AppAction) => setAppActions((l) => upsert(l, a));
/** Always-mounted UI such as dialogs (render returns the dialog; it controls its own open state). */
export const registerOverlay = (id: string, render: () => JSX.Element) => setOverlays((l) => upsert(l, { id, render }));
/** A section under the collections tree in the left pane (e.g. saved searches). Lower order first. */
export const registerSidebarSection = (id: string, order: number, render: () => JSX.Element) =>
	setSidebarSections((l) => upsert(l, { id, order, render }).sort((a, b) => a.order - b.order));

export { itemActions, collectionActions, appActions, overlays, sidebarSections };

export const ITEM_GROUPS = ["open", "cite", "export", "edit", "maintain"] as const;
