// annotations/ plugin entry (see ../contract.ts): shows, creates and edits Zotero reader annotations.
// Storage is the core's /api/attachments/:key/annotations (Zotero reader JSON, synced into Zotero's database), so
// annotations made here appear in Zotero's own reader. Annotations embedded in the PDF file are painted by PDFium
// (the page raster uses withAnnotations) and are not touched.
import { render } from "solid-js/web";
import type { ReaderPlugin } from "../contract";
import { createActions, type Ctx } from "./actions";
import { PageAnnotations } from "./Overlay";
import { AnnotationsPanel } from "./Panel";
import { Popups } from "./Popups";
import { createUi, type Tool } from "./state";
import { createStore } from "./store";

const TOOLS: { id: Tool; title: string; icon: string }[] = [
	{ id: "highlight", title: "Highlight text", icon: "ann-highlight" },
	{ id: "underline", title: "Underline text", icon: "ann-underline" },
	{ id: "note", title: "Add note", icon: "ann-note" },
	{ id: "image", title: "Select area", icon: "ann-area" },
	{ id: "ink", title: "Draw", icon: "ann-ink" },
];

const isTyping = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input,textarea,select,[contenteditable]");

export const annotationsPlugin: ReaderPlugin = (viewer) => {
	const store = createStore(viewer.attachmentKey);
	const ui = createUi();
	const act = createActions(viewer, store, ui);
	const ctx: Ctx = { viewer, store, ui, act };
	const off: (() => void)[] = [];
	const listen = <K extends keyof WindowEventMap>(target: Window | Document, type: K | string, fn: (e: any) => void, capture = false) => {
		target.addEventListener(type, fn, capture);
		off.push(() => target.removeEventListener(type, fn, capture));
	};

	void store.load().catch((e) => console.warn("[annotations] could not load:", e));

	// ---- drawing: one Solid tree per mounted page overlay
	off.push(viewer.onPageOverlay((page, layer, toScreen) => {
		const host = document.createElement("div");
		host.className = "rn-ann-layer";
		layer.appendChild(host);
		const dispose = render(() => <PageAnnotations ctx={ctx} page={page} toScreen={toScreen} />, host);
		return () => { dispose(); host.remove(); };
	}));

	// ---- sidebar tab + toolbar tools
	off.push(viewer.addSidebarTab({
		id: "annotations", title: "Annotations", icon: "annotations",
		render: (container) => render(() => <AnnotationsPanel ctx={ctx} />, container),
	}));
	for (const t of TOOLS) {
		off.push(viewer.addToolbarButton({
			id: `ann-${t.id}`, title: t.title, icon: t.icon,
			active: () => ui.tool() === t.id,
			onClick: () => {
				const next = ui.tool() === t.id ? null : t.id;
				ui.setTool(next);
				if (next) { ui.select(null); viewer.clearSelection(); }
			},
		}));
	}

	// ---- popups (selection, selected annotation, tool colours)
	const popupHost = document.createElement("div");
	document.body.appendChild(popupHost);
	const disposePopups = render(() => <Popups ctx={ctx} />, popupHost);
	off.push(() => { disposePopups(); popupHost.remove(); });

	off.push(viewer.onSelection((s) => ui.setSelection(s)));
	off.push(viewer.onViewChange(() => ui.bump()));

	// text tools create the annotation as soon as the selection is released
	listen(document, "pointerdown", (e: PointerEvent) => {
		if (e.button === 0 && (e.target as Element).closest?.(".rn-page")) ui.setDragging(true);
	}, true);
	const release = () => {
		if (!ui.dragging()) return;
		setTimeout(() => {
			ui.setDragging(false);
			const t = ui.tool();
			if ((t === "highlight" || t === "underline") && viewer.selection()) void act.fromSelection(t, ui.color());
		}, 0);
	};
	listen(window, "pointerup", release, true);
	listen(window, "pointercancel", release, true);

	// click an annotation to select it; click empty page to deselect
	listen(document, "click", (e: MouseEvent) => {
		if (e.button !== 0 || ui.tool()) return;
		const t = e.target as Element;
		if (!t.closest?.("[data-scroller]")) return;
		if (window.getSelection()?.toString()) return;
		ui.select(act.at(e.clientX, e.clientY)?.id ?? null);
	});

	listen(window, "keydown", (e: KeyboardEvent) => {
		if (isTyping(e.target)) return;
		if ((e.key === "Delete" || e.key === "Backspace") && ui.selectedId()) {
			e.preventDefault();
			act.remove([ui.selectedId()!]);
		} else if (e.key === "Escape") {
			if (ui.tool()) ui.setTool(null);
			else if (ui.selectedId()) ui.select(null);
		}
	});

	const flush = () => void store.flush(true);
	listen(window, "pagehide", flush);
	listen(document, "visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });

	(window as unknown as { __rnAnn: unknown }).__rnAnn = { store, ui, act }; // test hook, like __rn

	return () => { for (const d of off.splice(0)) d(); store.dispose(); };
};
