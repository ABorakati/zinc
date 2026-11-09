// Better BibTeX's local HTTP endpoints, on the Zotero-compatible port (core/src/zport, 23119) so tools built for BBT
// (Pandoc filters, Obsidian / VS Code / Emacs / vim citation pickers, zotxt-style tools) work unchanged:
//   /better-bibtex/cayw                       cite as you write (probe, format, items, selected, clipboard)
//   /better-bibtex/json-rpc                   JSON-RPC 2.0 (see rpc.ts)
//   /better-bibtex/export/library?/0/library.bibtex          (also /better-bibtex/library)
//   /better-bibtex/export/collection?/0/<KEY or path>.bibtex  (also /better-bibtex/collection)
//   /better-bibtex/export/item?libraryID=1&citationKeys=a,b&translator=biblatex[&pandocFilterData=true]
//   /better-bibtex/export/selected?bibtex     (also /better-bibtex/select)
//   /better-bibtex/export?/library;id:1/My%20Library.bibtex   (the URL BBT shows for "Download Better BibTeX export")
// Request and response shapes follow BBT's documentation (https://retorque.re/zotero-better-bibtex/), MIT; see NOTICE.
import type { Database } from "bun:sqlite";
import { hostIsLoopback, registerZRoute } from "../zport/routes";
import { gatherItems } from "../io/export";
import { itemToCsl } from "../cite/csl";
import { cawyOutput, translatorFormat, type Pick } from "./cite";
import { exportBetterFormat } from "./export";
import { copyToClipboard, hasPicker, pickInteractively, selectedItemKeys } from "./hooks";
import { getKeyInfos, itemsForCitekey } from "./keys";
import { resolveCollection, handleRpc, hasStateChangingMethod, rpcParseError } from "./rpc";
import type { BbtExportFormat } from "./types";

const text = (body: string, status = 200, extra: Record<string, string> = {}) =>
	new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...extra } });

class HttpFail extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}

/** BBT reads `?/path/x.bib` as a path (a key without a value) and `?probe` as a flag; both end up here. */
export function queryParams(url: URL): { params: Record<string, string>; bare: string } {
	const params: Record<string, string> = {};
	let bare = "";
	for (const [k, v] of url.searchParams) {
		if (v) params[k] = v;
		else {
			params[k] = "";
			if (!bare) bare = k;
		}
	}
	return { params, bare };
}

const isOn = (v: string | undefined) => v !== undefined && !/^(0|false|no|off|n)$/i.test(v);

/**
 * Browsers must not reach the library through these endpoints (CSRF / DNS rebinding / sandboxed frames). Editors, CLIs and
 * Pandoc send no Origin. Any Origin at all is refused, including "null" (sandboxed iframes and data: URLs) and extension
 * origins; so is a cross-site / same-site fetch that carries none (an <img> or <script> tag).
 */
export function browserRejected(req: Request): boolean {
	if (req.headers.get("origin") !== null) return true;
	const site = (req.headers.get("sec-fetch-site") ?? "").toLowerCase();
	if (site === "cross-site" || site === "same-site") return true;
	return !hostIsLoopback(req);
}

function register(path: string | RegExp, handler: (req: Request, db: Database, url: URL) => Promise<Response>): void {
	const run = async (req: Request, ctx: { db: Database; url: URL }) => {
		if (browserRejected(req)) return text("browser access to Better BibTeX endpoints is not allowed", 403);
		try {
			return await handler(req, ctx.db, ctx.url);
		} catch (e) {
			if (e instanceof HttpFail) return text(e.message, e.status);
			const status = (e as { status?: number }).status;
			return text(`${e instanceof Error ? e.message : e}`, typeof status === "number" ? status : 500);
		}
	};
	registerZRoute("GET", path, run);
	registerZRoute("POST", path, run);
}

// ---------------------------------------------------------------- cayw

function picksFor(db: Database, tokens: string[]): Pick[] {
	const infos = getKeyInfos(db, tokens.filter((t) => /^[A-Z0-9]{8}$/.test(t)));
	const out: Pick[] = [];
	for (const raw of tokens) {
		const t = raw.replace(/^@/, "");
		const byKey = itemsForCitekey(db, t)[0];
		if (byKey) out.push({ itemKey: byKey, citationKey: t });
		else if (infos[t]) out.push({ itemKey: t, citationKey: infos[t]!.key });
		else throw new HttpFail(404, `no item found for "${t}"`);
	}
	return out;
}

