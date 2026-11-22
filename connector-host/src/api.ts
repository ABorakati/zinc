// The "api" host method: the library page of the extension (library.html, the app's WebAssembly build) and the reader tab send the
// app's own /api/* requests here, and the host answers them with the core's handleApi against the library file: the same code the
// desktop app runs in-process. Answers go back in the usual chunked `res`/`rc` frames, request bodies come inline or as `up` frames.
//
// Deny by default. A request reaches the core only when (method, route) is in ROUTES below, which lists what the two pages really
// call (gpui-ui/src, gpui-ui/web, reader-host/src). Everything else is refused, so a route added to the core later stays closed
// here until someone reads it and lists it. The list leaves out, even for reads:
// - Account and credential state: /api/sync/, /api/websync/, /api/integrations/ and the Find Full Text settings and sign-in.
// - Routes that act on this computer rather than on the library: opening a URL, file or folder with a desktop program, the desktop
//   app's file-storage settings and folders (/api/files/), a Mendeley database on disk, the Better BibTeX auto-exports (they write
//   to a path and list their paths) and the translator folder.
// And no write names a file or folder on this computer (a `path`, `basePath` or `dir` field at any depth, a linked file, a multipart
//   field of those names): the page uploads the file's bytes or takes the text back instead.
//
// The request the core sees is the one that was checked. The path is split, decoded once and each segment matched against the list;
// the core then gets a path rebuilt from those segments (so the spelling the core would have read differently, such as a trailing
// slash, an encoded letter, an empty segment, `.` or `..`, a backslash, never reaches it), the query rebuilt from the parameters
// that route takes, and the body bytes that were parsed here.
import type { Database } from "bun:sqlite";
import { isBusyError } from "../../core/src/connector/handlers";

type Body = "none" | "json" | "json-or-form";
export interface Rule {
	methods: readonly string[];
	/** "a/b/:key" without /api: `:key` an item, collection or attachment key, `:id` a job id, `:style` a citation style id */
	path: string;
	/** the query parameters this route takes (none listed: none allowed) */
	query?: readonly string[];
	/** what the core reads from the body; default: "json" for a write, "none" for a read. "none" drops any body. */
	body?: Body;
	/** top-level body fields that are not paths here although the name is on the list (searches/run's `dir` is a sort direction) */
	allowKeys?: readonly string[];
}

const ITEM_QUERY = [
	"library",
	"collection",
	"tag",
	"q",
	"sort",
	"dir",
	"then",
	"limit",
	"offset",
	"search",
	"qmode",
	"unfiled",
	"publications",
	"trash",
	"fields",
	"include",
] as const;

const GET = ["GET"] as const;
const POST = ["POST"] as const;

