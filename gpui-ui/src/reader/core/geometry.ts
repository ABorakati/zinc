// Each open document's page geometry, by attachment key: every page's own /Rotate and its size as displayed. Code that stores page
// coordinates uses it to convert between the two spaces involved:
//
//   * the reader's page space: the page as it is displayed (its /Rotate applied), PDF points, origin bottom-left, y up. The text
//     layer, the selection and ReaderContext.pageSize are in this space, and so is everything the annotation plugin works with.
//   * PDF user space: the page without its /Rotate. Zotero stores annotation positions in this space (pdf.js convertToPdfPoint), so
//     a page rotated by Rotate Pages (a new /Rotate in the file) keeps its annotations where they were on the page's content.
//
// For a page with /Rotate 0 the two are the same, and the conversions return their input unchanged.
import type { PdfRect } from "../structure/types";

export interface DocGeometry {
	/** /Rotate of every page, degrees clockwise (0, 90, 180, 270) */
	rots: number[];
	/** displayed page size in points (/Rotate applied) */
	sizes: [number, number][];
}

const docs = new Map<string, DocGeometry>();
export function setDocGeometry(key: string, g: DocGeometry): void { docs.set(key, g); }
export function getDocGeometry(key: string): DocGeometry | undefined { return docs.get(key); }

/** /Rotate of a page (0 for an unknown page). */
export const pageRot = (g: DocGeometry | undefined, page: number): number => ((g?.rots[page] ?? 0) % 360 + 360) % 360;

/** The page's size in user space (without its /Rotate). */
function userSize(g: DocGeometry, page: number): [number, number] {
	const [w, h] = g.sizes[page] ?? [612, 792];
	return pageRot(g, page) % 180 ? [h, w] : [w, h];
}

/** A user-space point of `page` in the reader's page space. */
export function fromUser(g: DocGeometry, page: number, x: number, y: number): [number, number] {
	const [uw, uh] = userSize(g, page);
	switch (pageRot(g, page)) {
		case 90: return [y, uw - x];
		case 180: return [uw - x, uh - y];
		case 270: return [uh - y, x];
		default: return [x, y];
	}
}

/** A point of the reader's page space in user space. */
export function toUser(g: DocGeometry, page: number, x: number, y: number): [number, number] {
	const [uw, uh] = userSize(g, page);
	switch (pageRot(g, page)) {
		case 90: return [uw - y, x];
		case 180: return [uw - x, uh - y];
		case 270: return [y, uh - x];
		default: return [x, y];
	}
}

function mapRect(r: PdfRect, f: (x: number, y: number) => [number, number]): PdfRect {
	const [ax, ay] = f(r[0], r[1]), [bx, by] = f(r[2], r[3]);
	return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}
export const rectFromUser = (g: DocGeometry, page: number, r: PdfRect): PdfRect => mapRect(r, (x, y) => fromUser(g, page, x, y));
export const rectToUser = (g: DocGeometry, page: number, r: PdfRect): PdfRect => mapRect(r, (x, y) => toUser(g, page, x, y));

/** A flat [x1, y1, x2, y2, ...] path through `f`. */
export function mapPath(path: number[], f: (x: number, y: number) => [number, number]): number[] {
	const out = path.slice();
	for (let i = 0; i + 1 < path.length; i += 2) { const [x, y] = f(path[i]!, path[i + 1]!); out[i] = x; out[i + 1] = y; }
	return out;
}
