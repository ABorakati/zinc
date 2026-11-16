// The "api" host method: the library page of the extension (library.html, the app's WebAssembly build) sends the app's own
// /api/* requests here, and the host answers them with the core's handleApi against the library file: the same code the desktop
// app runs in-process. Answers go back in the usual chunked `res`/`rc` frames, request bodies come inline or as `up` frames.
//
// What is allowed (read-mostly, for now):
// - GET and HEAD on /api/*: the list, collections, item details, tags, searches, schema, attachment bytes. These read the
//   library and change nothing. Refused even for reads: /api/sync/ and /api/websync/ (account and credential state that belongs
//   to the app, and the sync engine does not run in the host) and /api/integrations/ (tokens of connected services).
// - POST /api/ui/selection: the library view posts the collection it shows (src/store.ts). The core keeps it in this host
//   process's memory only (core/src/connector/state.ts), so it changes nothing on disk. Without it every view change logs an error.
// Everything else (item edits, collections, tags, trash, imports, attachment writes, and the routes that open a file, folder or
// URL on this computer) answers 403 until editing is enabled on purpose.
import type { Database } from "bun:sqlite";
import { isBusyError } from "../../core/src/connector/handlers";

const READ_REFUSED = /^\/api\/(sync|websync|integrations)(\/|$)/;
const WRITES_ALLOWED: { method: string; path: RegExp; why: string }[] = [
	{ method: "POST", path: /^\/api\/ui\/selection$/, why: "the view the page shows; kept in host memory only" },
];

/** null when the request may go to the core, else why it is refused. */
export function apiRefusal(method: string, pathname: string): string | null {
	if (pathname !== "/api" && !pathname.startsWith("/api/")) return "not an /api path";
	if (pathname.split("/").some((s) => s === ".." || s === ".")) return "malformed path";
	if (method === "GET" || method === "HEAD") return READ_REFUSED.test(pathname) ? "not available in the browser library" : null;
	return WRITES_ALLOWED.some((w) => w.method === method && w.path.test(pathname)) ? null : "read-only in the browser library";
}

export interface ApiCall {
	http: string;
	/** "/api/..." with its query string */
	path: string;
	headers: Headers;
	body?: BodyInit;
}

export interface ApiResult {
	status: number;
	headers: Record<string, string>;
	body: Uint8Array;
}

const out = (status: number, body: unknown): ApiResult => ({
	status,
	headers: { "Content-Type": "application/json; charset=utf-8" },
	body: Buffer.from(JSON.stringify(body)),
});

/** One /api request through the allow-list and handleApi (loaded on first use: ping and saves never pay for it). */
export async function forwardApi(getDb: () => Database, call: ApiCall): Promise<ApiResult> {
	const method = call.http.toUpperCase();
	let url: URL;
	try {
		url = new URL(call.path, "http://127.0.0.1");
	} catch {
		return out(400, { error: "malformed path" });
	}
	const refused = apiRefusal(method, url.pathname);
	if (refused)
		return out(refused === "malformed path" || refused === "not an /api path" ? 400 : 403, {
			error: refused,
			method,
			path: url.pathname,
		});
	const req = new Request(url, { method, headers: call.headers, body: method === "GET" || method === "HEAD" ? undefined : call.body });
	let res: Response | null;
	try {
		const { handleApi } = await import("../../core/src/api");
		res = await handleApi(req, getDb());
	} catch (e) {
		if (isBusyError(e))
			return out(503, { error: "The Zinc library is busy (another program is writing to it). Try again in a moment." });
		throw e;
	}
	if (!res) return out(404, { error: "not found" });
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => (headers[k] = v));
	return { status: res.status, headers, body: method === "HEAD" ? new Uint8Array() : new Uint8Array(await res.arrayBuffer()) };
}
