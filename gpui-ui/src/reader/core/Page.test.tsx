// bun test src/reader/core/Page.test.tsx -- PageSlot tile & preview upload unmount races (Issue #1).
import { describe, expect, test } from "bun:test";
import { createRoot } from "@gpuix/solid";
import { createSignal, Show } from "solid-js";
import type { PdfDoc, RenderTask } from "../pdf";
import { BitmapCache, type PageEnv, PageSlot, type PageStats } from "./Page";
import { Scheduler } from "./scheduler";

const tick = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));

/** Minimal fake GPUIX native renderer that tracks live element ids and throws `Unknown element id <id>` just like Rust. */
function makeFakeRenderer(opts: { failFirstUploads?: number; failIdTimes?: Map<number, number>; dropOnUpload?: boolean } = {}) {
	const live = new Set<number>();
	const children = new Map<number, Set<number>>();
	const uploaded: number[] = [];
	const batches: unknown[][][] = [];
	let remainingFails = opts.failFirstUploads ?? 0;

	const destroySubtree = (id: number, out: number[]) => {
		if (live.delete(id)) out.push(id);
		const kids = children.get(id);
		if (kids) {
			for (const c of kids) destroySubtree(c, out);
			children.delete(id);
		}
	};

	const renderer = {
		applyBatch(raw: string): number[] {
			const ops = JSON.parse(raw) as unknown[][];
			batches.push(ops);
			const destroyed: number[] = [];
			for (const op of ops) {
				const kind = op[0];
				if (kind === "createElement") {
					live.add(op[1] as number);
				} else if (kind === "appendChild" || kind === "insertBefore") {
					const parent = op[1] as number;
					const child = op[2] as number;
					let set = children.get(parent);
					if (!set) children.set(parent, (set = new Set()));
					set.add(child);
				} else if (kind === "destroyElement") {
					destroySubtree(op[1] as number, destroyed);
				}
			}
			return destroyed;
		},
		setImagePixels(id: number, _w: number, _h: number, _pixels: Uint8Array, _format?: string) {
			const idFails = opts.failIdTimes?.get(id) ?? 0;
			if (idFails > 0) {
				opts.failIdTimes!.set(id, idFails - 1);
				throw new Error(`Unknown element id ${id}`);
			}
			if (remainingFails > 0) {
				remainingFails--;
				throw new Error(`Unknown element id ${id}`);
			}
			if (opts.dropOnUpload) {
				live.delete(id);
			}
			if (!live.has(id)) {
				throw new Error(`Unknown element id ${id}`);
			}
			uploaded.push(id);
		},
		setWindowKeyEvents() {},
		setWindowSelectionChange() {},
	};

	return { renderer, live, uploaded, batches };
}

function makeBitmap(w = 600, h = 800) {
	let released = false;
	const pixels = new Uint8Array(w * h * 4);
	return {
		width: w,
		height: h,
		pixels: Buffer.from(pixels.buffer),
		renderMs: 1,
		slice(y: number, rows: number) {
			return Buffer.from(pixels.buffer, y * w * 4, rows * w * 4);
		},
		release() {
			released = true;
		},
		get released() {
			return released;
		},
	};
}

function makeEnv(opts: { doc: Partial<PdfDoc>; bitmaps?: BitmapCache; previews?: PageEnv["previews"] }): PageEnv {
	const stats: PageStats = {
		renders: 0,
		lastRenderMs: 0,
		lastUploadMs: 0,
		totalRenderMs: 0,
		cancelled: 0,
		tiles: 0,
		peakTiles: 0,
	};
	return {
		doc: opts.doc as PdfDoc,
		sched: new Scheduler(2),
		dpr: () => 1,
		look: () => ({ mode: 0 }),
		paper: () => "#fff",
		stats,
		pending: { n: 0 },
		reg: { boxes: new Map() },
		probe: new Map(),
		margins: () => ({ up: 200, down: 200, keep: 100, ahead: 1 }),
		laidOut: () => true,
		jobs: new Set(),
		bitmaps: opts.bitmaps,
		previews: opts.previews,
	};
}

