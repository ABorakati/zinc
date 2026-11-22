// Cross-origin access to /api for Zinc's Office.js Word add-in. Its task pane is an https page (the add-in's own local server,
// https://localhost:44321 by default) that calls this server on http://127.0.0.1. Only these exact origins get CORS headers,
// only for GET and POST, and never "Access-Control-Allow-Origin: *": any other web page is still refused (apiRequestRejected).
// Add origins with ZINC_TASKPANE_ORIGINS (comma-separated, exact, e.g. "https://localhost:3000").
const DEFAULT_ORIGINS = ["https://localhost:44321", "https://127.0.0.1:44321", "https://[::1]:44321"];

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);

export function isTaskPaneOrigin(origin: string | null): boolean {
	if (!origin) return false;
	if (DEFAULT_ORIGINS.includes(origin)) return true;
	const extra = process.env.ZINC_TASKPANE_ORIGINS;
	return !!extra && extra.split(",").some((o) => o.trim() === origin);
}

const isApi = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/");

/** The task pane's Origin to echo for this /api request, or null when the request gets no CORS access. */
export function taskPaneOrigin(req: Request): string | null {
	const origin = req.headers.get("origin");
	if (!isTaskPaneOrigin(origin) || !isApi(new URL(req.url).pathname)) return null;
	return origin;
}

/**
 * The answer to a browser's CORS preflight (OPTIONS) from the task pane, or null for any other request (which then goes on as
 * before). Private Network Access: Chromium asks before a public https page may reach loopback (Word on the web), and gets a yes.
 */
export function taskPanePreflight(req: Request): Response | null {
	if (req.method !== "OPTIONS") return null;
	const origin = taskPaneOrigin(req);
	if (!origin) return null;
	const method = (req.headers.get("access-control-request-method") ?? "").toUpperCase();
	if (!ALLOWED_METHODS.has(method)) return new Response(null, { status: 403, headers: { Vary: "Origin" } });
	const headers: Record<string, string> = {
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "GET, POST",
		"Access-Control-Allow-Headers": "Content-Type",
		"Access-Control-Max-Age": "600",
		Vary: "Origin",
	};
	if ((req.headers.get("access-control-request-private-network") ?? "").toLowerCase() === "true")
		headers["Access-Control-Allow-Private-Network"] = "true";
	return new Response(null, { status: 204, headers });
}

/** res with the CORS headers that let the task pane read it (unchanged when origin is null). */
export function withTaskPaneCors(res: Response, origin: string | null): Response {
	if (!origin) return res;
	let out = res;
	try {
		out.headers.set("Access-Control-Allow-Origin", origin);
	} catch {
		out = new Response(res.body, res); // a response with immutable headers: copy it
		out.headers.set("Access-Control-Allow-Origin", origin);
	}
	out.headers.append("Vary", "Origin");
	return out;
}
