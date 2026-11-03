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
}

let u32: User32 | null | undefined;
let enumCb: JSCallback | undefined;
const pidBuf = new Uint32Array(1);
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
		}).symbols as unknown as User32;
		enumCb = new JSCallback(
			(h: H) => {
				const s = u32!;
				s.GetWindowThreadProcessId(h, pidBuf);
				// this process's visible top-level windows that have no owner (our own popup is owned, so it is skipped)
				if (pidBuf[0] === process.pid && s.IsWindowVisible(h) && !s.GetWindow(h, 4)) found.push(h);
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
	if (!s || w == null || s.IsIconic(w)) return null;
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
export function makeOwnedPopup(h: H, owner: H): void {
	const s = user32();
	if (!s) return;
	s.ShowWindow(h, 0);
	s.SetWindowLongPtrW(h, GWL_STYLE, WS_POPUP | WS_CLIPCHILDREN);
	s.SetWindowLongPtrW(h, GWL_EXSTYLE, WS_EX_TOOLWINDOW);
	s.SetWindowLongPtrW(h, GWLP_HWNDPARENT, BigInt(owner)); // GWLP_HWNDPARENT on a top-level window sets its OWNER
	s.SetWindowPos(h, null, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
}

/** Place the popup at a screen rectangle (physical px) and show it, without taking focus. */
export function placePopup(h: H, r: { x: number; y: number; width: number; height: number }): void {
	user32()?.SetWindowPos(h, null, r.x, r.y, r.width, r.height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
}

export function hidePopup(h: H): void {
	user32()?.SetWindowPos(h, null, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_HIDEWINDOW);
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
