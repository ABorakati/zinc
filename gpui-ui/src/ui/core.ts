// Shared plumbing for the UI building blocks: theme helpers, the overlay layer stack, toasts, tooltip state.
// Nothing here renders; overlay.tsx (OverlayHost) draws what these signals describe.
import { createSignal, type Accessor, type JSX } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import type { Mode, Style } from "../contracts";
import { store } from "../store";
import { textStyle, tokens, tw } from "../theme";

// ---- theme helpers (mode is read lazily so styles stay reactive) ----
export const mode = (): Mode => store.mode();
/** Tailwind classes -> style (see theme.ts). */
export const t = (cls: string): Style => tw(cls, mode());
/** Tailwind classes -> <text> style (always has a colour). */
export const tx = (cls: string): Style => textStyle(cls, mode());
/** Token colour of the current mode (styles.css custom property name, no leading --). */
export const tok = (name: string): string => tokens[mode()][name] ?? "#888888";

// ---- public types (re-exported by index.tsx) ----
export interface MenuItem {
	label?: string;
	icon?: string; // lucide name
	iconColor?: string; // tint of the icon (a swatch); default muted
	shortcut?: string;
	disabled?: boolean;
	danger?: boolean;
	checked?: boolean; // shows a check mark (radio/checkbox items)
	separator?: true; // a divider line (other fields ignored)
	heading?: string; // a small non-clickable group label
	submenu?: MenuItem[] | (() => MenuItem[]);
	onSelect?: () => void;
}
export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}
/** Screen position in window (logical px), e.g. from a pointer event, or the rect of an element to align to. */
export type Anchor = { x: number; y: number } | { rect: Rect; align?: "start" | "end" };

// ---- native renderer handle (set by OverlayHost; gives window size, focus and element bounds) ----
export interface NativeLike {
	getWindowSize?: () => { width: number; height: number };
	getElementBounds?: (id: number) => Rect | null;
	getFocusedElementId?: () => number | null;
	focusElement?: (id: number) => void;
}
let nativeRef: NativeLike | undefined;
export const setNative = (n: NativeLike | undefined) => {
	nativeRef = n;
};
export const native = (): NativeLike | undefined => nativeRef;
export const FALLBACK_WINDOW = { width: 1440, height: 881 };
const [winSig, setWinSig] = createSignal(FALLBACK_WINDOW);
/** OverlayHost feeds window resizes in here so anything reading windowSize() in a reactive scope updates. */
export const setWindowSignal = (width: number, height: number) => {
	const c = winSig();
	if (c.width !== width || c.height !== height) setWinSig({ width, height });
};
export function windowSize(): { width: number; height: number } {
	winSig(); // subscribe
	try {
		const s = nativeRef?.getWindowSize?.();
		if (s && s.width > 0 && s.height > 0) return s;
	} catch {
		/* renderer gone */
	}
	return FALLBACK_WINDOW;
}
/** Painted box of a host element (from a `ref`), null before the first paint. */
export function boundsOf(el: HostElement | undefined | null): Rect | null {
	if (!el || !el.mounted) return null;
	try {
		return nativeRef?.getElementBounds?.(el.id) ?? null;
	} catch {
		return null;
	}
}
export function focusedId(): number | null {
	try {
		return nativeRef?.getFocusedElementId?.() ?? null;
	} catch {
		return null;
	}
}
/**
 * A field that takes the keys as it appears (autoFocus) says so here, so that a menu item that opened it does not then give the focus
 * back to what had it before the menu: in the app's window that request can reach the UI thread after the field's own, and the typing
 * would go to the old element (Rename, New subcollection).
 */
let focusClaims = 0;
export const claimFocus = (): void => {
	focusClaims++;
};
export const focusClaimCount = (): number => focusClaims;

export function restoreFocus(id: number | null) {
	if (id === null) return;
	try {
		nativeRef?.focusElement?.(id);
	} catch {
		/* element is gone */
	}
}

