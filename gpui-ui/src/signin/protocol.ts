// Messages between the app and the sign-in helper process (helper.ts), and the Driver the bridge talks to.
//
// Why a helper process: the webview library puts a WebView2's data in %APPDATA%\<exe name>\EBWebView and ignores every setting that
// would move it. The app's own views (notes, web tabs) already use the folder of the app's exe, and a sign-in session must be kept apart
// from them (its cookies are the user's institutional login). So the sign-in browser runs in a child process started from a hard link of
// the app's exe called zotero-next-signin.exe, which gives it a profile of its own: %APPDATA%\zotero-next-signin.exe\EBWebView.
// The child also gives the sign-in window a message loop of its own (an ordinary framed top-level window, not the app's owned popup).
//
// Requests go from the app to the helper as { rid, op, ...args }; the helper answers { rid, ok, value | error }. Events come from the
// helper as { ev, ...fields }. Nothing here carries a cookie value except the `cookies` / `setCookies` ops, which stay inside the app
// process and the helper (never logged).

/** A cookie as the browser reports it (Chrome DevTools Protocol shape, trimmed to what the bridge uses). */
export interface RawCookie {
	name: string;
	value: string;
	domain: string; // leading "." = domain cookie
	path: string;
	secure: boolean;
	httpOnly: boolean;
	/** seconds since the epoch; -1 or absent = session cookie */
	expires?: number;
	session?: boolean;
	sameSite?: string;
}

export type BannerAction = "skip" | "handoff" | "keep_waiting";

/** What the in-page bar of the sign-in window shows. */
export interface BannerView {
	institution: string;
	waiting: number;
	status: string;
	offerKeepWaiting: boolean;
	challengeHint: boolean;
	standby: boolean;
}

export type HelperEvent =
	| { ev: "ready" }
	/** the top-level page of window `id` committed a navigation (url is the browser's own, not the page's claim) */
	| { ev: "nav"; id: string; url: string; mime?: string }
	| { ev: "loaded"; id: string }
	/** the user closed window `id` */
	| { ev: "closed"; id: string }
	| { ev: "action"; id: string; a: BannerAction }
	/** a download finished into the folder set with `downloads` */
	| { ev: "download"; path: string; url: string; filename?: string }
	/** a download started / was cancelled (a finished one is the `download` event) */
	| { ev: "download-begin" }
	| { ev: "download-end" }
	/** the helper process ended */
	| { ev: "exit" };

export interface OpenArgs {
	id: string;
	url: string;
	title: string;
	visible: boolean;
}

/** The requests the helper understands, with their results. */
export interface HelperOps {
	/** Show window `id` (a reused idle one, or a new one) on url. Resolves once its page is under control. */
	open: { args: OpenArgs; result: null };
	navigate: { args: { id: string; url: string }; result: null };
	/** document HTML with typed values removed, at most `max` characters; "" when the page is not ready */
	html: { args: { id: string; max: number }; result: string };
	title: { args: { id: string; text: string }; result: null };
	banner: { args: { id: string; state: BannerView | null }; result: null };
	/** put the window away: hide it, blank the page, keep the browser for the next use */
	release: { args: { id: string }; result: null };
	/** every cookie of the profile */
	cookies: { args: Record<string, never>; result: RawCookie[] };
	setCookies: { args: { cookies: RawCookie[] }; result: number };
	/** folder that downloads go to (the helper reports each finished one), or null to refuse downloads */
	downloads: { args: { dir: string | null }; result: null };
	/** close every window and end */
	quit: { args: Record<string, never>; result: null };
}
export type HelperOp = keyof HelperOps;

/** What the bridge needs from a running helper. HelperLink (launch.ts) is the real one; tests use a fake. */
export interface Driver {
	call<K extends HelperOp>(op: K, args: HelperOps[K]["args"], timeoutMs?: number): Promise<HelperOps[K]["result"]>;
	onEvent(cb: (e: HelperEvent) => void): void;
	/** end the helper (gracefully if it answers) */
	stop(): Promise<void>;
	readonly alive: boolean;
}
