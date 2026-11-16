// Zotero.HTTP for the translator runtime (replaces translation-server's request/jsdom version with fetch).
// Every request of a run goes through here, so the caps (request count, response size, timeout) live here.
import { makeDocument } from "./dom";

export interface RunLimits {
	maxRequests: number;
	maxResponseBytes: number;
	requestTimeoutMs: number;
	userAgent: string;
}

export const DEFAULT_LIMITS: RunLimits = {
	maxRequests: 25,
	maxResponseBytes: 10 * 1024 * 1024,
	requestTimeoutMs: 15000,
	userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

/** One cached GET response, base64 body so it survives the worker boundary (a multi-item page is fetched once). */
export interface CachedResponse {
	url: string;
	responseURL: string;
	status: number;
	headers: [string, string][];
	body: string;
}

const MAX_CACHE_ENTRY = 3 * 1024 * 1024;
const MAX_CACHE_TOTAL = 12 * 1024 * 1024;

let limits: RunLimits = DEFAULT_LIMITS;
let requests = 0;
let cacheTotal = 0;
let cache = new Map<string, CachedResponse>();
let jar = new Map<string, Map<string, string>>(); // host -> cookie name -> value
let closed = true; // between runs: callbacks a finished translator left behind must not fetch

export function beginRun(l: Partial<RunLimits> = {}, seed: CachedResponse[] = []): void {
	limits = { ...DEFAULT_LIMITS, ...l };
	closed = false;
	requests = 0;
	cacheTotal = 0;
	cache = new Map();
	jar = new Map();
	for (const c of seed) cache.set(c.url, c);
}

export function endRun(): CachedResponse[] {
	closed = true;
	const out = [...cache.values()];
	cache = new Map();
	jar = new Map();
	return out;
}

export function requestCount(): number {
	return requests;
}

function mimeEssence(contentType: string | null | undefined): string {
	return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}
const isHTML = (e: string) => e === "text/html";
const isXML = (e: string) => e === "text/xml" || e === "application/xml" || e.endsWith("+xml");

function charsetOf(contentType: string | null | undefined): string | null {
	const m = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType ?? "");
	return m ? m[1]!.toLowerCase() : null;
}

function decode(bytes: Uint8Array, label: string | null): string {
	for (const l of [label, "utf-8"]) {
		if (!l) continue;
		try {
			return new TextDecoder(l).decode(bytes);
		} catch {
			/* unknown label: try the next */
		}
	}
	return "";
}

/** Charset of an HTML page: the header, a BOM, or a <meta charset> in the first KB. */
function decodeHtml(bytes: Uint8Array, contentType: string | null): string {
	let label = charsetOf(contentType);
	if (!label) {
		if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) label = "utf-8";
		else {
			const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
			const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
			label = m ? m[1]!.toLowerCase() : "utf-8";
		}
	}
	return decode(bytes, label);
}

function cookieHeader(url: URL): string {
	const out: string[] = [];
	const host = url.hostname;
	for (const [domain, cookies] of jar) {
		if (host === domain || host.endsWith("." + domain)) for (const [k, v] of cookies) out.push(`${k}=${v}`);
	}
	return out.join("; ");
}

function storeCookies(url: URL, res: Response): void {
	const list = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
	for (const line of list) {
		const [pair, ...attrs] = line.split(";");
		const eq = pair!.indexOf("=");
		if (eq < 1) continue;
		let domain = url.hostname;
		for (const a of attrs) {
			const m = /^\s*domain\s*=\s*\.?(.+)$/i.exec(a);
			if (m) domain = m[1]!.trim().toLowerCase();
		}
		const bucket = jar.get(domain) ?? new Map<string, string>();
		bucket.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
		jar.set(domain, bucket);
	}
}

const Zotero = () => (globalThis as any).Zotero;

async function readCapped(res: Response, max: number, url: string): Promise<Uint8Array> {
	const declared = Number(res.headers.get("content-length") ?? 0);
	if (declared > max) throw new (Zotero().HTTP.ResponseSizeError)(url);
	if (!res.body) return new Uint8Array(await res.arrayBuffer());
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = res.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > max) {
			void reader.cancel();
			throw new (Zotero().HTTP.ResponseSizeError)(url);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.length;
	}
	return out;
}