/** Every (method, route) the pages call. A reader of a new route checks it for a local path, a process, a credential or a setting. */
export const ROUTES: readonly Rule[] = [
	// library
	{ methods: GET, path: "libraries" },
	{ methods: GET, path: "schema" },
	{ methods: GET, path: "tags", query: ["library"] },
	{ methods: ["GET", "PUT"], path: "tag-colors" },
	{ methods: GET, path: "search", query: ["q", "limit", "offset", "library"] },
	// items
	{ methods: GET, path: "items", query: ITEM_QUERY },
	{ methods: POST, path: "items" },
	{ methods: GET, path: "items/groups", query: [...ITEM_QUERY, "by"] },
	{ methods: GET, path: "items/index", query: [...ITEM_QUERY, "key"] },
	{ methods: ["GET", "PATCH"], path: "items/:key" },
	{ methods: POST, path: "items/:key/duplicate", body: "none" },
	{ methods: ["POST", "DELETE"], path: "items/:key/tags" },
	{ methods: ["POST", "DELETE"], path: "items/:key/related" },
	// collections
	{ methods: GET, path: "collections", query: ["library"] },
	{ methods: POST, path: "collections" },
	{ methods: ["PATCH"], path: "collections/:key" },
	{ methods: ["DELETE"], path: "collections/:key", body: "none" },
	{ methods: ["POST", "DELETE"], path: "collections/:key/items" },
	// saved searches
	{ methods: ["GET", "POST"], path: "searches" },
	{ methods: POST, path: "searches/run", allowKeys: ["dir"] },
	{ methods: ["GET", "PATCH", "DELETE"], path: "searches/:key" },
	// attachments: bytes, the reader's page edits, annotations, view state (the file's own path is never in a request or an answer)
	{ methods: ["GET", "HEAD", "PUT"], path: "attachments/:key/file" },
	{ methods: ["GET", "PUT", "DELETE"], path: "attachments/:key/annotations" },
	{ methods: ["GET", "PUT"], path: "attachments/:key/view-state" },
	// the library view the connector saves into
	{ methods: ["GET", "POST"], path: "ui/selection" },
	// duplicates
	{ methods: GET, path: "duplicates", query: ["summary", "library"] },
	{ methods: GET, path: "duplicates/set", query: ["keys"] },
	{ methods: POST, path: "duplicates/merge" },
	{ methods: POST, path: "duplicates/not-duplicates" },
	// trash, tags, attachment file names
	{ methods: GET, path: "maintenance/trash", query: ["olderThanDays", "library"] },
	{ methods: GET, path: "maintenance/tags/automatic", query: ["library"] },
	{ methods: POST, path: "maintenance/empty-trash" },
	{ methods: POST, path: "maintenance/erase" },
	{ methods: POST, path: "maintenance/erase/preview" },
	{ methods: POST, path: "maintenance/tags/rename" },
	{ methods: POST, path: "maintenance/tags/delete" },
	{ methods: POST, path: "maintenance/tags/delete-automatic" },
	{ methods: POST, path: "maintenance/rename-files" },
	// adding: identifiers, links, uploaded bytes (JSON `dataBase64` or a multipart `file`), metadata retrieval
	{ methods: POST, path: "add/identifier" },
	{ methods: POST, path: "add/link" },
	{ methods: POST, path: "add/create-parent" },
	{ methods: POST, path: "add/retrieve-metadata" },
	{ methods: POST, path: "add/file", body: "json-or-form" },
	// import from text, export to text
	{ methods: POST, path: "io/import" },
	{ methods: POST, path: "io/export" },
	{ methods: POST, path: "translate/web" },
	{ methods: POST, path: "translate/web/select" },
	{ methods: POST, path: "translate/import" },
	{ methods: POST, path: "translate/export" },
	{ methods: GET, path: "translate/import-formats", query: ["all"] },
	{ methods: GET, path: "translate/export-formats", query: ["all"] },
	// citations
	{ methods: ["GET", "PUT"], path: "cite/settings" },
	{ methods: GET, path: "cite/styles", query: ["q", "format", "field", "installed", "quick", "limit", "offset"] },
	{ methods: POST, path: "cite/styles/install" },
	{ methods: GET, path: "cite/styles/preview", query: ["id", "items", "locale"] },
	{ methods: ["DELETE"], path: "cite/styles/:style", body: "none" },
	{ methods: POST, path: "cite/format" },
	// references (the reader's bibliography)
	{ methods: GET, path: "references/lookup", query: ["doi", "title"] },
	{ methods: POST, path: "references/add" },
	{ methods: GET, path: "references/:key", query: ["refresh"] },
	// Find Full Text jobs (its settings and sign-in are not here)
	{ methods: POST, path: "fulltext/find" },
	{ methods: GET, path: "fulltext/jobs/:id" },
	{ methods: POST, path: "fulltext/jobs/:id/cancel", body: "none" },
	// Better BibTeX keys and Quick Copy (not the auto-exports)
	{ methods: ["GET", "POST"], path: "bbt/settings" },
	{ methods: POST, path: "bbt/formula" },
	{ methods: GET, path: "bbt/keys", query: ["items"] },
	{ methods: POST, path: "bbt/pin" },
	{ methods: POST, path: "bbt/unpin" },
	{ methods: POST, path: "bbt/refresh" },
	{ methods: POST, path: "bbt/cite" },
];

const SEGMENT = {
	":key": /^[A-Za-z0-9]{1,32}$/,
	":id": /^[A-Za-z0-9_-]{1,64}$/,
	":style": /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/,
} as const;

const COMPILED = ROUTES.map((r) => ({ ...r, parts: r.path.split("/") }));

