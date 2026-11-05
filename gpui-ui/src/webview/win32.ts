// The few user32 calls the web view needs (bun:ffi): find this process's main window, and make a webview window an OWNED POPUP that
// follows it. Windows only; everything is lazy so other platforms (and the headless renderer, which has no window) never load them.
//
// Why an owned popup and not a child window: GPUI draws the window through a DirectComposition swapchain whose visual is composed
// above every child HWND (measured: a WS_CHILD WebView2 window is positioned, visible and loaded - the page reports its size - but is
// never seen). An owned top-level popup with no frame is composed by DWM like any window, stays above its owner, minimises/hides
// with it, and is absent from the taskbar and Alt-Tab (WS_EX_TOOLWINDOW).
import { dlopen, FFIType, JSCallback } from "bun:ffi";

type H = number | bigint;
interface User32 {
	EnumWindows(cb: unknown, lparam: number): number;
	GetWindowThreadProcessId(hwnd: H, pid: unknown): number;
	IsWindowVisible(hwnd: H): number;
	IsWindow(hwnd: H): number;
	IsIconic(hwnd: H): number;
	GetWindow(hwnd: H, cmd: number): H;
	GetDpiForWindow(hwnd: H): number;
	ClientToScreen(hwnd: H, pt: unknown): number;
	GetClientRect(hwnd: H, rect: unknown): number;
	SetWindowLongPtrW(hwnd: H, index: number, value: bigint): bigint;
	SetWindowPos(hwnd: H, after: H | null, x: number, y: number, w: number, h: number, flags: number): number;
	ShowWindow(hwnd: H, cmd: number): number;
	PeekMessageW(msg: unknown, hwnd: null, min: number, max: number, remove: number): number;
	TranslateMessage(msg: unknown): number;
	DispatchMessageW(msg: unknown): bigint;
	GetForegroundWindow(): H;
	SetForegroundWindow(hwnd: H): number;
	SetWindowRgn(hwnd: H, rgn: H | null, redraw: number): number;
	GetWindowTextW(hwnd: H, buf: unknown, max: number): number;
}
interface Gdi32 {
	CreateRectRgn(l: number, t: number, r: number, b: number): H;
	CombineRgn(dst: H, a: H, b: H, mode: number): number;
	DeleteObject(h: H): number;
}

let u32: User32 | null | undefined;
let g32: Gdi32 | null | undefined;
let enumCb: JSCallback | undefined;
const pidBuf = new Uint32Array(1);
const titleBuf = new Uint16Array(64);
let found: H[] = [];

