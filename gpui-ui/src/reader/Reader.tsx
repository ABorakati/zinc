// Native PDF reader: pages are rasterized by hayro (native/pdf, via bun:ffi) into tiles that live as <img> in a windowed GPUIX
// <virtual-list>. It lives inside the app window and fills its parent:
//
//   <Reader attachmentKey="ABCD1234" title="Zare 2017" active={tab is visible} />
//
// What it does (the GPUI counterpart of reader-next/src/viewer):
//  * fetches the PDF through the core (library.ts); fit width / fit page / custom zoom (Ctrl +/-/0, Ctrl+wheel, toolbar), rotation,
//    page navigation (PgUp/PgDn/Home/End/arrows/space, page box), find with a result list, page appearance (dark / sepia / custom),
//    drag text selection with copy (Ctrl+C or the popup), link annotations (internal jump with Alt+Left to come back, http(s) opens
//    the browser), a left sidebar (thumbnails, outline, find results, plus plugin panels) and remembers page / zoom / rotation per
//    document in %APPDATA%\zotero-next-gpui\reader-state.json.
//  * hosts the plugin contract (plugins.ts): toolbar items, sidebar panels, a page overlay on every mounted page, the selection
//    popup, alternate full-pane views (the pages are unmounted while one is shown) and onOpen.
//  * memory: see core/Page.tsx. Only the pixels near the viewport exist; `active=false` (a background tab) frees all of them.
//  * layout follows the container (onLayout); the page column is centred with 16 px gutters and a 12 px gap on a "muted" canvas.
//  * page layouts (the toolbar's View menu, per document, default in Settings): vertical / horizontal / wrapped scrolling and odd /
//    even spreads (core/layout.ts groups the pages into the rows of the virtual list, or the columns of a horizontal strip); Rotate /
//    Delete Pages change the PDF file as Zotero does (core/pageops.ts), Print shows the system print dialog (core/layoutui.tsx).
import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack, type Accessor, type JSX } from "solid-js";
import { useGpuix } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/solid";
import type { Mode, Style } from "../contracts";
import { Icon } from "../icons";
import { textStyle, tokens, tw, withAlpha } from "../theme";
import { readerMode, windowDpr } from "./env";
import { openPdf, fetchAttachment } from "./library";
import { PdfDoc, type OutlineEntry, type PdfLink, type TextLayer, type TextWord } from "./pdf";
import { readerPlugins, type NRect, type ReaderContext, type ReaderPlugin, type Word } from "./plugins";
import { readerAppearance as appearance, initReaderAppearance, lookOf, paperColor, paperIsDark, setReaderAppearance, type Appearance } from "./core/appearance";
import { BitmapCache, type LinkInfo, type Margins, PageSlot, type PageEnv, type PageStats, type ViewRect } from "./core/Page";
import { Previews, type PreviewWant } from "./core/preview";
import { Scheduler } from "./core/scheduler";
import { runSelfTest, selfTestDir } from "./selftest";
import { FindResults, Outline, Sidebar, SIDEBAR_MIN, Thumbnails, type HitRow, type SideTab } from "./core/Sidebar";
import { getDocState, getSidebar, saveSidebar, setDocState, type ZoomMode } from "./core/state";
import { copyText, isSafeUrl, openUrl } from "./core/sys";
import { buildPageText, caretAt, cmpCaret, lineAt, rotRect, selectionRects, selectionText, unrotPoint, wordAt, type Caret, type PageText } from "./core/text";
import { buildLayout, isScrollMode, isSpreadMode, medianUnit, rowAt, rowPages, unitOf, type Layout, type ScrollMode, type SpreadMode } from "./core/layout";
import { setDocGeometry } from "./core/geometry";
import { createPageCommands, PrintButton, ViewMenuButton } from "./core/layoutui";
import { readerPrefs } from "../settings/readerPrefs";

export const CSS_PER_PT = 96 / 72; // zoom 1 (100%) = 96 dpi, like the web reader
export const GAP = 12; // between pages
export const PAD = 16; // around the page column
const SPREAD_GAP = 4; // between the two pages of a spread
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;
const TEXT_CACHE = 40; // pages of text layer kept (selection, links and plugins use them)
/** css px of pre-rendered page ahead of the viewport (at rest .. at the fastest scroll), and behind it */
const AHEAD_MIN = 400, AHEAD_MAX = 1000, BEHIND = 120;

export interface ReaderStats extends PageStats {}

/** Hooks for scripts (screenshots, benchmarks); the app does not need them. */
export interface ReaderController {
	/** null until the document is open */
	doc(): PdfDoc | null;
	stats: ReaderStats;
	/** effective zoom (1 = 100%) */
	zoom: Accessor<number>;
	setZoom(z: number): void;
	fitWidth(): void;
	fitPage(): void;
	scrollToPage(i: number, yNorm?: number): void;
	/** page tiles currently alive (their <img> exists) */
	tiles(): number;
	/** pages mounted (their box exists) */
	mounted(): number;
	/** [first, last] page index visible (fractional first) */
	visible(): [number, number];
	dpr(): number;
	/** resolves when no render is queued or running */
	idle(): Promise<void>;
	/** resolves when the document is open (or failed) */
	ready(): Promise<void>;
	error(): string | null;
	search(q: string): void;
	next(): void;
	prev(): void;
	/** [current 1-based, total, finished scanning] */
	hits(): [number, number, boolean];
	hitRows(): HitRow[];
	rotate(deg: number, page?: number): void;
	/** select from (page, word, char) to (page, word, char) like a drag would */
	select(a: Caret, b: Caret): Promise<void>;
	selectedText(): string | null;
	copySelection(): boolean;
	clearSelection(): void;
	/** page at the top, as persisted */
	viewState(): { page: number; frac: number; zoomMode: ZoomMode; zoom: number; rot: number };
	/** the plugin context handed to plugins (null before the document is open) */
	context(): ReaderContext | null;
	linksOf(page: number): LinkInfo[];
	outline(): OutlineEntry[] | null;
	setSidebar(open: boolean, tab?: string): void;
	setAltView(id: string | null): void;
	/** internal view state, for diagnosing layout problems */
	debug(): unknown;
	/** simulate a key press as the root element receives it (tests) */
	key(e: { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean }): void;
	/** a mouse-wheel event over the page list through GPUI's own hit test (positive dy = scroll down, css px); false when there is no list yet */
	wheel(dy: number): boolean;
	/** for every mounted page that intersects the viewport, as the list's true scroll position (not the polled one) puts it: visible area and the fractions blank / soft / sharp */
	coverage(): { page: number; vis: number; blank: number; soft: number; sharp: number; noSrc: number }[];
	/** low-resolution page previews: rendered so far and still in flight */
	previews(): { made: number; pending: number };
	/** page layout (View menu): scroll mode and spreads */
	layout(): { scroll: ScrollMode; spread: SpreadMode; rows: number };
	setLayout(scroll?: ScrollMode, spread?: SpreadMode): void;
	/** pages selected in the thumbnails (0-based) */
	selectedPages(): number[];
	selectPages(pages: number[]): void;
	/** Rotate Pages / Delete Pages: change the PDF file (delete asks for confirmation unless `ask` is false) */
	rotatePages(pages: number[], turns: number): Promise<void>;
	deletePages(pages: number[], ask?: boolean): Promise<void>;
}

export interface ReaderProps {
	/** the attachment (not the item) whose PDF to show */
	attachmentKey: string;
	title?: string;
	/** the parent item's key (plugins get it as ctx.itemKey; looked up from the open tabs when omitted) */
	itemKey?: string;
	/** false: stay mounted but free the page bitmaps and stop rendering (default true) */
	active?: boolean;

	// ---- optional extras for scripts; the app passes none of them
	/** open this file instead of fetching `attachmentKey` */
	path?: string;
	/** or use an already open document (the caller closes it) */
	doc?: PdfDoc;
	/** initial custom zoom (default: fit width, or the remembered one) */
	zoom?: number;
	/** force the device pixel ratio (default: the window's) */
	dpr?: number;
	/** max pages mounted at once (default: the visible ones plus one on each side) */
	window?: number;
	/** initial search text */
	highlight?: string;
	/** outline every word rect of the text layer (geometry check) */
	debugWords?: boolean;
	showToolbar?: boolean;
	/** do not read / write reader-state.json for this instance */
	ephemeral?: boolean;
	controller?: (c: ReaderController) => void;
}

interface Hit { page: number; rects: NRect[]; snippet: string }

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const eqScroll = (a: { idx: number; off: number; h: number }, b: { idx: number; off: number; h: number }) => a.idx === b.idx && a.off === b.off && a.h === b.h;

// ------------------------------------------------------------------------------------------------ search

/** Case-insensitive hits of `needle` (already lower-cased, single-spaced) in a page's words; phrases may span words and lines. */
function searchLayer(words: { t: string; x: number; y: number; w: number; h: number; l: number }[], needle: string): { rects: NRect[]; snippet: string }[] {
	if (!needle || !words.length) return [];
	const starts: number[] = [];
	let off = 0;
	const parts: string[] = [];
	for (const w of words) { starts.push(off); parts.push(w.t); off += w.t.length + 1; }
	const joined = parts.join(" ");
	const text = joined.toLowerCase();
	const out: { rects: NRect[]; snippet: string }[] = [];
	let from = 0;
	for (;;) {
		const i = text.indexOf(needle, from);
		if (i < 0) break;
		const e = i + needle.length;
		from = e;
		let lo = 0, hi = starts.length - 1;
		while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid]! + words[mid]!.t.length <= i) lo = mid + 1; else hi = mid; }
		const rects: NRect[] = [];
		let cur: (NRect & { l: number }) | undefined;
		for (let k = lo; k < starts.length && starts[k]! < e; k++) {
			const w = words[k]!;
			if (cur && cur.l === w.l) {
				const x2 = Math.max(cur.x + cur.w, w.x + w.w), y1 = Math.min(cur.y, w.y), y2 = Math.max(cur.y + cur.h, w.y + w.h);
				cur = { x: cur.x, y: y1, w: x2 - cur.x, h: y2 - y1, l: w.l };
			} else {
				if (cur) rects.push({ x: cur.x, y: cur.y, w: cur.w, h: cur.h });
				cur = { x: w.x, y: w.y, w: w.w, h: w.h, l: w.l };
			}
		}
		if (cur) rects.push({ x: cur.x, y: cur.y, w: cur.w, h: cur.h });
		if (rects.length) {
			const a = Math.max(0, i - 28), b = Math.min(joined.length, e + 56);
			out.push({ rects, snippet: `${a > 0 ? "…" : ""}${joined.slice(a, b)}${b < joined.length ? "…" : ""}` });
		}
	}
	return out;
}

// ------------------------------------------------------------------------------------------------ toolbar bits

function IconButton(p: { icon: string; title: string; mode: Accessor<Mode>; onClick: () => void; on?: boolean; disabled?: boolean; size?: number }): JSX.Element {
	const t = (cls: string): Style => tw(cls, p.mode());
	const tok = (n: string) => tokens[p.mode()][n] ?? "#888";
	return (
		<div
			aria-label={p.title}
			onClick={() => { if (!p.disabled) p.onClick(); }}
			style={{
				...t("flex size-8 flex-none items-center justify-center rounded-md"),
				cursor: p.disabled ? "default" : "pointer",
				...(p.on ? { backgroundColor: tok("accent") } : {}),
				hover: p.disabled ? {} : t("bg-accent"),
			}}
		>
			<Icon name={p.icon} size={p.size ?? 16} color={tok(p.disabled ? "border" : p.on ? "foreground" : "muted-foreground")} />
		</div>
	);
}

/** A labelled toolbar toggle (icon + text), for the plugins' alternate views ("Reading view"): an icon alone is not discoverable. */
function LabelButton(p: { icon: string; label: string; mode: Accessor<Mode>; onClick: () => void; on?: boolean }): JSX.Element {
	const t = (cls: string): Style => tw(cls, p.mode());
	const tok = (n: string) => tokens[p.mode()][n] ?? "#888";
	return (
		<div
			aria-label={p.label}
			onClick={p.onClick}
			style={{
				...t("flex h-8 flex-none items-center justify-center gap-1.5 rounded-md border px-2.5"), cursor: "pointer", borderColor: tok(p.on ? "foreground" : "input"),
				...(p.on ? { backgroundColor: tok("accent") } : {}), hover: t("bg-accent"),
			}}
		>
			<Icon name={p.icon} size={15} color={tok(p.on ? "foreground" : "muted-foreground")} />
			<text style={{ ...textStyle("text-[12px] font-medium text-foreground", p.mode()), whiteSpace: "nowrap" }}>{p.label}</text>
		</div>
	);
}