function matches(parts: readonly string[], segments: readonly string[]): boolean {
	return (
		parts.length === segments.length &&
		parts.every((p, i) => (p.startsWith(":") ? SEGMENT[p as keyof typeof SEGMENT].test(segments[i]!) : p === segments[i]))
	);
}

/** A request the checks let through: the exact URL the core is given, and the rule that allowed it. */
export interface ApiRoute {
	method: string;
	url: string;
	rule: Rule;
}
export interface Refusal {
	status: number;
	error: string;
}

const refuse = (status: number, error: string): Refusal => ({ status, error });
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Split "/api/x/y?a=b" into its decoded segments and query pairs, or say why it is malformed. */
function parsePath(raw: unknown): { segments: string[]; pairs: [string, string][] } | Refusal {
	if (typeof raw !== "string" || raw.length > 16_384) return refuse(400, "malformed path");
	if (!/^[\x21-\x7e]*$/.test(raw)) return refuse(400, "malformed path"); // controls, NUL, spaces, anything not ASCII
	if (raw.includes("\\") || raw.includes("#")) return refuse(400, "malformed path");
	const q = raw.indexOf("?");
	const pathPart = q < 0 ? raw : raw.slice(0, q);
	const queryPart = q < 0 ? "" : raw.slice(q + 1);
	if (pathPart !== "/api" && !pathPart.startsWith("/api/")) return refuse(400, "not an /api path");
	const rawSegments = pathPart.slice(1).split("/").slice(1); // "/api/a/b" -> ["a", "b"]
	const segments: string[] = [];
	for (const s of rawSegments) {
		if (s === "") return refuse(400, "malformed path");
		if (s === "." || s === "..") return refuse(400, "malformed path");
		let d: string;
		try {
			d = decodeURIComponent(s);
		} catch {
			return refuse(400, "malformed path");
		}
		if (d === "" || d === "." || d === ".." || d.includes("/") || d.includes("\\") || CONTROL.test(d)) return refuse(400, "malformed path");
		segments.push(d);
	}
	const pairs: [string, string][] = [];
	if (queryPart) {
		for (const part of queryPart.split("&")) {
			if (!part) continue;
			const eq = part.indexOf("=");
			const decode = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));
			let name: string;
			let value: string;
			try {
				name = decode(eq < 0 ? part : part.slice(0, eq));
				value = eq < 0 ? "" : decode(part.slice(eq + 1));
			} catch {
				return refuse(400, "malformed path");
			}
			if (name.includes("\u0000") || value.includes("\u0000")) return refuse(400, "malformed path");
			pairs.push([name, value]);
		}
	}
	return { segments, pairs };
}

/** The route the request names, with the URL to give the core, or why it is refused. */
export function resolveApi(method: string, rawPath: unknown): ApiRoute | Refusal {
	const parsed = parsePath(rawPath);
	if ("status" in parsed) return parsed;
	const { segments, pairs } = parsed;
	const named = COMPILED.filter((r) => matches(r.parts, segments));
	const rule = named.find((r) => r.methods.includes(method));
	if (!rule) {
		return named.length ? refuse(405, "method not allowed") : refuse(403, "not available in the browser library");
	}
	const seen = new Set<string>();
	for (const [name] of pairs) {
		if (!rule.query?.includes(name) || seen.has(name)) return refuse(400, `query parameter not accepted here: ${name}`);
		seen.add(name);
	}
	const path = "/api/" + segments.map(encodeURIComponent).join("/");
	const search = new URLSearchParams(pairs).toString();
	const url = `http://127.0.0.1${path}${search ? `?${search}` : ""}`;
	// what the core will read as the path is what was matched, byte for byte
	if (new URL(url).pathname !== path) return refuse(400, "malformed path");
	return { method, url, rule };
}

/** null when the request may go to the core, else why it is refused. `rawPath` is the path as sent, with its query string. */
export function apiRefusal(method: string, rawPath: string): string | null {
	const r = resolveApi(method.toUpperCase(), rawPath);
	return "error" in r ? r.error : null;
}

