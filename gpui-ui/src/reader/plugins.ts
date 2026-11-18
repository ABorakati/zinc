// Reader extension points (the GPUI counterpart of reader-next/src/contract.ts ReaderPlugin). The reader core
// (Reader.tsx) hosts plugins; features such as annotations, citations/figures (academic) and the reflowed reading
// view register here from their own folder. CONTRACT: fixed signatures; the reader core implements the hosting.
import { createSignal, type Accessor, type JSX } from "solid-js";
import type { MenuItem } from "../ui/core";
import type { Annotation } from "./annotations/model";

/** A rect in page space, normalised 0..1 (x, y from the top-left of the page). */
export interface NRect {
	x: number;
	y: number;
	w: number;
	h: number;
}
export interface Word {
	t: string;
	x: number;
	y: number;
	w: number;
	h: number;
	l: number; /* line index */
}

export interface ReaderContext {
	attachmentKey: string;
	itemKey: string;
	/** true when the attachment's library cannot be edited by this user (a read-only group): the annotation tools and edits are off */
	readOnly?: boolean;
	pageCount: Accessor<number>;
	/** page size in PDF points */
	pageSize(i: number): { w: number; h: number };
	/** positioned words of a page (cached by the core) */
	textLayer(i: number): Promise<{ words: Word[] }>;
	/** raw PDF bytes (for plugins that run their own analysis, e.g. structure extraction) */
	pdfBytes(): Promise<Uint8Array>;
	currentPage: Accessor<number>; // 0-based, the page at the top of the viewport
	zoom: Accessor<number>;
	scrollTo(page: number, yNorm?: number): void;
	/** current text selection (set by the reader core's drag-select), null when none */
	selection: Accessor<{
		/** the page of the selection's first word; `rects` are that page's rects (unrotated page space) */
		page: number;
		text: string;
		rects: NRect[];
		/** added by the core: every page the selection touches, in order (a selection can span pages); `pages[0]` is {page, rects} */
		pages?: { page: number; rects: NRect[] }[];
	} | null>;
	clearSelection(): void;
	/** switch between the page view and a plugin's full-pane view (null = page view) */
	altView: Accessor<string | null>;
	setAltView(id: string | null): void;
	mode: Accessor<"light" | "dark">;

	// ---- optional additions by the reader core (always provided by the core; optional so older plugin code and mocks still type-check)
	/** the page's rotation in degrees (0/90/180/270) as displayed. pageOverlay draws in UNROTATED page space: the core hides a plugin's
	 *  overlay on a rotated page unless the plugin sets `handlesRotation` (then it must rotate its own rects, see core/text.ts rotRect). */
	rotation?(page: number): number;
	/** link annotations of a page: rect in unrotated page space; internal targets carry the destination page + y (0..1, -1 unknown) */
	pageLinks?(page: number): Promise<{ rect: NRect; target: { kind: "page"; page: number; y: number } | { kind: "uri"; uri: string } }[]>;
	/** Intercept link clicks (e.g. to show a citation popup instead of jumping): return true to stop the core's navigation. x/y: window px. */
	onLink?(
		cb: (e: {
			page: number;
			rect: NRect;
			target: { kind: "page"; page: number; y: number } | { kind: "uri"; uri: string };
			x: number;
			y: number;
		}) => boolean | void,
	): () => void;
	openUrl?(url: string): boolean;
	/** put text on the clipboard */
	copy?(text: string): boolean;
	/** window-space rect (logical px) of a rect on a mounted page, null while the page is not mounted: for positioning popups */
	rectToWindow?(page: number, rect: NRect): { x: number; y: number; width: number; height: number } | null;
	/** bumps whenever pages move on screen (scroll, zoom, layout): read it in an effect to follow an anchored popup */
	viewTick?: Accessor<number>;
	/** the page currently being drawn: 0-based indexes of the mounted pages */
	mountedPages?: Accessor<number[]>;
	/** open / close the reader's left sidebar, optionally on a tab (a plugin's sidePanel id) */
	setSidebar?(open: boolean, tab?: string): void;
	/** the sidebar tab being shown, null while the sidebar is closed */
	sidebarTab?: Accessor<string | null>;
}