const APPEARANCES: { id: Appearance["mode"]; label: string; swatch: string }[] = [
	{ id: "normal", label: "Normal", swatch: "#ffffff" },
	{ id: "dark", label: "Dark", swatch: "#1d1d1f" },
	{ id: "sepia", label: "Sepia", swatch: "#f4ecd8" },
];
const CUSTOM_COLORS = ["#e8f0e0", "#dbe7f5", "#f5e1e1", "#fff8c6", "#2b3a42", "#1b2b1b"];

// ------------------------------------------------------------------------------------------------ the reader

let pluginsLoaded = false;
/** The reader plugins (annotations, academic, reflow) register themselves through ./register once, on the first reader that opens. */
function loadPlugins(): void {
	if (pluginsLoaded || process.env.ZN_NO_PLUGINS === "1") return;
	pluginsLoaded = true;
	void import("./register").then((m) => m.register()).catch((e) => console.error("[reader] plugins:", e instanceof Error ? e.message : e));
}

export function Reader(props: ReaderProps): JSX.Element {
	if (props.ephemeral !== true) { loadPlugins(); initReaderAppearance(); }
	const gpuix = useGpuix();
	const mode = readerMode();
	const t = (cls: string): Style => tw(cls, mode());
	const tx = (cls: string): Style => textStyle(cls, mode());
	const tok = (name: string): string => tokens[mode()][name] ?? "#888";
	const persist = props.ephemeral !== true;

	const active = () => props.active !== false;
	const key = () => props.attachmentKey;

	// ---- the document ---------------------------------------------------------------------------------------------
	const [doc, setDoc] = createSignal<PdfDoc | null>(null);
	const [error, setError] = createSignal<string | null>(null);
	const [loading, setLoading] = createSignal(false);
	let owned: PdfDoc | null = null;
	let abort: AbortController | undefined;
	let loadGen = 0;
	let readyWaiters: (() => void)[] = [];
	const settleReady = () => { const w = readyWaiters; readyWaiters = []; for (const f of w) f(); };
	let sched = new Scheduler(2);

	function closeOwned() { if (owned) { owned.close(); owned = null; } }
	async function load(): Promise<void> {
		const my = ++loadGen;
		abort?.abort();
		abort = new AbortController();
		setError(null);
		setLoading(true);
		setDoc(null);
		sched.clear();
		sched = new Scheduler(2);
		closeOwned();
		textCache.clear();
		textPending.clear();
		linksCache.clear();
		setOutline(null);
		setHits([]);
		setCur(-1);
		scanGen++;
		setWin([0, 3]);
		setVis([0, 1]);
		setSp({ idx: 0, off: 0, h: 0 });
		saved = [0, 0];
		list = undefined;
		bytesRef = undefined;
		try {
			let d: PdfDoc;
			if (props.doc) d = props.doc;
			else {
				d = await openPdf(props.path ?? props.attachmentKey, abort.signal);
				if (my !== loadGen) { d.close(); return; }
				owned = d;
			}
			if (d.pageCount < 1) throw new Error("the PDF has no pages");
			restoreState();
			// re-opened after Rotate / Delete Pages: the same place, the view rotations on their pages
			if (reopenWith) { saved = reopenWith.anchor; setPageRots(reopenWith.rots); reopenWith = undefined; }
			setDocGeometry(key(), { rots: Array.from({ length: d.pageCount }, (_, i) => d.pageRotation(i)), sizes: d.sizes });
			setDoc(d);
			if (saved[0] > 0) { const r = rowOf(saved[0]); setWin([Math.max(0, r - 1), r + 3]); }
		} catch (e) {
			if (my !== loadGen || (e as Error).name === "AbortError") return;
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			if (my === loadGen) { setLoading(false); settleReady(); }
		}
	}
	// open on first activation (a tab opened in the background costs nothing), and again when the attachment changes
	let loadedFor: string | undefined;
	createEffect(() => {
		const a = active(), k = `${props.path ?? ""}|${props.attachmentKey}`;
		if (!a || loadedFor === k) return;
		loadedFor = k;
		untrack(() => void load());
	});
	onCleanup(() => { loadGen++; abort?.abort(); sched.clear(); saveNow(); closeOwned(); scanGen++; });

	// ---- viewport / zoom / rotation -------------------------------------------------------------------------------
	const [vp, setVp] = createSignal({ w: 0, h: 0 });
	const [dpr, setDpr] = createSignal(props.dpr ?? windowDpr());
	const refreshDpr = () => setDpr(props.dpr ?? windowDpr());

	const [zoomMode, setZoomMode] = createSignal<ZoomMode>(props.zoom ? "custom" : "width");
	const [zoomCustom, setZoomCustom] = createSignal(props.zoom ?? 1);
	const [docRot, setDocRot] = createSignal(0);
	const [pageRots, setPageRots] = createSignal<Record<number, number>>({});
	const [rotTick, setRotTick] = createSignal(0);
	const rotOf = (i: number): number => (((docRot() + (pageRots()[i] ?? 0)) % 360) + 360) % 360;
	const swapped = (i: number) => rotOf(i) % 180 !== 0;
	/** displayed page size in PDF points */
	const dispPt = (i: number): [number, number] => { const s = doc()!.sizes[i]!; return swapped(i) ? [s[1], s[0]] : s; };

	// page layout (View menu, core/layout.ts): scroll mode and spreads, per document; new documents get the Settings default
	const [scrollMode, setScrollMode] = createSignal<ScrollMode>(readerPrefs.scrollMode());
	const [spreadMode, setSpreadMode] = createSignal<SpreadMode>(readerPrefs.spreadMode());
	const horiz = () => scrollMode() === "horizontal";
	// fit width / fit page fit a whole unit: with spreads, two pages side by side
	const fitUnit = createMemo(() => { const d = doc(); return d ? medianUnit(d.pageCount, spreadMode(), (i) => dispPt(i)[0]) : { w: 612, pages: 1 }; });
	const fitW = createMemo(() => clamp((Math.max(100, vp().w) - PAD * 2 - SPREAD_GAP * (fitUnit().pages - 1)) / (fitUnit().w * CSS_PER_PT), MIN_ZOOM, MAX_ZOOM));
	const fitP = (): number => {
		const d = doc();
		if (!d) return 1;
		const [a, b] = unitOf(d.pageCount, spreadMode(), untrack(curPage));
		let w = 0, h = 0;
		for (let i = a; i < b; i++) { const [pw, ph] = dispPt(i); w += pw; h = Math.max(h, ph); }
		return clamp(Math.min((Math.max(100, vp().w) - PAD * 2 - SPREAD_GAP * (b - a - 1)) / (w * CSS_PER_PT), (Math.max(100, vp().h) - PAD * 2) / (h * CSS_PER_PT)), MIN_ZOOM, MAX_ZOOM);
	};
	const [fitPageZoom, setFitPageZoom] = createSignal(1);
	const zoom = () => (zoomMode() === "width" ? fitW() : zoomMode() === "page" ? fitPageZoom() : zoomCustom());
	const pageWidth = (i: number) => Math.max(8, Math.round(dispPt(i)[0] * CSS_PER_PT * zoom()));
	const pageHeight = (i: number) => Math.round((pageWidth(i) * dispPt(i)[1]) / dispPt(i)[0]);
	// The pages grouped into rows (columns when scrolling horizontally): one row is one item of the virtual list, so every function
	// below that walks the list works on ROWS; a page's row is rowOf(page). With no spreads and vertical scrolling a row is a page.
	const layout = createMemo<Layout>(() => buildLayout({
		n: doc()?.pageCount ?? 0, w: pageWidth, h: pageHeight, scroll: scrollMode(), spread: spreadMode(),
		viewW: scrollMode() === "wrapped" ? vp().w : 0, pad: PAD, gap: GAP, spreadGap: SPREAD_GAP,
	}));
	const nRows = () => layout().rows;
	/** main-axis extent of row r (a column's width when scrolling horizontally), its padding included */
	const rowHeight = (r: number) => layout().ext[r] ?? 0;
	const rowOf = (p: number) => layout().pageRow[clamp(p, 0, Math.max(0, layout().n - 1))] ?? 0;
	/** where page p starts on the main axis inside its row */
	const pageLead = (p: number) => { const L = layout(), r = rowOf(p); return (L.lead[r] ?? 0) + ((horiz() ? L.px[p] : L.py[p]) ?? 0); };
	/** width of the scrolled content: the viewport, or wider when the widest row (plus gutters) does not fit; the whole strip when horizontal */
	const innerWidth = () => (horiz() ? Math.max(vp().w, Math.round(layout().total)) : Math.max(vp().w, Math.round(layout().maxSize) + PAD * 2));
	/** height of the horizontal strip: the viewport, or the tallest page plus gutters */
	const innerHeight = () => Math.max(vp().h, Math.round(layout().maxSize) + PAD * 2);
	/** top of column r's pages in the horizontal strip (the column is centred) */
	const colTop = (r: number) => Math.max(PAD, Math.round((innerHeight() - (layout().size[r] ?? 0)) / 2));

	// ---- the mounted pages -----------------------------------------------------------------------------------------
	const stats: ReaderStats = { renders: 0, lastRenderMs: 0, lastUploadMs: 0, totalRenderMs: 0, cancelled: 0, tiles: 0, peakTiles: 0 };
	const pending = { n: 0 };
	const reg: PageEnv["reg"] = { boxes: new Map() };
	const probe: PageEnv["probe"] = new Map();
	const jobs: PageEnv["jobs"] = new Set();
	const count = () => doc()?.pageCount ?? 0;
	// vis, win and sp are in ROWS (see layout above); sp is the main-axis scroll position: the row at the viewport start, the offset
	// into it and the viewport's length (its width when scrolling horizontally)
	const [vis, setVis] = createSignal<[number, number]>([0, 1]);
	const [win, setWin] = createSignal<[number, number]>([0, 3]);
	const [sp, setSp] = createSignal({ idx: 0, off: 0, h: 0 }, { equals: eqScroll });
	const [scrollX, setScrollX] = createSignal(0);
	const [scrollY, setScrollY] = createSignal(0); // the horizontal strip's vertical offset (tall pages)
	const [viewTick, setViewTick] = createSignal(0);
	const bump = () => setViewTick((n) => n + 1);
	/** the mounted rows */
	const rowIdx = createMemo(() => {
		const [lo, hi0] = win();
		let hi = Math.min(hi0, nRows());
		if (props.window) hi = Math.min(hi, lo + Math.max(1, props.window));
		return Array.from({ length: Math.max(0, hi - lo) }, (_, k) => lo + k);
	});
	/** the mounted pages */
	const indices = createMemo(() => {
		const L = layout(), rs = rowIdx();
		if (!rs.length) return [];
		const a = L.first[rs[0]!] ?? 0, b = L.first[rs[rs.length - 1]! + 1] ?? a;
		return Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k);
	}, [], { equals: (x, y) => x.length === y.length && x[0] === y[0] });
	const first = () => rowIdx()[0] ?? 0;
	// which way the reader scrolls (1 down, -1 up; down until the first move): the margin of pre-rendered tiles is long on that side
	const [dir, setDir] = createSignal(0);
	// ... and how far ahead: every live tile costs ~4x its pixel bytes in GPUIX (a 1000 px wide page at DPR 2 is ~18 MB per 256 px of height),
	// so the lead follows the scroll speed (css px/s, decays to 0 shortly after the last movement): ~0.3 s of travel plus a floor that
	// covers the render + upload time of a page that is not scrolling yet (a band is ready within ~60-100 ms), capped.
	const [speed, setSpeed] = createSignal(0);
	const margins = createMemo(() => {
		const vh = sp().h || vp().h || 800;
		const ahead = clamp(Math.round((AHEAD_MIN + speed() * 0.3) / 50) * 50, AHEAD_MIN, AHEAD_MAX), behind = BEHIND;
		const d = dir();
		const mg: Margins = { up: d < 0 ? ahead : behind, down: d < 0 ? behind : ahead, keep: Math.round(vh * 0.1), ahead: d, axis: horiz() ? "x" : "y" };
		return mg;
	}, undefined, { equals: (a, b) => a.up === b.up && a.down === b.down && a.keep === b.keep && a.ahead === b.ahead && a.axis === b.axis });
	const laidOut = () => vp().w > 0 && sp().h > 0;
	const MAX_MOUNT = 14;
	/** the rows that touch the viewport or the margins (+ keep distance) around it: their pages are mounted, so their tiles can be rendered ahead of time */
	function windowFor(s: { idx: number; off: number; h: number }): [number, number] {
		const L = untrack(layout), n = L.rows;
		if (!n) return [0, 0];
		const m = untrack(margins), vh = s.h || (untrack(horiz) ? untrack(vp).w : untrack(vp).h) || 800;
		const idx = clamp(s.idx, 0, n - 1);
		const top = (L.start[idx] ?? 0) + s.off;
		const lo = rowAt(L, top - (m.up + m.keep)), hi = Math.max(idx + 1, rowAt(L, top + vh + m.down + m.keep) + 1);
		const pages = (a: number, b: number) => (L.first[b] ?? 0) - (L.first[a] ?? 0);
		if (pages(lo, hi) <= MAX_MOUNT) return [lo, Math.min(n, hi)];
		// too many pages: the visible rows (always), one row behind, and ahead as far as the page budget allows
		const vlo = rowAt(L, top), vhi = Math.max(vlo + 1, rowAt(L, top + vh - 1) + 1);
		const a = Math.max(lo, vlo - 1);
		let b = vhi;
		while (b < Math.min(n, hi) && pages(a, b + 1) <= MAX_MOUNT) b++;
		return [a, Math.min(n, b)];
	}
	function updateWin(s: { idx: number; off: number; h: number }) {
		const w = windowFor(s), cw = untrack(win);
		if (w[0] !== cw[0] || w[1] !== cw[1]) setWin(w);
	}
	// row heights change with the zoom, the viewport, rotations and the layout (the first layout comes after the first scroll sample): re-fit the window
	createEffect(() => {
		zoom(); docRot(); pageRots(); vp(); layout();
		if (!doc()) return;
		untrack(() => { const s = sp(); if (s.h) updateWin(s); });
	});
	let reprioTimer: ReturnType<typeof setTimeout> | undefined;
	let speedTimer: ReturnType<typeof setTimeout> | undefined;
	let speedAt = 0;
	/** scroll speed from the move between two list positions (css px); a jump over many rows is not a speed */
	function noteSpeed(prev: { idx: number; off: number }, n: { idx: number; off: number }) {
		const now = performance.now();
		if (Math.abs(n.idx - prev.idx) > 3) { speedAt = now; return; }
		const L = untrack(layout);
		const dy = (L.start[n.idx] ?? 0) + n.off - (L.start[prev.idx] ?? 0) - prev.off;
		const dt = Math.max(8, now - speedAt);
		const v = speedAt ? Math.abs(dy) / (dt / 1000) : 0;
		speedAt = now;
		setSpeed((s) => Math.round(s * 0.6 + Math.min(v, 12000) * 0.4));
		clearTimeout(speedTimer);
		speedTimer = setTimeout(() => { speedAt = 0; setSpeed(0); }, 450);
	}
	onCleanup(() => clearTimeout(speedTimer));
	/** the queued render jobs follow the viewport: re-set their priorities (at most every 30 ms) */
	function reprioSoon() {
		if (reprioTimer) return;
		reprioTimer = setTimeout(() => { reprioTimer = undefined; for (const f of jobs) f(); }, 30);
	}
	onCleanup(() => clearTimeout(reprioTimer));
	/** the page under a line 35% of the way down the viewport (the web reader's "current page") */
	// (in a row of several pages: the first one that reaches into the viewport; scrolling horizontally: the one under that line)
	const curPage = createMemo(() => {
		const d = doc();
		if (!d) return 0;
		const s = sp(), L = layout();
		if (!L.rows) return 0;
		let r: number, line = 0;
		if (!s.h) {
			const [a, b] = vis();
			r = clamp(Math.floor(a + 0.35 * Math.max(0, b - a)), 0, L.rows - 1);
		} else {
			const pos = (L.start[clamp(s.idx, 0, L.rows - 1)] ?? 0) + s.off + 0.35 * s.h;
			r = rowAt(L, pos);
			line = pos - (L.start[r] ?? 0) - (L.lead[r] ?? 0);
		}
		const a = L.first[r] ?? 0, b = L.first[r + 1] ?? a + 1;
		if (b - a > 1) {
			// the viewport's left edge in the row's content (vertical rows are centred in the content width)
			const x0 = horiz() ? line : -scrollX() - (innerWidth() - (L.size[r] ?? 0)) / 2;
			for (let i = a; i < b; i++) if ((L.px[i] ?? 0) + pageWidth(i) > x0 + 1) return i;
			return b - 1;
		}
		return clamp(a, 0, Math.max(0, count() - 1));
	});
	const estimate = createMemo(() => {
		const L = layout();
		if (!L.rows) return 800;
		const n = Math.min(L.rows, 20);
		return Math.round((L.start[n] ?? 0) / n);
	});

	/** the scroll anchor before a Ctrl+wheel zoom started (the wheel scrolls the list as well; the zoom puts the position back) */
	let lastAnchor: [number, number] = [0, 0];
	let zoomingUntil = 0;
	let list: { id: number } | undefined;
	let hbox: { id: number } | undefined; // the horizontally scrolling box around the list
	let rootEl: { id: number } | undefined;
	let searchEl: { id: number } | undefined;
	let paneEl: { id: number } | undefined; // the box the selection popup is positioned in

	/** the main-axis scroll position as the list (or, scrolling horizontally, the strip) has it now */
	function readScroll(): { idx: number; off: number; h: number } | null {
		if (untrack(horiz)) {
			const o = hbox ? gpuix?.renderer.getScrollOffset?.(hbox.id) : null;
			const w = Math.round(untrack(vp).w);
			if (!o || !w) return null;
			const L = untrack(layout), x = Math.max(0, -(o[0] ?? 0)), idx = rowAt(L, x);
			return { idx, off: Math.round(x - (L.start[idx] ?? 0)), h: w };
		}
		const a = list ? gpuix?.renderer.getListScrollTop?.(list.id) : null;
		if (!a || a.length < 3) return null;
		return { idx: clamp(a[0]!, 0, Math.max(0, untrack(nRows) - 1)), off: Math.round(a[1]!), h: Math.round(a[2]!) };
	}
	function refreshScroll() {
		const n = readScroll();
		if (n) {
			if (untrack(horiz) && hbox) {
				// the strip has no visible-range event: the visible rows and the vertical offset come from here
				const L = untrack(layout), o = gpuix?.renderer.getScrollOffset?.(hbox.id);
				const y = Math.round(o?.[1] ?? 0);
				if (y !== untrack(scrollY)) { setScrollY(y); bump(); }
				const x = (L.start[n.idx] ?? 0) + n.off, e = rowAt(L, x + n.h - 1);
				const v: [number, number] = [n.idx + n.off / Math.max(1, rowHeight(n.idx)), e + Math.min(1, (x + n.h - (L.start[e] ?? 0)) / Math.max(1, rowHeight(e)))];
				const cv = untrack(vis);
				if (Math.abs(cv[0] - v[0]) > 1e-3 || Math.abs(cv[1] - v[1]) > 1e-3) setVis(v);
			}
			const prev = untrack(sp);
			if (!eqScroll(prev, n)) {
				const moved = n.idx !== prev.idx ? n.idx - prev.idx : n.off - prev.off;
				if (prev.h && moved !== 0) { setDir(moved > 0 ? 1 : -1); noteSpeed(prev, n); }
				setSp(n); bump(); saveSoon();
				updateWin(n);
				reprioSoon();
				if (performance.now() > zoomingUntil) lastAnchor = anchor();
			}
		}
	}
	const onVisibleRange = (e: EventPayload) => {
		const a = e.startIndex ?? 0, b = e.endIndex ?? a + 1;
		setVis([a, b]);
		refreshScroll();
		const lo = Math.max(0, Math.floor(a) - 1), hi = Math.min(untrack(nRows), Math.ceil(b) + 1);
		// once the scroll position is known refreshScroll() owns the window (pages inside the margins); until then trust the list's range
		const w = untrack(win);
		if (!untrack(sp).h && (w[0] !== lo || w[1] !== hi)) setWin([lo, hi]);
		bump();
		saveSoon();
	};

	/** where the viewport top (left, scrolling horizontally) is: [first page of the row there, fraction of that row before it]; a page, so it survives a layout change */
	function anchor(): [number, number] {
		const L = untrack(layout), s = readScroll();
		if (s && L.rows) {
			const r = clamp(s.idx, 0, L.rows - 1);
			return [L.first[r] ?? 0, clamp(s.off / Math.max(1, L.ext[r] ?? 1), 0, 1)];
		}
		const v = untrack(vis)[0], r = clamp(Math.floor(v), 0, Math.max(0, L.rows - 1));
		return [L.first[r] ?? 0, v - Math.floor(v)];
	}
	/** scroll so that `offset` css px of row r are before the viewport start */
	function scrollToRow(row: number, offset = 0) {
		const r = clamp(row, 0, Math.max(0, nRows() - 1));
		setWin([Math.max(0, r - 1), Math.min(nRows(), r + 3)]);
		if (horiz()) {
			const x = clamp((layout().start[r] ?? 0) + offset, 0, Math.max(0, innerWidth() - vp().w));
			if (hbox) gpuix?.renderer.scrollTo?.(hbox.id, -x, scrollY());
		} else if (list) gpuix?.renderer.scrollToItem?.(list.id, r, offset);
		queueMicrotask(refreshScroll);
	}
	/** scroll to page's row, `offset` css px into the row */
	const scrollTo = (page: number, offset = 0) => scrollToRow(rowOf(page), offset);
	function restore([page, frac]: [number, number]) {
		scrollTo(page, Math.round(frac * rowHeight(rowOf(page))));
	}
	/** scroll by dy css px along the main axis (positive = down / right), carrying the offset across rows */
	function scrollBy(dy: number) {
		const s = readScroll();
		if (!s) return;
		const L = layout(), pos = clamp((L.start[s.idx] ?? 0) + s.off + dy, 0, L.total), r = rowAt(L, pos);
		scrollToRow(r, Math.max(0, Math.round(pos - (L.start[r] ?? 0))));
	}
	/** the strip's vertical offset (horizontal scrolling, pages taller than the viewport): `y` css px of the strip above the viewport */
	function scrollStripY(y: number) {
		if (!hbox || !horiz()) return;
		const o = gpuix?.renderer.getScrollOffset?.(hbox.id);
		const yy = -clamp(Math.round(y), 0, Math.max(0, innerHeight() - vp().h));
		gpuix?.renderer.scrollTo?.(hbox.id, o?.[0] ?? 0, yy);
		setScrollY(yy);
		bump();
	}
	/** bring the point (nx, ny) of page p (0..1 of the page as displayed) `atY` css px below the viewport top (and, scrolling
	 *  horizontally, `atX` px right of its left edge) */
	function reveal(p: number, nx: number, ny: number, atY: number, atX = PAD) {
		if (horiz()) {
			scrollTo(p, Math.max(0, Math.round(pageLead(p) + nx * pageWidth(p) - atX)));
			if (innerHeight() > vp().h) scrollStripY(colTop(rowOf(p)) + (layout().py[p] ?? 0) + ny * pageHeight(p) - atY);
			return;
		}
		scrollTo(p, Math.max(0, Math.round(pageLead(p) + ny * pageHeight(p) - atY)));
	}
	/** run a layout change (zoom, resize, rotation) and keep the same spot of the document at the top, and the same column centred */
	function keepAnchor(change: () => void) {
		const a = doc() && list ? anchor() : null;
		const z0 = zoom(), w0 = innerWidth(), v0 = vp().w;
		const sx0 = hbox ? gpuix?.renderer.getScrollOffset?.(hbox.id)?.[0] ?? 0 : 0;
		change();
		if (a && (a[0] > 0 || a[1] > 0)) queueMicrotask(() => restore(a));
		if (hbox && !horiz()) {
			const w1 = innerWidth(), v1 = vp().w, ratio = zoom() / z0;
			const cx = (-sx0 + v0 / 2 - w0 / 2) * ratio + w1 / 2; // the content x that was in the middle of the viewport
			const sx1 = clamp(-(cx - v1 / 2), -Math.max(0, w1 - v1), 0);
			if (Math.abs(sx1 - sx0) >= 1) queueMicrotask(() => hbox && gpuix?.renderer.scrollTo?.(hbox.id, sx1, 0));
		}
		bump();
	}
	function setZoom(z: number) {
		keepAnchor(() => { setZoomMode("custom"); setZoomCustom(clamp(Math.round(z * 100) / 100, MIN_ZOOM, MAX_ZOOM)); });
		saveSoon();
	}
	const fitWidth = () => { keepAnchor(() => setZoomMode("width")); saveSoon(); };
	const fitPage = () => {
		keepAnchor(() => { setFitPageZoom(fitP()); setZoomMode("page"); });
		saveSoon();
	};
	const zoomBy = (f: number) => setZoom(zoom() * f);
	function rotate(deg: number, page?: number) {
		const d = deg % 360;
		keepAnchor(() => {
			if (page === undefined) setDocRot((r) => (r + d + 360) % 360);
			else setPageRots((m) => ({ ...m, [page]: ((((m[page] ?? 0) + d) % 360) + 360) % 360 }));
			if (zoomMode() === "page") setFitPageZoom(fitP());
		});
		setRotTick((n) => n + 1);
		saveSoon();
	}

	// the container's size: refit on resize (the page tiles debounce the re-render)
	function onViewport(e: EventPayload) {
		const w = Math.round(e.width ?? 0), h = Math.round(e.height ?? 0);
		if (w <= 0 || h <= 0) return; // hidden: keep the last layout
		const v = untrack(vp);
		refreshDpr();
		if (Math.abs(v.w - w) < 1 && Math.abs(v.h - h) < 1) return;
		if (v.w === 0 || zoomMode() === "custom") setVp({ w, h });
		else keepAnchor(() => { setVp({ w, h }); if (zoomMode() === "page") setFitPageZoom(fitP()); });
		bump();
	}

	// the viewport in a page's own css coordinates
	function viewFor(i: number, s = sp()): ViewRect {
		const L = layout(), r = L.pageRow[i] ?? 0, idx = clamp(s.idx, 0, Math.max(0, L.rows - 1));
		// the viewport start relative to the content of page i's row: `off` into the anchor row, moved by the rows in between
		const pos = (L.start[idx] ?? 0) + s.off - (L.start[r] ?? 0) - (L.lead[r] ?? 0);
		if (horiz()) {
			const x0 = pos - (L.px[i] ?? 0), y0 = -scrollY() - colTop(r) - (L.py[i] ?? 0);
			return { x0, x1: x0 + vp().w, y0, y1: y0 + vp().h };
		}
		const vh = s.h || vp().h;
		const y0 = pos - (L.py[i] ?? 0);
		const left = (innerWidth() - (L.size[r] ?? 0)) / 2 + (L.px[i] ?? 0);
		const x0 = -scrollX() - left;
		return { x0, x1: x0 + vp().w, y0, y1: y0 + vh };
	}

	// the visible-range event only fires when the integer page range changes: follow the scroll position within a page too
	{
		const poll = setInterval(() => { if (untrack(pagesShown) && list) { refreshScroll(); } }, 16);
		onCleanup(() => clearInterval(poll));
	}

	// ---- persistence --------------------------------------------------------------------------------------------------
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	function saveNow() {
		clearTimeout(saveTimer);
		saveTimer = undefined;
		if (!persist || !doc() || !list) return;
		const [page, frac] = anchor();
		setDocState(key(), { page, frac, zoomMode: zoomMode(), zoom: zoomMode() === "page" ? fitPageZoom() : zoomCustom(), rot: docRot(), rots: Object.fromEntries(Object.entries(pageRots()).filter(([, v]) => v)), scroll: scrollMode(), spread: spreadMode() });
	}
	function saveSoon() {
		if (!persist || saveTimer) return;
		saveTimer = setTimeout(saveNow, 700);
	}
	function restoreState() {
		if (!persist) return;
		const s = getDocState(key());
		if (!s) return;
		if (!props.zoom) {
			setZoomMode(s.zoomMode === "custom" || s.zoomMode === "page" ? s.zoomMode : "width");
			setZoomCustom(clamp(Number(s.zoom) || 1, MIN_ZOOM, MAX_ZOOM));
			if (s.zoomMode === "page") setFitPageZoom(clamp(Number(s.zoom) || 1, MIN_ZOOM, MAX_ZOOM));
		}
		setDocRot([0, 90, 180, 270].includes(s.rot) ? s.rot : 0);
		const m: Record<number, number> = {};
		for (const [k, v] of Object.entries(s.rots ?? {})) if ([90, 180, 270].includes(v as number)) m[+k] = v as number;
		setPageRots(m);
		if (isScrollMode(s.scroll)) setScrollMode(s.scroll);
		if (isSpreadMode(s.spread)) setSpreadMode(s.spread);
		saved = [Math.max(0, Math.floor(s.page)), clamp(s.frac, 0, 1)];
		setWin([Math.max(0, saved[0] - 1), saved[0] + 3]);
	}

	// ---- the list's lifecycle: inactive tab, alternate view, page layout -----------------------------------------------
	let saved: [number, number] = [0, 0];
	/** set by Rotate / Delete Pages for the next load(): where to be, and the view rotations of the pages that remain */
	let reopenWith: { anchor: [number, number]; rots: Record<number, number> } | undefined;
	const [altView, setAltViewSig] = createSignal<string | null>(null);
	const pagesShown = createMemo(() => active() && !altView() && !!doc());
	createEffect(on(pagesShown, (shown, prev) => {
		if (shown || !prev) return;
		// the page list is about to be unmounted: remember where we were, free what hayro cached
		saved = untrack(() => (list ? anchor() : [Math.floor(vis()[0]), vis()[0] - Math.floor(vis()[0])]));
		saveNow();
		const r = untrack(() => rowOf(saved[0]));
		setWin([Math.max(0, r - 1), r + 3]);
		list = undefined;
		// (the queue is not cleared: tiles cancel their own jobs when they unmount, and the sidebar's thumbnails still need theirs)
		doc()?.clearCache();
	}, { defer: true }));
	function onListRef(el: { id: number }) {
		list = el;
		if (saved[0] > 0 || saved[1] > 0) {
			const s = saved;
			saved = [0, 0];
			setTimeout(() => restore(s), 0);
			// the horizontal strip clamps a scroll set before its content is laid out: once more after the first frames
			if (untrack(horiz)) setTimeout(() => restore(s), 60);
		}
	}
	/** View menu: switch the scroll mode and / or spreads, keeping the same page at the top */
	function setLayout(scroll?: ScrollMode, spread?: SpreadMode) {
		const sm = scroll ?? scrollMode(), pm = spread ?? spreadMode();
		if (sm === scrollMode() && pm === spreadMode()) return;
		const a: [number, number] = doc() && list ? anchor() : [curPage(), 0];
		const modeChanged = (sm === "horizontal") !== horiz();
		// the list and the strip are different elements: the new one restores the position when it mounts (onListRef)
		if (modeChanged) { saved = [a[0], Math.max(a[1], 1e-6)]; list = undefined; }
		batch(() => {
			setScrollMode(sm);
			setSpreadMode(pm);
			setSp({ idx: 0, off: 0, h: 0 }); // the old position is in the old rows: wait for the new one
		});
		const r = rowOf(a[0]);
		batch(() => {
			setVis([r, r + 1]);
			setWin([Math.max(0, r - 1), r + 3]);
			if (zoomMode() === "page") setFitPageZoom(fitP());
		});
		if (!modeChanged) {
			queueMicrotask(() => restore(a));
			setTimeout(() => restore(a), 60);
		}
		bump();
		saveSoon();
	}
	// the toolbar's View menu and the thumbnails' commands change the PDF file through these (core/layoutui.tsx, core/pageops.ts)
	const [selPages, setSelPages] = createSignal<number[]>([]);
	const cmds = createPageCommands({
		attachmentKey: () => key(),
		path: () => props.path,
		title: () => props.title ?? "",
		doc,
		curPage: () => curPage(),
		selected: () => (sbOpen() && sbTab() === "thumbs" ? selPages() : []),
		read: async () => (props.path ? new Uint8Array(await Bun.file(props.path).arrayBuffer()) : fetchAttachment(props.attachmentKey)),
		canEdit: () => !props.doc,
		reopen: async (map) => {
			const a = list ? anchor() : saved;
			let page = a[0];
			// a deleted page: the next one that remains (or the last)
			for (let p = a[0]; p < count() && (page = map(p)) < 0; p++);
			if (page < 0) for (let p = a[0]; p >= 0 && (page = map(p)) < 0; p--);
			const rots: Record<number, number> = {};
			for (const [k, v] of Object.entries(untrack(pageRots))) { const m = map(+k); if (m >= 0 && v) rots[m] = v; }
			setSelPages((s) => s.map(map).filter((p) => p >= 0));
			reopenWith = { anchor: [Math.max(0, page), map(a[0]) >= 0 ? a[1] : 0], rots };
			await load();
		},
	});

	// ---- text layers + links ----------------------------------------------------------------------------------------------
	const textCache = new Map<number, PageText>();
	const textPending = new Map<number, Promise<PageText | null>>();
	const [textVer, setTextVer] = createSignal(0);
	const peekText = (i: number): PageText | undefined => {
		const v = textCache.get(i);
		if (v) { textCache.delete(i); textCache.set(i, v); }
		return v;
	};
	function loadText(i: number, band = 2): Promise<PageText | null> {
		const c = peekText(i);
		if (c) return Promise.resolve(c);
		const p0 = textPending.get(i);
		if (p0) return p0;
		const d = doc();
		if (!d || i < 0 || i >= d.pageCount) return Promise.resolve(null);
		const s = sched;
		const p = new Promise<PageText | null>((res) => {
			s.add({
				pri: () => band * 1e6 + Math.abs(i - untrack(curPage)),
				dropped: () => { textPending.delete(i); res(null); },
				run: async () => {
					try {
						const l = await d.textLayerAsync(i);
						const pt = buildPageText(l);
						if (doc() === d) {
							textCache.set(i, pt);
							while (textCache.size > TEXT_CACHE) textCache.delete(textCache.keys().next().value!);
							setTextVer((n) => n + 1);
						}
						res(pt);
					} catch (e) {
						console.error("[reader] text layer:", e instanceof Error ? e.message : e);
						res(null);
					} finally { textPending.delete(i); }
				},
			});
		});
		textPending.set(i, p);
		return p;
	}

	const linksCache = new Map<number, LinkInfo[] | Promise<LinkInfo[]>>();
	const [linksVer, setLinksVer] = createSignal(0);
	function toLink(l: PdfLink): LinkInfo {
		return { rect: { x: l.x, y: l.y, w: l.w, h: l.h }, target: l.k === "page" ? { kind: "page", page: l.p, y: l.ty } : { kind: "uri", uri: l.u } };
	}
	function loadLinks(i: number, band = 2.5): Promise<LinkInfo[]> {
		const c = linksCache.get(i);
		if (c) return c instanceof Promise ? c : Promise.resolve(c);
		const d = doc();
		if (!d) return Promise.resolve([]);
		const s = sched;
		const p = new Promise<LinkInfo[]>((res) => {
			s.add({
				pri: () => band * 1e6 + Math.abs(i - untrack(curPage)),
				dropped: () => { linksCache.delete(i); res([]); },
				run: async () => {
					try {
						const ls = (await d.linksAsync(i)).filter((l) => l.k === "page" || isSafeUrl(l.u)).map(toLink);
						if (doc() === d) { linksCache.set(i, ls); setLinksVer((n) => n + 1); }
						res(ls);
					} catch { linksCache.set(i, []); res([]); }
				},
			});
		});
		linksCache.set(i, p);
		return p;
	}
	const linksOf = (i: number): LinkInfo[] => { linksVer(); const c = linksCache.get(i); return c && !(c instanceof Promise) ? c : []; };
	// mounted pages get their text layer (selection, plugins) and links
	createEffect(() => {
		if (!pagesShown()) return;
		for (const i of indices()) { void loadText(i); if (!linksCache.has(i)) void loadLinks(i); }
	});

	// ---- outline + pdf bytes -----------------------------------------------------------------------------------------------
	const [outline, setOutline] = createSignal<OutlineEntry[] | null>(null);
	createEffect(on(doc, (d) => {
		if (!d) return;
		void d.outlineAsync().then((o) => { if (doc() === d) setOutline(o); }).catch(() => { if (doc() === d) setOutline([]); });
	}));
	let bytesRef: WeakRef<Uint8Array> | undefined;
	async function pdfBytes(): Promise<Uint8Array> {
		// not kept: the worker owns its own copy, so the JS side re-reads on demand and lets the GC have it again
		const hit = bytesRef?.deref();
		if (hit) return hit;
		const b = props.path ? new Uint8Array(await Bun.file(props.path).arrayBuffer()) : await fetchAttachment(props.attachmentKey);
		bytesRef = new WeakRef(b);
		return b;
	}

	// ---- page navigation (links, outline, history) --------------------------------------------------------------------
	const [history, setHistory] = createSignal<[number, number][]>([]);
	function goTo(page: number, y = -1, record = true) {
		if (!doc()) return;
		if (record) setHistory((h) => [...h.slice(-30), anchor()]);
		const p = clamp(page, 0, count() - 1);
		if (y >= 0 && rotOf(p) === 0) reveal(p, 0, y, 36);
		else if (horiz()) reveal(p, 0, 0, 0);
		else scrollTo(p, 0);
	}
	const goBack = () => {
		const h = history();
		if (!h.length) return;
		setHistory(h.slice(0, -1));
		restore(h[h.length - 1]!);
	};
	type LinkEvent = { page: number; rect: NRect; target: LinkInfo["target"]; x: number; y: number };
	const linkHandlers = new Set<(e: LinkEvent) => boolean | void>();
	function activateLink(page: number, l: LinkInfo, e: { x?: number; y?: number }) {
		for (const h of linkHandlers) { try { if (h({ page, rect: l.rect, target: l.target, x: e.x ?? 0, y: e.y ?? 0 })) return; } catch (err) { console.error("[reader] link handler:", err); } }
		if (l.target.kind === "page") goTo(l.target.page, l.target.y);
		else openUrl(l.target.uri);
	}

	// ---- search ---------------------------------------------------------------------------------------------------------------
	const [query, setQuery] = createSignal(props.highlight ?? "");
	const [hits, setHits] = createSignal<Hit[]>([]);
	const [cur, setCur] = createSignal(-1);
	const [scanDone, setScanDone] = createSignal(true);
	let scanGen = 0;
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => clearTimeout(searchTimer));
	const hitsByPage = createMemo(() => {
		const m = new Map<number, { rects: NRect[]; id: number }[]>();
		hits().forEach((h, id) => { const l = m.get(h.page); if (l) l.push({ rects: h.rects, id }); else m.set(h.page, [{ rects: h.rects, id }]); });
		return m;
	});
	function showHit(id: number) {
		const h = untrack(hits)[id];
		if (!h) return;
		setCur(id);
		const r = rotRect(h.rects[0]!, rotOf(h.page));
		// put the hit about a third of the way down the viewport (and across it, scrolling horizontally)
		reveal(h.page, r.x, r.y, untrack(vp).h * 0.3, untrack(vp).w * 0.3);
	}
	async function runSearch(q: string): Promise<void> {
		const my = ++scanGen;
		const needle = q.trim().replace(/\s+/g, " ").toLowerCase();
		setHits([]);
		setCur(-1);
		if (!needle) { setScanDone(true); return; }
		while (!doc()) { if (my !== scanGen) return; await Bun.sleep(50); }
		const d = doc()!;
		setScanDone(false);
		const from = untrack(curPage);
		const found: Hit[] = [];
		let jumped = false;
		for (let i = 0; i < d.pageCount; i++) {
			while (!active()) { if (my !== scanGen) return; await Bun.sleep(200); } // an inactive reader pauses its scan
			if (my !== scanGen || doc() !== d) return;
			let words: TextWord[];
			const cached = peekText(i);
			try { words = cached ? (cached.words as TextWord[]) : (await d.textLayerAsync(i)).words; } catch { continue; }
			if (my !== scanGen) return;
			const rs = searchLayer(words, needle);
			if (rs.length) {
				for (const r of rs) found.push({ page: i, rects: r.rects, snippet: r.snippet });
				setHits([...found]);
				// the first hit at or after the page being looked at is the current one
				if (!jumped && i >= from) { jumped = true; showHit(found.length - rs.length); }
			}
			if (i % 4 === 3) await Bun.sleep(0); // let renders and frames in between
		}
		if (my !== scanGen) return;
		setScanDone(true);
		if (!jumped && found.length) showHit(0); // nothing after the current page: wrap to the first
	}
	function onQuery(q: string) {
		setQuery(q);
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => void runSearch(q), 220);
	}
	const step = (d: 1 | -1) => {
		const n = untrack(hits).length;
		if (!n) return;
		showHit((untrack(cur) + d + n) % n);
	};
	createEffect(() => { if (doc() && props.highlight) untrack(() => void runSearch(query())); });

	// ---- text selection -----------------------------------------------------------------------------------------------------
	interface SelInfo { page: number; text: string; rects: NRect[]; pages: { page: number; rects: NRect[] }[] }
	const [range, setRange] = createSignal<[Caret, Caret] | null>(null);
	const [selInfo, setSelInfo] = createSignal<SelInfo | null>(null);
	let drag: { anchor: Caret; pend: boolean; moved: boolean; x: number; y: number } | null = null;
	const order = (a: Caret, b: Caret): [Caret, Caret] => (cmpCaret(a, b) <= 0 ? [a, b] : [b, a]);

	/** the page under (or, when `near`, nearest to) a window point, with the point in the page's unrotated 0..1 space */
	function pageAt(x: number, y: number, near: boolean): { page: number; nx: number; ny: number } | null {
		let best: { page: number; nx: number; ny: number; d: number } | null = null;
		for (const [i, el] of reg.boxes) {
			const b = gpuix?.renderer.getElementBounds?.(el.id);
			if (!b || b.width <= 0) continue;
			const inside = x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
			const d = inside ? 0 : y < b.y ? b.y - y : y > b.y + b.height ? y - b.y - b.height : 0;
			if (!inside && !near) continue;
			if (!best || d < best.d) {
				const dx = (clamp(x, b.x, b.x + b.width) - b.x) / b.width, dy = (clamp(y, b.y, b.y + b.height) - b.y) / b.height;
				const [nx, ny] = unrotPoint(dx, dy, rotOf(i));
				best = { page: i, nx, ny, d };
			}
		}
		return best;
	}

	function selRectsFor(i: number): NRect[] {
		textVer();
		const r = range();
		if (!r || i < r[0].page || i > r[1].page) return [];
		const pt = peekText(i);
		return pt ? selectionRects(pt, i, r[0], r[1]) : [];
	}
	async function finalizeSelection(r: [Caret, Caret] | null) {
		if (!r) { setSelInfo(null); return; }
		const [a, b] = r;
		if (b.page - a.page > 80) { setSelInfo(null); return; }
		const parts: string[] = [];
		const pages: { page: number; rects: NRect[] }[] = [];
		for (let p = a.page; p <= b.page; p++) {
			const pt = await loadText(p, 0);
			if (!pt) continue;
			if (untrack(range) !== r) return; // superseded
			const txt = selectionText(pt, p, a, b);
			if (txt) parts.push(txt);
			const rects = selectionRects(pt, p, a, b);
			if (rects.length) pages.push({ page: p, rects });
		}
		const text = parts.join("\n");
		if (!text) { setSelInfo(null); return; }
		setSelInfo({ page: pages[0]?.page ?? a.page, text, rects: pages[0]?.rects ?? [], pages });
		bump();
	}
	function clearSel() {
		drag = null;
		setRange(null);
		setSelInfo(null);
	}
	async function startSelection(e: EventPayload) {
		const x = e.x ?? 0, y = e.y ?? 0;
		const hitp = pageAt(x, y, false);
		if (!hitp) return;
		clearSel();
		const d = { anchor: { page: hitp.page, w: 0, c: 0 }, pend: true, moved: false, x, y };
		drag = d;
		const pt = peekText(hitp.page) ?? (await loadText(hitp.page, 0));
		if (drag !== d || !pt) return;
		const car = caretAt(pt, hitp.page, hitp.nx, hitp.ny);
		if (!car) { drag = null; return; }
		d.anchor = car;
		d.pend = false;
		const n = e.clickCount ?? 1;
		if (n >= 2) {
			const rr = n === 2 ? wordAt(pt, car) : lineAt(pt, car);
			d.moved = true;
			setRange(rr);
			drag = null;
			void finalizeSelection(rr);
			return;
		}
		// the pointer may already have moved while the text layer loaded
		moveSelection(d.x, d.y);
	}
	function moveSelection(x: number, y: number) {
		const d = drag;
		if (!d) return;
		d.x = x; d.y = y;
		if (d.pend) return;
		const hp = pageAt(x, y, true);
		if (!hp) return;
		const pt = peekText(hp.page);
		if (!pt) { void loadText(hp.page, 0); return; }
		const car = caretAt(pt, hp.page, hp.nx, hp.ny);
		if (!car) return;
		if (!d.moved && cmpCaret(car, d.anchor) === 0) return;
		d.moved = true;
		setRange(order(d.anchor, car));
	}
	function endSelection() {
		const d = drag;
		drag = null;
		if (!d) return;
		if (!d.moved) { clearSel(); return; }
		void finalizeSelection(untrack(range));
	}
	const DBG = process.env.ZN_READER_DEBUG === "1";
	const onMouseDown = (e: EventPayload) => {
		if (DBG) console.log("[reader] mouseDown", e.x, e.y, e.button, e.clickCount, "top:", gpuix?.renderer.getElementsAt?.(e.x ?? 0, e.y ?? 0)?.slice(0, 4), "boxes", [...reg.boxes.keys()]);
		if ((e.button ?? 0) !== 0) return;
		if (rootEl) gpuix?.renderer.focusElement?.(rootEl.id);
		setOpenMenu(null);
		void startSelection(e);
	};
	const onMouseMove = (e: EventPayload) => {
		if (DBG && drag) console.log("[reader] mouseMove", e.x, e.y, e.pressedButton);
		if (!drag) return;
		if (e.pressedButton !== 0) { endSelection(); return; } // the button went up outside of us
		moveSelection(e.x ?? 0, e.y ?? 0);
	};
	const onMouseUp = () => endSelection();
	const doCopy = (): boolean => {
		const s = selInfo();
		return s ? copyText(s.text, gpuix?.renderer as never) : false;
	};

	// ---- plugins ----------------------------------------------------------------------------------------------------------------
	const [ctxSig, setCtx] = createSignal<ReaderContext | null>(null);
	function makeContext(d: PdfDoc): ReaderContext {
		return {
			attachmentKey: key(),
			itemKey: props.itemKey ?? itemKeyLookup(key()),
			pageCount: count,
			pageSize: (i) => { const s = d.sizes[i] ?? [612, 792]; return { w: s[0], h: s[1] }; },
			textLayer: async (i) => {
				const pt = await loadText(i, 1);
				return { words: (pt?.words ?? []) as Word[] };
			},
			pdfBytes,
			currentPage: curPage,
			zoom,
			scrollTo: (page, y) => goTo(page, y ?? -1, false),
			selection: selInfo,
			clearSelection: clearSel,
			altView,
			setAltView: (id) => setAltViewSig(id),
			mode,
			rotation: (p) => rotOf(p),
			pageLinks: async (i) => loadLinks(i, 1.5),
			onLink: (cb) => { linkHandlers.add(cb as never); return () => linkHandlers.delete(cb as never); },
			openUrl,
			copy: (s) => copyText(s, gpuix?.renderer as never),
			rectToWindow: (page, r) => {
				const el = reg.boxes.get(page);
				const b = el ? gpuix?.renderer.getElementBounds?.(el.id) : null;
				if (!b) return null;
				const q = rotRect(r, rotOf(page));
				return { x: b.x + q.x * b.width, y: b.y + q.y * b.height, width: q.w * b.width, height: q.h * b.height };
			},
			viewTick,
			mountedPages: indices,
			// tabs by a plugin's sidePanel id (the sidebar keys them "plugin:<plugin>:<panel>")
			setSidebar: (open, tab) => setSidebar(open, tab && (sideTabs().find((t) => t.id === tab || t.id.endsWith(`:${tab}`))?.id ?? tab)),
			sidebarTab: () => (sbOpen() ? sbTab().replace(/^plugin:[^:]*:/, "") : null),
		};
	}
	const plugins = readerPlugins;
	const ctx = (): ReaderContext => ctxSig()!;
	// onOpen once per open document (and for plugins that register later)
	const opened = new Map<string, (() => void) | void>();
	const runCleanups = () => {
		for (const f of opened.values()) { try { if (typeof f === "function") f(); } catch { /* ignore */ } }
		opened.clear();
		linkHandlers.clear();
	};
	createEffect(on(doc, (d, prev) => {
		if (prev && prev !== d) runCleanups();
		setAltViewSig(null);
		clearSel();
		if (!d) { setCtx(null); return; }
		setCtx(makeContext(d));
	}));
	createEffect(() => {
		const c = ctxSig(), ps = plugins();
		if (!c) return;
		untrack(() => {
			for (const p of ps) {
				if (opened.has(p.id) || !p.onOpen) continue;
				try { opened.set(p.id, p.onOpen(c)); } catch (e) { console.error(`[reader] plugin ${p.id} onOpen:`, e); }
			}
		});
	});
	onCleanup(runCleanups);
	// ZN_READER_SELFTEST=<dir>: the packaged-app check of the mentions and the structure worker (src/reader/selftest.ts)
	createEffect(() => {
		const c = ctxSig();
		if (c && active() && laidOut() && selfTestDir()) untrack(() => void runSelfTest(c, gpuix!.renderer as never));
	});

	// ---- sidebar ----------------------------------------------------------------------------------------------------------------
	const sb0 = getSidebar();
	const [sbOpen, setSbOpen] = createSignal(sb0.open);
	const [sbTab, setSbTab] = createSignal(sb0.tab);
	// the sidebar's width: dragged by its right edge (180 px .. half of the reader), remembered with the rest of the reader state
	const [sbW, setSbW] = createSignal(clamp(sb0.width || 232, SIDEBAR_MIN, 900));
	const [bodyW, setBodyW] = createSignal(0);
	const sbMax = () => Math.max(SIDEBAR_MIN, Math.floor((bodyW() || 1200) / 2));
	const resizeSidebar = (w: number) => { setSbW(w); if (persist) saveSidebar({ ...getSidebar(), width: w }); };
	const setSidebar = (open: boolean, tab?: string) => { setSbOpen(open); if (tab) setSbTab(tab); if (persist) saveSidebar({ ...getSidebar(), open, tab: tab ?? sbTab() }); };
	const hitRows = createMemo<HitRow[]>(() => hits().map((h) => ({ page: h.page, snippet: h.snippet })));
	const look = createMemo(() => lookOf(appearance()));
	const [thumbEpoch, setThumbEpoch] = createSignal(0);
	createEffect(on([look, rotTick], () => setThumbEpoch((n) => n + 1), { defer: true }));
	const sideTabs = createMemo<SideTab[]>(() => {
		const core: SideTab[] = [
			{
				id: "thumbs", label: "Pages", icon: "layout-grid",
				render: () => (
					<Thumbnails
						mode={mode} doc={doc} sched={sched} dpr={dpr} look={look} rot={rotOf} epoch={thumbEpoch} curPage={curPage} goTo={(p) => goTo(p, -1, false)}
						selected={selPages} onSelect={setSelPages} onMenu={(p, x, y) => cmds.thumbMenu(p, x, y, selPages, setSelPages)}
					/>
				),
			},
			{ id: "outline", label: "Outline", icon: "list-tree", render: () => <Outline mode={mode} outline={outline} goTo={(p, y) => goTo(p, y)} curPage={curPage} /> },
		];
		const extra: SideTab[] = [];
		for (const p of plugins()) if (p.sidePanel) {
			const sp0 = p.sidePanel;
			extra.push({ id: `plugin:${p.id}:${sp0.id}`, label: sp0.label, icon: sp0.icon, render: () => <Show when={ctxSig()}>{sp0.render(ctx())}</Show> });
		}
		return [...core, ...extra];
	});

	// ---- appearance menu ------------------------------------------------------------------------------------------------------------
	const [openMenu, setOpenMenu] = createSignal<"appearance" | null>(null);
	const selColor = () => (paperIsDark(appearance()) ? "rgba(120, 170, 255, 0.40)" : "rgba(40, 110, 230, 0.30)");
	const HIT = withAlpha("#ffd60a", 0.4);
	const HIT_CUR = withAlpha("#ff8a00", 0.55);

	// ---- keyboard ----------------------------------------------------------------------------------------------------------------------
	function focusSearch() {
		if (searchEl) gpuix?.renderer.focusElement?.(searchEl.id);
	}
	function onKey(e: { key?: string; keyChar?: string; modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; cmd?: boolean }; preventDefault?: () => void }) {
		const k = (e.key ?? "").toLowerCase();
		const m = e.modifiers ?? {};
		if (process.env.ZN_READER_DEBUG === "1") console.log("[reader] key", e.key, JSON.stringify(e.keyChar), JSON.stringify(m), "focus", gpuix?.renderer.getFocusedElementId?.(), "root", rootEl?.id);
		const mod = !!(m.ctrl || m.cmd);
		const stop = () => e.preventDefault?.();
		const focused = gpuix?.renderer.getFocusedElementId?.();
		const onRoot = focused == null || focused === rootEl?.id;
		if (mod) {
			if (k === "f") { stop(); focusSearch(); return; }
			if (k === "=" || k === "+" || e.keyChar === "+" || k === "plus" || k === "equals") { stop(); zoomBy(1.1); return; }
			if (k === "-" || k === "minus" || k === "_") { stop(); zoomBy(1 / 1.1); return; }
			if (k === "0") { stop(); fitWidth(); return; }
			if (k === "]") { stop(); rotate(90, m.shift ? curPage() : undefined); return; }
			if (k === "[") { stop(); rotate(-90, m.shift ? curPage() : undefined); return; }
			if (k === "g") { stop(); step(m.shift ? -1 : 1); return; }
			if (k === "c" && onRoot && selInfo()) { stop(); doCopy(); return; }
			if (k === "p") { stop(); void cmds.print(); return; }
			return;
		}
		if (k === "f3") { stop(); step(m.shift ? -1 : 1); return; }
		if (m.alt && k === "left") { stop(); goBack(); return; }
		if (k === "escape") {
			if (openMenu()) { setOpenMenu(null); return; }
			if (selInfo() || range()) { clearSel(); return; }
			if (rootEl) gpuix?.renderer.focusElement?.(rootEl.id);
			return;
		}
		if (!onRoot || altView()) return;
		const vh = sp().h || vp().h;
		switch (k) {
			case "pagedown": stop(); scrollBy(vh * 0.9); break;
			case "pageup": stop(); scrollBy(-vh * 0.9); break;
			case "space": stop(); scrollBy(m.shift ? -vh * 0.9 : vh * 0.9); break;
			case "home": stop(); goTo(0, -1, false); break;
			case "end": stop(); scrollToRow(nRows() - 1, Math.max(0, rowHeight(nRows() - 1) - vh)); break;
			// scrolling horizontally: up / down move over a page taller than the viewport, left / right go to the previous / next page
			case "down": stop(); if (horiz()) { if (innerHeight() > vp().h) scrollStripY(-scrollY() + 48); else stepRow(1); } else scrollBy(48); break;
			case "up": stop(); if (horiz()) { if (innerHeight() > vp().h) scrollStripY(-scrollY() - 48); else stepRow(-1); } else scrollBy(-48); break;
			case "right": stop(); if (!horiz() && innerWidth() > vp().w && hbox) panX(-48); else stepRow(1); break;
			case "left": stop(); if (!horiz() && innerWidth() > vp().w && hbox) panX(48); else stepRow(-1); break;
		}
	}
	/** the next / previous row (a page, a spread, a wrapped row of pages) */
	const stepRow = (d: number) => goTo(layout().first[clamp(rowOf(curPage()) + d, 0, Math.max(0, nRows() - 1))] ?? 0, -1, false);
	function panX(dx: number) {
		if (!hbox) return;
		const cur0 = gpuix?.renderer.getScrollOffset?.(hbox.id)?.[0] ?? 0;
		gpuix?.renderer.scrollTo?.(hbox.id, clamp(cur0 + dx, -Math.max(0, innerWidth() - vp().w), 0), 0);
	}
	// Ctrl + wheel zooms (the page list scrolls too: its own wheel handling runs first, so the scroll position is put back)
	const onWheel = (e: EventPayload) => {
		if (!(e.modifiers?.ctrl || e.modifiers?.cmd)) {
			// the horizontal strip: GPUIX keeps a sideways-only scroll box to the wheel's own axis, so an ordinary (vertical) wheel moves
			// it here, as long as the pages fit the height (when they do not, the wheel scrolls up and down)
			const dy = e.deltaY ?? 0;
			if (horiz() && hbox && !(e.deltaX ?? 0) && dy && innerHeight() <= vp().h + 1) {
				const o = gpuix?.renderer.getScrollOffset?.(hbox.id) ?? [0, 0];
				const x = clamp((o[0] ?? 0) + (e.precise ? dy : dy * 26), -Math.max(0, innerWidth() - vp().w), 0);
				gpuix?.renderer.scrollTo?.(hbox.id, x, o[1] ?? 0);
			}
			refreshScroll(); queueMicrotask(refreshScroll); return;
		}
		const dy = e.deltaY ?? 0;
		if (!dy) return;
		zoomingUntil = performance.now() + 500;
		const f = Math.exp((e.precise ? dy : dy * 16) * 0.0022); // GPUI: positive deltaY = wheel up = zoom in
		const a = lastAnchor;
		setZoom(zoom() * f);
		queueMicrotask(() => restore(a));
		setTimeout(() => restore(a), 160); // once the new row heights are measured
	};

	// ---- controller for scripts -----------------------------------------------------------------------------------------------
	props.controller?.({
		doc, stats, zoom, setZoom, fitWidth, fitPage, scrollToPage: (i, y) => goTo(i, y ?? -1, false),
		tiles: () => stats.tiles,
		mounted: () => reg.boxes.size,
		visible: () => vis(),
		dpr,
		idle: async () => { while (pending.n > 0 || sched.pending > 0 || (previews()?.pending ?? 0) > 0) await Bun.sleep(5); },
			previews: () => ({ made: previews()?.made ?? 0, pending: previews()?.pending ?? 0 }),
		ready: () => (doc() || error() ? Promise.resolve() : new Promise<void>((r) => readyWaiters.push(r))),
		error,
		search: (q) => { clearTimeout(searchTimer); setQuery(q); void runSearch(q); },
		next: () => step(1),
		prev: () => step(-1),
		hits: () => [cur() + 1, hits().length, scanDone()],
		hitRows: () => hitRows(),
		rotate,
		select: async (a, b) => {
			await Promise.all([loadText(a.page, 0), loadText(b.page, 0)]);
			const r = order(a, b);
			setRange(r);
			await finalizeSelection(r);
		},
		selectedText: () => selInfo()?.text ?? null,
		copySelection: doCopy,
		clearSelection: clearSel,
		viewState: () => { const [page, frac] = anchor(); return { page, frac, zoomMode: zoomMode(), zoom: zoom(), rot: docRot() }; },
		context: () => ctxSig(),
		linksOf,
		outline,
		setSidebar,
		setAltView: (id) => setAltViewSig(id),
		debug: () => ({ sp: sp(), vis: vis(), win: win(), vp: vp(), zoom: zoom(), scrollX: scrollX(), scrollY: scrollY(), scroll: scrollMode(), spread: spreadMode(), rows: nRows(), curPage: curPage(), inner: [innerWidth(), innerHeight()], view: indices().map((i) => ({ i, v: viewFor(i), h: pageHeight(i), w: pageWidth(i) })), raw: readScroll() }),
		key: (e) => onKey({ key: e.key, modifiers: { ctrl: e.ctrl, shift: e.shift, alt: e.alt } }),
		wheel: (dy) => {
			const b = paneEl ? gpuix?.renderer.getElementBounds?.(paneEl.id) : null;
			if (!b || !list) return false;
			(gpuix?.renderer as unknown as { simulateScrollWheel?(x: number, y: number, dx: number, dy: number): void } | undefined)?.simulateScrollWheel?.(b.x + b.width / 2, b.y + b.height / 2, 0, -dy);
			return true;
		},
		coverage: () => {
			const s = readScroll();
			if (!s) return [];
			const out: { page: number; vis: number; blank: number; soft: number; sharp: number; noSrc: number }[] = [];
			for (const [page, f] of probe) { const r = f(viewFor(page, s)); if (r.vis > 0) out.push({ page, ...r }); }
			return out;
		},
		layout: () => ({ scroll: scrollMode(), spread: spreadMode(), rows: nRows() }),
		setLayout,
		selectedPages: () => selPages(),
		selectPages: (p) => setSelPages([...new Set(p)].sort((a, b) => a - b)),
		rotatePages: (pages, turns) => cmds.rotate(turns, pages),
		deletePages: (pages, ask = true) => cmds.remove(pages, ask),
	});

	// ---- view -------------------------------------------------------------------------------------------------------------------------
	const searchCount = () => {
		if (!query().trim()) return "";
		const n = hits().length;
		if (!n) return scanDone() ? "No results" : "…";
		return `${cur() + 1} / ${n}${scanDone() ? "" : "+"}`;
	};
	const inputTheme = () => ({
		appearance: mode(), bg: tok("background"), text: tok("foreground"), textMuted: tok("muted-foreground"),
		textFaint: tok("muted-foreground"), textDim: tok("muted-foreground"), accent: tok("primary"), caret: tok("primary"), fontSans: "Inter",
	});
	const [hitList, setHitList] = createSignal(false);
	const sep = () => <div style={{ ...t("mx-1 h-5 w-px flex-none"), backgroundColor: tok("border") }} />;

	// The toolbar WRAPS: its controls are grouped in rows that stay together (navigation, page, zoom and view, search, plugins), and a
	// group that does not fit moves to a second line instead of running past the window edge (the annotation tool options, the
	// academic "Back" button and the reading-view toggle all add width). One line is 40 px tall, as before.
	const toolbar = () => (
		<div style={{ ...t("relative flex flex-none items-center gap-x-1 border-b bg-card px-2"), flexWrap: "wrap", minHeight: 40, paddingTop: 4, paddingBottom: 4, rowGap: 4 }}>
			<div style={t("flex flex-none items-center gap-1")}>
			<Show when={doc()}>
				<IconButton icon="panel-left" title="Sidebar" mode={mode} on={sbOpen()} onClick={() => setSidebar(!sbOpen())} />
				<IconButton icon="arrow-left" title="Back (Alt+Left)" mode={mode} disabled={history().length === 0} onClick={goBack} />
			</Show>
			</div>
			<div style={{ ...t("mx-2 flex min-w-0 items-center"), flexGrow: 1, flexShrink: 1, flexBasis: 96 }}>
				<text style={{ ...tx("text-[13px] font-medium text-foreground"), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{props.title ?? ""}</text>
			</div>

			<Show when={doc()}>
				{/* page n / N */}
				<div style={t("flex flex-none items-center gap-1")}>
				<div style={{ ...t("flex h-7 w-11 flex-none items-center justify-center rounded border bg-background"), borderColor: tok("input") }}>
					<input
						value={String(curPage() + 1)}
						onSubmit={(e) => { const n = parseInt((e as { value?: string }).value ?? "", 10); if (Number.isFinite(n)) goTo(n - 1, -1, false); if (rootEl) gpuix?.renderer.focusElement?.(rootEl.id); }}
						style={{ width: 40, height: 26, fontSize: 12, fontFamily: "Inter", color: tok("foreground"), textAlign: "center" }}
						theme={inputTheme()}
					/>
				</div>
				<text style={{ ...tx("mr-2 text-xs text-muted-foreground"), whiteSpace: "nowrap" }}>{`/ ${count()}`}</text>
				</div>

				<div style={t("flex flex-none items-center gap-1")}>

				<IconButton icon="zoom-out" title="Zoom out (Ctrl+-)" mode={mode} onClick={() => zoomBy(1 / 1.15)} />
				<div style={t("flex w-11 flex-none items-center justify-center")}>
					<text style={{ ...tx("text-[11px] text-muted-foreground"), whiteSpace: "nowrap" }}>{`${Math.round(zoom() * 100)}%`}</text>
				</div>
				<IconButton icon="zoom-in" title="Zoom in (Ctrl+=)" mode={mode} onClick={() => zoomBy(1.15)} />
				<IconButton icon="move-horizontal" title="Fit width (Ctrl+0)" mode={mode} on={zoomMode() === "width"} onClick={fitWidth} />
				<IconButton icon="maximize" title="Fit page" mode={mode} on={zoomMode() === "page"} onClick={fitPage} />
				<IconButton icon="rotate-ccw" title="Rotate left (Ctrl+[)" mode={mode} onClick={() => rotate(-90)} />
				<IconButton icon="rotate-cw" title="Rotate right (Ctrl+])" mode={mode} onClick={() => rotate(90)} />
				<IconButton icon="palette" title="Page appearance" mode={mode} on={openMenu() === "appearance" || appearance().mode !== "normal"} onClick={() => setOpenMenu(openMenu() === "appearance" ? null : "appearance")} />
				<ViewMenuButton mode={mode} scroll={scrollMode} spread={spreadMode} setLayout={setLayout} cmds={cmds} />
				<PrintButton mode={mode} cmds={cmds} />
				</div>

				{/* search */}
				<div style={t("flex flex-none items-center gap-1")}>
				<div style={{ ...t("flex h-7 w-60 flex-none items-center rounded-md border bg-background pl-2"), borderColor: tok("input") }}>
					<Icon name="search" size={14} color={tok("muted-foreground")} />
					<input
						ref={(el: { id: number }) => { searchEl = el; }}
						value={query()}
						placeholder="Find in document"
						onChange={(e) => onQuery((e as { value?: string }).value ?? "")}
						onSubmit={() => step(1)}
						onKeyDown={(e) => {
							const k = e as { key?: string; modifiers?: { shift?: boolean } };
							if (k.key === "enter" && k.modifiers?.shift) step(-1);
							else if (k.key === "escape" && rootEl) gpuix?.renderer.focusElement?.(rootEl.id);
						}}
						style={{ flexGrow: 1, minWidth: 0, height: 26, paddingLeft: 6, paddingRight: 4, fontSize: 12, fontFamily: "Inter", color: tok("foreground") }}
						theme={inputTheme()}
					/>
					<div style={{ ...t("flex flex-none items-center justify-center"), width: 76 }}>
						<text style={{ ...tx("text-[11px] text-muted-foreground"), whiteSpace: "nowrap" }}>{searchCount()}</text>
					</div>
				</div>
				<IconButton icon="chevron-up" title="Previous match" mode={mode} disabled={hits().length === 0} onClick={() => step(-1)} />
				<IconButton icon="chevron-down" title="Next match" mode={mode} disabled={hits().length === 0} onClick={() => step(1)} />
				<IconButton icon="list" title="Match list" mode={mode} on={hitList()} disabled={hits().length === 0} onClick={() => setHitList(!hitList())} />
				</div>

				{/* plugins: their toolbar items, and a toggle for every alternate view */}
				<For each={plugins()}>
					{(p: ReaderPlugin) => (
						<>
							<Show when={p.altView}>
								{(av) => <LabelButton icon={av().icon} label={av().label} mode={mode} on={altView() === av().id} onClick={() => setAltViewSig(altView() === av().id ? null : av().id)} />}
							</Show>
							<Show when={p.toolbar && ctxSig()}>{p.toolbar!(ctx())}</Show>
						</>
					)}
				</For>
			</Show>
		</div>
	);

	const message = (icon: string, text: string, retry?: boolean) => (
		<div style={{ ...t("flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-muted"), width: "100%" }}>
			<Icon name={icon} size={28} color={tok("muted-foreground")} />
			<div style={{ maxWidth: 460, display: "flex", flexDirection: "row", justifyContent: "center" }}>
				<text style={{ ...tx("text-[13px] text-muted-foreground"), textAlign: "center" }}>{text}</text>
			</div>
			<Show when={retry}>
				<div
					onClick={() => void load()}
					style={{ ...t("flex h-8 items-center rounded-md border bg-background px-3"), borderColor: tok("input"), cursor: "pointer", hover: t("bg-accent") }}
				>
					<text style={tx("text-[13px] font-medium text-foreground")}>Retry</text>
				</div>
			</Show>
		</div>
	);

	const curAlt = createMemo(() => { const id = altView(); return id ? plugins().find((p) => p.altView?.id === id)?.altView : undefined; });
	// Whole-page low-resolution previews (core/preview.ts): the visible and mounted pages first, then a few pages ahead in the scroll
	// direction (one behind), so the page the reader is about to reach already has a stretched image under its tiles.
	const previews = createMemo<Previews | null>(() => {
		const d = doc();
		if (!d || process.env.ZN_NO_PREVIEW === "1") return null; // (the env switch is for before / after benchmarks)
		const pv = new Previews(d, dpr, look);
		onCleanup(() => pv.close());
		return pv;
	});
	// recently rendered whole-page bitmaps, so a band tile that turns up later is cut out of one instead of rendering the page again
	const bitmaps = createMemo<BitmapCache | null>(() => {
		if (!doc()) return null;
		const c = new BitmapCache();
		onCleanup(() => c.clear());
		return c;
	});
	const PREVIEW_AHEAD = 4, PREVIEW_BEHIND = 1;
	createEffect(() => {
		const pv = previews();
		if (!pv || !active() || !laidOut()) return;
		vis(); win(); dir(); docRot(); pageRots(); look(); dpr(); sp(); layout();
		untrack(() => {
			// vis is in rows: the visible pages are those of the visible rows
			const n = count(), dr = dir() || 1, [a, b] = vis(), L = layout();
			const ra = clamp(Math.floor(a), 0, Math.max(0, L.rows - 1)), rb = clamp(Math.ceil(b), ra + 1, L.rows);
			const lo = clamp(L.first[ra] ?? 0, 0, n - 1), hi = clamp(L.first[rb] ?? n, lo + 1, n);
			const want = new Map<number, PreviewWant>();
			const add = (page: number, prio: number) => {
				if (page < 0 || page >= n) return;
				const old = want.get(page);
				if (!old || prio < old.prio) want.set(page, { page, rot: rotOf(page), prio });
			};
			const cp = curPage();
			for (let i = lo; i < hi; i++) add(i, 0.4e6 + Math.abs(i - cp));
			for (const i of indices()) add(i, 0.5e6 + Math.abs(i - cp));
			for (let k = 0; k < PREVIEW_AHEAD; k++) add(dr > 0 ? hi + k : lo - 1 - k, 1.5e6 + k * 1000);
			for (let k = 0; k < PREVIEW_BEHIND; k++) add(dr > 0 ? lo - 1 - k : hi + k, 1.6e6 + k * 1000);
			pv.want([...want.values()]);
		});
	});
	const pageEnv = createMemo<PageEnv | null>(() => {
		const d = doc();
		return d ? { doc: d, sched, dpr, look, paper: () => paperColor(appearance()), stats, pending, reg, probe, margins, jobs, laidOut, previews: previews() ?? undefined, bitmaps: bitmaps() ?? undefined } : null;
	});

	/** overlays of every plugin for one page, in a pointer-transparent box the size of the page */
	const overlaysFor = (i: number) => () => (
		<Show when={ctxSig()}>
			<For each={plugins()}>
				{(p: ReaderPlugin) => (
					<Show when={p.pageOverlay && (rotOf(i) === 0 || p.handlesRotation)}>
						<div style={{ position: "absolute", left: 0, top: 0, width: pageWidth(i), height: pageHeight(i), pointerEvents: "none" }}>
							{p.pageOverlay!(ctx(), i, () => ({ width: pageWidth(i), height: pageHeight(i) }))}
						</div>
					</Show>
				)}
			</For>
		</Show>
	);

	// where the selection popup sits (window px -> this reader's px)
	const popupPos = createMemo(() => {
		viewTick();
		const s = selInfo();
		if (!s || drag || !paneEl) return null;
		const lastP = s.pages[s.pages.length - 1];
		const r = lastP?.rects[lastP.rects.length - 1];
		if (!lastP || !r) return null;
		const w = ctxSig()?.rectToWindow?.(lastP.page, r);
		const rb = gpuix?.renderer.getElementBounds?.(paneEl.id);
		if (!w || !rb) return null;
		const x = clamp(w.x - rb.x, 8, Math.max(8, rb.width - 220)), y = w.y - rb.y + w.height + 8;
		if (y < 4 || y > rb.height - 40) return null;
		return { x, y };
	});

	const pageSlot = (env: PageEnv, i: number) => (
		<PageSlot
			env={env}
			index={i}
			boxW={() => pageWidth(i)}
			boxH={() => pageHeight(i)}
			rot={() => rotOf(i)}
			view={() => viewFor(i)}
			hits={() => hitsByPage().get(i) ?? []}
			currentHit={cur}
			selection={() => selRectsFor(i)}
			links={() => linksOf(i)}
			onLink={(l, e) => activateLink(i, l, e)}
			overlays={overlaysFor(i)}
			debugWords={() => (props.debugWords ? (textVer(), peekText(i)?.words.map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h })) ?? null) : null)}
			selColor={selColor}
			hitColor={HIT}
			hitCurColor={HIT_CUR}
		/>
	);
	/** the pages of row r side by side (a spread, a wrapped row), each at its offset from core/layout.ts */
	const rowContent = (env: PageEnv, r: number) => (
		<For each={rowPages(layout(), r)}>
			{(i) => (
				<div style={{ display: "flex", flexShrink: 0, marginLeft: i === layout().first[r] ? 0 : (layout().px[i] ?? 0) - (layout().px[i - 1] ?? 0) - pageWidth(i - 1), marginTop: layout().py[i] ?? 0 }}>
					{pageSlot(env, i)}
				</div>
			)}
		</For>
	);
	/** vertical and wrapped scrolling: a virtual list of rows inside a box that pans sideways when a row is wider than the viewport */
	const verticalPages = (env: PageEnv) => (
		<div
			ref={(el: { id: number }) => { hbox = el; }}
			onLayout={onViewport}
			onScrollChange={(e: EventPayload) => { setScrollX(Math.round(e.scrollX ?? 0)); bump(); }}
			onMouseDown={onMouseDown}
			onMouseMove={onMouseMove}
			onMouseUp={onMouseUp}
			onScroll={onWheel}
			style={{ display: "flex", flexDirection: "row", flexGrow: 1, minHeight: 0, width: "100%", overflowX: "scroll" }}
		>
			<div style={{ display: "flex", flexDirection: "column", flexShrink: 0, width: innerWidth(), height: "100%" }}>
				<virtual-list
					ref={onListRef}
					testId="reader-pages"
					itemCount={nRows()}
					windowStart={first()}
					estimatedItemHeight={estimate()}
					overdraw={300}
					onVisibleRange={onVisibleRange}
					style={{ width: "100%", flexGrow: 1, minHeight: 0 }}
				>
					<For each={rowIdx()}>
						{(r) => (
							<div style={{ display: "flex", flexDirection: "row", justifyContent: "center", alignItems: "flex-start", width: "100%", paddingTop: layout().lead[r] ?? 0, paddingBottom: layout().trail[r] ?? 0 }}>
								{rowContent(env, r)}
							</div>
						)}
					</For>
				</virtual-list>
			</div>
		</div>
	);
	/** horizontal scrolling: a strip as wide as all columns, scrolled sideways, with only the columns near the viewport mounted after
	 *  a spacer (an overflow box lays out its children every frame, so it must not hold every page) */
	const horizontalPages = (env: PageEnv) => (
		<div
			ref={(el: { id: number }) => { hbox = el; onListRef(el); }}
			testId="reader-pages"
			onLayout={onViewport}
			onScrollChange={(e: EventPayload) => { setScrollY(Math.round(e.scrollY ?? 0)); refreshScroll(); bump(); }}
			onMouseDown={onMouseDown}
			onMouseMove={onMouseMove}
			onMouseUp={onMouseUp}
			onScroll={onWheel}
			style={{ display: "flex", flexDirection: "row", flexGrow: 1, minHeight: 0, width: "100%", overflowX: "scroll", overflowY: innerHeight() > vp().h + 1 ? "scroll" : "hidden" }}
		>
			<div style={{ display: "flex", flexDirection: "row", flexShrink: 0, alignItems: "flex-start", width: innerWidth(), height: innerHeight() }}>
				<div style={{ flexShrink: 0, width: layout().start[first()] ?? 0, height: 1 }} />
				<For each={rowIdx()}>
					{(r) => (
						<div style={{ display: "flex", flexDirection: "row", alignItems: "flex-start", flexShrink: 0, width: layout().ext[r] ?? 0, paddingLeft: layout().lead[r] ?? 0, paddingTop: colTop(r) }}>
							{rowContent(env, r)}
						</div>
					)}
				</For>
			</div>
		</div>
	);

	const body = (env: PageEnv) => (
		<div onLayout={(e: EventPayload) => setBodyW(e.width ?? 0)} style={{ display: "flex", flexDirection: "row", flexGrow: 1, minHeight: 0, width: "100%" }}>
			{/* the sidebar (annotations, figures, references…) stays available in the reading view too; Contents there is a dropdown */}
			<Show when={sbOpen()}>
				<Sidebar mode={mode} width={Math.min(sbW(), sbMax())} tabs={sideTabs} tab={sbTab} onTab={(id) => setSidebar(true, id)} onWidth={resizeSidebar} maxWidth={sbMax} />
			</Show>
			<div ref={(el: { id: number }) => { paneEl = el; }} onLayout={onViewport} style={{ display: "flex", flexDirection: "column", flexGrow: 1, minWidth: 0, minHeight: 0, position: "relative", backgroundColor: tok("muted") }}>
				<Show
					when={curAlt()}
					fallback={<Show when={horiz()} fallback={verticalPages(env)}>{horizontalPages(env)}</Show>}
				>
					{(av) => <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0, width: "100%" }}><Show when={ctxSig()}>{av().render(ctx())}</Show></div>}
				</Show>

				{/* selection popup: Copy + the plugins' controls */}
				<Show when={popupPos()}>
					{(pos) => (
						<div style={{ ...t("absolute flex items-center gap-1 rounded-lg border bg-popover p-1"), left: pos().x, top: pos().y, boxShadow: [{ offsetX: 0, offsetY: 4, blurRadius: 12, spreadRadius: 0, color: "rgba(0,0,0,0.25)" }] }}>
							<div
								onClick={() => { doCopy(); }}
								style={{ ...t("flex h-7 items-center gap-1.5 rounded-md px-2"), cursor: "pointer", hover: t("bg-accent") }}
							>
								<Icon name="copy" size={13} color={tok("foreground")} />
								<text style={tx("text-xs text-foreground")}>Copy</text>
							</div>
							<Show when={ctxSig()}>
								<For each={plugins()}>{(p: ReaderPlugin) => <Show when={p.selectionPopup}>{p.selectionPopup!(ctx())}</Show>}</For>
							</Show>
						</div>
					)}
				</Show>
			</div>
		</div>
	);

	/** the list of matches, a dropdown under the toolbar's search box (the sidebar has no Find tab: the box is the one place to search) */
	const hitMenu = () => (
		<div
			onMouseDownOutside={() => setHitList(false)}
			style={{ ...t("absolute flex flex-col rounded-lg border bg-popover"), overflow: "hidden", right: 8, top: 44, width: 340, height: Math.min(360, Math.max(1, hitRows().length) * 50 + 2), boxShadow: [{ offsetX: 0, offsetY: 6, blurRadius: 18, spreadRadius: 0, color: "rgba(0,0,0,0.3)" }] }}
		>
			<FindResults mode={mode} query={query} hits={hitRows} cur={cur} done={scanDone} show={(i) => showHit(i)} />
		</div>
	);

	const appearanceMenu = () => (
		<div
			onMouseDownOutside={() => { if (openMenu() === "appearance") setOpenMenu(null); }}
			style={{ ...t("absolute flex flex-col gap-2 rounded-lg border bg-popover p-3"), right: 8, top: 44, width: 236, boxShadow: [{ offsetX: 0, offsetY: 6, blurRadius: 18, spreadRadius: 0, color: "rgba(0,0,0,0.3)" }] }}
		>
			<text style={tx("text-xs font-medium text-muted-foreground")}>Page appearance</text>
			<div style={{ display: "flex", flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
				<For each={APPEARANCES}>
					{(a) => (
						<div
							onClick={() => setReaderAppearance({ ...appearance(), mode: a.id })}
							style={{ ...t("flex flex-col items-center gap-1 rounded-md p-1.5"), width: 60, cursor: "pointer", ...(appearance().mode === a.id ? { backgroundColor: tok("accent") } : {}), hover: t("bg-accent") }}
						>
							<div style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: a.swatch, borderWidth: 1, borderColor: tok("border") }} />
							<text style={tx("text-[11px] text-foreground")}>{a.label}</text>
						</div>
					)}
				</For>
				<Show when={appearance().mode === "reading" || (appearance().fg && appearance().bg)}>
					<div
						onClick={() => setReaderAppearance({ ...appearance(), mode: "reading" })}
						style={{ ...t("flex flex-col items-center gap-1 rounded-md p-1.5"), width: 60, cursor: "pointer", ...(appearance().mode === "reading" ? { backgroundColor: tok("accent") } : {}), hover: t("bg-accent") }}
					>
						<div style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: appearance().bg ?? "#fff", borderWidth: 1, borderColor: tok("border") }} />
						<text style={tx("text-[11px] text-foreground")}>Reading</text>
					</div>
				</Show>
			</div>
			<text style={tx("text-xs font-medium text-muted-foreground")}>Custom colour</text>
			<div style={{ display: "flex", flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
				<For each={CUSTOM_COLORS}>
					{(c) => (
						<div
							onClick={() => setReaderAppearance({ ...appearance(), mode: "custom", custom: c })}
							style={{
								width: 24, height: 24, borderRadius: 12, backgroundColor: c, cursor: "pointer",
								borderWidth: appearance().mode === "custom" && appearance().custom === c ? 2 : 1,
								borderColor: appearance().mode === "custom" && appearance().custom === c ? tok("primary") : tok("border"),
							}}
						/>
					)}
				</For>
			</div>
		</div>
	);

	return (
		<div
			ref={(el: { id: number }) => { rootEl = el; }}
			tabIndex={0}
			onKeyDown={(e) => onKey(e as never)}
			style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", flexGrow: 1, minHeight: 0, minWidth: 0, backgroundColor: tok("muted"), position: "relative", keyboardFocusDim: false }}
		>
			<Show when={active()} fallback={<div style={{ flexGrow: 1 }} />}>
				<Show when={props.showToolbar !== false}>{toolbar()}</Show>
				<Show
					when={pageEnv()}
					keyed
					fallback={
						<Show when={error()} fallback={message("loader-circle", loading() ? "Opening PDF…" : "")}>
							{message("file-warning", error() ?? "", true)}
						</Show>
					}
				>
					{(env) => body(env)}
				</Show>
				<Show when={openMenu() === "appearance"}>{appearanceMenu()}</Show>
				<Show when={hitList() && hits().length > 0}>{hitMenu()}</Show>
			</Show>
		</div>
	);
}

/** The parent item of an attachment, from the open reader tabs (the store is imported lazily: it starts loading the library). */
let tabsLookup: ((attachmentKey: string) => string) | undefined;
function itemKeyLookup(attachmentKey: string): string {
	if (!tabsLookup) {
		tabsLookup = () => "";
		void import("../store").then(({ store }) => {
			tabsLookup = (k) => {
				const tab = store.tabs().find((x) => x.id === k);
				return tab && "itemKey" in tab ? (tab as { itemKey: string }).itemKey : "";
			};
		}).catch(() => {});
	}
	return tabsLookup(attachmentKey);
}
