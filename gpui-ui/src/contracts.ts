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

export interface Store {
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
