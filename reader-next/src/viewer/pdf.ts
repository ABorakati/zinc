// Thin promise-based wrapper over EmbedPDF's PDFium engine (running in a Web Worker).
// EmbedPDF page space: origin top-left, y down, points. We convert to the contract's PdfRect
// (origin bottom-left) at this boundary so nothing else in the viewer deals with both.
import { createPdfiumEngine } from "@embedpdf/engines/pdfium-worker-engine";
import type {
	PdfDocumentObject, PdfPageObject, PdfBookmarkObject, PdfLinkTarget, PdfAnnotationObject,
	PdfTextRun, ImageDataLike, SearchResult, Rect,
} from "@embedpdf/models";
import { MatchFlag, PdfErrorCode, PdfActionType, PdfAnnotationSubtype, PdfZoomMode } from "@embedpdf/models";
import type { LinkTarget, PageInfo, PdfRect } from "../contract";

type Engine = ReturnType<typeof createPdfiumEngine>;

let enginePromise: Promise<Engine> | null = null;
export function getEngine(): Promise<Engine> {
	// The WASM is shipped next to index.html (public/pdfium.wasm); the worker is a blob so the URL must be absolute.
	enginePromise ??= Promise.resolve(createPdfiumEngine(new URL("./pdfium.wasm", document.baseURI).href, { encoderPoolSize: 0, fontFallback: null }));
	return enginePromise;
}

const run = <T>(task: { toPromise(): Promise<T> }): Promise<T> => task.toPromise();

/** Convert an EmbedPDF rect (top-left origin) on a page of height H to a contract PdfRect. */
export function toPdfRect(r: Rect, H: number): PdfRect {
	return [r.origin.x, H - (r.origin.y + r.size.height), r.origin.x + r.size.width, H - r.origin.y];
}

export interface LinkInfo {
	rect: PdfRect;
	target: LinkTarget;
}
export interface TextRun {
	text: string;
	rect: PdfRect;
	fontSize: number;
	charIndex: number;
}
export interface PageTextData {
	text: string;
	rects: PdfRect[];
	runs: TextRun[];
}
export interface OutlineNode {
	title: string;
	page?: number;
	top?: number;
	uri?: string;
	children: OutlineNode[];
}
export interface FindHit {
	page: number;
	rects: PdfRect[];
	context: string;
}

class Lru<K, V> {
	private m = new Map<K, V>();
	constructor(private max: number) {}
	get(k: K): V | undefined {
		const v = this.m.get(k);
		if (v !== undefined) { this.m.delete(k); this.m.set(k, v); }
		return v;
	}
	set(k: K, v: V) {
		this.m.delete(k);
		this.m.set(k, v);
		if (this.m.size > this.max) this.m.delete(this.m.keys().next().value as K);
	}
}

export class PdfDoc {
	readonly pages: PageInfo[];
	private links = new Lru<number, Promise<LinkInfo[]>>(40);
	private text = new Lru<number, Promise<PageTextData>>(40);
	private closed = false;

	private constructor(private engine: Engine, readonly doc: PdfDocumentObject) {
		this.pages = doc.pages.map((p) => ({ index: p.index, width: p.size.width, height: p.size.height }));
	}

	static async open(bytes: ArrayBuffer): Promise<PdfDoc> {
		const engine = await getEngine();
		const doc = await run(engine.openDocumentBuffer({ id: "doc", content: bytes }, { normalizeRotation: true }));
		return new PdfDoc(engine, doc);
	}

	private page(i: number): PdfPageObject {
		return this.doc.pages[i];
	}

	/** Render page i at cssScale * dpr pixels per point into raw RGBA; cancellable. */
	renderRaw(i: number, cssScale: number, dpr: number): { promise: Promise<ImageDataLike>; cancel: () => void } {
		const task = this.engine.renderPageRaw(this.doc, this.page(i), { scaleFactor: cssScale, dpr, withAnnotations: true, withForms: false });
		return { promise: task.toPromise(), cancel: () => { try { task.abort({ code: PdfErrorCode.Cancelled, message: "cancelled" }); } catch { /* ignore */ } } };
	}
	/** Render only rect (PdfRect, bottom-left origin) of page i at scale pixels per point, as raw RGBA. */
	renderRect(i: number, rect: PdfRect, scale: number): Promise<ImageDataLike> {
		const pg = this.page(i);
		const H = pg.size.height;
		const r: Rect = { origin: { x: rect[0], y: H - rect[3] }, size: { width: rect[2] - rect[0], height: rect[3] - rect[1] } };
		return this.engine.renderPageRectRaw(this.doc, pg, r, { scaleFactor: scale, dpr: 1, withAnnotations: false }).toPromise();
	}
	renderThumb(i: number, scale: number): { promise: Promise<ImageDataLike>; cancel: () => void } {
		const task = this.engine.renderPageRaw(this.doc, this.page(i), { scaleFactor: scale, dpr: 1, withAnnotations: false });
		return { promise: task.toPromise(), cancel: () => { try { task.abort({ code: PdfErrorCode.Cancelled, message: "cancelled" }); } catch { /* ignore */ } } };
	}

