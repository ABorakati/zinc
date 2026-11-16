// One page of the reader: a box of the page's size with the rasterized tiles in it, the search / selection washes, the link hot
// zones and the plugins' overlays.
//
// MEMORY MODEL. A page is not one bitmap held forever. Its pixels (page size x zoom x device pixel ratio) are cut into tiles
// (bands, or a grid when the page is wide), and only the tiles that touch the viewport or sit in a margin ahead of it (the
// direction the reader is scrolling in) exist as images; the rest of the page is the paper colour. Scrolling creates the
// tiles that come into the margin and destroys the ones that leave it (after a grace distance, so a small reversal does not
// thrash), so the cost of an open PDF is the size of the viewport plus the margin, whatever the page count or the zoom (a 6x
// zoom is a few more small tiles, not a 500 MB page). Pixels are handed to GPUIX once (setImagePixels copies them into its own
// image) and the native buffer is freed on the spot: the JS side never keeps a copy.
//
// LATENCY MODEL. Rendering is queued natively (native/pdf: a pool of worker threads over one priority queue). Every job carries a
// priority (0 tiles that touch the viewport, 1e6 tiles in the margin ahead, 2e6 behind; within a band: nearest to the viewport
// centre first), and the reader re-sets the priorities of the waiting jobs whenever the scroll position changes, so the
// worker that frees up always renders what the screen needs most. A tile that is destroyed before a worker took its job is
// cancelled. A single-column page of a moderate size is rasterized by ONE job and cut into its band tiles (hayro walks the whole
// content stream for every job, so a page drawn as three tiles pays three interpretations: dense figures took ~300 ms each).
//
// NO "img: no src". An <img> without pixels paints as a dark box with that text, and a tile cannot get pixels before its host node
// exists, so every tile (and the page preview) is created hidden (core/pixels.ts) and shown by the step that sets its pixels; until
// then the page's own paper colour (and, once rendered, its low-resolution preview) shows through.
//
// PREVIEWS (core/preview.ts). Under the tiles, a page shows its whole-page low-resolution preview (a fifth of the sharp resolution,
// kept in a cache that outlives the page component and fed for the pages AHEAD of the reader), so a tile that is still in the queue
// leaves a blurry page and not a hole.
//
// A zoom or resize does not blank the page: the tiles of the old resolution stay, stretched to the new box, until the new
// ones that cover the viewport are ready (the new ones are requested after a short debounce).
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack, type Accessor, type JSX } from "solid-js";
import type { Look, PdfDoc, RenderTask } from "../pdf";
import type { NRect } from "../plugins";
import { lookKey } from "./appearance";
import type { Scheduler } from "./scheduler";
import { HIDE_UNTIL_PIXELS, hiddenUntil, type ImgNode, whenMounted } from "./pixels";
import type { Previews } from "./preview";
import { rotRect } from "./text";

export const MAX_TILE = 800; // device px per tile edge when a page needs several
const SINGLE_COL_MAX = 2400; // a page up to this wide (device px) is one column of tiles, whatever its width
const WHOLE_BAND = 512; // band height (device px) of a whole-page job: finer than MAX_TILE because cutting a bitmap is free and GPUIX keeps ~4x the pixel bytes of every live image
const WHOLE_MAX_PX = 6_000_000; // a single-column page up to this many device px is rasterized by one job and cut into bands
const MARGIN_X = 48;
const ZOOM_DEBOUNCE = 140;

/** Queue priorities (lower runs first). The native side also uses 5e6+ for text layers, links and the outline. */
export const PRIO_VISIBLE = 0;
export const PRIO_AHEAD = 1e6;
export const PRIO_BEHIND = 2e6;
export const PRIO_BACKGROUND = 4e6;

export interface ViewRect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}
export interface LinkInfo {
	rect: NRect;
	target: { kind: "page"; page: number; y: number } | { kind: "uri"; uri: string };
}

