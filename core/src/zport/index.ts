// The "Zotero port" server: 127.0.0.1:23119, where the Zotero Connector browser extension and the Zotero
// word-processor plugins expect Zotero. zotero-next answers there only while Zotero itself is not running
// (the port is free); otherwise Zotero answers and zotero-next picks up the results through sync.
//
// Features register routes here (connector.ts: browser saving; integration.ts: Word citations), each in its
// own file, so they can be built independently.
import type { Database } from "bun:sqlite";
import { routes } from "./routes";
// Feature route files (each registers its routes on import).
import "./connector";
import "./integration";

export { registerZRoute, type ZRoute } from "./routes";
export const ZOTERO_PORT = 23119;

// The Connector calls from web pages' origins (and from the extension); Zotero answers with these headers.
const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, X-Zotero-Version, X-Zotero-Connector-API-Version, X-Metadata, Zotero-Allowed-Request",
	"X-Zotero-Version": "7.0.0",
};

export function withCors(res: Response): Response {
	for (const [k, v] of Object.entries(CORS)) if (!res.headers.has(k)) res.headers.set(k, v);
	return res;
}

export async function handleZRequest(req: Request, db: Database, server: Bun.Server<unknown>): Promise<Response> {
	const url = new URL(req.url);
	if (req.method === "OPTIONS") return withCors(new Response(null, { status: 200 }));
	for (const r of routes) {
		if (r.method !== req.method && !(r.method === "GET" && req.method === "HEAD")) continue;
		if (typeof r.path === "string" ? r.path !== url.pathname : !r.path.test(url.pathname)) continue;
		try {
			const res = await r.handler(req, { db, url, server });
			if (res) return withCors(res);
		}
		catch (e) {
			console.error(`[zport] ${req.method} ${url.pathname} failed:`, e);
			return withCors(Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }));
		}
	}
	return withCors(new Response("No endpoint found", { status: 404 }));
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
		}
		catch {
			server = null; // in use (Zotero is running)
			if (opts.retryMs) timer = setTimeout(tryStart, opts.retryMs);
		}
	};
	tryStart();
	return {
		get listening() { return !!server; },
		stop() { clearTimeout(timer); server?.stop(true); server = null; },
	};
}