function renderSlot(env: PageEnv, show: () => boolean) {
	return (
		<Show when={show()}>
			<PageSlot
				env={env}
				index={0}
				boxW={() => 600}
				boxH={() => 800}
				rot={() => 0}
				view={() => ({ x0: 0, y0: 0, x1: 600, y1: 800 })}
				hits={() => []}
				currentHit={() => -1}
				selection={() => []}
				links={() => []}
				onLink={() => {}}
				overlays={() => undefined}
				debugWords={() => null}
				selColor={() => "rgba(0,0,255,0.2)"}
				hitColor="rgba(255,255,0,0.3)"
				hitCurColor="rgba(255,165,0,0.5)"
			/>
		</Show>
	);
}

describe("PageSlot tile upload unmount races", () => {
	test("cached-bitmap upload on jump/unmount never produces an unhandled Unknown element id rejection", async () => {
		const rejections: unknown[] = [];
		const onRej = (e: unknown) => rejections.push(e);
		process.on("unhandledRejection", onRej);

		try {
			const { renderer } = makeFakeRenderer({ dropOnUpload: true });
			const bitmaps = new BitmapCache(24 * 1024 * 1024);
			const bm = makeBitmap(600, 800);
			// Pre-populate BitmapCache as happens when jumping from bibliography back to an earlier page
			const entry = bitmaps.put("0|600x800.0.0.0.0", 0, bm);
			bitmaps.unuse(entry);

			let renderCalls = 0;
			const env = makeEnv({
				bitmaps,
				doc: {
					sizes: [[600, 800]],
					renderSize2: () => [600, 800],
					render3: () => {
						renderCalls++;
						return { promise: Promise.resolve(null), cancel() {}, setPrio() {} };
					},
				},
			});

			const [show, setShow] = createSignal(true);
			const root = createRoot(renderer as never);
			root.render(() => renderSlot(env, show));
			root.flush();

			// Unmount immediately while cached-bitmap uploadTiles is in flight
			setShow(false);
			root.flush();
			await tick(40);

			root.unmount();
			// Clearing the cache should release the cached bitmap (proving bitmaps.unuse ran in finally)
			bitmaps.clear();
			expect(bm.released).toBe(true);
			expect(renderCalls).toBe(0);
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onRej);
		}
	});

	test("in-flight render resolving right as the page unmounts releases bitmap without throwing", async () => {
		const rejections: unknown[] = [];
		const onRej = (e: unknown) => rejections.push(e);
		process.on("unhandledRejection", onRej);

		try {
			const { renderer } = makeFakeRenderer();
			const bm = makeBitmap(600, 800);
			let resolveRender!: (r: ReturnType<typeof makeBitmap> | null) => void;
			const task: RenderTask = {
				promise: new Promise((res) => {
					resolveRender = res;
				}),
				cancel() {},
				setPrio() {},
			};

			const env = makeEnv({
				doc: {
					sizes: [[600, 800]],
					renderSize2: () => [600, 800],
					render3: () => task,
				},
			});

			const [show, setShow] = createSignal(true);
			const root = createRoot(renderer as never);
			root.render(() => renderSlot(env, show));
			root.flush();

			// Resolve render and unmount in the same turn (stale element race)
			resolveRender(bm);
			setShow(false);
			root.flush();
			await tick(40);

			root.unmount();
			expect(bm.released).toBe(true);
			expect(env.pending.n).toBe(0);
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onRej);
		}
	});

	test("transient Unknown element id before native flush retries and paints the tile", async () => {
		const rejections: unknown[] = [];
		const onRej = (e: unknown) => rejections.push(e);
		process.on("unhandledRejection", onRej);

		try {
			const { renderer, uploaded } = makeFakeRenderer({ failFirstUploads: 2 });
			const bitmaps = new BitmapCache(24 * 1024 * 1024);
			const bm = makeBitmap(600, 800);
			const entry = bitmaps.put("0|600x800.0.0.0.0", 0, bm);
			bitmaps.unuse(entry);

			const env = makeEnv({
				bitmaps,
				doc: {
					sizes: [[600, 800]],
					renderSize2: () => [600, 800],
					render3: () => ({ promise: Promise.resolve(null), cancel() {}, setPrio() {} }),
				},
			});

			const [show] = createSignal(true);
			const root = createRoot(renderer as never);
			root.render(() => renderSlot(env, show));
			root.flush();
			await tick(50);

			expect(uploaded.length).toBeGreaterThan(0);
			const cov = env.probe.get(0)?.({ x0: 0, y0: 0, x1: 600, y1: 800 });
			expect(cov?.sharp).toBe(1);
			expect(rejections).toEqual([]);

			root.unmount();
			bitmaps.clear();
		} finally {
			process.off("unhandledRejection", onRej);
		}
	});

	test("PreviewImg unmounting mid-upload never produces an unhandled rejection", async () => {
		const rejections: unknown[] = [];
		const onRej = (e: unknown) => rejections.push(e);
		process.on("unhandledRejection", onRej);

		try {
			const { renderer } = makeFakeRenderer({ dropOnUpload: true });
			const env = makeEnv({
				doc: {
					sizes: [[600, 800]],
					renderSize2: () => [600, 800],
					render3: () => ({ promise: Promise.resolve(null), cancel() {}, setPrio() {} }),
				},
				previews: {
					get: () => ({ w: 120, h: 160, px: new Uint8Array(120 * 160 * 4) }),
				} as never,
			});

			const [show, setShow] = createSignal(true);
			const root = createRoot(renderer as never);
			root.render(() => renderSlot(env, show));
			root.flush();
			setShow(false);
			root.flush();
			await tick(40);

			root.unmount();
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onRej);
		}
	});
});