export interface PageStats {
	renders: number;
	lastRenderMs: number;
	lastUploadMs: number;
	totalRenderMs: number;
	cancelled: number;
	tiles: number;
	peakTiles: number;
	/** per-job breakdown sums (ms): waiting in the native queue + the poll delay, waiting for the <img> host node, handing the pixels to GPUIX; and the job count */
	jobs?: number;
	queueMs?: number;
	mountWaitMs?: number;
	uploadMs?: number;
}

/**
 * How far around the viewport (css px) tiles are rendered ahead of time. `up` / `down` are the margins above / below it (the one in
 * the scroll direction is the long one), `keep` the extra distance a tile survives outside its margin, `ahead` the direction (1 down, -1 up).
 * `axis` "x" (horizontal scrolling): the same margins lie left / right of the viewport instead (up = left, down = right).
 */
export interface Margins {
	up: number;
	down: number;
	keep: number;
	ahead: number;
	axis?: "x" | "y";
}

export interface PageEnv {
	doc: PdfDoc;
	sched: Scheduler;
	dpr: Accessor<number>;
	look: Accessor<Look>;
	paper: Accessor<string>;
	stats: PageStats;
	/** bumped when a tile finished, for scripts waiting for idle */
	pending: { n: number };
	/** window-space bookkeeping for hit-testing: the page box and every tile image register here */
	reg: { boxes: Map<number, { id: number }> };
	/** every mounted page registers a coverage probe here (benchmarks: what part of the visible page shows pixels, and how sharp) */
	probe: Map<number, PageProbe>;
	margins: Accessor<Margins>;
	/** false until the viewport has a size and the list a scroll position: nothing is rendered before (the first layout is a throw-away guess) */
	laidOut: Accessor<boolean>;
	/** priority updaters of the live render jobs; the reader calls them all when the scroll position moved */
	jobs: Set<() => void>;
	/** whole-page low-resolution previews of this document (shown under the tiles) */
	previews?: Previews;
	/** recently rendered whole-page bitmaps (band tiles that appear later are cut out of them) */
	bitmaps?: BitmapCache;
}

type Bitmap = NonNullable<Awaited<RenderTask["promise"]>>;
interface BitmapEntry {
	key: string;
	page: number;
	r: Bitmap;
	uses: number;
	doomed: boolean;
}

/**
 * The most recently rendered whole-page bitmaps (native memory, BGRA, ~7.7 MB for a Letter page at DPR 2), kept so that a band tile that
 * turns up AFTER the page was rendered (the reader scrolled on, or back) is cut out of it instead of costing another interpretation of
 * the whole content stream (hayro and PDFium walk all of it for every job: a 30 MB scatter plot page takes 0.4-1 s EVERY time, a normal
 * page 5-20 ms times the 3-4 bands of the page). GPUIX keeps its own copy of what it was given, so this is extra native memory: the
 * budget bounds it (default 24 MB; ZN_BITMAP_MB). An entry that is being cut when it is evicted is freed afterwards.
 */
export class BitmapCache {
	private map = new Map<string, BitmapEntry>();
	bytes = 0;
	constructor(readonly budget = (Number(process.env.ZN_BITMAP_MB) || 24) * 1048576) {}
	get size(): number {
		return this.map.size;
	}
	/** takes ownership of `r`; the caller holds one use of the returned entry and must call unuse() */
	put(key: string, page: number, r: Bitmap): BitmapEntry {
		const e: BitmapEntry = { key, page, r, uses: 1, doomed: false };
		if (this.budget <= 0) {
			e.doomed = true;
			return e;
		}
		for (const o of [...this.map.values()]) if (o.page === page) this.drop(o); // an older resolution / look of the same page
		const len = r.pixels.length;
		while (this.map.size && this.bytes + len > this.budget) this.drop(this.map.values().next().value!);
		this.map.set(key, e);
		this.bytes += len;
		return e;
	}
	acquire(key: string): BitmapEntry | undefined {
		const e = this.map.get(key);
		if (!e) return undefined;
		this.map.delete(key);
		this.map.set(key, e); // most recently used last
		e.uses++;
		return e;
	}
	unuse(e: BitmapEntry): void {
		if (--e.uses <= 0 && e.doomed) e.r.release();
	}
	private drop(e: BitmapEntry): void {
		this.map.delete(e.key);
		this.bytes -= e.r.pixels.length;
		e.doomed = true;
		if (e.uses <= 0) e.r.release();
	}
	clear(): void {
		for (const e of [...this.map.values()]) this.drop(e);
	}
}

