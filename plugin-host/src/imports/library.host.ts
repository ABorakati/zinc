// `library` (library.wit): libraries, items, collections, tags, saved searches, duplicates, trash, and `apply`.
// Runs in the plugin host process and calls core over HTTP (ctx.coreUrl). Every function checks its permission first.
import { defineHandler, witError, WitError, type HandlerContext } from "./registry";
import { core, coreJson, keySeg, newKeys, parseJson, pmap, qs } from "./data/core";
import { requirePermission } from "./data/perm";
import {
	allKeys,
	detailsOf,
	getDetail,
	includeFlags,
	runQuery,
	searchFromCore,
	searchToCore,
	summaryFromDetail,
	toSummary,
	type CoreDetail,
} from "./data/library-map";

const MAX_KEYS = 1000;
const FACET_SCAN_CAP = 20_000;

const SEARCH_CONDITIONS: { name: string; operators: string[]; label: string }[] = [
	{ name: "title", label: "Title", operators: ["contains", "doesNotContain", "is", "isNot", "beginsWith"] },
	{ name: "creator", label: "Creator", operators: ["contains", "doesNotContain", "is", "isNot", "beginsWith"] },
	{ name: "year", label: "Year", operators: ["is", "isNot", "isBefore", "isAfter"] },
	{ name: "date", label: "Date", operators: ["is", "isBefore", "isAfter", "isInTheLast"] },
	{ name: "dateAdded", label: "Date Added", operators: ["is", "isBefore", "isAfter", "isInTheLast"] },
	{ name: "dateModified", label: "Date Modified", operators: ["is", "isBefore", "isAfter", "isInTheLast"] },
	{ name: "publicationTitle", label: "Publication", operators: ["contains", "doesNotContain", "is", "isNot", "beginsWith"] },
	{ name: "itemType", label: "Item Type", operators: ["is", "isNot"] },
	{ name: "tag", label: "Tag", operators: ["is", "isNot", "contains", "doesNotContain"] },
	{ name: "collection", label: "Collection", operators: ["is", "isNot"] },
	{ name: "note", label: "Note", operators: ["contains", "doesNotContain"] },
	{ name: "attachmentFileType", label: "Attachment File Type", operators: ["is", "isNot"] },
	{ name: "fulltextContent", label: "Attachment Content", operators: ["contains", "doesNotContain"] },
	{ name: "anyField", label: "All Fields & Tags", operators: ["contains", "doesNotContain"] },
];

function keyList(keys: unknown, what = "keys"): string[] {
	if (!Array.isArray(keys)) throw witError("invalid-argument", `${what} must be a list`);
	if (keys.length > MAX_KEYS) throw witError("limit-exceeded", `at most ${MAX_KEYS} keys per call`);
	return keys as string[];
}

/** Library id of a collection, found by looking through the libraries. */
async function collectionLibrary(ctx: HandlerContext, key: string): Promise<number | undefined> {
	const libs = (await coreJson<{ libraries: { id: number }[] }>(ctx, "/api/libraries")).libraries;
	for (const l of libs) {
		const cs = await coreJson<{ key: string }[]>(ctx, "/api/collections" + qs({ library: l.id }));
		if (cs.some((c) => c.key === key)) return l.id;
	}
	return undefined;
}

// ----------------------------------------------------------------------------------------------- apply
const WRITE = new Set([
	"create-item", "update-item", "add-to-collection", "remove-from-collection", "add-tags", "remove-tags", "add-related", "remove-related",
	"add-to-publications", "remove-from-publications", "create-collection", "update-collection", "create-saved-search", "update-saved-search",
]);
const TRASH = new Set(["trash-items", "restore-items"]);
const ERASE = new Set(["erase-items", "erase-collection", "erase-saved-search"]);

