// Native PDF reader: pages are rasterized by hayro (native/pdf, via bun:ffi) and shown as <img> in a windowed GPUIX
// <virtual-list>. It lives inside the app window and fills its parent:
//
//   <Reader attachmentKey="ABCD1234" title="Zare 2017" active={tab is visible} />
//
// * The PDF is fetched through the core (library.ts), so the reader needs nothing but the attachment key.
// * Layout follows the container (onLayout): fit-width by default (centred page column, 16 px gutters, 12 px gap, the web
//   reader's page shadow + 1 px ring on a "muted" canvas); a resize re-fits and re-renders (debounced in the page slots).
// * Bitmaps are rendered at DPR x zoom (DPR from the window, see env.ts); only a window of pages is mounted.
// * `active=false` keeps the component mounted but unmounts the whole page list (GPUIX drops the bitmaps), cancels queued
//   renders, clears hayro's caches and pauses a running search; `active` again restores the same page and zoom.
// * Toolbar like reader-next's: title, page n / N, zoom - / % / +, fit width, search with next / previous.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack, type Accessor, type JSX } from "solid-js";
import { useGpuix } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/solid";
import type { Mode, Style } from "../contracts";
import { Icon } from "../icons";
import { textStyle, tokens, tw, withAlpha, type BoxShadow } from "../theme";
import { readerMode, windowDpr } from "./env";
import { openPdf } from "./library";
import { PdfDoc, type RenderTask, type TextLayer, type TextWord } from "./pdf";

export const CSS_PER_PT = 96 / 72; // zoom 1 (100%) = 96 dpi, like the web reader
export const GAP = 12; // between pages
export const PAD = 16; // around the page column
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;
/** Longest bitmap we will rasterize, in pixels (a 6x zoom at DPR 2 would otherwise ask for ~500 MB per page). */
const MAX_BITMAP_PX = 24_000_000;
/** Total bitmap pixels the mounted window may hold; fewer pages are mounted when they are big. */
const WINDOW_BUDGET_PX = 120_000_000;

export interface ReaderStats {
	/** pages rasterized / uploaded since start */
	renders: number;
	lastRenderMs: number;
	lastUploadMs: number;
	totalRenderMs: number;
	/** peak number of page <img>s alive at once */
	peakMounted: number;
	cancelled: number;
}

/** Hooks for scripts (screenshots, benchmarks); the app does not need them. */
export interface ReaderController {
	/** null until the document is open */
	doc(): PdfDoc | null;
	stats: ReaderStats;
	/** effective zoom (1 = 100%) */
	zoom: Accessor<number>;
	setZoom(z: number): void;
	fitWidth(): void;
	scrollToPage(i: number): void;
	/** pages currently mounted (their <img> exists) */
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
}

export interface ReaderProps {
	/** the attachment (not the item) whose PDF to show */
	attachmentKey: string;
	title?: string;
	/** false: stay mounted but free the page bitmaps and stop rendering (default true) */
	active?: boolean;

	// ---- optional extras for scripts; the app passes none of them
	/** open this file instead of fetching `attachmentKey` */
	path?: string;
	/** or use an already open document (the caller closes it) */
	doc?: PdfDoc;
	/** initial custom zoom (default: fit width) */
	zoom?: number;
	/** force the device pixel ratio (default: the window's) */
	dpr?: number;
	/** max pages mounted at once (default: by pixel budget, at most 7) */
	window?: number;
	/** initial search text */
	highlight?: string;
	/** outline every word rect of the text layer (geometry check) */
	debugWords?: boolean;
	showToolbar?: boolean;
	controller?: (c: ReaderController) => void;
}

interface Rect { x: number; y: number; w: number; h: number }
/** One search hit: the rects (normalised 0..1 of the page) of the words it covers, merged per line. */
interface Hit { page: number; rects: Rect[] }

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

// ------------------------------------------------------------------------------------------------ search

