// src/reader/pdf.ts for the browser demo: the same PdfDoc interface, on PDFium compiled to WebAssembly (@embedpdf/pdfium) instead
// of zn_pdf.dll. web/build.ts maps the reader's `./pdf` imports here. It follows zn_pdf's contract (native/pdf/src/lib.rs, nav.rs):
// sizes in points with the page rotation applied, BGRA bitmaps sized like geometry() there, the same page-appearance recolouring
// (to_bgra), and a text layer / links / outline with fractions of the page, origin top-left. Rendering runs on the main thread
// (one page at a time, behind a timer so the UI keeps drawing); there is no page editing or printing in the browser.
//
// initPdfium() must have finished before a document is opened (web/main.tsx awaits it in the reader's file fetcher).
import { init } from "@embedpdf/pdfium";

type Mod = Awaited<ReturnType<typeof init>>;
let mod: Mod | null = null;
let loading: Promise<void> | null = null;

/** Load PDFium (pdfium.wasm next to the bundle) once; later calls return the same promise. */
export function initPdfium(bytes?: ArrayBuffer): Promise<void> {
	loading ??= (async () => {
		const wasmBinary = bytes ?? await (await fetch(new URL("pdfium.wasm", import.meta.url))).arrayBuffer();
		mod = await init({ wasmBinary });
		mod.PDFiumExt_Init();
	})();
	return loading;
}
const M = (): Mod => { if (!mod) throw new Error("PDFium is still loading"); return mod; };
const raw = () => M().pdfium as unknown as { HEAPU8: Uint8Array; HEAPF32: Float32Array; HEAPF64: Float64Array; HEAP32: Int32Array; wasmExports: { malloc(n: number): number; free(p: number): void }; UTF16ToString(p: number, max?: number): string; UTF8ToString(p: number): string };
const fn = (name: string) => (M() as unknown as Record<string, (...a: unknown[]) => number>)[name]!;
const malloc = (n: number) => raw().wasmExports.malloc(n);
const free = (p: number) => raw().wasmExports.free(p);

export const findDll = (): string => "pdfium.wasm";
export const pdfOpsUnavailable = (): string | null => "Page editing and printing need the desktop app.";
export const nativeVersion = (): string => "pdfium-wasm";
export const pdfiumStatus = (): string => (mod ? "PDFium (WebAssembly)" : "PDFium (WebAssembly) not loaded yet");
export interface PdfEdit { rotate?: { page: number; turns: number }[]; delete?: number[] }
export async function editPdf(_bytes: Uint8Array, _e: PdfEdit): Promise<Uint8Array> { throw new Error("Page editing needs the desktop app."); }
export interface PrintResult { result: "printed" | "cancelled"; pages: number; printer: string }
export async function printPdf(): Promise<PrintResult> { throw new Error("Printing needs the desktop app."); }
export async function printPdfTo(): Promise<PrintResult> { throw new Error("Printing needs the desktop app."); }

export interface TextWord { t: string; x: number; y: number; w: number; h: number; l: number }
export interface TextLayer { pw: number; ph: number; words: TextWord[] }
export interface Look { mode: 0 | 1 | 2 | 3 | 4; c0?: number; c1?: number }
export const PRIO_BACKGROUND = 4e6;
export interface RenderOpts { rot?: number; region?: { x: number; y: number; w: number; h: number }; look?: Look; prio?: number }
export interface OutlineEntry { t: string; l: number; p: number; y: number }
export type PdfLink = { x: number; y: number; w: number; h: number } & ({ k: "page"; p: number; ty: number } | { k: "uri"; u: string });
export interface Rendered { width: number; height: number; pixels: Uint8Array; renderMs: number; slice(y: number, h: number): Uint8Array; release(): void }
export interface RenderTask { promise: Promise<Rendered | null>; cancel(): void; setPrio(prio: number): void }

const MAX_SIDE = 16384;
function geometry(pw: number, ph: number, scale: number, rot: number, region?: RenderOpts["region"]) {
	const r = ((rot % 360) + 360) % 360;
	const [bw, bh] = r % 180 === 0 ? [pw, ph] : [ph, pw];
	let s = Number.isFinite(scale) && scale > 0 ? scale : 1;
	const side = Math.max(bw, bh) * s;
	if (side > MAX_SIDE) s = (s * MAX_SIDE) / side;
	const fw = Math.max(1, Math.trunc(bw * s) & 0xffff), fh = Math.max(1, Math.trunc(bh * s) & 0xffff);
	if (!region || !region.w || !region.h) return { r, fw, fh, rx: 0, ry: 0, rw: fw, rh: fh };
	const rx = Math.min(region.x, fw - 1), ry = Math.min(region.y, fh - 1);
	return { r, fw, fh, rx, ry, rw: Math.min(region.w, fw - rx), rh: Math.min(region.h, fh - ry) };
}

