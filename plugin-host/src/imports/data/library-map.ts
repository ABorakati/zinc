// Mapping between the WIT `library` records (jco form) and core's HTTP shapes.
import { witError, type HandlerContext } from "../registry";
import { core, coreJson, keySeg, pmap, qs } from "./core";
import { displayTitle, firstCreator, publicationOf, yearOf } from "./utils";

export interface CoreSummary {
	key: string;
	itemType: string;
	title: string;
	creatorsSummary: string;
	year: number | null;
	publication: string | null;
	dateAdded: string;
	primaryAttachment: { key: string; contentType: string } | null;
	attachmentCount: number;
	noteCount: number;
	fields?: Record<string, string | null>;
	creators?: string[];
	tags?: { tag: string; type: number }[];
}

export interface CoreDetail {
	data: Record<string, any>;
	children: { key: string; itemType: string; title: string; contentType: string | null; linkMode: string | null; hasFile: boolean }[];
	collections: string[];
	tags: { tag: string; type: number }[];
}

/** jco's `item-include` flags value: an object of booleans (flags) in jco 1.x. */
export function includeFlags(expand: any): { creators: boolean; tags: boolean; collections: boolean } {
	const f = expand ?? {};
	return { creators: !!f.creators, tags: !!f.tags, collections: !!f.collections };
}

const tagKind = (type: number | undefined) => (type ? "automatic" : "manual");

export function toSummary(s: CoreSummary, library: number, fields: string[], opts: { inTrash: boolean; dateModified?: string; parentKey?: string }): any {
	return {
		key: s.key,
		library,
		itemType: s.itemType,
		title: s.title ?? "",
		creatorsSummary: s.creatorsSummary ?? "",
		year: s.year ?? undefined,
		publication: s.publication ?? undefined,
		dateAdded: s.dateAdded,
		dateModified: opts.dateModified ?? s.fields?.dateModified ?? s.dateAdded,
		parentKey: opts.parentKey,
		bestAttachment: s.primaryAttachment?.key,
		attachmentCount: s.attachmentCount ?? 0,
		noteCount: s.noteCount ?? 0,
		inTrash: opts.inTrash,
		fields: fields.map((f) => [f, s.fields?.[f] ?? undefined]),
		creators: s.creators ?? [],
		tags: (s.tags ?? []).map((t) => ({ name: t.tag, kind: tagKind(t.type) })),
		collections: [],
	};
}

// --------------------------------------------------------------------------------------------- best attachment
const rank = (contentType: string | null, linkMode: string | null): number => {
	const t = (contentType ?? "").toLowerCase();
	if (linkMode === "linked_url") return 9;
	if (t === "application/pdf") return 0;
	if (t === "application/epub+zip") return 1;
	if (t.startsWith("text/html")) return 2;
	return 5;
};

/** Attachment children in Zotero's preference order: PDF, EPUB, snapshot, other files, links. */
export function orderAttachments(children: CoreDetail["children"]): string[] {
	return children
		.filter((c) => c.itemType === "attachment")
		.map((c, i) => ({ k: c.key, r: rank(c.contentType, c.linkMode), i, file: c.hasFile ? 0 : 1 }))
		.sort((a, b) => a.r - b.r || a.file - b.file || a.i - b.i)
		.map((x) => x.k);
}

/** A summary built from an item detail (for get-summaries / get-children, where core has no bulk-by-key listing). */
export function summaryFromDetail(d: CoreDetail, library: number, fields: string[], expand: ReturnType<typeof includeFlags>): any {
	const data = d.data;
	const children = d.children ?? [];
	return {
		key: data.key,
		library,
		itemType: data.itemType,
		title: displayTitle(data),
		creatorsSummary: firstCreator(data),
		year: yearOf(data.date),
		publication: publicationOf(data),
		dateAdded: data.dateAdded ?? "",
		dateModified: data.dateModified ?? data.dateAdded ?? "",
		parentKey: data.parentItem || undefined,
		bestAttachment: orderAttachments(children)[0],
		attachmentCount: children.filter((c) => c.itemType === "attachment").length,
		noteCount: children.filter((c) => c.itemType === "note").length,
		inTrash: !!data.deleted,
		fields: fields.map((f) => {
			const v = data[f];
			return [f, v === undefined || v === null || v === "" ? undefined : String(v)];
		}),
		creators: expand.creators
			? (Array.isArray(data.creators) ? data.creators : []).map((c: any) =>
					c.name ? String(c.name) : [c.lastName, ...(c.firstName ? [String(c.firstName).split(/[\s.-]+/).filter(Boolean).map((p: string) => p[0].toUpperCase()).join("")] : [])].filter(Boolean).join(" "),
				)
			: [],
		tags: expand.tags ? d.tags.map((t) => ({ name: t.tag, kind: tagKind(t.type) })) : [],
		collections: expand.collections ? d.collections : [],
	};
}

