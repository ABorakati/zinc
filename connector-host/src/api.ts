// The "api" host method: the library page of the extension (library.html, the app's WebAssembly build) sends the app's own
// /api/* requests here, and the host answers them with the core's handleApi against the library file: the same code the desktop
// app runs in-process. Answers go back in the usual chunked `res`/`rc` frames, request bodies come inline or as `up` frames.
//
// The library page edits the library like the desktop app does: item edits, notes, tags, collections, the trash, duplicates,
// imports of text and uploaded files, annotations, page edits. Every change goes through handleApi, so the core's own checks
// (read-only group libraries, file types) apply and the sync outbox records it for the next sync. What stays refused:
// - /api/sync/, /api/websync/ and /api/integrations/, even for reads: account and credential state that belongs to the app
//   (the sync engine does not run in the host), and the tokens of connected services.
// - Routes that act on this computer rather than on the library (LOCAL_ROUTES): opening a URL, file or folder with a desktop
//   program, the desktop app's file-storage settings (/api/files/), and reading a Mendeley database from disk.
// - Imports and exports that name a file or folder on this computer (a `path`, `basePath` or `dir` field, or a linked file):
//   the page uploads the file's bytes or takes the text back instead.
import type { Database } from "bun:sqlite";
import { isBusyError } from "../../core/src/connector/handlers";

const ACCOUNT_ROUTES = /^\/api\/(sync|websync|integrations)(\/|$)/;
const LOCAL_ROUTES: { path: RegExp; why: string }[] = [
	{ path: /^\/api\/open-url$/, why: "opens a URL in a desktop program" },
	{ path: /^\/api\/ui\/reveal$/, why: "shows the item in the desktop app" },
	{ path: /^\/api\/attachments\/[^/]+\/(reveal|open-external)$/, why: "opens the file or its folder in a desktop program" },
	{ path: /^\/api\/files\//, why: "the desktop app's file storage settings and folders" },
	{ path: /^\/api\/io\/mendeley$/, why: "reads a Mendeley database on this computer" },
];
/** Write routes whose body can name a file or folder on this computer (checked by localPathField). */
const PATH_BODY_ROUTES = /^\/api\/(add\/file|io\/(import|export)|translate\/(import|export))$/;
const LOCAL_PATH_KEYS = ["path", "basePath", "dir"];

/** null when the request may go to the core, else why it is refused. */
export function apiRefusal(method: string, pathname: string): string | null {
	if (pathname !== "/api" && !pathname.startsWith("/api/")) return "not an /api path";
	if (pathname.split("/").some((s) => s === ".." || s === ".")) return "malformed path";
	if (ACCOUNT_ROUTES.test(pathname)) return "not available in the browser library";
	if (method === "GET" || method === "HEAD") return null;
	const local = LOCAL_ROUTES.find((r) => r.path.test(pathname));
	return local ? `not available in the browser library: it ${local.why}` : null;
}

/** The body field that names a file or folder on this computer, or null. A body that does not parse is left to the route. */
export async function localPathField(req: Request): Promise<string | null> {
	const type = (req.headers.get("content-type") ?? "").toLowerCase();
	try {
		if (type.startsWith("multipart/form-data")) {
			const form = await req.formData();
			return LOCAL_PATH_KEYS.find((k) => form.has(k)) ?? (form.get("mode") === "linked_file" ? "mode" : null);
		}
		const body = (await req.json()) as Record<string, unknown> | null;
		if (!body || typeof body !== "object" || Array.isArray(body)) return null;
		return LOCAL_PATH_KEYS.find((k) => body[k] !== undefined && body[k] !== null) ?? (body.mode === "linked_file" ? "mode" : null);
	} catch {
		return null;
	}
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
	if (method !== "GET" && method !== "HEAD" && PATH_BODY_ROUTES.test(url.pathname)) {
		const field = await localPathField(req.clone());
		if (field) {
			return out(403, {
				error: `not available in the browser library: \`${field}\` names a file or folder on this computer. Upload the file instead.`,
				method,
				path: url.pathname,
			});
		}
	}
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
