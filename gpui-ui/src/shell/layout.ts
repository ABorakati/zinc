// Shell state that outlives a session: the library's layout (frame columns, panes, sizes) and the Settings tab (an extra tab
// beside Library and the readers, like the web UI's SETTINGS_TAB). Everything lives in ui-state.json ("shell.*").
//
// The layout is the working copy of docs/developer-guide/layouts.md, section 8 ("shell.layout.current.library"), normalised by
// shell/frameLayout.ts. leftOpen / rightOpen (top-bar buttons, View menu, Settings > General) are views of it: the left column
// and the "item" pane.
import { createMemo, createRoot, createSignal } from "solid-js";
import { isDocTab } from "../contracts";
import { registerAppAction } from "../registry";
import { store, uiState } from "../store";
import {
	isPluginPane,
	locatePane,
	sectionPaneId,
	migrateLegacyLibrary,
	movePane,
	normalizeLayout,
	resetSizes,
	setLeftShown,
	setPaneHidden,
	setStackActive,
	standardLibrary,
	type DropTarget,
	type KnownPanes,
	type PaneLocation,
	type ViewLayout,
} from "./frameLayout";
import { knownPanes } from "./panes";
import { RIGHT_PARTS } from "./sidebarLayout";
import { bindUiState, getPref, persisted, setPref } from "./prefs";

bindUiState(uiState); // prefs are written by store.ts's single ui-state.json writer

export const SETTINGS_TAB = "settings";

// ---- the library layout
export const LAYOUT_VERSION = 1;
const CURRENT_LIBRARY = "shell.layout.current.library";

// The built-in library panes are known here even before shell/builtinPanes.tsx registers them, so an edit made earlier (or a
// layout read earlier) never drops them; they are drawn once registered.
const BUILTIN_LIBRARY: KnownPanes = { ids: ["items", "item", ...RIGHT_PARTS.map((p) => sectionPaneId(p.id))], required: ["items"] };
const knownLibrary = (): KnownPanes => {
	const reg = knownPanes("library");
	return {
		ids: [...new Set([...BUILTIN_LIBRARY.ids, ...reg.ids])],
		required: [...new Set([...BUILTIN_LIBRARY.required, ...reg.required])],
	};
};

// First start with layouts: build the working copy from the fixed layout's keys (layouts.md, section 12). Those keys stay in the
// file for one release, so a downgrade still finds them.
if (getPref<unknown>("shell.layout.version", undefined) !== LAYOUT_VERSION) {
	setPref(CURRENT_LIBRARY, migrateLegacyLibrary((k) => getPref<unknown>(k, undefined)));
	setPref("shell.layout.active", { library: "builtin:standard" });
	setPref("shell.layout.version", LAYOUT_VERSION);
}

const [rawLibrary, setRawLibrary] = persisted<unknown>(CURRENT_LIBRARY, standardLibrary());
/** The library's layout, valid for the panes registered now (normalised again when a pane registers or goes away). */
export const libraryLayout = createRoot(() => createMemo(() => normalizeLayout(rawLibrary(), knownLibrary())));
/** Replace the library's working copy (stored normalised). */
export function setLibraryLayout(l: ViewLayout): void {
	setRawLibrary(normalizeLayout(l, knownLibrary()));
	setPref("shell.layout.version", LAYOUT_VERSION); // again, in case the "shell." keys were cleared since (Settings > Reset)
}

// ---- side panels (top-bar toggles): the left column and the item pane
export const leftOpen = (): boolean => libraryLayout().left.shown;
export const setLeftOpen = (shown: boolean): void => setLibraryLayout(setLeftShown(libraryLayout(), shown));
export const rightOpen = (): boolean => !libraryLayout().hidden.includes("item");
export const setRightOpen = (shown: boolean): void => setLibraryLayout(setPaneHidden(libraryLayout(), "item", !shown));

/** Frame and column sizes back to the defaults (the panes stay where they are). */
export function resetCols(): void {
	setLibraryLayout(resetSizes(libraryLayout()));
}

// ---- Settings tab
const [settingsOpen, setSettingsOpen] = createSignal(false);
export { settingsOpen };

/** Open the Settings tab (or focus it). */
export function openSettings(): void {
	setSettingsOpen(true);
	store.setActiveTab(SETTINGS_TAB);
}
/** Close the Settings tab; the library (or the last reader) becomes active when it was. */
export function closeSettings(): void {
	if (!settingsOpen()) return;
	setSettingsOpen(false);
	if (store.activeTab() === SETTINGS_TAB) {
		const tabs = store.tabs();
		store.setActiveTab(tabs[tabs.length - 1]?.id ?? "library");
	}
}

