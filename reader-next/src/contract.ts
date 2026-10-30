// Contracts for the zotero-next reader (reader-next/), an optional alternative to Zotero's reader.
// Page: /reader-next/index.html?attachment=<key>  (served by the core like /reader-host/).
// Three parts, built separately:
//   viewer/     EmbedPDF (PDFium/WASM, Apache-2.0) document view with our Solid UI; exposes ViewerHandle.
//   structure/  DocStructure from Zotero's document-worker (the SDT pack that powers Zotero's Reading
//               Mode): blocks, figures, tables, reference list, reading order. Also feeds reflow/.
//   academic/   citation popups (PDF link annotations + /api/references), figures & tables navigator,
//               reference list panel hooks. Mounts overlays through ViewerHandle.
//   reflow/     reflowed reading view of DocStructure with user typography (font, size, width, theme).
// Data comes from the core API (core/src/api-types.ts): /api/attachments/:key/file, /api/items/:key,
// /api/attachments/:key/view-state, /api/references/:key, /api/open-url. All mutating requests must
// send Content-Type: application/json.

/** A rectangle in PDF user space of one page: [x1, y1, x2, y2], origin bottom-left, in points. */
export type PdfRect = [number, number, number, number];

export interface PageInfo {
	index: number; // 0-based
	label?: string; // printed page label if the PDF defines one
	width: number; // points
	height: number; // points
}

export interface LinkTarget {
	kind: "internal" | "external";
	page?: number; // internal: destination page index
	top?: number; // internal: destination y in PDF points (top of the target), if known
	uri?: string; // external
}

export interface LinkClick {
	page: number;
	rect: PdfRect; // the link annotation's area
	target: LinkTarget;
	text?: string; // text under the link (e.g. "[12]" or "Smith et al., 2020")
	preventDefault(): void; // stop the viewer's own navigation (academic/ shows a popup instead)
	clientX: number; // pointer position, for positioning popups
	clientY: number;
}

export interface ViewerHandle {
	readonly attachmentKey: string;
	readonly itemKey: string | null; // parent item
	readonly pages: PageInfo[];
	/** Current page index (0-based) and zoom (1 = 100%). */
	page(): number;
	zoom(): number;
	goToPage(index: number, opts?: { top?: number; smooth?: boolean }): void;
	/** Scroll so rect on page is visible and flash-highlight it briefly. */
	reveal(page: number, rect: PdfRect): void;
	/**
	 * An absolutely positioned layer over a page (above text selection, below popups) that
	 * academic/ can draw into; toScreen converts a PDF rect to CSS pixels within that layer.
	 * Called again when pages are re-rendered (zoom); return a cleanup function.
	 */
	onPageOverlay(cb: (page: number, layer: HTMLElement, toScreen: (r: PdfRect) => { left: number; top: number; width: number; height: number }) => void | (() => void)): () => void;
	/** Link clicks and hover (hover fires after a short delay; cleared with null). */
	onLink(cb: (e: LinkClick) => void): () => void;
	onLinkHover(cb: (e: LinkClick | null) => void): () => void;
	/** Text of a page with character rects, for mapping citations/reference entries to positions. */
	pageText(index: number): Promise<{ text: string; rects: PdfRect[] }>;
	/** A crop of page `page` (rect in PDF space) rendered as a canvas at most maxWidth CSS px wide. */
	renderRegion(page: number, rect: PdfRect, maxWidth: number): Promise<HTMLCanvasElement>;
	/** Side panel slots in the viewer chrome (left sidebar tabs and a right panel). */
	addSidebarTab(tab: { id: string; title: string; icon?: string; render: (container: HTMLElement) => void | (() => void) }): () => void;
	/** Link annotations of a page (rect, target, text under the link). */
	pageLinks(index: number): Promise<{ rect: PdfRect; target: LinkTarget; text?: string }[]>;
	/** Open the sidebar on one of the tabs added with addSidebarTab. */
	showSidebarTab(id: string): void;
	/** Toolbar button (e.g. "Reading view", "Figures"). */
	addToolbarButton(btn: { id: string; title: string; icon?: string; onClick: () => void; active?: () => boolean }): () => void;
	/** Switch between the page view and an alternate full-pane view (reflow/). */
	setAlternateView(render: ((container: HTMLElement) => void | (() => void)) | null): void;
	/** True while an alternate view (the reading view) covers the pages. */
	alternateActive(): boolean;
}

/** Registered by academic/ and reflow/ from their index.ts; the viewer calls each once ready. */
export type ReaderPlugin = (viewer: ViewerHandle) => void | (() => void);

// ---------------------------------------------------------------- structure (structure/)

export type BlockType =
	| "title" | "heading" | "paragraph" | "list" | "figure" | "table" | "caption"
	| "equation" | "footnote" | "reference" | "header" | "footer" | "other";

export interface Block {
	id: string;
	type: BlockType;
	page: number;
	rects: PdfRect[];
	text: string; // plain text ("" for pure images)
	html?: string; // inline formatting (italics, sub/superscript, links) when available
	level?: number; // heading level
	captionOf?: string; // caption block -> figure/table block id
}

export interface FigureOrTable {
	id: string;
	kind: "figure" | "table";
	label?: string; // "Figure 2", "Table 1"
	page: number;
	rect: PdfRect; // the image/table area
	captionBlockId?: string;
	caption?: string;
}

export interface ReferenceEntry {
	index: number; // 1-based order in the bibliography
	text: string;
	page: number;
	rects: PdfRect[];
}

export interface DocStructure {
	blocks: Block[]; // in reading order; headers/footers marked so reflow can skip them
	figures: FigureOrTable[];
	tables: FigureOrTable[];
	references: ReferenceEntry[];
	outline: { title: string; level: number; blockId: string }[];
}

/** structure/load.ts — implemented by the structure owner; cached per attachment (Cache API). */
export type LoadStructure = (attachmentKey: string, pdfBytes: ArrayBuffer, onProgress?: (pct: number) => void) => Promise<DocStructure>;