export async function getDetail(ctx: HandlerContext, key: string): Promise<CoreDetail | undefined> {
	const res = await fetchOptional(ctx, `/api/items/${keySeg(key, "item key")}`);
	return res ? ((await res.json()) as CoreDetail) : undefined;
}

/** GET that answers undefined on 404 instead of throwing. */
export async function fetchOptional(ctx: HandlerContext, path: string): Promise<Response | undefined> {
	try {
		return await core(ctx, path);
	} catch (e: any) {
		if (e?.payload?.tag === "not-found") return undefined;
		throw e;
	}
}

export async function detailsOf(ctx: HandlerContext, keys: string[]): Promise<(CoreDetail | undefined)[]> {
	for (const k of keys) keySeg(k, "item key"); // all of them before the first request
	return pmap(keys, 8, (k) => getDetail(ctx, k));
}

// ------------------------------------------------------------------------------------------------- search
const OPERATORS = new Set(["is", "isNot", "contains", "doesNotContain", "beginsWith", "isBefore", "isAfter", "isInTheLast"]);

/** WIT `search-definition` to core's `{conditions, options}`. `required` has no counterpart in core and is ignored. */
export function searchToCore(def: any): { conditions: { field: string; operator: string; value: string }[]; options: Record<string, unknown> } {
	const conditions = (def?.conditions ?? []).map((c: any, i: number) => {
		if (c.condition === "groupStart" || c.condition === "groupEnd") throw witError("invalid-argument", `condition ${i + 1}: groups are not supported by this core`);
		if (!OPERATORS.has(c.operator)) throw witError("invalid-argument", `condition ${i + 1}: operator ${c.operator} is not supported by this core`);
		return { field: c.condition, operator: c.operator, value: c.value ?? "" };
	});
	const o = def?.options ?? {};
	return {
		conditions,
		options: {
			match: o.join === "any" ? "any" : "all",
			includeParentsAndChildren: !!o.includeParentsAndChildren,
			searchSubcollections: !!o.searchSubcollections,
			topLevelOnly: !!o.topLevelOnly,
			includeTrash: !!o.includeTrash,
		},
	};
}

export function searchFromCore(s: { conditions: any[]; options: any }): any {
	return {
		conditions: s.conditions.map((c) => ({ condition: c.field, operator: c.operator, value: c.value, required: false })),
		options: {
			join: s.options.match === "any" ? "any" : "all",
			includeParentsAndChildren: !!s.options.includeParentsAndChildren,
			searchSubcollections: !!s.options.searchSubcollections,
			topLevelOnly: !!s.options.topLevelOnly,
			includeTrash: !!s.options.includeTrash,
		},
	};
}

// -------------------------------------------------------------------------------------------------- query
const QMODE: Record<string, string> = { "title-creator-year": "titleCreatorYear", fields: "fields", everything: "everything" };
const MAX_PAGE = 1000;
const DEFAULT_PAGE = 200;

export interface QueryResult {
	total: number;
	items: CoreSummary[];
	library: number;
	inTrash: boolean;
}