export interface ReaderPlugin {
	id: string;
	/** extra toolbar controls, right of the core's */
	toolbar?: (ctx: ReaderContext) => JSX.Element;
	/** a tab in the reader's left sidebar (core provides Thumbnails + Outline) */
	sidePanel?: { id: string; label: string; icon: string; render: (ctx: ReaderContext) => JSX.Element };
	/** drawn over each mounted page, sized to the page box; use NRect × the box size */
	pageOverlay?: (ctx: ReaderContext, page: number, box: Accessor<{ width: number; height: number }>) => JSX.Element;
	/** shown in a small popup at the selection when text is selected (e.g. highlight colours) */
	selectionPopup?: (ctx: ReaderContext) => JSX.Element;
	/** a full-pane alternate view, shown when ctx.altView() === id (e.g. the reflowed reading view) */
	altView?: { id: string; label: string; icon: string; render: (ctx: ReaderContext) => JSX.Element };
	/** the plugin's pageOverlay rotates its own rects (see ReaderContext.rotation); otherwise the overlay is hidden on rotated pages */
	handlesRotation?: boolean;
	/** rows a plugin adds under the swatches of the annotation tool's colour popover (Zotero's createColorContextMenu); only items with
	 *  an `onSelect` are drawn. This and the two hooks below are used by the WASM plugin bridge (src/wasmplugins/reader). */
	colorMenu?: (ctx: ReaderContext) => MenuItem[];
	/** extra items at the end of the annotation sidebar's tag filter menu (Zotero's createSelectorContextMenu) */
	selectorMenu?: (ctx: ReaderContext, e: { enableClearSelection: boolean }) => MenuItem[];
	/** extra items in the reader's appearance popup (Zotero's createThemeContextMenu); `theme` is "normal", "dark", "sepia", "custom" or "reading" */
	themeMenu?: (ctx: ReaderContext, e: { theme: string }) => MenuItem[];
	/** a key press the core did not take for itself (Zotero's reader shortcuts: tools, colours, delete). Return true when handled, so
	 *  the core stops it. `onRoot` is false while a text field has the focus (a comment box): plugins must not take bare keys then. */
	onKey?: (
		ctx: ReaderContext,
		e: { key: string; modifiers: { ctrl: boolean; shift: boolean; alt: boolean; cmd: boolean }; onRoot: boolean },
	) => boolean;
	/** extra items at the end of an annotation's context menu (the sidebar card and the annotation on the page); `ids` are the annotations
	 *  the menu acts on (Zotero's createAnnotationContextMenu) */
	annotationMenu?: (ctx: ReaderContext, e: { ids: string[]; annotation: Annotation }) => MenuItem[];
	/** drawn in the header row of each annotation card in the sidebar, before the delete button (Zotero's renderSidebarAnnotationHeader) */
	annotationHeader?: (ctx: ReaderContext, annotation: Accessor<Annotation>) => JSX.Element;
	/** extra items at the end of the toolbar's View menu (Zotero's createViewContextMenu) */
	viewMenu?: (ctx: ReaderContext) => MenuItem[];
	/** extra items at the end of a thumbnail's right-click menu; `pages` are the 0-based pages it acts on (createThumbnailContextMenu) */
	thumbnailMenu?: (ctx: ReaderContext, pages: number[]) => MenuItem[];
	/** called once per open document */
	onOpen?: (ctx: ReaderContext) => void | (() => void);
}

const [plugins, setPlugins] = createSignal<ReaderPlugin[]>([]);
export const registerReaderPlugin = (p: ReaderPlugin) => setPlugins((l) => [...l.filter((x) => x.id !== p.id), p]);
export { plugins as readerPlugins };
/** Remove a plugin (the Zotero plugin system drops a plugin's reader hooks when it shuts down). */
export const unregisterReaderPlugin = (id: string) => setPlugins((l) => (l.some((x) => x.id === id) ? l.filter((x) => x.id !== id) : l));

/** The menu items the registered plugins add through `pick`, behind a separator (empty when none): a failing plugin is skipped. */
export function pluginMenuItems(pick: (p: ReaderPlugin) => MenuItem[] | undefined): MenuItem[] {
	const out: MenuItem[] = [];
	for (const p of plugins()) {
		try {
			const items = pick(p);
			if (items?.length) out.push(...items);
		} catch (e) {
			console.error(`[reader] plugin ${p.id} menu:`, e);
		}
	}
	return out.length ? [{ separator: true }, ...out] : out;
}

const [openReaders, setOpenReaders] = createSignal<ReaderContext[]>([]);
/** The documents open in a reader now, oldest first (Zotero.Reader._readers). The reader core adds a context here when it opens a document. */
export { openReaders };
/** Record an open document; returns the function that removes it. */
export const trackOpenReader = (c: ReaderContext): (() => void) => {
	setOpenReaders((l) => [...l, c]);
	return () => setOpenReaders((l) => (l.includes(c) ? l.filter((x) => x !== c) : l));
};

// Menus whose plugin items come from a WASM plugin (src/wasmplugins/reader/menus.ts) need an answer from another process, but Zinc's menu
// layer reads its items once when it opens. The bridge `holdMenu`s the pending answer; `openAfterPlugins` evaluates the items once (which
// starts the plugin's build-menu), waits for what is pending (at most MENU_WAIT_MS), then opens the menu with the answers in.
const pendingMenus = new Set<Promise<unknown>>();
const MENU_WAIT_MS = 600;
export function holdMenu(p: Promise<unknown>): void {
	pendingMenus.add(p);
	const done = () => void pendingMenus.delete(p);
	p.then(done, done);
}
export function openAfterPlugins(open: (items: MenuItem[]) => void, build: () => MenuItem[]): void {
	const first = build();
	if (!pendingMenus.size) return open(first);
	const waiting = Promise.race([Promise.allSettled([...pendingMenus]), new Promise((r) => setTimeout(r, MENU_WAIT_MS))]);
	void waiting.then(() => open(build()));
}
