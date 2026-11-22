// HTTP for Effect::Http: Bun fetch with manual redirects, a cookie jar, byte caps, timeouts and a file sink for PDFs.
// One call = one logical round trip, no retries (the engine decides), no interpretation of the response (the
// wasm inspector does that). Port of plugin/content/net.js.

import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { HttpReq, OpErr } from "./proto";

/** Response headers copied into HttpOk.headers (lower-case). set-cookie is deliberately absent. */
const RESPONSE_HEADERS = [
	"content-type",
	"content-length",
	"content-disposition",
	"content-encoding",
	"location",
	"retry-after",
	"server",
	"cf-mitigated",
	"cf-ray",
	"akamai-grn",
	"refresh",
	"link",
	"x-ratelimit-remaining",
	"www-authenticate",
	"last-modified",
	"etag",
];
const DROPPED_REQUEST_HEADERS = ["host", "content-length", "cookie", "connection", "accept-encoding"];
const HEADER_VALUE_MAX = 512;
export const INSPECT_TEXT_MAX = 2 * 1024 * 1024;
const MAX_REDIRECTS = 10;

const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";
export const UA_PLAIN = FIREFOX;
export const UA_DEFAULT = `${FIREFOX} zinc/0.1`;

/** An error that maps onto proto.rs OpErr. */
export class OpError extends Error {
	constructor(
		public kind: OpErr["kind"],
		message = "",
		public extra: { status?: number; after_ms?: number } = {},
	) {
		super(message || kind);
		this.name = "OpError";
	}
	toOpErr(): OpErr {
		return { kind: this.kind, message: this.message, ...this.extra };
	}
}

// ---------------------------------------------------------------- cookies

interface Cookie {
	name: string;
	value: string;
	domain: string;
	hostOnly: boolean;
	path: string;
	secure: boolean;
	expires: number | null;
	/** copied from the embedded browser's sign-in session (BrowserBridge.cookiesFor) and not set by an engine response since */
	fromBridge?: boolean;
}

/** A cookie of the embedded browser (browser-bridge.ts BridgeCookie, the fields the jar reads). */
export interface ForeignCookie {
	name: string;
	value: string;
	domain: string; // leading "." = domain cookie
	path: string;
	secure: boolean;
	expires?: number; // seconds since epoch; absent = session cookie
}

export class CookieJar {
	private cookies: Cookie[] = [];

	/**
	 * Merge the embedded browser's cookies. Domain ".x.org" = domain cookie (x.org and subdomains), "x.org" = host-only;
	 * path / secure / expiry are kept (expired ones dropped, secure ones are only sent over https by header()).
	 * An existing cookie with the same name, domain and path is replaced when it came from the browser itself or when
	 * `force` is set; one that an engine response set later wins (it is newer than the browser's copy).
	 * Values are never logged. Returns how many cookies were added or replaced.
	 */
	merge(foreign: ForeignCookie[], force = false): number {
		const now = Date.now();
		let n = 0;
		for (const f of foreign) {
			if (!f || typeof f.name !== "string" || !f.name || typeof f.value !== "string" || typeof f.domain !== "string") continue;
			const hostOnly = !f.domain.startsWith(".");
			const domain = f.domain.replace(/^\./, "").toLowerCase();
			if (!domain) continue;
			const expires = typeof f.expires === "number" && Number.isFinite(f.expires) ? f.expires * 1000 : null;
			if (expires !== null && expires <= now) continue;
			const path = typeof f.path === "string" && f.path.startsWith("/") ? f.path : "/";
			const c: Cookie = { name: f.name, value: f.value, domain, hostOnly, path, secure: !!f.secure, expires, fromBridge: true };
			const i = this.cookies.findIndex((o) => o.name === c.name && o.domain === c.domain && o.path === c.path);
			if (i >= 0) {
				if (!force && !this.cookies[i].fromBridge) continue;
				this.cookies[i] = c;
			} else this.cookies.push(c);
			n++;
		}
		return n;
	}

