// The `reader` import (reader.wit `reader`): open readers, state, navigation, selection, page text, themes, and the registration of
// slots, menus, panels, overlays and link interceptors. PDF readers only: EPUB and snapshot tabs are not listed (they run in the web
// reader, see phase2-reader.md), and the calls that need them answer `unavailable`.
import { readerAppearance, setReaderAppearance, SEPIA } from "../../reader/core/appearance";
import { readerMode } from "../../reader/env";
import { pageLabelFor, type Annotation } from "../../reader/annotations/model";
import { bgraToPng } from "../../reader/annotations/imageExport";
import { sessionOf, type Tool } from "../../reader/annotations/session";
import { opsOf, type ReaderOps } from "../../reader/ops";
import { renderRegion } from "../../reader/structure/regions";
import type { ReaderContext } from "../../reader/plugins";
import { apiRequest } from "../../api";
import { witSelectionOf } from "./bridge";
import { allReaders, findReader, infoOf, readerApp, requireReader } from "./host";
import { changed, invalidate, regsFor, unregisterId } from "./registry";
import {
	fail,
	type EventKind,
	type FindState,
	type LinkInterceptorRegistration,
	type ListenerRegistration,
	type OverlayRegistration,
	type PanelRegistration,
	type PluginCtx,
	type ReaderInfo,
	type ReaderState,
	type ToolKind,
	type ToolState,
	type ViewStats,
	type WitLocation,
} from "./types";

const opsFor = (ctx: ReaderContext): ReaderOps => opsOf(ctx) ?? fail("unavailable", "this reader has no controls yet (it is still opening)");
const pdfOnly = (what: string): never => fail("unavailable", `${what} is available for PDF readers only`);

// ---------------------------------------------------------------- state

const TOOL_OF: Record<string, Tool | null> = { pointer: null, highlight: "highlight", underline: "underline", note: "note", ink: "ink", eraser: "eraser" };

function viewStats(c: ReaderContext, o: ReaderOps): ViewStats {
	const s = o.state();
	const labels = sessionOf(c.attachmentKey)?.store.list() ?? [];
	return {
		pageIndex: s.page,
		pageLabel: pageLabelFor(s.page, labels),
		pagesCount: s.pages,
		zoom: s.zoom,
		zoomMode: s.zoomMode === "width" ? "page-width" : s.zoomMode === "page" ? "auto" : "custom",
		scrollMode: s.scroll,
		spreadMode: s.spread,
		flowMode: undefined,
		canGoBack: s.canBack,
		canGoForward: s.canForward,
	};
}

export function readerState(c: ReaderContext): ReaderState {
	const o = opsFor(c);
	const s = o.state();
	const sess = sessionOf(c.attachmentKey);
	const tool = sess?.ui.tool();
	const find: FindState = {
		active: s.find.query.trim() !== "",
		query: s.find.query,
		caseSensitive: false,
		entireWord: false,
		highlightAll: true,
		total: s.find.query.trim() ? s.find.total : undefined,
		index: s.find.index >= 0 ? s.find.index : undefined,
	};
	return {
		info: infoOf(c),
		primary: viewStats(c, o),
		secondary: undefined,
		primaryIsActive: true,
		primaryViewState: JSON.stringify({ pageIndex: s.page, scale: s.zoomMode === "custom" ? String(s.zoom) : s.zoomMode === "width" ? "page-width" : "page-fit", scrollMode: s.scroll, spreadMode: s.spread, rotation: s.rotation }),
		secondaryViewState: undefined,
		tool: { kind: (tool ?? "pointer") as ToolKind, color: sess?.ui.color() },
		selectedAnnotations: sess?.ui.selectedId() ? [sess.ui.selectedId()!] : [],
		filter: { query: "", colors: [], tags: [], authors: [] },
		showAnnotations: true,
		sidebar: { open: s.sidebar.open, view: s.sidebar.tab === "thumbs" ? "thumbnails" : (s.sidebar.tab?.replace(/^plugin:.*:/, "") ?? "annotations"), width: Math.round(s.sidebar.width) },
		split: undefined,
		find,
	};
}

// ---------------------------------------------------------------- locations

const MARGIN = 0.06; // as annotations' jump(): a little above the annotation

function annotationY(c: ReaderContext, a: Annotation): number {
	const r = a.position.rects?.[0];
	if (!r) return -1;
	return Math.max(0, 1 - r[3] / c.pageSize(a.position.pageIndex).h - MARGIN);
}