/** Case-insensitive hits of `needle` (already lower-cased, single-spaced) in a page's words; phrases may span words and lines. */
function searchLayer(l: TextLayer, needle: string): Rect[][] {
	if (!needle || !l.words.length) return [];
	const starts: number[] = [];
	let off = 0;
	const parts: string[] = [];
	for (const w of l.words) { starts.push(off); parts.push(w.t); off += w.t.length + 1; }
	const text = parts.join(" ").toLowerCase();
	const out: Rect[][] = [];
	let from = 0;
	for (;;) {
		const i = text.indexOf(needle, from);
		if (i < 0) break;
		const e = i + needle.length;
		from = e;
		// first word whose end is past i
		let lo = 0, hi = starts.length - 1;
		while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid]! + l.words[mid]!.t.length <= i) lo = mid + 1; else hi = mid; }
		const rects: Rect[] = [];
		let cur: (Rect & { l: number }) | undefined;
		for (let k = lo; k < starts.length && starts[k]! < e; k++) {
			const w: TextWord = l.words[k]!;
			if (cur && cur.l === w.l) {
				const x2 = Math.max(cur.x + cur.w, w.x + w.w), y1 = Math.min(cur.y, w.y), y2 = Math.max(cur.y + cur.h, w.y + w.h);
				cur = { x: cur.x, y: y1, w: x2 - cur.x, h: y2 - y1, l: w.l };
			} else {
				if (cur) rects.push(cur);
				cur = { x: w.x, y: w.y, w: w.w, h: w.h, l: w.l };
			}
		}
		if (cur) rects.push(cur);
		if (rects.length) out.push(rects);
	}
	return out;
}

// ------------------------------------------------------------------------------------------------ one page

const PAGE_SHADOW: BoxShadow[] = [
	{ offsetX: 0, offsetY: 4, blurRadius: 6, spreadRadius: -1, color: "rgba(0, 0, 0, 0.1)" },
	{ offsetX: 0, offsetY: 2, blurRadius: 4, spreadRadius: -2, color: "rgba(0, 0, 0, 0.1)" },
];

const HIT = withAlpha("#ffd60a", 0.4);
const HIT_CUR = withAlpha("#ff8a00", 0.55);

