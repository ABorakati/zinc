// The "Zotero port" server: 127.0.0.1:23119, where the Zotero Connector browser extension and the Zotero
// word-processor plugins expect Zotero. zotero-next answers there only while Zotero itself is not running
// (the port is free); otherwise Zotero answers and zotero-next picks up the results through sync.
//
// Features register routes here (connector.ts: browser saving; integration.ts: Word citations), each in its
// own file, so they can be built independently.
import type { Database } from "bun:sqlite";
import { allowedCorsOrigin, hostIsLoopback, isIntegrationOrigin, isWebRequest, routes } from "./routes";
// Feature route files (each registers its routes on import).
import "./connector";
import "./integration";
import "../bbt/http"; // Better BibTeX: /better-bibtex/* (cayw, json-rpc, exports)

export { registerZRoute, type ZRoute } from "./routes";
export const ZOTERO_PORT = 23119;

// CORS: only origins that legitimately call this port get Access-Control-* headers (see the origin policy in routes.ts).
// A web page is refused outright; it never gets "Access-Control-Allow-Origin: *".
const CORS_STATIC = {
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, X-Zotero-Version, X-Zotero-Connector-API-Version, X-Metadata, Zotero-Allowed-Request",
	"Access-Control-Max-Age": "600",
	Vary: "Origin",
	"X-Zotero-Version": "7.0.0",
};

export function withCors(res: Response, allowedOrigin: string | null = null): Response {
	for (const [k, v] of Object.entries(CORS_STATIC)) {
		// the Access-Control headers are only for an allowed cross-origin caller; Vary and X-Zotero-Version are for everyone
		if (k.startsWith("Access-Control-") && !allowedOrigin) continue;
		if (!res.headers.has(k)) res.headers.set(k, v);
	}
	if (allowedOrigin) res.headers.set("Access-Control-Allow-Origin", allowedOrigin);
	return res;
}

const forbidden = (why: string) =>
	new Response(why, { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Zotero-Version": "7.0.0" } });

/** The Zotero port's gate: loopback Host, and no web page except /connector/ping navigation and the integration origins. */
function gate(req: Request, url: URL): Response | null {
	if (!hostIsLoopback(req)) return forbidden("forbidden host");
	if (!isWebRequest(req)) return null;
	const origin = req.headers.get("origin");
	// Opening http://127.0.0.1:23119/connector/ping in a tab (Zotero's "is it running" check) stays possible.
	if (url.pathname === "/connector/ping" && req.method === "GET" && req.headers.get("sec-fetch-mode") === "navigate" && origin === null)
		return null;
	if ((url.pathname.startsWith("/connector/document/") || url.pathname === "/connector/ping") && isIntegrationOrigin(origin)) return null;
	return forbidden("web pages may not access this endpoint");
}

export async function handleZRequest(req: Request, db: Database, server: Bun.Server<unknown>): Promise<Response> {
	const url = new URL(req.url);
	const refused = gate(req, url);
	if (refused) return refused;
	const cors = allowedCorsOrigin(req, url.pathname);
	if (req.method === "OPTIONS") return withCors(new Response(null, { status: 200 }), cors);
	for (const r of routes) {
		if (r.method !== req.method && !(r.method === "GET" && req.method === "HEAD")) continue;
		if (typeof r.path === "string" ? r.path !== url.pathname : !r.path.test(url.pathname)) continue;
		try {
			const res = await r.handler(req, { db, url, server });
			if (res) return withCors(res, cors);
		} catch (e) {
			console.error(`[zport] ${req.method} ${url.pathname} failed:`, e);
			return withCors(Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }), cors);
		}
	}
	return withCors(new Response("No endpoint found", { status: 404 }), cors);
}

/**
 * Listen on 23119 if it is free. Returns null when Zotero (or anything else) already has the port; `retryMs`
 * keeps trying, so zotero-next takes over when Zotero quits.
 */
export function startZoteroPort(db: Database, opts: { port?: number; retryMs?: number; onStart?: (port: number) => void } = {}) {
	const port = opts.port ?? ZOTERO_PORT;
	let server: Bun.Server<unknown> | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const tryStart = () => {
		try {
			server = Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: 120, fetch: (req, srv) => handleZRequest(req, db, srv) });
			opts.onStart?.(port);
		} catch {
			server = null; // in use (Zotero is running)
			if (opts.retryMs) timer = setTimeout(tryStart, opts.retryMs);
		}
	};
	tryStart();
	return {
		get listening() {
			return !!server;
		},
		stop() {
			clearTimeout(timer);
			server?.stop(true);
			server = null;
		},
	};
}