register("/better-bibtex/cayw", async (req, db, url) => {
	const { params } = queryParams(url);
	if ("probe" in params) return text("ready");
	let picks: Pick[];
	const list = (params.items ?? params.citekeys ?? "").split(",").map((s) => s.trim()).filter(Boolean);
	if (list.length) picks = picksFor(db, list);
	else if ("selected" in params && isOn(params.selected || "true")) {
		const keys = await selectedItemKeys();
		const infos = getKeyInfos(db, keys);
		picks = keys.filter((k) => infos[k]).map((k) => ({ itemKey: k, citationKey: infos[k]!.key }));
		if (!picks.length) return text("", 200);
	} else {
		if (!hasPicker()) return text("no citation picker is available in this Zinc window; pass ?selected=1 or ?items=<citekey,...>", 503);
		const r = await pickInteractively({ format: params.format || "cite", params });
		if (!r || !r.length) return text("");
		const infos = getKeyInfos(db, r.map((p) => p.itemKey));
		picks = r.map((p) => ({ ...p, citationKey: p.citationKey || infos[p.itemKey]?.key || p.itemKey }));
	}
	const out = await cawyOutput(db, picks, params);
	if (params.clipboard) await copyToClipboard(out.body);
	return new Response(out.body, { headers: { "Content-Type": out.contentType } });
});

// ---------------------------------------------------------------- json-rpc

register("/better-bibtex/json-rpc", async (req, db, url) => {
	let body: unknown;
	try {
		if (req.method === "GET") {
			const { bare } = queryParams(url);
			body = JSON.parse(decodeURIComponent(url.search.slice(1)) || bare);
		} else body = await req.json();
	} catch (e) {
		return Response.json(rpcParseError(e instanceof Error ? e.message : String(e)));
	}
	const isGet = req.method === "GET";
	// Methods that change data or write files are POST-only with a JSON body: a GET (an <img> tag, a link) must never run them.
	if (!isGet && hasStateChangingMethod(body)) {
		const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
		if (!/(^|[/+])json(-rpc)?$/.test(type)) return Response.json({ jsonrpc: "2.0", error: { code: -32600, message: "state-changing methods need Content-Type: application/json" }, id: null }, { status: 415 });
	}
	return Response.json(await handleRpc(db, body, { readOnly: isGet }));
});

// ---------------------------------------------------------------- pull exports

function formatFor(ext: string): BbtExportFormat {
	const f = translatorFormat(ext);
	if (!f) throw new HttpFail(404, `Could not export bibliography: unsupported format "${ext}" (use bibtex, biblatex, bib, json, csljson, yaml, cslyaml)`);
	return f;
}

function render(db: Database, format: BbtExportFormat, params: Record<string, string>, scope: { collectionKey?: string; keys?: string[] }): string {
	const includeNotes = isOn(params.exportNotes) && "exportNotes" in params;
	const items = gatherItems(db, { format: "bibtex", includeNotes, ...scope });
	return exportBetterFormat(db, format, items, { includeNotes });
}

function exportLibrary(db: Database, ext: string, params: Record<string, string>): Response {
	return text(render(db, formatFor(ext), params, {}));
}

function exportCollection(db: Database, path: string, ext: string, params: Record<string, string>): Response {
	const key = resolveCollection(db, path, false);
	if (!key) throw new HttpFail(404, `Could not export bibliography: path '${path}' not found`);
	return text(render(db, formatFor(ext), params, { collectionKey: key }));
}

for (const p of ["/better-bibtex/export/library", "/better-bibtex/library"]) {
	register(p, async (_req, db, url) => {
		const { params, bare } = queryParams(url);
		const m = bare.match(/\/?(?:([0-9]+)\/)?library\.([-0-9a-z]+)$/i);
		if (!m) throw new HttpFail(400, `no library/translator found in ${bare}`);
		return exportLibrary(db, m[2]!, params);
	});
}

for (const p of ["/better-bibtex/export/collection", "/better-bibtex/collection"]) {
	register(p, async (_req, db, url) => {
		const { params, bare } = queryParams(url);
		const m = bare.match(/^\/(?:(\d+)\/)?(.*)\.([-0-9a-z]+)$/i);
		if (!m) throw new HttpFail(400, `no library/path/translator found in ${bare}`);
		return exportCollection(db, decodeURIComponent(m[2]!), m[3]!, params);
	});
}