/** zn_pdf's to_bgra for looks 1..4, on BGRA pixels in place. */
function recolour(buf: Uint8Array, look: Look): void {
	if (!look.mode) return;
	const rgb = (c = 0) => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
	const k0 = rgb(look.c0), k1 = rgb(look.c1);
	const dark = (r0: number, g0: number, b0: number, a: number) => {
		const inv = (c: number) => a * (1 - c) + (1 - a) * c;
		const r = inv(r0), g = inv(g0), b = inv(b0);
		const cl = (v: number) => Math.min(1, Math.max(0, v));
		return [cl(-0.574 * r + 1.43 * g + 0.144 * b), cl(0.426 * r + 0.43 * g + 0.144 * b), cl(0.426 * r + 1.43 * g - 0.856 * b)];
	};
	for (let i = 0; i < buf.length; i += 4) {
		const r = buf[i + 2]! / 255, g = buf[i + 1]! / 255, b = buf[i]! / 255;
		let o: number[];
		if (look.mode === 1) o = dark(r, g, b, 0.92);
		else if (look.mode === 2) o = [r * k0[0]!, g * k0[1]!, b * k0[2]!];
		else if (look.mode === 3) { const d = dark(r, g, b, 1); o = [1 - (1 - d[0]!) * (1 - k0[0]!), 1 - (1 - d[1]!) * (1 - k0[1]!), 1 - (1 - d[2]!) * (1 - k0[2]!)]; }
		else { const l = 0.2126 * r + 0.7152 * g + 0.0722 * b; o = [k0[0]! + (k1[0]! - k0[0]!) * l, k0[1]! + (k1[1]! - k0[1]!) * l, k0[2]! + (k1[2]! - k0[2]!) * l]; }
		buf[i] = (o[2]! * 255 + 0.5) | 0; buf[i + 1] = (o[1]! * 255 + 0.5) | 0; buf[i + 2] = (o[0]! * 255 + 0.5) | 0; buf[i + 3] = 255;
	}
}

// one job at a time, lowest priority first, behind a timer so frames keep painting between pages
interface Job { prio: number; run: () => void; cancelled: boolean; done: boolean }
const queue: Job[] = [];
let ticking = false;
function pump(): void {
	ticking = false;
	queue.sort((a, b) => a.prio - b.prio);
	const job = queue.shift();
	if (job && !job.cancelled) { job.done = true; job.run(); }
	if (queue.length && !ticking) { ticking = true; setTimeout(pump, 0); }
}
function enqueue(prio: number, run: () => void): Job {
	const job: Job = { prio, run, cancelled: false, done: false };
	queue.push(job);
	if (!ticking) { ticking = true; setTimeout(pump, 0); }
	return job;
}

export class PdfDoc {
	readonly pageCount: number;
	readonly sizes: [number, number][];
	private doc: number;
	private dataPtr: number;

	private constructor(doc: number, dataPtr: number) {
		this.doc = doc;
		this.dataPtr = dataPtr;
		this.pageCount = fn("FPDF_GetPageCount")(doc);
		this.sizes = [];
		const out = malloc(16);
		for (let i = 0; i < this.pageCount; i++) {
			fn("FPDF_GetPageSizeByIndexF")(doc, i, out);
			const f = raw().HEAPF32;
			this.sizes.push([f[out >> 2]!, f[(out >> 2) + 1]!]);
		}
		free(out);
	}

	static open(path: string): PdfDoc { throw new Error(`no file system in the browser demo: ${path}`); }

	static openBytes(data: Uint8Array): PdfDoc {
		const p = malloc(data.byteLength);
		raw().HEAPU8.set(data, p);
		const doc = fn("FPDF_LoadMemDocument")(p, data.byteLength, "");
		if (!doc) { free(p); throw new Error(`PDFium could not open the PDF (error ${fn("FPDF_GetLastError")()})`); }
		return new PdfDoc(doc, p);
	}

	private withPage<T>(i: number, f: (page: number) => T): T {
		const page = fn("FPDF_LoadPage")(this.doc, i);
		if (!page) throw new Error(`cannot load page ${i + 1}`);
		try { return f(page); } finally { fn("FPDF_ClosePage")(page); }
	}

	renderSize(page: number, scale: number): [number, number] { return this.renderSize2(page, scale, 0); }
	renderSize2(page: number, scale: number, rot = 0): [number, number] {
		const [pw, ph] = this.sizes[page] ?? [612, 792];
		const g = geometry(pw, ph, scale, rot);
		return [g.fw, g.fh];
	}

