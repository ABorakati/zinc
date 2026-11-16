// Typed fetch client for the core API (the subset the library window needs).
import type { Collection, ItemRow, Library } from "./contracts";

const trim = (u: string) => u.replace(/\/+$/, "");

/**
 * Where the core API lives. Default: an external core at ZN_URL (default http://127.0.0.1:23160). When ZN_DB is set, src/core.ts
 * runs the core inside this process and repoints it (setBaseUrl, or setDirect for the no-HTTP shortcut).
 */
export let BASE_URL = trim((typeof process !== "undefined" ? process.env.ZN_URL : undefined) ?? "http://127.0.0.1:23160");

/** In-process shortcut: answer /api requests by calling the core's handleApi directly (no socket, no loopback HTTP). */
export type DirectHandler = (req: Request) => Promise<Response | null> | Response | null;
let direct: DirectHandler | null = null;

/** Requests wait for this before going out: main.tsx holds them while the in-process core starts (so the store can be created at once). */
let gate: Promise<unknown> = Promise.resolve();

export function setBaseUrl(u: string): void {
	BASE_URL = trim(u);
	direct = null;
}
export function setDirect(h: DirectHandler): void {
	direct = h;
}
export function holdRequestsUntil(p: Promise<unknown>): void {
	gate = Promise.all([gate, p]);
	gate.catch(() => {}); // a failed core start surfaces through the requests waiting on it, not as an unhandled rejection
}

/** Flat collection as GET /api/collections returns it. */
export interface CollectionDto {
	key: string;
	name: string;
	parentKey: string | null;
	itemCount: number;
	dateAdded?: string;
	dateModified?: string;
}

/** Query params of GET /api/items (same names the web UI sends). */
export interface ItemQuery {
	/** Local library id (GET /api/libraries); absent = My Library (a collection also decides it). */
	library?: number;
	collection?: string;
	/** list a saved search's results */
	search?: string;
	/** only items with this tag (the core takes a single tag) */
	tag?: string;
	/** the Unfiled / Trash views of the library */
	unfiled?: boolean;
	/** My Publications: regular top-level items flagged inPublications */
	publications?: boolean;
	trash?: boolean;
	/** quick-search mode for `q`: titleCreatorYear (default) | fields | everything */
	qmode?: string;
	q?: string;
	sort: string;
	dir: "asc" | "desc";
	/** further sort levels, e.g. "dateAdded:desc,title:asc" */
	then?: string;
	/** comma-separated Zotero data fields to return in `fields` */
	fields?: string;
	/** comma-separated extras: "creators", "tags" */
	include?: string;
}

export interface ItemPage {
	total: number;
	items: ItemRow[];
}

export interface ItemGroup {
	value: string | null;
	count: number;
}

const qs = (o: Record<string, string | number | boolean | undefined>) => {
	const p = new URLSearchParams();
	for (const [k, v] of Object.entries(o)) {
		if (v === undefined || v === "" || v === false) continue;
		p.set(k, v === true ? "1" : String(v));
	}
	return p.toString();
};

// ---- early answers (src/prefetch.ts): a worker answers the first screen's GETs while the main thread is busy starting up ----
const early = new Map<string, Promise<string | null>>();
/** The first screen's request paths, in order, collected until takeRecordedPaths() (read-only requests the worker may repeat). */
let recorded: string[] | null = [];
const PREFETCHABLE = /^\/(collections|items\?|items\/groups\?|schema|tag-colors|searches)/;
let onDemand: (() => void) | null = null;
/** Start the in-process core on the first request that early answers do not cover (main.tsx starts it anyway after the first page). */
export function startCoreOnDemand(start: () => void): void {
	onDemand = start;
}
export function expectEarly(path: string, answer: Promise<string | null>): void {
	early.set(path, answer);
}
export function takeRecordedPaths(): string[] {
	const r = recorded ?? [];
	recorded = null;
	return r;
}

