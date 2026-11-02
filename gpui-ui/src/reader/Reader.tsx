// Native PDF reader spike: pages are rasterized by hayro (native/pdf, via bun:ffi) and shown as <img> in a windowed GPUIX
// <virtual-list>. Only a small window of pages is mounted; a page that scrolls out of the window is unmounted (its bitmap
// is dropped by GPUIX), a page that scrolls in is rendered on the worker thread and pushed with setImagePixels (BGRA,
// zero-copy from Rust memory into the upload). Zoom re-renders at DPR x zoom (debounced) and keeps the old bitmap on screen
// (stretched) until the new one lands. Highlights come from the text layer: word rects normalised 0..1 of the page.
//
// Self-contained on purpose (own colours, no store/theme imports) so it can be dropped into any window.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack, type Accessor, type JSX } from "solid-js";
import { useGpuix } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/solid";
import { PdfDoc, type RenderTask, type TextLayer, type TextWord } from "./pdf";

const GAP = 10; // vertical gap between page slots
const C = { bg: "#2a2a2f", bar: "#1b1b1f", text: "#e6e6ea", dim: "#9a9aa6", btn: "#34343b", page: "#ffffff" };

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

export interface ReaderController {
	doc: PdfDoc;
	stats: ReaderStats;
	zoom: Accessor<number>;
	setZoom(z: number): void;
	scrollToPage(i: number): void;
	/** pages currently mounted (their <img> exists) */
	mounted(): number;
	/** [first, last] page index visible (fractional first) */
	visible(): [number, number];
	/** resolves when no render is queued or running */
	idle(): Promise<void>;
}

export interface ReaderProps {
	/** open this file (the Reader owns and closes the document) ... */
	path?: string;
	/** ... or use an already open one (the caller closes it) */
	doc?: PdfDoc;
	/** window width the pages are fitted to at zoom 1 (the list is as wide as the window) */
	viewportWidth?: number;
	/** device pixel ratio the bitmaps are rendered for */
	dpr?: number;
	zoom?: number;
	/** pages mounted at once (default 7: the visible ones plus a margin; 1 keeps a single page) */
	window?: number;
	/** highlight every word containing this text (case-insensitive) */
	highlight?: string;
	/** outline every word rect of the text layer (geometry check) */
	debugWords?: boolean;
	showToolbar?: boolean;
	controller?: (c: ReaderController) => void;
}

/** One page: the <img> the bitmap goes into, plus the highlight overlay. */
function PageSlot(p: {
	doc: PdfDoc;
	index: number;
	width: Accessor<number>;
	dpr: number;
	stats: ReaderStats;
	pending: { n: number };
	mountedCount: { n: number; set(): void };
	highlight: Accessor<string>;
	debugWords: Accessor<boolean>;
	/** true while this page is within one page of the viewport: those render first, the rest of the window waits a bit */
	near: Accessor<boolean>;
}): JSX.Element {
	const [pw, ph] = p.doc.sizes[p.index]!;
	const height = () => (p.width() * ph) / pw;
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
		const t = p.doc.render(p.index, scale);
		task = t;
		try {
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
			console.error(`[reader] page ${p.index}:`, e instanceof Error ? e.message : e);
		} finally {
			p.pending.n--;
		}
	}

	// (re)render whenever the target bitmap width changes: at once the first time, debounced after a zoom change
	createEffect(on(() => Math.max(16, Math.round(p.width() * p.dpr)), (pxW, prev) => {
		const my = ++gen;
		if (task) { task.cancel(); p.stats.cancelled++; }
		clearTimeout(timer);
		const delay = (prev === undefined ? 0 : 140) + (untrack(p.near) ? 0 : 300);
		if (delay === 0) void run(my, pxW);
		else timer = setTimeout(() => void run(my, pxW), delay);
	}));

	// text layer: fetched lazily, only when something needs it
	const [layer, setLayer] = createSignal<TextLayer | null>(null);
	createEffect(() => {
		const need = p.highlight().trim() !== "" || p.debugWords();
		if (!need || untrack(layer)) return;
		void p.doc.textLayerAsync(p.index).then((l) => { if (alive) setLayer(l); }).catch((e) => console.error("[reader] text layer:", e));
	});
	const hits = createMemo<TextWord[]>(() => {
		const l = layer();
		const q = p.highlight().trim().toLowerCase();
		if (!l) return [];
		if (p.debugWords()) return l.words;
		return q ? l.words.filter((w) => w.t.toLowerCase().includes(q)) : [];
	});

	return (
		<div style={{ position: "relative", width: p.width(), height: height(), flexShrink: 0, backgroundColor: C.page }}>
			<img
				ref={(el) => { img = el as never; }}
				objectFit="fill"
				style={{ position: "absolute", left: 0, top: 0, width: p.width(), height: height() }}
			/>
			<For each={hits()}>
				{(w) => (
					<div
						style={p.debugWords()
							? { position: "absolute", left: w.x * p.width(), top: w.y * height(), width: w.w * p.width(), height: w.h * height(), borderWidth: 1, borderColor: "#e5484d", backgroundColor: "#e5484d1f" }
							: { position: "absolute", left: w.x * p.width(), top: w.y * height(), width: w.w * p.width(), height: w.h * height(), backgroundColor: "#ffd60066", borderRadius: 2 }}
					/>
				)}
			</For>
		</div>
	);
}

