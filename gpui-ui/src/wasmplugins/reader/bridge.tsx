// Turns what WASM plugins registered (registry.ts) into Zinc's in-process reader plugins (src/reader/plugins.ts): one `ReaderPlugin`
// per WASM plugin for slots, menus, overlays and link interceptors, and one per panel (the reader keeps a single sidePanel / altView
// per plugin object). The reader re-reads `readerPlugins()` on every change, so a registration shows at once.
//
//   WIT slot toolbar / text-selection-popup / sidebar-annotation-header   -> toolbar / selectionPopup / annotationHeader
//   WIT menu annotation / view / thumbnail / color / selector / theme     -> annotationMenu / viewMenu / thumbnailMenu / colorMenu / selectorMenu / themeMenu
//   WIT panel sidebar-tab / alt-view                                      -> sidePanel / altView
//   WIT overlay                                                           -> pageOverlay          WIT link interceptor -> ReaderContext.onLink
import { createEffect, createRoot, createSignal, For, on, onCleanup, Show, untrack, type Accessor, type JSX } from "solid-js";
import { withAlpha } from "../../theme";
import type { Annotation } from "../../reader/annotations/model";
import { pageLabelFor } from "../../reader/annotations/model";
import { sessionOf } from "../../reader/annotations/session";
import { openReaders, registerReaderPlugin, unregisterReaderPlugin, type ReaderContext, type ReaderPlugin } from "../../reader/plugins";
import { opsOf } from "../../reader/ops";
import { toWitAnnotation, toWitSelection } from "./convert";
import { infoOf, readerApp } from "./host";
import { callPlugin, notifyPlugin } from "./link";
import { pluginMenuFor, warmMenus } from "./menus";
import { invalidationOf, registrationRev, regsOf, pluginsWithRegs } from "./registry";
import type { ListenerRegistration, OverlayShape, SlotKind } from "./types";
import { WasmView } from "./view";

const pdfOnly = (kinds: string[]) => !kinds.length || kinds.includes("pdf");
const idOf = (plugin: string) => `wasm:${plugin}`;
const panelIdOf = (plugin: string, panel: string) => `wasm:${plugin}#${panel}`;

/** The annotation as a plugin sees it (library from the app, read-only from the reader). */
export function witAnnotationOf(ctx: ReaderContext, a: Annotation) {
	const info = infoOf(ctx);
	return toWitAnnotation(a, { library: info.attachment.library, attachment: ctx.attachmentKey, readOnly: !!ctx.readOnly });
}

/** The current selection as a `text-selection`, or undefined. */
export function witSelectionOf(ctx: ReaderContext) {
	const sel = ctx.selection();
	if (!sel) return undefined;
	const color = sessionOf(ctx.attachmentKey)?.ui.color() ?? "#ffd400";
	const label = pageLabelFor(sel.page, sessionOf(ctx.attachmentKey)?.store.list() ?? []);
	return toWitSelection(sel, (p) => ctx.pageSize(p), color, label);
}

// ---------------------------------------------------------------------------------------------------------------- overlays

const shapeCache = new Map<string, Promise<OverlayShape[]>>();
function overlayShapes(plugin: string, reg: string, ctx: ReaderContext, page: number): Promise<OverlayShape[]> {
	const key = `${plugin}\u0000${reg}\u0000${ctx.attachmentKey}\u0000${page}\u0000${invalidationOf(plugin, reg, ctx.attachmentKey)}`;
	let p = shapeCache.get(key);
	if (!p) {
		if (shapeCache.size > 300) shapeCache.delete(shapeCache.keys().next().value!);
		p = callPlugin(plugin, "reader-events", "render-overlay", [reg, infoOf(ctx), page]).then((r) => (Array.isArray(r) ? (r as OverlayShape[]) : []));
		p.catch(() => shapeCache.delete(key));
		shapeCache.set(key, p);
	}
	return p;
}
export const clearOverlayCache = (): void => shapeCache.clear();

