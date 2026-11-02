// One page of the reader: a box of the page's size with the rasterized tiles in it, the search / selection washes, the link hot
// zones and the plugins' overlays.
//
// MEMORY MODEL. A page is not one bitmap. Its pixels (page size x zoom x device pixel ratio) are cut into tiles of at most
// ~1024 px on a side, and only the tiles that touch the viewport (plus a margin) exist as images; the rest of the page is the
// paper colour. Scrolling creates the tiles that come into the margin and destroys the ones that leave it, so the cost of an
// open PDF is the size of the viewport, whatever the page count or the zoom (a 6x zoom is a few more small tiles, not a 500 MB
// page). Pixels are handed to GPUIX once (setImagePixels copies them into its own image) and the native buffer is freed on the
// spot: the JS side never keeps a copy.
//
// A zoom or resize does not blank the page: the tiles of the old resolution stay, stretched to the new box, until the new
// ones that cover the viewport are ready (the new ones are requested after a short debounce).
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack, type Accessor, type JSX } from "solid-js";
import type { Look, PdfDoc } from "../pdf";
import type { NRect } from "../plugins";
import { lookKey } from "./appearance";
import type { Scheduler } from "./scheduler";
import { rotRect } from "./text";

export const MAX_TILE = 800; // device px per tile edge when a page needs several
const SINGLE_COL_MAX = 2400; // a page up to this wide (device px) is one column of tiles, whatever its width
const MARGIN_Y = 200; // css px around the viewport that are kept rendered
const MARGIN_X = 160;
const ZOOM_DEBOUNCE = 140;

export interface ViewRect { x0: number; y0: number; x1: number; y1: number }
export interface LinkInfo { rect: NRect; target: { kind: "page"; page: number; y: number } | { kind: "uri"; uri: string } }

export interface PageStats { renders: number; lastRenderMs: number; lastUploadMs: number; totalRenderMs: number; cancelled: number; tiles: number; peakTiles: number }

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
}

interface TileSpec {
	key: string;
	sk: string;
	x: number; y: number; w: number; h: number;
	W: number; H: number;
	scale: number;
	rot: number;
	look: Look;
	ready: Accessor<boolean>;
	setReady(v: boolean): void;
	/** 0: touches the viewport, 1: only the margin */
	tier: Accessor<number>;
	setTier(v: number): void;
}

interface Grid { sk: string; W: number; H: number; scale: number; rot: number; look: Look; cols: number; rows: number; TW: number; TH: number }

type ImgNode = { id: number; mounted: boolean; setImagePixels(w: number, h: number, b: Uint8Array, o?: { format?: "rgba" | "bgra" }): void };

