// ViewerController: all viewer state (layout, zoom, scroll, find, plugin registries) and the ViewerHandle
// implementation. The Solid components in Viewer.tsx are thin renderers over this.
import { batch, createMemo, createSignal, type Accessor } from "solid-js";
import type { LinkClick, PageInfo, PdfRect, ViewerHandle } from "../contract";
import { PdfDoc, type FindHit, type LinkInfo, type PageTextData } from "./pdf";

export const CSS_PER_PT = 96 / 72; // zoom 1 (100%) = 96 dpi
export const GAP = 12; // css px between pages
export const PAD = 16; // css px around the page column
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 6;

export type ZoomMode = "width" | "page" | "custom";
export type OverlayCb = Parameters<ViewerHandle["onPageOverlay"]>[0];
export interface SidebarTabDef { id: string; title: string; icon?: string; render: (c: HTMLElement) => void | (() => void) }
export interface ToolbarBtnDef { id: string; title: string; icon?: string; onClick: () => void; active?: () => boolean }
type AlternateRender = (c: HTMLElement) => void | (() => void);

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export class ViewerController implements ViewerHandle {
	readonly pages: PageInfo[];
	scroller: HTMLElement | null = null;

	// ---- viewport / zoom / scroll
	viewport = createSignal({ w: 800, h: 600 });
	zoomMode = createSignal<ZoomMode>("width");
	zoomVal = createSignal(1); // effective zoom (1 = 100%)
	/** zoom after interaction settles; canvases re-render at this */
	settledZoom = createSignal(1);
	scrollTop = createSignal(0);
	scrollLeft = createSignal(0);
	ready = createSignal(false);
	firstPaintMs = createSignal<number | null>(null);

	// ---- layout
	/** whole-document rotation (clockwise degrees) and per-page extra rotation; effective = sum mod 360 */
	rotation = createSignal(0);
	pageRots = createSignal<Record<number, number>>({});
	thumbSel = createSignal<number[]>([]);
	thumbAnchor = 0;
	/** set by Viewer: text of the current selection rebuilt from the text layer */
	copyText: () => string | null = () => null;
	menu = createSignal<{ x: number; y: number; items: { label: string; onClick: () => void }[] } | null>(null);
	rotOf = (i: number) => (((this.rotation[0]() + (this.pageRots[0]()[i] ?? 0)) % 360) + 360) % 360;
	layout: Accessor<{ tops: number[]; heights: number[]; widths: number[]; lefts: number[]; rots: number[]; total: number; innerW: number; scale: number }>;
	curPage: Accessor<number>;
	/** pages that should be mounted (viewport +- one viewport) */
	range: Accessor<[number, number]>;

	// ---- find
	findOpen = createSignal(false);
	findQuery = createSignal("");
	findCase = createSignal(false);
	findWord = createSignal(false);
	findHits = createSignal<FindHit[]>([]);
	findIndex = createSignal(-1);
	findBusy = createSignal(false);
	private findSeq = 0;

	// ---- plugins
	sidebarTabs = createSignal<SidebarTabDef[]>([]);
	/** Request from a plugin to open the sidebar on a tab (Viewer.tsx applies it). */
	sidebarRequest = createSignal<{ id: string } | null>(null, { equals: false });
	toolbarBtns = createSignal<ToolbarBtnDef[]>([]);
	alternate = createSignal<AlternateRender | null>(null);
	private overlayCbs = new Set<OverlayCb>();
	private linkCbs = new Set<(e: LinkClick) => void>();
	private hoverCbs = new Set<(e: LinkClick | null) => void>();
	overlayEpoch = createSignal(0);

	// ---- flash
	flash = createSignal<{ id: number; page: number; rect: PdfRect } | null>(null);
	private flashId = 0;

	/** resolved page text, readable synchronously (for click text lookup) */
	textCache = new Map<number, PageTextData>();
	linkCache = new Map<number, LinkInfo[]>();
	backStack: { top: number }[] = [];

	constructor(
		readonly attachmentKey: string,
		readonly itemKey: string | null,
		readonly title: string,
		readonly pdf: PdfDoc,
	) {
		this.pages = pdf.pages;

		this.layout = createMemo(() => {
			const scale = this.zoomVal[0]() * CSS_PER_PT;
			const n = this.pages.length;
			const tops = new Array<number>(n), heights = new Array<number>(n), widths = new Array<number>(n), rots = new Array<number>(n);
			let y = PAD, maxW = 0;
			for (let i = 0; i < n; i++) {
				const r = this.rotOf(i);
				rots[i] = r;
				const sw = r % 180 !== 0;
				const w = (sw ? this.pages[i].height : this.pages[i].width) * scale, h = (sw ? this.pages[i].width : this.pages[i].height) * scale;
				tops[i] = y; heights[i] = h; widths[i] = w;
				y += h + GAP;
				if (w > maxW) maxW = w;
			}
			const innerW = Math.max(this.viewport[0]().w, maxW + PAD * 2);
			const lefts = widths.map((w) => Math.round((innerW - w) / 2));
			return { tops, heights, widths, lefts, rots, total: y - GAP + PAD, innerW, scale };
		});

		const findPage = (y: number) => {
			const { tops, heights } = this.layout();
			let lo = 0, hi = tops.length - 1;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (tops[mid] + heights[mid] + GAP / 2 < y) lo = mid + 1; else hi = mid;
			}
			return lo;
		};
		this.curPage = createMemo(() => {
			const st = this.scrollTop[0](), vh = this.viewport[0]().h;
			return findPage(st + vh * 0.35);
		});
		this.range = createMemo<[number, number]>((prev) => {
			const st = this.scrollTop[0](), vh = this.viewport[0]().h;
			this.layout();
			const a = findPage(Math.max(0, st - vh)), b = findPage(st + vh * 2);
			if (prev && prev[0] === a && prev[1] === b) return prev;
			return [a, b];
		}, [0, 0], { equals: (p, n) => p[0] === n[0] && p[1] === n[1] });

		this.applyZoomMode();
	}

	// ------------------------------------------------------------------ zoom

	/** recompute zoom for fit modes after viewport / mode change */
	applyZoomMode() {
		const mode = this.zoomMode[0]();
		if (mode === "custom") return;
		const { w, h } = this.viewport[0]();
		const availW = Math.max(100, w - PAD * 2 - (this.scroller ? this.scroller.offsetWidth - this.scroller.clientWidth : 0));
		const ws: number[] = [], hs: number[] = [];
		this.pages.forEach((p, i) => { const sw = this.rotOf(i) % 180 !== 0; ws.push(sw ? p.height : p.width); hs.push(sw ? p.width : p.height); });
		ws.sort((a, b) => a - b); hs.sort((a, b) => a - b);
		const medianW = ws[ws.length >> 1] || 612, medianH = hs[hs.length >> 1] || 792;
		let z = availW / (medianW * CSS_PER_PT);
		if (mode === "page") z = Math.min(z, (h - PAD * 2) / (medianH * CSS_PER_PT));
		this.setZoomRaw(clamp(z, MIN_ZOOM, MAX_ZOOM), true);
	}

	private zoomTimer = 0;
	private setZoomRaw(z: number, keepPage = false) {
		const old = this.zoomVal[0]();
		if (Math.abs(old - z) < 1e-4) return;
		const page = this.curPage();
		const sc = this.scroller;
		const frac = sc && keepPage ? this.pageFrac(page) : 0;
		this.zoomVal[1](z);
		if (sc && keepPage) this.restorePageFrac(page, frac);
		this.scheduleSettle();
	}
	private scheduleSettle() {
		clearTimeout(this.zoomTimer);
		this.zoomTimer = window.setTimeout(() => {
			this.settledZoom[1](this.zoomVal[0]());
			this.overlayEpoch[1]((e) => e + 1);
			this.scheduleSave();
		}, 140);
	}
	/** fraction of the current page above the viewport top */
	private pageFrac(page: number) {
		const { tops, heights } = this.layout();
		return (this.scrollTop[0]() - tops[page]) / heights[page];
	}
	private restorePageFrac(page: number, frac: number) {
		const { tops, heights } = this.layout();
		this.setScroll(tops[page] + frac * heights[page]);
	}
	setScroll(top: number, left?: number) {
		const sc = this.scroller;
		if (!sc) return;
		sc.scrollTop = Math.max(0, top);
		if (left !== undefined) sc.scrollLeft = left;
		this.scrollTop[1](sc.scrollTop);
	}

	setZoom(z: number, anchor?: { x: number; y: number }) {
		z = clamp(z, MIN_ZOOM, MAX_ZOOM);
		const sc = this.scroller;
		const old = this.zoomVal[0]();
		if (!sc || Math.abs(old - z) < 1e-4) { this.zoomMode[1]("custom"); this.setZoomRaw(z); return; }
		// keep the content point under `anchor` (viewport coords) fixed
		const ax = anchor?.x ?? sc.clientWidth / 2, ay = anchor?.y ?? sc.clientHeight / 2;
		const ratio = z / old;
		const cx = sc.scrollLeft + ax, cy = sc.scrollTop + ay;
		const oldInner = this.layout().innerW;
		batch(() => { this.zoomMode[1]("custom"); this.zoomVal[1](z); });
		const newInner = this.layout().innerW;
		// pages are centred; horizontal anchor relative to the centre
		const nx = (cx - oldInner / 2) * ratio + newInner / 2;
		// vertical: content offset scales (PAD/GAP are constant, small error is acceptable)
		const ny = cy * ratio;
		this.setScroll(ny - ay, nx - ax);
		this.scheduleSettle();
	}
	zoomBy(f: number, anchor?: { x: number; y: number }) { this.setZoom(this.zoomVal[0]() * f, anchor); }
	setMode(m: ZoomMode) {
		batch(() => this.zoomMode[1](m));
		const page = this.curPage();
		const frac = this.scroller ? this.pageFrac(page) : 0;
		this.applyZoomMode();
		if (this.scroller) { this.restorePageFrac(page, frac); this.scroller.scrollLeft = 0; }
		this.scheduleSettle();
	}
	onResize(w: number, h: number) {
		const v = this.viewport[0]();
		if (Math.abs(v.w - w) < 1 && Math.abs(v.h - h) < 1) return;
		const page = this.curPage();
		const frac = this.scroller ? this.pageFrac(page) : 0;
		this.viewport[1]({ w, h });
		if (this.zoomMode[0]() !== "custom") {
			this.applyZoomMode();
			if (this.scroller) this.restorePageFrac(page, frac);
		}
	}

	// ------------------------------------------------------------------ ViewerHandle

	page() { return this.curPage(); }
	zoom() { return this.zoomVal[0](); }

	goToPage(index: number, opts?: { top?: number; smooth?: boolean }) {
		index = clamp(Math.round(index), 0, this.pages.length - 1);
		const { tops } = this.layout();
		let y = tops[index];
		if (opts?.top !== undefined) y += Math.max(0, this.rectToBox(index, [0, opts.top, 0, opts.top]).top - 48);
		this.scrollToY(y, opts?.smooth);
	}
	scrollToY(y: number, smooth = false) {
		const sc = this.scroller;
		if (!sc) return;
		const max = sc.scrollHeight - sc.clientHeight;
		const target = clamp(y - 8, 0, Math.max(0, max));
		if (smooth && Math.abs(target - sc.scrollTop) < sc.clientHeight * 3) sc.scrollTo({ top: target, behavior: "smooth" });
		else sc.scrollTop = target;
		this.scrollTop[1](sc.scrollTop);
	}

	reveal(page: number, rect: PdfRect) {
		const { tops, lefts } = this.layout();
		const sc = this.scroller;
		if (!sc || page < 0 || page >= this.pages.length) return;
		const b = this.rectToBox(page, rect);
		const top = tops[page] + b.top, bottom = tops[page] + b.bottom;
		const left = lefts[page] + b.left, right = lefts[page] + b.right;
		const vTop = sc.scrollTop, vH = sc.clientHeight;
		if (top < vTop + 40 || bottom > vTop + vH - 40) this.scrollToY(Math.max(0, top - vH * 0.3), false);
		if (left < sc.scrollLeft || right > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = Math.max(0, left - sc.clientWidth * 0.3);
		this.flash[1]({ id: ++this.flashId, page, rect });
		const id = this.flashId;
		setTimeout(() => { if (this.flash[0]()?.id === id) this.flash[1](null); }, 1800);
	}

	onPageOverlay(cb: OverlayCb) {
		this.overlayCbs.add(cb);
		this.overlayEpoch[1]((e) => e + 1);
		return () => { this.overlayCbs.delete(cb); this.overlayEpoch[1]((e) => e + 1); };
	}
	/** used by PageView: register a mounted overlay layer; returns unmount fn */
	mountOverlay(page: number, layer: HTMLElement, getScale: () => number): () => void {
		const cleanups = new Map<OverlayCb, () => void>();
		void getScale;
		const toScreen = (r: PdfRect) => {
			const b = this.rectToBox(page, r);
			return { left: b.left, top: b.top, width: b.right - b.left, height: b.bottom - b.top };
		};
		const apply = (cb: OverlayCb) => {
			cleanups.get(cb)?.();
			cleanups.delete(cb);
			try {
				const c = cb(page, layer, toScreen);
				if (typeof c === "function") cleanups.set(cb, c);
			} catch (e) { console.error("onPageOverlay callback failed", e); }
		};
		for (const cb of this.overlayCbs) apply(cb);
		return () => {
			for (const c of cleanups.values()) { try { c(); } catch { /* ignore */ } }
			cleanups.clear();
		};
	}
	/** re-run callbacks for one layer (after zoom settles) */
	get overlayCallbacks() { return this.overlayCbs; }

	onLink(cb: (e: LinkClick) => void) { this.linkCbs.add(cb); return () => { this.linkCbs.delete(cb); }; }
	onLinkHover(cb: (e: LinkClick | null) => void) { this.hoverCbs.add(cb); return () => { this.hoverCbs.delete(cb); }; }

	pageText(index: number) {
		return this.loadText(index).then((d) => ({ text: d.text, rects: d.rects }));
	}
	/** Crop of a page region as a canvas, at most maxWidth CSS px wide (sharp on high-DPI screens). */
	async renderRegion(page: number, rect: PdfRect, maxWidth: number): Promise<HTMLCanvasElement> {
		const w = Math.max(1, rect[2] - rect[0]);
		const css = Math.min(maxWidth / w, 4);
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const img = await this.pdf.renderRect(page, rect, css * dpr);
		const canvas = document.createElement("canvas");
		canvas.width = img.width;
		canvas.height = img.height;
		canvas.style.width = `${Math.round(img.width / dpr)}px`;
		canvas.getContext("2d")!.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
		return canvas;
	}
	loadText(index: number): Promise<PageTextData> {
		const c = this.textCache.get(index);
		if (c) return Promise.resolve(c);
		return this.pdf.pageText(index).then((d) => { this.textCache.set(index, d); return d; });
	}
	loadLinks(index: number): Promise<LinkInfo[]> {
		const c = this.linkCache.get(index);
		if (c) return Promise.resolve(c);
		return this.pdf.pageLinks(index).then((d) => { this.linkCache.set(index, d); return d; });
	}

	addSidebarTab(tab: SidebarTabDef) {
		this.sidebarTabs[1]((t) => [...t.filter((x) => x.id !== tab.id), tab]);
		return () => this.sidebarTabs[1]((t) => t.filter((x) => x !== tab));
	}
	showSidebarTab(id: string) { this.sidebarRequest[1]({ id }); }
	/** Link annotations of a page with the text under each. */
	async pageLinks(index: number) {
		const [links] = await Promise.all([this.loadLinks(index), this.loadText(index)]);
		return links.map((l) => ({ rect: l.rect, target: l.target, text: this.textUnder(index, l.rect) }));
	}
	addToolbarButton(btn: ToolbarBtnDef) {
		this.toolbarBtns[1]((t) => [...t.filter((x) => x.id !== btn.id), btn]);
		return () => this.toolbarBtns[1]((t) => t.filter((x) => x !== btn));
	}
	setAlternateView(render: AlternateRender | null) { this.alternate[1](() => render); }
	alternateActive() { return !!this.alternate[0](); }

	// ------------------------------------------------------------------ links

	textUnder(page: number, rect: PdfRect): string | undefined {
		const d = this.textCache.get(page);
		if (!d) return undefined;
		let s = "";
		for (let i = 0; i < d.rects.length; i++) {
			const r = d.rects[i];
			if (r[2] <= r[0]) continue;
			const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
			if (cx >= rect[0] && cx <= rect[2] && cy >= rect[1] && cy <= rect[3]) s += d.text[i] ?? "";
		}
		return s.trim() || undefined;
	}
	makeLinkEvent(page: number, link: LinkInfo, clientX: number, clientY: number): LinkClick & { prevented: boolean } {
		const ev = {
			page, rect: link.rect, target: link.target, text: this.textUnder(page, link.rect), clientX, clientY,
			prevented: false,
			preventDefault() { ev.prevented = true; },
		};
		return ev;
	}
	activateLink(page: number, link: LinkInfo, clientX: number, clientY: number) {
		const ev = this.makeLinkEvent(page, link, clientX, clientY);
		for (const cb of [...this.linkCbs]) {
			try { cb(ev); } catch (e) { console.error("onLink listener failed", e); }
			if (ev.prevented) return;
		}
		this.defaultLink(link);
	}
	defaultLink(link: LinkInfo) {
		const t = link.target;
		if (t.kind === "internal" && t.page !== undefined) {
			this.backStack.push({ top: this.scroller?.scrollTop ?? 0 });
			this.goToPage(t.page, { top: t.top });
		} else if (t.kind === "external" && t.uri) {
			void fetch("/api/open-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: t.uri }) }).catch(() => {});
		}
	}
	goBack() {
		const b = this.backStack.pop();
		if (b) this.scrollToY(b.top + 8);
	}
	fireHover(page: number | null, link: LinkInfo | null, clientX = 0, clientY = 0) {
		const ev = page === null || !link ? null : this.makeLinkEvent(page, link, clientX, clientY);
		for (const cb of [...this.hoverCbs]) { try { cb(ev); } catch (e) { console.error("onLinkHover listener failed", e); } }
	}

	// ------------------------------------------------------------------ find

	async runFind() {
		const q = this.findQuery[0]().trim();
		const seq = ++this.findSeq;
		if (!q) { batch(() => { this.findHits[1]([]); this.findIndex[1](-1); this.findBusy[1](false); }); return; }
		this.findBusy[1](true);
		try {
			const hits = await this.pdf.search(q, this.findCase[0](), this.findWord[0]());
			if (seq !== this.findSeq) return;
			batch(() => {
				this.findHits[1](hits);
				// start from the first hit at/after the current page
				const cur = this.curPage();
				const i = hits.findIndex((h) => h.page >= cur);
				this.findIndex[1](hits.length ? (i < 0 ? 0 : i) : -1);
			});
			this.focusHit();
		} catch (e) {
			console.error("find failed", e);
		} finally {
			if (seq === this.findSeq) this.findBusy[1](false);
		}
	}
	findStep(dir: 1 | -1) {
		const n = this.findHits[0]().length;
		if (!n) return;
		this.findIndex[1]((i) => (i + dir + n) % n);
		this.focusHit();
	}
	private focusHit() {
		const h = this.findHits[0]()[this.findIndex[0]()];
		if (!h || !h.rects.length) return;
		const r = h.rects[0];
		const { tops, lefts } = this.layout();
		const sc = this.scroller;
		if (!sc) return;
		const b = this.rectToBox(h.page, r);
		const top = tops[h.page] + b.top, bottom = tops[h.page] + b.bottom;
		const left = lefts[h.page] + b.left, right = lefts[h.page] + b.right;
		if (top < sc.scrollTop + 60 || bottom > sc.scrollTop + sc.clientHeight - 60) this.scrollToY(top - sc.clientHeight * 0.35);
		if (left < sc.scrollLeft || right > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = Math.max(0, left - sc.clientWidth * 0.3);
	}
	closeFind() { batch(() => { this.findOpen[1](false); this.findHits[1]([]); this.findIndex[1](-1); }); this.findSeq++; }

	// ------------------------------------------------------------------ view state

	private saveTimer = 0;
	scheduleSave() {
		clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => this.saveNow(false), 700);
	}
	currentState() {
		const page = this.curPage();
		return { page, offset: this.pageFrac(page), zoom: this.zoomVal[0](), zoomMode: this.zoomMode[0](), rotation: this.rotation[0](), pageRotations: this.pageRots[0]() };
	}
	saveNow(keepalive: boolean) {
		clearTimeout(this.saveTimer);
		if (!this.ready[0]()) return;
		void fetch(`/api/attachments/${this.attachmentKey}/view-state`, {
			method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(this.currentState()), keepalive,
		}).catch(() => {});
	}
	restoreState(s: { page?: number; offset?: number; zoom?: number; zoomMode?: ZoomMode; rotation?: number; pageRotations?: Record<string, number> } | null) {
		if (!s) return;
		batch(() => {
			if (typeof s.rotation === "number" && [0, 90, 180, 270].includes(s.rotation)) this.rotation[1](s.rotation);
			if (s.pageRotations && typeof s.pageRotations === "object") {
				const m: Record<number, number> = {};
				for (const [k, v] of Object.entries(s.pageRotations)) if ([90, 180, 270].includes(v as number) && +k >= 0 && +k < this.pages.length) m[+k] = v as number;
				this.pageRots[1](m);
			}
			if (s.zoomMode === "custom" && typeof s.zoom === "number") { this.zoomMode[1]("custom"); this.zoomVal[1](clamp(s.zoom, MIN_ZOOM, MAX_ZOOM)); this.settledZoom[1](this.zoomVal[0]()); }
			else if (s.zoomMode === "page" || s.zoomMode === "width") { this.zoomMode[1](s.zoomMode); this.applyZoomMode(); this.settledZoom[1](this.zoomVal[0]()); }
		});
		if (typeof s.page === "number" && s.page >= 0 && s.page < this.pages.length) {
			const { tops, heights } = this.layout();
			const y = tops[s.page] + (s.offset ?? 0) * heights[s.page];
			this.setScroll(y);
		}
	}

	// ------------------------------------------------------------------ rotation

	/** Rect in unrotated PDF space -> box in CSS px inside the (rotated) page box. */
	rectToBox(page: number, r: PdfRect) {
		const { scale, rots } = this.layout();
		const p = this.pages[page];
		const W = p.width * scale, H = p.height * scale;
		const rot = rots[page] ?? 0;
		const pt = (u: number, v: number): [number, number] =>
			rot === 90 ? [H - v, u] : rot === 180 ? [W - u, H - v] : rot === 270 ? [v, W - u] : [u, v];
		const a = pt(r[0] * scale, (p.height - r[3]) * scale), b = pt(r[2] * scale, (p.height - r[1]) * scale);
		return { left: Math.min(a[0], b[0]), top: Math.min(a[1], b[1]), right: Math.max(a[0], b[0]), bottom: Math.max(a[1], b[1]) };
	}
	private afterRotate(page: number, frac: number) {
		this.applyZoomMode();
		this.restorePageFrac(page, frac);
		this.overlayEpoch[1]((e) => e + 1);
		this.scheduleSave();
	}
	rotateDoc(d: 90 | -90) {
		const page = this.curPage(), frac = this.pageFrac(page);
		this.rotation[1](((this.rotation[0]() + d) % 360 + 360) % 360);
		this.afterRotate(page, frac);
	}
	rotatePages(idx: number[], d: 90 | -90 | 0) {
		const page = this.curPage(), frac = this.pageFrac(page);
		const m = { ...this.pageRots[0]() };
		for (const i of idx) {
			const v = d === 0 ? 0 : (((m[i] ?? 0) + d) % 360 + 360) % 360;
			if (v === 0) delete m[i]; else m[i] = v;
		}
		this.pageRots[1](m);
		this.afterRotate(page, frac);
	}
	showMenu(e: MouseEvent, idx: number[], copyText?: () => string | null) {
		e.preventDefault();
		const n = idx.length > 1 ? idx.length + " pages" : "Page";
		const items: { label: string; onClick: () => void }[] = [];
		const t = copyText?.();
		if (t) items.push({ label: "Copy", onClick: () => void navigator.clipboard.writeText(t).catch(() => {}) });
		items.push(
			{ label: "Rotate " + n + " Left", onClick: () => this.rotatePages(idx, -90) },
			{ label: "Rotate " + n + " Right", onClick: () => this.rotatePages(idx, 90) },
			{ label: "Reset " + n + " Rotation", onClick: () => this.rotatePages(idx, 0) },
			{ label: "Rotate Document Left", onClick: () => this.rotateDoc(-90) },
			{ label: "Rotate Document Right", onClick: () => this.rotateDoc(90) },
		);
		this.menu[1]({ x: e.clientX, y: e.clientY, items });
	}

	destroy() {
		clearTimeout(this.zoomTimer);
		clearTimeout(this.saveTimer);
		void this.pdf.close();
	}
}
