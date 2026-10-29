// Embedded sign-in browser for Find Full Text (implements core/src/fulltext/browser-bridge.ts).
//
// Institution-agnostic: nothing here knows about any identity provider. The banner shows the real
// origin of the page the user is typing credentials into, plus whatever the core passes in the request.
//
// Window layout: one BrowserWindow whose primary view is a small TRUSTED banner page (inline HTML,
// has the host-message bridge). The site is an <electrobun-webview sandbox partition=...> tag inside
// that banner page, so it auto-resizes with the window. The site view is sandboxed (events only, no
// RPC) and shares a persistent partition with the hidden load() windows, so cookies are shared.
//
// Data back from the untrusted page: navigation events give URLs; document HTML and the user agent are
// pulled by executeJavascript() calling window.__electrobunSendToHost() with a per-window nonce; the
// pulled HTML has input value attributes stripped, and nothing reads form fields or credentials.
import Electrobun, { BrowserView, BrowserWindow, Session, Utils } from "electrobun/main";
import { readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type {
	BridgeCookie,
	BrowserBridge,
	BrowserLoadRequest,
	BrowserLoadResult,
	LoginRequest,
	LoginSession,
	LoginUserAction,
} from "../../../core/src/fulltext/browser-bridge";

/** Generic persistent partition shared by the sign-in window and the hidden load windows. */
export const INSTITUTION_PARTITION = "persist:institution";

const BLANK_HTML = "<!doctype html><meta charset=utf-8><title>zotero-next</title>";
const MAX_PAGE_HTML = 256 * 1024;
const FALLBACK_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

type Ev = { data: { detail: unknown } };
const events = Electrobun.events;

function nonce(): string {
	const b = new Uint8Array(16);
	crypto.getRandomValues(b);
	return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function isHttp(u: string): boolean {
	try {
		const p = new URL(u).protocol;
		return p === "http:" || p === "https:";
	} catch {
		return false;
	}
}

function pdfish(u: string): boolean {
	try {
		const x = new URL(u);
		return /pdf/i.test(x.pathname + x.search);
	} catch {
		return false;
	}
}

function hasPdfMagic(b: Uint8Array): boolean {
	// %PDF within the first KiB (some servers prepend whitespace)
	const head = new TextDecoder("latin1").decode(b.subarray(0, 1024));
	return head.includes("%PDF-");
}

function filenameOf(u: string): string | undefined {
	try {
		const last = new URL(u).pathname.split("/").filter(Boolean).pop();
		return last ? decodeURIComponent(last) : undefined;
	} catch {
		return undefined;
	}
}

// Electrobun 2.0.5 on Windows: Session.cookies.get() returns [] and .set() returns false (not implemented
// for WebView2), so cookiesFor() falls back to reading document.cookie in a hidden page on the same
// partition. That sees script-visible cookies only (HttpOnly ones are not visible); the engine should
// use browser_load for anything that needs the full session.
const pageCookieCache = new Map<string, { at: number; cs: BridgeCookie[] }>();

async function cookiesFor(url: string): Promise<BridgeCookie[]> {
	const native = nativeCookies(url);
	if (native.length) return native;
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return [];
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") return [];
	const hit = pageCookieCache.get(u.origin);
	if (hit && Date.now() - hit.at < 30_000) return hit.cs;
	const h = openHidden(u.origin + "/robots.txt", false);
	let cs: BridgeCookie[] = [];
	try {
		const t0 = Date.now();
		while (!h.tracker.loaded && Date.now() - t0 < 8000) await Bun.sleep(100);
		const raw = h.tracker.loaded ? await h.tracker.docCookie() : "";
		cs = raw
			.split(/;\s*/)
			.filter((p) => p.includes("="))
			.map((p) => {
				const i = p.indexOf("=");
				return { name: p.slice(0, i), value: p.slice(i + 1), domain: u.hostname, path: "/", secure: u.protocol === "https:", httpOnly: false };
			});
	} finally {
		h.close();
	}
	pageCookieCache.set(u.origin, { at: Date.now(), cs });
	return cs;
}

function openHidden(url: string, capturePdf: boolean) {
	const win = new BrowserWindow({
		title: "zotero-next page load",
		html: BLANK_HTML,
		frame: { x: 40, y: 40, width: 1280, height: 900 },
		hidden: true,
		activate: false,
		sandbox: true,
	});
	const view = new BrowserView({
		url,
		partition: INSTITUTION_PARTITION,
		sandbox: true,
		windowId: win.id,
		frame: { x: 0, y: 0, width: 1280, height: 900 },
	});
	const tracker = new SiteTracker(view, nonce(), capturePdf, () => {});
	return {
		tracker,
		close() {
			tracker.dispose();
			try {
				view.remove();
			} catch {}
			try {
				win.close();
			} catch {}
		},
	};
}

function nativeCookies(url: string): BridgeCookie[] {
	let raw: ReturnType<ReturnType<typeof Session.fromPartition>["cookies"]["get"]>;
	try {
		raw = Session.fromPartition(INSTITUTION_PARTITION).cookies.get({ url });
	} catch {
		return [];
	}
	const now = Date.now() / 1000;
	const out: BridgeCookie[] = [];
	for (const c of raw) {
		if (c.expirationDate !== undefined && c.expirationDate !== 0 && c.expirationDate < now) continue;
		const exp = c.expirationDate;
		out.push({
			name: c.name,
			value: c.value,
			domain: c.domain ?? "",
			path: c.path ?? "/",
			secure: !!c.secure,
			httpOnly: !!c.httpOnly,
			...(exp !== undefined && exp > 0 ? { expires: exp } : {}),
		});
	}
	return out;
}

function cookieHeader(cs: BridgeCookie[], url: string): string {
	let host = "";
	let secure = false;
	try {
		const u = new URL(url);
		host = u.hostname;
		secure = u.protocol === "https:";
	} catch {
		return "";
	}
	return cs
		.filter((c) => {
			const d = c.domain.replace(/^\./, "").toLowerCase();
			const hostOk = !d || host === d || host.endsWith("." + d);
			return hostOk && (!c.secure || secure);
		})
		.map((c) => `${c.name}=${c.value}`)
		.join("; ");
}

type Pdf = { bytes: Uint8Array; url: string; filename?: string };

/** Everything we learn from one site view: URLs, load state, downloads, page-script replies. */
class SiteTracker {
	url = "";
	trail: string[] = [];
	loaded = false; // a top-level load finished (dom-ready)
	navSeen = false;
	lastEventAt = Date.now();
	activeDownloads = 0;
	pdf: Pdf | null = null;
	userAgent = "";
	private seq = 0;
	private pending = new Map<number, (html: string) => void>();
	private offs: Array<() => void> = [];
	private probed = new Set<string>();

	constructor(
		readonly view: BrowserView,
		readonly key: string,
		public capturePdf: boolean,
		private readonly onChange: () => void,
		private readonly onPopup?: (url: string) => void,
	) {
		const on = (name: string, h: (e: Ev) => void) => {
			const n = `${name}-${view.id}`;
			events.on(n, h);
			this.offs.push(() => events.off(n, h));
		};
		const nav = (e: Ev) => this.setUrl(String(e.data.detail ?? ""));
		on("did-commit-navigation", nav);
		on("did-navigate", nav);
		on("did-navigate-in-page", nav);
		on("dom-ready", (e) => {
			this.setUrl(String(e.data.detail ?? ""));
			this.loaded = true;
			this.touch();
			if (!this.userAgent) {
				view.executeJavascript(
					`try{window.__electrobunSendToHost({zn:${JSON.stringify(key)},ua:navigator.userAgent})}catch(e){}`,
				);
			}
			void this.maybeProbe();
		});
		on("host-message", (e) => {
			const m = e.data.detail as { zn?: string; id?: number; html?: string; ua?: string } | null;
			if (!m || typeof m !== "object" || m.zn !== this.key) return;
			if (typeof m.ua === "string") this.userAgent = m.ua.slice(0, 400);
			if (typeof m.id === "number" && typeof m.html === "string") {
				this.pending.get(m.id)?.(m.html);
				this.pending.delete(m.id);
			}
		});
		on("new-window-open", (e) => {
			const d = e.data.detail as string | { url?: string } | null;
			const u = typeof d === "string" ? d : d?.url;
			if (u && isHttp(u)) {
				if (this.onPopup) this.onPopup(u);
				else this.view.loadURL(u);
			}
		});
		on("download-started", () => {
			this.activeDownloads++;
			this.touch();
		});
		on("download-completed", (e) => {
			this.activeDownloads = Math.max(0, this.activeDownloads - 1);
			this.touch();
			if (this.capturePdf) this.takeDownload(e.data.detail);
		});
		on("download-failed", () => {
			this.activeDownloads = Math.max(0, this.activeDownloads - 1);
			this.touch();
		});
	}

	private touch() {
		this.lastEventAt = Date.now();
		this.onChange();
	}

	private setUrl(u: string) {
		if (!isHttp(u)) return; // about:blank, data:, blob: etc. are not part of the trail
		this.navSeen = true;
		if (u !== this.url) {
			this.url = u;
			if (this.trail[this.trail.length - 1] !== u) this.trail.push(u);
		}
		this.touch();
	}

	reset() {
		this.url = "";
		this.trail = [];
		this.loaded = false;
		this.navSeen = false;
		this.pdf = null;
		this.probed.clear();
		this.touch();
	}

	/** A download finished: the detail carries a path and/or filename (shape differs by platform). */
	private takeDownload(detail: unknown) {
		const d = (typeof detail === "object" && detail ? detail : {}) as Record<string, unknown>;
		if (process.env.ZN_SIGNIN_SELFTEST === "1") console.log("[signin] download-completed keys:", Object.keys(d).join(","));
		const cand: string[] = [];
		for (const k of ["path", "filePath", "savedPath", "filename", "fileName"]) {
			const v = d[k];
			if (typeof v === "string" && v) cand.push(v);
		}
		for (const c of cand) {
			const p = isAbsolute(c) ? c : join(Utils.paths.downloads, c);
			try {
				const bytes = new Uint8Array(readFileSync(p));
				if (!hasPdfMagic(bytes)) continue;
				try {
					rmSync(p, { force: true });
				} catch {}
				this.pdf = { bytes, url: this.url, filename: filenameOf(String(d["url"] ?? this.url)) ?? c.split(/[\\/]/).pop() };
				this.touch();
				return;
			} catch {}
		}
	}

	/** document.cookie of the page (script-visible cookies only; HttpOnly ones are invisible to script). */
	docCookie(): Promise<string> {
		const id = ++this.seq;
		return new Promise((resolve) => {
			const t = setTimeout(() => {
				this.pending.delete(id);
				resolve("");
			}, 3000);
			this.pending.set(id, (h) => {
				clearTimeout(t);
				resolve(h);
			});
			this.view.executeJavascript(
				`try{window.__electrobunSendToHost({zn:${JSON.stringify(this.key)},id:${id},html:document.cookie})}` +
					`catch(e){window.__electrobunSendToHost({zn:${JSON.stringify(this.key)},id:${id},html:''})}`,
			);
		});
	}

	html(maxChars: number): Promise<string> {
		const id = ++this.seq;
		const max = Math.max(0, Math.min(maxChars, MAX_PAGE_HTML));
		return new Promise((resolve) => {
			const t = setTimeout(() => {
				this.pending.delete(id);
				resolve("");
			}, 2000);
			this.pending.set(id, (h) => {
				clearTimeout(t);
				resolve(h);
			});
			// Strip typed/prefilled values: nothing about form fields leaves the page.
			this.view.executeJavascript(
				`try{var c=document.documentElement.cloneNode(true);` +
					`c.querySelectorAll('input,textarea').forEach(function(i){i.removeAttribute('value')});` +
					`window.__electrobunSendToHost({zn:${JSON.stringify(this.key)},id:${id},html:c.outerHTML.slice(0,${max})})}` +
					`catch(e){window.__electrobunSendToHost({zn:${JSON.stringify(this.key)},id:${id},html:''})}`,
			);
		});
	}

	/** Fallback for PDFs shown in the engine's PDF viewer (no download event): fetch with the session cookies. */
	async probePdf(url: string): Promise<Pdf | null> {
		if (!isHttp(url)) return null;
		try {
			const cs = await cookiesFor(url);
			const res = await fetch(url, {
				redirect: "follow",
				headers: {
					"User-Agent": this.userAgent || FALLBACK_UA,
					Accept: "application/pdf,*/*;q=0.8",
					...(cs.length ? { Cookie: cookieHeader(cs, url) } : {}),
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
			if (process.env.ZN_SIGNIN_SELFTEST === "1") console.log("[signin] pdf via cookie fetch probe");
			return { bytes, url: res.url || url, filename: filenameOf(res.url || url) };
		} catch {
			return null;
		}
	}

	private async maybeProbe() {
		if (!this.capturePdf || this.pdf || !pdfish(this.url) || this.probed.has(this.url)) return;
		this.probed.add(this.url);
		const p = await this.probePdf(this.url);
		if (p && !this.pdf) {
			this.pdf = p;
			this.touch();
		}
	}

	dispose() {
		for (const off of this.offs) off();
		this.offs = [];
		for (const r of this.pending.values()) r("");
		this.pending.clear();
	}
}

// ---------------------------------------------------------------------------------------------
// Visible sign-in window
// ---------------------------------------------------------------------------------------------

interface BannerState {
	institution: string;
	waiting: number;
	status: string;
	offerKeepWaiting: boolean;
	challengeHint: boolean;
	standby: boolean;
	host: string;
	scheme: string;
	secure: boolean;
}

interface SessionState {
	req: LoginRequest;
	actions: LoginUserAction[];
	closed: boolean;
	finished: boolean;
	waiters: Set<() => void>;
}

function esc(s: string): string {
	return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function bannerHtml(entryUrl: string, key: string, init: BannerState): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title><style>
:root{color-scheme:light dark;--bg:#f4f5f7;--fg:#1d2330;--mut:#5b6475;--ok:#0b7a3b;--bad:#b3261e;--line:#c9ced8;--btn:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#1b1f29;--fg:#e8ebf2;--mut:#9aa3b5;--ok:#5fd18a;--bad:#ff8a80;--line:#394055;--btn:#262c3a}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:13px system-ui,Segoe UI,sans-serif}
body{display:flex;flex-direction:column}
#bar{flex:none;padding:8px 12px;border-bottom:1px solid var(--line);display:grid;grid-template-columns:1fr auto;gap:4px 12px;align-items:center}
#sec{display:flex;align-items:center;gap:8px;min-width:0}
#pill{font-weight:600;padding:1px 8px;border-radius:10px;border:1px solid currentColor;white-space:nowrap}
#pill.ok{color:var(--ok)}#pill.bad{color:var(--bad)}
#origin{font:600 15px ui-monospace,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#sub{grid-column:1;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#hint{grid-column:1/-1;color:var(--fg);background:rgba(220,160,0,.18);padding:3px 8px;border-radius:4px}
#btns{grid-row:1/3;grid-column:2;display:flex;gap:6px}
button{font:inherit;padding:4px 10px;border:1px solid var(--line);background:var(--btn);color:var(--fg);border-radius:5px;cursor:pointer}
button:hover{border-color:var(--fg)}
electrobun-webview{display:block;flex:1;min-height:0;width:100%}
</style></head><body>
<div id="bar">
<div id="sec"><span id="pill" class="bad">...</span><span id="origin"></span></div>
<div id="btns"><button id="keep" hidden>Keep waiting</button><button id="handoff">Open in browser</button><button id="skip">Skip</button></div>
<div id="sub"></div><div id="hint" hidden>This page may need a human check (captcha or multi-factor prompt). Complete it in this window.</div>
</div>
<electrobun-webview src="${esc(entryUrl)}" partition="${INSTITUTION_PARTITION}" sandbox></electrobun-webview>
<script>
var KEY=${JSON.stringify(key)};
function send(m){m.zn=KEY;try{window.__electrobunSendToHost(m)}catch(e){}}
window.__znUpdate=function(s){
 var p=document.getElementById('pill');
 if(!s.host){p.textContent='Loading';p.className='bad'}
 else if(s.secure){p.textContent='Secure (https)';p.className='ok'}
 else{p.textContent='Not secure ('+s.scheme+')';p.className='bad'}
 document.getElementById('origin').textContent=s.host?s.scheme+'://'+s.host:'';
 var n=s.waiting;
 document.getElementById('sub').textContent=s.standby?'Checking access...':('Signing in to '+s.institution+(n>0?' for '+n+(n===1?' item':' items'):'')+(s.status?' - '+s.status:''));
 document.getElementById('keep').hidden=!s.offerKeepWaiting||s.standby;
 document.getElementById('hint').hidden=!s.challengeHint||s.standby;
 document.getElementById('skip').hidden=s.standby;document.getElementById('handoff').hidden=s.standby;
};
document.getElementById('skip').onclick=function(){send({action:'skip'})};
document.getElementById('handoff').onclick=function(){send({action:'handoff'})};
document.getElementById('keep').onclick=function(){send({action:'keep_waiting'})};
window.__znUpdate(${JSON.stringify(init).replace(/</g, "\\u003c")});
send({ready:true});
</script></body></html>`;
}

class LoginWindow {
	readonly key = nonce();
	win: BrowserWindow;
	site: BrowserView | null = null;
	tracker: SiteTracker | null = null;
	closed = false;
	s: SessionState;
	banner: BannerState;
	private standbyTimer: ReturnType<typeof setTimeout> | null = null;
	private offs: Array<() => void> = [];
	private offCreated: () => void;
	private pendingLoad: string | null = null;

	constructor(req: LoginRequest, hidden: boolean, readonly onGone: () => void) {
		this.s = this.newState(req);
		this.banner = this.initialBanner(req);
		this.win = new BrowserWindow({
			title: `Sign in - ${this.banner.institution}`,
			html: bannerHtml(req.entryUrl, this.key, this.banner),
			frame: { width: 1000, height: 760 },
			hidden,
		});
		const wid = this.win.webviewId;
		this.offCreated = BrowserView.on("created", (v) => {
			if (v.hostWebviewId !== wid || this.site) return;
			this.site = v;
			this.tracker = new SiteTracker(v, this.key, req.capturePdf, () => this.onTrackerChange(), undefined);
			if (this.pendingLoad) {
				v.loadURL(this.pendingLoad);
				this.pendingLoad = null;
			}
		});
		const bn = `host-message-${wid}`;
		const bh = (e: Ev) => this.onBannerMessage(e.data.detail);
		events.on(bn, bh);
		this.offs.push(() => events.off(bn, bh));
		const cn = `close-${this.win.id}`;
		const ch = () => this.onWindowClosed();
		events.on(cn, ch);
		this.offs.push(() => events.off(cn, ch));
	}

	private newState(req: LoginRequest): SessionState {
		return { req, actions: [], closed: false, finished: false, waiters: new Set() };
	}

	private initialBanner(req: LoginRequest): BannerState {
		const inst = (req as LoginRequest & { institutionName?: string }).institutionName || req.realm;
		return {
			institution: inst,
			waiting: req.waiting,
			status: "",
			offerKeepWaiting: false,
			challengeHint: false,
			standby: false,
			host: "",
			scheme: "",
			secure: false,
		};
	}

	/** Reuse the parked window for a new request (generic: any realm). */
	reuse(req: LoginRequest) {
		if (this.standbyTimer) clearTimeout(this.standbyTimer);
		this.standbyTimer = null;
		this.s = this.newState(req);
		this.banner = { ...this.initialBanner(req), host: "", scheme: "", secure: false };
		this.win.setTitle(`Sign in - ${this.banner.institution}`);
		this.tracker?.reset();
		if (this.tracker) this.tracker.capturePdf = req.capturePdf;
		this.pushBanner();
		if (this.site) this.site.loadURL(req.entryUrl);
		else this.pendingLoad = req.entryUrl;
	}

	notify() {
		const w = [...this.s.waiters];
		this.s.waiters.clear();
		for (const f of w) f();
	}

	private onTrackerChange() {
		const u = this.tracker?.url ?? "";
		let host = "";
		let scheme = "";
		try {
			const p = new URL(u);
			host = p.host;
			scheme = p.protocol.replace(":", "");
		} catch {}
		if (host !== this.banner.host || scheme !== this.banner.scheme) {
			this.banner.host = host;
			this.banner.scheme = scheme;
			this.banner.secure = scheme === "https";
			this.pushBanner();
		}
		this.notify();
	}

	pushBanner() {
		if (this.closed) return;
		try {
			this.win.webview.executeJavascript(
				`window.__znUpdate&&window.__znUpdate(${JSON.stringify(this.banner).replace(/</g, "\\u003c")})`,
			);
		} catch {}
	}

	/** Same path the on-screen buttons use. */
	handleAction(a: string) {
		if (a !== "skip" && a !== "handoff" && a !== "keep_waiting") return;
		if (a === "handoff") {
			const u = this.tracker?.url || this.s.req.entryUrl;
			if (isHttp(u)) Utils.openExternal(u);
		}
		this.s.actions.push(a);
		this.notify();
	}

	private onBannerMessage(d: unknown) {
		const m = d as { zn?: string; action?: string; ready?: boolean } | null;
		if (!m || typeof m !== "object" || m.zn !== this.key) return;
		if (m.ready) this.pushBanner();
		else if (m.action) this.handleAction(m.action);
	}

	private onWindowClosed() {
		this.closed = true;
		this.s.closed = true;
		if (this.standbyTimer) clearTimeout(this.standbyTimer);
		this.dispose();
		this.notify();
		this.onGone();
	}

	private dispose() {
		this.offCreated();
		for (const off of this.offs) off();
		this.offs = [];
		this.tracker?.dispose();
	}

	close() {
		if (this.closed) return;
		try {
			this.win.close();
		} catch {}
		// The native close event normally drives onWindowClosed; make sure we end up closed regardless.
		if (!this.closed) this.onWindowClosed();
	}

	session(): LoginSession {
		const st = this.s;
		const self = this;
		return {
			url: () => self.tracker?.url ?? "",
			html: async (max) => (self.tracker && !self.closed ? self.tracker.html(max) : ""),
			takeActions: () => st.actions.splice(0),
			closed: () => st.closed,
			capturedPdf: () => self.tracker?.pdf ?? null,
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
			},
		};
	}
}

// ---------------------------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------------------------

export interface SigninBridge extends BrowserBridge {
	/** Test hook: press a banner button ("skip" | "handoff" | "keep_waiting") exactly as the UI does. */
	simulateBannerAction(a: LoginUserAction): void;
	/** Test hook: state shown on the banner and window id of the sign-in window. */
	debugState(): { banner: BannerState; windowId: number; ua: string } | null;
}

export function createSigninBridge(): SigninBridge {
	let login: LoginWindow | null = null;
	const loadWindows = new Set<{ close(): void }>();

	return {
		async openLogin(req, signal) {
			if (!isHttp(req.entryUrl)) throw new Error("entryUrl must be http(s)");
			if (signal.aborted) throw new Error("aborted");
			if (login && !login.closed) {
				if (!login.s.finished) throw new Error(`a sign-in window is already open (realm ${login.s.req.realm})`);
				login.reuse(req);
			} else {
				const hidden = process.env.ZN_SIGNIN_HIDDEN === "1"; // test-only override
				const lw: LoginWindow = new LoginWindow(req, hidden, () => {
					if (login === lw) login = null;
				});
				login = lw;
			}
			const lw = login;
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
			const t0 = Date.now();
			const handle = openHidden(req.url, req.capturePdf);
			const tracker = handle.tracker;
			loadWindows.add(handle);
			try {
				const quietMs = req.capturePdf ? 2500 : 1500;
				for (;;) {
					if (signal.aborted) throw new Error("aborted");
					const now = Date.now();
					if (now - t0 >= req.timeoutMs) break;
					if (tracker.pdf) break;
					const quiet = now - tracker.lastEventAt;
					if ((tracker.loaded || tracker.navSeen) && tracker.activeDownloads === 0 && quiet >= quietMs) break;
					await Bun.sleep(100);
				}
				let pdf = tracker.pdf;
				let pageHtml: string | undefined;
				if (!pdf) {
					const h = await tracker.html(MAX_PAGE_HTML);
					if (h) pageHtml = h;
					if (req.capturePdf && tracker.url) {
						const looksPdf = pdfish(tracker.url) || !h || /type=["']application\/pdf/i.test(h);
						if (looksPdf) pdf = tracker.pdf ?? (await tracker.probePdf(tracker.url));
					}
				}
				const finalUrl = tracker.url || req.url;
				const trail = tracker.trail.length ? [...tracker.trail] : [req.url];
				return {
					finalUrl,
					status: tracker.loaded || tracker.navSeen ? 200 : 0,
					urlTrail: trail,
					...(pdf ? { pdf } : pageHtml !== undefined ? { pageHtml } : {}),
					ms: Date.now() - t0,
				};
			} finally {
				handle.close();
				loadWindows.delete(handle);
			}
		},

		cookiesFor,

		closeAll() {
			login?.close();
			for (const h of [...loadWindows]) h.close();
			loadWindows.clear();
		},

		simulateBannerAction(a) {
			login?.handleAction(a);
		},

		debugState() {
			return login
				? { banner: { ...login.banner }, windowId: login.win.id, ua: login.tracker?.userAgent ?? "" }
				: null;
		},
	};
}
