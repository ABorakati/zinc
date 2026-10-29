// Contract between the Find Full Text host (core, ./host.ts) and an embedded browser provided by
// the desktop app (Electrobun, app/src/bun/signin.ts). Core never imports Electrobun: the app
// registers an implementation with setBrowserBridge() at startup. Without one, sign-in falls back
// to "handoff" (a link for the user's own browser) and browser_load is unsupported.
//
// Port of the zotero-fulltext plugin's login-controller.js / browser.js semantics:
//  - ONE visible sign-in window at a time; it serves every waiting item (single-flight per realm).
//  - The core decides when sign-in is done: it polls the window (url + page HTML) and asks the
//    engine's pure fx_login_state; the bridge only reports what the window shows and what the user did.
//  - A window that landed or captured a PDF may be parked ("standby") and reused by the next login
//    request of the same run instead of opening another window.
//  - Nothing reads form fields or credentials. Logs carry host + path only.
//  - Cookies of the window's session are copied into the engine's HTTP cookie jar (cookiesFor) so the
//    engine's own requests are signed in after the user signs in.

/** What the user or the window did since the session started. */
export type LoginUserAction = "skip" | "handoff" | "keep_waiting";

/** A live sign-in window session (one per LoginWindow effect; may reuse a parked window). */
export interface LoginSession {
	/** Current top-level URL ("" before the first navigation commits). */
	url(): string;
	/** Current document HTML, capped at maxChars; "" if the page isn't ready within ~2 s. */
	html(maxChars: number): Promise<string>;
	/** User actions not yet consumed (drained on each call). */
	takeActions(): LoginUserAction[];
	/** True once the user closed the window. */
	closed(): boolean;
	/** A PDF the window downloaded/displayed after sign-in (when capturePdf was requested), else null. */
	capturedPdf(): { bytes: Uint8Array; url: string; filename?: string } | null;
	/** Update the banner: items waiting, "keep waiting" offer, challenge hint, status line. */
	setBanner(b: { waiting?: number; offerKeepWaiting?: boolean; challengeHint?: boolean; status?: string }): void;
	/** Resolves when anything above may have changed (navigation, user click, close, PDF) or after ms. */
	waitForChange(ms: number): Promise<void>;
	/**
	 * End the session. "close": close the window. "standby": keep it open (status "Checking access…")
	 * for up to standbyMs so the next openLogin() reuses it; it closes itself afterwards.
	 */
	finish(mode: "close" | "standby", standbyMs?: number): void;
}

export interface LoginRequest {
	entryUrl: string;
	realm: string; // engine realm (single-flight key)
	institutionName?: string; // display name for the window's banner, e.g. "King's College London"
	kind: string; // e.g. "openathens" | "saml" | "proxy" | "warmup"
	itemTitle?: string;
	waiting: number; // items waiting on this sign-in
	capturePdf: boolean;
}

export interface BrowserLoadRequest {
	url: string;
	timeoutMs: number;
	capturePdf: boolean; // take a PDF the page downloads or navigates to
	userAgent?: "plain"; // plain browser UA (some SSO/Cloudflare pages reject app UAs)
}

export interface BrowserLoadResult {
	finalUrl: string;
	status: number; // HTTP status of the final top-level navigation when known, else 200/0
	urlTrail: string[]; // top-level URLs visited, in order
	pageHtml?: string; // capped document HTML of the final page (when no PDF)
	pdf?: { bytes: Uint8Array; url: string; filename?: string };
	ms: number;
}

export interface BridgeCookie {
	name: string;
	value: string;
	domain: string; // leading "." for domain cookies
	path: string;
	secure: boolean;
	httpOnly: boolean;
	expires?: number; // seconds since epoch; absent = session cookie
}

export interface BrowserBridge {
	/** Open (or reuse the parked) visible sign-in window on entryUrl. Rejects if one is already open for this realm. */
	openLogin(req: LoginRequest, signal: AbortSignal): Promise<LoginSession>;
	/** Update the "N items waiting" label of the open window for this realm, if any. */
	updateWaiting(realm: string, waiting: number): void;
	/** Load a page in a hidden window that shares the sign-in session's cookies. */
	load(req: BrowserLoadRequest, signal: AbortSignal): Promise<BrowserLoadResult>;
	/** Cookies the embedded browser would send to url (from the shared sign-in session). */
	cookiesFor(url: string): Promise<BridgeCookie[]>;
	/** Close every sign-in/hidden window (app quitting, run cancelled). */
	closeAll(): void;
}

let bridge: BrowserBridge | null = null;

/** Called by the desktop app at startup. Pass null to remove. */
export function setBrowserBridge(b: BrowserBridge | null): void {
	bridge = b;
}

export function getBrowserBridge(): BrowserBridge | null {
	return bridge;
}
