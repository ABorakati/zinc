// OverlayHost (menus, dialogs, popovers, toasts, tooltips drawn above everything), Popover, Tooltip and toast().
// Every layer is a deferred `anchored` GPUIX element, so it paints above the whole window and its hit area blocks the
// content below. Toasts and tooltips do not take clicks outside their own box.
import { createEffect, For, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js";
import { createWindowSize, useGpuix, type HostElement } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/native";
import type { Style } from "../contracts";
import { Icon } from "../icons";
import { DialogLayerView } from "./dialogs";
import {
	addToast, armToast, boundsOf, dismissToast, focusedId, hideTooltip, newId, overlayLayers, pauseToast, placeAt, pushLayer, removeLayer,
	restoreFocus, setNative, setWindowSignal, showTooltip, t, toastList, tok, tooltipState, tx, windowSize,
	type Anchor, type NativeLike, type PopoverLayer, type Rect, type ToastItem,
} from "./core";
import { MenuLayerView } from "./menu";

/** Mount once at the root of App: renders open menus, dialogs, popovers, toasts and tooltips above everything. */
export function OverlayHost(): JSX.Element {
	const g = useGpuix();
	setNative(g?.renderer as unknown as NativeLike | undefined);
	onCleanup(() => setNative(undefined));
	try {
		const size = createWindowSize();
		createEffect(() => { const s = size(); setWindowSignal(s.width, s.height); });
	} catch { /* a renderer without getWindowSize: the 1440x881 fallback stays */ }
	return (
		<div style={{ position: "absolute", top: 0, left: 0, width: 0, height: 0 }}>
			<For each={overlayLayers()}>{(layer, i) => {
				const priority = 100 + i() * 10;
				return (
					<Switch>
						<Match when={layer.kind === "menu"}><MenuLayerView layer={layer as never} priority={priority} /></Match>
						<Match when={layer.kind === "dialog"}><DialogLayerView layer={layer as never} priority={priority} /></Match>
						<Match when={layer.kind === "popover"}><PopoverLayerView layer={layer as PopoverLayer} priority={priority} /></Match>
					</Switch>
				);
			}}</For>
			<ToastStack />
			<TooltipView />
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------- Popover

/** Anchored popover (hover-card / popover in the web UI): "w-72 rounded-md border bg-popover p-4 shadow-md"; Escape or a click outside calls onClose. */
export function Popover(p: { open: boolean; onClose: () => void; anchor: Anchor; children: JSX.Element; width?: number }): JSX.Element {
	const id = newId();
	let prevFocus: number | null = null;
	createEffect(on(() => p.open, (open) => {
		if (open) {
			prevFocus = focusedId();
			pushLayer({ kind: "popover", id, open: () => p.open, onClose: () => p.onClose(), anchor: () => p.anchor, width: () => p.width ?? 288, children: () => p.children });
		} else {
			removeLayer(id);
			restoreFocus(prevFocus);
			prevFocus = null;
		}
	}));
	onCleanup(() => removeLayer(id));
	return undefined as unknown as JSX.Element; // draws nothing here: the content renders in OverlayHost
}

function PopoverLayerView(p: { layer: PopoverLayer; priority: number }) {
	const l = p.layer;
	const pos = () => placeAt(l.anchor(), 160);
	return (
		<anchored fill="window" priority={p.priority} style={{ backgroundColor: "rgba(0, 0, 0, 0.004)" }} onClick={() => l.onClose()} onAuxClick={() => l.onClose()}>
			<div tabIndex={0} autoFocus onKeyDown={(e) => { if (e.key === "escape") l.onClose(); }} style={{ width: "100%", height: "100%", keyboardFocusDim: false }}>
				<anchored
					position={{ x: pos().x, y: pos().y }}
					anchor={pos().anchor}
					fit="snap"
					priority={p.priority + 1}
					style={{ ...t("flex flex-col rounded-md border bg-popover p-4 shadow-md"), width: l.width() }}
				>
					{l.children()}
				</anchored>
			</div>
		</anchored>
	);
}

// ---------------------------------------------------------------------------------------------------- Tooltip

const TOOLTIP_DELAY_MS = 500;

/**
 * Shows `label` in a small popover under the wrapped element after the pointer rests on it. The wrapper is a row; pass
 * `style` (addition) to change that, e.g. { flexGrow: 1 }.
 */
export function Tooltip(p: { label: string; children: JSX.Element; style?: Style }): JSX.Element {
	let el: HostElement | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; hideTooltip(); };
	onCleanup(cancel);
	const enter = (e: EventPayload) => {
		cancel();
		if (!p.label) return;
		const pointer = { x: e.x ?? 0, y: e.y ?? 0 };
		timer = setTimeout(() => { timer = undefined; showTooltip({ label: p.label, rect: boundsOf(el), pointer }); }, TOOLTIP_DELAY_MS);
	};
	return (
		<div ref={(x: HostElement) => { el = x; }} onMouseEnter={enter} onMouseLeave={cancel} onMouseDown={cancel} style={{ display: "flex", flexDirection: "row", ...p.style }}>
			{p.children}
		</div>
	);
}

function TooltipView() {
	return (
		<Show when={tooltipState()}>{(s) => {
			const pos = () => {
				const st = s();
				const win = windowSize();
				const r = st.rect;
				if (!r) return { x: st.pointer.x, y: st.pointer.y + 20, anchor: "topLeft" as const };
				const cx = r.x + r.width / 2;
				if (r.y + r.height + 4 + 36 > win.height - 8) return { x: cx, y: r.y - 4, anchor: "bottomCenter" as const };
				return { x: cx, y: r.y + r.height + 4, anchor: (st.rect ? "topCenter" : "topLeft") as "topCenter" };
			};
			return (
				<anchored
					ref={(el: HostElement) => { tipEl = el; }}
					position={{ x: pos().x, y: pos().y }}
					anchor={pos().anchor}
					fit="snap"
					priority={5000}
					occlude={false}
					style={{ ...t("rounded-md border bg-popover px-3 py-1.5 shadow-md"), pointerEvents: "none" }}
				>
					<text style={{ ...tx("text-sm text-popover-foreground"), whiteSpace: "nowrap" }}>{s().label}</text>
				</anchored>
			);
		}}</Show>
	);
}

// ---------------------------------------------------------------------------------------------------- toasts

export interface ToastOptions { kind?: "info" | "success" | "error"; description?: string; action?: { label: string; run: () => void }; durationMs?: number; id?: string }

/** Toast messages (solid-sonner in the web UI): bottom-right stack, dismissed after 4 s (6 s for errors), a click dismisses. `id` (addition) replaces a toast with the same id. */
export function toast(message: string, o?: ToastOptions): void {
	const kind = o?.kind ?? "info";
	const item: ToastItem = {
		id: o?.id ?? `t${newId()}`,
		message,
		kind,
		description: o?.description,
		action: o?.action,
		durationMs: o?.durationMs ?? (kind === "error" ? 6000 : o?.action ? 8000 : 4000),
	};
	addToast(item);
}
/** Shorthands (additions): toast.error("Could not save", { description }). */
toast.error = (message: string, o?: Omit<ToastOptions, "kind">) => toast(message, { ...o, kind: "error" });
toast.success = (message: string, o?: Omit<ToastOptions, "kind">) => toast(message, { ...o, kind: "success" });
toast.info = (message: string, o?: Omit<ToastOptions, "kind">) => toast(message, { ...o, kind: "info" });
/** Remove one toast (by id) or all of them. */
toast.dismiss = (id?: string) => dismissToast(id);

const TOAST_W = 356;

function ToastView(p: { item: ToastItem }) {
	const it = p.item;
	const iconName = it.kind === "success" ? "circle-check" : it.kind === "error" ? "circle-x" : null;
	const iconColor = () => (it.kind === "success" ? tok("success-foreground") : tok("destructive"));
	return (
		<div
			onClick={() => dismissToast(it.id)}
			onMouseEnter={() => pauseToast(it.id)}
			onMouseLeave={() => armToast(it.id, 2000)}
			style={{ ...t("flex flex-none items-start rounded-lg border border-border bg-background p-4 shadow-lg"), width: TOAST_W, cursor: "default" }}
		>
			{iconName ? <Icon name={iconName} size={16} color={iconColor()} style={{ marginRight: 12, marginTop: 2 }} /> : undefined}
			<div style={{ display: "flex", flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 2 }}>
				<text style={tx("text-[13px] font-medium text-foreground")}>{it.message}</text>
				{it.description ? <text style={tx("text-[13px] text-muted-foreground")}>{it.description}</text> : undefined}
			</div>
			{it.action ? (
				<div
					onClick={() => { const a = it.action!; dismissToast(it.id); a.run(); }}
					style={{ ...t("flex h-6 flex-none items-center rounded-md bg-primary px-2"), marginLeft: 12, cursor: "pointer" }}
				>
					<text style={{ ...tx("text-xs font-medium text-primary-foreground"), whiteSpace: "nowrap" }}>{it.action.label}</text>
				</div>
			) : undefined}
		</div>
	);
}

// the toast stack and the tooltip, for floatingRects()
let toastEl: HostElement | undefined;
let tipEl: HostElement | undefined;
/** Window rects (logical px) of the toasts and the tooltip now on screen: a WebView2 popup cuts holes for them (webview/host.ts). */
export function floatingRects(): Rect[] {
	const out: Rect[] = [];
	for (const el of [toastEl, tipEl]) { const r = boundsOf(el); if (r && r.width > 0 && r.height > 0) out.push(r); }
	return out;
}

function ToastStack() {
	return (
		<Show when={toastList().length > 0}>
			<anchored
				ref={(el: HostElement) => { toastEl = el; }}
				position={{ x: windowSize().width - 16, y: windowSize().height - 16 }}
				anchor="bottomRight"
				fit="snap"
				priority={4000}
				style={{ backgroundColor: "rgba(0, 0, 0, 0)", display: "flex", flexDirection: "column", gap: 8 }}
			>
				<For each={toastList()}>{(item) => <ToastView item={item} />}</For>
			</anchored>
		</Show>
	);
}