/** Close whichever tab is active (Ctrl+W); the library tab stays. */
export function closeActiveTab(): void {
	const id = store.activeTab();
	if (id === SETTINGS_TAB) closeSettings();
	else store.closeTab(id);
}

registerAppAction({ id: "tab-close", label: "Close tab", icon: "x", menu: "none", shortcut: "Ctrl+W", run: closeActiveTab });

// ---- moving between tabs (Zotero's tab keys): the order of the top bar, Library, the documents, then Settings
/** Tab ids in the top bar's order. */
export const tabOrder = (): string[] => [
	"library",
	...store
		.tabs()
		.filter(isDocTab)
		.map((t) => t.id),
	...(settingsOpen() ? [SETTINGS_TAB] : []),
];
/** Go `delta` tabs along, wrapping around. */
export function stepTab(delta: number): void {
	const list = tabOrder();
	const i = Math.max(0, list.indexOf(store.activeTab()));
	store.setActiveTab(list[(i + delta + list.length) % list.length]!);
}
/** The n-th tab (1-based); 9 is the last, as in browsers and Zotero. */
export function gotoTab(n: number): void {
	const list = tabOrder();
	const id = n >= 9 ? list[list.length - 1] : list[n - 1];
	if (id) store.setActiveTab(id);
}
registerAppAction({ id: "tab-next", label: "Next tab", menu: "none", shortcut: "Ctrl+Tab", run: () => stepTab(1) });
registerAppAction({ id: "tab-previous", label: "Previous tab", menu: "none", shortcut: "Ctrl+Shift+Tab", run: () => stepTab(-1) });
registerAppAction({ id: "tab-next-page", label: "Next tab (Page Down)", menu: "none", shortcut: "Ctrl+PageDown", run: () => stepTab(1) });
registerAppAction({
	id: "tab-previous-page",
	label: "Previous tab (Page Up)",
	menu: "none",
	shortcut: "Ctrl+PageUp",
	run: () => stepTab(-1),
});
for (let n = 1; n <= 9; n++)
	registerAppAction({
		id: `tab-goto-${n}`,
		label: n === 9 ? "Go to the last tab" : `Go to tab ${n}`,
		menu: "none",
		shortcut: `Ctrl+${n}`,
		run: () => gotoTab(n),
	});

// ---- moving library panes (phase 2; see docs/developer-guide/layouts-phase2.md) --------------------------------------------
// The one entry point for drag-to-dock (shell/dock.tsx), the pane menus (shell/PaneStack.tsx) and sections (shell/sectionPanes.tsx).

let undoStack: ViewLayout[] = [];
const [undoCount, setUndoCount] = createSignal(0);
/** Whether there is a layout change to undo. */
export const canUndoLayout = (): boolean => undoCount() > 0;
function remember(prev: ViewLayout): void {
	undoStack = [...undoStack.slice(-19), prev]; // the last 20 changes
	setUndoCount(undoStack.length);
}
/** Undo the last move / show / hide made through the functions below. Returns false when there is nothing to undo. */
export function undoLayout(): boolean {
	const prev = undoStack.pop();
	setUndoCount(undoStack.length);
	if (!prev) return false;
	setLibraryLayout(prev);
	return true;
}

/** Move a pane of the library (or place it, for a section being detached). Undoable. Returns false when the move is not allowed. */
export function moveLibraryPane(id: string, to: DropTarget): boolean {
	const known = knownLibrary();
	if (!known.ids.includes(id) && !isPluginPane(id)) return false;
	if (to.kind === "section" && known.required.includes(id)) return false;
	const prev = libraryLayout();
	const next = movePane(prev, id, to);
	if (next === prev) return false;
	remember(prev);
	setLibraryLayout(next);
	return true;
}
/** Show `id` in its stack (a tab click). Not undoable. */
export function activateLibraryPane(id: string): void {
	setLibraryLayout(setStackActive(libraryLayout(), id));
}
/** Hide or show a library pane in place. Undoable. */
export function hideLibraryPane(id: string, hide: boolean): void {
	const prev = libraryLayout();
	if (!locatePane(prev, id) || (hide && knownLibrary().required.includes(id)) || prev.hidden.includes(id) === hide) return;
	remember(prev);
	setLibraryLayout(setPaneHidden(prev, id, hide));
}
/** Where a library pane is, or null. */
export const libraryPaneLocation = (id: string): PaneLocation | null => locatePane(libraryLayout(), id);

import "./layoutActions";