function OverlayLayer(p: {
	plugin: string;
	reg: string;
	ctx: ReaderContext;
	page: number;
	box: Accessor<{ width: number; height: number }>;
}): JSX.Element {
	const [shapes, setShapes] = createSignal<OverlayShape[]>([]);
	let gen = 0;
	createEffect(() => {
		const my = ++gen;
		overlayShapes(p.plugin, p.reg, p.ctx, p.page).then(
			(s) => my === gen && setShapes(s),
			(e) => console.error(`[wasm-reader] ${p.plugin} render-overlay:`, e instanceof Error ? e.message : e),
		);
	});
	const size = () => p.ctx.pageSize(p.page);
	const sc = () => p.box().width / size().w;
	return (
		<For each={shapes()}>
			{(s) => (
				<For each={s.rects}>
					{(r) => {
						const color = () => s.color ?? "#2ea8e5";
						const geo = () => ({
							left: r[0] * sc(),
							top: (size().h - r[3]) * sc(),
							width: Math.max(1, (r[2] - r[0]) * sc()),
							height: Math.max(1, (r[3] - r[1]) * sc()),
						});
						const base = (): Record<string, unknown> => ({ position: "absolute", ...geo(), pointerEvents: s.command ? "auto" : "none" });
						return (
							<div
								onClick={
									s.command
										? () => notifyPlugin(p.plugin, "reader-events", "on-overlay-click", [p.reg, infoOf(p.ctx), p.page, s.command])
										: undefined
								}
								style={
									s.kind === "fill"
										? { ...base(), backgroundColor: withAlpha(color(), s.opacity ?? 0.35) }
										: s.kind === "outline"
											? { ...base(), borderWidth: 1.5, borderColor: withAlpha(color(), s.opacity ?? 1) }
											: {
													...base(),
													height: 2,
													top: geo().top + geo().height - 2,
													backgroundColor: withAlpha(color(), s.opacity ?? 1),
												}
								}
							/>
						);
					}}
				</For>
			)}
		</For>
	);
}

// ---------------------------------------------------------------------------------------------------------------- plugin objects

function slotRegs(plugin: string, kind: SlotKind): ListenerRegistration[] {
	return [...(regsOf(plugin)?.listeners.values() ?? [])].filter((l) => l.target.tag === "slot" && l.target.val === kind && pdfOnly(l.readerKinds));
}
const hasMenu = (plugin: string, kind: string) =>
	[...(regsOf(plugin)?.listeners.values() ?? [])].some((l) => l.target.tag === "menu" && l.target.val === kind && pdfOnly(l.readerKinds));

/** The links a plugin claims. Reads the registry live, so an interceptor registered after the document opened still works. */
function linkHandler(plugin: string, ctx: ReaderContext) {
	return (e: { page: number; target: { kind: "page"; page: number; y: number } | { kind: "uri"; uri: string } }): boolean => {
		const claims = [...(regsOf(plugin)?.interceptors.values() ?? [])].filter((i) => (e.target.kind === "page" ? i.internal : i.external));
		if (!claims.length) return false;
		const target =
			e.target.kind === "page"
				? { tag: "page", val: { pageIndex: e.target.page, y: e.target.y >= 0 ? e.target.y : undefined } }
				: { tag: "uri", val: e.target.uri };
		for (const c of claims) notifyPlugin(plugin, "reader-events", "on-link", [c.id, { reader: infoOf(ctx), pageIndex: e.page, target }]);
		return true;
	};
}