function TileView(p: { env: PageEnv; page: number; spec: TileSpec; boxW: Accessor<number>; boxH: Accessor<number>; dist: (s: TileSpec) => number; onReady(): void }): JSX.Element {
	const { env, spec } = p;
	let img: ImgNode | undefined;
	let alive = true;
	let task: { cancel(): void } | undefined;
	env.stats.tiles++;
	env.stats.peakTiles = Math.max(env.stats.peakTiles, env.stats.tiles);
	const handle = env.sched.add({
		pri: () => spec.tier() * 1e6 + p.dist(spec),
		dropped: () => { env.pending.n--; },
		run: async () => {
			if (!alive) { env.pending.n--; return; }
			try {
				const t = env.doc.render2(p.page, spec.scale, { rot: spec.rot, look: spec.look, region: { x: spec.x, y: spec.y, w: spec.w, h: spec.h } });
				task = t;
				const r = await t.promise;
				task = undefined;
				if (!r) return;
				// the element may not be inserted yet right after mount: wait for it (a few frames at most)
				for (let i = 0; i < 40 && alive && !(img && img.mounted); i++) await Bun.sleep(8);
				if (!alive || !img || !img.mounted) { r.release(); return; }
				const u0 = performance.now();
				img.setImagePixels(r.width, r.height, r.pixels, { format: "bgra" });
				env.stats.lastUploadMs = performance.now() - u0;
				env.stats.renders++;
				env.stats.lastRenderMs = r.renderMs;
				env.stats.totalRenderMs += r.renderMs;
				r.release(); // the native copy goes now; GPUIX holds its own
				spec.setReady(true);
				p.onReady();
			} catch (e) {
				if (alive) console.error(`[reader] page ${p.page} tile:`, e instanceof Error ? e.message : e);
			} finally {
				env.pending.n--;
			}
		},
	});
	env.pending.n++;
	onCleanup(() => {
		alive = false;
		handle.cancel();
		if (task) { task.cancel(); env.stats.cancelled++; }
		env.stats.tiles--;
	});
	// css box of the tile inside the page box (rounded outwards so neighbours never leave a seam)
	const geo = () => {
		const kx = p.boxW() / spec.W, ky = p.boxH() / spec.H;
		const l = Math.floor(spec.x * kx), t = Math.floor(spec.y * ky);
		return { left: l, top: t, width: Math.ceil((spec.x + spec.w) * kx) - l, height: Math.ceil((spec.y + spec.h) * ky) - t };
	};
	return (
		<img
			ref={(el: ImgNode) => { img = el; }}
			objectFit="fill"
			style={{ position: "absolute", pointerEvents: "none", ...geo() }}
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
		if (first) { first = false; return; }
		clearTimeout(zt);
		zt = setTimeout(() => setRenderW(w), ZOOM_DEBOUNCE);
	});
	onCleanup(() => clearTimeout(zt));

	const grid = createMemo<Grid>(() => {
		const rot = p.rot(), look = env.look();
		const base = rot % 180 === 0 ? pw : ph;
		const scale = renderW() / base;
		const [W, H] = env.doc.renderSize2(p.index, scale, rot);
		const cols = W <= SINGLE_COL_MAX ? 1 : Math.ceil(W / MAX_TILE);
		const rows = Math.max(1, Math.ceil(H / MAX_TILE));
		return { sk: `${W}x${H}.${rot}.${lookKey(look)}`, W, H, scale, rot, look, cols, rows, TW: Math.ceil(W / cols), TH: Math.ceil(H / rows) };
	});

	/** tiles of the current grid that touch the viewport (tier 0) or its margin (tier 1) */
	const wanted = createMemo(() => {
		const g = grid(), v = p.view();
		const kx = g.W / p.boxW(), ky = g.H / p.boxH(); // css -> device px
		const vx0 = (v.x0 - MARGIN_X) * kx, vx1 = (v.x1 + MARGIN_X) * kx, vy0 = (v.y0 - MARGIN_Y) * ky, vy1 = (v.y1 + MARGIN_Y) * ky;
		const ix0 = v.x0 * kx, ix1 = v.x1 * kx, iy0 = v.y0 * ky, iy1 = v.y1 * ky;
		const out: { key: string; c: number; r: number; tier: number }[] = [];
		if (vy1 <= 0 || vy0 >= g.H || vx1 <= 0 || vx0 >= g.W) return out;
		const c0 = Math.max(0, Math.floor(vx0 / g.TW)), c1 = Math.min(g.cols - 1, Math.floor((vx1 - 1) / g.TW));
		const r0 = Math.max(0, Math.floor(vy0 / g.TH)), r1 = Math.min(g.rows - 1, Math.floor((vy1 - 1) / g.TH));
		for (let r = r0; r <= r1; r++) {
			for (let c = c0; c <= c1; c++) {
				const tx0 = c * g.TW, tx1 = tx0 + g.TW, ty0 = r * g.TH, ty1 = ty0 + g.TH;
				const inside = tx1 > ix0 && tx0 < ix1 && ty1 > iy0 && ty0 < iy1;
				out.push({ key: `${g.sk}:${c}:${r}`, c, r, tier: inside ? 0 : 1 });
			}
		}
		return out;
	}, undefined, { equals: (a, b) => a.length === b.length && a.every((t, i) => t.key === b[i]!.key && t.tier === b[i]!.tier) });

	// ---- tile set
	const [tiles, setTiles] = createSignal<TileSpec[]>([]);
	const [tick, setTick] = createSignal(0);
	const make = (g: Grid, c: number, r: number, key: string, tier: number): TileSpec => {
		const [ready, setReady] = createSignal(false);
		const [t, setT] = createSignal(tier);
		const x = c * g.TW, y = r * g.TH;
		return { key, sk: g.sk, x, y, w: Math.min(g.TW, g.W - x), h: Math.min(g.TH, g.H - y), W: g.W, H: g.H, scale: g.scale, rot: g.rot, look: g.look, ready, setReady, tier: t, setTier: setT };
	};
	createEffect(() => {
		const g = grid(), want = wanted();
		tick();
		untrack(() => {
			const cur = tiles();
			const byKey = new Map(cur.map((t) => [t.key, t]));
			const fresh: TileSpec[] = want.map((w) => {
				const old = byKey.get(w.key);
				if (old) { if (old.tier() !== w.tier) old.setTier(w.tier); return old; }
				return make(g, w.c, w.r, w.key, w.tier);
			});
			// older resolutions stay (under the new tiles) until everything on screen is redrawn at the new one
			const covered = fresh.every((t) => t.tier() !== 0 || t.ready());
			const stale = covered ? [] : cur.filter((t) => t.sk !== g.sk);
			const next = [...stale, ...fresh];
			if (next.length === cur.length && next.every((t, i) => t === cur[i])) return;
			setTiles(next);
		});
	});

	const dist = (s: TileSpec): number => {
		const v = untrack(p.view), bw = untrack(p.boxW), bh = untrack(p.boxH);
		const cy = ((s.y + s.h / 2) / s.H) * bh, vy = (v.y0 + v.y1) / 2;
		return Math.abs(cy - vy);
	};

	// ---- geometry of the washes (unrotated page space -> displayed css px)
	const place = (r: NRect): Record<string, unknown> => {
		const d = rotRect(r, p.rot());
		return { position: "absolute", left: d.x * p.boxW(), top: d.y * p.boxH(), width: d.w * p.boxW(), height: d.h * p.boxH() };
	};

	return (
		<div
			ref={(el: { id: number }) => {
				p.env.reg.boxes.set(p.index, el);
				onCleanup(() => { if (p.env.reg.boxes.get(p.index) === el) p.env.reg.boxes.delete(p.index); });
			}}
			style={{
				position: "relative", width: p.boxW(), height: p.boxH(), flexShrink: 0, backgroundColor: env.paper(),
				boxShadow: [
					{ offsetX: 0, offsetY: 4, blurRadius: 6, spreadRadius: -1, color: "rgba(0, 0, 0, 0.1)" },
					{ offsetX: 0, offsetY: 2, blurRadius: 4, spreadRadius: -2, color: "rgba(0, 0, 0, 0.1)" },
				],
				// the page does not take the mouse: presses and drags reach the reader's handlers (a positioned or filled element would
				// block them); only the link zones and the plugins' own controls do
				pointerEvents: "none",
			}}
		>
			<For each={tiles()}>
				{(spec) => <TileView env={env} page={p.index} spec={spec} boxW={p.boxW} boxH={p.boxH} dist={dist} onReady={() => setTick((n) => n + 1)} />}
			</For>
			<For each={p.hits()}>
				{(h) => (
					<For each={h.rects}>
						{(r) => <div style={{ ...place(r), backgroundColor: p.currentHit() === h.id ? p.hitCurColor : p.hitColor, borderRadius: 2, pointerEvents: "none" }} />}
					</For>
				)}
			</For>
			<For each={p.selection()}>
				{(r) => <div style={{ ...place(r), backgroundColor: p.selColor(), pointerEvents: "none" }} />}
			</For>
			<Show when={p.debugWords()}>
				<For each={p.debugWords()!}>
					{(r) => <div style={{ ...place(r), borderWidth: 1, borderColor: "#e5484d", backgroundColor: "#e5484d1f", pointerEvents: "none" }} />}
				</For>
			</Show>
			{p.overlays()}
			<For each={p.links()}>
				{(l) => (
					<div
						onClick={(e) => p.onLink(l, e)}
						style={{ ...place(l.rect), cursor: "pointer", hover: { backgroundColor: "rgba(60, 120, 230, 0.14)" } }}
					/>
				)}
			</For>
			{/* the web reader's ring-1 ring-black/10 */}
			<div style={{ position: "absolute", left: 0, top: 0, width: p.boxW(), height: p.boxH(), borderWidth: 1, borderColor: "rgba(0, 0, 0, 0.1)", pointerEvents: "none" }} />
		</div>
	);
}
