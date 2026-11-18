// `net` (lifecycle.wit): HTTP for plugins, behind the manifest's `permissions.net.hosts` allowlist. Runs in the plugin host process.
//
//  - Allowlist: scheme://host[:port], `*.` wildcards, `*` for any PUBLIC host (data/nethosts.ts). Loopback and private hosts only by
//    exact entry. Every redirect hop is checked again (redirects are followed here, not by fetch). A public name that resolves to
//    a private address is refused unless the name itself is listed.
//  - Caps: request timeout (default 30 s, never more than 10 min), response size (default 64 MiB, at most 512 MiB), 16 requests per
//    send-many, 20 redirects.
//  - The host sets Host, Content-Length, Connection, Cookie (unless cookie jar), Proxy-*, Sec-*; the plugin's values are ignored.
//  - Cookie jars are private to the plugin and live as long as this process.
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { dirname } from "node:path";
import { Writable } from "node:stream";
import { defineHandler, WitError, type HandlerContext } from "./registry";
import { isPrivateHost, netHostAllowed, parseRule } from "./data/nethosts";
import { checkQuota, resolveRef, type PathRef } from "./data/fs-roots";

const USER_AGENT = "Zinc/0.1";
const MAX_REDIRECTS = 20;
const DEFAULT_TIMEOUT = 30_000;
const HARD_TIMEOUT = 10 * 60_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_MAX_BYTES = 512 * 1024 * 1024;
const FORBIDDEN_HEADERS = /^(host|content-length|connection|cookie|proxy-.*|sec-.*|transfer-encoding|upgrade|te|keep-alive)$/i;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** `result<_, net-error>`'s err payload is a net-error variant, not a types.error: build the WitError with that payload. */
function netError(tag: string, val?: unknown): WitError {
	const e = new WitError("internal", tag);
	(e as { payload: unknown }).payload = val === undefined ? { tag } : { tag, val };
	e.message = val === undefined ? tag : `${tag}: ${typeof val === "string" ? val : "…"}`;
	return e;
}

interface Req {
	method: string;
	url: string;
	headers: { name: string; value: string }[];
	body?: Uint8Array;
	timeoutMs?: number;
	successCodes?: number[];
	redirect: string;
	credentials?: { username: string; password: string };
	cookies: { tag: string; val?: string };
	retry?: { delaysMs: number[]; maxTotalMs: number; surfaceThrottle: boolean };
	bypassCache: boolean;
	maxResponseBytes?: bigint;
	cancelKey?: string;
}

// ------------------------------------------------------------------------------------------- state
interface Cookie {
	name: string;
	value: string;
	domain: string;
	hostOnly: boolean;
	path: string;
	secure: boolean;
	expires?: number;
}
const jars = new Map<string, Map<string, Cookie[]>>(); // plugin -> jar name -> cookies
const cancels = new Map<string, Map<string, AbortController>>(); // plugin -> cancel key -> controller

const jarOf = (plugin: string, name: string): Cookie[] => {
	let p = jars.get(plugin);
	if (!p) jars.set(plugin, (p = new Map()));
	let j = p.get(name);
	if (!j) p.set(name, (j = []));
	return j;
};

function storeCookies(jar: Cookie[], url: URL, setCookies: string[]) {
	for (const line of setCookies) {
		const parts = line.split(";").map((s) => s.trim());
		const [nv, ...attrs] = parts;
		const eq = nv.indexOf("=");
		if (eq < 1) continue;
		const c: Cookie = { name: nv.slice(0, eq), value: nv.slice(eq + 1), domain: url.hostname.toLowerCase(), hostOnly: true, path: "/", secure: false };
		for (const a of attrs) {
			const [k, v = ""] = [a.split("=")[0].toLowerCase(), a.includes("=") ? a.slice(a.indexOf("=") + 1) : ""];
			if (k === "domain" && v) {
				const d = v.replace(/^\./, "").toLowerCase();
				if (url.hostname.toLowerCase() === d || url.hostname.toLowerCase().endsWith("." + d)) {
					c.domain = d;
					c.hostOnly = false;
				}
			} else if (k === "path" && v.startsWith("/")) c.path = v;
			else if (k === "secure") c.secure = true;
			else if (k === "max-age" && /^-?\d+$/.test(v)) c.expires = Date.now() + +v * 1000;
			else if (k === "expires" && c.expires === undefined) {
				const t = Date.parse(v);
				if (!Number.isNaN(t)) c.expires = t;
			}
		}
		const i = jar.findIndex((x) => x.name === c.name && x.domain === c.domain && x.path === c.path);
		if (i >= 0) jar.splice(i, 1);
		if (c.expires === undefined || c.expires > Date.now()) jar.push(c);
	}
}

