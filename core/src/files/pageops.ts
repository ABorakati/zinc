// How a PDF's annotations follow its pages when pages are deleted (Zotero.PDFWorker.deletePages): annotations on a deleted
// page go, those on later pages move up by the number of deleted pages before them (sort index and a plain numeric page label
// follow), and a highlight's continuation on a deleted next page is dropped. Rotation needs nothing: positions are stored in
// PDF user space, which a page's /Rotate does not change. files/replace.ts applies this in the same step as the file swap.
import { nowIso } from "../db";

/** Annotation as stored (Zotero reader JSON); only what the shift needs is typed. */
export interface WireAnnotation {
	id: string;
	sortIndex?: string;
	pageLabel?: string;
	dateModified?: string;
	position?: { pageIndex?: number; nextPageRects?: unknown; [k: string]: unknown };
	[k: string]: unknown;
}

/** Which annotations are updated and which removed when `deleted` pages (0-based, of the old document) go. */
export function shiftAnnotations<T extends { id: string }>(anns: T[], deleted: number[]): { changed: T[]; removed: string[] } {
	const del = [...new Set(deleted)].sort((a, b) => a - b);
	const gone = new Set(del);
	const before = (p: number) => {
		let k = 0;
		while (k < del.length && del[k]! < p) k++;
		return k;
	};
	const changed: T[] = [];
	const removed: string[] = [];
	for (const item of anns) {
		const a = item as unknown as WireAnnotation;
		const pos = a.position;
		const pi = pos?.pageIndex;
		if (!pos || typeof pi !== "number") continue;
		if (gone.has(pi)) {
			removed.push(a.id);
			continue;
		}
		const shift = before(pi);
		const dropNext = pos.nextPageRects !== undefined && gone.has(pi + 1);
		if (!shift && !dropNext) continue;
		const np: NonNullable<WireAnnotation["position"]> = { ...pos, pageIndex: pi - shift };
		if (dropNext) delete np.nextPageRects;
		const b: WireAnnotation = { ...a, position: np, dateModified: nowIso() };
		if (shift && typeof a.sortIndex === "string" && /^\d{5}\|/.test(a.sortIndex)) b.sortIndex = String(pi - shift).padStart(5, "0") + a.sortIndex.slice(5);
		if (shift && a.pageLabel === String(pi + 1)) b.pageLabel = String(pi - shift + 1);
		changed.push(b as unknown as T);
	}
	return { changed, removed };
}
