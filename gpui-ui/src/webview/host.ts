// WebView2 hosts (through the `webview-bun` FFI to the webview C library) for the few places that need web content: Zotero's web reader
// (reader-host: snapshots, EPUBs) in a web tab, and Zotero's note editor (note-host, see notes.ts) in the item pane. GPUIX has no web-view
// element, so each WebView2 lives in its own frameless popup window OWNED by the GPUI window and kept over a placeholder element
// (win32.ts says why not a child window). Nothing is created until a host is first used, and release() destroys it, so the WebView2
// processes (~100-200 MB) only exist while something needs them.
//
// Threading: the webview library creates its window on THIS thread, so this thread must pump that window's messages. webview_run would
// block the event loop; instead one shared 10 ms timer calls PeekMessage/DispatchMessage (win32.pump) while any view exists. The page
// itself runs in WebView2's own processes, so a busy JS thread only delays resizing / moving the popup, never the page.
//
// Position: GPUIX reports element boxes in window-relative logical pixels (onLayout / getElementBounds); each tick maps them to screen
// pixels through the window's client origin and DPI, so moving the window needs no event. A placement can also carry a clip rect (the
// scroller the placeholder sits in) and holes (toasts drawn over it): the popup keeps its full size and a window region cuts it.
import { createSignal, type Accessor, type Setter } from "solid-js";
import type { Rect } from "../ui/core";
import {
	appIsForeground, clientOnScreen, clipPopup, dpr, focusMain, focusPopup, forgetPopup, hidePopup, isWindow, keepAbove, mainWindow, makeOwnedPopup,
	placePopup, popupHasFocus, pump, win32Available,
} from "./win32";

type H = number | bigint;
type WebviewLike = {
	unsafeWindowHandle: H | null;
	navigate(url: string): void;
	eval(js: string): void;
	init(js: string): void;
	bind(name: string, cb: (...a: unknown[]) => unknown): void;
	destroy(): void;
};

export type HostState = "idle" | "starting" | "ready" | "error";
export type PageMessage = { type?: string; [k: string]: unknown };
/** Where a popup goes, in window-relative logical px: `rect` is the placeholder; only the part inside `clip` and outside `holes` shows. */
export interface Placement { rect: Rect; clip?: Rect | null; holes?: Rect[] }

export interface WebHostOptions {
	/** script run in every page before its own scripts (webview_init) */
	init: string;
	/** what the page sends with window.znMsg(JSON.stringify(message)) */
	onMessage?: (m: PageMessage) => void;
	/** the page is about to be replaced (navigation elsewhere, release): let it save */
	onLeave?: (h: WebHost) => void;
	/** the view was destroyed (released, or closed behind our back) */
	onGone?: () => void;
	/** re-check the placement every tick (10 ms) instead of every third: for placeholders that scroll */
	follow?: boolean;
}

/** True when a web view can be shown at all (Windows with user32). Whether WebView2 itself starts is only known when it is created. */
export const webViewSupported = (): boolean => win32Available();
/** Tests: create views without a GPUI window (hidden, never placed), so a page can be driven headlessly. */
export const webViewHeadless = (): boolean => process.env.ZN_WEBVIEW_HEADLESS === "1";

