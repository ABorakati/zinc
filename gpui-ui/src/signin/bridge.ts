// The Find Full Text sign-in browser for the GPUI app: implements core/src/fulltext/browser-bridge.ts on top of a Driver (the helper
// process of helper.ts; tests pass a fake). Port of app/src/bun/signin.ts of the Electrobun app (git d8abaeb4), with these differences:
//   - the browser is a separate process on a profile of its own (protocol.ts), started on first use and ended after IDLE_MS of no use;
//   - URLs and cookies come from the browser (DevTools protocol), so HttpOnly cookies are included in cookiesFor() and the window title
//     can show the real address;
//   - the cookies are also kept in memory in this process (the "jar" below) so a session survives the helper ending: they are put back
//     into the browser when the helper starts again. They are never written to disk by this app and never logged.
//
// What the core sees (browser-bridge.ts): one visible sign-in window at a time (openLogin, a LoginSession per request, reusing a parked
// window); hidden page loads (load); the cookies the browser would send to a URL (cookiesFor); closeAll.
import { existsSync, readFileSync, rmSync } from "node:fs";
import type {
	BridgeCookie,
	BrowserBridge,
	BrowserLoadRequest,
	BrowserLoadResult,
	LoginRequest,
	LoginSession,
	LoginUserAction,
} from "../../../core/src/fulltext/browser-bridge";
import { logInfo, logWarn } from "../../../core/src/log";
import { downloadsDir, signinProfileDir } from "./paths";
import type { BannerView, Driver, HelperEvent, RawCookie } from "./protocol";

// The browser exposes a DevTools port on loopback while it runs (WebView2 has no pipe transport), so it is not kept around long:
// a sign-in or capture that finds it gone starts it again in a few seconds.
export const IDLE_MS = 2 * 60_000;
const MAX_PAGE_HTML = 256 * 1024;
const FALLBACK_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
/** cookiesFor() asks the browser at most this often (the core asks once per request hop). */
const COOKIE_MAX_AGE_MS = 2000;

type Pdf = { bytes: Uint8Array; url: string; filename?: string };

// ---------------------------------------------------------------- pure helpers (tested)

export function isHttp(u: string): boolean {
	try {
		const p = new URL(u).protocol;
		return p === "http:" || p === "https:";
	} catch {
		return false;
	}
}

/** scheme://host/path with no userinfo, query or fragment: all that is ever logged of a URL. */
export function safeUrl(url: string): string {
	try {
		const u = new URL(url);
		return u.protocol === "http:" || u.protocol === "https:" ? `${u.protocol}//${u.host}${u.pathname}` : "";
	} catch {
		return "";
	}
}

export function pdfish(u: string): boolean {
	try {
		const x = new URL(u);
		return /pdf/i.test(x.pathname + x.search);
	} catch {
		return false;
	}
}

export function hasPdfMagic(b: Uint8Array): boolean {
	// %PDF within the first KiB (some servers prepend whitespace)
	return new TextDecoder("latin1").decode(b.subarray(0, 1024)).includes("%PDF-");
}

function filenameOf(u: string): string | undefined {
	try {
		const last = new URL(u).pathname.split("/").filter(Boolean).pop();
		return last ? decodeURIComponent(last) : undefined;
	} catch {
		return undefined;
	}
}

/** The window title: where the user is typing, from the browser's own address (trusted), not from the page. */
export function windowTitle(institution: string, url: string): string {
	let where = "";
	try {
		const u = new URL(url);
		if (u.protocol === "http:" || u.protocol === "https:")
			where = ` - ${u.protocol}//${u.host}${u.protocol === "http:" ? " (not secure)" : ""}`;
	} catch {
		/* no address yet */
	}
	return `Sign in to ${institution}${where}`;
}