	size(): number {
		return this.cookies.length;
	}

	store(url: string, setCookies: string[]): void {
		const u = new URL(url);
		for (const raw of setCookies) {
			const parts = raw.split(";").map((s) => s.trim());
			const eq = parts[0].indexOf("=");
			if (eq < 1) continue;
			const c: Cookie = {
				name: parts[0].slice(0, eq),
				value: parts[0].slice(eq + 1),
				domain: u.hostname.toLowerCase(),
				hostOnly: true,
				path: defaultPath(u.pathname),
				secure: false,
				expires: null,
			};
			for (const attr of parts.slice(1)) {
				const i = attr.indexOf("=");
				const k = (i < 0 ? attr : attr.slice(0, i)).toLowerCase();
				const v = i < 0 ? "" : attr.slice(i + 1);
				if (k === "domain" && v) {
					const d = v.replace(/^\./, "").toLowerCase();
					if (u.hostname.toLowerCase() === d || u.hostname.toLowerCase().endsWith(`.${d}`)) {
						c.domain = d;
						c.hostOnly = false;
					}
				} else if (k === "path" && v.startsWith("/")) c.path = v;
				else if (k === "secure") c.secure = true;
				else if (k === "max-age") {
					const n = Number(v);
					if (Number.isFinite(n)) c.expires = Date.now() + n * 1000;
				} else if (k === "expires" && c.expires === null) {
					const t = Date.parse(v);
					if (Number.isFinite(t)) c.expires = t;
				}
			}
			this.cookies = this.cookies.filter((o) => !(o.name === c.name && o.domain === c.domain && o.path === c.path));
			if (c.expires === null || c.expires > Date.now()) this.cookies.push(c);
		}
	}