function ToolButton(p: { label: string; onClick: () => void }): JSX.Element {
	return (
		<div
			onClick={p.onClick}
			style={{ width: 28, height: 24, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, backgroundColor: C.btn, cursor: "pointer" }}
		>
			<text style={{ color: C.text, fontSize: 15 }}>{p.label}</text>
		</div>
	);
}

export function Reader(props: ReaderProps): JSX.Element {
	const gpuix = useGpuix();
	const owned = props.doc == null;
	const doc = props.doc ?? PdfDoc.open(props.path!);
	onCleanup(() => { if (owned) doc.close(); });

	const dpr = props.dpr ?? 1;
	const WINDOW = Math.max(1, props.window ?? 7);
	const vw = props.viewportWidth ?? 1000;
	const [zoom, setZoomRaw] = createSignal(props.zoom ?? 1);
	const width = () => Math.round((vw - 48) * zoom());
	const setZoom = (z: number) => setZoomRaw(Math.min(4, Math.max(0.5, Math.round(z * 100) / 100)));

	const stats: ReaderStats = { renders: 0, lastRenderMs: 0, lastUploadMs: 0, totalRenderMs: 0, peakMounted: 0, cancelled: 0 };
	const pending = { n: 0 };
	const [mountedN, setMountedN] = createSignal(0);
	const mountedCount = {
		n: 0,
		set() { stats.peakMounted = Math.max(stats.peakMounted, this.n); queueMicrotask(() => setMountedN(this.n)); },
	};

	const count = doc.pageCount;
	const estimate = () => {
		let sum = 0;
		const n = Math.min(count, 20);
		for (let i = 0; i < n; i++) sum += (width() * doc.sizes[i]![1]) / doc.sizes[i]![0];
		return Math.round(sum / Math.max(1, n)) + GAP;
	};

	const [start, setStart] = createSignal(0);
	const first = createMemo(() => Math.max(0, Math.min(start(), count - WINDOW)));
	const indices = createMemo(() => {
		const s = first(), e = Math.min(count, s + WINDOW);
		return Array.from({ length: Math.max(0, e - s) }, (_, i) => s + i);
	});
	const [vis, setVis] = createSignal<[number, number]>([0, 1]);
	const margin = Math.max(1, Math.floor(WINDOW / 4));
	const onVisibleRange = (e: EventPayload) => {
		const a = e.startIndex ?? 0, b = e.endIndex ?? a + 1;
		setVis([a, b]);
		const s = untrack(first);
		const span = Math.ceil(b) - Math.floor(a);
		if ((Math.floor(a) < s + margin && s > 0) || Math.ceil(b) > s + WINDOW - margin) {
			setStart(Math.max(0, Math.floor(a) - Math.max(0, Math.floor((WINDOW - span) / 2))));
		}
	};

	let list: { id: number } | undefined;
	const scrollToPage = (i: number) => {
		const idx = Math.max(0, Math.min(count - 1, i));
		setStart(Math.max(0, idx - Math.floor(WINDOW / 4)));
		gpuix?.renderer.scrollToItem?.(list!.id, idx, 0);
	};

	// keep the same page at the top across a zoom change (row heights all change)
	createEffect(on(zoom, () => {
		const top = Math.floor(untrack(vis)[0]);
		queueMicrotask(() => { if (list && top > 0) gpuix?.renderer.scrollToItem?.(list.id, top, 0); });
	}, { defer: true }));

	props.controller?.({
		doc, stats, zoom, setZoom, scrollToPage,
		mounted: () => mountedCount.n,
		visible: () => vis(),
		idle: async () => { while (pending.n > 0) await Bun.sleep(5); },
	});

	const highlight = () => props.highlight ?? "";
	const debugWords = () => props.debugWords ?? false;
	const status = createMemo(() => `${mountedN()} pages mounted`);

	return (
		<div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.bg }}>
			<Show when={props.showToolbar !== false}>
				<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8, height: 36, flexShrink: 0, paddingLeft: 12, paddingRight: 12, backgroundColor: C.bar }}>
					<ToolButton label="-" onClick={() => setZoom(zoom() - 0.25)} />
					<text style={{ color: C.text, fontSize: 13, width: 44 }}>{`${Math.round(zoom() * 100)}%`}</text>
					<ToolButton label="+" onClick={() => setZoom(zoom() + 0.25)} />
					<text style={{ color: C.dim, fontSize: 13 }}>{`page ${Math.min(count, Math.floor(vis()[0]) + 1)} / ${count}`}</text>
					<div style={{ flexGrow: 1 }} />
					<text style={{ color: C.dim, fontSize: 12 }}>{status()}</text>
				</div>
			</Show>
			<virtual-list
				ref={(el: { id: number }) => { list = el; }}
				testId="reader-pages"
				itemCount={count}
				windowStart={first()}
				estimatedItemHeight={estimate()}
				overdraw={300}
				onVisibleRange={onVisibleRange}
				style={{ width: "100%", flexGrow: 1, minHeight: 0 }}
			>
				<For each={indices()}>
					{(i) => (
						<div style={{ display: "flex", flexDirection: "row", width: "100%", paddingTop: GAP, paddingLeft: Math.max(8, Math.round((vw - width()) / 2)) }}>
							<PageSlot
								doc={doc}
								index={i}
								width={width}
								dpr={dpr}
								stats={stats}
								pending={pending}
								mountedCount={mountedCount}
								highlight={highlight}
								debugWords={debugWords}
								near={() => i >= Math.floor(vis()[0]) - 1 && i <= Math.ceil(vis()[1])}
							/>
						</div>
					)}
				</For>
			</virtual-list>
		</div>
	);
}
