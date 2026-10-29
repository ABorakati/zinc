// HTTP helper for the reference services: shared fetch (replaceable in tests), 15 s timeout,
// retries with backoff on 429/5xx, concurrency limiter and the polite mailto parameter.
import type { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { loadSettings } from "../fulltext/config";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const USER_AGENT = "zotero-next/0.1 (local reference manager)";

export const net = {
	fetch: ((input: string, init?: RequestInit) => fetch(input, init)) as FetchFn,
	timeoutMs: 15_000,
	retries: 3,
	backoffMs: 600,
};

/** Tests inject a mock; call with no argument to restore the real fetch. */
export function setFetch(f?: FetchFn): void {
	net.fetch = f ?? ((input, init) => fetch(input, init));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class NetError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

/** GET a URL and parse JSON. Returns null on 404; throws NetError on other failures after retries. */
export async function getJson<T = any>(url: string): Promise<T | null> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= net.retries; attempt++) {
		try {
			const res = await net.fetch(url, {
				headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
				signal: AbortSignal.timeout(net.timeoutMs),
			});
			if (res.status === 404) return null;
			if (res.status === 429 || res.status >= 500) {
				const ra = Number(res.headers.get("retry-after"));
				const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : net.backoffMs * 2 ** attempt;
				lastErr = new NetError(res.status, `${res.status} from ${new URL(url).host}`);
				if (attempt < net.retries) await sleep(wait);
				continue;
			}
			if (!res.ok) throw new NetError(res.status, `${res.status} from ${new URL(url).host}`);
			return (await res.json()) as T;
		} catch (e) {
			if (e instanceof NetError && e.status < 500 && e.status !== 429) throw e;
			lastErr = e;
			if (attempt < net.retries) await sleep(net.backoffMs * 2 ** attempt);
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Run fn over items with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

/** Polite-pool email from <data dir>/fulltext-settings.json (unpaywallEmail); none is invented. */
export function mailtoFor(db: Database): string | null {
	try {
		const file = (db as unknown as { filename?: string }).filename;
		if (!file || file === ":memory:") return null;
		const email = loadSettings(dirname(file)).unpaywallEmail;
		return typeof email === "string" && email.includes("@") ? email : null;
	} catch {
		return null;
	}
}

export function withMailto(url: string, mailto: string | null): string {
	if (!mailto) return url;
	return url + (url.includes("?") ? "&" : "?") + "mailto=" + encodeURIComponent(mailto);
}
