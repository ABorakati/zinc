// Operations on annotations: create from selection / click / drag, move, delete, jump, note export.
import type { PdfRect, ViewerHandle } from "../contract";
import { annotationAt, selectionToPosition, thinInk } from "./geometry";
import {
	areaPosition, boundingRect, INK_WIDTH, inkPosition, makeAnnotation, notePosition, notesHtml, pageLabelFor, sortIndexFor, textPosition,
	type Annotation, type AnnotationType, type Position,
} from "./model";
import type { Store } from "./store";
import type { Ui } from "./state";

export function createActions(viewer: ViewerHandle, store: Store, ui: Ui) {
	const pageSize = (page: number) => viewer.pages[page] ?? { width: 612, height: 792 };

	async function sortIndex(position: Position): Promise<string> {
		const pt = await viewer.pageText(position.pageIndex).catch(() => ({ text: "", rects: [] as PdfRect[] }));
		return sortIndexFor(position, pageSize(position.pageIndex).height, pt.rects);
	}
	const label = (pageIndex: number) => viewer.pages[pageIndex]?.label ?? pageLabelFor(pageIndex, store.list());

	async function create(type: AnnotationType, color: string, position: Position, extra: { text?: string; comment?: string } = {}): Promise<Annotation> {
		const a = makeAnnotation({ type, color, position, sortIndex: await sortIndex(position), pageLabel: label(position.pageIndex), ...extra });
		store.add(a);
		return a;
	}

	const act = {
		sortIndex,
		/** Highlight/underline the current text selection; returns the new annotation. */
		async fromSelection(type: "highlight" | "underline", color: string, opts: { comment?: boolean } = {}): Promise<Annotation | null> {
			const sel = viewer.selection();
			if (!sel) return null;
			const pos = selectionToPosition(sel.pages);
			if (!pos) return null;
			viewer.clearSelection();
			ui.setSelection(null);
			const a = await create(type, color, textPosition(pos.pageIndex, pos.rects, pos.nextPageRects), { text: sel.text.replace(/\s+/g, " ").trim() });
			ui.select(a.id);
			if (opts.comment) ui.setFocusComment(a.id);
			return a;
		},
		async placeNote(page: number, x: number, y: number, color: string): Promise<Annotation> {
			const s = pageSize(page);
			const a = await create("note", color, notePosition(page, x, y, s.width, s.height));
			ui.select(a.id);
			ui.setFocusComment(a.id);
			return a;
		},
		async addArea(page: number, a: [number, number], b: [number, number], color: string): Promise<Annotation | null> {
			const s = pageSize(page);
			const pos = areaPosition(page, a, b, s.width, s.height);
			const r = pos.rects![0]!;
			if (r[2] - r[0] < 4 || r[3] - r[1] < 4) return null; // a click, not a drag
			const ann = await create("image", color, pos);
			ui.select(ann.id);
			return ann;
		},
		async addInk(page: number, path: number[], color: string): Promise<Annotation | null> {
			if (path.length < 2) return null;
			const p = thinInk(path);
			const ann = await create("ink", color, inkPosition(page, INK_WIDTH, [p.length === 2 ? [...p, ...p] : p]));
			ui.select(ann.id);
			return ann;
		},
		/** Move/resize: the position changes now, the sort index follows once the page text is known. */
		reposition(id: string, position: Position) {
			store.update(id, { position });
			void sortIndex(position).then((si) => { if (store.get(id)?.sortIndex !== si) store.update(id, { sortIndex: si }); });
		},
		remove(ids: string[]) {
			const sel = ui.selectedId();
			if (sel && ids.includes(sel)) ui.select(null);
			store.remove(ids);
		},
		/** The first rect of the annotation, on its own page. */
		anchor(a: Annotation): { page: number; rect: PdfRect } {
			const r = a.position.rects?.[0] ?? boundingRect(a.position);
			return { page: a.position.pageIndex, rect: r };
		},
		jump(a: Annotation) {
			ui.select(a.id);
			const { page, rect } = act.anchor(a);
			viewer.reveal(page, a.type === "ink" ? boundingRect(a.position) : rect);
		},
		/** Annotation under a window point (null if none). */
		at(clientX: number, clientY: number): Annotation | null {
			const p = viewer.pointAt(clientX, clientY);
			if (!p) return null;
			const tol = 3 / (viewer.zoom() * 96 / 72); // 3 CSS px in points
			return annotationAt(store.list(), p.page, p.x, p.y, tol);
		},
		/** Create a child note of the parent item listing the given annotations (Zotero's "Add Note from Annotations"). */
		async noteFromAnnotations(anns: Annotation[]): Promise<boolean> {
			if (!viewer.itemKey) { ui.showToast("This file has no parent item to attach a note to."); return false; }
			if (!anns.length) { ui.showToast("No annotations to add."); return false; }
			try {
				const r = await fetch("/api/items", {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ data: { itemType: "note", parentItem: viewer.itemKey, note: notesHtml(anns) } }),
				});
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				ui.showToast(`Added a note with ${anns.length} annotation${anns.length === 1 ? "" : "s"} to the item.`);
				return true;
			} catch (e) {
				ui.showToast(`Could not create the note: ${e instanceof Error ? e.message : e}`);
				return false;
			}
		},
	};
	return act;
}
export type Actions = ReturnType<typeof createActions>;

export interface Ctx {
	viewer: ViewerHandle;
	store: Store;
	ui: Ui;
	act: Actions;
}