// one message pump for every live view
const live = new Set<WebHost>();
let pumpTimer: ReturnType<typeof setInterval> | undefined;
// ZN_WEBVIEW_TRACE=1: log every pump round that takes longer than 30 ms, split into message pumping and placement
const TRACE = typeof process !== "undefined" && process.env.ZN_WEBVIEW_TRACE === "1";
function startPump(h: WebHost): void {
	live.add(h);
	pumpTimer ??= setInterval(() => {
		const t0 = TRACE ? performance.now() : 0;
		pump();
		const t1 = TRACE ? performance.now() : 0;
		for (const x of [...live]) x.tick();
		if (TRACE) { const t2 = performance.now(); if (t2 - t0 > 30) console.log(`[webview trace] round ${(t2 - t0).toFixed(0)} ms: pump ${(t1 - t0).toFixed(0)} ms, tick ${(t2 - t1).toFixed(0)} ms`); }
	}, 10);
}
function stopPump(h: WebHost): void {
	live.delete(h);
	if (!live.size && pumpTimer) { clearInterval(pumpTimer); pumpTimer = undefined; }
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export class WebHost {
	readonly state: Accessor<HostState>;
	readonly error: Accessor<string>;
	private setState: Setter<HostState>;
	private setError: Setter<string>;
	private wv: WebviewLike | null = null;
	private hwnd: H | null = null;
	private ticks = 0;
	private navigated = "";
	private placed = "";
	private region = "";
	private shown = false;
	private releaseTimer: ReturnType<typeof setTimeout> | undefined;
	private background = "";
	/** the page wanted (null: none, the view may go) */
	private url: string | null = null;
	private where: Rect | (() => Placement | null) | null = null;
	private visible = false;

	constructor(private o: WebHostOptions) {
		const [state, setState] = createSignal<HostState>("idle");
		const [error, setError] = createSignal("");
		this.state = state; this.error = error; this.setState = setState; this.setError = setError;
	}

	/** The view exists (its page may still be loading). */
	get alive(): boolean { return this.wv != null; }
	/** The popup is on screen. */
	get onScreen(): boolean { return this.shown; }

	/** Create the view if needed and load `url` in it (hidden until show()). */
	load(url: string): void {
		if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = undefined; }
		this.url = url;
		if (!this.wv) return void this.start();
		this.navigate();
	}

	/** Show `url` at `where` (a fixed rect, or a function polled every tick). Creates the view on first use. */
	show(url: string, where: Rect | (() => Placement | null)): void {
		this.where = where;
		this.visible = true;
		this.load(url);
		this.place();
	}

	/** Keep the view alive but out of sight (its tab is not active, or something is drawn over it). */
	hide(): void {
		this.visible = false;
		this.hideNow();
	}

	/** Nothing needs the page any more: let it save (onLeave), then destroy the view after `delayMs` unless it is wanted again. */
	release(delayMs = 400): void {
		this.url = null;
		this.where = null;
		this.hide();
		if (!this.wv || this.releaseTimer) return;
		this.o.onLeave?.(this);
		this.releaseTimer = setTimeout(() => { this.releaseTimer = undefined; if (!this.url) this.teardown(); }, delayMs);
	}

	/** Run a script in the page (fire and forget; answers come back through window.znMsg). */
	eval(js: string): void { try { this.wv?.eval(js); } catch { /* gone */ } }

	setBackground(hex: string): void { this.background = hex.replace("#", "").slice(0, 6).toUpperCase(); }

	/** Give the popup keyboard focus (only while it is shown and this app is in front). */
	focus(): void { if (this.hwnd != null && this.shown) focusPopup(this.hwnd); }

	/** True when the popup has keyboard focus. */
	hasFocus(): boolean { return this.hwnd != null && popupHasFocus(this.hwnd); }

	/** The shared pump calls this every 10 ms while the view exists. */
	tick(): void {
		if (!this.wv || this.hwnd == null) return;
		if (TRACE) {
			const t0 = performance.now();
			const p = typeof this.where === "function" ? this.where() : null;
			const t1 = performance.now();
			clientOnScreen(); dpr();
			const t2 = performance.now();
			if (t2 - t0 > 20) console.log(`[webview trace] tick: placement callback ${(t1 - t0).toFixed(0)} ms, window queries ${(t2 - t1).toFixed(0)} ms (rect ${p ? "yes" : "no"})`);
		}
		if (!isWindow(this.hwnd)) { // closed behind our back (Alt+F4 while the page had focus): start over if the page is still wanted
			const url = this.url, where = this.where, visible = this.visible;
			this.teardown();
			if (url) { this.url = url; this.where = where; this.visible = visible; void this.start(); }
			return;
		}
		if (this.o.follow || ++this.ticks % 3 === 0) this.place();
	}

	private hideNow(): void {
		if (this.hwnd != null && this.shown) {
			const had = popupHasFocus(this.hwnd);
			hidePopup(this.hwnd);
			this.shown = false; this.placed = "";
			if (had || appIsForeground()) focusMain();
		}
	}

	private navigate(): void {
		if (!this.wv || !this.url || this.navigated === this.url) return;
		if (this.navigated) this.o.onLeave?.(this);
		this.navigated = this.url;
		this.wv.navigate(this.url);
	}

	private async start(): Promise<void> {
		if (this.state() === "starting") return;
		this.setState("starting");
		this.setError("");
		await new Promise((r) => setTimeout(r, 0)); // let the placeholder paint before the ~0.4 s creation
		try {
			if (!win32Available()) throw new Error("the web view needs Windows");
			const owner = mainWindow();
			if (owner == null && !webViewHeadless()) throw new Error("no application window to attach the web view to");
			// WebView2's profile: the webview library picks %APPDATA%/<exe name>/EBWebView (bun.exe unpackaged, zotero-next-gpui.exe packaged); it ignores WEBVIEW2_USER_DATA_FOLDER
			if (this.background) process.env.WEBVIEW2_DEFAULT_BACKGROUND_COLOR = `FF${this.background}`;
			// literal specifier cast to string: bundled by Bun.build, but keeps TypeScript out of the package's .ts sources (they do not type-check under bun-types 1.4)
			const { Webview } = await import("webview-bun" as string) as unknown as { Webview: new (debug: boolean) => WebviewLike };
			const tc = TRACE ? performance.now() : 0;
			const w = new Webview(false);
			if (TRACE) console.log(`[webview trace] new Webview: ${(performance.now() - tc).toFixed(0)} ms`);
			const h = w.unsafeWindowHandle;
			if (h == null) throw new Error("the web view created no window");
			w.bind("znMsg", (json) => {
				const tm = TRACE ? performance.now() : 0;
				try { this.o.onMessage?.(JSON.parse(String(json)) as PageMessage); } catch (e) { console.error("[webview] message:", e); }
				if (TRACE) { const d = performance.now() - tm; if (d > 20) console.log(`[webview trace] page message handled in ${d.toFixed(0)} ms: ${String(json).slice(0, 80)}`); }
				return null;
			});
			w.init(this.o.init);
			makeOwnedPopup(h, owner); // not actually owned: see makeOwnedPopup (cross-thread ownership hung the app)
			this.wv = w; this.hwnd = h; this.navigated = ""; this.placed = ""; this.region = ""; this.shown = false; this.ticks = 0;
			startPump(this);
			this.setState("ready");
			if (!this.url) { this.release(); return; } // released while it was being created
			this.navigate();
			this.place();
		} catch (e) {
			this.teardown();
			this.setState("error");
			this.setError(e instanceof Error ? e.message : String(e));
		}
	}

	private place(): void {
		const hwnd = this.hwnd;
		if (!this.wv || hwnd == null || !this.url || !this.visible || !this.where || webViewHeadless()) return;
		const p = typeof this.where === "function" ? this.where() : { rect: this.where };
		const c = clientOnScreen();
		const r = p?.rect;
		if (!p || !r || !c || r.width < 2 || r.height < 2 || (p.clip && !overlaps(r, p.clip))) {
			if (this.shown) { hidePopup(hwnd); this.shown = false; this.placed = ""; } // window minimised / area collapsed or scrolled away
			return;
		}
		const k = dpr();
		const x = c.x + Math.round(r.x * k), y = c.y + Math.round(r.y * k);
		const w = Math.max(1, Math.round(r.width * k)), h = Math.max(1, Math.round(r.height * k));
		// a rect's part inside the placeholder, in the popup's own pixels
		const px = (q: Rect) => {
			const x0 = Math.round((Math.max(q.x, r.x) - r.x) * k), y0 = Math.round((Math.max(q.y, r.y) - r.y) * k);
			const x1 = Math.round((Math.min(q.x + q.width, r.x + r.width) - r.x) * k), y1 = Math.round((Math.min(q.y + q.height, r.y + r.height) - r.y) * k);
			return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
		};
		const clip = p.clip;
		const inside = !clip || (clip.x <= r.x && clip.y <= r.y && clip.x + clip.width >= r.x + r.width && clip.y + clip.height >= r.y + r.height);
		const keep = inside ? null : px(clip!);
		if (keep && (keep.width < 2 || keep.height < 2)) {
			if (this.shown) { hidePopup(hwnd); this.shown = false; this.placed = ""; }
			return;
		}
		const holes = (p.holes ?? []).filter((q) => overlaps(q, r)).map(px);
		const region = keep || holes.length ? JSON.stringify([keep, holes]) : "";
		const key = `${x},${y},${w},${h}`;
		if (this.shown && key === this.placed && region === this.region) { keepAbove(hwnd); return; }
		if (region !== this.region) { clipPopup(hwnd, keep, holes); this.region = region; }
		placePopup(hwnd, { x, y, width: w, height: h });
		keepAbove(hwnd);
		this.shown = true;
		this.placed = key;
	}

	private teardown(): void {
		stopPump(this);
		if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = undefined; }
		const w = this.wv, had = this.hwnd != null && this.shown && popupHasFocus(this.hwnd);
		if (this.hwnd != null) forgetPopup(this.hwnd);
		this.wv = null; this.hwnd = null; this.navigated = ""; this.placed = ""; this.region = ""; this.shown = false;
		this.url = null; this.where = null; this.visible = false;
		try { w?.destroy(); } catch { /* already gone */ }
		// destroy() only posts WM_CLOSE; with the pump stopped just above, the window would linger and the NEXT view then failed to
		// create ("the web view created no window": close a web tab, open another within a second or so). Drain the close chain now.
		if (w) for (let i = 0; i < 3; i++) pump();
		if (had && appIsForeground()) focusMain();
		if (this.state() !== "error") this.setState("idle");
		if (w) this.o.onGone?.();
	}
}

