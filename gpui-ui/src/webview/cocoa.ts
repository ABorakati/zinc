// The macOS side of the web view (win32.ts / x11.ts are the others; ./popup.ts picks one), through the Objective-C runtime (shell/objc.ts).
//
// On macOS GPUIX runs AppKit on the JS thread (tick() pumps it), so the page does not need a window of its own kept over the app's:
// webview-bun's WKWebView is taken out of the window the webview library made and added to GPUI's own content view, inside a container
// view that clips it. It then moves, resizes, minimises and stacks with the app by itself, and keyboard focus is the window's first
// responder. The handles the rest of the code passes around stay the webview library's NSWindow (now empty and hidden).
//
// Coordinates: host.ts places popups in window pixels; here clientOnScreen() is the content area at (0, 0) and dpr() is 1, so they arrive
// in GPUI's logical pixels = AppKit points. GPUI's view may not be flipped, in which case y counts from the bottom.
// Holes (toasts drawn over the page) are not cut on macOS: the page stays above them.
import { hostRenderer } from "../shell/native";
import { objc, runLoopOnce, type Id } from "../shell/objc";

type H = number | bigint;
interface Popup { win: Id; web: Id; box: Id; rect: Rect | null; keep: Rect | null; shown: boolean }
type Rect = { x: number; y: number; width: number; height: number };

const popups = new Map<bigint, Popup>();
const key = (h: H) => BigInt(h);
const ours = (w: Id) => w != null && [...popups.values()].some((p) => BigInt(p.win ?? 0) === BigInt(w));

/** True when the Cocoa calls are available (macOS). */
export const cocoaAvailable = (): boolean => objc() != null;

/** The GPUI window: the first visible window of the app that is not one of the webview library's. */
export function mainWindow(): H | null {
	const r = objc();
	if (!r) return null;
	const { send: s, sel } = r;
	const app = s.m0(r.cls("NSApplication"), sel("sharedApplication"));
	const list = s.m0(app, sel("windows"));
	const n = Number(s.m0(list, sel("count")) ?? 0);
	for (let i = 0; i < n; i++) {
		const w = s.mu(list, sel("objectAtIndex:"), i);
		if (w && !ours(w) && s.b0(w, sel("isVisible"))) return w as H;
	}
	return null;
}

const contentView = (): Id => { const r = objc(), w = mainWindow(); return r && w != null ? r.send.m0(w, r.sel("contentView")) : null; };

/** Window pixels are AppKit points here. */
export const dpr = (): number => 1;

/** The content area, at (0, 0) in window coordinates, or null while the window is minimised / gone. */
export function clientOnScreen(): { x: number; y: number; width: number; height: number } | null {
	const r = objc(), w = mainWindow();
	if (!r || w == null || r.send.b0(w, r.sel("isMiniaturized"))) return null;
	const size = hostRenderer()?.getWindowSize?.();
	if (!size?.width || !size.height) return null;
	return { x: 0, y: 0, width: size.width, height: size.height };
}

export const isWindow = (h: H): boolean => popups.has(key(h));

/**
 * A hidden borderless window to hand to webview_create. When the webview library makes its OWN window on macOS it also sets up an app
 * delegate and runs [NSApp run] until "did finish launching", which GPUI's app sent long ago: the call never returned (the macOS CI
 * smoke run hung there). Given a window, the library only embeds the page in it.
 */
export function newWebviewWindow(): Id {
	const r = objc();
	if (!r) return null;
	const { send: s, sel } = r;
	const win = s.mwin(s.m0(r.cls("NSWindow"), sel("alloc")), sel("initWithContentRect:styleMask:backing:defer:"), 0, 0, 800, 600, 0 /* borderless */, 2 /* buffered */, 1);
	if (win) s.mi(win, sel("setReleasedWhenClosed:"), 0);
	return win;
}

/** The WKWebView the library put into `h`: its content view, or (embedded) a view inside it. */
function webViewOf(h: H): Id {
	const r = objc()!;
	const { send: s, sel } = r;
	const wk = r.cls("WKWebView");
	const content = s.m0(h, sel("contentView"));
	if (!content || !wk) return content;
	if (s.b1(content, sel("isKindOfClass:"), wk)) return content;
	const subs = s.m0(content, sel("subviews"));
	const n = Number(s.m0(subs, sel("count")) ?? 0);
	for (let i = 0; i < n; i++) {
		const v = s.mu(subs, sel("objectAtIndex:"), i);
		if (v && s.b1(v, sel("isKindOfClass:"), wk)) return v;
	}
	return null;
}