/** Fractions (0..1) of the part of the page inside `view` that is blank paper, shows a stretched / lower resolution image, or is sharp; `vis` is the visible area in css px^2. */
export type PageProbe = (view: ViewRect) => { vis: number; blank: number; soft: number; sharp: number; noSrc: number };

interface TileSpec {
	key: string;
	sk: string;
	x: number;
	y: number;
	w: number;
	h: number;
	W: number;
	H: number;
	scale: number;
	rot: number;
	look: Look;
	/** part of a whole-page job (cut out of one bitmap) rather than a job of its own */
	whole: boolean;
	ready: Accessor<boolean>;
	setReady(v: boolean): void;
	/** 0: touches the viewport, 1: margin ahead, 2: margin behind */
	tier: Accessor<number>;
	setTier(v: number): void;
	img?: ImgNode;
	alive: boolean;
	/** being cut out of a cached bitmap right now */
	busy?: boolean;
}

interface Grid {
	sk: string;
	W: number;
	H: number;
	scale: number;
	rot: number;
	look: Look;
	cols: number;
	rows: number;
	TW: number;
	TH: number;
	whole: boolean;
}

/** A render job in flight and the tiles waiting for it. */
interface Inflight {
	key: string;
	tiles: Set<TileSpec>;
	task: RenderTask | null;
	update(): void;
}

function TileView(p: {
	env: PageEnv;
	spec: TileSpec;
	boxW: Accessor<number>;
	boxH: Accessor<number>;
	onGone(t: TileSpec): void;
}): JSX.Element {
	const { env, spec } = p;
	env.stats.tiles++;
	env.stats.peakTiles = Math.max(env.stats.peakTiles, env.stats.tiles);
	onCleanup(() => {
		spec.alive = false;
		env.stats.tiles--;
		p.onGone(spec);
	});
	// css box of the tile inside the page box (rounded outwards so neighbours never leave a seam)
	const geo = () => {
		const kx = p.boxW() / spec.W,
			ky = p.boxH() / spec.H;
		const l = Math.floor(spec.x * kx),
			t = Math.floor(spec.y * ky);
		return { left: l, top: t, width: Math.ceil((spec.x + spec.w) * kx) - l, height: Math.ceil((spec.y + spec.h) * ky) - t };
	};
	return (
		<img
			ref={(el: ImgNode) => {
				spec.img = el;
			}}
			objectFit="fill"
			style={{ position: "absolute", pointerEvents: "none", ...geo(), ...hiddenUntil(spec.ready()) }}
		/>
	);
}

/** The page's preview: one image over the whole page box, hidden until it has its pixels. */
function PreviewImg(p: {
	data: { w: number; h: number; px: Uint8Array };
	boxW: Accessor<number>;
	boxH: Accessor<number>;
	onShown(v: boolean): void;
}): JSX.Element {
	let img: ImgNode | undefined;
	let alive = true;
	const [ready, setReady] = createSignal(false);
	onCleanup(() => {
		alive = false;
		p.onShown(false);
	});
	void (async () => {
		if (
			!(await whenMounted(
				() => img,
				() => alive,
			)) ||
			!img
		)
			return;
		img.setImagePixels(p.data.w, p.data.h, p.data.px, { format: "bgra" });
		setReady(true);
		p.onShown(true);
	})();
	return (
		<img
			ref={(el: ImgNode) => {
				img = el;
			}}
			objectFit="fill"
			style={{
				position: "absolute",
				left: 0,
				top: 0,
				width: p.boxW(),
				height: p.boxH(),
				pointerEvents: "none",
				...hiddenUntil(ready()),
			}}
		/>
	);
}

