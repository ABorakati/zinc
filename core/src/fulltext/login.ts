// The institutional sign-in controller (Effect::LoginWindow / LoginUpdate and the "Sign in to <institution>" warm-up).
// Port of plugin/content/login-controller.js of zotero-fulltext onto the BrowserBridge contract (./browser-bridge.ts):
// the app owns the window, core owns the decision. Each poll asks the bridge for url + page HTML, asks the engine's pure
// fx_login_state what the page is, and decide() (a verbatim port) says whether the sign-in is over.
//
// SINGLE-FLIGHT: one visible window at a time. A second login request (any realm) waits for the open one to end and
// then opens its own session, which the bridge serves from the parked ("standby") window; a warm-up request while
// a window is open joins it and returns its result. The engine emits one LoginWindow per sign-in epoch and sends
// LoginUpdate{waiting} as more items queue up; update() forwards that count to the window.
// Nothing here reads cookies, form fields or credentials; logs carry host + path only.

import { writeFileSync } from "node:fs";
import type { BodyStore } from "./bodies";
import { stageFile } from "./bodies";
import type { BrowserBridge, LoginSession, LoginUserAction } from "./browser-bridge";
import { OpError } from "./http";
import type { Inspection, InspectMeta, LoginOk, LoginReq, LoginResult, LoginState } from "./proto";

export const POLL_MS = 500;
/** Fraction of timeoutMs after which "Keep waiting" is offered. */
export const KEEP_WAITING_AT = 0.75;
export const HTML_CAP = 256 * 1024;
export const LINGER_MS = 1500;
export const STANDBY_MS = 120000;
export const DEFAULT_TIMEOUT_MS = 300000;
/** A reused window's old page is ignored by the classifier for at most this long after the session started. */
export const STALE_URL_MS = 20000;
/** A sign-in counts as current for this long. */
export const SIGNED_IN_MS = 12 * 60 * 60 * 1000;

// ---------------------------------------------------------------- pure decision

export interface DecideInput {
	state: LoginState | string | null | undefined;
	elapsedMs: number;
	timeoutMs: number;
	extended: boolean;
	windowClosed: boolean;
	userAction: LoginUserAction | null;
	pdfCaptured: boolean;
}

export interface Decision {
	done: null | "landed" | "pdf" | "closed_by_user" | "handoff" | "timeout" | "ca_blocked";
	caError?: string | null;
	extend?: boolean;
	offerKeepWaiting?: boolean;
	showChallengeHint?: boolean;
}

/**
 * Pure poll decision. Priority: pdfCaptured > windowClosed/skip > handoff > refused > landed > timeout (after at most
 * one "keep waiting" extension). While not done, showChallengeHint and offerKeepWaiting are independent advice flags.
 */
export function decide(s: DecideInput): Decision {
	const st = typeof s.state === "string" ? s.state : s.state?.state;
	const code = s.state && typeof s.state === "object" ? s.state.code : null;
	const elapsed = Number(s.elapsedMs) || 0;
	const timeout = Number(s.timeoutMs) || 0;
	if (s.pdfCaptured) return { done: "pdf" };
	if (s.windowClosed || s.userAction === "skip") return { done: "closed_by_user" };
	if (s.userAction === "handoff") return { done: "handoff" };
	if (st === "refused") return { done: "ca_blocked", caError: code == null || code === "" ? null : String(code) };
	if (st === "landed") return { done: "landed" };
	if (timeout > 0 && elapsed >= timeout) {
		if (!s.extended && s.userAction === "keep_waiting") return { done: null, extend: true };
		return { done: "timeout" };
	}
	const out: Decision = { done: null };
	if (st === "challenge_shown") out.showChallengeHint = true;
	if (!s.extended && timeout > 0 && elapsed >= KEEP_WAITING_AT * timeout) out.offerKeepWaiting = true;
	return out;
}

// ---------------------------------------------------------------- helpers

