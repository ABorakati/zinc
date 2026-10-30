// Line reconstruction from a page's text + per-character rects (ViewerHandle.pageText).
// Pure (no DOM) so it can be unit-tested with synthetic pages.
import type { PdfRect } from "../contract";

export interface Line {
	start: number; // index of first char in the page text
	end: number; // exclusive
	text: string;
	x1: number;
	x2: number;
	y1: number; // bottom
	y2: number; // top
}

const hasGeometry = (r: PdfRect | undefined): r is PdfRect => !!r && r[3] - r[1] > 0.01 && r[2] - r[0] >= 0;

export function unionRects(rects: PdfRect[]): PdfRect | null {
	let out: PdfRect | null = null;
	for (const r of rects) {
		if (!out) out = [r[0], r[1], r[2], r[3]];
		else {
			out[0] = Math.min(out[0], r[0]);
			out[1] = Math.min(out[1], r[1]);
			out[2] = Math.max(out[2], r[2]);
			out[3] = Math.max(out[3], r[3]);
		}
	}
	return out;
}

/** Split page text into visual lines (text order is preserved; columns stay separate when the text order is column-wise). */
export function computeLines(text: string, rects: PdfRect[]): Line[] {
	const lines: Line[] = [];
	let cur: Line | null = null;
	let pending = -1; // first geometry-less visible char of a line that has not started yet (e.g. a glyph with a degenerate rect)
	const close = (endIdx: number) => {
		pending = -1;
		if (cur) {
			cur.end = endIdx;
			cur.text = text.slice(cur.start, cur.end).replace(/[\r\n]+/g, " ");
			if (cur.text.trim()) lines.push(cur);
			cur = null;
		}
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (ch === "\n" || ch === "\r") {
			close(i);
			continue;
		}
		const r = rects[i];
		if (!hasGeometry(r)) {
			if (cur && /\S/.test(ch)) cur.end = i + 1;
			else if (!cur && pending < 0 && /\S/.test(ch)) pending = i;
			continue;
		}
		if (cur) {
			const h = Math.min(r[3] - r[1], cur.y2 - cur.y1);
			const overlap = Math.min(r[3], cur.y2) - Math.max(r[1], cur.y1);
			if (overlap < 0.45 * h) close(i);
		}
		if (!cur) cur = { start: pending >= 0 ? pending : i, end: i + 1, text: "", x1: r[0], x2: r[2], y1: r[1], y2: r[3] };
		else {
			cur.x1 = Math.min(cur.x1, r[0]);
			cur.x2 = Math.max(cur.x2, r[2]);
			cur.y1 = Math.min(cur.y1, r[1]);
			cur.y2 = Math.max(cur.y2, r[3]);
			cur.end = i + 1;
		}
	}
	close(text.length);
	return lines;
}

export function lineRect(l: Line): PdfRect {
	return [l.x1, l.y1, l.x2, l.y2];
}

/** Collapse whitespace and join hyphenated line breaks. */
export function joinLines(lines: Line[]): string {
	let out = "";
	for (const l of lines) {
		const t = l.text.trim();
		if (!t) continue;
		if (!out) out = t;
		else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(t)) out = out.slice(0, -1) + t;
		else out += " " + t;
	}
	return out.replace(/\s+/g, " ").trim();
}

/** Character rects whose centre lies inside `r`, as [firstIndex, lastIndexExclusive], or null. */
export function charsInRect(rects: PdfRect[], r: PdfRect, pad = 1): [number, number] | null {
	let first = -1;
	let last = -1;
	for (let i = 0; i < rects.length; i++) {
		const c = rects[i]!;
		if (!hasGeometry(c)) continue;
		const cx = (c[0] + c[2]) / 2;
		const cy = (c[1] + c[3]) / 2;
		if (cx >= r[0] - pad && cx <= r[2] + pad && cy >= r[1] - pad && cy <= r[3] + pad) {
			if (first < 0) first = i;
			last = i + 1;
		}
	}
	return first < 0 ? null : [first, last];
}

/** Rects for text range [a,b): one union rect per visual line. */
export function rangeRects(rects: PdfRect[], a: number, b: number): PdfRect[] {
	const out: PdfRect[] = [];
	let cur: PdfRect | null = null;
	for (let i = a; i < b && i < rects.length; i++) {
		const r = rects[i];
		if (!hasGeometry(r)) continue;
		if (cur) {
			const h = Math.min(r[3] - r[1], cur[3] - cur[1]);
			const overlap = Math.min(r[3], cur[3]) - Math.max(r[1], cur[1]);
			if (overlap < 0.45 * h) { out.push(cur); cur = null; }
		}
		if (!cur) cur = [r[0], r[1], r[2], r[3]];
		else {
			cur[0] = Math.min(cur[0], r[0]);
			cur[1] = Math.min(cur[1], r[1]);
			cur[2] = Math.max(cur[2], r[2]);
			cur[3] = Math.max(cur[3], r[3]);
		}
	}
	if (cur) out.push(cur);
	return out;
}

/** Index of the line containing text index i (binary search over sorted lines), or -1. */
export function lineAt(lines: Line[], i: number): number {
	let lo = 0;
	let hi = lines.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const l = lines[mid]!;
		if (i < l.start) hi = mid - 1;
		else if (i >= l.end) lo = mid + 1;
		else return mid;
	}
	return -1;
}