export function PageSlot(p: {
	env: PageEnv;
	index: number;
	/** displayed page box in css px (zoom and rotation applied) */
	boxW: Accessor<number>;
	boxH: Accessor<number>;
	rot: Accessor<number>;
	/** the viewport in this page's css coordinates (origin: page top-left) */
	view: Accessor<ViewRect>;
	hits: Accessor<{ rects: NRect[]; id: number }[]>;
	currentHit: Accessor<number>;
	/** selection washes, unrotated page space */
	selection: Accessor<NRect[]>;
	links: Accessor<LinkInfo[]>;
	onLink(link: LinkInfo, e: { x?: number; y?: number }): void;
	/** plugins' overlays for this page (already wrapped to the page box) */
	overlays: () => JSX.Element;
	debugWords: Accessor<NRect[] | null>;
	selColor: Accessor<string>;
	hitColor: string;
	hitCurColor: string;
}): JSX.Element {
	const { env } = p;
	const [pw, ph] = env.doc.sizes[p.index]!;

	// ---- resolution: follows the box, debounced after the first render so a zoom gesture does not render every step
	const wantW = () => Math.max(16, Math.round(p.boxW() * env.dpr()));
	const [renderW, setRenderW] = createSignal(untrack(wantW));
	let zt: ReturnType<typeof setTimeout> | undefined;
	let first = true;
	createEffect(() => {
		const w = wantW();
		if (first) {
			first = false;
			return;
		}
		clearTimeout(zt);
		zt = setTimeout(() => setRenderW(w), ZOOM_DEBOUNCE);
	});
	onCleanup(() => clearTimeout(zt));

	const grid = createMemo<Grid>(() => {
		const rot = p.rot(),
			look = env.look();
		const base = rot % 180 === 0 ? pw : ph;
		const scale = renderW() / base;
		const [W, H] = env.doc.renderSize2(p.index, scale, rot);
		const cols = W <= SINGLE_COL_MAX ? 1 : Math.ceil(W / MAX_TILE);
		const whole = cols === 1 && W * H <= WHOLE_MAX_PX;
		const rows = Math.max(1, Math.ceil(H / (whole ? WHOLE_BAND : MAX_TILE)));
		return {
			sk: `${W}x${H}.${rot}.${lookKey(look)}`,
			W,
			H,
			scale,
			rot,
			look,
			cols,
			rows,
			TW: Math.ceil(W / cols),
			TH: Math.ceil(H / rows),
			whole,
		};
	});

	/**
	 * Tiles of the current grid worth having: zone 0 touches the viewport, 1 is inside the margin (created, rendered), 2 only inside
	 * the keep distance (an existing tile stays, a missing one is not created).
	 */
	interface Want {
		key: string;
		c: number;
		r: number;
		tier: number;
		zone: number;
	}
	const wanted = createMemo(
		() => {
			const g = grid(),
				v = p.view(),
				m = env.margins();
			if (!env.laidOut()) return [];
			const kx = g.W / p.boxW(),
				ky = g.H / p.boxH(); // css -> device px
			const ix0 = v.x0 * kx,
				ix1 = v.x1 * kx,
				iy0 = v.y0 * ky,
				iy1 = v.y1 * ky;
			// zoomed in (a grid of tiles, every tile re-interprets the page) the margins are shorter: the pixel bytes per css px are far higher
			const f = g.whole ? 1 : 0.25;
			const xa = m.axis === "x"; // scrolling horizontally: the long margins are left / right
			const wx0 = (v.x0 - (xa ? m.up * f : MARGIN_X)) * kx,
				wx1 = (v.x1 + (xa ? m.down * f : MARGIN_X)) * kx;
			const wy0 = (v.y0 - (xa ? MARGIN_X : m.up * f)) * ky,
				wy1 = (v.y1 + (xa ? MARGIN_X : m.down * f)) * ky;
			const kp = (xa ? MARGIN_X : m.keep * f) * ky,
				kpx = (xa ? m.keep * f : MARGIN_X) * kx;
			const out: Want[] = [];
			// nothing of this page is near enough to matter
			if (wy1 + kp <= 0 || wy0 - kp >= g.H || wx1 + kpx <= 0 || wx0 - kpx >= g.W) return out;
			const c0 = Math.max(0, Math.floor((wx0 - kpx) / g.TW)),
				c1 = Math.min(g.cols - 1, Math.floor((wx1 + kpx - 1) / g.TW));
			const r0 = Math.max(0, Math.floor((wy0 - kp) / g.TH)),
				r1 = Math.min(g.rows - 1, Math.floor((wy1 + kp - 1) / g.TH));
			for (let r = r0; r <= r1; r++) {
				for (let c = c0; c <= c1; c++) {
					const tx0 = c * g.TW,
						tx1 = tx0 + g.TW,
						ty0 = r * g.TH,
						ty1 = ty0 + g.TH;
					const inside = tx1 > ix0 && tx0 < ix1 && ty1 > iy0 && ty0 < iy1;
					const near = tx1 > wx0 && tx0 < wx1 && ty1 > wy0 && ty0 < wy1;
					const kept = tx1 > wx0 - kpx && tx0 < wx1 + kpx && ty1 > wy0 - kp && ty0 < wy1 + kp;
					const zone = inside ? 0 : near ? 1 : kept ? 2 : 3;
					if (zone === 3) continue;
					const below = xa ? tx0 >= ix1 : ty0 >= iy1;
					const tier = inside ? 0 : below ? (m.ahead >= 0 ? 1 : 2) : m.ahead < 0 ? 1 : 2;
					out.push({ key: `${g.sk}:${c}:${r}`, c, r, tier, zone });
				}
			}
			return out;
		},
		undefined,
		{
			equals: (a, b) =>
				a.length === b.length && a.every((t, i) => t.key === b[i]!.key && t.tier === b[i]!.tier && t.zone === b[i]!.zone),
		},
	);

	// ---- preview under the tiles
	const [pvShown, setPvShown] = createSignal(false);
	const pv = createMemo(() => env.previews?.get(p.index, p.rot()));

	// ---- tile set
	const [tiles, setTiles] = createSignal<TileSpec[]>([]);
	const [tick, setTick] = createSignal(0);
	const make = (g: Grid, c: number, r: number, key: string, tier: number): TileSpec => {
		const [ready, setReady] = createSignal(false);
		const [t, setT] = createSignal(tier);
		const x = c * g.TW,
			y = r * g.TH;
		return {
			key,
			sk: g.sk,
			x,
			y,
			w: Math.min(g.TW, g.W - x),
			h: Math.min(g.TH, g.H - y),
			W: g.W,
			H: g.H,
			scale: g.scale,
			rot: g.rot,
			look: g.look,
			whole: g.whole,
			ready,
			setReady,
			tier: t,
			setTier: setT,
			alive: true,
		};
	};
	createEffect(() => {
		const g = grid(),
			want = wanted();
		tick();
		untrack(() => {
			const cur = tiles();
			const byKey = new Map(cur.map((t) => [t.key, t]));
			const fresh: TileSpec[] = [];
			for (const w of want) {
				const old = byKey.get(w.key);
				if (old) {
					if (old.tier() !== w.tier) old.setTier(w.tier);
					fresh.push(old);
				} else if (w.zone <= 1) fresh.push(make(g, w.c, w.r, w.key, w.tier));
			}
			// older resolutions stay (under the new tiles) until everything on screen is redrawn at the new one; only drawn ones are worth keeping
			const covered = fresh.every((t) => t.tier() !== 0 || t.ready());
			const stale = covered ? [] : cur.filter((t) => t.sk !== g.sk && t.ready());
			const next = [...stale, ...fresh];
			if (next.length === cur.length && next.every((t, i) => t === cur[i])) return;
			setTiles(next);
		});
	});

	const dist = (s: TileSpec): number => {
		const v = untrack(p.view);
		const bh = untrack(p.boxH);
		const cy = ((s.y + s.h / 2) / s.H) * bh,
			vy = (v.y0 + v.y1) / 2;
		if (untrack(env.margins).axis === "x") {
			// scrolling horizontally the pages ahead are to the side: distance along x first, then within the page
			const cx = ((s.x + s.w / 2) / s.W) * untrack(p.boxW),
				vx = (v.x0 + v.x1) / 2;
			return Math.abs(cx - vx) + Math.abs(cy - vy);
		}
		return Math.abs(cy - vy);
	};

	// ---- rendering: the tiles that exist and are not drawn get a job (one per tile, or one for the whole page)
	const inflight = new Map<string, Inflight>();
	const BANDS = [PRIO_VISIBLE, PRIO_AHEAD, PRIO_BEHIND];
	const prioOf = (inf: Inflight): number => {
		let best = Infinity;
		for (const t of inf.tiles) best = Math.min(best, BANDS[t.tier()]! + dist(t));
		return Number.isFinite(best) ? best : PRIO_BEHIND;
	};
	const bitmaps = env.bitmaps ?? new BitmapCache(0);
	const bmKey = (sk: string) => p.index + "|" + sk;
	/** hand the tiles their pixels, the ones the reader sees first before the others */
	async function uploadTiles(list: Iterable<TileSpec>, r: Bitmap): Promise<void> {
		const order = [...list].sort((a, b) => a.tier() - b.tier() || dist(a) - dist(b));
		for (const t of order) {
			if (t.ready()) continue;
			// the element may not be inserted yet right after mount: wait for it (a few frames at most)
			const m0 = performance.now();
			if (
				!(await whenMounted(
					() => t.img,
					() => t.alive,
				)) ||
				!t.img
			)
				continue;
			const u0 = performance.now();
			env.stats.mountWaitMs = (env.stats.mountWaitMs ?? 0) + (u0 - m0);
			if (t.whole) t.img.setImagePixels(r.width, t.h, r.slice(t.y, t.h), { format: "bgra" });
			else t.img.setImagePixels(r.width, r.height, r.pixels, { format: "bgra" });
			env.stats.lastUploadMs = performance.now() - u0;
			env.stats.uploadMs = (env.stats.uploadMs ?? 0) + env.stats.lastUploadMs;
			t.setReady(true);
		}
	}
	function startJob(key: string, first: TileSpec): void {
		const inf: Inflight = { key, tiles: new Set([first]), task: null, update: () => {} };
		inflight.set(key, inf);
		env.pending.n++;
		let task: RenderTask;
		try {
			task = env.doc.render3(p.index, first.scale, {
				rot: first.rot,
				look: first.look,
				region: first.whole ? undefined : { x: first.x, y: first.y, w: first.w, h: first.h },
				prio: prioOf(inf),
			});
		} catch (e) {
			inflight.delete(key);
			env.pending.n--;
			if (first.alive) console.error(`[reader] page ${p.index} tile:`, e instanceof Error ? e.message : e);
			return;
		}
		inf.task = task;
		const tReq = performance.now();
		inf.update = () => task.setPrio(prioOf(inf));
		env.jobs.add(inf.update);
		void (async () => {
			try {
				const r = await task.promise;
				if (!r) return;
				env.stats.jobs = (env.stats.jobs ?? 0) + 1;
				env.stats.queueMs = (env.stats.queueMs ?? 0) + Math.max(0, performance.now() - tReq - r.renderMs);
				// a whole-page bitmap stays in the cache (band tiles that appear later are cut out of it), a region is freed once uploaded
				const entry = first.whole ? bitmaps.put(bmKey(first.sk), p.index, r) : null;
				try {
					if (inf.tiles.size) {
						await uploadTiles(inf.tiles, r);
						env.stats.renders++;
						env.stats.lastRenderMs = r.renderMs;
						env.stats.totalRenderMs += r.renderMs;
						setTick((n) => n + 1);
					}
				} finally {
					if (entry) bitmaps.unuse(entry);
					else r.release();
				} // GPUIX holds its own copy of what it got
			} catch (e) {
				console.error(`[reader] page ${p.index} tile:`, e instanceof Error ? e.message : e);
			} finally {
				env.jobs.delete(inf.update);
				if (inflight.get(key) === inf) inflight.delete(key);
				env.pending.n--;
				// a tile that appeared while the bitmap was being uploaded: it is cut out of the cached bitmap
				if (inf.tiles.size) untrack(() => ensureJobs(tiles()));
			}
		})();
	}
	function ensureJobs(list: TileSpec[]): void {
		for (const t of list) {
			if (t.ready() || t.busy || !t.alive || t.sk !== untrack(grid).sk) continue;
			const key = t.whole ? t.sk : t.key;
			const inf = inflight.get(key);
			if (inf) {
				if (!inf.tiles.has(t)) inf.tiles.add(t);
				continue;
			}
			const cached = t.whole ? bitmaps.acquire(bmKey(t.sk)) : undefined;
			if (cached) {
				t.busy = true;
				void uploadTiles([t], cached.r).finally(() => {
					t.busy = false;
					bitmaps.unuse(cached);
				});
			} else startJob(key, t);
		}
	}
	createEffect(() => {
		const list = tiles();
		untrack(() => ensureJobs(list));
	});
	/** a tile element went away: drop it from its job; a job nobody waits for any more is cancelled (a no-op once a worker took it) */
	function onGone(t: TileSpec): void {
		for (const inf of inflight.values()) {
			if (!inf.tiles.delete(t) || inf.tiles.size) continue;
			inf.task?.cancel();
			env.stats.cancelled++;
			if (inflight.get(inf.key) === inf) inflight.delete(inf.key);
		}
	}
	onCleanup(() => {
		for (const inf of inflight.values()) {
			inf.tiles.clear();
			inf.task?.cancel();
		}
		inflight.clear();
	});

	// ---- coverage probe (benchmarks only; costs nothing unless called)
	p.env.probe.set(p.index, (v) => {
		const bw = untrack(p.boxW),
			bh = untrack(p.boxH);
		const x0 = Math.max(0, v.x0),
			x1 = Math.min(bw, v.x1),
			y0 = Math.max(0, v.y0),
			y1 = Math.min(bh, v.y1);
		if (x1 <= x0 || y1 <= y0) return { vis: 0, blank: 0, soft: 0, sharp: 0, noSrc: 0 };
		const sk = untrack(grid).sk;
		const all = untrack(tiles);
		const ts = all.filter((t) => untrack(t.ready));
		// tiles that exist natively, intersect the view and would paint GPUIX's "img: no src" box (never with hidden-until-pixels images)
		let noSrc = 0;
		if (!HIDE_UNTIL_PIXELS) {
			for (const t of all) {
				if (untrack(t.ready) || !t.img?.mounted) continue;
				if (((t.x + t.w) / t.W) * bw > x0 && (t.x / t.W) * bw < x1 && ((t.y + t.h) / t.H) * bh > y0 && (t.y / t.H) * bh < y1)
					noSrc++;
			}
		}
		const pvOn = untrack(pvShown);
		let blank = 0,
			soft = 0,
			sharp = 0;
		const NY = 16,
			NX = 3;
		for (let a = 0; a < NY; a++) {
			for (let b = 0; b < NX; b++) {
				const x = x0 + ((b + 0.5) / NX) * (x1 - x0),
					y = y0 + ((a + 0.5) / NY) * (y1 - y0);
				let best = 0;
				for (const t of ts) {
					if (x < (t.x / t.W) * bw || x >= ((t.x + t.w) / t.W) * bw || y < (t.y / t.H) * bh || y >= ((t.y + t.h) / t.H) * bh)
						continue;
					best = Math.max(best, t.sk === sk ? 2 : 1);
					if (best === 2) break;
				}
				if (best === 2) sharp++;
				else if (best === 1 || pvOn) soft++;
				else blank++;
			}
		}
		const n = NX * NY;
		return { vis: (x1 - x0) * (y1 - y0), blank: blank / n, soft: soft / n, sharp: sharp / n, noSrc };
	});
	onCleanup(() => p.env.probe.delete(p.index));

	// ---- geometry of the washes (unrotated page space -> displayed css px)
	const place = (r: NRect): Record<string, unknown> => {
		const d = rotRect(r, p.rot());
		return { position: "absolute", left: d.x * p.boxW(), top: d.y * p.boxH(), width: d.w * p.boxW(), height: d.h * p.boxH() };
	};

	return (
		<div
			ref={(el: { id: number }) => {
				p.env.reg.boxes.set(p.index, el);
				onCleanup(() => {
					if (p.env.reg.boxes.get(p.index) === el) p.env.reg.boxes.delete(p.index);
				});
			}}
			style={{
				position: "relative",
				width: p.boxW(),
				height: p.boxH(),
				flexShrink: 0,
				backgroundColor: env.paper(),
				boxShadow: [
					{ offsetX: 0, offsetY: 4, blurRadius: 6, spreadRadius: -1, color: "rgba(0, 0, 0, 0.1)" },
					{ offsetX: 0, offsetY: 2, blurRadius: 4, spreadRadius: -2, color: "rgba(0, 0, 0, 0.1)" },
				],
				// the page does not take the mouse: presses and drags reach the reader's handlers (a positioned or filled element would
				// block them); only the link zones and the plugins' own controls do
				pointerEvents: "none",
			}}
		>
			<Show when={pv()} keyed>
				{(d) => <PreviewImg data={d} boxW={p.boxW} boxH={p.boxH} onShown={setPvShown} />}
			</Show>
			<For each={tiles()}>{(spec) => <TileView env={env} spec={spec} boxW={p.boxW} boxH={p.boxH} onGone={onGone} />}</For>
			<For each={p.hits()}>
				{(h) => (
					<For each={h.rects}>
						{(r) => (
							<div
								style={{
									...place(r),
									backgroundColor: p.currentHit() === h.id ? p.hitCurColor : p.hitColor,
									borderRadius: 2,
									pointerEvents: "none",
								}}
							/>
						)}
					</For>
				)}
			</For>
			<For each={p.selection()}>{(r) => <div style={{ ...place(r), backgroundColor: p.selColor(), pointerEvents: "none" }} />}</For>
			<Show when={p.debugWords()}>
				<For each={p.debugWords()!}>
					{(r) => (
						<div
							style={{
								...place(r),
								borderWidth: 1,
								borderColor: "#e5484d",
								backgroundColor: "#e5484d1f",
								pointerEvents: "none",
							}}
						/>
					)}
				</For>
			</Show>
			<For each={p.links()}>
				{(l) => (
					<div
						onClick={(e) => p.onLink(l, e)}
						style={{
							...place(l.rect),
							cursor: "pointer",
							pointerEvents: "auto",
							hover: { backgroundColor: "rgba(60, 120, 230, 0.14)" },
						}}
					/>
				)}
			</For>
			{/* the plugins' overlays sit ABOVE the link zones: a plugin's hover / click zone over a citation link (academic popovers) must win the pointer; the links draw first and still catch everything the overlays leave free */}
			{p.overlays()}
			{/* the web reader's ring-1 ring-black/10 */}
			<div
				style={{
					position: "absolute",
					left: 0,
					top: 0,
					width: p.boxW(),
					height: p.boxH(),
					borderWidth: 1,
					borderColor: "rgba(0, 0, 0, 0.1)",
					pointerEvents: "none",
				}}
			/>
		</div>
	);
}
