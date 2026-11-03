// One shared WebView2 (through the `webview-bun` FFI to the webview C library) that shows Zotero's web reader (reader-host: snapshots, EPUBs)
// in a web tab. GPUIX has no web-view element, so the WebView2 lives in its own frameless popup window OWNED by the GPUI window and kept
// over the tab's content area (win32.ts says why not a child window). Nothing is created until a web tab is first shown, and it is
// destroyed once the last web tab closes, so the WebView2 processes (~100-200 MB) only exist while one is open.
//
// Threading: the webview library creates its window on THIS thread, so this thread must pump that window's messages. webview_run would
// block the event loop; instead a 10 ms timer calls PeekMessage/DispatchMessage (win32.pump) while the view exists. The page itself
// runs in WebView2's own processes, so a busy JS thread only delays resizing / moving the popup, never the page.
//
// Position: GPUIX reports the tab area in window-relative logical pixels (onLayout); each tick maps it to screen pixels through the window's
// client origin and DPI, so moving the window needs no event.
import { createSignal, type Accessor } from "solid-js";
import type { Rect } from "../ui/core";
import { appIsForeground, clientOnScreen, dpr, focusMain, hidePopup, isWindow, mainWindow, makeOwnedPopup, placePopup, pump, win32Available } from "./win32";

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

const [state, setState] = createSignal<HostState>("idle");
const [error, setError] = createSignal("");
export const hostState: Accessor<HostState> = state;
export const hostError: Accessor<string> = error;

let wv: WebviewLike | null = null;
let hwnd: H | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let ticks = 0;
let navigated = "";
let placed = "";
let shown = false;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;
let handler: ((m: PageMessage) => void) | undefined;
let background = "";

interface Want { url: string; rect: Rect }
let want: Want | null = null;
let visible = false;

/** Everything the bridge needs in the page: reader-host talks to window.parent (the Electrobun shell's iframe parent); a top-level web view has no parent, so a stub receives the messages. */
const BRIDGE = `(() => {
	if (window.top !== window) return;
	try {
		Object.defineProperty(window, "parent", { configurable: true, value: { postMessage(m) { try { window.znMsg(JSON.stringify(m)); } catch (e) {} } } });
	} catch (e) {}
})();`;

/** True when a web view can be shown at all (Windows with user32). Whether WebView2 itself starts is only known when it is created. */
export const webViewSupported = (): boolean => win32Available();

/** Called by the tab view: the page to show and where (window-relative logical px). Creates the view on first use. */
export function show(url: string, rect: Rect): void {
	if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = undefined; }
	want = { url, rect };
	visible = true;
	if (!wv) return void start();
	place();
}

/** Keep the view alive but out of sight (its tab is not active, or something is drawn over it). */
export function hide(): void {
	visible = false;
	hideNow();
}

/** No web tab is open any more: flush the page's pending saves, then destroy the view and stop the timer. */
export function release(): void {
	want = null;
	visible = false;
	hideNow();
	if (!wv || releaseTimer) return;
	flushPage();
	releaseTimer = setTimeout(() => { releaseTimer = undefined; if (!want) teardown(); }, 400);
}

/** Receive the messages the reader page posts to its "parent" (open-link, open-item, open-attachment, ...). */
export function onPageMessage(cb: ((m: PageMessage) => void) | undefined): void { handler = cb; }

/** Run a script in the page (tests, debugging). */
export function evalInPage(js: string): void { try { wv?.eval(js); } catch { /* gone */ } }

export function setBackground(hex: string): void { background = hex.replace("#", "").slice(0, 6).toUpperCase(); }

function hideNow(): void {
	if (hwnd != null && shown) { hidePopup(hwnd); shown = false; placed = ""; if (appIsForeground()) focusMain(); }
}

function flushPage(): void {
	// reader-host saves annotations and the view state on pagehide / visibilitychange
	try { wv?.eval("window.dispatchEvent(new Event('pagehide'))"); } catch { /* gone */ }
}

async function start(): Promise<void> {
	if (state() === "starting") return;
	setState("starting");
	setError("");
	await new Promise((r) => setTimeout(r, 0)); // let the tab chip and its placeholder paint before the ~0.4 s creation
	try {
		if (!win32Available()) throw new Error("the web view needs Windows");
		const owner = mainWindow();
		if (owner == null) throw new Error("no application window to attach the web view to");
		// WebView2's profile: the webview library picks %APPDATA%/<exe name>/EBWebView (bun.exe unpackaged, zotero-next-gpui.exe packaged); it ignores WEBVIEW2_USER_DATA_FOLDER
		if (background) process.env.WEBVIEW2_DEFAULT_BACKGROUND_COLOR = `FF${background}`;
		// literal specifier cast to string: bundled by Bun.build, but keeps TypeScript out of the package's .ts sources (they do not type-check under bun-types 1.4)
		const { Webview } = await import("webview-bun" as string) as unknown as { Webview: new (debug: boolean) => WebviewLike };
		const w = new Webview(false);
		const h = w.unsafeWindowHandle;
		if (h == null) throw new Error("the web view created no window");
		w.bind("znMsg", (json) => {
			try { handler?.(JSON.parse(String(json)) as PageMessage); } catch { /* malformed */ }
			return null;
		});
		w.init(BRIDGE);
		makeOwnedPopup(h, owner);
		wv = w; hwnd = h; navigated = ""; placed = ""; shown = false; ticks = 0;
		timer = setInterval(tick, 10);
		setState("ready");
		place();
	} catch (e) {
		teardown();
		setState("error");
		setError(e instanceof Error ? e.message : String(e));
	}
}

function tick(): void {
	pump();
	if (!wv || hwnd == null) return;
	if (!isWindow(hwnd)) { // closed behind our back (Alt+F4 while the page had focus): start over if a tab still wants it
		const again = want;
		teardown();
		if (again) { want = again; visible = true; void start(); }
		return;
	}
	if (++ticks % 3 === 0) place();
}

function place(): void {
	if (!wv || hwnd == null || !want || !visible) return;
	if (navigated !== want.url) {
		if (navigated) flushPage();
		navigated = want.url;
		wv.navigate(want.url);
	}
	const c = clientOnScreen();
	if (!c || want.rect.width < 2 || want.rect.height < 2) {
		if (shown) { hidePopup(hwnd); shown = false; placed = ""; } // window minimised / area collapsed
		return;
	}
	const k = dpr();
	const r = want.rect;
	const x = c.x + Math.round(r.x * k), y = c.y + Math.round(r.y * k);
	const w = Math.max(1, Math.round(r.width * k)), h = Math.max(1, Math.round(r.height * k));
	const key = `${x},${y},${w},${h}`;
	if (shown && key === placed) return;
	placePopup(hwnd, { x, y, width: w, height: h });
	shown = true;
	placed = key;
}

function teardown(): void {
	if (timer) { clearInterval(timer); timer = undefined; }
	if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = undefined; }
	const w = wv;
	wv = null; hwnd = null; navigated = ""; placed = ""; shown = false; want = null; visible = false;
	try { w?.destroy(); } catch { /* already gone */ }
	if (state() !== "error") setState("idle");
}
