// PDFium compiled to WebAssembly (@embedpdf/pdfium), the parts shared by the page (web/pdf.ts) and the render workers
// (web/pdf-worker.ts): loading the engine, opening a document from bytes, drawing a page into BGRA pixels and reading a page's text
// layer. It follows zn_pdf's contract (native/pdf/src/lib.rs, nav.rs): sizes in points with the page rotation applied, BGRA bitmaps
// sized like geometry() there, the same page-appearance recolouring (to_bgra), text with fractions of the page, origin top-left.
import { init } from "@embedpdf/pdfium";

type Mod = Awaited<ReturnType<typeof init>>;
let mod: Mod | null = null;
let loading: Promise<void> | null = null;

/** Load PDFium once (`wasm`: the bytes, or the URL of pdfium.wasm); later calls return the same promise. */
export function initEngine(wasm: ArrayBuffer | string): Promise<void> {
	loading ??= (async () => {
		const wasmBinary = typeof wasm === "string" ? await (await fetch(wasm)).arrayBuffer() : wasm;
		mod = await init({ wasmBinary });
		mod.PDFiumExt_Init();
	})();
	return loading;
}
export const engineReady = (): boolean => !!mod;
const M = (): Mod => { if (!mod) throw new Error("PDFium is still loading"); return mod; };
const raw = () => M().pdfium as unknown as { HEAPU8: Uint8Array; HEAPF32: Float32Array; HEAPF64: Float64Array; HEAP32: Int32Array; wasmExports: { malloc(n: number): number; free(p: number): void }; UTF16ToString(p: number, max?: number): string; UTF8ToString(p: number): string };
export const fn = (name: string) => (M() as unknown as Record<string, (...a: unknown[]) => number>)[name]!;
export const malloc = (n: number) => raw().wasmExports.malloc(n);
export const free = (p: number) => raw().wasmExports.free(p);
export const heap = () => raw();

export interface TextWord { t: string; x: number; y: number; w: number; h: number; l: number }
export interface TextLayer { pw: number; ph: number; words: TextWord[] }
export interface Look { mode: 0 | 1 | 2 | 3 | 4; c0?: number; c1?: number }
export interface DrawOpts { rot?: number; region?: { x: number; y: number; w: number; h: number }; look?: Look }
export interface Drawn { width: number; height: number; pixels: Uint8Array; renderMs: number }

/** An open document: the PDFium handle, the copy of its bytes in the engine's memory, and the page sizes. */
export interface DocHandle { doc: number; dataPtr: number; pageCount: number; sizes: [number, number][] }

export function openDoc(data: Uint8Array): DocHandle {
	const p = malloc(data.byteLength);
	raw().HEAPU8.set(data, p);
	const doc = fn("FPDF_LoadMemDocument")(p, data.byteLength, "");
	if (!doc) { free(p); throw new Error(`PDFium could not open the PDF (error ${fn("FPDF_GetLastError")()})`); }
	const pageCount = fn("FPDF_GetPageCount")(doc);
	const sizes: [number, number][] = [];
	const out = malloc(16);
	for (let i = 0; i < pageCount; i++) {
		fn("FPDF_GetPageSizeByIndexF")(doc, i, out);
		const f = raw().HEAPF32;
		sizes.push([f[out >> 2]!, f[(out >> 2) + 1]!]);
	}
	free(out);
	return { doc, dataPtr: p, pageCount, sizes };
}

export function closeDoc(h: DocHandle): void {
	if (!h.doc) return;
	fn("FPDF_CloseDocument")(h.doc);
	free(h.dataPtr);
	h.doc = 0;
}

export function withPage<T>(h: DocHandle, i: number, f: (page: number) => T): T {
	const page = fn("FPDF_LoadPage")(h.doc, i);
	if (!page) throw new Error(`cannot load page ${i + 1}`);
	try { return f(page); } finally { fn("FPDF_ClosePage")(page); }
}

const MAX_SIDE = 16384;
export function geometry(pw: number, ph: number, scale: number, rot: number, region?: DrawOpts["region"]) {
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
export function recolour(buf: Uint8Array, look: Look): void {
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

/** Draw one page (or a region of it) at `scale` into BGRA pixels. */
export function drawPage(h: DocHandle, page: number, scale: number, o: DrawOpts): Drawn {
	const t0 = performance.now();
	const [pw, ph] = h.sizes[page] ?? [612, 792];
	const g = geometry(pw, ph, scale, o.rot ?? 0, o.region);
	const bmp = fn("FPDFBitmap_Create")(g.rw, g.rh, 0);
	fn("FPDFBitmap_FillRect")(bmp, 0, 0, g.rw, g.rh, 0xffffffff);
	// FPDF_ANNOT | FPDF_LCD_TEXT off | FPDF_REVERSE_BYTE_ORDER off: BGRA, annotations drawn like the desktop
	withPage(h, page, (p) => fn("FPDF_RenderPageBitmap")(bmp, p, -g.rx, -g.ry, g.fw, g.fh, g.r / 90, 0x01));
	const buf = fn("FPDFBitmap_GetBuffer")(bmp);
	const stride = fn("FPDFBitmap_GetStride")(bmp);
	const pixels = new Uint8Array(g.rw * g.rh * 4);
	const mem = raw().HEAPU8;
	for (let y = 0; y < g.rh; y++) pixels.set(mem.subarray(buf + y * stride, buf + y * stride + g.rw * 4), y * g.rw * 4);
	fn("FPDFBitmap_Destroy")(bmp);
	for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
	if (o.look) recolour(pixels, o.look);
	return { width: g.rw, height: g.rh, pixels, renderMs: performance.now() - t0 };
}

/** The page's words with their boxes (fractions of the page) and line numbers. */
export function pageText(h: DocHandle, page: number): TextLayer {
	const [pw, ph] = h.sizes[page] ?? [612, 792];
	return withPage(h, page, (p) => {
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
			const mid = (t + b) / 2, hh = Math.max(t - b, 0.1);
			// a new line: the baseline moved by more than half a glyph, or the text jumped back to the left
			if (!Number.isNaN(lastMid) && (Math.abs(mid - lastMid) > Math.max(hh, lastH) * 0.6 || l < lastRight - Math.max(hh, lastH) * 2)) { flush(); line++; }
			lastMid = mid; lastRight = r; lastH = hh;
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