/** Cookies the browser would send to `url`: domain / path / secure / expiry matching. */
export function cookiesForUrl(all: RawCookie[], url: string, nowSec = Date.now() / 1000): BridgeCookie[] {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return [];
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") return [];
	const host = u.hostname.toLowerCase();
	const path = u.pathname || "/";
	const out: BridgeCookie[] = [];
	for (const c of all) {
		if (!c || typeof c.name !== "string" || typeof c.value !== "string" || typeof c.domain !== "string") continue;
		const session = c.session === true || c.expires === undefined || c.expires <= 0;
		if (!session && (c.expires as number) < nowSec) continue;
		if (c.secure && u.protocol !== "https:") continue;
		const d = c.domain.toLowerCase();
		const bare = d.replace(/^\./, "");
		const hostOk = d.startsWith(".") ? host === bare || host.endsWith("." + bare) : host === bare;
		if (!hostOk) continue;
		const cp = c.path || "/";
		const pathOk = path === cp || (path.startsWith(cp) && (cp.endsWith("/") || path.charAt(cp.length) === "/"));
		if (!pathOk) continue;
		out.push({
			name: c.name,
			value: c.value,
			domain: c.domain,
			path: cp,
			secure: !!c.secure,
			httpOnly: !!c.httpOnly,
			...(session ? {} : { expires: c.expires as number }),
		});
	}
	return out;
}

export function cookieHeader(cs: BridgeCookie[]): string {
	return cs.map((c) => `${c.name}=${c.value}`).join("; ");
}

// ---------------------------------------------------------------- bridge

export interface BridgeDeps {
	/** Start a helper (waits until it is ready). */
	start: () => Promise<Driver>;
	/** The sign-in browser has a profile on disk (cookies may be in it). */
	profileExists?: () => boolean;
	/** Scratch folder for captured downloads. */
	downloads?: string;
	idleMs?: number;
	log?: (level: "info" | "warn", msg: string) => void;
	/** test seams */
	now?: () => number;
	fetchFn?: typeof fetch;
}

export interface SigninBridge extends BrowserBridge {
	/** End the helper (app quitting). Resolves when it has gone. */
	dispose(): Promise<void>;
	/** Test hook: press a bar button as the UI does. */
	simulateAction(a: LoginUserAction): void;
	/** Test hook: is a helper process running. */
	readonly helperRunning: boolean;
}

interface SessionState {
	req: LoginRequest;
	actions: LoginUserAction[];
	closed: boolean;
	finished: boolean;
	waiters: Set<() => void>;
}

/** Everything the helper reports about one window: address, load state, downloads. */
class Tracker {
	url = "";
	trail: string[] = [];
	loaded = false;
	navSeen = false;
	lastEventAt: number;
	activeDownloads = 0;
	pdf: Pdf | null = null;
	capturePdf: boolean;
	private probed = new Set<string>();
	constructor(
		private now: () => number,
		capturePdf: boolean,
		private onChange: () => void,
	) {
		this.lastEventAt = now();
		this.capturePdf = capturePdf;
	}
	touch(): void {
		this.lastEventAt = this.now();
		this.onChange();
	}
	nav(url: string): boolean {
		if (!isHttp(url)) return false; // about:blank, error pages, ... are not part of the trail
		this.navSeen = true;
		if (url !== this.url) {
			this.url = url;
			if (this.trail[this.trail.length - 1] !== url) this.trail.push(url);
		}
		this.touch();
		return true;
	}
	reset(): void {
		this.url = "";
		this.trail = [];
		this.loaded = false;
		this.navSeen = false;
		this.pdf = null;
		this.activeDownloads = 0;
		this.probed.clear();
		this.touch();
	}
	/** True once per URL: the caller should try to fetch it as a PDF. */
	shouldProbe(url: string): boolean {
		if (!this.capturePdf || this.pdf || this.probed.has(url)) return false;
		this.probed.add(url);
		return true;
	}
}