/** A `location` as a page and a height (0..1 from the top, -1 unknown). The first field that is set wins, in WIT order. */
function resolveLocation(c: ReaderContext, loc: WitLocation): { page: number; y: number } {
	if (loc.annotation) {
		const a = sessionOf(c.attachmentKey)?.store.get(loc.annotation) ?? fail("not-found", `annotation ${loc.annotation} in this reader`);
		return { page: a.position.pageIndex, y: annotationY(c, a) };
	}
	if (loc.position) {
		let p: { pageIndex?: number; rects?: number[][] };
		try {
			p = JSON.parse(loc.position);
		} catch {
			return fail("invalid-argument", "location.position is not JSON");
		}
		if (typeof p.pageIndex !== "number") return fail("invalid-argument", "location.position has no pageIndex");
		const r = p.rects?.[0];
		return { page: p.pageIndex, y: r && r.length === 4 ? Math.max(0, 1 - r[3]! / c.pageSize(p.pageIndex).h - MARGIN) : -1 };
	}
	if (loc.pdfDest) return fail("unavailable", "navigating to a PDF destination is not supported yet (use page-index)");
	if (loc.pageIndex !== undefined) return { page: loc.pageIndex, y: -1 };
	if (loc.pageLabel !== undefined) {
		const labels = sessionOf(c.attachmentKey)?.store.list() ?? [];
		const hit = labels.find((a) => a.pageLabel === loc.pageLabel);
		if (hit) return { page: hit.position.pageIndex, y: -1 };
		const n = Number(loc.pageLabel);
		if (Number.isInteger(n) && n >= 1) return { page: n - 1, y: -1 };
		return fail("not-found", `page label ${JSON.stringify(loc.pageLabel)}`);
	}
	if (loc.cfi !== undefined || loc.href !== undefined) return pdfOnly("cfi and href locations");
	if (loc.scrollYPercent !== undefined) return fail("unavailable", "scroll-y-percent is for EPUB and snapshots; use page-index");
	return fail("invalid-argument", "the location is empty");
}

// ---------------------------------------------------------------- themes

const BUILTIN_THEMES = [
	{ id: "normal", label: "Normal", background: "#ffffff", foreground: "#000000", invertImages: false, builtin: true },
	{ id: "dark", label: "Dark", background: "#121212", foreground: "#e0e0e0", invertImages: true, builtin: true },
	{ id: "sepia", label: "Sepia", background: SEPIA, foreground: "#5b4636", invertImages: false, builtin: true },
];
type Theme = (typeof BUILTIN_THEMES)[number];
const customThemes = new Map<string, Theme>();
let choice: { light?: string; dark?: string } = {};

function applyChoice(): void {
	const id = readerMode()() === "dark" ? choice.dark : choice.light;
	if (!id) return;
	const t = BUILTIN_THEMES.find((x) => x.id === id) ?? customThemes.get(id);
	if (!t) return;
	const cur = readerAppearance();
	if (t.builtin) setReaderAppearance({ ...cur, mode: t.id as "normal" | "dark" | "sepia" });
	else setReaderAppearance({ ...cur, mode: "custom", custom: t.background });
}

// ---------------------------------------------------------------- the interface