/** One page: the <img> the bitmap goes into, the page ring, and the highlight overlays. */
function PageSlot(p: {
	doc: PdfDoc;
	index: number;
	width: Accessor<number>;
	dpr: Accessor<number>;
	stats: ReaderStats;
	pending: { n: number };
	mountedCount: { n: number; set(): void };
	hits: Accessor<{ rects: Rect[]; id: number }[]>;
	currentHit: Accessor<number>;
	debugWords: Accessor<boolean>;
	/** true while this page is within one page of the viewport: those render first, the rest of the window waits a bit */
	near: Accessor<boolean>;
}): JSX.Element {
	const [pw, ph] = p.doc.sizes[p.index]!;
	const height = () => Math.round((p.width() * ph) / pw);
	let img: { mounted: boolean; setImagePixels(w: number, h: number, b: Uint8Array, o?: { format?: "rgba" | "bgra" }): void } | undefined;
	let alive = true;
	let task: RenderTask | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let gen = 0;

	p.mountedCount.n++;
	p.mountedCount.set();
	onCleanup(() => {
		alive = false;
		if (task) { task.cancel(); p.stats.cancelled++; }
		clearTimeout(timer);
		p.mountedCount.n--;
		p.mountedCount.set();
	});

	async function run(my: number, pxWidth: number): Promise<void> {
		const scale = pxWidth / pw;
		p.pending.n++;
		try {
			const t = p.doc.render(p.index, scale);
			task = t;
			const r = await t.promise;
			if (task === t) task = undefined;
			if (!r) return;
			// the element may not be inserted yet right after mount: wait for it (a few frames at most)
			for (let i = 0; i < 40 && alive && !(img && img.mounted); i++) await Bun.sleep(8);
			if (!alive || my !== gen || !img || !img.mounted) { r.release(); return; }
			const u0 = performance.now();
			img.setImagePixels(r.width, r.height, r.pixels, { format: "bgra" });
			const upload = performance.now() - u0;
			p.stats.renders++;
			p.stats.lastRenderMs = r.renderMs;
			p.stats.totalRenderMs += r.renderMs;
			p.stats.lastUploadMs = upload;
			r.release();
		} catch (e) {
			if (alive) console.error(`[reader] page ${p.index}:`, e instanceof Error ? e.message : e);
		} finally {
			p.pending.n--;
		}
	}

	// target bitmap width in device pixels (capped so one page never asks for hundreds of MB)
	const pxWidth = () => {
		const want = Math.max(16, Math.round(p.width() * p.dpr()));
		const cap = Math.floor(Math.sqrt((MAX_BITMAP_PX * pw) / ph));
		return Math.min(want, cap);
	};
	// (re)render whenever the target bitmap width changes: at once the first time, debounced after a zoom / resize
	createEffect(on(pxWidth, (pxW, prev) => {
		const my = ++gen;
		if (task) { task.cancel(); p.stats.cancelled++; task = undefined; }
		clearTimeout(timer);
		const delay = (prev === undefined ? 0 : 140) + (untrack(p.near) ? 0 : 300);
		if (delay === 0) void run(my, pxW);
		else timer = setTimeout(() => void run(my, pxW), delay);
	}));

	// text layer: fetched only for the word-geometry debug overlay
	const [layer, setLayer] = createSignal<TextLayer | null>(null);
	createEffect(() => {
		if (!p.debugWords() || untrack(layer)) return;
		void p.doc.textLayerAsync(p.index).then((l) => { if (alive) setLayer(l); }).catch((e) => console.error("[reader] text layer:", e));
	});

	return (
		<div style={{ position: "relative", width: p.width(), height: height(), flexShrink: 0, backgroundColor: "#ffffff", boxShadow: PAGE_SHADOW }}>
			<img
				ref={(el) => { img = el as never; }}
				objectFit="fill"
				style={{ position: "absolute", left: 0, top: 0, width: p.width(), height: height() }}
			/>
			<For each={p.hits()}>
				{(h) => (
					<For each={h.rects}>
						{(r) => (
							<div
								style={{
									position: "absolute", left: r.x * p.width(), top: r.y * height(), width: r.w * p.width(), height: r.h * height(),
									backgroundColor: p.currentHit() === h.id ? HIT_CUR : HIT, borderRadius: 2,
								}}
							/>
						)}
					</For>
				)}
			</For>
			<Show when={p.debugWords() && layer()}>
				<For each={layer()!.words}>
					{(w) => (
						<div style={{ position: "absolute", left: w.x * p.width(), top: w.y * height(), width: w.w * p.width(), height: w.h * height(), borderWidth: 1, borderColor: "#e5484d", backgroundColor: "#e5484d1f" }} />
					)}
				</For>
			</Show>
			{/* the web reader's ring-1 ring-black/10 */}
			<div style={{ position: "absolute", left: 0, top: 0, width: p.width(), height: height(), borderWidth: 1, borderColor: "rgba(0, 0, 0, 0.1)", pointerEvents: "none" }} />
		</div>
	);
}

// ------------------------------------------------------------------------------------------------ toolbar bits