function cookieHeader(jar: Cookie[], url: URL): string | undefined {
	const host = url.hostname.toLowerCase();
	const now = Date.now();
	const parts = jar
		.filter((c) => (c.expires === undefined || c.expires > now) && (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith("." + c.domain)) && url.pathname.startsWith(c.path) && (!c.secure || url.protocol === "https:"))
		.map((c) => `${c.name}=${c.value}`);
	return parts.length ? parts.join("; ") : undefined;
}

// ------------------------------------------------------------------------------------------ checks
async function assertAllowed(ctx: HandlerContext, url: URL): Promise<void> {
	if (url.protocol !== "http:" && url.protocol !== "https:") throw netError("blocked", `scheme ${url.protocol} is not allowed`);
	if (url.username || url.password) throw netError("blocked", "credentials in the URL are not allowed: use `credentials`");
	if (!netHostAllowed(ctx.grants.netHosts, url)) throw netError("blocked", `${url.origin} is not in permissions.net.hosts`);
	const host = url.hostname.replace(/^\[|\]$/g, "");
	// A name that the manifest lists exactly may be private (a local model server). Any other name that resolves to a private
	// address is refused (DNS rebinding, internal names behind a wildcard).
	if (isPrivateHost(host)) return;
	const exact = ctx.grants.netHosts.some((e) => {
		const r = parseRule(e);
		return r && r !== "any" && !r.wild && r.host === host.toLowerCase();
	});
	if (exact) return;
	try {
		const addrs = await lookup(host, { all: true });
		if (addrs.some((a) => isPrivateHost(a.address))) throw netError("blocked", `${host} resolves to a private address`);
	} catch (e) {
		if (e instanceof WitError) throw e;
		throw netError("dns", (e as Error).message);
	}
}

function classify(e: unknown, signal: { timedOut: boolean; cancelled: boolean }): WitError {
	if (e instanceof WitError) return e;
	if (signal.cancelled) return netError("cancelled");
	if (signal.timedOut) return netError("timeout");
	const msg = String((e as Error)?.message ?? e);
	const code = (e as { code?: string })?.code ?? "";
	if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg + code)) return netError("dns", msg);
	if (/certificate|TLS|SSL|CERT_/i.test(msg + code)) return netError("tls", msg);
	if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|Unable to connect|socket/i.test(msg + code)) return netError("connection", msg);
	return netError("other", msg);
}

interface Exchange {
	res: Response;
	url: string;
	controller: AbortController;
	done: () => void;
	flags: { timedOut: boolean; cancelled: boolean };
}

