// Shared interfaces for the GPUI spike (zotero-next's library window drawn natively by GPUIX/GPUI, not a web view).
// Each module below is owned by one person/agent; code against these signatures, not each other's internals.
//
//   theme.ts      tokens (ui/src/styles.css resolved to concrete colours, light + dark) and tw(): Tailwind classes -> style
//   icons.tsx     <Icon name="folder" size={14} color=... />  (lucide, by kebab-case name)
//   fonts.ts      registerFonts(): the UI's fonts (ui/src/fonts.css) registered with GPUIX
//   api.ts        HTTP client for the core API (ZN_URL, default http://127.0.0.1:23160 during the spike)
//   store.ts      app state (Solid signals) implementing Store below
//   App.tsx       window layout: top bar, sidebar | list | item pane placeholder; Toolbar.tsx (search box, view toggle)
//   Sidebar.tsx   library + collections tree (ui/src/Collections.tsx look)
//   cards/        Card.tsx + CardList.tsx (ui/src/cards look), virtual-list over the store's items
//   main.tsx      registerFonts(); render(() => <App />, ...)
//
// GPUIX facts (v0.11.0, Windows): every <text> needs an explicit color (no inheritance); a <text> with mixed static
// text and {signal()} children renders as separate stacked nodes, so pass one template string; headless screenshots
// work: createTestRoot() from "@gpuix/solid/testing" + renderer.captureScreenshot(path) (window comes out ~1440x880
// whatever size is asked). Never drive the user's screen.
import type { Accessor } from "solid-js";

export type Mode = "light" | "dark";

/** A GPUIX style object (what <div style={...}> takes). */
export type Style = Record<string, unknown>;

export interface Collection {
	key: string;
	name: string;
	parentKey: string | null;
	itemCount: number;
	/** ISO dates, when the core sends them (it does not today: the sidebar then uses first-seen times, collectionStyle.ts). */
	dateAdded?: string;
	dateModified?: string;
	children?: Collection[];
}

/** One row of GET /api/items (fields as the core returns them; see ui/src/api.ts ItemSummary). */
export interface ItemRow {
	key: string;
	itemType: string;
	title: string;
	creatorsSummary?: string;
	creators?: { firstName?: string; lastName?: string; name?: string; creatorType?: string }[];
	year?: number | string | null;
	publication?: string;
	dateAdded?: string;
	tags?: { tag: string; type?: number }[];
	primaryAttachment?: { key: string; contentType?: string } | null;
	attachmentCount?: number;
	noteCount?: number;
	[k: string]: unknown;
}

// ---- feature-parity port: shared types (see registry.ts for extension points, ui/index.tsx for UI building blocks) ----

/** What the item list shows (ui/src/store.ts View). */
export type View =
	| { kind: "library" }
	| { kind: "collection"; key: string }
	| { kind: "unfiled" }
	| { kind: "trash" }
	| { kind: "duplicates" }
	| { kind: "savedSearch"; key: string }
	| { kind: "publications" };

/** Sort level as in the web UI's SortBar (up to 4); while grouped, level 1 is the group field. */
export interface SortLevel { key: string; dir: "asc" | "desc" }
export type GroupBy = "none" | "year" | "itemType" | "creator" | "publication" | "dateAdded";

/**
 * Library-list state added for parity (implemented in store.ts by the list/table owner; other features use it).
 * view/setView replaces selectedCollection (which becomes view().kind === "collection" ? key : null);
 * selectedItem() stays the focused item, selected() is the multi-selection.
 */
export interface ListStore {
	view: Accessor<View>;
	setView(v: View): void;
	tagFilter: Accessor<string[]>;
	setTagFilter(tags: string[]): void;
	selected: Accessor<Set<string>>;
	setSelected(keys: Set<string>): void;
	viewMode: Accessor<"cards" | "table">;
	setViewMode(m: "cards" | "table"): void;
	sortLevels: Accessor<SortLevel[]>;
	setSortLevels(l: SortLevel[]): void;
	groupBy: Accessor<GroupBy>;
	setGroupBy(g: GroupBy): void;
	/** re-fetch collections + the list after a change (edits, imports, trash…) */
	refresh(): void;
}

/** The permanent first tab: the library (sidebar | list | item pane). */
export interface LibraryTab { id: "library" }
/** A PDF reader tab; its id is the attachment key. */
export interface ReaderTab { id: string; kind: "reader"; title: string; itemKey: string }
/** A web reader tab (HTML snapshots, EPUBs): Zotero's reader-host page in the shared WebView2 (src/webview); its id is the attachment key. */
export interface WebTab { id: string; kind: "web"; title: string; itemKey: string; attachmentKey: string; contentType: string }
export type Tab = LibraryTab | ReaderTab | WebTab;
export const isReaderTab = (t: Tab): t is ReaderTab => "kind" in t && t.kind === "reader";
export const isWebTab = (t: Tab): t is WebTab => "kind" in t && t.kind === "web";
/** Tabs that hold a document (native reader or web view): drawn as a chip in the top bar and a full-width body. */
export const isDocTab = (t: Tab): t is ReaderTab | WebTab => isReaderTab(t) || isWebTab(t);

export interface Store {
	/** Open tabs in strip order; tabs()[0] is always the library. */
	tabs: Accessor<Tab[]>;
	/** Tab id: "library" or a reader tab's attachment key. */
	activeTab: Accessor<string>;
	setActiveTab(id: string): void;
	/** Open the attachment in a reader tab, or focus its tab if already open. */
	openAttachment(attachmentKey: string, title: string, itemKey: string): void;
	/** Close a reader tab (the library tab cannot be closed); the neighbour becomes active when the closed tab was. */
	closeTab(id: string): void;
	mode: Accessor<Mode>;
	setMode(m: Mode): void;
	collections: Accessor<Collection[]>; // tree (roots with children)
	selectedCollection: Accessor<string | null>; // null = My Library
	selectCollection(key: string | null): void;
	filter: Accessor<string>;
	setFilter(q: string): void;
	total: Accessor<number>; // items matching the current collection + filter
	/** Row i of the current list, or undefined while its page loads (the call triggers the fetch). */
	itemAt(i: number): ItemRow | undefined;
	/** Bumped whenever the list is reset (collection/filter change) so views can re-read. */
	listVersion: Accessor<number>;
	selectedItem: Accessor<string | null>;
	selectItem(key: string | null): void;
}
