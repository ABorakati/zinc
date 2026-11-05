// Per-document annotation state shared by the toolbar, side panel, page overlays and selection popup: the persisted list, the
// UI state (active tool, colour, selected annotation) and the operations (create from the selection / a click, delete, jump,
// "note from annotations"). One session per attachment key; onOpen creates it, its cleanup flushes and drops it.
import { createSignal } from "solid-js";
import { apiRequest } from "../../api";
import type { ReaderContext } from "../plugins";
import { buildPageText, fromNRect } from "../structure/pagetext";
import type { PdfRect } from "../structure/types";
import { selectionToPosition } from "./geometry";
import {
	boundingRect, COLORS, DEFAULT_COLOR, makeAnnotation, notePosition, notesHtml, pageLabelFor, sortIndexFor, textPosition,
	type Annotation, type AnnotationType, type Position,
} from "./model";
import { createStore } from "./store";

export type Tool = "highlight" | "underline" | "note" | "ink" | "eraser";

let rememberedColor: string = DEFAULT_COLOR;

export function createSession(ctx: ReaderContext) {
	const store = createStore(ctx.attachmentKey);
	const [tool, setToolRaw] = createSignal<Tool | null>(null);
	const [color, setColorRaw] = createSignal<string>(rememberedColor);
	const [selectedId, select] = createSignal<string | null>(null);
	const [inkWidth, setInkWidthRaw] = createSignal<number>(2);
	/** annotation whose comment box should take focus (after "Add comment") */
	const [focusComment, setFocusComment] = createSignal<string | null>(null);
	const [message, setMessage] = createSignal<string | null>(null);
	let messageTimer: ReturnType<typeof setTimeout> | undefined;

	const ui = {
		tool, color, selectedId, select, focusComment, setFocusComment, message, inkWidth,
		setTool(t: Tool | null) { setToolRaw(t); if (t) { select(null); ctx.clearSelection(); } },
		setColor(c: string) { rememberedColor = c; setColorRaw(c); },
		setInkWidth(w: number) { setInkWidthRaw(w); },
		notify(msg: string) {
			setMessage(msg);
			clearTimeout(messageTimer);
			messageTimer = setTimeout(() => setMessage(null), 3500);
		},
	};

	async function sortIndex(position: Position): Promise<string> {
		const size = ctx.pageSize(position.pageIndex);
		const layer = await ctx.textLayer(position.pageIndex).catch(() => ({ words: [] }));
		return sortIndexFor(position, size.h, buildPageText(layer.words, size.w, size.h).rects);
	}
	const label = (pageIndex: number) => pageLabelFor(pageIndex, store.list());

	async function create(type: AnnotationType, col: string, position: Position, extra: { text?: string; comment?: string } = {}): Promise<Annotation> {
		const a = makeAnnotation({ type, color: col, position, sortIndex: await sortIndex(position), pageLabel: label(position.pageIndex), ...extra });
		store.add(a);
		return a;
	}

	/** A view that shows the document its own way (the reading view) can take over "jump to annotation"; it returns false to let
	 *  the page view scroll as usual. */
	let jumpOverride: ((a: Annotation) => boolean) | null = null;

	const act = {
		sortIndex,
		/** Save a new annotation at an explicit position (PDF points), e.g. one made in the reading view; selects it. */
		async create(type: AnnotationType, col: string, position: Position, extra: { text?: string; comment?: string; focusComment?: boolean } = {}): Promise<Annotation> {
			const a = await create(type, col, position, { text: extra.text, comment: extra.comment });
			select(a.id);
			if (extra.focusComment) setFocusComment(a.id);
			return a;
		},
		/** Route jump() to another view while it is shown; returns the remover. */
		setJumpOverride(fn: ((a: Annotation) => boolean) | null): () => void {
			jumpOverride = fn;
			return () => { if (jumpOverride === fn) jumpOverride = null; };
		},
		/** Highlight/underline the current text selection; returns the new annotation. */
		async fromSelection(type: "highlight" | "underline", col: string, opts: { comment?: boolean } = {}): Promise<Annotation | null> {
			const sel = ctx.selection();
			if (!sel || !sel.rects.length) return null;
			const size = ctx.pageSize(sel.page);
			const pos = selectionToPosition([{ page: sel.page, rects: sel.rects.map((r) => fromNRect(r, size.w, size.h)) }]);
			if (!pos) return null;
			const text = sel.text.replace(/\s+/g, " ").trim();
			ctx.clearSelection();
			const a = await create(type, col, textPosition(pos.pageIndex, pos.rects, pos.nextPageRects), { text });
			select(a.id);
			if (opts.comment) setFocusComment(a.id);
			return a;
		},
		/** A sticky note at a point of the page (normalised 0..1). */
		async placeNote(page: number, xn: number, yn: number, col: string): Promise<Annotation> {
			const s = ctx.pageSize(page);
			const a = await create("note", col, notePosition(page, xn * s.w, (1 - yn) * s.h, s.w, s.h));
			select(a.id);
			setFocusComment(a.id);
			return a;
		},
		remove(ids: string[]) {
			const sel = selectedId();
			if (sel && ids.includes(sel)) select(null);
			store.remove(ids);
		},
		/** Scroll to the annotation (its first rect) and select it. */
		jump(a: Annotation) {
			select(a.id);
			if (jumpOverride?.(a)) return;
			const r: PdfRect = a.position.rects?.[0] ?? boundingRect(a.position);
			const s = ctx.pageSize(a.position.pageIndex);
			ctx.scrollTo(a.position.pageIndex, Math.max(0, 1 - r[3] / s.h - 0.06));
		},
		/** Create a child note of the parent item listing the given annotations (Zotero's "Add Note from Annotations"). */
		async noteFromAnnotations(anns: Annotation[]): Promise<boolean> {
			if (!ctx.itemKey) { ui.notify("This file has no parent item to attach a note to."); return false; }
			if (!anns.length) { ui.notify("No annotations to add."); return false; }
			try {
				await apiRequest("POST", "/items", { data: { itemType: "note", parentItem: ctx.itemKey, note: notesHtml(anns) } });
				ui.notify(`Added a note with ${anns.length} annotation${anns.length === 1 ? "" : "s"} to the item.`);
				return true;
			} catch (e) {
				ui.notify(`Could not create the note: ${(e as Error).message}`);
				return false;
			}
		},
	};

	return { ctx, store, ui, act, colors: COLORS };
}
export type Session = ReturnType<typeof createSession>;

const sessions = new Map<string, Session>();
/** The session of the open document (created on first use). */
export function sessionFor(ctx: ReaderContext): Session {
	let s = sessions.get(ctx.attachmentKey);
	if (!s) {
		s = createSession(ctx);
		sessions.set(ctx.attachmentKey, s);
		void s.store.load().catch((e) => console.warn("[annotations] could not load:", (e as Error).message));
	}
	return s;
}
export function closeSession(attachmentKey: string): void {
	const s = sessions.get(attachmentKey);
	if (!s) return;
	void s.store.flush();
	sessions.delete(attachmentKey);
}