/** One HTTP exchange with redirects checked hop by hop. Does not read the body. */
async function exchange(ctx: HandlerContext, req: Req, inactivity?: number): Promise<Exchange> {
	const method = req.method.toUpperCase();
	if (!METHODS.has(method)) throw netError("other", `unsupported method ${req.method}`);
	let url: URL;
	try {
		url = new URL(req.url);
	} catch {
		throw netError("other", `invalid url: ${req.url}`);
	}
	const controller = new AbortController();
	const flags = { timedOut: false, cancelled: false };
	let timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT;
	if (timeoutMs <= 0 || timeoutMs > HARD_TIMEOUT) timeoutMs = HARD_TIMEOUT;
	let timer = setTimeout(() => ((flags.timedOut = true), controller.abort()), inactivity ?? timeoutMs);
	const done = () => clearTimeout(timer);
	if (req.cancelKey) {
		let m = cancels.get(ctx.pluginId);
		if (!m) cancels.set(ctx.pluginId, (m = new Map()));
		if (m.has(req.cancelKey)) {
			done();
			throw netError("other", `cancel-key ${req.cancelKey} is already in use`);
		}
		m.set(req.cancelKey, controller);
		controller.signal.addEventListener("abort", () => {
			if (!flags.timedOut) flags.cancelled = true;
		});
	}
	const release = () => {
		if (req.cancelKey) cancels.get(ctx.pluginId)?.delete(req.cancelKey);
	};
	const jar = req.cookies?.tag === "jar" ? jarOf(ctx.pluginId, req.cookies.val ?? "default") : undefined;
	try {
		let body: Uint8Array | undefined = req.body ?? undefined;
		let m = method;
		for (let hop = 0; ; hop++) {
			await assertAllowed(ctx, url);
			const headers = new Headers();
			let hasUA = false;
			for (const h of req.headers ?? []) {
				if (FORBIDDEN_HEADERS.test(h.name)) continue;
				if (h.name.toLowerCase() === "user-agent") hasUA = true;
				headers.append(h.name, h.value);
			}
			if (!hasUA) headers.set("User-Agent", USER_AGENT);
			if (req.credentials) headers.set("Authorization", "Basic " + Buffer.from(`${req.credentials.username}:${req.credentials.password}`).toString("base64"));
			if (jar) {
				const c = cookieHeader(jar, url);
				if (c) headers.set("Cookie", c);
			}
			const res = await fetch(url, {
				method: m,
				headers,
				body: m === "GET" || m === "HEAD" ? undefined : (body as BodyInit | undefined),
				redirect: "manual",
				signal: controller.signal,
				cache: req.bypassCache ? "no-store" : "default",
			});
			if (jar) storeCookies(jar, url, res.headers.getSetCookie());
			const loc = res.headers.get("location");
			if (req.redirect !== "manual" && loc && [301, 302, 303, 307, 308].includes(res.status) && !req.redirect?.startsWith?.("manual")) {
				if (hop >= MAX_REDIRECTS) throw netError("other", "too many redirects");
				await res.body?.cancel().catch(() => {});
				url = new URL(loc, url);
				if (res.status === 303 || ((res.status === 301 || res.status === 302) && m === "POST")) {
					m = m === "HEAD" ? "HEAD" : "GET";
					body = undefined;
				}
				continue;
			}
			// a manual-redirect answer, or the final one
			if (inactivity === undefined) {
				// whole-body mode: keep the timer running until the body is read (the caller clears it with `done`)
			} else {
				clearTimeout(timer);
				timer = setTimeout(() => ((flags.timedOut = true), controller.abort()), inactivity);
			}
			return {
				res,
				url: url.href,
				controller,
				flags,
				done: () => {
					done();
					release();
				},
			};
		}
	} catch (e) {
		done();
		release();
		throw classify(e, flags);
	}
}

const headersOf = (res: Response) => [...res.headers.entries()].map(([name, value]) => ({ name, value }));

function responseRecord(res: Response, url: string, body: Uint8Array) {
	return { status: res.status, statusText: res.statusText, url, headers: headersOf(res), body };
}

async function readCapped(ex: Exchange, cap: number): Promise<Uint8Array> {
	const len = Number(ex.res.headers.get("content-length") ?? NaN);
	if (Number.isFinite(len) && len > cap) {
		ex.controller.abort();
		throw netError("too-large");
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = ex.res.body?.getReader();
	if (reader) {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > cap) {
				ex.controller.abort();
				throw netError("too-large");
			}
			chunks.push(value);
		}
	}
	if (chunks.length === 1) return chunks[0];
	const out = new Uint8Array(total);
	let o = 0;
	for (const c of chunks) {
		out.set(c, o);
		o += c.byteLength;
	}
	return out;
}

const okStatus = (req: Req, status: number) => (req.successCodes === undefined || req.successCodes === null ? status >= 200 && status < 300 : req.successCodes.length === 0 || req.successCodes.includes(status));

const capOf = (req: Req) => Math.min(Number(req.maxResponseBytes ?? BigInt(DEFAULT_MAX_BYTES)), MAX_MAX_BYTES);