describe("PageSlot tile upload fast-path and batching", () => {
	test("multi-tile whole-page upload paints ready tiles concurrently in one GPUIX batch without stalling behind a retrying sibling", async () => {
		// 600x1600 at WHOLE_BAND=512 creates 4 band tiles
		const { renderer, uploaded, batches } = makeFakeRenderer();
		const bitmaps = new BitmapCache(24 * 1024 * 1024);
		const bm = makeBitmap(600, 1600);
		let resolveRender!: (r: ReturnType<typeof makeBitmap> | null) => void;
		const env = makeEnv({
			bitmaps,
			doc: {
				sizes: [[600, 1600]],
				renderSize2: () => [600, 1600],
				render3: () => ({
					promise: new Promise((res) => {
						resolveRender = res;
					}),
					cancel() {},
					setPrio() {},
				}),
			},
		});

		const [show] = createSignal(true);
		const root = createRoot(renderer as never);
		root.render(() => (
			<Show when={show()}>
				<PageSlot
					env={env}
					index={0}
					boxW={() => 600}
					boxH={() => 1600}
					rot={() => 0}
					view={() => ({ x0: 0, y0: 0, x1: 600, y1: 1600 })}
					hits={() => []}
					currentHit={() => -1}
					selection={() => []}
					links={() => []}
					onLink={() => {}}
					overlays={() => undefined}
					debugWords={() => null}
					selColor={() => "rgba(0,0,255,0.2)"}
					hitColor="rgba(255,255,0,0.3)"
					hitCurColor="rgba(255,165,0,0.5)"
				/>
			</Show>
		));
		root.flush();

		const batchesBeforeUpload = batches.length;
		resolveRender(bm);
		await tick(20);

		expect(uploaded).toHaveLength(4);
		// All 4 tiles should become visible in ONE batched GPUIX mutation flush (not 4 serial flushes)
		const uploadBatches = batches.slice(batchesBeforeUpload);
		expect(uploadBatches).toHaveLength(1);
		expect(env.probe.get(0)?.({ x0: 0, y0: 0, x1: 600, y1: 1600 })?.sharp).toBe(1);

		root.unmount();
		bitmaps.clear();
	});

	test("cached whole-page multi-tile upload batches into a single BitmapCache acquire and single GPUIX flush", async () => {
		const { renderer, uploaded, batches } = makeFakeRenderer();
		const bitmaps = new BitmapCache(24 * 1024 * 1024);
		const bm = makeBitmap(600, 1600);
		const entry = bitmaps.put("0|600x1600.0.0.0.0", 0, bm);
		bitmaps.unuse(entry);

		let acquireCalls = 0;
		const origAcquire = bitmaps.acquire.bind(bitmaps);
		bitmaps.acquire = (k: string) => {
			acquireCalls++;
			return origAcquire(k);
		};

		const env = makeEnv({
			bitmaps,
			doc: {
				sizes: [[600, 1600]],
				renderSize2: () => [600, 1600],
				render3: () => ({ promise: Promise.resolve(null), cancel() {}, setPrio() {} }),
			},
		});

		const [show] = createSignal(true);
		const root = createRoot(renderer as never);
		root.render(() => (
			<Show when={show()}>
				<PageSlot
					env={env}
					index={0}
					boxW={() => 600}
					boxH={() => 1600}
					rot={() => 0}
					view={() => ({ x0: 0, y0: 0, x1: 600, y1: 1600 })}
					hits={() => []}
					currentHit={() => -1}
					selection={() => []}
					links={() => []}
					onLink={() => {}}
					overlays={() => undefined}
					debugWords={() => null}
					selColor={() => "rgba(0,0,255,0.2)"}
					hitColor="rgba(255,255,0,0.3)"
					hitCurColor="rgba(255,165,0,0.5)"
				/>
			</Show>
		));
		root.flush();
		const batchesAfterMount = batches.length;
		await tick(20);

		expect(uploaded).toHaveLength(4);
		expect(acquireCalls).toBe(1);
		expect(batches.slice(batchesAfterMount)).toHaveLength(1);
		expect(env.probe.get(0)?.({ x0: 0, y0: 0, x1: 600, y1: 1600 })?.sharp).toBe(1);

		root.unmount();
		bitmaps.clear();
		expect(bm.released).toBe(true);
	});

	test("a retrying tile never serially blocks sibling tiles on the same page from painting immediately", async () => {
		const failIdTimes = new Map<number, number>();
		let firstTileId: number | null = null;
		const { renderer, uploaded } = makeFakeRenderer({ failIdTimes });
		const origSetImagePixels = renderer.setImagePixels.bind(renderer);
		renderer.setImagePixels = (id: number, w: number, h: number, pixels: Uint8Array, format?: string) => {
			if (firstTileId === null) {
				firstTileId = id;
				// Fail the very first tile 4 times so it has to retry via timers
				failIdTimes.set(id, 4);
			}
			origSetImagePixels(id, w, h, pixels, format);
		};

		const bitmaps = new BitmapCache(24 * 1024 * 1024);
		const bm = makeBitmap(600, 1600);
		let resolveRender!: (r: ReturnType<typeof makeBitmap> | null) => void;
		const env = makeEnv({
			bitmaps,
			doc: {
				sizes: [[600, 1600]],
				renderSize2: () => [600, 1600],
				render3: () => ({
					promise: new Promise((res) => {
						resolveRender = res;
					}),
					cancel() {},
					setPrio() {},
				}),
			},
		});

		const [show] = createSignal(true);
		const root = createRoot(renderer as never);
		root.render(() => (
			<Show when={show()}>
				<PageSlot
					env={env}
					index={0}
					boxW={() => 600}
					boxH={() => 1600}
					rot={() => 0}
					view={() => ({ x0: 0, y0: 0, x1: 600, y1: 1600 })}
					hits={() => []}
					currentHit={() => -1}
					selection={() => []}
					links={() => []}
					onLink={() => {}}
					overlays={() => undefined}
					debugWords={() => null}
					selColor={() => "rgba(0,0,255,0.2)"}
					hitColor="rgba(255,255,0,0.3)"
					hitCurColor="rgba(255,165,0,0.5)"
				/>
			</Show>
		));
		root.flush();

		resolveRender(bm);
		// Wait only microtasks (before any setTimeout retry of firstTileId finishes)
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// The 3 healthy sibling tiles must already be uploaded even while firstTileId is still retrying!
		expect(firstTileId).not.toBeNull();
		expect(uploaded.length).toBe(3);
		expect(uploaded).not.toContain(firstTileId!);

		// After retries settle, the 4th tile finishes too
		await tick(40);
		expect(uploaded.length).toBe(4);
		expect(uploaded).toContain(firstTileId!);

		root.unmount();
		bitmaps.clear();
	});
});
