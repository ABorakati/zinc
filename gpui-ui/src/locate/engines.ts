// Zotero-compatible Locate engines: the model, the parsers (Zotero's locate/engines.json and an OpenSearch description) and the
// URL template expansion. Pure: no app state, no I/O except the injected fetch of fetchOpenSearch. Unit-tested in engines.test.ts.
//
// Semantics follow Zotero's xpcom/locateManager.js (LocateEngine.getItemSubmission / _lookupParam):
//   {z:title}      a Zotero item field (namespace http://www.zotero.org/namespaces/openSearch#); also z:year, z:openURL
//   {rft:aulast}   an OpenURL KEV field (rft.aulast ...), under any of the OpenURL item namespaces
//   {searchTerms}  no prefix: the item title
//   {x?}           optional: replaced by "" when the item has no value; without "?" a missing value means no link at all
// Values are URL-encoded here (Zotero encodes the namespaced ones but pastes the title and the openURL context in raw, which
// breaks on "&" or "#" in a title).
import { openUrlParams, wellFormed, type LocateItem } from "./openurl";

/** encodeURIComponent that accepts any string: a lone surrogate would make the original throw a URIError. */
const enc = (s: string): string => encodeURIComponent(wellFormed(s));

export interface LocateEngine {
	name: string;
	alias: string;
	description: string | null;
	/** file:// or http(s) URL of the icon, as Zotero stores it (not drawn by the menu: lucide icons only). */
	icon: string | null;
	iconSourceUri: string | null;
	urlTemplate: string;
	/** Extra query parameters; values may be {ns:param} references. */
	urlParams: Record<string, string>;
	/** Namespace prefix -> URI, as declared in the OpenSearch description (Zotero's _urlNamespaces). */
	urlNamespaces: Record<string, string>;
	method: "GET" | "POST";
	/** Zotero's inverse `_hidden`. */
	enabled: boolean;
}

const ZOTERO_NS = "http://www.zotero.org/namespaces/openSearch#";
const OPENSEARCH_NS = "http://a9.com/-/spec/opensearch/1.1/";
const CTX_NS = "info:ofi/fmt:kev:mtx:ctx";
const OPENURL_ITEM_NS = [
	"info:ofi/fmt:kev:mtx:journal",
	"info:ofi/fmt:kev:mtx:book",
	"info:ofi/fmt:kev:mtx:patent",
	"info:ofi/fmt:kev:mtx:sch_svc",
	"info:ofi/fmt:kev:mtx:dissertation",
];
const CTX_MAP: Record<string, string> = { version: "ctx_ver", identifier: "rfr_id", format: "rft_val_fmt" };
const OPENSEARCH_NAMESPACES = [
	"http://a9.com/-/spec/opensearch/1.1/",
	"http://a9.com/-/spec/opensearch/1.0/",
	"http://a9.com/-/spec/opensearchdescription/1.1/",
	"http://a9.com/-/spec/opensearchdescription/1.0/",
];

/** Zotero's built-in engine set (resource/schema/engines.json after its migrations: just Google Scholar). */
export function defaultEngines(): LocateEngine[] {
	return [
		{
			name: "Google Scholar",
			alias: "Untitled",
			description: "Google Scholar Search",
			icon: null,
			iconSourceUri: "chrome://zotero/skin/logos/google-scholar.ico",
			urlTemplate:
				"https://scholar.google.com/scholar?as_q=&as_epq={z:title}&as_occt=title&as_sauthors={rft:aufirst?}+{rft:aulast?}&as_ylo={z:year?}&as_yhi={z:year?}&as_sdt=1.&as_sdtp=on&as_sdtf=&as_sdts=22&",
			urlParams: {},
			urlNamespaces: { rft: "info:ofi/fmt:kev:mtx:journal", z: ZOTERO_NS, "": OPENSEARCH_NS },
			method: "GET",
			enabled: true,
		},
	];
}

// ---------------------------------------------------------------- parsing

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** One entry of Zotero's engines.json (the `_name`, `_urlTemplate`, ... keys of its serialised LocateEngine); null when unusable. */
export function parseZoteroEngine(raw: unknown): LocateEngine | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const name = str(o._name);
	const urlTemplate = str(o._urlTemplate);
	if (!name || !urlTemplate) return null;
	const dict = (v: unknown): Record<string, string> => {
		const out: Record<string, string> = {};
		// Zotero keeps named params on a JS array, which JSON.stringify drops: the stored value is usually `[]`
		if (v && typeof v === "object" && !Array.isArray(v)) {
			for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x;
		}
		return out;
	};
	return {
		name,
		alias: str(o._alias) ?? name,
		description: str(o._description),
		icon: str(o._icon),
		iconSourceUri: str(o._iconSourceURI),
		urlTemplate,
		urlParams: dict(o._urlParams),
		urlNamespaces: dict(o._urlNamespaces),
		method: typeof o._method === "string" && o._method.toUpperCase() === "POST" ? "POST" : "GET",
		enabled: o._hidden !== true,
	};
}

