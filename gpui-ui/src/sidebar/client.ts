// Core API calls the sidebar needs beyond api.ts (collection writes, tags, tag colours, saved searches, schema, duplicates).
// All calls go through api.ts's apiRequest, so the in-process core modes work as well.
import * as A from "../api";
import type { Collection } from "../contracts";
import type { SavedSearch, SearchCondition, SearchOptions } from "../../../core/src/searches/types";
import type { ItemList, TagColor, ZoteroSchema } from "../../../core/src/api-types";

export type { SavedSearch, SearchCondition, SearchOptions, TagColor, ZoteroSchema };
export type { Operator } from "../../../core/src/searches/types";

/** Raw verb helper of api.ts (works in the in-process core modes too); the path is relative to /api. */
export const request = A.apiRequest;

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const sidebarApi = {
	// collections
	collections: () => request<{ key: string; name: string; parentKey: string | null; itemCount: number }[]>("GET", "/collections").then(A.buildTree),
	createCollection: (name: string, parentKey?: string | null) => request<Collection>("POST", "/collections", { name, parentKey: parentKey ?? undefined }),
	patchCollection: (key: string, patch: { name?: string; parentKey?: string | null }) => request<Collection>("PATCH", `/collections/${key}`, patch),
	deleteCollection: (key: string) => request<{ ok: true }>("DELETE", `/collections/${key}`),
	addToCollection: (key: string, keys: string[]) => request<{ ok: true }>("POST", `/collections/${key}/items`, { keys }),
	// tags
	tags: () => request<{ tag: string; count: number }[]>("GET", "/tags"),
	tagColors: () => request<TagColor[]>("GET", "/tag-colors"),
	putTagColors: (colors: TagColor[]) => request<TagColor[]>("PUT", "/tag-colors", colors),
	automaticTags: () => request<{ tag: string; count: number }[]>("GET", "/maintenance/tags/automatic"),
	renameTag: (from: string, to: string) => request<{ items: number; merged: boolean }>("POST", "/maintenance/tags/rename", { from, to }),
	deleteTags: (tags: string[]) => request<{ tags: number; items: number }>("POST", "/maintenance/tags/delete", { tags }),
	deleteAutomaticTags: () => request<{ tags: number; items: number }>("POST", "/maintenance/tags/delete-automatic", {}),
	// saved searches
	savedSearches: () => request<SavedSearch[]>("GET", "/searches"),
	createSavedSearch: (name: string, conditions: SearchCondition[], options: SearchOptions) => request<SavedSearch>("POST", "/searches", { name, conditions, options }),
	patchSavedSearch: (key: string, patch: { name?: string; conditions?: SearchCondition[]; options?: SearchOptions }) => request<SavedSearch>("PATCH", `/searches/${key}`, patch),
	deleteSavedSearch: (key: string) => request<{ ok: true }>("DELETE", `/searches/${key}`),
	runSearch: (conditions: SearchCondition[], options: SearchOptions, limit = 100, offset = 0, signal?: AbortSignal) =>
		request<ItemList>("POST", "/searches/run", { conditions, options, limit, offset, sort: "title", dir: "asc" }, signal),
	schema: () => request<ZoteroSchema>("GET", "/schema"),
	// duplicates (count only)
	duplicateCount: () => request<{ total: number }>("GET", "/duplicates").then((r) => r.total),
	// trash
	trashCounts: () => request<{ items: number; total: number }>("GET", "/maintenance/trash"),
	emptyTrash: () => request<{ erased: number }>("POST", "/maintenance/empty-trash", {}),
};