/** One request with the retry policy; returns the response record or throws a net-error. */
async function send(ctx: HandlerContext, req: Req) {
	const retry = req.retry;
	const delays = retry?.delaysMs ?? [];
	let waited = 0;
	for (let attempt = 0; ; attempt++) {
		let ex: Exchange | undefined;
		try {
			ex = await exchange(ctx, req);
			const body = await readCapped(ex, capOf(req));
			const rec = responseRecord(ex.res, ex.url, body);
			const throttle = ex.res.status === 429 || ex.res.status === 503;
			const retryable = ex.res.status >= 500 || ex.res.status === 429;
			ex.done();
			if (retryable && attempt < delays.length && !(throttle && retry?.surfaceThrottle && ex.res.headers.has("retry-after"))) {
				const ra = Number(ex.res.headers.get("retry-after"));
				const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : delays[attempt];
				if (waited + wait <= (retry?.maxTotalMs || Infinity)) {
					waited += wait;
					await new Promise((r) => setTimeout(r, wait));
					continue;
				}
			}
			if (!okStatus(req, ex.res.status)) throw netError("unexpected-status", rec);
			return rec;
		} catch (e) {
			ex?.done();
			const err = e instanceof WitError ? e : classify(e, ex?.flags ?? { timedOut: false, cancelled: false });
			const tag = (err.payload as { tag: string }).tag;
			if ((tag === "connection" || tag === "dns") && attempt < delays.length && waited + delays[attempt] <= (retry?.maxTotalMs || Infinity)) {
				waited += delays[attempt];
				await new Promise((r) => setTimeout(r, delays[attempt]));
				continue;
			}
			throw err;
		}
	}
}

interface ReaderState {
	ex: Exchange;
	reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	pending: Uint8Array | undefined;
	closed: boolean;
}

export default defineHandler({
	interface: "zinc:plugin/net",
	where: "host",
	functions: {
		send: (ctx, req: Req) => send(ctx, req),

		async "send-many"(ctx, reqs: Req[]) {
			if (reqs.length > 16) throw netError("other", "at most 16 requests per call");
			// result<..., net-error> per entry, in the jco shape of a list of results: { tag: "ok", val } | { tag: "err", val }
			return Promise.all(
				reqs.map((r) =>
					send(ctx, r).then(
						(val) => ({ tag: "ok", val }),
						(e: any) => ({ tag: "err", val: e?.payload ?? { tag: "other", val: String(e?.message ?? e) } }),
					),
				),
			);
		},

		async download(ctx, req: Req, dest: PathRef, options: { onConflict?: string; createParents?: boolean; inactivityTimeoutMs?: number; reportProgress?: boolean }) {
			const r = (() => {
				try {
					return resolveRef(ctx, dest, "write");
				} catch (e: any) {
					throw netError("blocked", `destination: ${e?.payload?.val ?? e?.message ?? e}`);
				}
			})();
			let target = r.abs;
			if (options.createParents) await mkdir(dirname(target), { recursive: true });
			const exists = await stat(target).then(() => true, () => false);
			if (exists) {
				if ((options.onConflict ?? "fail") === "fail") throw netError("other", `${dest.path} exists`);
				if (options.onConflict === "rename-unique") {
					const { extname, basename, join } = await import("node:path");
					const ext = extname(target);
					const stem = basename(target, ext);
					for (let n = 2; ; n++) {
						const cand = join(dirname(target), `${stem} ${n}${ext}`);
						if (!(await stat(cand).then(() => true, () => false))) {
							target = cand;
							break;
						}
					}
				}
			}
			const ex = await exchange(ctx, req, options.inactivityTimeoutMs ?? 30_000);
			const tmp = `${target}.${process.pid}.part`;
			let bytes = 0;
			try {
				if (!okStatus(req, ex.res.status)) throw netError("unexpected-status", responseRecord(ex.res, ex.url, new Uint8Array(0)));
				const len = Number(ex.res.headers.get("content-length") ?? 0);
				if (len) checkQuota(r, len);
				const out = createWriteStream(tmp);
				const w = Writable.toWeb(out) as WritableStream<Uint8Array>;
				const writer = w.getWriter();
				const reader = ex.res.body?.getReader();
				let reset = setTimeout(() => ((ex.flags.timedOut = true), ex.controller.abort()), options.inactivityTimeoutMs ?? 30_000);
				const cap = capOf(req);
				try {
					for (;;) {
						const { done, value } = reader ? await reader.read() : { done: true, value: undefined };
						if (done) break;
						clearTimeout(reset);
						reset = setTimeout(() => ((ex.flags.timedOut = true), ex.controller.abort()), options.inactivityTimeoutMs ?? 30_000);
						bytes += value!.byteLength;
						if (bytes > cap) throw netError("too-large");
						if (r.root === "data" && bytes > len) checkQuota(r, value!.byteLength);
						await writer.write(value!);
					}
					await writer.close();
				} finally {
					clearTimeout(reset);
				}
				const { rename } = await import("node:fs/promises");
				await rename(tmp, target);
			} catch (e) {
				await rm(tmp, { force: true }).catch(() => {});
				throw e instanceof WitError ? e : classify(e, ex.flags);
			} finally {
				ex.done();
			}
			const rel = target === r.abs ? dest.path : dest.path.split("/").slice(0, -1).concat(target.split(/[\\/]/).pop()!).join("/");
			return { file: { root: dest.root, path: rel }, status: ex.res.status, url: ex.url, headers: headersOf(ex.res), bytes: BigInt(bytes) };
		},

		async "send-streamed"(ctx, req: Req) {
			const ex = await exchange(ctx, req, req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : DEFAULT_TIMEOUT);
			if (!okStatus(req, ex.res.status)) {
				const rec = responseRecord(ex.res, ex.url, new Uint8Array(0));
				ex.controller.abort();
				ex.done();
				throw netError("unexpected-status", rec);
			}
			const state: ReaderState = { ex, reader: ex.res.body?.getReader(), pending: undefined, closed: false };
			return { status: ex.res.status, statusText: ex.res.statusText, url: ex.url, headers: headersOf(ex.res), body: ctx.resource("body-reader", state) };
		},

		cancel(ctx, key: string) {
			cancels.get(ctx.pluginId)?.get(key)?.abort();
		},

		"list-cookies"(ctx, jar: string, host: string) {
			const h = host.toLowerCase();
			const now = Date.now();
			return jarOf(ctx.pluginId, jar)
				.filter((c) => (c.expires === undefined || c.expires > now) && (c.domain === h || h.endsWith("." + c.domain)))
				.map((c) => ({ name: c.name, value: c.value }));
		},

		"clear-cookie-jar"(ctx, jar: string) {
			jars.get(ctx.pluginId)?.delete(jar);
		},

		"is-online"() {
			return true;
		},
	},
	resources: {
		"body-reader": {
			methods: {
				async read(_ctx, self: ReaderState, max: number) {
					if (self.closed || !self.reader) return undefined;
					try {
						if (!self.pending || self.pending.byteLength === 0) {
							const { done, value } = await self.reader.read();
							if (done) {
								self.closed = true;
								self.ex.done();
								return undefined;
							}
							self.pending = value;
						}
						const n = Math.max(1, Math.min(max, self.pending.byteLength));
						const out = self.pending.subarray(0, n);
						self.pending = self.pending.subarray(n);
						return out;
					} catch (e) {
						self.closed = true;
						self.ex.done();
						throw classify(e, self.ex.flags);
					}
				},
				close(_ctx, self: ReaderState) {
					if (!self.closed) {
						self.closed = true;
						self.ex.controller.abort();
						self.ex.done();
					}
				},
			},
			drop(_ctx, self: ReaderState | undefined) {
				if (self && !self.closed) {
					self.closed = true;
					self.ex.controller.abort();
					self.ex.done();
				}
			},
		},
	},
});