/**
 * A raw /api request (the Response itself: headers, bytes, Range) by the route every UI call takes: the direct handler when one is
 * set (ZN_CORE_DIRECT, the browser build's in-page core), else BASE_URL. Waits for a starting in-process core. `path` is relative
 * to /api. Use it instead of fetch(BASE_URL + ...), which misses the direct handler.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
	if (onDemand) {
		const start = onDemand;
		onDemand = null;
		start();
	} // the in-process core was left to start lazily (main.tsx): now it is needed
	await gate;
	init.signal?.throwIfAborted();
	return direct
		? ((await direct(new Request("http://127.0.0.1/api" + path, init))) ?? new Response('{"error":"not found"}', { status: 404 }))
		: await fetch(BASE_URL + "/api" + path, init);
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
	if (method === "GET") {
		if (recorded && PREFETCHABLE.test(path) && !recorded.includes(path) && recorded.length < 8) recorded.push(path);
		const e = early.get(path);
		if (e) {
			// each early answer is used once: later identical requests (refresh) go to the core
			early.delete(path);
			const text = await e;
			if (text != null) {
				try {
					return JSON.parse(text) as T;
				} catch {
					/* fall through to the core */
				}
			}
		}
	}
	const res = await apiFetch(path, {
		method,
		signal,
		headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		let msg = res.statusText;
		try {
			msg = ((await res.json()) as { error?: string }).error ?? msg;
		} catch {}
		throw Object.assign(new Error(msg), { status: res.status }); // callers that must tell a refusal (4xx) from a hiccup read .status
	}
	const text = await res.text();
	return (text ? JSON.parse(text) : {}) as T;
}
const get = <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, signal);

/** Raw verbs for features that need an endpoint this file does not wrap yet. `path` is relative to /api. */
export const apiRequest = request;
/** Same, under the name feature modules feature-detect (itempane/net.ts); honours the in-process direct mode. */
export { request };

/** Turn the flat collection list into a tree (roots first, siblings sorted by name). */
export function buildTree(flat: CollectionDto[]): Collection[] {
	const byKey = new Map<string, Collection>();
	for (const c of flat)
		byKey.set(c.key, {
			key: c.key,
			name: c.name,
			parentKey: c.parentKey,
			itemCount: c.itemCount,
			...(c.dateAdded ? { dateAdded: c.dateAdded } : {}),
			...(c.dateModified ? { dateModified: c.dateModified } : {}),
		});
	const roots: Collection[] = [];
	for (const c of byKey.values()) {
		const parent = c.parentKey ? byKey.get(c.parentKey) : undefined;
		if (parent) (parent.children ??= []).push(c);
		else roots.push(c);
	}
	const sort = (l: Collection[]) => {
		l.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
		for (const c of l) if (c.children) sort(c.children);
	};
	sort(roots);
	return roots;
}

// ---- response shapes (core/src/api-types.ts, the parts the list needs) ----

export interface ChildSummary {
	key: string;
	itemType: string;
	title?: string;
	contentType?: string | null;
	linkMode?: string | null;
	hasFile?: boolean;
	[k: string]: unknown;
}
export interface ItemDetail {
	data: Record<string, unknown> & { key: string; itemType: string; title?: string; DOI?: string; url?: string };
	children: ChildSummary[];
	collections: string[];
	tags: { tag: string; type?: number }[];
}
export interface SearchHit {
	key: string;
	title: string;
	creatorsSummary: string;
	year: number | null;
	/** FTS5 snippet with <mark>..</mark> around the matches */
	snippet: string;
	matchedIn: ("metadata" | "fulltext" | "notes")[];
	rank: number;
}
export interface SearchResult {
	total: number;
	hits: SearchHit[];
}
export interface TagColor {
	name: string;
	color: string;
	position: number;
}
export interface ZoteroSchema {
	itemTypes: { itemType: string; label: string; fields: { field: string; label: string; baseField?: string }[] }[];
	fieldLabels: Record<string, string>;
	[k: string]: unknown;
}
export interface DuplicateSet {
	keys: string[];
	reason: string;
	title?: string;
	creatorsSummary?: string;
	year?: number | null;
	itemType?: string;
}
export interface CiteSettings {
	quickCopy: { style: string; locale?: string; mode: "bibliography" | "citation"; format: string };
}
export interface CiteResult {
	text?: string;
	html?: string;
	rtf?: string;
}
export interface FullTextJob {
	id: string;
	done: boolean;
	items: { key: string; title: string; state: string; source?: string; message?: string; attachmentKey?: string; handoffUrl?: string }[];
}

