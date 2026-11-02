// Item-pane HTTP calls (the routes ui/src/itempane/api.ts and ui/src/api.ts use). The core's base URL comes from ../api; if that
// module exports a generic `request(method, path, body)` (also covering the in-process "direct" mode) it is used instead.
import * as core from "../api";
import type {
	ChildSummary, Creator, ItemDetail, ItemList, TagColor, ZoteroItemData, ZoteroSchema,
} from "../../../core/src/api-types";

export type { ChildSummary, Creator, ItemDetail, ItemList, TagColor, ZoteroItemData, ZoteroSchema };
export type { ZoteroSchemaField, ZoteroSchemaItemType, FullTextJob } from "../../../core/src/api-types";

type GenericRequest = (method: string, path: string, body?: unknown) => Promise<unknown>;

export async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
	const generic = (core as unknown as { request?: GenericRequest }).request;
	if (generic) return (await generic(method, path, body)) as T;
	const res = await fetch(core.BASE_URL + "/api" + path, {
		method,
		headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		let msg = res.statusText;
		try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* keep the status text */ }
		throw new Error(msg);
	}
	return (await res.json()) as T;
}

const qs = (o: Record<string, string | number | undefined>) => {
	const p = new URLSearchParams();
	for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") p.set(k, String(v));
	return p.toString();
};

let schemaP: Promise<ZoteroSchema> | null = null;
let tagsP: { at: number; p: Promise<{ tag: string; count: number }[]> } | null = null;

export const ipApi = {
	/** Cached for the life of the process; retried if the first load failed. */
	schema: () => (schemaP ??= req<ZoteroSchema>("GET", "/schema").catch((e) => { schemaP = null; throw e; })),
	item: (key: string) => req<ItemDetail>("GET", `/items/${key}`),
	patchItem: (key: string, data: Partial<ZoteroItemData>) => req<ItemDetail>("PATCH", `/items/${key}`, { data }),
	setDeleted: (key: string, deleted: boolean) => req<ItemDetail>("PATCH", `/items/${key}`, { data: { deleted: deleted ? 1 : 0 } }),
	createChild: (data: Partial<ZoteroItemData>) => req<ItemDetail>("POST", "/items", { data }),
	addTags: (key: string, tags: string[]) => req<{ ok: true }>("POST", `/items/${key}/tags`, { tags }),
	removeTags: (key: string, tags: string[]) => req<{ ok: true }>("DELETE", `/items/${key}/tags`, { tags }),
	/** The library's tag list (large: fetched at most once a minute). */
	tags: () => {
		if (!tagsP || Date.now() - tagsP.at > 60_000) {
			const p = req<{ tag: string; count: number }[]>("GET", "/tags");
			p.catch(() => { if (tagsP?.p === p) tagsP = null; });
			tagsP = { at: Date.now(), p };
		}
		return tagsP.p;
	},
	invalidateTags: () => { tagsP = null; },
	tagColors: () => req<TagColor[]>("GET", "/tag-colors"),
	addRelated: (key: string, keys: string[]) => req<ItemDetail>("POST", `/items/${key}/related`, { keys }),
	removeRelated: (key: string, keys: string[]) => req<ItemDetail>("DELETE", `/items/${key}/related`, { keys }),
	searchItems: (q: string, limit = 15) => req<ItemList>("GET", "/items?" + qs({ q, sort: "title", dir: "asc", limit, offset: 0 })),
	addToCollection: (coll: string, keys: string[]) => req<{ ok: true }>("POST", `/collections/${coll}/items`, { keys }),
	removeFromCollection: (coll: string, keys: string[]) => req<{ ok: true }>("DELETE", `/collections/${coll}/items`, { keys }),
	reveal: (attachmentKey: string) => req<{ ok: true }>("POST", `/attachments/${attachmentKey}/reveal`),
	openExternal: (attachmentKey: string) => req<{ ok: true }>("POST", `/attachments/${attachmentKey}/open-external`),
	openUrl: (url: string) => req<{ ok: true }>("POST", "/open-url", { url }),
	renameFiles: (attachmentKeys: string[]) =>
		req<{ status: string; message?: string }[]>("POST", "/maintenance/rename-files", { attachmentKeys }),
	// Cite (Quick Copy) and Find Full Text
	citeSettings: () => req<{ quickCopy: { style: string; locale: string } }>("GET", "/cite/settings"),
	citeFormat: (b: { keys: string[]; style?: string; locale?: string; mode: "citation" | "bibliography" }) =>
		req<{ text?: string; html?: string }>("POST", "/cite/format", { ...b, format: ["html", "text"] }),
	findFullText: (keys: string[]) => req<{ jobId: string }>("POST", "/fulltext/find", { keys }),
	fullTextJob: (id: string) => req<import("../../../core/src/api-types").FullTextJob>("GET", `/fulltext/jobs/${id}`),
};