export function buildReaderPlugins(plugin: string): ReaderPlugin[] {
	const regs = regsOf(plugin);
	if (!regs) return [];
	const out: ReaderPlugin[] = [];
	const main: ReaderPlugin = { id: idOf(plugin) };
	const view = (ctx: ReaderContext, reg: ListenerRegistration, surface: "toolbar-slot" | "popover", extra: () => Record<string, unknown>) => (
		<WasmView
			plugin={plugin}
			view={reg.id}
			surface={surface}
			params={() => ({ slot: (reg.target as { val: string }).val, reader: infoOf(ctx), ...extra() })}
		/>
	);

	const toolbar = slotRegs(plugin, "toolbar");
	if (toolbar.length)
		main.toolbar = (ctx) => (
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>
				<For each={toolbar}>{(reg) => view(ctx, reg, "toolbar-slot", () => ({}))}</For>
			</div>
		);
	const popup = slotRegs(plugin, "text-selection-popup");
	if (popup.length)
		main.selectionPopup = (ctx) => (
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
				<For each={popup}>{(reg) => view(ctx, reg, "popover", () => ({ selection: witSelectionOf(ctx) }))}</For>
			</div>
		);
	const header = slotRegs(plugin, "sidebar-annotation-header");
	if (header.length)
		main.annotationHeader = (ctx, a) => (
			<div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 4 }}>
				<For each={header}>
					{(reg) => (
						<Show when={a()}>{view(ctx, reg, "toolbar-slot", () => ({ annotation: a() ? witAnnotationOf(ctx, a()) : undefined }))}</Show>
					)}
				</For>
			</div>
		);

	if (hasMenu(plugin, "annotation"))
		main.annotationMenu = (ctx, e) =>
			pluginMenuFor(plugin, "annotation", infoOf(ctx), {
				tag: "annotation",
				val: { annotations: [witAnnotationOf(ctx, e.annotation)], current: e.annotation.id, fromView: false, popup: false },
			});
	if (hasMenu(plugin, "view")) main.viewMenu = (ctx) => pluginMenuFor(plugin, "view", infoOf(ctx), { tag: "view" });
	if (hasMenu(plugin, "thumbnail"))
		main.thumbnailMenu = (ctx, pages) => pluginMenuFor(plugin, "thumbnail", infoOf(ctx), { tag: "thumbnail", val: pages });
	if (hasMenu(plugin, "color")) main.colorMenu = (ctx) => pluginMenuFor(plugin, "color", infoOf(ctx), { tag: "color" });
	if (hasMenu(plugin, "selector"))
		main.selectorMenu = (ctx, e) =>
			pluginMenuFor(plugin, "selector", infoOf(ctx), { tag: "selector", val: { enableClearSelection: e.enableClearSelection } });
	if (hasMenu(plugin, "theme"))
		main.themeMenu = (ctx, e) => pluginMenuFor(plugin, "theme", infoOf(ctx), { tag: "theme", val: e.theme });

	const overlays = [...regs.overlays.values()].filter((o) => pdfOnly(o.readerKinds));
	if (overlays.length)
		main.pageOverlay = (ctx, page, box) => (
			<For each={overlays}>{(o) => <OverlayLayer plugin={plugin} reg={o.id} ctx={ctx} page={page} box={box} />}</For>
		);

	// links: always attached on open (the handler reads the registry live); a plugin object exists only while it has registrations
	main.onOpen = (ctx) => ctx.onLink?.(linkHandler(plugin, ctx) as never);

	const empty =
		!main.toolbar &&
		!main.selectionPopup &&
		!main.annotationHeader &&
		!main.annotationMenu &&
		!main.viewMenu &&
		!main.thumbnailMenu &&
		!main.colorMenu &&
		!main.selectorMenu &&
		!main.themeMenu &&
		!main.pageOverlay &&
		!regs.interceptors.size;
	if (!empty) out.push(main);

	for (const pn of regs.panels.values()) {
		if (!pdfOnly(pn.readerKinds)) continue;
		const label = pn.label.tag === "plain" ? pn.label.val : (pn.label.val.fallback ?? pn.label.val.id);
		const icon = pn.icon?.tag === "builtin" ? pn.icon.val : "puzzle";
		const render = (ctx: ReaderContext) => (
			<WasmView plugin={plugin} view={pn.id} surface={pn.placement === "alt-view" ? "reader-overlay" : "reader-sidebar"} params={() => ({ slot: "panel", reader: infoOf(ctx), invalidated: invalidationOf(plugin, pn.id, ctx.attachmentKey) })} />
		);
		const rp: ReaderPlugin = { id: panelIdOf(plugin, pn.id) };
		if (pn.placement === "alt-view") rp.altView = { id: pn.id, label, icon, render };
		else rp.sidePanel = { id: pn.id, label, icon, render };
		out.push(rp);
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------------------- sync

const registered = new Set<string>();
let disposeSync: (() => void) | undefined;

/** Keep `readerPlugins()` in step with the registry. Idempotent. Returns the stop function. */
export function startReaderSync(): () => void {
	if (disposeSync) return disposeSync;
	disposeSync = createRoot((dispose) => {
		createEffect(() => {
			registrationRev();
			const want = new Map<string, ReaderPlugin>();
			for (const plugin of pluginsWithRegs()) for (const rp of buildReaderPlugins(plugin)) want.set(rp.id, rp);
			for (const id of [...registered]) if (!want.has(id)) (unregisterReaderPlugin(id), registered.delete(id));
			for (const [id, rp] of want) {
				registerReaderPlugin(rp);
				registered.add(id);
			}
			// menus that need no parameters are asked for now, so the first opening has them (menus.ts)
			untrack(() => warmMenus(openReaders().map(infoOf)));
		});
		createEffect(on(() => openReaders().length, () => untrack(() => warmMenus(openReaders().map(infoOf)))));
		onCleanup(() => {
			for (const id of registered) unregisterReaderPlugin(id);
			registered.clear();
		});
		return () => {
			dispose();
			disposeSync = undefined;
		};
	});
	return disposeSync;
}
