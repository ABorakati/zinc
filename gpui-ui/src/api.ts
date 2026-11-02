// Typed fetch client for the core API (the subset the library window needs).
import type { Collection, ItemRow } from "./contracts";

export const BASE_URL = ((typeof process !== "undefined" ? process.env.ZN_URL : undefined) ?? "http://127.0.0.1:23160").replace(/\/+$/, "");

/** Flat collection as GET /api/collections returns it. */
export interface CollectionDto {
	key: string;
	name: string;
	parentKey: string | null;
	itemCount: number;
}

/** Query params of GET /api/items (same names the web UI sends). */
export interface ItemQuery {
	collection?: string;
	/** the Unfiled / Trash views of the library */
	unfiled?: boolean;
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

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
	const res = await fetch(BASE_URL + "/api" + path, { signal });
	if (!res.ok) {
		let msg = res.statusText;
		try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch {}
		throw new Error(msg);
	}
	return (await res.json()) as T;
}

/** Turn the flat collection list into a tree (roots first, siblings sorted by name). */
export function buildTree(flat: CollectionDto[]): Collection[] {
	const byKey = new Map<string, Collection>();
	for (const c of flat) byKey.set(c.key, { key: c.key, name: c.name, parentKey: c.parentKey, itemCount: c.itemCount });
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

export const api = {
	collections: async () => buildTree(await get<CollectionDto[]>("/collections")),
	items: (q: ItemQuery, offset: number, limit: number, signal?: AbortSignal) =>
		get<ItemPage>("/items?" + qs({ ...q, limit, offset }), signal),
	/** Group sizes for a query, in list order (the first sort level must be `by`). */
	itemGroups: (q: ItemQuery, by: string, signal?: AbortSignal) => {
		const { fields: _f, include: _i, then: _t, sort: _s, ...rest } = q;
		return get<{ groups: ItemGroup[] }>("/items/groups?" + qs({ ...rest, by }), signal);
	},
};