/** Move the webview library's WKWebView into a clipping container on GPUI's content view; the library's own window is hidden. */
export function makeOwnedPopup(h: H, _owner: H | null): void {
	const r = objc(), view = contentView();
	if (!r || view == null) return;
	const { send: s, sel } = r;
	const web = webViewOf(h);
	if (!web) return;
	s.m0(web, sel("retain"));
	// the window gets an empty view, so the WKWebView is not its content any more (releasing the old content view leaves ours)
	const blank = s.mrect(s.m0(r.cls("NSView"), sel("alloc")), sel("initWithFrame:"), 0, 0, 1, 1);
	s.m1(h, sel("setContentView:"), blank);
	s.m1(h, sel("orderOut:"), null);
	const box = s.mrect(s.m0(r.cls("NSView"), sel("alloc")), sel("initWithFrame:"), 0, 0, 1, 1);
	s.mi(box, sel("setWantsLayer:"), 1);
	s.mi(s.m0(box, sel("layer")), sel("setMasksToBounds:"), 1);
	s.m1(box, sel("addSubview:"), web);
	s.mi(box, sel("setHidden:"), 1);
	s.mpip(view, sel("addSubview:positioned:relativeTo:"), box, 1 /* NSWindowAbove */, null);
	popups.set(key(h), { win: h, web, box, rect: null, keep: null, shown: false });
}

export function forgetPopup(h: H): void {
	const r = objc(), p = popups.get(key(h));
	popups.delete(key(h));
	if (!r || !p) return;
	r.send.m0(p.box, r.sel("removeFromSuperview"));
	r.send.m0(p.box, r.sel("release"));
	r.send.m0(p.web, r.sel("release"));
}

/** Lay the container (the visible part) and the page inside it (its full size, shifted) out in GPUI's view. */
function apply(p: Popup): void {
	const r = objc(), view = contentView();
	if (!r || !p.rect || view == null) return;
	const { send: s, sel } = r;
	const rect = p.rect;
	const k = p.keep ?? { x: 0, y: 0, width: rect.width, height: rect.height };
	const flipped = s.b0(view, sel("isFlipped"));
	const H = hostRenderer()?.getWindowSize?.()?.height ?? 0;
	const top = rect.y + k.y;
	s.mrect(p.box, sel("setFrame:"), rect.x + k.x, flipped ? top : H - top - k.height, k.width, k.height);
	// inside the (unflipped) container: the page's top edge is k.y above the container's top
	s.mrect(p.web, sel("setFrame:"), -k.x, k.height + k.y - rect.height, rect.width, rect.height);
}

export function placePopup(h: H, rect: { x: number; y: number; width: number; height: number }): void {
	const r = objc(), p = popups.get(key(h));
	if (!r || !p) return;
	p.rect = rect;
	apply(p);
	if (!p.shown) { r.send.mi(p.box, r.sel("setHidden:"), 0); p.shown = true; }
}

export function hidePopup(h: H): void {
	const r = objc(), p = popups.get(key(h));
	if (!r || !p) return;
	r.send.mi(p.box, r.sel("setHidden:"), 1);
	p.shown = false;
}

/** Clip the page to `keep` (page pixels); holes are not cut on macOS (see the header). */
export function clipPopup(h: H, keep: Rect | null, _holes: Rect[] = []): void {
	const p = popups.get(key(h));
	if (!p) return;
	p.keep = keep;
	apply(p);
}

/** Inside GPUI's window: nothing to keep above. */
export function keepAbove(_h: H): void {}

const responder = (): Id => { const r = objc(), w = mainWindow(); return r && w != null ? r.send.m0(w, r.sel("firstResponder")) : null; };

export function popupHasFocus(h: H): boolean {
	const r = objc(), p = popups.get(key(h)), f = responder();
	if (!r || !p || f == null) return false;
	return r.send.b1(f, r.sel("isKindOfClass:"), r.cls("NSView")) && r.send.b1(f, r.sel("isDescendantOf:"), p.web);
}

export function focusPopup(h: H): void {
	const r = objc(), p = popups.get(key(h)), w = mainWindow();
	if (r && p && w != null && appIsForeground()) r.send.b1(w, r.sel("makeFirstResponder:"), p.web);
}

export function focusMain(): void {
	const r = objc(), w = mainWindow(), view = contentView();
	if (r && w != null && view != null) r.send.b1(w, r.sel("makeFirstResponder:"), view);
}

export function appIsForeground(): boolean {
	const r = objc();
	return !!r && r.send.b0(r.send.m0(r.cls("NSApplication"), r.sel("sharedApplication")), r.sel("isActive"));
}

/** GPUIX's tick() pumps AppKit's events; this also lets the run loop service WebKit's sources (see objc.runLoopOnce). */
export function pump(): void {
	if (popups.size) runLoopOnce();
}

/** For diagnostics (the macOS smoke run): where the container is, as AppKit has it. */
export function debugPopups(): { shown: boolean; rect: Rect | null; keep: Rect | null }[] {
	return [...popups.values()].map((p) => ({ shown: p.shown, rect: p.rect, keep: p.keep }));
}
