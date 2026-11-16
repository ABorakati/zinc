// Geometry for annotations: selection rects -> highlight rects, hit testing, ink helpers. Pure (PDF space, y up).
import type { PdfRect } from "../structure/types";
import { boundingRect, type Annotation, type Position } from "./model";

const w = (r: PdfRect) => r[2] - r[0];
const h = (r: PdfRect) => r[3] - r[1];
const union = (a: PdfRect, b: PdfRect): PdfRect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

/** True if two rects sit on the same text line: they overlap vertically by more than half the shorter one. */
export function sameLine(a: PdfRect, b: PdfRect): boolean {
	const overlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
	return overlap > Math.min(h(a), h(b)) * 0.5;
}

/**
 * Merge per-word rects (in reading order) into one rect per line, like Zotero's highlights. Rects on the same line
 * join when the horizontal gap is small (a different column stays separate).
 */
export function mergeLineRects(rects: PdfRect[]): PdfRect[] {
	const out: PdfRect[] = [];
	for (const r of rects) {
		if (!(w(r) > 0 && h(r) > 0)) continue;
		let merged = false;
		// words arrive in reading order, but a line can interleave with the next after a column break: check the last few
		for (let k = out.length - 1; k >= Math.max(0, out.length - 2); k--) {
			const l = out[k]!;
			if (!sameLine(l, r)) continue;
			const gap = r[0] >= l[2] ? r[0] - l[2] : l[0] >= r[2] ? l[0] - r[2] : 0;
			if (gap <= Math.max(h(l), h(r)) * 1.2) {
				out[k] = union(l, r);
				merged = true;
			}
			break;
		}
		if (!merged) out.push([...r] as PdfRect);
	}
	return out;
}

/** Rects of a selection on several pages: the first page becomes `rects`, the next `nextPageRects` (Zotero's limit is two pages). */
export function selectionToPosition(
	pages: { page: number; rects: PdfRect[] }[],
): { pageIndex: number; rects: PdfRect[]; nextPageRects?: PdfRect[] } | null {
	const used = pages
		.filter((p) => p.rects.length)
		.sort((a, b) => a.page - b.page)
		.slice(0, 2);
	if (!used.length) return null;
	const first = used[0]!;
	const rects = mergeLineRects(first.rects);
	if (!rects.length) return null;
	const second = used[1];
	const next = second && second.page === first.page + 1 ? mergeLineRects(second.rects) : [];
	return next.length ? { pageIndex: first.page, rects, nextPageRects: next } : { pageIndex: first.page, rects };
}

export const rectContains = (r: PdfRect, x: number, y: number, tol = 0) =>
	x >= r[0] - tol && x <= r[2] + tol && y >= r[1] - tol && y <= r[3] + tol;

/** Distance from point (x, y) to segment (ax, ay)-(bx, by). */
export function segmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax,
		dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
	return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** Is the point on the annotation? (tol in PDF points; ink hit-tests the stroke, others their rects.) */
export function hitsAnnotation(a: Annotation, page: number, x: number, y: number, tol: number): boolean {
	const p = a.position;
	const onNext = p.nextPageRects && p.pageIndex + 1 === page;
	if (p.pageIndex !== page && !onNext) return false;
	if (a.type === "ink") {
		const half = (p.width ?? 2) / 2 + tol;
		for (const path of p.paths ?? []) {
			if (path.length === 2 && Math.hypot(x - path[0]!, y - path[1]!) <= half) return true;
			for (let i = 0; i + 3 < path.length; i += 2) {
				if (segmentDistance(x, y, path[i]!, path[i + 1]!, path[i + 2]!, path[i + 3]!) <= half) return true;
			}
		}
		return false;
	}
	return (onNext ? p.nextPageRects! : (p.rects ?? [])).some((r) => rectContains(r, x, y, a.type === "underline" ? tol : 0));
}

/** The topmost annotation under the point: the smallest area wins (a note over a highlight). */
export function annotationAt(anns: Annotation[], page: number, x: number, y: number, tol = 2): Annotation | null {
	let best: Annotation | null = null,
		bestArea = Infinity;
	for (const a of anns) {
		if (!hitsAnnotation(a, page, x, y, tol)) continue;
		const b = boundingRect(a.position);
		const area = Math.max(1, w(b) * h(b));
		if (area <= bestArea) {
			best = a;
			bestArea = area;
		}
	}
	return best;
}

/** Rects of the annotation on one page (the continuation of a two-page highlight is on pageIndex + 1). */
export function rectsOnPage(p: Position, page: number): PdfRect[] {
	if (p.pageIndex === page) return p.rects ?? [];
	if (p.nextPageRects && p.pageIndex + 1 === page) return p.nextPageRects;
	return [];
}

/** Drop ink points closer than minDist to the previous kept point; the last point is always kept. */
export function thinInk(path: number[], minDist = 0.6): number[] {
	if (path.length <= 4) return path;
	const out = [path[0]!, path[1]!];
	for (let i = 2; i < path.length - 2; i += 2) {
		if (Math.hypot(path[i]! - out[out.length - 2]!, path[i + 1]! - out[out.length - 1]!) >= minDist) out.push(path[i]!, path[i + 1]!);
	}
	out.push(path[path.length - 2]!, path[path.length - 1]!);
	return out;
}

/** Resize a rect by dragging one corner/edge handle ("nw", "ne", "sw", "se") to (x, y); keeps at least min points. */
export function resizeRect(r: PdfRect, handle: "nw" | "ne" | "sw" | "se", x: number, y: number, min = 8): PdfRect {
	let [x1, y1, x2, y2] = r;
	if (handle.includes("w")) x1 = Math.min(x, x2 - min);
	else x2 = Math.max(x, x1 + min);
	if (handle.includes("n")) y2 = Math.max(y, y1 + min);
	else y1 = Math.min(y, y2 - min);
	return [x1, y1, x2, y2];
}