interface Raw {
	responseURL: string;
	status: number;
	headers: Headers;
	body: Uint8Array;
}

async function rawRequest(method: string, requestURL: string, options: any): Promise<Raw> {
	const key = method === "GET" && options.body == null ? requestURL : null;
	if (key) {
		const hit = cache.get(key);
		if (hit)
			return {
				responseURL: hit.responseURL,
				status: hit.status,
				headers: new Headers(hit.headers),
				body: new Uint8Array(Buffer.from(hit.body, "base64")),
			};
	}
	if (closed) throw new Error("the translation run has finished");
	if (++requests > limits.maxRequests) throw new Error(`translator exceeded the limit of ${limits.maxRequests} HTTP requests`);
	let url = new URL(requestURL);
	const headers: Record<string, string> = { "User-Agent": limits.userAgent, Accept: "*/*", ...(options.headers ?? {}) };
	let body: string | null = options.body ?? null;
	if (body != null && typeof body !== "string") body = JSON.stringify(body);
	let m = method;
	for (let hop = 0; hop < 10; hop++) {
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`unsupported protocol ${url.protocol}`);
		const cookie = cookieHeader(url);
		const res = await fetch(url, {
			method: m,
			headers: cookie ? { ...headers, Cookie: cookie } : headers,
			body: m === "GET" || m === "HEAD" ? undefined : body,
			redirect: "manual",
			signal: AbortSignal.timeout(options.timeout ?? limits.requestTimeoutMs),
		});
		storeCookies(url, res);
		if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
			url = new URL(res.headers.get("location")!, url);
			if (res.status !== 307 && res.status !== 308) {
				m = "GET";
				body = null;
			}
			void res.body?.cancel();
			continue;
		}
		const bytes = await readCapped(res, options.maxResponseSize ?? limits.maxResponseBytes, requestURL);
		const raw: Raw = { responseURL: url.href, status: res.status, headers: res.headers, body: bytes };
		if (key && res.status < 400 && bytes.length <= MAX_CACHE_ENTRY && cacheTotal + bytes.length <= MAX_CACHE_TOTAL) {
			cacheTotal += bytes.length;
			cache.set(key, {
				url: key,
				responseURL: raw.responseURL,
				status: raw.status,
				headers: [...res.headers.entries()],
				body: Buffer.from(bytes).toString("base64"),
			});
		}
		return raw;
	}
	throw new Error("too many redirects");
}

function responseTypeFor(contentType: string | null, options: any): string {
	const e = mimeEssence(contentType);
	if (options.responseType) return options.responseType;
	const map: Map<string, string> | undefined = options.responseTypeMap;
	if (map) {
		if (map.has("html") && isHTML(e)) return map.get("html")!;
		if (map.has("xml") && isXML(e)) return map.get("xml")!;
		if (map.has(e)) return map.get(e)!;
		if (map.has("")) return map.get("")!;
	}
	return "text";
}