export const api = {
	collections: async (library?: number) =>
		buildTree(await get<CollectionDto[]>("/collections" + (library && library > 1 ? `?library=${library}` : ""))),
	/** My Library and the account's group libraries. */
	libraries: async () => (await get<{ libraries: Library[] }>("/libraries")).libraries,
	/** Tags of one library with their counts. */
	tags: (library?: number) => get<{ tag: string; count: number }[]>("/tags" + (library && library > 1 ? `?library=${library}` : "")),
	items: (q: ItemQuery, offset: number, limit: number, signal?: AbortSignal) =>
		get<ItemPage>("/items?" + qs({ ...q, limit, offset }), signal),
	/** Group sizes for a query, in list order (the first sort level must be `by`). */
	itemGroups: (q: ItemQuery, by: string, signal?: AbortSignal) => {
		const { fields: _f, include: _i, then: _t, sort: _s, ...rest } = q;
		return get<{ groups: ItemGroup[] }>("/items/groups?" + qs({ ...rest, by }), signal);
	},
	schema: (signal?: AbortSignal) => get<ZoteroSchema>("/schema", signal),
	item: (key: string, signal?: AbortSignal) => get<ItemDetail>(`/items/${key}`, signal),
	/** Full-text + metadata search with snippets (the "Full text" quick-search mode). */
	search: (q: string, limit = 200, offset = 0, signal?: AbortSignal, library?: number) =>
		get<SearchResult>("/search?" + qs({ q, limit, offset, library: library && library > 1 ? library : undefined }), signal),
	tagColors: (signal?: AbortSignal) => get<TagColor[]>("/tag-colors", signal),
	addTags: (key: string, tags: string[]) => request<{ ok: true }>("POST", `/items/${key}/tags`, { tags }),
	removeTags: (key: string, tags: string[]) => request<{ ok: true }>("DELETE", `/items/${key}/tags`, { tags }),
	/** Move to / restore from the trash (Zotero convention: data.deleted = 1 | 0). */
	setDeleted: (key: string, deleted: boolean) => request<ItemDetail>("PATCH", `/items/${key}`, { data: { deleted: deleted ? 1 : 0 } }),
	/** Add to / remove from My Publications (data.inPublications = true | absent). */
	setInPublications: (key: string, inPublications: boolean) =>
		request<ItemDetail>("PATCH", `/items/${key}`, { data: { inPublications } }),
	addToCollection: (collectionKey: string, keys: string[]) =>
		request<{ ok: true }>("POST", `/collections/${collectionKey}/items`, { keys }),
	removeFromCollection: (collectionKey: string, keys: string[]) =>
		request<{ ok: true }>("DELETE", `/collections/${collectionKey}/items`, { keys }),
	duplicates: (signal?: AbortSignal) => get<{ sets: DuplicateSet[]; total: number }>("/duplicates?summary=1", signal),
	/** Open an http(s) URL in the system browser (through the core). */
	openUrl: (url: string) => request<{ ok: true }>("POST", "/open-url", { url }),
	/** Open the attachment's file in its default app / show it in Explorer. */
	openExternal: (attachmentKey: string) => request<{ ok: true }>("POST", `/attachments/${attachmentKey}/open-external`, {}),
	reveal: (attachmentKey: string) => request<{ ok: true }>("POST", `/attachments/${attachmentKey}/reveal`, {}),
	citeSettings: () => get<CiteSettings>("/cite/settings"),
	citeFormat: (b: { keys: string[]; style?: string; locale?: string; mode?: string; format?: string | string[] }) =>
		request<CiteResult>("POST", "/cite/format", b),
	/** Find Full Text: starts a job for top-level item keys; returns its id. */
	findFullText: (keys: string[], openAccessOnly = false) =>
		request<{ jobId: string }>("POST", "/fulltext/find", { keys, openAccessOnly }),
	fullTextJob: (id: string) => get<FullTextJob>(`/fulltext/jobs/${id}`),
	/** Browser-extension saves go to the collection selected here (best effort). */
	postSelection: (sel: { kind: string; key?: string }) => request<unknown>("POST", "/ui/selection", sel),
};
