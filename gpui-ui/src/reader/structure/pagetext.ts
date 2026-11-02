// A page's text layer (positioned words, normalised 0..1 from the top-left) as the flat text + per-character PDF rects that the
// reader-next helpers (textlines, citations, mentions, annotations sort index) work on. Characters of a word share the word's
// box evenly (the text layer has word boxes only); spaces and line breaks get empty rects.
import type { PdfRect } from "./types";

export interface PagePt { text: string; rects: PdfRect[] }
export interface LayerWord { t: string; x: number; y: number; w: number; h: number; l: number }

export function buildPageText(words: LayerWord[], pageW: number, pageH: number): PagePt {
	const parts: string[] = [];
	const rects: PdfRect[] = [];
	const none: PdfRect = [0, 0, 0, 0];
	let lastLine = -1;
	let first = true;
	for (const wd of words) {
		if (!wd.t) continue;
		if (!first) { parts.push(wd.l !== lastLine ? "\n" : " "); rects.push(none); }
		first = false;
		lastLine = wd.l;
		const x1 = wd.x * pageW, x2 = (wd.x + wd.w) * pageW, y1 = (1 - wd.y - wd.h) * pageH, y2 = (1 - wd.y) * pageH;
		const n = wd.t.length;
		for (let i = 0; i < n; i++) rects.push([x1 + ((x2 - x1) * i) / n, y1, x1 + ((x2 - x1) * (i + 1)) / n, y2]);
		parts.push(wd.t);
	}
	return { text: parts.join(""), rects };
}

/** A PDF rect (bottom-left origin, points) as a normalised rect of the page (top-left origin, 0..1). */
export function toNRect(r: PdfRect, pageW: number, pageH: number): { x: number; y: number; w: number; h: number } {
	return { x: r[0] / pageW, y: 1 - r[3] / pageH, w: (r[2] - r[0]) / pageW, h: (r[3] - r[1]) / pageH };
}
/** A normalised page rect as a PDF rect. */
export function fromNRect(r: { x: number; y: number; w: number; h: number }, pageW: number, pageH: number): PdfRect {
	return [r.x * pageW, (1 - r.y - r.h) * pageH, (r.x + r.w) * pageW, (1 - r.y) * pageH];
}