// ---- overlay layers (menus, dialogs, popovers), bottom to top ----
export interface MenuLayer {
	kind: "menu";
	id: number;
	at: Anchor;
	items: () => MenuItem[];
	minWidth?: number;
	prevFocus: number | null;
}
export interface DialogLayer {
	kind: "dialog";
	id: number;
	render: (close: (v?: unknown) => void) => JSX.Element;
	title?: string;
	width: number;
	dismissable: boolean;
	alert: boolean;
	close: (v?: unknown) => void;
	prevFocus: number | null;
	/** keys other than Escape that reach the dialog (the confirm dialog uses Enter) */
	onKey?: (e: import("@gpuix/native").EventPayload) => void;
}
export interface PopoverLayer {
	kind: "popover";
	id: number;
	open: () => boolean;
	onClose: () => void;
	anchor: () => Anchor;
	width: () => number;
	children: () => JSX.Element;
}
export type Layer = MenuLayer | DialogLayer | PopoverLayer;

const [layers, setLayers] = createSignal<Layer[]>([]);
export const overlayLayers: Accessor<Layer[]> = layers;
let nextId = 1;
export const newId = () => nextId++;
export const pushLayer = (l: Layer) => setLayers((ls) => [...ls, l]);
export const removeLayer = (id: number) => setLayers((ls) => (ls.some((l) => l.id === id) ? ls.filter((l) => l.id !== id) : ls));
/** Close every open menu (a menu opened while another is open replaces it). */
export const closeMenus = () => setLayers((ls) => ls.filter((l) => l.kind !== "menu"));

// ---- toasts ----
export interface ToastItem {
	id: string;
	message: string;
	kind: "info" | "success" | "error";
	description?: string;
	action?: { label: string; run: () => void };
	/** A row of buttons under the text (the last one is the primary button): for a toast that offers several choices. */
	actions?: { label: string; run: () => void }[];
	durationMs: number;
}
const [toasts, setToasts] = createSignal<ToastItem[]>([]);
export const toastList: Accessor<ToastItem[]> = toasts;
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function pauseToast(id: string) {
	const h = toastTimers.get(id);
	if (h !== undefined) {
		clearTimeout(h);
		toastTimers.delete(id);
	}
}
export function armToast(id: string, ms?: number) {
	pauseToast(id);
	const item = toasts().find((x) => x.id === id);
	const d = ms ?? item?.durationMs ?? 4000;
	if (d > 0 && Number.isFinite(d))
		toastTimers.set(
			id,
			setTimeout(() => dismissToast(id), d),
		);
}
export function dismissToast(id?: string) {
	if (id === undefined) {
		for (const k of [...toastTimers.keys()]) pauseToast(k);
		setToasts([]);
		return;
	}
	pauseToast(id);
	setToasts((l) => l.filter((x) => x.id !== id));
}
export function addToast(item: ToastItem) {
	setToasts((l) => [...l.filter((x) => x.id !== item.id), item].slice(-4));
	armToast(item.id);
}

// ---- tooltip (one at a time) ----
export interface TooltipState {
	label: string;
	rect: Rect | null;
	pointer: { x: number; y: number };
}
const [tooltip, setTooltip] = createSignal<TooltipState | null>(null);
export const tooltipState: Accessor<TooltipState | null> = tooltip;
export const showTooltip = (s: TooltipState) => setTooltip(s);
export const hideTooltip = () => setTooltip(null);

// ---- placing a popup next to an anchor ----
export type PopAnchor = "topLeft" | "topRight" | "bottomLeft" | "bottomRight" | "topCenter";
export interface Pos {
	x: number;
	y: number;
	anchor: PopAnchor;
}
const GUTTER = 4;
/**
 * Window position + which corner of the popup sits on it. A point opens right/down of the pointer; a rect opens under the
 * element (above it when it would not fit below: `estHeight` is a guess of the popup height). GPUIX snaps the popup back
 * inside the window (8 px margin) either way.
 */
export function placeAt(at: Anchor, estHeight: number): Pos {
	const win = windowSize();
	if ("rect" in at) {
		const r = at.rect;
		const end = at.align === "end";
		const x = end ? r.x + r.width : r.x;
		const below = r.y + r.height + GUTTER;
		if (below + estHeight > win.height - 8 && r.y - GUTTER - estHeight > 8)
			return { x, y: r.y - GUTTER, anchor: end ? "bottomRight" : "bottomLeft" };
		return { x, y: below, anchor: end ? "topRight" : "topLeft" };
	}
	return { x: at.x, y: at.y, anchor: "topLeft" };
}