function applyError(index: number | undefined, tag: string, val?: string): WitError {
	const e = new WitError("internal", "apply");
	(e as { payload: unknown }).payload = { index, error: val === undefined ? { tag } : { tag, val } };
	e.message = val ? `${tag}: ${val}` : tag;
	return e;
}

/** jco gives `option<option<T>>` as undefined | null | T, or as {tag,val}; accept every spelling. Returns "keep" | string | null. */
function nestedOption(v: any): "keep" | string | null {
	if (v === undefined) return "keep";
	if (v === null) return null;
	if (typeof v === "string") return v;
	if (v && typeof v === "object" && "tag" in v) return v.tag === "some" ? nestedOption(v.val) : null;
	return "keep";
}

/** A WIT `change` (jco form) to the JSON that core's POST /api/batch takes. Throws applyError with the index. */
function toBatchChange(c: any, index: number): { tag: string; val: any } {
	const v = c.val;
	try {
		switch (c.tag) {
			case "create-item":
				return { tag: c.tag, val: { key: v.key ?? undefined, library: v.library ?? undefined, data: parseJson(v.data, "data") } };
			case "update-item":
				return { tag: c.tag, val: { key: v.key, patch: parseJson(v.patch, "patch"), expectedModified: v.expectedModified ?? undefined } };
			case "add-tags":
			case "remove-tags":
				return { tag: c.tag, val: { items: v.items, tags: (v.tags ?? []).map((t: any) => ({ name: t.name, kind: t.kind })) } };
			case "create-collection":
				return { tag: c.tag, val: { key: v.key ?? undefined, library: v.library ?? undefined, name: v.name, parent: v.parent ?? undefined } };
			case "update-collection": {
				const p = nestedOption(v.parent);
				return { tag: c.tag, val: { key: v.key, name: v.name ?? undefined, ...(p === "keep" ? {} : { parentKey: p }) } };
			}
			case "erase-collection":
				return { tag: c.tag, val: { key: v.key, trashItems: !!v.trashItems } };
			case "create-saved-search": {
				const d = searchToCore(v.definition);
				return { tag: c.tag, val: { key: v.key ?? undefined, library: v.library ?? undefined, name: v.name, conditions: d.conditions, options: d.options } };
			}
			case "update-saved-search": {
				const d = v.definition ? searchToCore(v.definition) : undefined;
				return { tag: c.tag, val: { key: v.key, name: v.name ?? undefined, conditions: d?.conditions, options: d?.options } };
			}
			default:
				return { tag: c.tag, val: v };
		}
	} catch (e) {
		if (e instanceof WitError) throw applyError(index, (e.payload as any).tag, (e.payload as any).val);
		throw e;
	}
}

