// Crops of a page (figure / table previews, annotation image areas): the plugins open their own PdfDoc over ctx.pdfBytes() (one
// extra copy of the file in the native worker) and render the page, then cut the region out as BGRA pixels for <img>.setImagePixels.
// Renders are queued two at a time and the crops are cached (small LRU).
import type { ReaderContext } from "../plugins";
import { PdfDoc } from "../pdf";
import type { PdfRect } from "./types";

export interface Crop { width: number; height: number; pixels: Uint8Array }

interface Entry { doc: Promise<PdfDoc | null>; running: number; waiting: (() => void)[]; cache: Map<string, Promise<Crop | null>> }
const entries = new Map<string, Entry>();
const MAX_CACHE = 48;

function entryFor(ctx: ReaderContext): Entry {
	let e = entries.get(ctx.attachmentKey);
	if (!e) {
		e = { doc: ctx.pdfBytes().then((b) => PdfDoc.openBytes(b)).catch((err) => { console.warn("[regions] cannot open the PDF:", (err as Error).message); return null; }), running: 0, waiting: [], cache: new Map() };
		entries.set(ctx.attachmentKey, e);
	}
	return e;
}

/** Free the region renderer of a document (call when it closes). */
export function closeRegions(attachmentKey: string): void {
	const e = entries.get(attachmentKey);
	if (!e) return;
	entries.delete(attachmentKey);
	void e.doc.then((d) => d?.close());
}

async function slot(e: Entry): Promise<() => void> {
	while (e.running >= 2) await new Promise<void>((r) => e.waiting.push(r));
	e.running++;
	return () => { e.running--; e.waiting.shift()?.(); };
}

/**
 * The part `rect` (PDF points, bottom-left origin) of a page, about `width` px wide (at most; never upscaled past 3x).
 * Resolves null when the document cannot be opened or the rect is empty.
 */
export function renderRegion(ctx: ReaderContext, page: number, rect: PdfRect, width: number): Promise<Crop | null> {
	const e = entryFor(ctx);
	const key = `${page}|${rect.map((n) => Math.round(n)).join(",")}|${Math.round(width)}`;
	let p = e.cache.get(key);
	if (p) return p;
	p = (async () => {
		const doc = await e.doc;
		if (!doc || page < 0 || page >= doc.pageCount) return null;
		const [pw, ph] = doc.sizes[page]!;
		const x1 = Math.max(0, Math.min(rect[0], rect[2])), x2 = Math.min(pw, Math.max(rect[0], rect[2]));
		const y1 = Math.max(0, Math.min(rect[1], rect[3])), y2 = Math.min(ph, Math.max(rect[1], rect[3]));
		if (x2 - x1 < 2 || y2 - y1 < 2) return null;
		const scale = Math.min(3, Math.max(0.3, width / (x2 - x1)));
		const release = await slot(e);
		try {
			const r = await doc.renderAsync(page, scale);
			if (!r) return null;
			try {
				const sx = r.width / pw, sy = r.height / ph;
				const cx = Math.floor(x1 * sx), cw = Math.max(1, Math.min(r.width - cx, Math.ceil((x2 - x1) * sx)));
				const cy = Math.floor((ph - y2) * sy), ch = Math.max(1, Math.min(r.height - cy, Math.ceil((y2 - y1) * sy)));
				const out = new Uint8Array(cw * ch * 4);
				for (let row = 0; row < ch; row++) {
					const from = ((cy + row) * r.width + cx) * 4;
					out.set(r.pixels.subarray(from, from + cw * 4), row * cw * 4);
				}
				return { width: cw, height: ch, pixels: out };
			} finally { r.release(); }
		} finally { release(); }
	})().catch((err) => { console.warn("[regions] render failed:", (err as Error).message); return null; });
	e.cache.set(key, p);
	if (e.cache.size > MAX_CACHE) e.cache.delete(e.cache.keys().next().value!);
	return p;
}
