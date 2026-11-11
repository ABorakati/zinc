// The Linux side of the web view (win32.ts is the Windows side; ./native.ts picks one): the same calls, on X11, through bun:ffi.
//
// webview-bun's Linux library is GTK 4 + WebKitGTK 6. GTK 4 cannot place, stack or clip a top-level window, so this file does that
// with plain Xlib on the window's X id (gdk_x11_surface_get_xid): XMoveResizeWindow places it, a transient-for hint keeps it over the
// GPUI window, and the Shape extension cuts it to the visible part. That only works when both GTK and GPUI talk X11 (on Wayland a
// client cannot position its windows at all), so shell/linuxDisplay.ts makes the whole app use X11 (XWayland on a Wayland desktop).
//
// GTK runs on this (the JS) thread, so pump() iterates GLib's default main context, as win32.pump dispatches Windows messages.
// Every library is loaded lazily: on other systems, and in the headless renderer (no window), nothing here is loaded.
import { dlopen, FFIType, JSCallback, read } from "bun:ffi";
import { hostRenderer } from "../shell/native";

type H = number | bigint;
const { ptr: P, i32: I32, u32: U32, u64: U64, i64: I64, cstring: CSTR } = FFIType;

interface X11 {
	XOpenDisplay(name: null): bigint | number | null;
	XDefaultRootWindow(d: unknown): bigint;
	XInternAtom(d: unknown, name: Buffer, onlyIfExists: number): bigint;
	XQueryTree(d: unknown, w: bigint, root: unknown, parent: unknown, children: unknown, n: unknown): number;
	XGetWindowProperty(d: unknown, w: bigint, prop: bigint, off: number, len: number, del: number, type: bigint, actualType: unknown, fmt: unknown, n: unknown, after: unknown, data: unknown): number;
	XFree(p: unknown): number;
	XGetWindowAttributes(d: unknown, w: bigint, attrs: unknown): number;
	XTranslateCoordinates(d: unknown, src: bigint, dst: bigint, x: number, y: number, dx: unknown, dy: unknown, child: unknown): number;
	XMoveResizeWindow(d: unknown, w: bigint, x: number, y: number, width: number, height: number): number;
	XSetTransientForHint(d: unknown, w: bigint, owner: bigint): number;
	XChangeProperty(d: unknown, w: bigint, prop: bigint, type: bigint, fmt: number, mode: number, data: unknown, n: number): number;
	XGetInputFocus(d: unknown, focus: unknown, revert: unknown): number;
	XSetInputFocus(d: unknown, w: bigint, revert: number, time: number): number;
	XRaiseWindow(d: unknown, w: bigint): number;
	XFlush(d: unknown): number;
	XSetErrorHandler(cb: unknown): unknown;
}
interface Xext {
	XShapeCombineRectangles(d: unknown, w: bigint, kind: number, x: number, y: number, rects: unknown, n: number, op: number, ordering: number): void;
	XShapeCombineMask(d: unknown, w: bigint, kind: number, x: number, y: number, mask: bigint, op: number): void;
}
interface Gtk {
	gtk_native_get_surface(w: H): H;
	gdk_x11_surface_get_xid(s: H): bigint;
	gtk_widget_set_visible(w: H, v: number): void;
	gtk_widget_get_visible(w: H): number;
	gtk_window_set_decorated(w: H, v: number): void;
	gtk_window_is_active(w: H): number;
	gtk_window_present(w: H): void;
	gdk_x11_surface_set_user_time(s: H, t: number): void;
}
interface Glib {
	g_main_context_iteration(ctx: null, mayBlock: number): number;
}

let x: { lib: X11; dpy: unknown; root: bigint } | null | undefined;
let xext: Xext | null | undefined;
let gtk: Gtk | null | undefined;
let glib: Glib | null | undefined;
let onXError: JSCallback | undefined;