export function createSigninBridge(deps: BridgeDeps): SigninBridge {
	const now = deps.now ?? Date.now;
	const log = deps.log ?? ((level, msg) => (level === "warn" ? logWarn("core", `signin: ${msg}`) : logInfo("core", `signin: ${msg}`)));
	const profileExists = deps.profileExists ?? (() => existsSync(signinProfileDir()));
	const dlDir = deps.downloads ?? downloadsDir();
	const idleMs = deps.idleMs ?? IDLE_MS;
	const doFetch = deps.fetchFn ?? fetch;

	let driver: Driver | null = null;
	let starting: Promise<Driver> | null = null;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;
	/** cookies of the browser as last read (kept in memory only) */
	let jar: { at: number; cookies: RawCookie[] } | null = null;
	let reading: Promise<RawCookie[]> | null = null;
	let seq = 0;

	const logins = new Map<string, LoginWin>(); // id -> window (at most one open at a time)
	const loads = new Map<string, Tracker>();
	let login: LoginWin | null = null;
	let busy = 0; // calls in flight that must keep the helper alive (loads, window use)

	// ---- helper life cycle

	function armIdle(): void {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = null;
		if (!driver || disposed) return;
		idleTimer = setTimeout(() => void idleStop(), idleMs);
		(idleTimer as { unref?: () => void }).unref?.();
	}

	async function idleStop(): Promise<void> {
		idleTimer = null;
		const inUse = () => busy > 0 || (login && !login.closed);
		if (!driver || inUse()) return armIdle();
		const d = driver;
		try {
			await readCookies(d, 0); // the in-memory copy is current when the browser ends
		} catch {
			/* keep the older copy */
		}
		// drv() handed this browser out while the cookies were read: a load or a window may be using it now
		if (driver !== d || inUse()) return armIdle();
		driver = null;
		log("info", "sign-in browser ended (idle)");
		await d.stop();
	}

	async function drv(): Promise<Driver> {
		if (disposed) throw new Error("the sign-in browser is shut down");
		if (driver?.alive) {
			armIdle();
			return driver;
		}
		starting ??= (async () => {
			const d = await deps.start();
			d.onEvent((e) => route(d, e));
			// put the session cookies of the last run back (they would otherwise be lost when the browser ended)
			const session = (jar?.cookies ?? []).filter((c) => c.session === true || c.expires === undefined || c.expires <= 0);
			if (session.length) {
				try {
					await d.call("setCookies", { cookies: session });
				} catch {
					/* the browser starts without them */
				}
			}
			driver = d;
			log("info", "sign-in browser started");
			return d;
		})().finally(() => {
			starting = null;
		});
		const d = await starting;
		armIdle();
		return d;
	}

	function route(d: Driver, e: HelperEvent): void {
		if (e.ev === "exit") {
			if (driver === d) driver = null;
			for (const l of [...logins.values()]) l.gone();
			return;
		}
		if (e.ev === "nav" || e.ev === "loaded" || e.ev === "closed" || e.ev === "action") {
			logins.get(e.id)?.onEvent(e);
			const t = loads.get(e.id);
			if (t) {
				if (e.ev === "nav") {
					if (t.nav(e.url) && e.mime?.toLowerCase().includes("pdf")) void probe(t, e.url);
				} else if (e.ev === "loaded") {
					t.loaded = true;
					t.touch();
				}
			}
			return;
		}
		if (e.ev === "download-begin") {
			for (const t of capturing()) {
				t.activeDownloads++;
				t.touch();
			}
		} else if (e.ev === "download-end") {
			for (const t of capturing()) {
				t.activeDownloads = Math.max(0, t.activeDownloads - 1);
				t.touch();
			}
		} else if (e.ev === "download") {
			for (const t of capturing()) {
				t.activeDownloads = Math.max(0, t.activeDownloads - 1);
				takeDownload(t, e);
			}
		}
	}

	function capturing(): Tracker[] {
		const out = [...loads.values()].filter((t) => t.capturePdf);
		if (login && login.tracker.capturePdf) out.push(login.tracker);
		return out;
	}

	function takeDownload(t: Tracker, e: { path: string; url: string; filename?: string }): void {
		try {
			const bytes = new Uint8Array(readFileSync(e.path));
			if (!hasPdfMagic(bytes)) return;
			t.pdf = { bytes, url: t.url || e.url, filename: e.filename ?? filenameOf(e.url) };
			t.touch();
		} catch {
			/* not readable: another route may still capture the PDF */
		} finally {
			try {
				rmSync(e.path, { force: true });
			} catch {
				/* left for the next sweep */
			}
		}
	}

	async function setDownloads(on: boolean): Promise<void> {
		try {
			await (await drv()).call("downloads", { dir: on ? dlDir : null });
		} catch {
			/* downloads stay as they were; the cookie fetch probe still works */
		}
	}

	// ---- cookies

	async function readCookies(d: Driver, maxAgeMs: number): Promise<RawCookie[]> {
		if (jar && now() - jar.at <= maxAgeMs) return jar.cookies;
		reading ??= d
			.call("cookies", {}, 8000)
			.then((cookies) => {
				jar = { at: now(), cookies };
				return cookies;
			})
			.finally(() => {
				reading = null;
			});
		return reading;
	}

	async function cookiesFor(url: string): Promise<BridgeCookie[]> {
		if (!isHttp(url)) return [];
		let all: RawCookie[] = [];
		try {
			if (driver?.alive) all = await readCookies(driver, COOKIE_MAX_AGE_MS);
			else if (jar) all = jar.cookies;
			else if (profileExists()) all = await readCookies(await drv(), 0);
		} catch {
			all = jar?.cookies ?? [];
		}
		return cookiesForUrl(all, url, now() / 1000);
	}

	/** A PDF the window displays in its own viewer (no download event): fetch it with the session's cookies. */
	async function probe(t: Tracker, url: string): Promise<void> {
		if (!t.shouldProbe(url)) return;
		const p = await probePdf(url);
		if (p && !t.pdf) {
			t.pdf = p;
			t.touch();
		}
	}

	async function probePdf(url: string): Promise<Pdf | null> {
		if (!isHttp(url)) return null;
		try {
			const cs = await cookiesFor(url);
			const res = await doFetch(url, {
				redirect: "follow",
				headers: {
					"User-Agent": FALLBACK_UA,
					Accept: "application/pdf,*/*;q=0.8",
					...(cs.length ? { Cookie: cookieHeader(cs) } : {}),
				},
				signal: AbortSignal.timeout(30_000),
			});
			const ct = (res.headers.get("content-type") ?? "").toLowerCase();
			if (!res.ok || !(ct.includes("pdf") || ct.includes("octet-stream"))) {
				void res.body?.cancel();
				return null;
			}
			const bytes = new Uint8Array(await res.arrayBuffer());
			if (!hasPdfMagic(bytes)) return null;
			return { bytes, url: res.url || url, filename: filenameOf(res.url || url) };
		} catch {
			return null;
		}
	}

	// ---- the visible sign-in window

	class LoginWin {
		readonly id = `login-${++seq}`;
		s: SessionState;
		banner: BannerView;
		tracker: Tracker;
		closed = false;
		/** a window just created: it shows nothing left over from an earlier sign-in (see session().url) */
		fresh = true;
		private standbyTimer: ReturnType<typeof setTimeout> | null = null;
		private title = "";

		constructor(req: LoginRequest) {
			this.s = { req, actions: [], closed: false, finished: false, waiters: new Set() };
			this.banner = this.initialBanner(req);
			this.tracker = new Tracker(now, req.capturePdf, () => this.onTracker());
		}

		private initialBanner(req: LoginRequest): BannerView {
			return {
				institution: req.institutionName || req.realm,
				waiting: req.waiting,
				status: "",
				offerKeepWaiting: false,
				challengeHint: false,
				standby: false,
			};
		}

		private notify(): void {
			const w = [...this.s.waiters];
			this.s.waiters.clear();
			for (const f of w) f();
		}

		private onTracker(): void {
			this.setTitle();
			this.notify();
		}

		private setTitle(): void {
			const t = windowTitle(this.banner.institution, this.tracker.url);
			if (t === this.title || this.closed) return;
			this.title = t;
			void driver?.call("title", { id: this.id, text: t }).catch(() => {});
		}

		pushBanner(): void {
			if (this.closed) return;
			void driver?.call("banner", { id: this.id, state: this.banner }).catch(() => {});
		}

		onEvent(e: Extract<HelperEvent, { id: string }>): void {
			if (e.ev === "nav") {
				if (this.tracker.nav(e.url) && e.mime?.toLowerCase().includes("pdf") && this.tracker.capturePdf)
					void probe(this.tracker, e.url);
				else if (isHttp(e.url) && this.tracker.capturePdf && pdfish(e.url)) void probe(this.tracker, e.url);
			} else if (e.ev === "loaded") {
				this.tracker.loaded = true;
				this.tracker.touch();
			} else if (e.ev === "closed") {
				this.gone();
			} else if (e.ev === "action") {
				this.handle(e.a);
			}
		}

		handle(a: LoginUserAction): void {
			this.s.actions.push(a);
			this.notify();
		}

		/** The window or the whole helper is gone. */
		gone(): void {
			if (this.closed) return;
			this.closed = true;
			this.s.closed = true;
			if (this.standbyTimer) clearTimeout(this.standbyTimer);
			logins.delete(this.id);
			if (login === this) login = null;
			this.notify();
		}

		/** Put the window away (kept by the helper for the next sign-in). */
		close(): void {
			if (this.closed) return;
			this.gone();
			void driver?.call("release", { id: this.id }).catch(() => {});
		}

		/** Reuse the parked window for a new request. */
		reuse(req: LoginRequest): void {
			if (this.standbyTimer) clearTimeout(this.standbyTimer);
			this.standbyTimer = null;
			this.s = { req, actions: [], closed: false, finished: false, waiters: new Set() };
			this.fresh = false;
			this.banner = this.initialBanner(req);
			this.tracker.reset();
			this.tracker.capturePdf = req.capturePdf;
			this.title = "";
			this.setTitle();
			this.pushBanner();
			void driver?.call("navigate", { id: this.id, url: req.entryUrl }).catch(() => {});
		}

		session(): LoginSession {
			const st = this.s;
			const self = this;
			// The controller reads the address once at the start to learn what an earlier sign-in left in a reused window and ignores that page
			// for a while. A new window has no such page, even when the browser already committed the entry page before the window was handed out.
			let first = this.fresh;
			return {
				url: () => {
					if (first) {
						first = false;
						return "";
					}
					return self.tracker.url;
				},
				html: async (max) => {
					if (self.closed || !driver?.alive) return "";
					try {
						return (await driver.call("html", { id: self.id, max: Math.min(max, MAX_PAGE_HTML) }, 2500)).slice(0, max);
					} catch {
						return "";
					}
				},
				takeActions: () => st.actions.splice(0),
				closed: () => st.closed,
				capturedPdf: () => self.tracker.pdf,
				setBanner(b) {
					if (st !== self.s) return;
					if (b.waiting !== undefined) self.banner.waiting = b.waiting;
					if (b.offerKeepWaiting !== undefined) self.banner.offerKeepWaiting = b.offerKeepWaiting;
					if (b.challengeHint !== undefined) self.banner.challengeHint = b.challengeHint;
					if (b.status !== undefined) self.banner.status = b.status;
					self.pushBanner();
				},
				waitForChange(ms) {
					return new Promise<void>((resolve) => {
						if (st.closed) return resolve();
						const t = setTimeout(done, Math.max(0, ms));
						function done() {
							clearTimeout(t);
							st.waiters.delete(done);
							resolve();
						}
						st.waiters.add(done);
					});
				},
				finish(mode, standbyMs = 60_000) {
					if (st !== self.s || st.finished) return;
					st.finished = true;
					if (mode === "close") return self.close();
					self.banner.standby = true;
					self.pushBanner();
					if (self.standbyTimer) clearTimeout(self.standbyTimer);
					self.standbyTimer = setTimeout(() => self.close(), standbyMs);
					(self.standbyTimer as { unref?: () => void }).unref?.();
				},
			};
		}
	}

	// ---- BrowserBridge

	const bridge: SigninBridge = {
		async openLogin(req, signal) {
			if (!isHttp(req.entryUrl)) throw new Error("entryUrl must be http(s)");
			if (signal.aborted) throw new Error("aborted");
			let lw = login;
			if (lw && !lw.closed) {
				if (!lw.s.finished) throw new Error(`a sign-in window is already open (realm ${lw.s.req.realm})`);
				lw.reuse(req);
			} else {
				const w = new LoginWin(req);
				const d = await drv();
				if (login && !login.closed) throw new Error(`a sign-in window is already open (realm ${login.s.req.realm})`); // another call got there while the browser started
				login = w;
				logins.set(w.id, w);
				busy++;
				try {
					if (req.capturePdf) await setDownloads(true);
					await d.call(
						"open",
						{ id: w.id, url: req.entryUrl, title: windowTitle(w.banner.institution, ""), visible: true },
						30_000,
					);
				} catch (e) {
					w.gone();
					throw e;
				} finally {
					busy--;
				}
				w.pushBanner();
				lw = w;
			}
			log("info", `sign-in window open at ${safeUrl(req.entryUrl) || "(url)"} (realm ${req.realm}, ${req.kind})`);
			const sess = lw.session();
			signal.addEventListener("abort", () => sess.finish("close"), { once: true });
			return sess;
		},

		updateWaiting(realm, waiting) {
			if (login && !login.closed && !login.s.finished && login.s.req.realm === realm) {
				login.banner.waiting = waiting;
				login.pushBanner();
			}
		},

		async load(req: BrowserLoadRequest, signal: AbortSignal): Promise<BrowserLoadResult> {
			if (!isHttp(req.url)) throw new Error("url must be http(s)");
			const t0 = now();
			const id = `load-${++seq}`;
			const tracker = new Tracker(now, req.capturePdf, () => {});
			loads.set(id, tracker);
			busy++;
			let opened = false;
			try {
				const d = await drv();
				if (req.capturePdf) await setDownloads(true);
				await d.call("open", { id, url: req.url, title: "zotero-next page load", visible: false }, 30_000);
				opened = true;
				const quietMs = req.capturePdf ? 2500 : 1500;
				for (;;) {
					if (signal.aborted) throw new Error("aborted");
					const t = now();
					if (t - t0 >= req.timeoutMs) break;
					if (tracker.pdf) break;
					if (!d.alive) break;
					if ((tracker.loaded || tracker.navSeen) && tracker.activeDownloads === 0 && t - tracker.lastEventAt >= quietMs) break;
					await new Promise((r) => setTimeout(r, 100));
				}
				let pdf = tracker.pdf;
				let pageHtml: string | undefined;
				if (!pdf) {
					let h = "";
					try {
						h = await d.call("html", { id, max: MAX_PAGE_HTML }, 4000);
					} catch {
						/* no page */
					}
					if (h) pageHtml = h;
					if (req.capturePdf && tracker.url) {
						const looksPdf = pdfish(tracker.url) || !h || /type=["']application\/pdf/i.test(h);
						if (looksPdf) pdf = tracker.pdf ?? (await probePdf(tracker.url));
					}
				}
				const finalUrl = tracker.url || req.url;
				return {
					finalUrl,
					status: tracker.loaded || tracker.navSeen ? 200 : 0,
					urlTrail: tracker.trail.length ? [...tracker.trail] : [req.url],
					...(pdf ? { pdf } : pageHtml !== undefined ? { pageHtml } : {}),
					ms: now() - t0,
				};
			} finally {
				loads.delete(id);
				if (opened) void driver?.call("release", { id }).catch(() => {});
				if (req.capturePdf && capturing().length === 0) void setDownloads(false); // no load and no sign-in window still captures
				busy--;
				armIdle();
			}
		},

		cookiesFor,

		closeAll() {
			login?.close();
			for (const id of [...loads.keys()]) void driver?.call("release", { id }).catch(() => {});
			loads.clear();
		},

		async dispose() {
			disposed = true;
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = null;
			bridge.closeAll();
			const d = driver;
			driver = null;
			if (d) {
				try {
					await readCookies(d, 0);
				} catch {
					/* gone */
				}
				await d.stop();
			}
		},

		simulateAction(a) {
			login?.handle(a);
		},

		get helperRunning() {
			return !!driver?.alive;
		},
	};
	return bridge;
}