function user32(): User32 | null {
	if (u32 !== undefined) return u32;
	if (process.platform !== "win32") return (u32 = null);
	try {
		const p = FFIType.ptr, i = FFIType.i32, u = FFIType.u32;
		u32 = dlopen("user32.dll", {
			EnumWindows: { args: [FFIType.function, p], returns: i },
			GetWindowThreadProcessId: { args: [p, p], returns: u },
			IsWindowVisible: { args: [p], returns: i },
			IsWindow: { args: [p], returns: i },
			IsIconic: { args: [p], returns: i },
			GetWindow: { args: [p, u], returns: p },
			GetDpiForWindow: { args: [p], returns: u },
			ClientToScreen: { args: [p, p], returns: i },
			GetClientRect: { args: [p, p], returns: i },
			SetWindowLongPtrW: { args: [p, i, FFIType.i64], returns: FFIType.i64 },
			SetWindowPos: { args: [p, p, i, i, i, i, u], returns: i },
			ShowWindow: { args: [p, i], returns: i },
			PeekMessageW: { args: [p, p, u, u, u], returns: i },
			TranslateMessage: { args: [p], returns: i },
			DispatchMessageW: { args: [p], returns: FFIType.i64 },
			GetForegroundWindow: { args: [], returns: p },
			SetForegroundWindow: { args: [p], returns: i },
			SetWindowRgn: { args: [p, p, i], returns: i },
			GetWindowTextW: { args: [p, p, i], returns: i },
		}).symbols as unknown as User32;
		enumCb = new JSCallback(
			(h: H) => {
				const s = u32!;
				s.GetWindowThreadProcessId(h, pidBuf);
				// this process's visible top-level windows that have no owner (our own popup is owned, so it is skipped), except the
				// headless test renderer's window, which is never really on screen (a popup placed over it would be)
				if (pidBuf[0] === process.pid && s.IsWindowVisible(h) && !s.GetWindow(h, 4)) {
					const n = s.GetWindowTextW(h, titleBuf, titleBuf.length);
					if (String.fromCharCode(...titleBuf.subarray(0, Math.max(0, n))) !== "GPUIX Test") found.push(h);
				}
				return 1;
			},
			{ args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		);
	} catch {
		u32 = null;
	}
	return u32;
}

/** True when the win32 calls are available (Windows, user32 loaded). */
export const win32Available = (): boolean => user32() != null;

let main: H | null = null;
/** The GPUI window of this process (null in the headless renderer or before the window is shown). */
export function mainWindow(): H | null {
	const s = user32();
	if (!s || !enumCb) return null;
	try {
		if (main == null || !s.IsWindow(main)) {
			found = [];
			s.EnumWindows(enumCb.ptr, 0);
			main = found[0] ?? null;
		}
	} catch {
		main = null;
	}
	return main;
}

/** Scale factor of the main window (1 when there is none). */
export function dpr(): number {
	const s = user32(), w = mainWindow();
	if (!s || w == null) return 1;
	const d = s.GetDpiForWindow(w);
	return d > 0 ? d / 96 : 1;
}

const pt = new Int32Array(2);
const rc = new Int32Array(4);
/** The main window's client area in screen pixels, or null while it is minimised / gone. */
export function clientOnScreen(): { x: number; y: number; width: number; height: number } | null {
	const s = user32(), w = mainWindow();
	if (!s || w == null || s.IsIconic(w) || !s.IsWindowVisible(w)) return null;
	pt[0] = 0; pt[1] = 0;
	if (!s.ClientToScreen(w, pt)) return null;
	s.GetClientRect(w, rc);
	return { x: pt[0]!, y: pt[1]!, width: rc[2]!, height: rc[3]! };
}

export const isWindow = (h: H): boolean => { const s = user32(); return !!s && !!s.IsWindow(h); };

const GWL_STYLE = -16, GWL_EXSTYLE = -20, GWLP_HWNDPARENT = -8;
const WS_POPUP = 0x80000000n, WS_CLIPCHILDREN = 0x02000000n;
const WS_EX_TOOLWINDOW = 0x80n, WS_EX_NOACTIVATE = 0x08000000n;
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20, SWP_SHOWWINDOW = 0x40, SWP_HIDEWINDOW = 0x80;

/** Turn a freshly created (top-level, framed) webview window into a frameless popup owned by the main window; it starts hidden. */
export function makeOwnedPopup(h: H, owner: H | null): void {
	const s = user32();
	if (!s) return;
	s.ShowWindow(h, 0);
	s.SetWindowLongPtrW(h, GWL_STYLE, WS_POPUP | WS_CLIPCHILDREN);
	s.SetWindowLongPtrW(h, GWL_EXSTYLE, WS_EX_TOOLWINDOW);
	if (owner != null) s.SetWindowLongPtrW(h, GWLP_HWNDPARENT, BigInt(owner)); // GWLP_HWNDPARENT on a top-level window sets its OWNER
	s.SetWindowPos(h, null, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
}

/** Place the popup at a screen rectangle (physical px) and show it, without taking focus. */
export function placePopup(h: H, r: { x: number; y: number; width: number; height: number }): void {
	user32()?.SetWindowPos(h, null, r.x, r.y, r.width, r.height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
}

export function hidePopup(h: H): void {
	user32()?.SetWindowPos(h, null, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_HIDEWINDOW);
}

function gdi32(): Gdi32 | null {
	if (g32 !== undefined) return g32;
	if (!user32()) return (g32 = null);
	try {
		const p = FFIType.ptr, i = FFIType.i32;
		g32 = dlopen("gdi32.dll", {
			CreateRectRgn: { args: [i, i, i, i], returns: p },
			CombineRgn: { args: [p, p, p, i], returns: i },
			DeleteObject: { args: [p], returns: i },
		}).symbols as unknown as Gdi32;
	} catch {
		g32 = null;
	}
	return g32;
}

type PxRect = { x: number; y: number; width: number; height: number };
const RGN_DIFF = 4;
/**
 * Clip what the popup shows to `keep` minus `holes` (rects in the popup's own pixels, origin at its top-left), or show all of it
 * (`keep` null and no holes). The page keeps its full size, so a note scrolled half out of the item pane is cut off instead of squeezed.
 * Clicks outside the region go to the window below (the GPUI window).
 */
export function clipPopup(h: H, keep: PxRect | null, holes: PxRect[] = []): void {
	const s = user32(), g = gdi32();
	if (!s) return;
	if (!g || (!keep && !holes.length)) { s.SetWindowRgn(h, null, 1); return; }
	const k = keep ?? { x: 0, y: 0, width: 1 << 15, height: 1 << 15 };
	const rgn = g.CreateRectRgn(k.x, k.y, k.x + k.width, k.y + k.height);
	for (const r of holes) {
		const hole = g.CreateRectRgn(r.x, r.y, r.x + r.width, r.y + r.height);
		g.CombineRgn(rgn, rgn, hole, RGN_DIFF);
		g.DeleteObject(hole);
	}
	if (!s.SetWindowRgn(h, rgn, 1)) g.DeleteObject(rgn); // on success the system owns the region
}

/** Give the popup keyboard focus (an explicit "edit this" from the user); only while this app is in front, so it never steals focus. */
export function focusPopup(h: H): void {
	const s = user32();
	if (s && appIsForeground()) s.SetForegroundWindow(h);
}

/** True when the popup (or a window inside it) is the foreground window. */
export function popupHasFocus(h: H): boolean {
	const s = user32();
	if (!s) return false;
	const f = s.GetForegroundWindow();
	return !!f && BigInt(f) === BigInt(h);
}

/** Give keyboard focus back to the main window (after the popup is hidden). */
export function focusMain(): void {
	const s = user32(), w = mainWindow();
	if (s && w != null) s.SetForegroundWindow(w);
}

/** True when the main window is the foreground window or one of this process's windows is (used to avoid stealing focus). */
export function appIsForeground(): boolean {
	const s = user32();
	if (!s) return false;
	const f = s.GetForegroundWindow();
	if (!f) return false;
	s.GetWindowThreadProcessId(f, pidBuf);
	return pidBuf[0] === process.pid;
}

const msg = new Uint8Array(64);
/** Dispatch the pending window messages of this thread (the popup's window procedure runs here; GPUI pumps its own thread). */
export function pump(): void {
	const s = user32();
	if (!s) return;
	let n = 0;
	while (n++ < 200 && s.PeekMessageW(msg, null, 0, 0, 1)) {
		s.TranslateMessage(msg);
		s.DispatchMessageW(msg);
	}
}