function IconButton(p: { icon: string; title: string; mode: Accessor<Mode>; onClick: () => void; on?: boolean; disabled?: boolean; size?: number }): JSX.Element {
	const t = (cls: string): Style => tw(cls, p.mode());
	const tok = (n: string) => tokens[p.mode()][n] ?? "#888";
	return (
		<div
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

// ------------------------------------------------------------------------------------------------ the reader

export function Reader(props: ReaderProps): JSX.Element {
	const gpuix = useGpuix();
	const mode = readerMode();
	const t = (cls: string): Style => tw(cls, mode());
	const tx = (cls: string): Style => textStyle(cls, mode());
	const tok = (name: string): string => tokens[mode()][name] ?? "#888";

	const active = () => props.active !== false;

	// ---- the document ---------------------------------------------------------------------------------------------
	const [doc, setDoc] = createSignal<PdfDoc | null>(null);
	const [error, setError] = createSignal<string | null>(null);
	const [loading, setLoading] = createSignal(false);
	let owned: PdfDoc | null = null;
	let abort: AbortController | undefined;
	let loadGen = 0;
	let readyWaiters: (() => void)[] = [];
	const settleReady = () => { const w = readyWaiters; readyWaiters = []; for (const f of w) f(); };

	function closeOwned() { if (owned) { owned.close(); owned = null; } }
	async function load(): Promise<void> {
		const my = ++loadGen;
		abort?.abort();
		abort = new AbortController();
		setError(null);
		setLoading(true);
		setDoc(null);
		closeOwned();
		// a new document starts at the top with no hits (zoom mode and the search text carry over)
		setStart(0);
		setVis([0, 1]);
		saved = [0, 0];
		list = undefined;
		scanGen++;
		setHits([]);
		setCur(-1);
		try {
			let d: PdfDoc;
			if (props.doc) d = props.doc;
			else {
				d = await openPdf(props.path ?? props.attachmentKey, abort.signal);
				if (my !== loadGen) { d.close(); return; }
				owned = d;
			}
			if (d.pageCount < 1) throw new Error("the PDF has no pages");
			setDoc(d);
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
		const a = active(), key = `${props.path ?? ""}|${props.attachmentKey}`;
		if (!a || loadedFor === key) return;
		loadedFor = key;
		untrack(() => void load());
	});
	onCleanup(() => { loadGen++; abort?.abort(); closeOwned(); scanGen++; });

	// ---- viewport / zoom ------------------------------------------------------------------------------------------
	const [vp, setVp] = createSignal({ w: 0, h: 0 });
	const [dpr, setDpr] = createSignal(props.dpr ?? windowDpr());
	const refreshDpr = () => setDpr(props.dpr ?? windowDpr());

	const [zoomMode, setZoomMode] = createSignal<"width" | "custom">(props.zoom ? "custom" : "width");
	const [zoomCustom, setZoomCustom] = createSignal(props.zoom ?? 1);
	const medianWidth = createMemo(() => {
		const d = doc();
		if (!d) return 612;
		const ws = d.sizes.map((s) => s[0]).sort((a, b) => a - b);
		return ws[ws.length >> 1] || 612;
	});
	const fit = createMemo(() => clamp((Math.max(100, vp().w) - PAD * 2) / (medianWidth() * CSS_PER_PT), MIN_ZOOM, MAX_ZOOM));
	const zoom = () => (zoomMode() === "width" ? fit() : zoomCustom());
	const pageWidth = (i: number) => Math.max(8, Math.round(doc()!.sizes[i]![0] * CSS_PER_PT * zoom()));
	const pageHeight = (i: number) => Math.round((pageWidth(i) * doc()!.sizes[i]![1]) / doc()!.sizes[i]![0]);
	const rowPad = (i: number): [number, number] => [i === 0 ? PAD : GAP / 2, i === (doc()?.pageCount ?? 1) - 1 ? PAD : GAP / 2];
	const rowHeight = (i: number) => pageHeight(i) + rowPad(i)[0] + rowPad(i)[1];
	const maxWidthPt = createMemo(() => Math.max(1, ...(doc()?.sizes.map((s) => s[0]) ?? [612])));
	/** width of the scrolled content: the viewport, or wider when the widest page (plus gutters) does not fit */
	const innerWidth = () => Math.max(vp().w, Math.round(maxWidthPt() * CSS_PER_PT * zoom()) + PAD * 2);

	// ---- the mounted window of pages ------------------------------------------------------------------------------
	const stats: ReaderStats = { renders: 0, lastRenderMs: 0, lastUploadMs: 0, totalRenderMs: 0, peakMounted: 0, cancelled: 0 };
	const pending = { n: 0 };
	const [, setMountedN] = createSignal(0);
	const mountedCount = {
		n: 0,
		set() { stats.peakMounted = Math.max(stats.peakMounted, this.n); queueMicrotask(() => setMountedN(this.n)); },
	};
	const count = () => doc()?.pageCount ?? 0;
	const windowN = createMemo(() => {
		if (props.window) return Math.max(1, props.window);
		const d = doc();
		if (!d) return 7;
		const px = Math.min(MAX_BITMAP_PX, pageWidth(0) * dpr() * pageHeight(0) * dpr());
		return clamp(Math.floor(WINDOW_BUDGET_PX / Math.max(1, px)), 3, 7);
	});
	const [start, setStart] = createSignal(0);
	const first = createMemo(() => Math.max(0, Math.min(start(), count() - windowN())));
	const indices = createMemo(() => {
		const s = first(), e = Math.min(count(), s + windowN());
		return Array.from({ length: Math.max(0, e - s) }, (_, i) => s + i);
	});
	const [vis, setVis] = createSignal<[number, number]>([0, 1]);
	const margin = () => Math.max(1, Math.floor(windowN() / 4));
	const onVisibleRange = (e: EventPayload) => {
		const a = e.startIndex ?? 0, b = e.endIndex ?? a + 1;
		setVis([a, b]);
		const s = untrack(first), W = untrack(windowN);
		const span = Math.ceil(b) - Math.floor(a);
		if ((Math.floor(a) < s + margin() && s > 0) || Math.ceil(b) > s + W - margin()) {
			setStart(Math.max(0, Math.floor(a) - Math.max(0, Math.floor((W - span) / 2))));
		}
	};
	const curPage = createMemo(() => {
		const [a, b] = vis();
		return clamp(Math.floor(a + 0.35 * Math.max(0, b - a)), 0, Math.max(0, count() - 1));
	});
	const estimate = createMemo(() => {
		const d = doc();
		if (!d) return 800;
		let sum = 0;
		const n = Math.min(d.pageCount, 20);
		for (let i = 0; i < n; i++) sum += pageHeight(i);
		return Math.round(sum / Math.max(1, n)) + GAP;
	});

	let list: { id: number } | undefined;
	let hbox: { id: number } | undefined; // the horizontally scrolling box around the list
	/** where the viewport top is: [page, fraction of that page's row above the top] */
	function anchor(): [number, number] {
		const a = list ? gpuix?.renderer.getListScrollTop?.(list.id) : null;
		if (a && a.length >= 2) {
			const i = clamp(a[0]!, 0, Math.max(0, count() - 1));
			return [i, clamp(a[1]! / Math.max(1, rowHeight(i)), 0, 1)];
		}
		const v = untrack(vis)[0];
		return [Math.floor(v), v - Math.floor(v)];
	}
	function scrollTo(page: number, offset = 0) {
		const idx = clamp(page, 0, Math.max(0, count() - 1));
		setStart(Math.max(0, idx - Math.floor(windowN() / 4)));
		if (list) gpuix?.renderer.scrollToItem?.(list.id, idx, offset);
	}
	function restore([page, frac]: [number, number]) {
		scrollTo(page, Math.round(frac * rowHeight(clamp(page, 0, Math.max(0, count() - 1)))));
	}
	/** run a layout change (zoom, resize) and keep the same spot of the document at the top, and the same column centred */
	function keepAnchor(change: () => void) {
		const a = doc() && list ? anchor() : null;
		const z0 = zoom(), w0 = innerWidth(), v0 = vp().w;
		const sx0 = hbox ? gpuix?.renderer.getScrollOffset?.(hbox.id)?.[0] ?? 0 : 0;
		change();
		if (a && (a[0] > 0 || a[1] > 0)) queueMicrotask(() => restore(a));
		if (hbox) {
			const w1 = innerWidth(), v1 = vp().w, ratio = zoom() / z0;
			const cx = (-sx0 + v0 / 2 - w0 / 2) * ratio + w1 / 2; // the content x that was in the middle of the viewport
			const sx1 = clamp(-(cx - v1 / 2), -Math.max(0, w1 - v1), 0);
			if (Math.abs(sx1 - sx0) >= 1) queueMicrotask(() => hbox && gpuix?.renderer.scrollTo?.(hbox.id, sx1, 0));
		}
	}

	function setZoom(z: number) {
		keepAnchor(() => { setZoomMode("custom"); setZoomCustom(clamp(Math.round(z * 100) / 100, MIN_ZOOM, MAX_ZOOM)); });
	}
	const fitWidth = () => keepAnchor(() => setZoomMode("width"));
	const zoomBy = (f: number) => setZoom(zoom() * f);

	// the container's size: refit on resize (the page slots debounce the re-render)
	function onViewport(e: EventPayload) {
		const w = Math.round(e.width ?? 0), h = Math.round(e.height ?? 0);
		if (w <= 0 || h <= 0) return; // hidden: keep the last layout
		const v = untrack(vp);
		refreshDpr();
		if (Math.abs(v.w - w) < 1 && Math.abs(v.h - h) < 1) return;
		if (v.w === 0 || zoomMode() === "custom") setVp({ w, h });
		else keepAnchor(() => setVp({ w, h }));
	}

	// ---- going inactive / active ----------------------------------------------------------------------------------
	let saved: [number, number] = [0, 0];
	createEffect(on(active, (a) => {
		if (a) return;
		// the page list is about to be unmounted: remember where we were, free what hayro cached
		saved = untrack(() => (list ? anchor() : [Math.floor(vis()[0]), vis()[0] - Math.floor(vis()[0])]));
		setStart(Math.max(0, saved[0] - margin()));
		list = undefined;
		doc()?.clearCache();
	}, { defer: true }));
	function onListRef(el: { id: number }) {
		list = el;
		if (saved[0] > 0 || saved[1] > 0) {
			const s = saved;
			saved = [0, 0];
			setTimeout(() => restore(s), 0);
		}
	}

	// ---- search ---------------------------------------------------------------------------------------------------
	const [query, setQuery] = createSignal(props.highlight ?? "");
	const [hits, setHits] = createSignal<Hit[]>([]);
	const [cur, setCur] = createSignal(-1);
	const [scanDone, setScanDone] = createSignal(true);
	let scanGen = 0;
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => clearTimeout(searchTimer));
	const hitsByPage = createMemo(() => {
		const m = new Map<number, { rects: Rect[]; id: number }[]>();
		hits().forEach((h, id) => { const l = m.get(h.page); if (l) l.push({ rects: h.rects, id }); else m.set(h.page, [{ rects: h.rects, id }]); });
		return m;
	});

	function showHit(id: number) {
		const h = untrack(hits)[id];
		if (!h) return;
		setCur(id);
		const top = h.rects[0]!.y * pageHeight(h.page);
		// put the hit about a third of the way down the viewport
		scrollTo(h.page, Math.max(0, Math.round(rowPad(h.page)[0] + top - untrack(vp).h * 0.3)));
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
			let layer: TextLayer;
			try { layer = await d.textLayerAsync(i); } catch { continue; }
			if (my !== scanGen) return;
			const rects = searchLayer(layer, needle);
			if (rects.length) {
				for (const r of rects) found.push({ page: i, rects: r });
				setHits([...found]);
				// the first hit at or after the page being looked at is the current one
				if (!jumped && i >= from) { jumped = true; showHit(found.length - rects.length); }
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

	// ---- controller for scripts -----------------------------------------------------------------------------------
	props.controller?.({
		doc, stats, zoom, setZoom, fitWidth, scrollToPage: (i) => scrollTo(i),
		mounted: () => mountedCount.n,
		visible: () => vis(),
		dpr,
		idle: async () => { while (pending.n > 0) await Bun.sleep(5); },
		ready: () => (doc() || error() ? Promise.resolve() : new Promise<void>((r) => readyWaiters.push(r))),
		error,
		search: (q) => { clearTimeout(searchTimer); setQuery(q); void runSearch(q); },
		next: () => step(1),
		prev: () => step(-1),
		hits: () => [cur() + 1, hits().length, scanDone()],
	});

	// ---- view -----------------------------------------------------------------------------------------------------
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

	const toolbar = () => (
		<div style={t("flex h-10 flex-none items-center gap-1 border-b bg-card px-2")}>
			<div style={t("mx-2 flex min-w-0 flex-1 items-center")}>
				<text style={{ ...tx("text-[13px] font-medium text-foreground"), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{props.title ?? ""}</text>
			</div>

			<Show when={doc()}>
			{/* page n / N */}
			<div style={{ ...t("flex h-7 w-11 flex-none items-center justify-center rounded border bg-background"), borderColor: tok("input") }}>
				<input
					value={String(curPage() + 1)}
					onSubmit={(e) => { const n = parseInt((e as { value?: string }).value ?? "", 10); if (Number.isFinite(n)) scrollTo(n - 1); }}
					style={{ width: 40, height: 26, fontSize: 12, fontFamily: "Inter", color: tok("foreground"), textAlign: "center" }}
					theme={inputTheme()}
				/>
			</div>
			<text style={{ ...tx("mr-2 text-xs text-muted-foreground"), whiteSpace: "nowrap" }}>{`/ ${count()}`}</text>

			<IconButton icon="zoom-out" title="Zoom out" mode={mode} onClick={() => zoomBy(1 / 1.15)} />
			<div style={t("flex w-11 flex-none items-center justify-center")}>
				<text style={{ ...tx("text-[11px] text-muted-foreground"), whiteSpace: "nowrap" }}>{`${Math.round(zoom() * 100)}%`}</text>
			</div>
			<IconButton icon="zoom-in" title="Zoom in" mode={mode} onClick={() => zoomBy(1.15)} />
			<IconButton icon="move-horizontal" title="Fit width" mode={mode} on={zoomMode() === "width"} onClick={fitWidth} />

			<div style={{ ...t("mx-1 h-5 w-px flex-none"), backgroundColor: tok("border") }} />

			{/* search */}
			<div style={{ ...t("flex h-7 w-60 flex-none items-center rounded-md border bg-background pl-2"), borderColor: tok("input") }}>
				<Icon name="search" size={14} color={tok("muted-foreground")} />
				<input
					value={query()}
					placeholder="Find in document"
					onChange={(e) => onQuery((e as { value?: string }).value ?? "")}
					onSubmit={() => step(1)}
					onKeyDown={(e) => { const k = e as { key?: string; modifiers?: { shift?: boolean } }; if (k.key === "enter" && k.modifiers?.shift) { step(-1); } }}
					style={{ flexGrow: 1, minWidth: 0, height: 26, paddingLeft: 6, paddingRight: 4, fontSize: 12, fontFamily: "Inter", color: tok("foreground") }}
					theme={inputTheme()}
				/>
				<div style={{ ...t("flex flex-none items-center justify-center"), width: 76 }}>
					<text style={{ ...tx("text-[11px] text-muted-foreground"), whiteSpace: "nowrap" }}>{searchCount()}</text>
				</div>
			</div>
			<IconButton icon="chevron-up" title="Previous match" mode={mode} disabled={hits().length === 0} onClick={() => step(-1)} />
			<IconButton icon="chevron-down" title="Next match" mode={mode} disabled={hits().length === 0} onClick={() => step(1)} />
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

	return (
		<div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", flexGrow: 1, minHeight: 0, minWidth: 0, backgroundColor: tok("muted") }}>
			<Show when={active()} fallback={<div style={{ flexGrow: 1 }} />}>
				<Show when={props.showToolbar !== false}>{toolbar()}</Show>
				<Show
					when={doc()}
					fallback={
						<Show when={error()} fallback={message("loader-circle", loading() ? "Opening PDF…" : "")}>
							{message("file-warning", error() ?? "", true)}
						</Show>
					}
				>
					<div
						ref={(el: { id: number }) => { hbox = el; }}
						onLayout={onViewport}
						style={{ display: "flex", flexDirection: "row", flexGrow: 1, minHeight: 0, width: "100%", overflowX: "scroll" }}
					>
					<div style={{ display: "flex", flexDirection: "column", flexShrink: 0, width: innerWidth(), height: "100%" }}>
						<virtual-list
							ref={onListRef}
							testId="reader-pages"
							itemCount={count()}
							windowStart={first()}
							estimatedItemHeight={estimate()}
							overdraw={300}
							onVisibleRange={onVisibleRange}
							style={{ width: "100%", flexGrow: 1, minHeight: 0 }}
						>
							<For each={indices()}>
								{(i) => (
									<div style={{ display: "flex", flexDirection: "row", justifyContent: "center", width: "100%", paddingTop: rowPad(i)[0], paddingBottom: rowPad(i)[1] }}>
										<PageSlot
											doc={doc()!}
											index={i}
											width={() => pageWidth(i)}
											dpr={dpr}
											stats={stats}
											pending={pending}
											mountedCount={mountedCount}
											hits={() => hitsByPage().get(i) ?? []}
											currentHit={cur}
											debugWords={() => props.debugWords ?? false}
											near={() => i >= Math.floor(vis()[0]) - 1 && i <= Math.ceil(vis()[1])}
										/>
									</div>
								)}
							</For>
						</virtual-list>
					</div>
					</div>
				</Show>
			</Show>
		</div>
	);
}
