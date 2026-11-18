// What the reader core lets the WASM plugin bridge (src/wasmplugins/reader) DO to an open document: navigate, zoom, layout, search,
// sidebar, page commands. Reader.tsx registers one `ReaderOps` per open document (next to its ReaderContext); the bridge finds it with
// `opsOf(ctx)`. Reading state goes through `state()`, which reads signals, so an effect that calls it follows the reader.
// This is not a plugin contract of its own: ReaderContext (plugins.ts) stays the in-process plugin API.
import type { OutlineEntry } from "./pdf";
import type { ReaderContext } from "./plugins";
import type { ScrollMode, SpreadMode } from "./core/layout";

export interface ReaderOpsState {
	/** 0-based page at the top of the viewport */
	page: number;
	pages: number;
	/** 1 = 100% */
	zoom: number;
	zoomMode: "width" | "page" | "custom";
	scroll: ScrollMode;
	spread: SpreadMode;
	/** whole-document rotation, degrees */
	rotation: number;
	canBack: boolean;
	canForward: boolean;
	sidebar: { open: boolean; tab: string | null; width: number };
	find: { query: string; total: number; index: number; done: boolean };
	/** pages selected in the thumbnails */
	selectedPages: number[];
}

export interface ReaderOps {
	state(): ReaderOpsState;
	/** the tab's title and whether it is the shown tab (a background reader is inactive) */
	info(): { title: string; active: boolean };
	/** scroll to a page (0-based) and, with `y` (0..1 from the top), to a height on it; `record` adds a back-history entry */
	goTo(page: number, y?: number, record?: boolean): void;
	back(): void;
	forward(): void;
	/** the next / previous row (a page, a spread, a wrapped row) */
	stepRow(d: 1 | -1): void;
	zoomBy(factor: number): void;
	setZoom(z: number): void;
	fitWidth(): void;
	fitPage(): void;
	/** `page` undefined: the whole document */
	rotate(deg: number, page?: number): void;
	setLayout(scroll?: ScrollMode, spread?: SpreadMode): void;
	setSidebar(open: boolean, tab?: string): void;
	/** start a search for `q` (empty: close it) */
	search(q: string): void;
	findStep(d: 1 | -1): void;
	outline(): OutlineEntry[] | null;
	/** change the PDF file (the host confirms deletes) */
	rotatePages(pages: number[], turns: number): Promise<void>;
	deletePages(pages: number[], ask?: boolean): Promise<void>;
	print(): Promise<unknown>;
	copySelection(): boolean;
	/** focus the document so keys reach the reader */
	focus(): void;
}

const ops = new WeakMap<ReaderContext, ReaderOps>();
/** Reader.tsx: attach the operations of an open document; returns the function that removes them. */
export function registerReaderOps(ctx: ReaderContext, o: ReaderOps): () => void {
	ops.set(ctx, o);
	return () => {
		if (ops.get(ctx) === o) ops.delete(ctx);
	};
}
export const opsOf = (ctx: ReaderContext): ReaderOps | undefined => ops.get(ctx);
