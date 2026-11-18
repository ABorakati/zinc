// Talking to core over HTTP from a `where: "host"` handler.
import { witError, type HandlerContext, type WitErrorTag } from "../registry";

export interface CoreInit {
	method?: string;
	/** Sent as JSON (Content-Type: application/json, which core's CSRF guard requires for writes). */
	json?: unknown;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

/** Map a core HTTP status to a `types.error` tag. */
export function tagForStatus(status: number): WitErrorTag {
	if (status === 404) return "not-found";
	if (status === 400 || status === 422) return "invalid-argument";
	if (status === 403) return "read-only";
	if (status === 409) return "conflict";
	if (status === 413 || status === 429) return "limit-exceeded";
	if (status === 501 || status === 503) return "unavailable";
	return "internal";
}

export function coreBase(ctx: HandlerContext): string {
	if (!ctx.coreUrl) throw witError("unavailable", "no core URL: the plugin host was started without one");
	return ctx.coreUrl.replace(/\/+$/, "");
}

/** A failed core call as a WitError. `body` is what core answered (`{error: "..."}` normally). */
export async function coreFailure(res: Response, what: string): Promise<never> {
	let msg = "";
	try {
		const t = await res.text();
		try {
			msg = (JSON.parse(t) as { error?: string }).error ?? t;
		} catch {
			msg = t;
		}
	} catch {
		// no body
	}
	throw witError(tagForStatus(res.status), `${what}: ${msg || res.statusText} (HTTP ${res.status})`.slice(0, 500));
}

export async function core(ctx: HandlerContext, path: string, init: CoreInit = {}): Promise<Response> {
	const url = coreBase(ctx) + path;
	let res: Response;
	try {
		res = await fetch(url, {
			method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
			headers: { ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}), ...init.headers },
			body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
			signal: init.signal,
		});
	} catch (e) {
		throw witError("unavailable", `core is not reachable: ${(e as Error).message}`);
	}
	if (!res.ok) await coreFailure(res, `${init.method ?? "GET"} ${path.split("?")[0]}`);
	return res;
}

export async function coreJson<T = any>(ctx: HandlerContext, path: string, init: CoreInit = {}): Promise<T> {
	return (await (await core(ctx, path, init)).json()) as T;
}

/** `?a=1&b=2`: undefined and empty values are left out. */
export function qs(params: Record<string, string | number | boolean | undefined | null | string[]>): string {
	const p = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v === undefined || v === null || v === "") continue;
		if (Array.isArray(v)) {
			if (v.length) p.set(k, v.join(","));
		} else p.set(k, String(v));
	}
	const s = p.toString();
	return s ? `?${s}` : "";
}

/** Run `fn` over `items` with at most `n` in flight; keeps order. */
export async function pmap<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
	return out;
}

/** JSON text from a handler argument (`json` typed). A parse failure is `invalid-argument`. */
export function parseJson(text: string, what: string): any {
	try {
		return JSON.parse(text);
	} catch {
		throw witError("invalid-argument", `${what} is not valid JSON`);
	}
}

const KEY_CHARS = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
const issued = new Set<string>();

/** `count` fresh 8-character keys. A key is never given out twice by this process. */
export function newKeys(count: number): string[] {
	const out: string[] = [];
	while (out.length < count) {
		const b = crypto.getRandomValues(new Uint8Array(8));
		let k = "";
		for (const x of b) k += KEY_CHARS[x % KEY_CHARS.length];
		if (issued.has(k)) continue;
		issued.add(k);
		out.push(k);
	}
	if (issued.size > 100_000) issued.clear();
	return out;
}

let rpcId = 1;

/**
 * Call one of core's MCP tools (POST /mcp, stateless JSON-RPC) and return its text. Used where core has a tool but no plain HTTP
 * route (get_fulltext, get_file_path). Throws `unavailable` when /mcp does not answer, `internal` when the tool reports an error.
 */
export async function mcpText(ctx: HandlerContext, tool: string, args: Record<string, unknown>): Promise<string> {
	let res: Response;
	try {
		res = await fetch(coreBase(ctx) + "/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name: tool, arguments: args } }),
		});
	} catch (e) {
		throw witError("unavailable", `core is not reachable: ${(e as Error).message}`);
	}
	if (!res.ok) throw witError("unavailable", `core /mcp answered HTTP ${res.status}`);
	const body = (await res.json()) as { result?: { content?: { type: string; text?: string }[]; isError?: boolean }; error?: { message: string } };
	if (body.error) throw witError("internal", `mcp ${tool}: ${body.error.message}`);
	const text = (body.result?.content ?? []).map((c) => c.text ?? "").join("\n");
	if (body.result?.isError) throw witError("internal", `mcp ${tool}: ${text}`.slice(0, 300));
	return text;
}
