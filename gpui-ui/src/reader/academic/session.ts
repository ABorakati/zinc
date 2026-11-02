// Per-document state of the academic plugins: the document structure (Zotero's document worker), the page text used to find
// citations and mentions, the figure/table index, the popup being shown and the "back" stack for jumps.
import { createSignal, type Accessor, type JSX } from "solid-js";
import type { ReaderContext } from "../plugins";
import { buildPageText, type PagePt } from "../structure/pagetext";
import { closeRegions } from "../structure/regions";
import { loadStructure } from "../structure/load";
import type { DocStructure, PdfRect } from "../structure/types";
import { createApi, type AcademicApi } from "./api";
import { findRefStartInPages, refStartFromStructure, type RefStart } from "./citations";
import { buildCiteIndex, type CiteIndex } from "./citedby";
import { indexFromStructure, mergeIndex, scanCaptionsInPage, type FigItem } from "./figures";

export type StructState =
	| { phase: "loading"; pct: number }
	| { phase: "ready"; doc: DocStructure }
	| { phase: "error"; message: string };

/** The card shown for a mention: drawn in the overlay of `page`, next to `rect` (PDF points). */
export interface Popup { key: string; page: number; rect: PdfRect; content: () => JSX.Element; pinned: boolean }

export const EMPTY_STRUCTURE: DocStructure = { blocks: [], figures: [], tables: [], references: [], outline: [] };

export function createSession(ctx: ReaderContext) {
	const api = createApi(ctx.attachmentKey, ctx.itemKey || null);
	const [struct, setStruct] = createSignal<StructState>({ phase: "loading", pct: 0 });
	const [figItems, setFigItems] = createSignal<FigItem[]>([]);
	const [analysed, setAnalysed] = createSignal(false);
	let refStart: RefStart | null = null;
	let started: Promise<void> | null = null;
	let closed = false;

	const ptCache = new Map<number, Promise<PagePt>>();
	function pageText(i: number): Promise<PagePt> {
		let p = ptCache.get(i);
		if (!p) {
			const size = ctx.pageSize(i);
			p = ctx.textLayer(i).then((l) => buildPageText(l.words, size.w, size.h)).catch(() => ({ text: "", rects: [] }) as PagePt);
			ptCache.set(i, p);
		}
		return p;
	}

	/** Load the structure and index the figures; resolves when done (also when the structure is unavailable). */
	function start(): Promise<void> {
		return (started ??= (async () => {
			let doc = EMPTY_STRUCTURE;
			try {
				const bytes = await ctx.pdfBytes();
				doc = await loadStructure(ctx.attachmentKey, bytes, (pct) => { if (struct().phase === "loading") setStruct({ phase: "loading", pct }); });
				if (closed) return;
				setStruct({ phase: "ready", doc });
			} catch (e) {
				console.warn("[academic] structure unavailable:", (e as Error).message);
				setStruct({ phase: "error", message: (e as Error).message });
			}
			refStart = refStartFromStructure(doc);
			try {
				const all: PagePt[] = [];
				for (let i = 0; i < ctx.pageCount() && !closed; i++) {
					all.push(await pageText(i));
					if (i % 6 === 5) await Bun.sleep(0);
				}
				refStart ??= findRefStartInPages(all);
				setFigItems(mergeIndex(indexFromStructure(doc), all.flatMap((pt, i) => scanCaptionsInPage(i, pt))));
			} catch (e) { console.warn("[academic] text scan failed:", (e as Error).message); }
			setAnalysed(true);
		})());
	}

	/** Reference number -> where the text cites it (built once, after the structure and the page texts are in). */
	let citeP: Promise<CiteIndex> | null = null;
	const structureNow = (): DocStructure => { const s = struct(); return s.phase === "ready" ? s.doc : EMPTY_STRUCTURE; };
	const citeIndex = (): Promise<CiteIndex> => (citeP ??= start().then(() => buildCiteIndex({ ctx, pageText, structure: structureNow, refStart: () => refStart })));

	/** Start over after a failure (the structure loader forgets failed runs). */
	function retry(): Promise<void> {
		started = null;
		setStruct({ phase: "loading", pct: 0 });
		return start();
	}

	// ---- popups
	const [popup, setPopup] = createSignal<Popup | null>(null);
	let hideTimer: ReturnType<typeof setTimeout> | undefined;
	const cancelHide = () => { clearTimeout(hideTimer); hideTimer = undefined; };

	// ---- jumps with a way back
	const [backStack, setBack] = createSignal<number[]>([]);
	function jump(page: number, rect: PdfRect | null, remember = true) {
		const size = ctx.pageSize(page);
		const here = ctx.currentPage();
		if (remember && backStack()[backStack().length - 1] !== here) setBack((s) => [...s.slice(-29), here]);
		ctx.scrollTo(page, rect ? Math.max(0, 1 - (rect[3] + 24) / size.h) : 0);
		setPopup(null);
	}
	function goBack(): void {
		const s = backStack();
		const page = s[s.length - 1];
		if (page === undefined) return;
		setBack(s.slice(0, -1));
		ctx.scrollTo(page, 0);
	}

	return {
		ctx, api, struct, figItems, analysed,
		structure: structureNow,
		refStart: () => refStart,
		pageText, start, retry, citeIndex,
		popup,
		showPopup(p: Popup) { cancelHide(); setPopup(p); },
		hidePopup() { cancelHide(); setPopup(null); },
		scheduleHide(ms = 400) { cancelHide(); hideTimer = setTimeout(() => { if (!popup()?.pinned) setPopup(null); }, ms); },
		cancelHide,
		backStack, jump, goBack,
		dispose() { closed = true; cancelHide(); closeRegions(ctx.attachmentKey); },
	};
}
export type AcademicSession = ReturnType<typeof createSession>;

const sessions = new Map<string, AcademicSession>();
export function academicFor(ctx: ReaderContext): AcademicSession {
	let s = sessions.get(ctx.attachmentKey);
	if (!s) { s = createSession(ctx); sessions.set(ctx.attachmentKey, s); }
	return s;
}
export function closeAcademic(attachmentKey: string): void {
	sessions.get(attachmentKey)?.dispose();
	sessions.delete(attachmentKey);
}
export type { Accessor };
