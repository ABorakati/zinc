// Text selection on a bitmap page: hit-testing a point against the text layer's word rects (the web reader gets this from the
// browser's own selection over an invisible text layer; here the page is an image, so the reader does it).
//
// Everything is in page space, unrotated, normalised 0..1 (x, y from the top-left): the same space as Word / NRect in
// plugins.ts. A caret is (page, word index, character offset inside the word); character offsets are interpolated along the word's
// width (exact for monospace, within a glyph or so for proportional text, which is what a drag-select needs).
import type { NRect, Word } from "../plugins";
import type { TextLayer } from "../pdf";

export interface Line {
	l: number;
	first: number;
	last: number;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}
export interface PageText {
	words: Word[];
	lines: Line[];
}
export interface Caret {
	page: number;
	w: number;
	c: number;
}

export function buildPageText(layer: TextLayer): PageText {
	const words = layer.words;
	const lines: Line[] = [];
	let cur: Line | undefined;
	for (let i = 0; i < words.length; i++) {
		const w = words[i]!;
		if (cur && cur.l === w.l) {
			cur.last = i;
			cur.x0 = Math.min(cur.x0, w.x);
			cur.y0 = Math.min(cur.y0, w.y);
			cur.x1 = Math.max(cur.x1, w.x + w.w);
			cur.y1 = Math.max(cur.y1, w.y + w.h);
		} else {
			if (cur) lines.push(cur);
			cur = { l: w.l, first: i, last: i, x0: w.x, y0: w.y, x1: w.x + w.w, y1: w.y + w.h };
		}
	}
	if (cur) lines.push(cur);
	return { words, lines };
}

export const cmpCaret = (a: Caret, b: Caret): number => a.page - b.page || a.w - b.w || a.c - b.c;
export const sameCaret = (a: Caret, b: Caret): boolean => a.page === b.page && a.w === b.w && a.c === b.c;

/** Caret nearest to the page point (nx, ny); null when the page has no text. */
export function caretAt(pt: PageText, page: number, nx: number, ny: number): Caret | null {
	if (!pt.lines.length) return null;
	let best: Line | undefined,
		bs = Infinity;
	for (const L of pt.lines) {
		const dy = ny < L.y0 ? L.y0 - ny : ny > L.y1 ? ny - L.y1 : 0;
		const dx = nx < L.x0 ? L.x0 - nx : nx > L.x1 ? nx - L.x1 : 0;
		const s = dy * 4 + dx; // inside a line's band beats a nearer line; between columns the nearer column wins
		if (s < bs) {
			bs = s;
			best = L;
		}
	}
	const L = best!;
	// word under / nearest to x within the line
	let wi = L.first,
		bd = Infinity;
	for (let i = L.first; i <= L.last; i++) {
		const w = pt.words[i]!;
		const d = nx < w.x ? w.x - nx : nx > w.x + w.w ? nx - (w.x + w.w) : 0;
		if (d < bd) {
			bd = d;
			wi = i;
			if (d === 0) break;
		}
	}
	const w = pt.words[wi]!;
	const len = Array.from(w.t).length;
	const f = w.w > 0 ? (nx - w.x) / w.w : 0;
	return { page, w: wi, c: Math.max(0, Math.min(len, Math.round(f * len))) };
}

/** The word under a caret as [start, end] carets (double-click). */
export function wordAt(pt: PageText, c: Caret): [Caret, Caret] {
	const w = pt.words[c.w];
	return [
		{ page: c.page, w: c.w, c: 0 },
		{ page: c.page, w: c.w, c: w ? Array.from(w.t).length : 0 },
	];
}
/** The visual line under a caret (triple-click). */
export function lineAt(pt: PageText, c: Caret): [Caret, Caret] {
	const L = pt.lines.find((l) => c.w >= l.first && c.w <= l.last);
	if (!L) return wordAt(pt, c);
	return [
		{ page: c.page, w: L.first, c: 0 },
		{ page: c.page, w: L.last, c: Array.from(pt.words[L.last]!.t).length },
	];
}

const slice = (t: string, a: number, b: number): string => {
	const cs = Array.from(t);
	return cs.slice(a, b).join("");
};