/**
 * Fetch a URL for another handler (attachments.import-from-url): same allowlist, redirect checks, DNS check and caps as `net.send`,
 * with errors mapped to `types.error` (a handler that returns `result<_, error>` cannot throw a net-error).
 */
export async function fetchForHandler(ctx: HandlerContext, url: string, maxBytes: number): Promise<{ status: number; url: string; contentType: string | undefined; body: Uint8Array }> {
	const req: Req = {
		method: "GET",
		url,
		headers: [],
		redirect: "follow",
		cookies: { tag: "none" },
		bypassCache: false,
		maxResponseBytes: BigInt(maxBytes),
	};
	try {
		const r = await send(ctx, req);
		return { status: r.status, url: r.url, contentType: r.headers.find((h) => h.name.toLowerCase() === "content-type")?.value, body: r.body };
	} catch (e) {
		const p = (e as WitError)?.payload as { tag?: string; val?: unknown } | undefined;
		if (!p) throw e;
		const text = typeof p.val === "string" ? p.val : p.tag === "unexpected-status" ? `HTTP ${(p.val as { status: number }).status}` : (p.tag ?? "failed");
		const tag = p.tag === "blocked" ? "permission-denied" : p.tag === "too-large" ? "limit-exceeded" : p.tag === "timeout" ? "timeout" : p.tag === "cancelled" ? "cancelled" : "unavailable";
		throw tag === "timeout" || tag === "cancelled" ? new WitError(tag) : new WitError(tag as "unavailable", `download failed: ${text}`);
	}
}
