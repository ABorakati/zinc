// The item pane's page preview (Preview.tsx) without the reader: one open PdfDoc per selected attachment, page thumbnails
// rendered on demand, and a memory cache of the thumbnails already rendered.
//
//   const s = await openPreview(key, { signal });   // { kind: "doc", session } | { kind: "big", bytes }
//   const task = s.session.render(page, scale, prio) // { promise, cancel } like PdfDoc.render3; the pixels are a copy (cached)
//   s.session.close()                              // cancels what is queued, waits for what runs, then closes the document
//
// Size guard: a HEAD request first (the core's serveFile answers HEAD with the file's Content-Length). A file over
// PREVIEW_MAX_BYTES is not read until the user asks ("Show preview"): a cloud-only OneDrive file can take seconds to come down.
// Cache: rendered thumbnails keyed `${attKey}:${page}:${dpr}:${width}` (BGRA copies, so the native bitmap is released at
// once), least recently used first out past PREVIEW_CACHE_BYTES; and each document's page sizes, so an item seen before lays
// out its strip (and shows its cached pages) before its file is read again.
import { apiFetch } from "../api";
import { startCore } from "../core";
import { fetchAttachment, PdfLoadError } from "../reader/library";
import { PdfDoc, type RenderTask } from "../reader/pdf";

/** Files over this size wait for "Show preview". */
export const PREVIEW_MAX_BYTES = 30 * 1024 * 1024;
let maxBytes = PREVIEW_MAX_BYTES;
/** Change the size limit (scripts test the guard with small files). */
export const setPreviewMaxBytes = (n: number): void => void (maxBytes = n);
/** Memory the cached thumbnails may hold. */
export const PREVIEW_CACHE_BYTES = 24 * 1024 * 1024;

export interface ThumbPixels {
	width: number;
	height: number;
	/** BGRA8 */
	pixels: Uint8Array;
}

/** A Map in use order (oldest first) with a byte budget. */
class ThumbCache {
	private map = new Map<string, ThumbPixels>();
	bytes = 0;
	hits = 0;
	misses = 0;
	constructor(readonly cap: number) {}
	get(k: string): ThumbPixels | undefined {
		const v = this.map.get(k);
		if (!v) {
			this.misses++;
			return undefined;
		}
		this.hits++;
		this.map.delete(k);
		this.map.set(k, v);
		return v;
	}
	set(k: string, v: ThumbPixels): void {
		const old = this.map.get(k);
		if (old) {
			this.bytes -= old.pixels.byteLength;
			this.map.delete(k);
		}
		this.map.set(k, v);
		this.bytes += v.pixels.byteLength;
		for (const [key, x] of this.map) {
			if (this.bytes <= this.cap || key === k) break;
			this.map.delete(key);
			this.bytes -= x.pixels.byteLength;
		}
	}
	get size(): number {
		return this.map.size;
	}
	clear(): void {
		this.map.clear();
		this.bytes = 0;
	}
}

export const thumbCache = new ThumbCache(PREVIEW_CACHE_BYTES);
export const thumbKey = (attKey: string, page: number, dpr: number, width: number): string => `${attKey}:${page}:${dpr}:${width}`;

/** Page sizes (PDF points) of documents opened before, most recent last; a few dozen entries. */
const sizeCache = new Map<string, [number, number][]>();
export function knownSizes(attKey: string): [number, number][] | undefined {
	return sizeCache.get(attKey);
}
function rememberSizes(attKey: string, sizes: [number, number][]): void {
	sizeCache.delete(attKey);
	sizeCache.set(attKey, sizes);
	if (sizeCache.size > 64) sizeCache.delete(sizeCache.keys().next().value!);
}

/** Attachments the user chose to preview despite their size (this run only). */
const forced = new Set<string>();
export const forcePreview = (attKey: string): void => void forced.add(attKey);

/** Timings of the last preview opened (ms), and counters for the headless checks. */
export const previewStats = {
	/** from the preview's mount (after the selection's item detail loaded) to its first page on screen, incl. the OPEN_DELAY wait */
	firstShownMs: 0,
	headMs: 0,
	fetchMs: 0,
	openMs: 0,
	bytes: 0,
	opened: 0,
	closed: 0,
	renders: 0,
	renderMs: [] as number[],
};