export function createReaderApi() {
	const control = (ctx: PluginCtx, id: string) => {
		ctx.require("reader.control");
		const c = requireReader(id);
		return { c, o: opsFor(c) };
	};
	const read = (ctx: PluginCtx, id: string) => {
		ctx.require("reader.read");
		return requireReader(id);
	};
	const sessionFor = (c: ReaderContext) => sessionOf(c.attachmentKey);

	return {
		// ---- instances
		listReaders(ctx: PluginCtx): ReaderInfo[] {
			ctx.require("reader.read");
			return allReaders().map(infoOf);
		},
		getReader(ctx: PluginCtx, id: string): ReaderInfo | undefined {
			ctx.require("reader.read");
			const c = findReader(id);
			return c ? infoOf(c) : undefined;
		},
		getReaderByTab(ctx: PluginCtx, tab: string): ReaderInfo | undefined {
			ctx.require("reader.read");
			const c = findReader(tab);
			return c ? infoOf(c) : undefined;
		},
		selectedReader(ctx: PluginCtx): ReaderInfo | undefined {
			ctx.require("reader.read");
			const tab = readerApp().activeTab?.();
			const infos = allReaders().map(infoOf);
			return tab ? infos.find((i) => i.id === tab) : infos.find((i) => i.selected);
		},
		async open(
			ctx: PluginCtx,
			req: { target: { tag: "attachment"; val: { key: string } } | { tag: "item-uri"; val: string }; location?: WitLocation; title?: string; background: boolean },
		): Promise<ReaderInfo | undefined> {
			ctx.require("reader.control");
			const app = readerApp();
			if (!app.openAttachment) return fail("unavailable", "the app has not bound its tabs to the reader bridge");
			const key = req.target.tag === "attachment" ? req.target.val.key : (/items\/([23456789A-Z]{8})\b/.exec(req.target.val)?.[1] ?? fail("invalid-argument", `no item key in ${JSON.stringify(req.target.val)}`));
			let title = req.title ?? "";
			let parent = "";
			try {
				const d = await apiRequest<{ data?: { title?: unknown; parentItem?: unknown } }>("GET", `/items/${encodeURIComponent(key)}`);
				parent = typeof d.data?.parentItem === "string" ? d.data.parentItem : "";
				if (!title) title = String(d.data?.title ?? "") || "Reader";
			} catch {
				fail("not-found", `attachment ${key}`);
			}
			const before = app.activeTab?.();
			app.openAttachment(key, title, parent);
			if (req.background && before) app.setActiveTab?.(before);
			let c: ReaderContext | undefined;
			for (let i = 0; i < 60 && !(c = findReader(key)); i++) await Bun.sleep(50);
			if (!c) return undefined; // the tab is selected; the reader opens and an `opened` event follows
			if (req.location) {
				const { page, y } = resolveLocation(c, req.location);
				opsOf(c)?.goTo(page, y >= 0 ? y : undefined, false);
			}
			return infoOf(c);
		},
		close(ctx: PluginCtx, id: string): void {
			ctx.require("reader.control");
			requireReader(id);
			const close = readerApp().closeTab ?? fail("unavailable", "the app has not bound its tabs to the reader bridge");
			close(id);
		},
		focus(ctx: PluginCtx, id: string): void {
			const { o } = control(ctx, id);
			readerApp().setActiveTab?.(id);
			o.focus();
		},

		// ---- state
		getState(ctx: PluginCtx, id: string): ReaderState {
			return readerState(read(ctx, id));
		},
		getSelection(ctx: PluginCtx, id: string) {
			return witSelectionOf(read(ctx, id));
		},
		getOutline(ctx: PluginCtx, id: string) {
			const c = read(ctx, id);
			return (opsFor(c).outline() ?? []).map((e) => ({
				title: e.t,
				depth: e.l,
				location: { pageIndex: e.p, annotation: undefined, position: undefined, pdfDest: undefined, pageLabel: undefined, cfi: undefined, href: undefined, scrollYPercent: undefined },
			}));
		},
		getPageLabels(ctx: PluginCtx, id: string): string[] {
			const c = read(ctx, id);
			const list = sessionOf(c.attachmentKey)?.store.list() ?? [];
			return Array.from({ length: c.pageCount() }, (_, i) => pageLabelFor(i, list));
		},
		async getPageText(ctx: PluginCtx, id: string, pages: number[], withWords: boolean) {
			const c = read(ctx, id);
			const n = c.pageCount();
			const out = [];
			for (const p of pages) {
				if (!Number.isInteger(p) || p < 0 || p >= n) return fail("invalid-argument", `page ${p} is outside 0..${n - 1}`);
				const { words } = await c.textLayer(p);
				const size = c.pageSize(p);
				let text = "";
				let line = -1;
				for (const w of words) {
					if (!w.t) continue;
					text += text ? (w.l !== line ? "\n" : " ") : "";
					line = w.l;
					text += w.t;
				}
				out.push({
					pageIndex: p,
					width: size.w,
					height: size.h,
					text,
					words: withWords
						? words
								.filter((w) => w.t)
								.map((w) => ({ text: w.t, rect: [w.x * size.w, (1 - w.y - w.h) * size.h, (w.x + w.w) * size.w, (1 - w.y) * size.h] as [number, number, number, number], line: w.l }))
						: [],
				});
			}
			return out;
		},
		async renderPage(ctx: PluginCtx, id: string, page: number, scale: number, clip?: [number, number, number, number]) {
			const c = read(ctx, id);
			if (!Number.isInteger(page) || page < 0 || page >= c.pageCount()) return fail("invalid-argument", `page ${page} is outside 0..${c.pageCount() - 1}`);
			if (!(scale > 0 && scale <= 8)) return fail("invalid-argument", "scale must be in (0, 8]");
			const size = c.pageSize(page);
			const rect = clip ?? ([0, 0, size.w, size.h] as [number, number, number, number]);
			const crop = await renderRegion(c, page, rect, Math.max(2, Math.round(Math.abs(rect[2] - rect[0]) * scale)));
			if (!crop) return fail("unavailable", "the page could not be drawn");
			return { mime: "image/png", width: crop.width, height: crop.height, bytes: new Uint8Array(bgraToPng(crop.pixels, crop.width, crop.height)) };
		},

		// ---- control
		navigate(ctx: PluginCtx, id: string, loc: WitLocation, options: { skipHistory: boolean }): void {
			const { c, o } = control(ctx, id);
			const { page, y } = resolveLocation(c, loc);
			if (page < 0 || page >= c.pageCount()) fail("invalid-argument", `page ${page} is outside 0..${c.pageCount() - 1}`);
			o.goTo(page, y >= 0 ? y : undefined, !options?.skipHistory);
		},
		navigateStep(ctx: PluginCtx, id: string, step: string): void {
			const { c, o } = control(ctx, id);
			const cur = o.state().page;
			const last = c.pageCount() - 1;
			switch (step) {
				case "back":
					return o.back();
				case "forward":
					return o.forward();
				case "first-page":
					return o.goTo(0, undefined, true);
				case "last-page":
					return o.goTo(last, undefined, true);
				case "previous-page":
					return o.goTo(Math.max(0, cur - 1), undefined, true);
				case "next-page":
					return o.goTo(Math.min(last, cur + 1), undefined, true);
				default:
					return fail("unavailable", `${step} needs a document outline of sections (EPUB)`);
			}
		},
		runCommand(ctx: PluginCtx, id: string, command: string): void | Promise<unknown> {
			const { c, o } = control(ctx, id);
			switch (command) {
				case "zoom-in":
					return o.zoomBy(1.1);
				case "zoom-out":
					return o.zoomBy(1 / 1.1);
				case "zoom-reset":
					return o.setZoom(1);
				case "zoom-auto":
				case "zoom-page-height":
					return o.fitPage();
				case "zoom-page-width":
					return o.fitWidth();
				case "copy":
					if (!o.copySelection()) fail("not-found", "no text is selected");
					return;
				case "print":
					return o.print();
				case "close-find":
					return o.search("");
				case "show-in-library": {
					const app = readerApp();
					if (!app.setActiveTab) return fail("unavailable", "the app has not bound its tabs to the reader bridge");
					app.setActiveTab("library");
					if (c.itemKey) app.selectItem?.(c.itemKey);
					return;
				}
				default:
					return fail("unavailable", `the reader command ${command} is not available in Zinc`);
			}
		},
		setLayout(ctx: PluginCtx, id: string, layout: { scrollMode?: string; spreadMode?: string; flowMode?: string }): void {
			const { o } = control(ctx, id);
			if (layout.flowMode !== undefined) pdfOnly("flow-mode");
			if (layout.scrollMode === "page") fail("unavailable", "the page scroll mode is not available in Zinc");
			o.setLayout(layout.scrollMode as "vertical" | "horizontal" | "wrapped" | undefined, layout.spreadMode as "none" | "odd" | "even" | undefined);
		},
		setTool(ctx: PluginCtx, id: string, tool: ToolState): void {
			const { c } = control(ctx, id);
			if (!(tool.kind in TOOL_OF)) return fail("unavailable", `the ${tool.kind} tool is not available in Zinc yet`);
			const s = sessionFor(c) ?? fail("unavailable", "the annotations plugin is not running in this reader");
			if (c.readOnly && tool.kind !== "pointer") fail("read-only", "the reader is read-only");
			if (tool.color !== undefined) s.ui.setColor(tool.color.toLowerCase());
			s.ui.setTool(TOOL_OF[tool.kind]!);
		},
		setFilter(ctx: PluginCtx, id: string): never {
			control(ctx, id);
			return fail("unavailable", "the annotation filter is kept by the sidebar and cannot be set from a plugin yet");
		},
		showAnnotations(ctx: PluginCtx, id: string): never {
			control(ctx, id);
			return fail("unavailable", "hiding annotations on the page is not available in Zinc yet");
		},
		selectAnnotations(ctx: PluginCtx, id: string, keys: string[], navigate: boolean): void {
			const { c } = control(ctx, id);
			const s = sessionFor(c) ?? fail("unavailable", "the annotations plugin is not running in this reader");
			const first = keys[0] ? (s.store.get(keys[0]) ?? fail("not-found", `annotation ${keys[0]}`)) : undefined;
			if (!first) {
				s.ui.select(null);
				return;
			}
			if (navigate) s.act.jump(first);
			else s.ui.select(first.id);
		},
		clearSelection(ctx: PluginCtx, id: string): void {
			const { c } = control(ctx, id);
			c.clearSelection();
			sessionFor(c)?.ui.select(null);
		},
		setSidebar(ctx: PluginCtx, id: string, open?: boolean, view?: string): void {
			const { o } = control(ctx, id);
			const cur = o.state().sidebar;
			o.setSidebar(open ?? cur.open, view === "thumbnails" ? "thumbs" : view);
		},
		setSplit(ctx: PluginCtx, id: string, orientation?: string): void {
			control(ctx, id);
			if (orientation !== undefined) fail("unavailable", "Zinc's PDF reader has no split view");
		},
		find(ctx: PluginCtx, id: string, req: { action: string; query: string }): FindState {
			const { c, o } = control(ctx, id);
			switch (req.action) {
				case "start":
					o.search(req.query);
					break;
				case "next":
					o.findStep(1);
					break;
				case "previous":
					o.findStep(-1);
					break;
				case "close":
					o.search("");
					break;
				default:
					fail("invalid-argument", `find action ${req.action}`);
			}
			return readerState(c).find;
		},
		async rotatePages(ctx: PluginCtx, id: string, pages: number[], degrees: number): Promise<void> {
			const { o } = control(ctx, id);
			ctx.require("library.files.write");
			if (![90, 180, 270].includes(degrees)) fail("invalid-argument", "degrees must be 90, 180 or 270");
			await o.rotatePages(pages, degrees / 90);
		},
		async deletePages(ctx: PluginCtx, id: string, pages: number[]): Promise<boolean> {
			const { c, o } = control(ctx, id);
			ctx.require("library.files.write");
			const before = c.pageCount();
			await o.deletePages(pages, true);
			return c.pageCount() < before;
		},

		// ---- themes
		listThemes(ctx: PluginCtx) {
			ctx.require("reader.read");
			return [...BUILTIN_THEMES, ...customThemes.values()];
		},
		getThemeChoice() {
			return { light: choice.light, dark: choice.dark };
		},
		setThemeChoice(ctx: PluginCtx, c: { light?: string; dark?: string }): void {
			ctx.require("reader.themes");
			for (const id of [c.light, c.dark]) if (id && !BUILTIN_THEMES.some((t) => t.id === id) && !customThemes.has(id)) fail("not-found", `theme ${id}`);
			choice = { light: c.light, dark: c.dark };
			applyChoice();
		},
		saveTheme(ctx: PluginCtx, t: Theme): void {
			ctx.require("reader.themes");
			if (BUILTIN_THEMES.some((b) => b.id === t.id)) fail("read-only", `${t.id} is a built-in theme`);
			if (!t.id) fail("invalid-argument", "theme id is empty");
			customThemes.set(t.id, { ...t, builtin: false });
		},
		deleteTheme(ctx: PluginCtx, id: string): void {
			ctx.require("reader.themes");
			if (BUILTIN_THEMES.some((b) => b.id === id)) fail("read-only", `${id} is a built-in theme`);
			if (!customThemes.delete(id)) fail("not-found", `theme ${id}`);
		},

		// ---- registration
		registerListener(ctx: PluginCtx, r: ListenerRegistration): void {
			ctx.require("reader.ui");
			if (!r.id) fail("invalid-argument", "registration id is empty");
			regsFor(ctx.pluginId).listeners.set(r.id, { ...r, readerKinds: r.readerKinds ?? [], staticMenu: r.staticMenu ?? [] });
			changed();
		},
		registerPanel(ctx: PluginCtx, r: PanelRegistration): void {
			ctx.require("reader.ui");
			if (!r.id) fail("invalid-argument", "registration id is empty");
			regsFor(ctx.pluginId).panels.set(r.id, r);
			changed();
		},
		registerOverlay(ctx: PluginCtx, r: OverlayRegistration): void {
			ctx.require("reader.ui");
			if (!r.id) fail("invalid-argument", "registration id is empty");
			regsFor(ctx.pluginId).overlays.set(r.id, r);
			changed();
		},
		registerLinkInterceptor(ctx: PluginCtx, r: LinkInterceptorRegistration): void {
			ctx.require("reader.ui");
			if (!r.id) fail("invalid-argument", "registration id is empty");
			regsFor(ctx.pluginId).interceptors.set(r.id, r);
			changed();
		},
		unregister(ctx: PluginCtx, id: string): void {
			unregisterId(ctx.pluginId, id);
		},
		invalidate(ctx: PluginCtx, id: string, reader?: string): void {
			invalidate(ctx.pluginId, id, reader);
		},
		subscribe(ctx: PluginCtx, kinds: EventKind[]): void {
			ctx.require("reader.read");
			regsFor(ctx.pluginId).events = new Set(kinds);
		},
	};
}
export type ReaderApi = ReturnType<typeof createReaderApi>;
