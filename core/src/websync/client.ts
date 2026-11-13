// Zotero Web API v3 client: at most `concurrency` requests in flight, and every request waits while the
// server asked for a pause (Backoff header on any response, Retry-After on 429/503).

export class WebApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "WebApiError";
	}
}

/** 412: the library changed since the version we sent. Pull, then try again. */
export class PreconditionFailed extends WebApiError {
	constructor() {
		super(412, "the library changed on zotero.org");
		this.name = "PreconditionFailed";
	}
}

export const DEFAULT_API = "https://api.zotero.org";

/** Base URL: ZN_ZOTERO_API (tests point it at a local mock server), else zotero.org. */
export function apiBase(): string {
	// (a browser worker may have no `process`: then the default)
	const env = typeof process !== "undefined" ? process.env?.ZN_ZOTERO_API : undefined;
	return (env || DEFAULT_API).replace(/\/+$/, "");
}

export interface ClientOptions {
	/** Base URL; a function so the environment is read when a request is made. */
	base?: () => string;
	getKey: () => Promise<string | null>;
	/**
	 * Where the API key goes. "header" (default; the desktop and the extension): the Zotero-API-Key header. "query": the `key` query
	 * parameter, which the Zotero Web API accepts too. A plain web page uses "query": it cannot install a declarativeNetRequest rule,
	 * so a custom header would be forwarded by the browser to the file host when it follows the file redirect, while a query
	 * parameter is not (the redirect target is the Location URL zotero.org chose, without our query).
	 */
	keyIn?: "header" | "query";
	concurrency?: number;
	fetch?: typeof fetch;
	/** Pauses are awaited through these; tests inject a fake clock instead of really waiting. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

export interface RequestInitEx {
	query?: Record<string, string | number | undefined>;
	headers?: Record<string, string>;
	body?: BodyInit;
	redirect?: "manual" | "follow";
	/** Use this key instead of the stored one (validating a key before it is saved). */
	key?: string;
}

const MAX_ATTEMPTS = 5;

function retryAfterMs(res: Response, now: number): number {
	const v = res.headers.get("retry-after");
	if (v) {
		if (/^\d+$/.test(v.trim())) return Number(v) * 1000;
		const t = Date.parse(v);
		if (!Number.isNaN(t)) return Math.max(0, t - now);
	}
	return 10_000;
}

export class ZoteroWebClient {
	/** Epoch ms until which all requests wait. */
	pausedUntil = 0;
	private active = 0;
	private waiters: (() => void)[] = [];
	private readonly limit: number;
	private readonly doFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	private readonly sleep: (ms: number) => Promise<void>;
	readonly now: () => number;

	constructor(private readonly opts: ClientOptions) {
		this.limit = opts.concurrency ?? 4;
		// (an arrow, not `fetch` itself: a browser's fetch throws "Illegal invocation" when called as a method of this object)
		this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
		this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.now = opts.now ?? Date.now;
	}

	get base(): string {
		return (this.opts.base ?? apiBase)();
	}

	private async acquire(): Promise<void> {
		if (this.active < this.limit) {
			this.active++;
			return;
		}
		await new Promise<void>((r) => this.waiters.push(r));
	}

	private release(): void {
		const next = this.waiters.shift();
		if (next) next(); // the slot passes straight to the next waiter
		else this.active--;
	}

	private async gate(): Promise<void> {
		for (;;) {
			const wait = this.pausedUntil - this.now();
			if (wait <= 0) return;
			await this.sleep(wait);
		}
	}

	private pause(ms: number): void {
		this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
	}

	/**
	 * A request to a host that is not zotero.org's API (the file host a download redirects to, the upload URL the API hands out).
	 * It goes through the same injected fetch but never carries the API key or the API headers.
	 */
	external(url: string | URL, init: RequestInit = {}): Promise<Response> {
		return this.doFetch(url, init);
	}

	async request(method: string, path: string, init: RequestInitEx = {}): Promise<Response> {
		const key = init.key ?? (await this.opts.getKey());
		if (!key) throw new WebApiError(401, "no zotero.org API key is set");
		const url = new URL(this.base + path);
		for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
		const inQuery = this.opts.keyIn === "query";
		// (query mode also sends the API version as `v=3`, which the API accepts, so a plain GET carries no custom header at all: a
		// browser then makes no CORS preflight for it and forwards nothing special when it follows the file redirect)
		if (inQuery) { url.searchParams.set("key", key); url.searchParams.set("v", "3"); }
		const headers: Record<string, string> = { ...(inQuery ? {} : { "Zotero-API-Key": key, "Zotero-API-Version": "3" }), ...init.headers };
		let res!: Response;
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			await this.acquire();
			try {
				await this.gate();
				res = await this.doFetch(url, { method, headers, body: init.body, redirect: init.redirect ?? "follow" });
			} finally {
				this.release();
			}
			const backoff = Number(res.headers.get("backoff"));
			if (backoff > 0) this.pause(backoff * 1000);
			if (res.status !== 429 && res.status !== 503) return res;
			this.pause(retryAfterMs(res, this.now()));
			await res.body?.cancel();
		}
		return res;
	}
}

export function libraryVersion(res: Response): number | undefined {
	const v = res.headers.get("last-modified-version");
	return v === null || v === "" ? undefined : Number(v);
}

/** Error for a failed response; never echoes request headers (the API key). */
export async function failure(res: Response): Promise<WebApiError> {
	if (res.status === 412) return new PreconditionFailed();
	let text = "";
	try {
		text = (await res.text()).slice(0, 200);
	} catch {
		// no body
	}
	if (res.status === 401) return new WebApiError(401, "the API key was rejected");
	if (res.status === 403) return new WebApiError(403, "the API key does not allow this");
	return new WebApiError(res.status, text ? `zotero.org answered ${res.status}: ${text}` : `zotero.org answered ${res.status}`);
}