/** Our own Xlib connection (window ids are global, so it can query and move the GTK and GPUI windows); null off X11. */
function xlib() {
	if (x !== undefined) return x;
	if (process.platform !== "linux" || !process.env.DISPLAY) return (x = null);
	try {
		const lib = dlopen("libX11.so.6", {
			XOpenDisplay: { args: [P], returns: P },
			XDefaultRootWindow: { args: [P], returns: U64 },
			XInternAtom: { args: [P, P, I32], returns: U64 },
			XQueryTree: { args: [P, U64, P, P, P, P], returns: I32 },
			XGetWindowProperty: { args: [P, U64, U64, I64, I64, I32, U64, P, P, P, P, P], returns: I32 },
			XFree: { args: [P], returns: I32 },
			XGetWindowAttributes: { args: [P, U64, P], returns: I32 },
			XTranslateCoordinates: { args: [P, U64, U64, I32, I32, P, P, P], returns: I32 },
			XMoveResizeWindow: { args: [P, U64, I32, I32, U32, U32], returns: I32 },
			XSetTransientForHint: { args: [P, U64, U64], returns: I32 },
			XChangeProperty: { args: [P, U64, U64, U64, I32, I32, P, I32], returns: I32 },
			XGetInputFocus: { args: [P, P, P], returns: I32 },
			XSetInputFocus: { args: [P, U64, I32, U64], returns: I32 },
			XRaiseWindow: { args: [P, U64], returns: I32 },
			XFlush: { args: [P], returns: I32 },
			XSetErrorHandler: { args: [FFIType.function], returns: P },
		}).symbols as unknown as X11;
		const dpy = lib.XOpenDisplay(null);
		if (!dpy) return (x = null);
		x = { lib, dpy, root: lib.XDefaultRootWindow(dpy) };
		ignoreXErrors();
	} catch {
		x = null;
	}
	return x;
}

/**
 * A window can vanish between two calls (a popup destroyed, the app closing), and Xlib's default error handler then EXITS the
 * process. Errors are only ever about such stale windows here, so they are ignored. The handler is process-wide: GTK installs its own
 * when it starts, so this is set again after each web view is created (ensureErrorHandler).
 */
function ignoreXErrors(): void {
	if (!x) return;
	onXError ??= new JSCallback(() => 0, { args: [P, P], returns: I32 });
	x.lib.XSetErrorHandler(onXError.ptr);
}

function shape(): Xext | null {
	if (xext !== undefined) return xext;
	try {
		xext = dlopen("libXext.so.6", {
			XShapeCombineRectangles: { args: [P, U64, I32, I32, I32, P, I32, I32, I32], returns: FFIType.void },
			XShapeCombineMask: { args: [P, U64, I32, I32, I32, U64, I32], returns: FFIType.void },
		}).symbols as unknown as Xext;
	} catch {
		xext = null;
	}
	return xext;
}

function gtk4(): Gtk | null {
	if (gtk !== undefined) return gtk;
	try {
		gtk = dlopen("libgtk-4.so.1", {
			gtk_native_get_surface: { args: [P], returns: P },
			gdk_x11_surface_get_xid: { args: [P], returns: U64 },
			gtk_widget_set_visible: { args: [P, I32], returns: FFIType.void },
			gtk_widget_get_visible: { args: [P], returns: I32 },
			gtk_window_set_decorated: { args: [P, I32], returns: FFIType.void },
			gtk_window_is_active: { args: [P], returns: I32 },
			gtk_window_present: { args: [P], returns: FFIType.void },
			gdk_x11_surface_set_user_time: { args: [P, U32], returns: FFIType.void },
		}).symbols as unknown as Gtk;
	} catch {
		gtk = null;
	}
	return gtk;
}

function gl(): Glib | null {
	if (glib !== undefined) return glib;
	try {
		glib = dlopen("libglib-2.0.so.0", { g_main_context_iteration: { args: [P, I32], returns: I32 } }).symbols as unknown as Glib;
	} catch {
		glib = null;
	}
	return glib;
}

const atoms = new Map<string, bigint>();
function atom(name: string): bigint {
	const s = xlib();
	if (!s) return 0n;
	let a = atoms.get(name);
	if (a === undefined) atoms.set(name, (a = s.lib.XInternAtom(s.dpy, Buffer.from(`${name}\0`), 0)));
	return a;
}

/** True when the X11 calls are available (Linux with an X display: X11, or XWayland). */
export const x11Available = (): boolean => xlib() != null && gtk4() != null;

// ---- the GPUI window ----

const u64a = new BigUint64Array(1), u64b = new BigUint64Array(1), u64c = new BigUint64Array(1), u64d = new BigUint64Array(1);
const i32a = new Int32Array(1), i32b = new Int32Array(1);

