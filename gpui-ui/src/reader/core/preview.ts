// Low-resolution whole-page previews: what a page shows under its sharp tiles (or alone) while the tiles are still being drawn.
//
// A preview is the page at about a fifth of the sharp resolution (a few hundred px wide, < 1 MB; GPUIX keeps ~4.4x that for a
// live image), rendered through the same native priority queue as the tiles and kept in a small LRU of pixel buffers that
// outlives the page components: scrolling back to a page that left the mounted window, or on to one the reader was about to
// reach (the pages ahead in the scroll direction are requested one after the other), shows a stretched preview in the first frame
// instead of paper. The cache holds ~PREVIEW_CACHE * 0.5 MB of JS memory and costs no GPUIX memory until a page shows it.
import { createSignal, type Accessor, type Setter } from "solid-js";
import type { Look, PdfDoc, RenderTask } from "../pdf";
import { lookKey } from "./appearance";

export const PREVIEW_CACHE = 32;
/** longest side of a preview in device px */
const PREVIEW_MAX = 512;
/** PDF points -> css px (the reader's 100 % zoom) */
const CSS_PER_PT = 4 / 3;

export interface PreviewData {
	w: number;
	h: number;
	px: Uint8Array;
	key: string;
}
export interface PreviewWant {
	page: number;
	rot: number;
	prio: number;
}

interface Slot {
	data: Accessor<PreviewData | undefined>;
	set: Setter<PreviewData | undefined>;
	touched: number;
}

export class Previews {
	private slots = new Map<number, Slot>();
	private inflight = new Map<number, { key: string; task: RenderTask; setPrio(p: number): void }>();
	private clock = 0;
	private closed = false;
	/** previews rendered, for scripts */
	made = 0;
	constructor(
		private doc: PdfDoc,
		private dpr: Accessor<number>,
		private look: Accessor<Look>,
	) {}

	get pending(): number {
		return this.inflight.size;
	}

	private slot(page: number): Slot {
		let s = this.slots.get(page);
		if (!s) {
			const [data, set] = createSignal<PreviewData | undefined>(undefined);
			s = { data, set, touched: 0 };
			this.slots.set(page, s);
		}
		return s;
	}

	/** The preview of `page` for this rotation / look (reactive: it appears once rendered), or undefined. */
	get(page: number, rot: number): PreviewData | undefined {
		const s = this.slot(page);
		const d = s.data();
		if (!d) return undefined;
		s.touched = ++this.clock;
		return d.key === this.keyOf(rot) ? d : undefined;
	}

	private keyOf(rot: number): string {
		return `${rot}.${lookKey(this.look())}.${Math.round(this.dpr() * 100)}`;
	}

	/** Make these pages' previews exist (render the missing ones at the given priorities) and cancel the jobs that are no longer wanted. */
	want(list: PreviewWant[]): void {
		if (this.closed) return;
		const keep = new Set<number>();
		for (const w of list) {
			keep.add(w.page);
			const key = this.keyOf(w.rot);
			const have = this.slot(w.page).data();
			if (have && have.key === key) continue;
			const run = this.inflight.get(w.page);
			if (run?.key === key) {
				run.setPrio(w.prio);
				continue;
			}
			run?.task.cancel();
			this.start(w, key);
		}
		for (const [page, run] of [...this.inflight]) {
			if (keep.has(page)) continue;
			run.task.cancel();
			this.inflight.delete(page);
		}
	}

	private start(w: PreviewWant, key: string): void {
		const sz = this.doc.sizes[w.page];
		if (!sz) return;
		const bw = w.rot % 180 === 0 ? sz[0] : sz[1],
			bh = w.rot % 180 === 0 ? sz[1] : sz[0];
		const scale = Math.min(0.2 * CSS_PER_PT * this.dpr(), PREVIEW_MAX / Math.max(bw, bh));
		let task: RenderTask;
		try {
			task = this.doc.render3(w.page, scale, { rot: w.rot, look: this.look(), prio: w.prio });
		} catch {
			return;
		}
		const run = { key, task, setPrio: (p: number) => task.setPrio(p) };
		this.inflight.set(w.page, run);
		void task.promise.then(
			(r) => {
				if (!r) return;
				try {
					if (this.closed || this.inflight.get(w.page) !== run) return;
					const px = new Uint8Array(r.pixels.length);
					px.set(r.pixels);
					this.slot(w.page).set({ w: r.width, h: r.height, px, key });
					this.made++;
					this.evict();
				} finally {
					r.release();
					if (this.inflight.get(w.page) === run) this.inflight.delete(w.page);
				}
			},
			() => {
				if (this.inflight.get(w.page) === run) this.inflight.delete(w.page);
			},
		);
	}

	private evict(): void {
		let n = 0;
		for (const s of this.slots.values()) if (s.data()) n++;
		if (n <= PREVIEW_CACHE) return;
		const order = [...this.slots.entries()].filter(([, s]) => s.data()).sort((a, b) => a[1].touched - b[1].touched);
		for (const [, s] of order.slice(0, n - PREVIEW_CACHE)) s.set(undefined);
	}

	/** Drop every preview and cancel the renders under way, but stay usable: want() makes them again (an inactive tab frees its memory). */
	release(): void {
		for (const run of this.inflight.values()) run.task.cancel();
		this.inflight.clear();
		for (const s of this.slots.values()) s.set(undefined);
	}

	close(): void {
		this.closed = true;
		for (const run of this.inflight.values()) run.task.cancel();
		this.inflight.clear();
		for (const s of this.slots.values()) s.set(undefined);
		this.slots.clear();
	}
}
