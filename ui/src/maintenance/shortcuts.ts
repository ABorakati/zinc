// Zotero-style keyboard shortcuts (window keydown listener) and the help overlay registry.
import { toast } from "solid-sonner";
import { api } from "~/api";
import { store } from "~/store";
import { deleteSelected } from "./ops";
import { registerShortcutHelp, setHelpOpen, helpOpen } from "./shortcutHelp";

export { registerShortcutHelp, setHelpOpen, helpOpen };
export type { ShortcutEntry } from "./shortcutHelp";

/** Events other features / panes can listen to. */
export const EVENT_NEW_ITEM = "zn:new-item";
export const EVENT_EXPAND_ALL = "zn:collections-expand-all";
export const EVENT_COLLAPSE_ALL = "zn:collections-collapse-all";

registerShortcutHelp([
	{ group: "Items", keys: "Ctrl+Shift+N", description: "New item" },
	{ group: "Items", keys: "Delete", description: "Move selected items to the Trash (permanently delete in the Trash)" },
	{ group: "Items", keys: "Shift+Delete", description: "Delete selected items permanently" },
	{ group: "Items", keys: "Ctrl+A", description: "Select all items" },
	{ group: "Navigation", keys: "Ctrl+F", description: "Search the library" },
	{ group: "Navigation", keys: "Ctrl+Shift+L", description: "Focus the collections pane" },
	{ group: "Navigation", keys: "+", description: "Expand all collections" },
	{ group: "Navigation", keys: "-", description: "Collapse all collections" },
	{ group: "Navigation", keys: "Ctrl+W", description: "Close the current tab" },
	{ group: "General", keys: "Ctrl+/  or  ?", description: "Show keyboard shortcuts" },
]);

/** Text entry: plain keys must not be hijacked there. */
function typingIn(t: EventTarget | null): boolean {
	const el = t instanceof Element ? t : null;
	if (!el) return false;
	if (el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return true;
	return false;
}

/** Open dialogs / menus own the keyboard. */
const inOverlay = (t: EventTarget | null) => t instanceof Element && !!t.closest("[role='dialog'], [role='alertdialog'], [role='menu']");

function focusSearch() {
	const el = document.querySelector<HTMLInputElement>("input[type='search']");
	if (!el) return;
	el.focus();
	el.select();
}

function focusCollections() {
	const pane = document.querySelector<HTMLElement>("[data-pane='collections'], [role='tree']");
	const target = pane?.matches("button, [tabindex]") ? pane : pane?.querySelector<HTMLElement>("button, [tabindex], [role='treeitem']");
	if (target) return target.focus();
	// No focusable pane: at least show the whole library.
	store.setView({ kind: "library" });
}

async function selectAll() {
	try {
		const q = store.query();
		const keys: string[] = [];
		const PAGE_SIZE = 500;
		for (let off = 0; off < 20000; off += PAGE_SIZE) {
			const res = await api.items(q, off, PAGE_SIZE);
			keys.push(...res.items.map((i) => i.key));
			if (keys.length >= res.total || res.items.length < PAGE_SIZE) break;
		}
		store.setSelected(new Set(keys));
		if (keys.length) store.setActiveKey(keys.length === 1 ? keys[0] : null);
	} catch (e) {
		toast.error("Could not select all", { description: e instanceof Error ? e.message : String(e) });
	}
}

export function handleShortcut(e: KeyboardEvent): void {
	if (e.defaultPrevented || e.isComposing) return;
	const ctrl = e.ctrlKey || e.metaKey;
	const key = e.key;
	const typing = typingIn(e.target);
	if (inOverlay(e.target) && !(ctrl && key === "/")) return;
	const consume = () => { e.preventDefault(); e.stopPropagation(); };

	// Help works everywhere.
	if ((ctrl && key === "/") || (!ctrl && !typing && !e.altKey && key === "?")) {
		consume();
		setHelpOpen(!helpOpen());
		return;
	}
	// Library shortcuts only apply while the library tab (not a reader) is showing.
	if (store.activeTab() !== "library") return;

	if (ctrl && e.shiftKey && key.toLowerCase() === "n") {
		consume();
		window.dispatchEvent(new CustomEvent(EVENT_NEW_ITEM));
	} else if (ctrl && !e.shiftKey && key.toLowerCase() === "f") {
		consume();
		focusSearch();
	} else if (ctrl && e.shiftKey && key.toLowerCase() === "l") {
		consume();
		focusCollections();
	} else if (typing) {
		// everything below is a plain key / text-editing shortcut
	} else if (key === "Delete") {
		if (!store.selected().size) return;
		consume();
		void deleteSelected(e.shiftKey);
	} else if (ctrl && !e.shiftKey && key.toLowerCase() === "a") {
		consume();
		void selectAll();
	} else if (!ctrl && !e.altKey && (key === "+" || key === "=")) {
		consume();
		window.dispatchEvent(new CustomEvent(EVENT_EXPAND_ALL));
	} else if (!ctrl && !e.altKey && (key === "-" || key === "_")) {
		consume();
		window.dispatchEvent(new CustomEvent(EVENT_COLLAPSE_ALL));
	}
}

let installed = false;
/** Install the window listener once (capture phase so focused rows cannot swallow the keys). */
export function installShortcuts(): void {
	if (installed || typeof window === "undefined") return;
	installed = true;
	window.addEventListener("keydown", handleShortcut, true);
}
