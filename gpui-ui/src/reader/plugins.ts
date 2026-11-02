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
	selection: Accessor<{ page: number; text: string; rects: NRect[] } | null>;
	clearSelection(): void;
	/** switch between the page view and a plugin's full-pane view (null = page view) */
	altView: Accessor<string | null>;
	setAltView(id: string | null): void;
	mode: Accessor<"light" | "dark">;
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
	/** called once per open document */
	onOpen?: (ctx: ReaderContext) => void | (() => void);
}

const [plugins, setPlugins] = createSignal<ReaderPlugin[]>([]);
export const registerReaderPlugin = (p: ReaderPlugin) => setPlugins((l) => [...l.filter((x) => x.id !== p.id), p]);
export { plugins as readerPlugins };