	private draw(page: number, scale: number, o: RenderOpts): Rendered {
		const t0 = performance.now();
		const [pw, ph] = this.sizes[page] ?? [612, 792];
		const g = geometry(pw, ph, scale, o.rot ?? 0, o.region);
		const bmp = fn("FPDFBitmap_Create")(g.rw, g.rh, 0);
		fn("FPDFBitmap_FillRect")(bmp, 0, 0, g.rw, g.rh, 0xffffffff);
		// FPDF_ANNOT | FPDF_LCD_TEXT off | FPDF_REVERSE_BYTE_ORDER off: BGRA, annotations drawn like the desktop
		this.withPage(page, (p) => fn("FPDF_RenderPageBitmap")(bmp, p, -g.rx, -g.ry, g.fw, g.fh, g.r / 90, 0x01));
		const buf = fn("FPDFBitmap_GetBuffer")(bmp);
		const stride = fn("FPDFBitmap_GetStride")(bmp);
		const pixels = new Uint8Array(g.rw * g.rh * 4);
		const heap = raw().HEAPU8;
		for (let y = 0; y < g.rh; y++) pixels.set(heap.subarray(buf + y * stride, buf + y * stride + g.rw * 4), y * g.rw * 4);
		fn("FPDFBitmap_Destroy")(bmp);
		for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
		if (o.look) recolour(pixels, o.look);
		const width = g.rw, height = g.rh;
		return {
			width, height, pixels, renderMs: performance.now() - t0,
			slice: (y, h) => pixels.subarray(y * width * 4, (y + Math.min(h, height - y)) * width * 4),
			release: () => {},
		};
	}

	render(page: number, scale: number): RenderTask { return this.render3(page, scale, {}); }
	render2(page: number, scale: number, o: RenderOpts = {}): RenderTask { return this.render3(page, scale, o); }
	render3(page: number, scale: number, o: RenderOpts = {}): RenderTask {
		let job!: Job;
		const promise = new Promise<Rendered | null>((res, rej) => {
			job = enqueue(o.prio ?? PRIO_BACKGROUND, () => { try { res(this.draw(page, scale, o)); } catch (e) { rej(e); } });
			const cancel = job;
			(job as Job & { resolveNull?: () => void }).resolveNull = () => { if (!cancel.done) { cancel.cancelled = true; res(null); } };
		});
		return {
			promise,
			cancel: () => (job as Job & { resolveNull?: () => void }).resolveNull?.(),
			setPrio: (p) => { if (!job.done) job.prio = p; },
		};
	}
	renderAsync(page: number, scale: number): Promise<Rendered | null> { return this.render(page, scale).promise; }
	renderSync(page: number, scale: number): Rendered { return this.draw(page, scale, {}); }

	pageRotation(page: number): number { return this.withPage(page, (p) => (fn("FPDFPage_GetRotation")(p) % 4) * 90); }
	backend(): "pdfium" | "hayro" { return "pdfium"; }
	poolSize(): number { return 1; }

	textLayer(page: number): TextLayer {
		const [pw, ph] = this.sizes[page] ?? [612, 792];
		return this.withPage(page, (p) => {
			const tp = fn("FPDFText_LoadPage")(p);
			const n = fn("FPDFText_CountChars")(tp);
			const box = malloc(32);
			const words: TextWord[] = [];
			let cur: { t: string; l: number; r: number; b: number; tp: number } | null = null;
			let line = 0, lastMid = Number.NaN, lastRight = -Infinity, lastH = 0;
			const flush = () => {
				if (cur && cur.t.trim()) words.push({ t: cur.t, x: cur.l / pw, y: (ph - cur.tp) / ph, w: (cur.r - cur.l) / pw, h: (cur.tp - cur.b) / ph, l: line });
				cur = null;
			};
			for (let i = 0; i < n; i++) {
				const c = fn("FPDFText_GetUnicode")(tp, i);
				if (c === 10 || c === 13) { flush(); if (c === 10) { line++; lastMid = Number.NaN; } continue; }
				if (c === 32 || c === 9 || c === 0xa0 || c === 0xfffe || c === 2) { flush(); continue; }
				if (!fn("FPDFText_GetCharBox")(tp, i, box, box + 8, box + 16, box + 24)) continue;
				const d = raw().HEAPF64;
				const l = d[box >> 3]!, r = d[(box >> 3) + 1]!, b = d[(box >> 3) + 2]!, t = d[(box >> 3) + 3]!;
				const mid = (t + b) / 2, h = Math.max(t - b, 0.1);
				// a new line: the baseline moved by more than half a glyph, or the text jumped back to the left
				if (!Number.isNaN(lastMid) && (Math.abs(mid - lastMid) > Math.max(h, lastH) * 0.6 || l < lastRight - Math.max(h, lastH) * 2)) { flush(); line++; }
				lastMid = mid; lastRight = r; lastH = h;
				const ch = String.fromCodePoint(c);
				if (!cur) cur = { t: ch, l, r, b, tp: t };
				else { cur.t += ch; cur.l = Math.min(cur.l, l); cur.r = Math.max(cur.r, r); cur.b = Math.min(cur.b, b); cur.tp = Math.max(cur.tp, t); }
			}
			flush();
			free(box);
			fn("FPDFText_ClosePage")(tp);
			return { pw, ph, words };
		});
	}
	textLayerAsync(page: number): Promise<TextLayer> { return new Promise((res, rej) => enqueue(PRIO_BACKGROUND / 2, () => { try { res(this.textLayer(page)); } catch (e) { rej(e); } })); }

