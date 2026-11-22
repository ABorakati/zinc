// HTTP helpers for talking to Zinc core's local API (default http://127.0.0.1:23120).
// Pure Web APIs only: runs inside the Office.js task-pane browser sandbox.

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class CoreHttpError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "CoreHttpError";
	}
}

export class ZincUnavailableError extends Error {
	constructor(
		public readonly apiBase: string,
		cause?: unknown,
	) {
		super(`Cannot reach Zinc at ${apiBase} — make sure Zinc is running.`, cause !== undefined ? { cause } : undefined);
		this.name = "ZincUnavailableError";
	}
}

export interface HttpClient {
	apiBase(): string;
	request(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response>;
	getJson<T = unknown>(path: string, timeoutMs?: number): Promise<T>;
	postJson<T = unknown>(path: string, body: unknown, timeoutMs?: number): Promise<T>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function timeoutSignal(ms: number, existing?: AbortSignal | null): { signal: AbortSignal; clear(): void } {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new Error(`Request timed out after ${ms} ms`)), ms);
	if (existing) {
		if (existing.aborted) ctrl.abort(existing.reason);
		else existing.addEventListener("abort", () => ctrl.abort(existing.reason), { once: true });
	}
	return {
		signal: ctrl.signal,
		clear: () => clearTimeout(timer),
	};
}

export async function readErrorMessage(res: Response): Promise<string> {
	const text = await res.text().catch(() => "");
	if (text) {
		try {
			const parsed = JSON.parse(text) as { error?: unknown };
			if (typeof parsed?.error === "string" && parsed.error) return parsed.error;
		} catch {
			// plain-text error body
		}
		return text;
	}
	return `HTTP ${res.status}`;
}

export function createHttpClient(getApiBase: () => string, fetchImpl?: FetchLike): HttpClient {
	const doFetch: FetchLike = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

	async function request(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
		const base = getApiBase();
		const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
		const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...rest } = init;
		const t = timeoutSignal(timeoutMs, callerSignal);
		try {
			return await doFetch(url, { ...rest, signal: t.signal });
		} catch (e) {
			throw new ZincUnavailableError(base, e);
		} finally {
			t.clear();
		}
	}

	async function expectJson<T>(res: Response): Promise<T> {
		if (!res.ok) throw new CoreHttpError(res.status, await readErrorMessage(res));
		return (await res.json()) as T;
	}

	return {
		apiBase: getApiBase,
		request,
		async getJson<T = unknown>(path: string, timeoutMs?: number): Promise<T> {
			const res = await request(path, timeoutMs !== undefined ? { timeoutMs } : {});
			return expectJson<T>(res);
		},
		async postJson<T = unknown>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
			const res = await request(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				...(timeoutMs !== undefined ? { timeoutMs } : {}),
			});
			return expectJson<T>(res);
		},
	};
}

/** Run async mapper over `items` with at most `concurrency` in-flight promises, preserving input order. */
export async function mapPool<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	if (items.length === 0) return [];
	const out = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, async () => {
		for (;;) {
			const idx = next++;
			if (idx >= items.length) break;
			out[idx] = await fn(items[idx]!, idx);
		}
	});
	await Promise.all(workers);
	return out;
}