/** Run a WIT `item-query` against core. Items come back as core summaries; `dateModified` is always in `fields`. */
export async function runQuery(ctx: HandlerContext, q: any, wantFields: string[], include: string[]): Promise<QueryResult> {
	const scope = q.scope ?? { tag: "all" };
	const limit = Math.min(q.limit > 0 ? q.limit : DEFAULT_PAGE, MAX_PAGE);
	const offset = q.offset ?? 0;
	const fields = [...new Set([...wantFields, "dateModified"])];
	const sorts: any[] = q.sort ?? [];
	const sortParams = {
		sort: sorts[0]?.field,
		dir: sorts[0] ? (sorts[0].ascending ? "asc" : "desc") : undefined,
		then: sorts.slice(1, 4).map((s: any) => `${s.field}:${s.ascending ? "asc" : "desc"}`).join(",") || undefined,
	};
	const tags: string[] = q.tags ?? [];
	const library: number | undefined = q.library ?? undefined;
	const text: string | undefined = q.text ?? undefined;
	const mode = QMODE[q.textMode] ?? "titleCreatorYear";

	if (scope.tag === "children-of") {
		const d = await getDetail(ctx, scope.val);
		if (!d) throw witError("not-found", `item ${scope.val}`);
		const lib = library ?? 1;
		const kids = (await detailsOf(ctx, d.children.map((c) => c.key))).filter((x): x is CoreDetail => !!x);
		const all = kids.map((k) => detailToCoreSummary(k, fields));
		return { total: all.length, items: all.slice(offset, offset + limit), library: lib, inTrash: false };
	}
	if (scope.tag === "saved-search" && q.search) throw witError("invalid-argument", "a saved-search scope cannot be combined with an ad-hoc search");

	const recursive = scope.tag === "collection" && !!scope.val?.recursive;
	const needsRun = !!q.search || tags.length > 1 || recursive;
	let page: { total: number; items: CoreSummary[] };
	if (needsRun) {
		if (scope.tag === "saved-search" || scope.tag === "unfiled" || scope.tag === "trash" || scope.tag === "publications")
			throw witError("invalid-argument", `scope ${scope.tag} cannot be combined with an ad-hoc search, several tags or a recursive collection`);
		const base = q.search ? searchToCore(q.search) : { conditions: [], options: { match: "all" } as Record<string, unknown> };
		const extra: { field: string; operator: string; value: string }[] = [];
		for (const t of tags) extra.push({ field: "tag", operator: "is", value: t });
		if (scope.tag === "collection") extra.push({ field: "collection", operator: "is", value: scope.val.key });
		if (text) extra.push({ field: "anyField", operator: "contains", value: text });
		if (extra.length && base.options.match === "any" && base.conditions.length > 1)
			throw witError("invalid-argument", "an any-join search cannot be combined with tags, text or a collection scope in one query");
		const options = { ...base.options, ...(recursive ? { searchSubcollections: true } : {}), ...(extra.length ? { match: "all" } : {}) };
		page = await coreJson(ctx, "/api/searches/run", {
			json: { conditions: [...base.conditions, ...extra], options, ...sortParams, limit, offset, fields, include },
		});
	} else {
		page = await coreJson(
			ctx,
			"/api/items" +
				qs({
					library,
					collection: scope.tag === "collection" ? scope.val.key : undefined,
					search: scope.tag === "saved-search" ? scope.val : undefined,
					unfiled: scope.tag === "unfiled" ? 1 : undefined,
					publications: scope.tag === "publications" ? 1 : undefined,
					trash: scope.tag === "trash" ? 1 : undefined,
					tag: tags[0],
					q: text,
					qmode: text ? mode : undefined,
					...sortParams,
					limit,
					offset,
					fields,
					include,
				}),
		);
	}
	return { ...page, library: library ?? 1, inTrash: scope.tag === "trash" };
}

function detailToCoreSummary(d: CoreDetail, fields: string[]): CoreSummary {
	const data = d.data;
	const f: Record<string, string | null> = {};
	for (const k of fields) f[k] = data[k] === undefined || data[k] === "" ? null : String(data[k]);
	return {
		key: data.key,
		itemType: data.itemType,
		title: displayTitle(data),
		creatorsSummary: firstCreator(data),
		year: yearOf(data.date) ?? null,
		publication: publicationOf(data) ?? null,
		dateAdded: data.dateAdded ?? "",
		primaryAttachment: null,
		attachmentCount: 0,
		noteCount: 0,
		fields: f,
	};
}

/** Walk every page of a query (keys only), up to `max` items. */
export async function allKeys(ctx: HandlerContext, q: any, max = 50_000): Promise<string[]> {
	const out: string[] = [];
	for (let offset = 0; out.length < max; ) {
		const p = await runQuery(ctx, { ...q, limit: MAX_PAGE, offset }, [], []);
		for (const i of p.items) out.push(i.key);
		offset += p.items.length;
		if (p.items.length === 0 || offset >= p.total) break;
	}
	return out;
}