/** Word index range [from, to] a selection covers on one page, with the character cuts of its first and last word. */
function pageSpan(pt: PageText, page: number, a: Caret, b: Caret): { from: number; to: number; c0: number; c1: number } | null {
	if (!pt.words.length) return null;
	const first = page === a.page,
		last = page === b.page;
	const from = first ? a.w : 0,
		to = last ? b.w : pt.words.length - 1;
	if (from > to) return null;
	const c0 = first ? a.c : 0;
	const c1 = last ? b.c : Array.from(pt.words[to]!.t).length;
	if (from === to && c0 >= c1) return null;
	return { from, to, c0, c1 };
}

/** The selected rects of one page, merged per visual line. `a` <= `b`. */
export function selectionRects(pt: PageText, page: number, a: Caret, b: Caret): NRect[] {
	const sp = pageSpan(pt, page, a, b);
	if (!sp) return [];
	const out: NRect[] = [];
	let cur: (NRect & { l: number }) | undefined;
	for (let i = sp.from; i <= sp.to; i++) {
		const w = pt.words[i]!;
		const len = Math.max(1, Array.from(w.t).length);
		const s = i === sp.from ? sp.c0 / len : 0;
		const e = i === sp.to ? sp.c1 / len : 1;
		if (e <= s) continue;
		const x = w.x + w.w * s,
			ww = w.w * (e - s);
		if (cur && cur.l === w.l) {
			const x2 = Math.max(cur.x + cur.w, x + ww),
				y1 = Math.min(cur.y, w.y),
				y2 = Math.max(cur.y + cur.h, w.y + w.h);
			cur = { x: Math.min(cur.x, x), y: y1, w: x2 - Math.min(cur.x, x), h: y2 - y1, l: w.l };
		} else {
			if (cur) out.push({ x: cur.x, y: cur.y, w: cur.w, h: cur.h });
			cur = { x, y: w.y, w: ww, h: w.h, l: w.l };
		}
	}
	if (cur) out.push({ x: cur.x, y: cur.y, w: cur.w, h: cur.h });
	return out;
}

/** The selected text of one page: words joined by spaces, a line break between visual lines (hyphenated line ends are rejoined). */
export function selectionText(pt: PageText, page: number, a: Caret, b: Caret): string {
	const sp = pageSpan(pt, page, a, b);
	if (!sp) return "";
	let out = "";
	let prev: Word | undefined;
	for (let i = sp.from; i <= sp.to; i++) {
		const w = pt.words[i]!;
		const len = Array.from(w.t).length;
		const t = slice(w.t, i === sp.from ? sp.c0 : 0, i === sp.to ? sp.c1 : len);
		if (!t) continue;
		if (prev) {
			if (prev.l !== w.l) {
				if (/[a-z]-$/.test(out) && /^[a-z]/.test(t))
					out = out.slice(0, -1); // "inter-" / "national" -> "international"
				else out += "\n";
			} else out += " ";
		}
		out += t;
		prev = w;
	}
	return out;
}

/** Rotate a normalised rect from unrotated page space into the page as displayed (rot clockwise: 0, 90, 180, 270). */
export function rotRect(r: NRect, rot: number): NRect {
	switch (((rot % 360) + 360) % 360) {
		case 90:
			return { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w };
		case 180:
			return { x: 1 - r.x - r.w, y: 1 - r.y - r.h, w: r.w, h: r.h };
		case 270:
			return { x: r.y, y: 1 - r.x - r.w, w: r.h, h: r.w };
		default:
			return r;
	}
}
/** Inverse of rotRect for a point: displayed page space -> unrotated page space. */
export function unrotPoint(x: number, y: number, rot: number): [number, number] {
	switch (((rot % 360) + 360) % 360) {
		case 90:
			return [y, 1 - x];
		case 180:
			return [1 - x, 1 - y];
		case 270:
			return [1 - y, x];
		default:
			return [x, y];
	}
}
/** Rotate a point from unrotated into displayed page space. */
export function rotPoint(x: number, y: number, rot: number): [number, number] {
	switch (((rot % 360) + 360) % 360) {
		case 90:
			return [1 - y, x];
		case 180:
			return [1 - x, 1 - y];
		case 270:
			return [y, 1 - x];
		default:
			return [x, y];
	}
}