/** scheme://host/path without userinfo, query or fragment ('' when it is not an http(s) URL). */
export function stripUrl(url: string): string {
	try {
		const u = new URL(String(url));
		return u.protocol === "http:" || u.protocol === "https:" ? `${u.protocol}//${u.host}${u.pathname}` : "";
	} catch {
		return "";
	}
}

function isHttpUrl(url: unknown): url is string {
	if (typeof url !== "string" || url.length === 0 || url.length > 8192) return false;
	try {
		const u = new URL(url);
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (ms <= 0 || signal.aborted) return resolve();
		const t = setTimeout(done, ms);
		function done() {
			clearTimeout(t);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

function cancelled(signal: AbortSignal): OpError {
	return new OpError("cancelled", String(signal.reason ?? "cancelled"));
}

// ---------------------------------------------------------------- controller

export interface LoginDeps {
	bridge: () => BrowserBridge | null;
	wasm: { loginState(a: { url: string; html?: string }): LoginState; inspect(meta: InspectMeta, body: Uint8Array): Inspection };
	bodies: BodyStore;
	/** monotonic ms (test seam) */
	now?: () => number;
	pollMs?: number;
	lingerMs?: number;
	standbyMs?: number;
	/** "Open in browser": the user's own browser gets the entry URL. When absent the item ends with the hand-off link. */
	openExternal?: (url: string) => void;
	/** Display name of the configured institution, for the window's banner (LoginRequest.institutionName). */
	institutionName?: () => string;
	onLog?: (level: string, msg: string) => void;
}

interface Outcome {
	result: LoginResult;
	finalUrl: string;
	caError: string | null;
	html: string;
	pdf: { bytes: Uint8Array; url: string; filename?: string } | null;
}

export interface SignInResult {
	result: LoginResult | "unavailable";
	finalUrl: string;
	caError?: string;
}

interface DriveParams {
	entryUrl: string;
	realm: string;
	kind: string;
	itemTitle?: string;
	waiting: number;
	timeoutMs: number;
	capturePdf: boolean;
	warm: boolean;
}

interface Ctl {
	setWaiting: (n: number) => void;
}

interface Busy {
	realm: string;
	done: Promise<SignInResult>;
	setWaiting(n: number): void;
}

const closedOutcome = (): Outcome => ({ result: "closed_by_user", finalUrl: "", caError: null, html: "", pdf: null });

export class LoginController {
	private busy: Busy | null = null;
	/** wall-clock time of the last sign-in that reached a publisher page (or a PDF) */
	signedInAt = 0;

	constructor(private deps: LoginDeps) {}

	private log(level: string, msg: string): void {
		if (this.deps.onLog) this.deps.onLog(level, msg);
		else if (level === "warn" || level === "error") console.warn(`fulltext: ${msg}`);
	}

	private now(): number {
		return this.deps.now ? this.deps.now() : performance.now();
	}

	/** A sign-in reached a publisher page (or a PDF) within the last 12 hours. */
	signedIn(): boolean {
		return this.signedInAt > 0 && Date.now() - this.signedInAt < SIGNED_IN_MS;
	}

	/** Something showed that the embedded browser's session gives access (a PDF arrived through it). */
	markSignedIn(): void {
		this.signedInAt = Date.now();
	}

	/** A sign-in window is open right now. */
	get active(): boolean {
		return this.busy !== null;
	}

	/** Effect::LoginUpdate: change the "N items waiting" label of the open window. No-op when none is open. */
	update(waiting: number): void {
		this.busy?.setWaiting(Math.max(0, Math.trunc(waiting) || 0));
	}

	/**
	 * Effect::LoginWindow. Resolves with proto.rs LoginOk; rejects OpError("cancelled") when the signal aborts
	 * (the window is closed first). Without a bridge it answers "handoff" like a host without an embedded browser.
	 */
	async open(run: number, req: LoginReq, signal: AbortSignal): Promise<LoginOk> {
		const bridge = this.deps.bridge();
		if (!bridge) return { result: "handoff", final_url: req.entry_url, inspect: { expect: "none" } };
		if (!isHttpUrl(req.entry_url)) {
			// the sign-in page must be a web address; anything else never reaches a browser
			this.log("error", "login: entry URL is not http(s), nothing opened");
			return { result: "closed_by_user", final_url: "", inspect: { expect: "none" } };
		}
		// wait for the open window to end; the check and the claim below must not be separated by an await
		while (this.busy) {
			if (signal.aborted) throw cancelled(signal);
			const aborted = new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
			await Promise.race([this.busy.done.catch(() => {}), aborted]);
		}
		if (signal.aborted) throw cancelled(signal);
		const params: DriveParams = {
			entryUrl: req.entry_url,
			realm: String(req.realm),
			kind: String(req.kind || "login"),
			itemTitle: req.item_title ? String(req.item_title) : undefined,
			waiting: Number(req.waiting) || 0,
			timeoutMs: Number(req.timeout_ms) > 0 ? Number(req.timeout_ms) : DEFAULT_TIMEOUT_MS,
			capturePdf: !!req.capture_pdf,
			warm: false,
		};
		const held: { o: Outcome | null } = { o: null };
		const ctl: Ctl = { setWaiting: () => {} };
		const done = this.claim(params.realm, ctl, () =>
			this.drive(bridge, params, signal, ctl).then((o) => {
				held.o = o;
				return summary(o);
			}),
		);
		try {
			await done;
		} catch (e) {
			if (signal.aborted) throw cancelled(signal);
			throw e;
		}
		return this.buildLoginOk(run, held.o ?? closedOutcome());
	}

	/**
	 * The "Sign in to <institution>" warm-up: the same window at `url`, no PDF capture, no item. Joins a window that is
	 * already open. Resolves with the result; "unavailable" when the app has no embedded browser.
	 */
	async warmUp(url: string, realm: string, timeoutMs: number, signal: AbortSignal): Promise<SignInResult> {
		const bridge = this.deps.bridge();
		if (!bridge) return { result: "unavailable", finalUrl: "" };
		if (this.busy) return this.busy.done;
		if (!isHttpUrl(url)) return { result: "closed_by_user", finalUrl: "" };
		const params: DriveParams = {
			entryUrl: url, realm, kind: "warmup", waiting: 0, timeoutMs: timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS, capturePdf: false, warm: true,
		};
		const ctl: Ctl = { setWaiting: () => {} };
		return this.claim(params.realm, ctl, () => this.drive(bridge, params, signal, ctl).then(summary));
	}

	/** Close every sign-in window (the app is quitting, the service is disposed). */
	closeAll(): void {
		this.deps.bridge()?.closeAll();
	}

	// ------------------------------------------------------------ single flight

	private claim(realm: string, ctl: Ctl, start: () => Promise<SignInResult>): Promise<SignInResult> {
		const done = start();
		const busy: Busy = { realm, done, setWaiting: (n) => ctl.setWaiting(n) };
		this.busy = busy;
		const clear = () => {
			if (this.busy === busy) this.busy = null;
		};
		done.then(clear, clear);
		return done;
	}

	// ------------------------------------------------------------ one window

	private async drive(bridge: BrowserBridge, p: DriveParams, signal: AbortSignal, ctl: Ctl): Promise<Outcome> {
		const pollMs = this.deps.pollMs ?? POLL_MS;
		let waiting = p.waiting;
		let session: LoginSession;
		try {
			// institutionName is read by the app at runtime; the BrowserBridge contract has no field for it yet
			const institutionName = this.deps.institutionName?.();
			session = await bridge.openLogin(
				{ entryUrl: p.entryUrl, realm: p.realm, kind: p.kind, itemTitle: p.itemTitle, waiting, capturePdf: p.capturePdf, ...(institutionName ? { institutionName } : {}) },
				signal,
			);
		} catch (e) {
			if (signal.aborted) throw cancelled(signal);
			this.log("error", `login: window could not be opened: ${e instanceof Error ? e.message : e}`);
			return closedOutcome();
		}
		this.log("info", `login: window open at ${stripUrl(p.entryUrl) || "(url)"} (realm ${p.realm}, ${p.kind})`);

		let hint = p.kind === "challenge";
		let keep = false;
		let extended = false;
		let timeoutMs = p.timeoutMs;
		let userAction: LoginUserAction | null = null;
		let sawState = false;
		const banner = (patch: { waiting?: number; offerKeepWaiting?: boolean; challengeHint?: boolean; status?: string }) => {
			try {
				session.setBanner(patch);
			} catch (e) {
				this.log("warn", `login: banner failed: ${e instanceof Error ? e.message : e}`);
			}
		};
		ctl.setWaiting = (n) => {
			waiting = n;
			banner({ waiting: n });
			try {
				bridge.updateWaiting(p.realm, n);
			} catch {
				/* the window is gone */
			}
		};
		banner({ waiting, challengeHint: hint, offerKeepWaiting: false });

		// A reused window may still show the previous route's page until the new load commits: not classified for a while.
		const shown = session.url();
		let staleUrl = shown && shown !== "about:blank" ? shown : "";
		const t0 = this.now();
		let outcome: Outcome | null = null;
		let aborted = false;
		try {
			for (;;) {
				if (signal.aborted) {
					aborted = true;
					throw cancelled(signal);
				}
				await session.waitForChange(pollMs);
				if (signal.aborted) {
					aborted = true;
					throw cancelled(signal);
				}
				const drain = () => {
					for (const a of session.takeActions()) {
						if (a === "skip" || a === "handoff") userAction = a;
						else if (userAction !== "skip" && userAction !== "handoff") userAction = a;
					}
				};
				const flags = () => ({
					windowClosed: session.closed(),
					pdfCaptured: p.capturePdf && !p.warm && session.capturedPdf() !== null,
					userAction,
				});
				// 1. local facts only: a button, the closed window or a captured PDF never wait for the page round trip
				drain();
				const pre = decide({ state: { state: "pending" }, elapsedMs: this.now() - t0, timeoutMs, extended, ...flags() });
				if (pre.done === "pdf" || pre.done === "closed_by_user" || pre.done === "handoff") {
					outcome = { ...closedOutcome(), result: pre.done, finalUrl: session.url() };
					break;
				}
				// 2. the page: url + html -> wasm login state
				const url = session.url();
				if (staleUrl && (url !== staleUrl || this.now() - t0 >= STALE_URL_MS)) staleUrl = "";
				let html = "";
				let state: LoginState = { state: "pending" };
				if (!staleUrl && url && url !== "about:blank") {
					try {
						html = (await session.html(HTML_CAP)).slice(0, HTML_CAP);
					} catch {
						html = "";
					}
					try {
						state = this.deps.wasm.loginState({ url, html });
					} catch {
						state = { state: "pending" };
					}
				}
				if (state.state !== "pending") sawState = true;
				// 3. decide with fresh flags (events may have arrived while we awaited)
				drain();
				const r = decide({ state, elapsedMs: this.now() - t0, timeoutMs, extended, ...flags() });
				if (r.extend) {
					extended = true;
					timeoutMs *= 2;
					userAction = null;
					keep = false;
					banner({ offerKeepWaiting: false, challengeHint: state.state === "challenge_shown" });
					hint = state.state === "challenge_shown";
					continue;
				}
				if (r.done) {
					outcome = { result: r.done, finalUrl: url, caError: r.caError ?? null, html: r.done === "landed" ? html : "", pdf: null };
					break;
				}
				// until the classifier has said anything, a challenge window keeps the hint it opened with
				if (p.kind === "challenge" && !sawState) r.showChallengeHint = true;
				const nh = !!r.showChallengeHint;
				const nk = !!r.offerKeepWaiting;
				if (nh !== hint || nk !== keep) {
					hint = nh;
					keep = nk;
					banner({ challengeHint: nh, offerKeepWaiting: nk });
				}
			}

			if (outcome.result === "handoff") {
				try {
					this.deps.openExternal?.(new URL(p.entryUrl).href);
				} catch (e) {
					this.log("error", `login: could not launch the browser: ${e instanceof Error ? e.message : e}`);
				}
			}
			if (outcome.result === "pdf") {
				outcome.pdf = session.capturedPdf();
				outcome.finalUrl = outcome.pdf?.url || outcome.finalUrl;
			}
			if ((outcome.result === "ca_blocked" || (p.warm && outcome.result === "landed")) && !session.closed()) {
				if (outcome.result === "ca_blocked") banner({ status: `Sign-in was refused by your institution (${outcome.caError ?? "unknown"})` });
				await sleep(this.deps.lingerMs ?? LINGER_MS, signal);
				if (signal.aborted) {
					aborted = true;
					throw cancelled(signal);
				}
			}
			return outcome;
		} finally {
			const landed = outcome?.result === "landed" || outcome?.result === "pdf";
			if (landed) this.signedInAt = Date.now();
			// a finished route keeps its window for the next one (the bridge parks it); every other ending closes it
			const park = !p.warm && landed && !aborted && !session.closed();
			try {
				session.finish(park ? "standby" : "close", park ? (this.deps.standbyMs ?? STANDBY_MS) : undefined);
			} catch {
				/* the window is gone */
			}
		}
	}

	// ------------------------------------------------------------ results

	private async buildLoginOk(run: number, o: Outcome): Promise<LoginOk> {
		const { bodies, wasm } = this.deps;
		const full = o.result === "landed" || o.result === "pdf";
		const ok: LoginOk = { result: o.result, final_url: full ? o.finalUrl : stripUrl(o.finalUrl), inspect: { expect: "none" } };
		if (o.result === "ca_blocked" && o.caError != null) ok.ca_error = o.caError;

		if (o.result === "landed" && o.html) {
			const bytes = new TextEncoder().encode(o.html);
			try {
				ok.page = bodies.putMemory(bytes, run);
			} catch (e) {
				this.log("warn", `login: could not keep the landing page: ${e instanceof Error ? e.message : e}`);
			}
			if (ok.page) {
				ok.inspect = wasm.inspect(
					{
						spec: { expect: "page", requested: {}, route: "inst" },
						resp: { status: 200, final_url: o.finalUrl, headers: { "content-type": "text/html" }, body_len: bytes.length },
					},
					bytes,
				);
			}
		} else if (o.result === "pdf") {
			if (!o.pdf) throw new OpError("internal", "login: the captured PDF is gone");
			const slot = bodies.allocSlot();
			try {
				writeFileSync(slot.path, o.pdf.bytes);
				const staged = stageFile(slot.path, o.pdf.bytes.length);
				ok.pdf = bodies.putFile({ path: slot.path, dir: slot.dir, len: staged.body_len, run });
				const resp: InspectMeta["resp"] = {
					status: 200,
					final_url: o.finalUrl,
					headers: { "content-type": "application/pdf" },
					body_len: staged.body_len,
					truncated: staged.truncated,
				};
				if (staged.head_len != null) resp.head_len = staged.head_len;
				ok.inspect = wasm.inspect({ spec: { expect: "pdf", requested: {}, route: "inst" }, resp }, staged.bytes);
			} catch (e) {
				bodies.discardSlot(slot);
				if (ok.pdf) {
					bodies.release(ok.pdf.handle);
					delete ok.pdf;
				}
				throw e instanceof OpError ? e : new OpError("io", `login: could not store the captured PDF: ${e instanceof Error ? e.message : e}`);
			}
		}
		return ok;
	}
}

function summary(o: Outcome): SignInResult {
	return { result: o.result, finalUrl: o.result === "landed" || o.result === "pdf" ? stripUrl(o.finalUrl) : "", ...(o.caError ? { caError: o.caError } : {}) };
}