/** Zotero's engines.json text -> engines (unusable entries dropped). Throws on text that is not a JSON array. */
export function parseZoteroEngines(text: string): LocateEngine[] {
	const v = JSON.parse(text) as unknown;
	if (!Array.isArray(v)) throw new Error("engines.json is not a list of engines");
	return v.map(parseZoteroEngine).filter((e): e is LocateEngine => !!e);
}

/** The engines as Zotero's engines.json would hold them (for tests and export; the app never writes Zotero's file). */
export function toZoteroJson(engines: LocateEngine[]): unknown[] {
	return engines.map((e) => ({
		_name: e.name,
		_alias: e.alias,
		_description: e.description,
		_icon: e.icon,
		_hidden: !e.enabled,
		_urlTemplate: e.urlTemplate,
		_urlParams: e.urlParams,
		_urlNamespaces: e.urlNamespaces,
		_iconSourceURI: e.iconSourceUri,
		...(e.method === "POST" ? { _method: "POST" } : {}),
	}));
}

const decodeXml = (s: string): string =>
	s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
		const l = e.toLowerCase();
		if (l === "amp") return "&";
		if (l === "lt") return "<";
		if (l === "gt") return ">";
		if (l === "quot") return '"';
		if (l === "apos") return "'";
		const cp = l.startsWith("#x") ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
		return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""; // above U+10FFFF fromCodePoint throws
	});

/** Attributes of a start tag's text (`a="x" b='y'`), entity-decoded. */
function attrsOf(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]!] = decodeXml(m[2] ?? m[3] ?? "");
	return out;
}