// Body fields that name a file or folder on this computer, compared without case, `_`, `-` and spaces.
const LOCAL_PATH_KEYS = new Set([
	"path",
	"basepath",
	"dir",
	"localpath",
	"filepath",
	"folder",
	"directory",
	"dirpath",
	"destination",
	"outdir",
	"outputdir",
	"outputpath",
	"targetpath",
	"targetdir",
	"sourcepath",
]);
const normKey = (k: string) => k.toLowerCase().replace(/[\s_-]/g, "");
const isLinkedFile = (k: string, v: unknown) => {
	const n = normKey(k);
	return (n === "mode" || n === "linkmode") && typeof v === "string" && v.trim().toLowerCase() === "linked_file";
};

/** The field that names a local file or folder anywhere in a parsed JSON body (any depth), or null. Too deep: refused. */
export function localPathField(v: unknown, depth = 0, allow: readonly string[] = []): string | null {
	if (depth > 64) return "(nested too deeply)";
	if (Array.isArray(v)) {
		for (const x of v) {
			const f = localPathField(x, depth + 1);
			if (f) return f;
		}
		return null;
	}
	if (!v || typeof v !== "object") return null;
	for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
		if ((LOCAL_PATH_KEYS.has(normKey(k)) && !(depth === 0 && allow.includes(k))) || isLinkedFile(k, x)) return k;
		const f = localPathField(x, depth + 1);
		if (f) return f;
	}
	return null;
}

const isMultipart = (type: string | null) => (type ?? "").toLowerCase().startsWith("multipart/form-data");

export interface CheckedBody {
	bytes: Uint8Array;
	contentType: string;
}

/**
 * The body as it is given to the core: the same bytes that were parsed here. Parsed the way the core parses them (a JSON route
 * reads JSON whatever the declared type; the add-file route reads a multipart body when the type says so). Returns a Refusal
 * for a body that does not parse, and for one that names a local file or folder.
 */
export async function checkBody(rule: Rule, bytes: Uint8Array, declaredType: string | null): Promise<CheckedBody | Refusal | null> {
	if (!bytes.length) return null; // nothing to read: the core answers 400 where it needs one
	const form = rule.body === "json-or-form" && isMultipart(declaredType);
	const contentType = form ? declaredType! : "application/json";
	const probe = new Request("http://127.0.0.1/", { method: "POST", headers: { "Content-Type": contentType }, body: bytes as BodyInit });
	let field: string | null;
	try {
		if (form) {
			const data = await probe.formData();
			field = null;
			for (const [k, v] of data.entries()) {
				if (LOCAL_PATH_KEYS.has(normKey(k)) || (typeof v === "string" && isLinkedFile(k, v))) {
					field = k;
					break;
				}
			}
		} else {
			field = localPathField(await probe.json(), 0, rule.allowKeys);
		}
	} catch {
		return refuse(400, "the request body could not be read as " + (form ? "a form" : "JSON"));
	}
	if (field) {
		return refuse(
			403,
			`not available in the browser library: \`${field}\` names a file or folder on this computer. Upload the file instead.`,
		);
	}
	return { bytes, contentType };
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
	const method = String(call.http).toUpperCase();
	const route = resolveApi(method, call.path);
	if ("status" in route) return out(route.status, { error: route.error, method, path: String(call.path).split("?")[0] });
	const headers = new Headers();
	let body: Uint8Array | undefined;
	if (method !== "GET" && method !== "HEAD" && route.rule.body !== "none" && call.body !== undefined) {
		const tmp = new Request("http://127.0.0.1/", { method: "POST", headers: call.headers, body: call.body });
		const declared = tmp.headers.get("content-type"); // before the body is read: the boundary of a FormData
		const bytes = new Uint8Array(await tmp.arrayBuffer());
		const checked = await checkBody(route.rule, bytes, declared);
		if (checked && "status" in checked) return out(checked.status, { error: checked.error, method, path: new URL(route.url).pathname });
		if (checked) {
			body = checked.bytes;
			headers.set("Content-Type", checked.contentType);
		}
	}
	const range = call.headers.get("range");
	if (range && (method === "GET" || method === "HEAD")) headers.set("Range", range);
	const req = new Request(route.url, { method, headers, body: body as BodyInit | undefined });
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
	const rh: Record<string, string> = {};
	res.headers.forEach((v, k) => (rh[k] = v));
	return { status: res.status, headers: rh, body: method === "HEAD" ? new Uint8Array() : new Uint8Array(await res.arrayBuffer()) };
}
