import type {
	Collection, ItemList, ItemDetail, SearchResult, TagColor, ZoteroItemData, ZoteroSchema,
} from "../../core/src/api-types";

export type {
	Collection, ItemList, ItemSummary, ItemDetail, SearchResult, SearchHit,
	ChildSummary, Creator, TagColor, ZoteroItemData, ZoteroSchema,
} from "../../core/src/api-types";

const BASE = "/api";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(BASE + path, {
		method,
		headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		let msg = res.statusText;
		try { msg = (await res.json()).error ?? msg; } catch {}
		throw new Error(msg);
	}
	return res.json() as Promise<T>;
}

export type { SavedSearch, SearchCondition, SearchOptions, Operator, QuickSearchMode } from "../../core/src/searches/types";
import type { SavedSearch, SearchCondition, SearchOptions } from "../../core/src/searches/types";

export interface ItemQuery {
	/** saved search key: list that search's results */
	search?: string;
	/** quick-search mode for `q`: titleCreatorYear (default) | fields | everything */
	qmode?: string;
	collection?: string;
	tag?: string;
	q?: string;
	sort: string;
	dir: "asc" | "desc";
	/** further sort levels, e.g. "creator:asc,title:asc" */
	then?: string;
	unfiled?: boolean;
	trash?: boolean;
	/** comma-separated Zotero data fields to return in ItemSummary.fields */
	fields?: string;
	/** comma-separated extras: "creators" (full author list), "tags" */
	include?: string;
}

const qs = (o: Record<string, string | number | undefined | boolean>) => {
	const p = new URLSearchParams();
	for (const [k, v] of Object.entries(o)) {
		if (v === undefined || v === "" || v === false) continue;
		p.set(k, v === true ? "1" : String(v));
	}
	return p.toString();
};

export const api = {
	collections: () => req<Collection[]>("GET", "/collections"),
	createCollection: (name: string, parentKey?: string | null) =>
		req<Collection>("POST", "/collections", { name, parentKey: parentKey ?? undefined }),
	patchCollection: (key: string, patch: { name?: string; parentKey?: string | null }) =>
		req<Collection>("PATCH", `/collections/${key}`, patch),
	deleteCollection: (key: string) => req<{ ok: true }>("DELETE", `/collections/${key}`),
	addToCollection: (key: string, keys: string[]) =>
		req<{ ok: true }>("POST", `/collections/${key}/items`, { keys }),
	items: (q: ItemQuery, offset: number, limit: number) =>
		req<ItemList>("GET", "/items?" + qs({ ...q, limit, offset })),
	/** Group sizes for a query, in list order (the query's first sort level must be `by`). */
	itemGroups: (q: ItemQuery, by: string) => {
		const { fields: _f, include: _i, then: _t, sort: _s, ...rest } = q;
		return req<{ groups: { value: string | null; count: number }[] }>("GET", "/items/groups?" + qs({ ...rest, by }));
	},
	schema: () => req<ZoteroSchema>("GET", "/schema"),
	item: (key: string) => req<ItemDetail>("GET", `/items/${key}`),
	patchItem: (key: string, data: Partial<ZoteroItemData>) =>
		req<ItemDetail>("PATCH", `/items/${key}`, { data }),
	/** Move to / restore from trash (Zotero convention: data.deleted = 1 | 0). */
	setDeleted: (key: string, deleted: boolean) =>
		req<ItemDetail>("PATCH", `/items/${key}`, { data: { deleted: deleted ? 1 : 0 } }),
	addTags: (key: string, tags: string[]) => req<{ ok: true }>("POST", `/items/${key}/tags`, { tags }),
	removeTags: (key: string, tags: string[]) => req<{ ok: true }>("DELETE", `/items/${key}/tags`, { tags }),
	tags: () => req<{ tag: string; count: number }[]>("GET", "/tags"),
	tagColors: () => req<TagColor[]>("GET", "/tag-colors"),
	putTagColors: (colors: TagColor[]) => req<TagColor[]>("PUT", "/tag-colors", colors),
	savedSearches: () => req<SavedSearch[]>("GET", "/searches"),
	createSavedSearch: (name: string, conditions: SearchCondition[], options: SearchOptions) =>
		req<SavedSearch>("POST", "/searches", { name, conditions, options }),
	patchSavedSearch: (key: string, patch: { name?: string; conditions?: SearchCondition[]; options?: SearchOptions }) =>
		req<SavedSearch>("PATCH", `/searches/${key}`, patch),
	deleteSavedSearch: (key: string) => req<{ ok: true }>("DELETE", `/searches/${key}`),
	/** Run conditions without saving them. */
	runSearch: (conditions: SearchCondition[], options: SearchOptions, limit = 100, offset = 0) =>
		req<ItemList>("POST", "/searches/run", { conditions, options, limit, offset, sort: "title", dir: "asc" }),
	search: (q: string, limit = 100, offset = 0) =>
		req<SearchResult>("GET", "/search?" + qs({ q, limit, offset })),
};