for (const p of ["/better-bibtex/export/selected", "/better-bibtex/select"]) {
	register(p, async (_req, db, url) => {
		const { params, bare } = queryParams(url);
		if (!bare) throw new HttpFail(404, "Could not export bibliography: no format");
		const keys = await selectedItemKeys();
		if (!keys.length) throw new HttpFail(404, "Could not export bibliography: no selection");
		return text(render(db, formatFor(bare), params, { keys }));
	});
}

register("/better-bibtex/export/item", async (_req, db, url) => {
	const { params } = queryParams(url);
	const citationKeys = [...new Set((params.citationKeys ?? "").split(",").filter(Boolean))];
	if (!citationKeys.length) throw new HttpFail(500, "no citation keys provided");
	if (!params.translator) throw new HttpFail(500, "no translator selected");
	const format = translatorFormat(params.translator);
	if (!format) throw new HttpFail(500, `translator ${params.translator} not found`);
	const response: { items: Record<string, unknown>; zotero: Record<string, { itemID: string; uri: string }>; errors: Record<string, string> } = { items: {}, zotero: {}, errors: {} };
	const keys: Record<string, string> = {};
	for (const ck of citationKeys) {
		const found = itemsForCitekey(db, ck);
		if (found.length === 0) response.errors[ck] = "not found";
		else if (found.length === 1) keys[ck] = found[0]!;
		else response.errors[ck] = `${found.length} items found with key "${ck}"`;
	}
	if (!Object.keys(keys).length) throw new HttpFail(500, "no items found");
	const includeNotes = "exportNotes" in params && isOn(params.exportNotes);
	const items = gatherItems(db, { format: "bibtex", keys: Object.values(keys), includeNotes });
	let contents = exportBetterFormat(db, format, items, { includeNotes });
	if (params.pandocFilterData) {
		let filtered: Record<string, unknown>[];
		if (format === "bettercsljson") filtered = JSON.parse(contents) as Record<string, unknown>[];
		else {
			// the filter wants CSL data keyed by citation key whatever the requested translator
			filtered = items.map((i) => ({ ...(itemToCsl(i.data) as Record<string, unknown>), id: Object.entries(keys).find(([, k]) => k === i.data.key)?.[0] }));
		}
		for (const item of filtered) {
			const ck = String(item["citation-key"] ?? item.id);
			response.items[ck] = item;
			response.zotero[ck] = { itemID: keys[ck]!, uri: `http://zotero.org/users/local/items/${keys[ck]}` };
		}
		contents = JSON.stringify(response);
	}
	return text(contents);
});

// the URL BBT's "Download Better BibTeX export..." menu produces: /better-bibtex/export?/library;id:1/Name.bibtex
register("/better-bibtex/export", async (_req, db, url) => {
	const { params, bare } = queryParams(url);
	let path = bare.replace(/^\//, "");
	if (!path) throw new HttpFail(404, "Could not export bibliography: no path");
	const ext = path.match(/[.]([^.]+)$/);
	if (!ext) throw new HttpFail(404, "Could not export bibliography: no type");
	const format = formatFor(ext[1]!);
	path = path.slice(0, -ext[0].length);
	const lib = path.match(/^(group|library);(id|name):([^/]+)[/]/);
	if (lib) {
		if (lib[1] === "group") throw new HttpFail(404, `Could not export bibliography: group ${lib[3]} does not exist (Zinc has a single library)`);
		path = path.slice(lib[0].length);
	}
	const coll = path.match(/^collection(?:;(id|key):(.+?)[/])?/);
	let body: string;
	let name = "My Library";
	if (coll) {
		path = path.slice(coll[0].length);
		const target = coll[1] === "key" ? coll[2]! : decodeURIComponent(path);
		const key = resolveCollection(db, target, false);
		if (!key) throw new HttpFail(404, `Could not export bibliography: path '${path}' not found`);
		name = (db.query("SELECT name FROM collections WHERE key = ?").get(key) as { name: string }).name;
		body = render(db, format, params, { collectionKey: key });
	} else body = render(db, format, params, {});
	return text(body, 200, { "Content-Disposition": `attachment; filename=${JSON.stringify(`${name}.${ext[1]}`)}` });
});