	pageLinks(i: number): Promise<LinkInfo[]> {
		let p = this.links.get(i);
		if (!p) {
			const H = this.pages[i].height;
			p = run(this.engine.getPageAnnotations(this.doc, this.page(i))).then((annos: PdfAnnotationObject[]) => {
				const out: LinkInfo[] = [];
				for (const a of annos) {
					if (a.type !== PdfAnnotationSubtype.LINK) continue;
					const target = this.convertTarget((a as { target?: PdfLinkTarget }).target);
					if (target) out.push({ rect: toPdfRect(a.rect, H), target });
				}
				return out;
			}).catch(() => []);
			this.links.set(i, p);
		}
		return p;
	}

	convertTarget(t: PdfLinkTarget | undefined): LinkTarget | null {
		if (!t) return null;
		const dest = t.type === "destination" ? t.destination : t.action.type === PdfActionType.Goto ? t.action.destination : null;
		if (dest) {
			let top: number | undefined;
			if (dest.zoom.mode === PdfZoomMode.XYZ) {
				const y = dest.zoom.params.y;
				if (Number.isFinite(y)) top = y;
			}
			return { kind: "internal", page: dest.pageIndex, top };
		}
		if (t.type === "action" && t.action.type === PdfActionType.URI) return { kind: "external", uri: t.action.uri };
		return null;
	}

	/** Page text + per-character rects (PDFium text API) and text runs (for the DOM text layer). */
	pageText(i: number): Promise<PageTextData> {
		let p = this.text.get(i);
		if (!p) {
			const H = this.pages[i].height;
			p = (async () => {
				const [text, geom, runs] = await Promise.all([
					run(this.engine.extractText(this.doc, [i])).catch(() => ""),
					run(this.engine.getPageGeometry(this.doc, this.page(i))),
					run(this.engine.getPageTextRuns(this.doc, this.page(i))),
				]);
				const rects: PdfRect[] = new Array(text.length).fill(null).map(() => [0, 0, 0, 0] as PdfRect);
				for (const r of geom.runs) {
					for (let k = 0; k < r.glyphs.length; k++) {
						const g = r.glyphs[k];
						const idx = r.charStart + k;
						if (idx < rects.length) rects[idx] = [g.x, H - (g.y + g.height), g.x + g.width, H - g.y];
					}
				}
				const tr: TextRun[] = runs.runs.map((r: PdfTextRun) => ({
					text: r.text, rect: toPdfRect(r.rect, H), fontSize: r.fontSize, charIndex: r.charIndex,
				}));
				return { text, rects, runs: tr };
			})();
			this.text.set(i, p);
		}
		return p;
	}

	async outline(): Promise<OutlineNode[]> {
		const res = await run(this.engine.getBookmarks(this.doc)).catch(() => ({ bookmarks: [] as PdfBookmarkObject[] }));
		const conv = (b: PdfBookmarkObject): OutlineNode => {
			const t = this.convertTarget(b.target);
			return {
				title: b.title, page: t?.page, top: t?.top, uri: t?.uri,
				children: (b.children ?? []).map(conv),
			};
		};
		return res.bookmarks.map(conv);
	}

	async search(q: string, matchCase: boolean, wholeWord: boolean): Promise<FindHit[]> {
		const flags = [] as MatchFlag[];
		if (matchCase) flags.push(MatchFlag.MatchCase);
		if (wholeWord) flags.push(MatchFlag.MatchWholeWord);
		const res = await run(this.engine.searchAllPages(this.doc, q, { flags }));
		return res.results.map((r: SearchResult) => ({
			page: r.pageIndex,
			rects: r.rects.map((x) => toPdfRect(x, this.pages[r.pageIndex].height)),
			context: `${r.context.before}${r.context.match}${r.context.after}`,
		}));
	}

	async close() {
		if (this.closed) return;
		this.closed = true;
		try { await run(this.engine.closeDocument(this.doc)); } catch { /* ignore */ }
	}
}