/** One open document of the preview. */
export class PreviewSession {
	private live = new Set<{ task: RenderTask; done: Promise<unknown> }>();
	private closed = false;
	constructor(
		readonly attKey: string,
		private doc: PdfDoc,
	) {}
	get sizes(): [number, number][] {
		return this.doc.sizes;
	}
	get pageCount(): number {
		return this.doc.pageCount;
	}
	/**
	 * Render a page at `scale` (device px per PDF point) with queue priority `prio` (lower first). The result is a copy of the
	 * bitmap (the native one is released here), already in the cache under `key`; null when cancelled or the session closed.
	 */
	render(page: number, scale: number, prio: number, key: string): { promise: Promise<ThumbPixels | null>; cancel(): void } {
		if (this.closed) return { promise: Promise.resolve(null), cancel() {} };
		const t0 = performance.now();
		const task = this.doc.render3(page, scale, { prio });
		const promise = task.promise.then(
			(r) => {
				if (!r) return null;
				try {
					if (this.closed) return null;
					const out = { width: r.width, height: r.height, pixels: new Uint8Array(r.pixels) };
					thumbCache.set(key, out);
					previewStats.renders++;
					previewStats.renderMs.push(performance.now() - t0);
					if (previewStats.renderMs.length > 200) previewStats.renderMs.shift();
					return out;
				} finally {
					r.release();
				}
			},
			() => null,
		);
		const entry = { task, done: promise };
		this.live.add(entry);
		void promise.finally(() => this.live.delete(entry));
		return { promise, cancel: () => task.cancel() };
	}
	/** Cancel the queued renders, let a running one finish, then close the document. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const pending = [...this.live];
		for (const e of pending) e.task.cancel();
		await Promise.allSettled(pending.map((e) => e.done));
		this.doc.close();
		previewStats.closed++;
	}
}

export type PreviewOpen = { kind: "doc"; session: PreviewSession } | { kind: "big"; bytes: number };

/** The attachment file's size from a HEAD request, or null when the core does not say. */
async function fileSize(attKey: string, signal: AbortSignal): Promise<number | null> {
	await startCore();
	try {
		const res = await apiFetch(`/attachments/${encodeURIComponent(attKey)}/file`, { method: "HEAD", signal });
		if (res.status === 404) throw new PdfLoadError("no file for this attachment");
		const n = Number(res.headers.get("content-length"));
		return res.ok && Number.isFinite(n) && n > 0 ? n : null;
	} catch (e) {
		if (e instanceof PdfLoadError || (e as Error).name === "AbortError") throw e;
		return null; // no HEAD support: read it anyway
	}
}

/** Open the attachment's PDF for the preview (or report that it is too big to read unasked). Throws AbortError when aborted. */
export async function openPreview(attKey: string, o: { signal: AbortSignal }): Promise<PreviewOpen> {
	const { signal } = o;
	if (!forced.has(attKey) && !sizeCache.has(attKey)) {
		const t0 = performance.now();
		const n = await fileSize(attKey, signal);
		previewStats.headMs = performance.now() - t0;
		if (n != null && n > maxBytes) return { kind: "big", bytes: n };
	}
	signal.throwIfAborted();
	const t1 = performance.now();
	const bytes = await fetchAttachment(attKey, signal);
	previewStats.fetchMs = performance.now() - t1;
	previewStats.bytes = bytes.byteLength;
	signal.throwIfAborted();
	if (bytes.byteLength < 8 || String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") throw new PdfLoadError("the file is not a PDF");
	const t2 = performance.now();
	let doc: PdfDoc;
	try {
		doc = PdfDoc.openBytes(bytes);
	} catch (e) {
		throw new PdfLoadError(`cannot open the PDF: ${(e as Error).message}`);
	}
	previewStats.openMs = performance.now() - t2;
	previewStats.opened++;
	if (signal.aborted) {
		doc.close();
		previewStats.closed++;
		signal.throwIfAborted();
	}
	rememberSizes(attKey, doc.sizes);
	return { kind: "doc", session: new PreviewSession(attKey, doc) };
}

/** "31.4 MB" */
export const formatBytes = (n: number): string =>
	n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