	header(url: string): string {
		const u = new URL(url);
		const host = u.hostname.toLowerCase();
		const now = Date.now();
		this.cookies = this.cookies.filter((c) => c.expires === null || c.expires > now);
		const out = this.cookies
			.filter((c) => (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`)))
			.filter((c) => u.pathname.startsWith(c.path))
			.filter((c) => !c.secure || u.protocol === "https:")
			.sort((a, b) => b.path.length - a.path.length);
		return out.map((c) => `${c.name}=${c.value}`).join("; ");
	}

	clear(): void {
		this.cookies = [];
	}
}

function defaultPath(p: string): string {
	const i = p.lastIndexOf("/");
	return i <= 0 ? "/" : p.slice(0, i);
}

// ---------------------------------------------------------------- client

export interface RawResponse {
	status: number;
	final_url: string;
	headers: Record<string, string>;
	bytes: number;
	ms: number;
	body: Uint8Array | null;
	path: string | null;
	errorBody: Uint8Array | null;
}

export interface RequestCtx {
	signal: AbortSignal;
	sink: "memory" | "file";
	path?: string;
	/** Called before every hop (redirects included): cookies of the embedded browser to merge into the jar. */
	cookieSource?: (url: string) => Promise<ForeignCookie[]>;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const TLS_RE = /\b(SSL|TLS)\b|certificate|CERT_|UNABLE_TO_VERIFY|self.signed|ERR_TLS/i;

export class HttpClient {
	readonly jar = new CookieJar();
	private fetchFn: FetchFn;
	constructor(opts: { fetch?: FetchFn } = {}) {
		this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
	}

	async request(req: HttpReq, ctx: RequestCtx): Promise<RawResponse> {
		if (!req || typeof req.url !== "string" || !/^https?:\/\//i.test(req.url))
			throw new OpError("unsupported", "only http(s) URLs are supported");
		if (!(Number(req.timeout_ms) > 0)) throw new OpError("internal", "timeout_ms must be positive");
		if (ctx.sink === "file" && !ctx.path) throw new OpError("internal", "file sink needs a path");
		const max = Number(req.max_bytes) > 0 ? Number(req.max_bytes) : 0;
		const ac = new AbortController();
		let abortKind: "cancelled" | "timeout" | "too_large" | null = null;
		const abort = (kind: "cancelled" | "timeout" | "too_large") => {
			if (abortKind) return;
			abortKind = kind;
			ac.abort();
		};
		let timer: ReturnType<typeof setTimeout> | null = null;
		const arm = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => abort("timeout"), req.timeout_ms);
		};
		const onCancel = () => abort("cancelled");
		if (ctx.signal.aborted) throw new OpError("cancelled", String(ctx.signal.reason ?? "cancelled"));
		ctx.signal.addEventListener("abort", onCancel, { once: true });
		arm();
		const t0 = performance.now();
		try {
			const res = await this.follow(req, ac.signal, ctx.cookieSource);
			const status = res.status;
			const headers = whitelist(res.headers);
			const finalUrl = (res as any).__finalUrl as string;
			if (ctx.sink === "file") {
				if (status >= 200 && status < 300) {
					const bytes = await this.streamToFile(res, ctx.path!, max, arm, abort);
					return {
						status,
						final_url: finalUrl,
						headers,
						bytes,
						ms: performance.now() - t0,
						body: null,
						path: ctx.path!,
						errorBody: null,
					};
				}
				const errorBody = await readBody(res, INSPECT_TEXT_MAX, arm, null, true);
				return {
					status,
					final_url: finalUrl,
					headers,
					bytes: errorBody.length,
					ms: performance.now() - t0,
					body: null,
					path: null,
					errorBody,
				};
			}
			if (max && Number(res.headers.get("content-length")) > max) {
				abort("too_large");
				throw new Error("too large");
			}
			const body = await readBody(res, max, arm, abort, false);
			return {
				status,
				final_url: finalUrl,
				headers,
				bytes: body.length,
				ms: performance.now() - t0,
				body,
				path: null,
				errorBody: null,
			};
		} catch (e) {
			if (ctx.sink === "file" && ctx.path) {
				try {
					rmSync(ctx.path, { force: true });
				} catch {
					/* best effort */
				}
			}
			throw classify(e, abortKind, ctx.signal, max);
		} finally {
			if (timer) clearTimeout(timer);
			ctx.signal.removeEventListener("abort", onCancel);
		}
	}

	/** Follow redirects by hand so cookies set on every hop are kept. Returns the final Response with __finalUrl. */
	private async follow(req: HttpReq, signal: AbortSignal, cookieSource?: RequestCtx["cookieSource"]): Promise<Response> {
		let url = req.url;
		let method = req.method.toUpperCase();
		let body: string | undefined = req.body;
		for (let hop = 0; ; hop++) {
			const headers: Record<string, string> = {};
			for (const [k, v] of Object.entries(req.headers ?? {})) {
				const lk = k.toLowerCase();
				if (DROPPED_REQUEST_HEADERS.includes(lk) || lk === "user-agent") continue;
				if (v != null) headers[k] = String(v);
			}
			headers["User-Agent"] = req.ua === "plain" ? UA_PLAIN : UA_DEFAULT;
			if (cookieSource) {
				try {
					this.jar.merge(await cookieSource(url));
				} catch {
					/* the embedded browser is gone: send what the jar has */
				}
			}
			const cookie = this.jar.header(url);
			if (cookie) headers.Cookie = cookie;
			const res = await this.fetchFn(url, {
				method,
				headers,
				body: method === "GET" || method === "HEAD" ? undefined : body,
				redirect: "manual",
				signal,
			});
			const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
			if (setCookies.length) this.jar.store(url, setCookies);
			const loc = res.headers.get("location");
			if (res.status >= 300 && res.status < 400 && loc) {
				const next = resolve(loc, url);
				if (req.follow_redirects !== false && /^https?:\/\//i.test(next)) {
					if (hop >= MAX_REDIRECTS) throw new OpError("network", "too many redirects");
					void res.body?.cancel().catch(() => {});
					if (res.status === 301 || res.status === 302 || res.status === 303) {
						if (method !== "GET" && method !== "HEAD") {
							method = "GET";
							body = undefined;
						}
					}
					url = next;
					continue;
				}
				// not following (or a non-http target): report the 3xx with a resolved Location
				const out = new Response(null, { status: res.status, headers: new Headers({ location: next }) });
				(out as any).__finalUrl = url;
				return out;
			}
			(res as any).__finalUrl = url;
			return res;
		}
	}

	private async streamToFile(
		res: Response,
		path: string,
		max: number,
		arm: () => void,
		abort: (k: "too_large") => void,
	): Promise<number> {
		mkdirSync(dirname(path), { recursive: true });
		const out = createWriteStream(path);
		let total = 0;
		const done = new Promise<void>((resolveDone, reject) => {
			out.on("error", reject);
			out.on("finish", resolveDone);
		});
		// A write error must not be an unhandled rejection while the loop is still reading, nor leave it waiting for a drain that
		// never comes: it is observed here, ends the wait below, and is thrown by `await done` at the end.
		done.catch(() => {});
		try {
			if (res.body) {
				const reader = res.body.getReader();
				void done.catch(() => void reader.cancel().catch(() => {}));
				for (;;) {
					const { done: d, value } = await reader.read();
					if (d) break;
					if (!value?.length) continue;
					total += value.length;
					if (max && total > max) {
						abort("too_large");
						void reader.cancel().catch(() => {});
						throw new Error("too large");
					}
					arm(); // inactivity timeout, not total time
					if (!out.write(value)) await Promise.race([new Promise<void>((r) => out.once("drain", () => r())), done]);
				}
			}
		} finally {
			out.end();
		}
		await done;
		return total;
	}
}

async function readBody(
	res: Response,
	limit: number,
	arm: () => void,
	abort: ((k: "too_large") => void) | null,
	truncateOnly: boolean,
): Promise<Uint8Array> {
	if (!res.body) return new Uint8Array(0);
	const reader = res.body.getReader();
	const parts: Uint8Array[] = [];
	let n = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value?.length) continue;
		arm();
		if (truncateOnly && limit && n + value.length > limit) {
			parts.push(value.subarray(0, limit - n));
			n = limit;
			void reader.cancel().catch(() => {});
			break;
		}
		n += value.length;
		parts.push(value);
		if (!truncateOnly && limit && n > limit) {
			abort?.("too_large");
			void reader.cancel().catch(() => {});
			throw new Error("too large");
		}
	}
	return concat(parts, n);
}

function concat(parts: Uint8Array[], n: number): Uint8Array {
	if (parts.length === 1) return parts[0];
	const out = new Uint8Array(n);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

function whitelist(h: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of RESPONSE_HEADERS) {
		const v = h.get(name);
		if (v != null && v !== "") out[name] = v.slice(0, HEADER_VALUE_MAX);
	}
	return out;
}

function resolve(loc: string, base: string): string {
	try {
		return new URL(loc, base).href;
	} catch {
		return loc;
	}
}

function classify(e: unknown, abortKind: string | null, signal: AbortSignal, max: number): OpError {
	if (e instanceof OpError) return e;
	if (abortKind === "too_large") return new OpError("too_large", `response exceeded ${max} bytes`);
	if (abortKind === "timeout") return new OpError("timeout", "request timed out");
	if (abortKind === "cancelled" || signal.aborted) return new OpError("cancelled", String(signal.reason ?? "cancelled"));
	const msg = e instanceof Error ? `${(e as any).code ?? ""} ${e.message}`.trim() : String(e);
	if ((e as any)?.name === "AbortError") return new OpError("network", `aborted: ${msg}`);
	if (TLS_RE.test(msg)) return new OpError("tls", msg);
	if (
		e instanceof TypeError ||
		/fetch failed|ConnectionRefused|ENOTFOUND|ECONN|socket|network|Unable to connect|DNS|FailedToOpen/i.test(msg)
	)
		return new OpError("network", msg);
	return new OpError("internal", msg.slice(0, 300));
}