function children(w: bigint): bigint[] {
	const s = xlib()!;
	if (!s.lib.XQueryTree(s.dpy, w, u64a, u64b, u64c, i32a)) return [];
	const n = i32a[0]!, p = u64c[0]!;
	if (!n || !p) return [];
	const out: bigint[] = [];
	for (let i = 0; i < n; i++) out.push(read.u64(Number(p) as never, i * 8));
	s.lib.XFree(Number(p));
	return out;
}

/** A window's 32-bit-format property as numbers (Xlib hands format-32 data back as C longs), or [] when it has none. */
function prop32(w: bigint, name: string, type: bigint): bigint[] {
	const s = xlib()!;
	const ok = s.lib.XGetWindowProperty(s.dpy, w, atom(name), 0, 64, 0, type, u64a, i32a, u64b, u64c, u64d);
	const data = u64d[0]!;
	if (ok !== 0 || !data) return [];
	const out: bigint[] = [];
	if (i32a[0] === 32) for (let i = 0; i < Number(u64b[0]!); i++) out.push(read.u64(Number(data) as never, i * 8));
	s.lib.XFree(Number(data));
	return out;
}

const attrs = new Uint8Array(256);
const attrView = new DataView(attrs.buffer);
/** XWindowAttributes (x86_64 / arm64 layout): width at 8, height at 12, map_state at 92 (2 = IsViewable). */
function attributes(w: bigint): { width: number; height: number; viewable: boolean } | null {
	const s = xlib();
	if (!s || !s.lib.XGetWindowAttributes(s.dpy, w, attrs)) return null;
	return { width: attrView.getInt32(8, true), height: attrView.getInt32(12, true), viewable: attrView.getInt32(92, true) === 2 };
}

const XA_CARDINAL = 6n, XA_ATOM = 4n;
let main: bigint | null = null;
/** Our popups' X ids, so they are never taken for the main window (they carry this process's _NET_WM_PID too). */
const popupXids = new Set<bigint>();

/** The GPUI window of this process: the viewable window carrying our _NET_WM_PID (searched a few levels down: WMs reparent). */
export function mainWindow(): H | null {
	const s = xlib();
	if (!s) return null;
	if (main != null && attributes(main)) return main;
	main = null;
	const pid = BigInt(process.pid);
	const visit = (w: bigint, depth: number): bigint | null => {
		for (const c of children(w)) {
			if (!popupXids.has(c) && prop32(c, "_NET_WM_PID", XA_CARDINAL)[0] === pid && attributes(c)?.viewable) return c;
			if (depth > 0) { const f = visit(c, depth - 1); if (f) return f; }
		}
		return null;
	};
	main = visit(s.root, 2);
	return main;
}

/** Scale between GPUIX's logical pixels and X pixels: the X window's width over the width GPUIX reports (1 when unknown). */
export function dpr(): number {
	const w = mainWindow();
	const a = w != null ? attributes(BigInt(w)) : null;
	const logical = hostRenderer()?.getWindowSize?.()?.width;
	if (!a || !logical) return 1;
	const k = a.width / logical;
	return k > 0.5 && k < 8 ? Math.round(k * 4) / 4 : 1;
}

/** The main window's client area in root (screen) pixels, or null while it is minimised / gone. */
export function clientOnScreen(): { x: number; y: number; width: number; height: number } | null {
	const s = xlib(), w = mainWindow();
	if (!s || w == null) return null;
	const a = attributes(BigInt(w));
	if (!a || !a.viewable) return null;
	if (!s.lib.XTranslateCoordinates(s.dpy, BigInt(w), s.root, 0, 0, i32a, i32b, u64a)) return null;
	return { x: i32a[0]!, y: i32b[0]!, width: a.width, height: a.height };
}

// ---- the popups (handles are GtkWindow pointers, as webview-bun's unsafeWindowHandle gives them) ----

const popups = new Map<bigint, bigint>(); // GtkWindow* -> X id
const key = (h: H) => BigInt(h);

function xidOf(h: H): bigint | null {
	const k = key(h);
	const known = popups.get(k);
	if (known) return known;
	const g = gtk4();
	if (!g) return null;
	const surface = g.gtk_native_get_surface(h);
	if (!surface) return null;
	const xid = g.gdk_x11_surface_get_xid(surface);
	return xid ? xid : null;
}

