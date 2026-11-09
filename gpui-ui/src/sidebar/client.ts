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
	collections: (library?: number) => A.api.collections(library),
	createCollection: (name: string, parentKey?: string | null, library?: number) => request<Collection>("POST", "/collections", { name, parentKey: parentKey ?? undefined, library: library && library > 1 ? library : undefined }),
	patchCollection: (key: string, patch: { name?: string; parentKey?: string | null }) => request<Collection>("PATCH", `/collections/${key}`, patch),
	deleteCollection: (key: string) => request<{ ok: true }>("DELETE", `/collections/${key}`),
	addToCollection: (key: string, keys: string[]) => request<{ ok: true }>("POST", `/collections/${key}/items`, { keys }),
	// tags
	tags: (library?: number) => A.api.tags(library),
	tagColors: () => request<TagColor[]>("GET", "/tag-colors"),
	putTagColors: (colors: TagColor[]) => request<TagColor[]>("PUT", "/tag-colors", colors),
	// tag maintenance acts on one library (`library`, default My Library: core/src/maintenance/api.ts)
	automaticTags: (library = 1) => request<{ tag: string; count: number }[]>("GET", "/maintenance/tags/automatic?library=" + library),
	renameTag: (from: string, to: string, library = 1) => request<{ items: number; merged: boolean }>("POST", "/maintenance/tags/rename", { from, to, library }),
	deleteTags: (tags: string[], library = 1) => request<{ tags: number; items: number }>("POST", "/maintenance/tags/delete", { tags, library }),
	deleteAutomaticTags: (library = 1) => request<{ tags: number; items: number }>("POST", "/maintenance/tags/delete-automatic", { library }),
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