/** Text of the first `<tag>..</tag>` child-or-descendant (OpenSearch tags carry no nesting), trimmed; null when absent/empty. */
function textOf(xml: string, tag: string): string | null {
	const m = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}\\s*>`, "i").exec(xml);
	if (!m) return null;
	const inner = (m[1] ?? "").replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
	return decodeXml(inner).trim() || null;
}

/**
 * An OpenSearch description document -> an engine (Zotero's LocateEngine.initWithXML): ShortName/LongName/Description, the first
 * text/html Url with rel "results" (or no rel), its Param children and the xmlns declarations of the root and that Url, and the
 * 16x16 (or unsized) Image as the icon source. Throws with a reason when the document is not usable.
 */
export function parseOpenSearch(xml: string): LocateEngine {
	const rootM = /<(?![?!])([\w-]+:)?[\w-]+\b([^>]*)>/.exec(xml.replace(/<!--[\s\S]*?-->/g, ""));
	if (!rootM) throw new Error("Not an XML document");
	const rootAttrs = attrsOf(rootM[2] ?? "");
	const rootNs = rootAttrs[rootM[1] ? "xmlns:" + rootM[1].slice(0, -1) : "xmlns"];
	if (!rootNs || !OPENSEARCH_NAMESPACES.includes(rootNs)) throw new Error("Not an OpenSearch description (invalid namespace)");

	const shortName = textOf(xml, "ShortName");
	const name = textOf(xml, "LongName") ?? shortName;
	if (!name) throw new Error("The OpenSearch description has no name");

	let urlOpen: string | null = null;
	let urlBody = "";
	// either a self-closing <Url .../> or <Url ...>children</Url>
	for (const m of xml.matchAll(/<(?:[\w-]+:)?Url\b(?:([^>]*?)\/>|([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?Url\s*>)/gi)) {
		const open = m[1] ?? m[2] ?? "";
		const a = attrsOf(open);
		if (a.type !== "text/html") continue;
		if (a.rel !== undefined && a.rel !== "results") continue;
		urlOpen = open;
		urlBody = m[3] ?? "";
		break;
	}
	if (urlOpen === null) throw new Error("No text/html Url found in the OpenSearch description");
	const urlAttrs = attrsOf(urlOpen);
	const urlTemplate = urlAttrs.template;
	if (!urlTemplate) throw new Error("The Url has no template");

	const urlNamespaces: Record<string, string> = {};
	for (const [k, v] of Object.entries(rootAttrs)) {
		if (k === "xmlns") urlNamespaces[""] = v;
		else if (k.startsWith("xmlns:")) urlNamespaces[k.slice(6)] = v;
	}
	for (const [k, v] of Object.entries(urlAttrs)) {
		if (k === "xmlns") urlNamespaces[""] = v;
		else if (k.startsWith("xmlns:")) urlNamespaces[k.slice(6)] = v;
	}

	const urlParams: Record<string, string> = {};
	for (const m of urlBody.matchAll(/<(?:[\w-]+:)?Param\b([^>]*?)\/?>/gi)) {
		const a = attrsOf(m[1] ?? "");
		if (a.name !== undefined) urlParams[a.name] = a.value ?? "";
	}

	let iconSourceUri: string | null = null;
	for (const m of xml.matchAll(/<(?:[\w-]+:)?Image\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?Image\s*>/gi)) {
		const a = attrsOf(m[1] ?? "");
		const unsized = a.width === undefined && a.height === undefined;
		if (unsized || (a.width === "16" && a.height === "16")) iconSourceUri = decodeXml(m[2] ?? "").trim() || iconSourceUri;
	}

	return {
		name,
		alias: shortName ?? name,
		description: textOf(xml, "Description"),
		icon: null,
		iconSourceUri,
		urlTemplate,
		urlParams,
		urlNamespaces,
		method: (urlAttrs.method ?? "").toUpperCase() === "POST" ? "POST" : "GET",
		enabled: true,
	};
}

/** Fetch an OpenSearch description and parse it. `fetchImpl` is injectable so tests never touch the network. */
export async function fetchOpenSearch(url: string, fetchImpl: (url: string) => Promise<Response> = (u) => fetch(u)): Promise<LocateEngine> {
	if (!/^https?:\/\/\S+$/i.test(url.trim())) throw new Error("Enter an http(s) address");
	const res = await fetchImpl(url.trim());
	if (!res.ok) throw new Error(`The server answered ${res.status} ${res.statusText}`.trim());
	const engine = parseOpenSearch(await res.text());
	// a relative icon address is relative to the description
	if (engine.iconSourceUri && !/^[a-z][a-z0-9+.-]*:/i.test(engine.iconSourceUri)) {
		try {
			engine.iconSourceUri = new URL(engine.iconSourceUri, url.trim()).toString();
		} catch {
			/* keep as is */
		}
	}
	return engine;
}

// ---------------------------------------------------------------- expansion

/** The item's OpenURL context as repeated-key values (Zotero's createContextObject(..., asObj)), plus the query string. */
function contextOf(item: LocateItem): { map: Map<string, string[]>; query: string } {
	const pairs = openUrlParams(item);
	const map = new Map<string, string[]>();
	for (const [k, v] of pairs) map.set(k, [...(map.get(k) ?? []), v]);
	return { map, query: pairs.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&") };
}

const present = (v: string[] | undefined | false): string[] | false => (v && v.length ? v : false);

/** Zotero's _lookupParam: the raw (unencoded) values of {prefix:param}, or false when the item has none. */
function lookupParam(
	item: LocateItem,
	ctx: ReturnType<typeof contextOf>,
	engine: LocateEngine,
	prefix: string | undefined,
	param: string,
): string[] | false {
	const title = typeof item.title === "string" && item.title ? item.title : ""; // item JSON may hold anything in a field
	if (!prefix) return param === "searchTerms" && title ? [title] : false;
	const ns = engine.urlNamespaces[prefix];
	if (!ns) return false;
	if (OPENURL_ITEM_NS.includes(ns)) {
		if (param === "title") return title ? [title] : false;
		return present(ctx.map.get("rft." + param));
	}
	if (ns === CTX_NS) {
		const key = CTX_MAP[param];
		return key ? present(ctx.map.get(key)) : false;
	}
	if (ns === ZOTERO_NS) {
		if (param === "openURL") return ctx.query ? [ctx.query] : false;
		if (param === "year") return present(ctx.map.get("rft.date")?.[0] ? [ctx.map.get("rft.date")![0]!.slice(0, 4)] : undefined);
		const v = (item as unknown as Record<string, unknown>)[param];
		return typeof v === "string" && v ? [v] : typeof v === "number" ? [String(v)] : false;
	}
	return false;
}

export interface Submission {
	url: string;
	postData: string | null;
}

/**
 * Zotero's getItemSubmission: the engine's URL (and POST body) for an item, or null when a required {param} has no value for it.
 */
export function engineSubmission(engine: LocateEngine, item: LocateItem): Submission | null {
	const ctx = contextOf(item);
	let abort = false;
	let url = engine.urlTemplate.replace(
		/{(?:([^}:]+):)?([^}:?]+)(\?)?}/g,
		(_all, prefix: string | undefined, param: string, optional: string | undefined) => {
			const r = lookupParam(item, ctx, engine, prefix, param);
			if (r) return enc(r[0]!);
			if (optional) return "";
			abort = true;
			return "";
		},
	);
	if (abort) return null;

	const add: string[] = [];
	for (const [name, value] of Object.entries(engine.urlParams)) {
		const m = /^{(?:([^}:]+):)?([^}:?]+)(\?)?}$/.exec(value);
		if (!m) {
			add.push(`${enc(name)}=${enc(value)}`);
			continue;
		}
		const r = lookupParam(item, ctx, engine, m[1], m[2]!);
		if (r) for (const v of r) add.push(`${enc(name)}=${enc(v)}`);
		else if (!m[3]) return null;
	}
	let postData: string | null = null;
	if (add.length) {
		if (engine.method === "POST") postData = add.join("&");
		else url += (url.includes("?") ? "&" : "?") + add.join("&");
	}
	return { url, postData };
}

/** The address to open for a GET engine; null for POST engines (the browser hand-off has no body) or an item the engine cannot use. */
export function engineUrl(engine: LocateEngine, item: LocateItem): string | null {
	if (engine.method === "POST") return null;
	const s = engineSubmission(engine, item);
	if (!s || !/^https?:\/\//i.test(s.url)) return null;
	try {
		new URL(s.url); // a value placed in the host part can leave something that is not a URL ("%3A.example")
	} catch {
		return null;
	}
	return s.url;
}

// ---------------------------------------------------------------- list operations (pure)

/** Add or replace by name (case-insensitive), keeping the replaced engine's position, as Zotero deletes the old one of that name. */
export function upsertEngine(list: LocateEngine[], engine: LocateEngine): LocateEngine[] {
	const i = list.findIndex((e) => e.name.toLowerCase() === engine.name.toLowerCase());
	if (i < 0) return [...list, engine];
	return list.map((e, j) => (j === i ? engine : e));
}

/** Move the engine at `index` by `delta` places (clamped). */
export function moveEngine(list: LocateEngine[], index: number, delta: number): LocateEngine[] {
	const to = Math.max(0, Math.min(list.length - 1, index + delta));
	if (index < 0 || index >= list.length || to === index) return list;
	const out = [...list];
	const [e] = out.splice(index, 1);
	out.splice(to, 0, e!);
	return out;
}

/** Merge engines imported from Zotero into the list: same name replaces in place, new ones are appended. */
export function mergeEngines(list: LocateEngine[], imported: LocateEngine[]): { list: LocateEngine[]; added: number; replaced: number } {
	let out = list,
		added = 0,
		replaced = 0;
	for (const e of imported) {
		if (out.some((x) => x.name.toLowerCase() === e.name.toLowerCase())) replaced++;
		else added++;
		out = upsertEngine(out, e);
	}
	return { list: out, added, replaced };
}

/** Validate a stored list (the ui-state.json value). */
export function coerceEngines(v: unknown): LocateEngine[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out: LocateEngine[] = [];
	for (const x of v) {
		if (!x || typeof x !== "object") continue;
		const o = x as Partial<LocateEngine>;
		if (typeof o.name !== "string" || !o.name || typeof o.urlTemplate !== "string" || !o.urlTemplate) continue;
		const dict = (d: unknown): Record<string, string> =>
			d && typeof d === "object" && !Array.isArray(d)
				? Object.fromEntries(Object.entries(d).filter((kv): kv is [string, string] => typeof kv[1] === "string"))
				: {};
		out.push({
			name: o.name,
			alias: typeof o.alias === "string" ? o.alias : o.name,
			description: typeof o.description === "string" ? o.description : null,
			icon: typeof o.icon === "string" ? o.icon : null,
			iconSourceUri: typeof o.iconSourceUri === "string" ? o.iconSourceUri : null,
			urlTemplate: o.urlTemplate,
			urlParams: dict(o.urlParams),
			urlNamespaces: dict(o.urlNamespaces),
			method: o.method === "POST" ? "POST" : "GET",
			enabled: o.enabled !== false,
		});
	}
	return out;
}
