// Route registry for the Zotero port (see index.ts). Separate from index.ts so feature files can import it
// without an import cycle.
import type { Database } from "bun:sqlite";

export type ZRoute = (req: Request, ctx: { db: Database; url: URL; server: Bun.Server<unknown> }) => Response | null | Promise<Response | null>;

export const routes: { method: string; path: string | RegExp; handler: ZRoute }[] = [];

/** Add a handler for METHOD path (exact string or RegExp on the pathname). First match wins. */
export function registerZRoute(method: string, path: string | RegExp, handler: ZRoute) {
	routes.push({ method: method.toUpperCase(), path, handler });
}

// ---------------------------------------------------------------------------------------------------------------- origin policy
//
// Port 23119 is reachable by every web page in the user's browser (a page can fetch http://127.0.0.1:23119), and a page can
// attach any request header it likes once a CORS preflight succeeds, so a "Zotero-Allowed-Request" or
// "X-Zotero-Connector-API-Version" header proves nothing. What a page cannot forge is the Origin header. The legitimate
// callers are: the Connector extension's background page (Origin chrome-extension:// | moz-extension:// |
// safari-web-extension://), native programs (curl, editors, Word plugins; no Origin at all), and the browser-hosted word
// processor add-ins on the integration routes (see INTEGRATION_ORIGINS).

const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension|safari-web-extension|ms-browser-extension):\/\/[^/]+$/i;

export const isExtensionOrigin = (origin: string | null): boolean => !!origin && EXTENSION_ORIGIN.test(origin);

/**
 * Web origins that may call the word-processor integration routes (/connector/document/*) from a browser: the Zotero Word
 * add-in's task pane and the Google Docs plugin's sandboxed Apps Script frame. Extend with ZINC_INTEGRATION_ORIGINS
 * (comma-separated exact origins).
 */
const INTEGRATION_ORIGINS = new Set(["https://zotero.github.io", "https://docs.google.com", "https://script.google.com"]);
const INTEGRATION_ORIGIN_PATTERNS = [/^https:\/\/[a-z0-9-]+-script\.googleusercontent\.com$/i];

export function isIntegrationOrigin(origin: string | null): boolean {
	if (!origin) return false;
	if (INTEGRATION_ORIGINS.has(origin) || INTEGRATION_ORIGIN_PATTERNS.some((re) => re.test(origin))) return true;
	const extra = process.env.ZINC_INTEGRATION_ORIGINS;
	return !!extra && extra.split(",").some((o) => o.trim() === origin);
}

/** True for a request that comes from a web page (or sandboxed frame / data: URL), as opposed to an extension or a program. */
export function isWebRequest(req: Request): boolean {
	const origin = req.headers.get("origin");
	if (origin !== null) return !isExtensionOrigin(origin); // includes "null" (sandboxed frames, data: URLs)
	const site = (req.headers.get("sec-fetch-site") ?? "").toLowerCase();
	return site === "cross-site" || site === "same-site"; // <img>, <script>, navigations from another site: no Origin
}

/** Host must be loopback (a DNS-rebinding page uses its own hostname). */
export function hostIsLoopback(req: Request): boolean {
	let host = (req.headers.get("host") ?? "").toLowerCase();
	host = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d+$/, "");
	return !host || ["127.0.0.1", "localhost", "[::1]"].includes(host);
}

/** The Origin to echo in Access-Control-Allow-Origin for this request, or null when no CORS access should be granted. */
export function allowedCorsOrigin(req: Request, pathname: string): string | null {
	const origin = req.headers.get("origin");
	if (!origin) return null;
	if (isExtensionOrigin(origin)) return origin;
	if (pathname.startsWith("/connector/document/") && isIntegrationOrigin(origin)) return origin;
	return null;
}