// ---- the web tabs' view (WebTabView.tsx) ----

/** Everything the bridge needs in the page: reader-host talks to window.parent (the Electrobun shell's iframe parent); a top-level web view has no parent, so a stub receives the messages. */
const BRIDGE = `(() => {
	if (window.top !== window) return;
	try {
		Object.defineProperty(window, "parent", { configurable: true, value: { postMessage(m) { try { window.znMsg(JSON.stringify(m)); } catch (e) {} } } });
	} catch (e) {}
})();`;

let handler: ((m: PageMessage) => void) | undefined;
const webTabs = new WebHost({
	init: BRIDGE,
	onMessage: (m) => handler?.(m),
	// reader-host saves annotations and the view state on pagehide / visibilitychange
	onLeave: (h) => h.eval("window.dispatchEvent(new Event('pagehide'))"),
});

export const hostState: Accessor<HostState> = webTabs.state;
export const hostError: Accessor<string> = webTabs.error;

/** Called by the tab view: the page to show and where (window-relative logical px). Creates the view on first use. */
export function show(url: string, rect: Rect): void { webTabs.show(url, rect); }

/** Keep the view alive but out of sight (its tab is not active, or something is drawn over it). */
export function hide(): void { webTabs.hide(); }

/** No web tab is open any more: flush the page's pending saves, then destroy the view and stop the timer. */
export function release(): void { webTabs.release(); }

/** Receive the messages the reader page posts to its "parent" (open-link, open-item, open-attachment, ...). */
export function onPageMessage(cb: ((m: PageMessage) => void) | undefined): void { handler = cb; }

/** Run a script in the page (tests, debugging). */
export function evalInPage(js: string): void { webTabs.eval(js); }

export function setBackground(hex: string): void { webTabs.setBackground(hex); }