export const isWindow = (h: H): boolean => { const id = popups.get(key(h)) ?? xidOf(h); return id != null && attributes(id) != null; };

/**
 * Turn a freshly created webview window into a frameless popup over the main window; it starts hidden. Like win32.makeOwnedPopup it
 * is not "owned" in GTK's sense (GTK 4 cannot make a foreign X window a parent): an X transient-for hint asks the window manager to keep
 * it above the GPUI window and out of the taskbar, and _NET_WM_STATE_SKIP_TASKBAR / _SKIP_PAGER say so explicitly.
 */
export function makeOwnedPopup(h: H, owner: H | null): void {
	const s = xlib(), g = gtk4();
	if (!s || !g) return;
	g.gtk_widget_set_visible(h, 0);
	g.gtk_window_set_decorated(h, 0);
	const xid = xidOf(h);
	if (!xid) return;
	popups.set(key(h), xid);
	popupXids.add(xid);
	if (owner != null) s.lib.XSetTransientForHint(s.dpy, xid, BigInt(owner));
	const state = new BigUint64Array([atom("_NET_WM_STATE_SKIP_TASKBAR"), atom("_NET_WM_STATE_SKIP_PAGER")]);
	s.lib.XChangeProperty(s.dpy, xid, atom("_NET_WM_STATE"), XA_ATOM, 32, 0, state, 2);
	s.lib.XFlush(s.dpy);
	ignoreXErrors(); // GTK replaced the handler when it started
}

export function forgetPopup(h: H): void {
	const xid = popups.get(key(h));
	if (xid) popupXids.delete(xid);
	popups.delete(key(h));
	wants.delete(key(h));
}

/** Where each popup was last asked to be, how often the request was repeated, and the focus guard after it was shown. */
interface Want { x: number; y: number; width: number; height: number; tries: number; guardUntil: number; prevFocus: bigint; asked: boolean }
const wants = new Map<bigint, Want>();

/** 0 as _NET_WM_USER_TIME tells the window manager not to give the window the focus when it is mapped (EWMH). */
function noFocusOnMap(h: H): void {
	const g = gtk4();
	const surface = g?.gtk_native_get_surface(h);
	if (g && surface) g.gdk_x11_surface_set_user_time(surface, 0);
}

/**
 * Called every tick while the placement is unchanged. The transient-for hint does the stacking; this repeats a move the window manager
 * overrode (a move sent while the window was being mapped loses to the manager's own placement of the new window) and gives the focus
 * back to the window that had it if mapping handed it to the popup without the user asking (focusPopup).
 */
export function keepAbove(h: H): void {
	const s = xlib(), xid = popups.get(key(h)), w = wants.get(key(h));
	if (!s || !xid || !w) return;
	if (w.tries < 40 && s.lib.XTranslateCoordinates(s.dpy, xid, s.root, 0, 0, i32a, i32b, u64a) && (i32a[0] !== w.x || i32b[0] !== w.y)) {
		w.tries++;
		s.lib.XMoveResizeWindow(s.dpy, xid, w.x, w.y, Math.max(1, w.width), Math.max(1, w.height));
		s.lib.XFlush(s.dpy);
	}
	if (w.guardUntil && performance.now() < w.guardUntil && !w.asked && focused() === xid && w.prevFocus > 1n) {
		s.lib.XSetInputFocus(s.dpy, w.prevFocus, 2, 0);
		s.lib.XFlush(s.dpy);
		w.guardUntil = 0;
	}
}

/** Place the popup at a root-window rectangle (X pixels) and show it, without taking the focus. */
export function placePopup(h: H, r: { x: number; y: number; width: number; height: number }): void {
	const s = xlib(), g = gtk4(), xid = popups.get(key(h));
	if (!s || !g || !xid) return;
	const w: Want = { ...r, tries: 0, guardUntil: wants.get(key(h))?.guardUntil ?? 0, prevFocus: wants.get(key(h))?.prevFocus ?? 0n, asked: false };
	if (!g.gtk_widget_get_visible(h)) {
		w.prevFocus = focused();
		w.guardUntil = performance.now() + 1500;
		noFocusOnMap(h);
		g.gtk_widget_set_visible(h, 1);
	}
	wants.set(key(h), w);
	s.lib.XMoveResizeWindow(s.dpy, xid, r.x, r.y, Math.max(1, r.width), Math.max(1, r.height));
	s.lib.XFlush(s.dpy);
}

