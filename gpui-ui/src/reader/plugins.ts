// Reader extension points (the GPUI counterpart of reader-next/src/contract.ts ReaderPlugin). The reader core
// (Reader.tsx) hosts plugins; features such as annotations, citations/figures (academic) and the reflowed reading
// view register here from their own folder. CONTRACT: fixed signatures; the reader core implements the hosting.
import { createSignal, type Accessor, type JSX } from "solid-js";

/** A rect in page space, normalised 0..1 (x, y from the top-left of the page). */
export interface NRect { x: number; y: number; w: number; h: number }
export interface Word { t: string; x: number; y: number; w: number; h: number; l: number /* line index */ }

export interface ReaderContext {
	attachmentKey: string;
	itemKey: string;
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
		page: number; text: string; rects: NRect[];
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
	onLink?(cb: (e: { page: number; rect: NRect; target: { kind: "page"; page: number; y: number } | { kind: "uri"; uri: string }; x: number; y: number }) => boolean | void): () => void;
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
	/** called once per open document */
	onOpen?: (ctx: ReaderContext) => void | (() => void);
}

const [plugins, setPlugins] = createSignal<ReaderPlugin[]>([]);
export const registerReaderPlugin = (p: ReaderPlugin) => setPlugins((l) => [...l.filter((x) => x.id !== p.id), p]);
export { plugins as readerPlugins };