export function installHttp(Z: any): void {
	const HTTP: any = (Z.HTTP = {});
	const errorClass = (name: string, init: (this: any, ...a: any[]) => void) => {
		const f: any = function (this: any, ...a: any[]) {
			init.apply(this, a);
		};
		f.prototype = Object.create(Error.prototype);
		f.prototype.name = name;
		return f;
	};
	HTTP.StatusError = errorClass("StatusError", function (url: string, status: number, body: string) {
		this.message = `HTTP request to ${url} rejected with status ${status}`;
		this.status = status;
		this.responseText = body;
	});
	HTTP.TimeoutError = errorClass("TimeoutError", function (ms: number) {
		this.message = `HTTP request has timed out after ${ms}ms`;
	});
	HTTP.ResponseSizeError = errorClass("ResponseSizeError", function (url: string) {
		this.message = `${url} response exceeds max size`;
	});
	HTTP.UnsupportedFormatError = errorClass("UnsupportedFormatError", function (_url: string, msg: string) {
		this.message = msg;
	});

	HTTP.request = async function (method: string, requestURL: string, options: any = {}): Promise<any> {
		if (["GET", "HEAD"].includes(method) && options.body != null) throw new Error(`HTTP ${method} cannot have a request body`);
		if (options.body != null && options.headers?.["Content-Type"] === undefined) {
			options = { ...options, headers: { "Content-Type": "application/x-www-form-urlencoded", ...(options.headers ?? {}) } };
		}
		Z.debug(`HTTP ${method} ${requestURL}`);
		let raw: Raw;
		try {
			raw = await rawRequest(method, new URL(requestURL).href, options);
		} catch (e: any) {
			if (e?.name === "TimeoutError" || e?.name === "AbortError")
				throw new HTTP.TimeoutError(options.timeout ?? limits.requestTimeoutMs);
			throw e;
		}
		const ct = raw.headers.get("content-type");
		const e = mimeEssence(ct);
		const ok =
			options.successCodes === false
				? true
				: Array.isArray(options.successCodes)
					? options.successCodes.includes(raw.status)
					: raw.status >= 200 && raw.status < 300;
		if (!ok) throw new HTTP.StatusError(requestURL, raw.status, decode(raw.body, charsetOf(ct)));
		const type = responseTypeFor(ct, options);
		const map: Map<string, string> | undefined = options.responseTypeMap;
		if (map instanceof Map) {
			const supported = (map.has("html") && isHTML(e)) || (map.has("xml") && isXML(e)) || map.has(e) || map.has("");
			if (!supported) throw new HTTP.UnsupportedFormatError(requestURL, `${ct} is not supported`);
		}
		if (type === "document" && !(isHTML(e) || isXML(e))) throw new HTTP.UnsupportedFormatError(requestURL, `${ct} is not supported`);
		const result: any = {
			responseURL: raw.responseURL,
			status: raw.status,
			type,
			getAllResponseHeaders: () => [...raw.headers.entries()].map(([k, v]) => `${k}: ${v}\r\n`).join(""),
			getResponseHeader: (h: string) => raw.headers.get(h) ?? null,
		};
		if (type === "document") {
			const html = isHTML(e) ? decodeHtml(raw.body, ct) : decode(raw.body, charsetOf(ct));
			result.response = makeDocument(html, raw.responseURL, e || "text/html");
			if (isHTML(e)) {
				const meta = result.response.querySelector("meta[http-equiv=refresh]");
				const content = meta?.getAttribute("content");
				if (content) {
					const parts = content.split(/;\s*url=/);
					if (parts.length === 2 && parseInt(parts[0]!) <= 15) {
						const next = new URL(parts[1]!.trim().replace(/^'(.+)'$/, "$1"), raw.responseURL).href;
						Z.debug("Meta refresh to " + next);
						return HTTP.request(method, next, options);
					}
				}
			}
		} else if (type === "json") {
			result.response = JSON.parse(decode(raw.body, charsetOf(ct)));
		} else {
			const text = decode(raw.body, charsetOf(ct));
			result.response = text;
			result.responseText = text;
		}
		return result;
	};

	HTTP.processDocuments = async function (urls: string | string[], processor: (doc: any, url: string) => any, options: any = {}) {
		if (typeof urls === "string") urls = [urls];
		const results: unknown[] = [];
		for (const url of urls) {
			const req = await HTTP.request("GET", url, {
				responseType: "document",
				cookieSandbox: options.cookieSandbox,
				headers: options.headers,
			});
			results.push(await processor(req.response, req.responseURL));
		}
		if (arguments.length > 3 && typeof arguments[3] === "function") arguments[3]();
		return results;
	};

	HTTP.doGet = function (url: string, onDone: (x: any) => void, _charset?: string, cookieSandbox?: unknown, headers?: unknown) {
		HTTP.request("GET", url, { headers, cookieSandbox }).then(onDone, (e: any) =>
			onDone({ status: e.status, responseText: e.responseText }),
		);
		return true;
	};
	HTTP.doPost = function (
		url: string,
		body: unknown,
		onDone: (x: any) => void,
		headers?: unknown,
		_charset?: string,
		cookieSandbox?: unknown,
	) {
		HTTP.request("POST", url, { body, headers, cookieSandbox }).then(onDone, (e: any) =>
			onDone({ status: e.status, responseText: e.responseText }),
		);
		return true;
	};
}