// --------------------------------------------------------------------------------------------- handler
export default defineHandler({
	interface: "zinc:plugin/library",
	where: "host",
	functions: {
		async "list-libraries"(ctx) {
			requirePermission(ctx, "library.read");
			const r = await coreJson<{ libraries: { id: number; type: string; groupId?: number; name: string; editable: boolean; filesEditable: boolean; removed?: boolean }[] }>(ctx, "/api/libraries");
			return r.libraries
				.filter((l) => !l.removed)
				.map((l) => ({ id: l.id, kind: l.type === "group" ? "group" : "user", groupId: l.groupId, name: l.name, editable: l.editable, filesEditable: l.filesEditable }));
		},

		"new-keys"(_ctx, count: number) {
			return newKeys(Math.max(0, Math.min(count, 10_000)));
		},

		// ------------------------------------------------------------------------------------- items
		async "query-items"(ctx, q: any) {
			requirePermission(ctx, "library.read");
			const fields: string[] = q.fields ?? [];
			const ex = includeFlags(q.expand);
			const include = [ex.creators ? "creators" : "", ex.tags ? "tags" : ""].filter(Boolean);
			const page = await runQuery(ctx, q, fields, include);
			let items = page.items.map((s) => toSummary(s, page.library, fields, { inTrash: page.inTrash }));
			if (ex.collections) {
				const d = await detailsOf(ctx, items.map((i) => i.key));
				items = items.map((i, n) => ({ ...i, collections: d[n]?.collections ?? [] }));
			}
			return { total: BigInt(page.total), items };
		},

		async "query-keys"(ctx, q: any) {
			requirePermission(ctx, "library.read");
			const page = await runQuery(ctx, q, [], []);
			return page.items.map((i) => i.key);
		},

		async "count-items"(ctx, q: any) {
			requirePermission(ctx, "library.read");
			const page = await runQuery(ctx, { ...q, limit: 1, offset: 0 }, [], []);
			return BigInt(page.total);
		},

		async facets(ctx, q: any, field: string, limit: number) {
			requirePermission(ctx, "library.read");
			const counts = new Map<string, number>();
			const bump = (v: string | null | undefined) => v && counts.set(v, (counts.get(v) ?? 0) + 1);
			if (field === "collection" || field === "contentType") throw witError("unavailable", `facets over ${field} need a core aggregation route`);
			const include = field === "tag" ? ["tags"] : field === "creator" ? ["creators"] : [];
			const fields = field === "tag" || field === "creator" || field === "year" || field === "itemType" ? [] : [field];
			for (let offset = 0, seen = 0; seen < FACET_SCAN_CAP; ) {
				const p = await runQuery(ctx, { ...q, limit: 1000, offset }, fields, include);
				for (const i of p.items) {
					if (field === "tag") i.tags?.forEach((t) => bump(t.tag));
					else if (field === "creator") i.creators?.forEach((c) => bump(c));
					else if (field === "year") bump(i.year === null ? undefined : String(i.year));
					else if (field === "itemType") bump(i.itemType);
					else bump(i.fields?.[field]);
				}
				seen += p.items.length;
				offset += p.items.length;
				if (p.items.length === 0 || offset >= p.total) break;
			}
			return [...counts.entries()]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.slice(0, limit > 0 ? limit : 100)
				.map(([value, count]) => ({ value, count: BigInt(count) }));
		},

		async "get-items"(ctx, keys: string[], options: any) {
			requirePermission(ctx, "library.read");
			keyList(keys);
			const canPaths = ctx.has("library.files.paths");
			const strip = (d: Record<string, any>) => {
				if (!canPaths && "path" in d) delete d.path;
				return d;
			};
			const details = await detailsOf(ctx, keys);
			return pmap(details, 8, async (d) => {
				if (!d) return undefined;
				if (d.data.deleted && !options?.includeTrashed) return undefined;
				const data = strip({ ...d.data });
				if (options?.includeChildren && d.children.length) {
					const kids = await detailsOf(ctx, d.children.map((c) => c.key));
					data.children = kids.filter((k): k is CoreDetail => !!k).map((k) => strip({ ...k.data }));
				}
				return JSON.stringify(data);
			});
		},

		async "get-summaries"(ctx, keys: string[], fields: string[], expand: any, includeTrashed: boolean) {
			requirePermission(ctx, "library.read");
			keyList(keys);
			const ex = includeFlags(expand);
			const details = await detailsOf(ctx, keys);
			return details.map((d) => (!d || (d.data.deleted && !includeTrashed) ? undefined : summaryFromDetail(d, 1, fields ?? [], ex)));
		},

		async "get-children"(ctx, key: string, includeTrashed: boolean) {
			requirePermission(ctx, "library.read");
			const d = await getDetail(ctx, key);
			if (!d) throw witError("not-found", `item ${key}`);
			const kids = (await detailsOf(ctx, d.children.map((c) => c.key))).filter((k): k is CoreDetail => !!k);
			return kids.filter((k) => includeTrashed || !k.data.deleted).map((k) => summaryFromDetail(k, 1, [], { creators: false, tags: false, collections: false }));
		},

		// --------------------------------------------------------------------------------- collections
		async "list-collections"(ctx, library: number | undefined) {
			requirePermission(ctx, "library.read");
			const lib = library ?? 1;
			const cs = await coreJson<{ key: string; name: string; parentKey: string | null; itemCount: number }[]>(ctx, "/api/collections" + qs({ library: lib }));
			return cs.map((c) => ({ key: c.key, library: lib, name: c.name, parent: c.parentKey ?? undefined, itemCount: c.itemCount, version: 0 }));
		},

		async "get-collection-items"(ctx, key: string, recursive: boolean) {
			requirePermission(ctx, "library.read");
			const lib = await collectionLibrary(ctx, key);
			if (lib === undefined) throw witError("not-found", `collection ${key}`);
			return allKeys(ctx, { library: lib, scope: { tag: "collection", val: { key, recursive } }, tags: [], textMode: "title-creator-year", sort: [] });
		},

		// -------------------------------------------------------------------------------------- tags
		async "list-tags"(ctx, library: number | undefined, within: any) {
			requirePermission(ctx, "library.read");
			const lib = library ?? 1;
			const auto = new Set((await coreJson<{ tag: string }[]>(ctx, "/api/maintenance/tags/automatic" + qs({ library: lib }))).map((t) => t.tag));
			if (!within) {
				const tags = await coreJson<{ tag: string; count: number }[]>(ctx, "/api/tags" + qs({ library: lib }));
				return tags.map((t) => ({ name: t.tag, kind: auto.has(t.tag) ? "automatic" : "manual", count: t.count }));
			}
			const counts = new Map<string, { n: number; type: number }>();
			for (let offset = 0; offset < FACET_SCAN_CAP; ) {
				const p = await runQuery(ctx, { ...within, library: within.library ?? lib, limit: 1000, offset }, [], ["tags"]);
				for (const i of p.items) for (const t of i.tags ?? []) {
					const e = counts.get(t.tag) ?? { n: 0, type: t.type };
					e.n++;
					counts.set(t.tag, e);
				}
				offset += p.items.length;
				if (p.items.length === 0 || offset >= p.total) break;
			}
			return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, e]) => ({ name, kind: e.type ? "automatic" : "manual", count: e.n }));
		},

		async "get-tag-colors"(ctx, _library: number | undefined) {
			requirePermission(ctx, "library.read");
			const cs = await coreJson<{ name: string; color: string; position: number }[]>(ctx, "/api/tag-colors");
			return cs.sort((a, b) => a.position - b.position).map((c) => ({ name: c.name, color: c.color }));
		},

		async "set-tag-colors"(ctx, _library: number | undefined, colors: { name: string; color: string }[]) {
			requirePermission(ctx, "library.write");
			await core(ctx, "/api/tag-colors", { method: "PUT", json: colors.map((c) => ({ name: c.name, color: c.color })) });
		},

		async "rename-tag"(ctx, library: number | undefined, oldName: string, newName: string) {
			requirePermission(ctx, "library.write");
			const r = await coreJson<{ items: number }>(ctx, "/api/maintenance/tags/rename", { json: { from: oldName, to: newName, library: library ?? 1 } });
			return r.items ?? 0;
		},

		async "delete-tags"(ctx, library: number | undefined, names: string[]) {
			requirePermission(ctx, "library.write");
			const r = await coreJson<{ items?: number; removed?: number }>(ctx, "/api/maintenance/tags/delete", { json: { tags: names, library: library ?? 1 } });
			return r.items ?? r.removed ?? 0;
		},

		async "delete-automatic-tags"(ctx, library: number | undefined) {
			requirePermission(ctx, "library.write");
			const r = await coreJson<{ items?: number; removed?: number }>(ctx, "/api/maintenance/tags/delete-automatic", { json: { library: library ?? 1 } });
			return r.items ?? r.removed ?? 0;
		},

		// ----------------------------------------------------------------------------------- relations
		async "find-by-relation"(ctx, _library: number | undefined, _predicate: string, _object: string | undefined) {
			requirePermission(ctx, "library.read");
			throw witError("unavailable", "find-by-relation needs a relation index in core (relations are JSON inside items.data)");
		},

		// ----------------------------------------------------------------------------- saved searches
		"list-search-conditions"() {
			return SEARCH_CONDITIONS;
		},

		async "list-saved-searches"(ctx, _library: number | undefined) {
			requirePermission(ctx, "library.read");
			const list = await coreJson<any[]>(ctx, "/api/searches");
			return list.map((s) => ({ key: s.key, library: 1, name: s.name, definition: searchFromCore(s), dateModified: s.dateModified }));
		},

		async "get-saved-search"(ctx, key: string) {
			requirePermission(ctx, "library.read");
			const s = await coreJson<any>(ctx, `/api/searches/${keySeg(key, "search key")}`);
			return { key: s.key, library: 1, name: s.name, definition: searchFromCore(s), dateModified: s.dateModified };
		},

		// ------------------------------------------------------------------------------------- apply
		async apply(ctx, changes: { tag: string; val: any }[], options: { skipNotify?: boolean } | undefined) {
			const tags = new Set(changes.map((c) => c.tag));
			try {
				if ([...tags].some((t) => WRITE.has(t))) requirePermission(ctx, "library.write");
				if ([...tags].some((t) => TRASH.has(t))) requirePermission(ctx, "library.trash");
				if ([...tags].some((t) => ERASE.has(t))) requirePermission(ctx, "library.erase");
			} catch (e) {
				if (e instanceof WitError) throw applyError(undefined, (e.payload as any).tag, (e.payload as any).val);
				throw e;
			}
			const batch = changes.map((c, i) => toBatchChange(c, i));
			let res: Response;
			try {
				res = await fetch(`${ctx.coreUrl}/api/batch`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ changes: batch, origin: `plugin:${ctx.pluginId}`, skipNotify: !!options?.skipNotify }),
				});
			} catch (e) {
				throw applyError(undefined, "unavailable", `core is not reachable: ${(e as Error).message}`);
			}
			const body = (await res.json().catch(() => ({}))) as { error?: string; index?: number | null; created?: string[]; changed?: number };
			if (!res.ok) {
				const tag = res.status === 404 ? "not-found" : res.status === 409 ? "conflict" : res.status === 403 ? "read-only" : res.status === 400 ? "invalid-argument" : res.status === 501 || res.status === 503 ? "unavailable" : "internal";
				throw applyError(body.index ?? undefined, tag, body.error ?? res.statusText);
			}
			return { created: body.created ?? [], changed: body.changed ?? 0 };
		},

		// -------------------------------------------------------------------------------- duplicates
		async "find-duplicates"(ctx, library: number | undefined) {
			requirePermission(ctx, "library.read");
			const r = await coreJson<{ sets: { keys: string[] }[] }>(ctx, "/api/duplicates" + qs({ library }));
			return r.sets.map((s) => ({ items: s.keys }));
		},

		async "merge-items"(ctx, master: string, others: string[]) {
			requirePermission(ctx, "library.write");
			requirePermission(ctx, "library.trash");
			await core(ctx, "/api/duplicates/merge", { json: { masterKey: master, otherKeys: others } });
		},

		async "mark-not-duplicates"(ctx, items: string[]) {
			requirePermission(ctx, "library.write");
			await core(ctx, "/api/duplicates/not-duplicates", { json: { keys: items } });
		},

		// ---------------------------------------------------------------------------------- trash
		async "empty-trash"(ctx, library: number | undefined, olderThanDays: number | undefined) {
			requirePermission(ctx, "library.erase");
			const r = await coreJson<{ topLevel?: number; erased?: number }>(ctx, "/api/maintenance/empty-trash", { json: { library: library ?? 1, olderThanDays } });
			return r.topLevel ?? r.erased ?? 0;
		},
	},
});