	private destOf(dest: number): { p: number; y: number } {
		const p = dest ? fn("FPDFDest_GetDestPageIndex")(this.doc, dest) : -1;
		if (p < 0) return { p: -1, y: -1 };
		const has = malloc(12), xy = malloc(24);
		let y = -1;
		if (fn("FPDFDest_GetLocationInPage")(dest, has, has + 4, has + 8, xy, xy + 4, xy + 8) && raw().HEAP32[(has >> 2) + 1]) {
			const ph = this.sizes[p]?.[1] ?? 792;
			y = Math.min(1, Math.max(0, (ph - raw().HEAPF32[(xy >> 2) + 1]!) / ph));
		}
		free(has); free(xy);
		return { p, y };
	}

	linksAsync(page: number): Promise<PdfLink[]> {
		return Promise.resolve().then(() => this.withPage(page, (p) => {
			const [pw, ph] = this.sizes[page] ?? [612, 792];
			const pos = malloc(4), link = malloc(4), rect = malloc(16);
			raw().HEAP32[pos >> 2] = 0;
			const out: PdfLink[] = [];
			while (fn("FPDFLink_Enumerate")(p, pos, link)) {
				const l = raw().HEAP32[link >> 2]!;
				if (!fn("FPDFLink_GetAnnotRect")(l, rect)) continue;
				const f = raw().HEAPF32, i = rect >> 2;
				const left = f[i]!, top = f[i + 1]!, right = f[i + 2]!, bottom = f[i + 3]!;
				const box = { x: Math.min(left, right) / pw, y: (ph - Math.max(top, bottom)) / ph, w: Math.abs(right - left) / pw, h: Math.abs(top - bottom) / ph };
				let dest = fn("FPDFLink_GetDest")(this.doc, l);
				const action = fn("FPDFLink_GetAction")(l);
				if (!dest && action) {
					const type = fn("FPDFAction_GetType")(action);
					if (type === 3) { // URI
						const n = fn("FPDFAction_GetURIPath")(this.doc, action, 0, 0);
						const b = malloc(n);
						fn("FPDFAction_GetURIPath")(this.doc, action, b, n);
						const u = raw().UTF8ToString(b);
						free(b);
						if (u) out.push({ ...box, k: "uri", u });
						continue;
					}
					if (type === 1) dest = fn("FPDFAction_GetDest")(this.doc, action);
				}
				if (dest) { const d = this.destOf(dest); if (d.p >= 0) out.push({ ...box, k: "page", p: d.p, ty: d.y }); }
			}
			free(pos); free(link); free(rect);
			return out;
		}));
	}

	outlineAsync(): Promise<OutlineEntry[]> {
		return Promise.resolve().then(() => {
			const out: OutlineEntry[] = [];
			const walk = (bm: number, level: number) => {
				for (let b = bm; b; b = fn("FPDFBookmark_GetNextSibling")(this.doc, b)) {
					const n = fn("FPDFBookmark_GetTitle")(b, 0, 0);
					const buf = malloc(n);
					fn("FPDFBookmark_GetTitle")(b, buf, n);
					const t = raw().UTF16ToString(buf);
					free(buf);
					let dest = fn("FPDFBookmark_GetDest")(this.doc, b);
					if (!dest) { const a = fn("FPDFBookmark_GetAction")(b); if (a && fn("FPDFAction_GetType")(a) === 1) dest = fn("FPDFAction_GetDest")(this.doc, a); }
					const d = this.destOf(dest);
					out.push({ t, l: level, p: d.p, y: d.y });
					walk(fn("FPDFBookmark_GetFirstChild")(this.doc, b), level + 1);
				}
			};
			walk(fn("FPDFBookmark_GetFirstChild")(this.doc, 0), 0);
			return out;
		});
	}

	clearCache(): void {}
	close(): void {
		if (!this.doc) return;
		fn("FPDF_CloseDocument")(this.doc);
		free(this.dataPtr);
		this.doc = 0;
	}
}