export function hidePopup(h: H): void {
	gtk4()?.gtk_widget_set_visible(h, 0);
	wants.delete(key(h));
}

type PxRect = { x: number; y: number; width: number; height: number };
const ShapeBounding = 0, ShapeInput = 2, ShapeSet = 0, ShapeSubtract = 3;
/** Clip the popup to `keep` minus `holes` (popup pixels), or show all of it; clicks outside the shape reach the window below. */
export function clipPopup(h: H, keep: PxRect | null, holes: PxRect[] = []): void {
	const s = xlib(), e = shape(), xid = popups.get(key(h));
	if (!s || !e || !xid) return;
	const rect = (r: PxRect) => {
		const b = new Int16Array(4);
		b[0] = Math.max(-32768, Math.min(32767, r.x)); b[1] = Math.max(-32768, Math.min(32767, r.y));
		b[2] = Math.max(0, Math.min(32767, r.width)); b[3] = Math.max(0, Math.min(32767, r.height)); // XRectangle: short x, y; unsigned short w, h
		return b;
	};
	for (const kind of [ShapeBounding, ShapeInput]) {
		if (!keep && !holes.length) { e.XShapeCombineMask(s.dpy, xid, kind, 0, 0, 0n, ShapeSet); continue; }
		e.XShapeCombineRectangles(s.dpy, xid, kind, 0, 0, rect(keep ?? { x: 0, y: 0, width: 32767, height: 32767 }), 1, ShapeSet, 0);
		for (const hole of holes) e.XShapeCombineRectangles(s.dpy, xid, kind, 0, 0, rect(hole), 1, ShapeSubtract, 0);
	}
	s.lib.XFlush(s.dpy);
}

function focused(): bigint {
	const s = xlib();
	if (!s) return 0n;
	s.lib.XGetInputFocus(s.dpy, u64a, i32a);
	return u64a[0]!;
}

/** Give the popup keyboard focus (an explicit "edit this" from the user); only while this app is in front. */
export function focusPopup(h: H): void {
	const s = xlib(), xid = popups.get(key(h));
	if (!s || !xid || !appIsForeground()) return;
	const w = wants.get(key(h));
	if (w) w.asked = true;
	gtk4()?.gtk_window_present(h);
	s.lib.XSetInputFocus(s.dpy, xid, 2 /* RevertToParent */, 0);
	s.lib.XFlush(s.dpy);
}

/** True when the popup has keyboard focus. */
export function popupHasFocus(h: H): boolean {
	const xid = popups.get(key(h));
	if (!xid) return false;
	return focused() === xid || !!gtk4()?.gtk_window_is_active(h);
}

/** Give keyboard focus back to the main window. */
export function focusMain(): void {
	const s = xlib(), w = mainWindow();
	if (!s || w == null) return;
	s.lib.XSetInputFocus(s.dpy, BigInt(w), 2, 0);
	s.lib.XFlush(s.dpy);
}

/** True when the main window or one of our popups has the keyboard focus. */
export function appIsForeground(): boolean {
	const f = focused();
	if (f <= 1n) return false; // None / PointerRoot
	return f === (mainWindow() != null ? BigInt(mainWindow()!) : -1n) || popupXids.has(f);
}

/**
 * Run GTK's pending work on this thread (the popups live here; GPUI runs its own loop). One iteration can draw a whole frame of the
 * page, so the round stops after ~8 ms and the rest waits for the next tick: the JS thread (and with it the app) stays responsive.
 */
export function pump(): void {
	const g = gl();
	if (!g) return;
	const t0 = performance.now();
	let n = 0;
	while (n++ < 200 && g.g_main_context_iteration(null, 0)) if (performance.now() - t0 > 8) break;
}

// ---- ordinary top-level windows (the sign-in helper; Windows only for now, see signin/helper.ts) ----

export function showTopLevel(h: H): void { const g = gtk4(); if (g) { g.gtk_widget_set_visible(h, 1); g.gtk_window_present(h); } }
export function hideTopLevel(h: H): void { gtk4()?.gtk_widget_set_visible(h, 0); }
export const isShown = (h: H): boolean => !!gtk4()?.gtk_widget_get_visible(h);
export function allowForeground(_pid: number): void {}
