// Rotate Pages and Delete Pages, as Zotero does them: the PDF FILE changes, not just the view.
//
//   1. pending annotation edits are saved first (annotations/store.ts), so nothing stale is written after the change;
//   2. the current file is read again and edited by PDFium (pdf.ts editPdf: /Rotate += quarter turns, FPDFPage_Delete, then
//      FPDF_SaveAsCopy writes the whole document anew);
//   3. the new bytes replace the file atomically: PUT /api/attachments/:key/file ({dataBase64, deletedPages?}), where the core writes a temporary
//      file in the same folder, flushes it and renames it over the original (core/src/files/replace.ts). A script that opened a file
//      path directly gets the same temp + rename here;
//   4. Delete only: the attachment's annotations follow their pages in the SAME core request (deletedPages), atomically with the file,
//      as in Zotero (Zotero.PDFWorker.deletePages; the rule lives in core/src/files/pageops.ts, shiftAnnotations here is the same
//      rule kept for the reader's own tests): annotations on a
//      deleted page are deleted, those on later pages move up by the number of deleted pages before them (sort index and a plain
//      numeric page label follow), and a highlight's continuation on a deleted next page is dropped. Rotation needs nothing:
//      positions are stored in PDF user space, which a page's /Rotate does not change (annotations/store.ts converts for display);
//   5. the reader re-opens the document at the same place.
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { apiRequest } from "../../api";
import { flushAnnotationStore } from "../annotations/store";
import { editPdf, type PdfEdit } from "../pdf";

export interface PageOpsTarget {
	/** the attachment (its annotations, and the file the core replaces) */
	attachmentKey: string;
	/** a file opened directly by path (scripts): it is replaced here and there are no annotations to move */
	path?: string;
	pageCount: number;
	/** the file's current bytes (read again, not a cached copy) */
	read(): Promise<Uint8Array>;
	/** re-open the document after the change; `map` takes a page index of the old document to the new one (-1: deleted) */
	reopen(map: (page: number) => number): Promise<void>;
}

/** Annotation as stored by the core (Zotero reader JSON); only what the shift needs is typed. */
interface WireAnnotation {
	id: string;
	sortIndex?: string;
	pageLabel?: string;
	dateModified?: string;
	position?: { pageIndex?: number; nextPageRects?: unknown; [k: string]: unknown };
	[k: string]: unknown;
}

const isKey = (k: string) => /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/.test(k);
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** How annotations change when `deleted` pages (0-based, of the old document) go: which are updated, which are removed. */
export function shiftAnnotations(anns: WireAnnotation[], deleted: number[]): { changed: WireAnnotation[]; removed: string[] } {
	const del = [...new Set(deleted)].sort((a, b) => a - b);
	const gone = new Set(del);
	const before = (p: number) => {
		let k = 0;
		while (k < del.length && del[k]! < p) k++;
		return k;
	};
	const changed: WireAnnotation[] = [],
		removed: string[] = [];
	for (const a of anns) {
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
		const np: WireAnnotation["position"] = { ...pos, pageIndex: pi - shift };
		if (dropNext) delete np.nextPageRects;
		const b: WireAnnotation = { ...a, position: np, dateModified: nowIso() };
		if (shift && typeof a.sortIndex === "string" && /^\d{5}\|/.test(a.sortIndex))
			b.sortIndex = String(pi - shift).padStart(5, "0") + a.sortIndex.slice(5);
		if (shift && a.pageLabel === String(pi + 1)) b.pageLabel = String(pi - shift + 1);
		changed.push(b);
	}
	return { changed, removed };
}

/** Write `bytes` over `path` through a temporary file in the same folder and a rename (the same steps as the core's PUT). */
export function replaceFileAtomic(path: string, bytes: Uint8Array): void {
	const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now().toString(36)}.zn-tmp`);
	let fd = -1;
	try {
		fd = openSync(tmp, "wx");
		let off = 0;
		while (off < bytes.byteLength) off += writeSync(fd, bytes, off, bytes.byteLength - off);
		fsyncSync(fd);
		closeSync(fd);
		fd = -1;
		renameSync(tmp, path);
	} catch (e) {
		if (fd >= 0)
			try {
				closeSync(fd);
			} catch {
				/* ignore */
			}
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* ignore */
		}
		throw e;
	}
}

let busy = false;
/** a page operation is running (the UI greys its commands out) */
export const pageOpBusy = (): boolean => busy;

async function apply(t: PageOpsTarget, edit: PdfEdit, map: (page: number) => number): Promise<void> {
	if (busy) throw new Error("another page change is still running");
	busy = true;
	try {
		const real = !t.path && isKey(t.attachmentKey);
		if (real) await flushAnnotationStore(t.attachmentKey);
		const bytes = await t.read();
		const next = await editPdf(bytes, edit);
		if (t.path) replaceFileAtomic(t.path, next);
		else {
			// ONE request: the core swaps the file and moves/removes the annotations in a single step, keeping the original until both
			// succeeded (core/src/files/replace.ts), so a failure cannot leave a shortened file with annotations on the wrong pages
			await apiRequest("PUT", `/attachments/${encodeURIComponent(t.attachmentKey)}/file`, {
				dataBase64: Buffer.from(next).toString("base64"),
				...(real && edit.delete?.length ? { deletedPages: edit.delete } : {}),
			});
		}
		await t.reopen(map);
	} finally {
		busy = false;
	}
}

/** Add `turns` quarter turns (clockwise; negative: anticlockwise) to the /Rotate of `pages` (0-based) and save the file. */
export async function rotatePages(t: PageOpsTarget, pages: number[], turns: number): Promise<void> {
	const ps = [...new Set(pages)].filter((p) => p >= 0 && p < t.pageCount).sort((a, b) => a - b);
	if (!ps.length || !(turns % 4)) return;
	await apply(t, { rotate: ps.map((page) => ({ page, turns })) }, (p) => p);
}

/** Delete `pages` (0-based) from the file; at least one page must remain. The caller asks for confirmation first. */
export async function deletePages(t: PageOpsTarget, pages: number[]): Promise<void> {
	const ps = [...new Set(pages)].filter((p) => p >= 0 && p < t.pageCount).sort((a, b) => a - b);
	if (!ps.length) return;
	if (ps.length >= t.pageCount) throw new Error("A PDF must keep at least one page.");
	const gone = new Set(ps);
	const map = (p: number) => {
		if (gone.has(p)) return -1;
		let k = 0;
		for (const d of ps) if (d < p) k++;
		return p - k;
	};
	await apply(t, { delete: ps }, map);
}
