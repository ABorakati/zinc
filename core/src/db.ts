// SQLite access layer for the zotero-next library (bun:sqlite).
// Schema contract: core/schema.sql. API contract: core/src/api-types.ts.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
// Imported as text so bundlers (Electrobun) embed it instead of reading from disk.
import schema from "../schema.sql" with { type: "text" };
import syncSchema from "./sync/schema.sql" with { type: "text" };
import { canonicalField, convertItemType, hasItemType } from "./schema-data";
import { assertQuickMode, compileSearch, quickSearchClause } from "./searches/compile";
import { ensureSearchSchema, getSavedSearch } from "./searches/store";
import type { QuickSearchMode, SearchDefinition } from "./searches/types";
import type {
	ChildSummary,
	Collection,
	ItemDetail,
	ItemList,
	ItemSummary,
	ReaderAnnotation,
	TagColor,
	ZoteroItemData,
} from "./api-types";

export class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

// ---------------------------------------------------------------- helpers

const KEY_CHARS = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";

export function generateKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	let key = "";
	for (const b of bytes) key += KEY_CHARS[b % KEY_CHARS.length];
	return key;
}

export function nowIso(): string {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

const fileCache = new Map<string, { ok: boolean; at: number }>();
const FILE_CACHE_MS = 5000;

export function fileExists(path: string | null | undefined): boolean {
	if (!path) return false;
	const now = Date.now();
	const hit = fileCache.get(path);
	if (hit && now - hit.at < FILE_CACHE_MS) return hit.ok;
	const ok = existsSync(path);
	fileCache.set(path, { ok, at: now });
	return ok;
}

export function clearFileCache(): void {
	fileCache.clear();
}

function creatorName(c: { lastName?: string; name?: string; firstName?: string }): string {
	return (c.lastName || c.name || c.firstName || "").trim();
}

export function creatorsSummary(creators: ZoteroItemData["creators"]): string {
	if (!creators || creators.length === 0) return "";
	const authors = creators.filter((c) => c.creatorType === "author");
	const list = authors.length > 0 ? authors : creators;
	const names = list.map(creatorName).filter(Boolean);
	if (names.length === 0) return "";
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names[0]} et al.`;
}

export function parseYear(date: unknown): number | null {
	if (typeof date !== "string") return null;
	const m = date.match(/(?<!\d)(\d{4})(?!\d)/);
	return m ? Number(m[1]) : null;
}

function stripHtmlBasic(html: string): string {
	return html
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

export interface DerivedColumns {
	title: string;
	creators_summary: string;
	year: number | null;
	publication: string | null;
}

export function deriveColumns(data: ZoteroItemData): DerivedColumns {
	let title = typeof data.title === "string" ? data.title : "";
	if (!title && data.itemType === "note" && typeof data.note === "string") {
		title = stripHtmlBasic(data.note).slice(0, 120);
	}
	const pub =
		(data.publicationTitle as string | undefined) ||
		(data.bookTitle as string | undefined) ||
		(data.websiteTitle as string | undefined) ||
		(data.proceedingsTitle as string | undefined) ||
		(data.repository as string | undefined) ||
		null;
	return {
		title,
		creators_summary: creatorsSummary(data.creators),
		year: parseYear(data.date),
		publication: pub || null,
	};
}

// ---------------------------------------------------------------- open

export function openDb(path: string): Database {
	const db = new Database(path, { create: true });
	db.exec(schema);
	db.exec(syncSchema);
	db.exec("PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA cache_size = -65536; PRAGMA temp_store = MEMORY; PRAGMA mmap_size = 268435456;");
	for (const [name, expr] of [
		["title", "title COLLATE NOCASE"],
		["creator", "creators_summary COLLATE NOCASE"],
		["year", "year"],
		["added", "date_added"],
	]) {
		db.exec(
			`CREATE INDEX IF NOT EXISTS items_top_${name} ON items(${expr}, key) WHERE parent_key IS NULL AND deleted = 0 AND item_type <> 'annotation'`,
		);
	}
	db.run(
		"INSERT INTO meta(name, value) VALUES('schema_version', '1') ON CONFLICT(name) DO UPDATE SET value = excluded.value",
	);
	return db;
}

// ---------------------------------------------------------------- collections

interface CollectionRow {
	key: string;
	name: string;
	parent_key: string | null;
	item_count: number;
}

const COLLECTION_SQL = `SELECT c.key, c.name, c.parent_key,
	(SELECT count(*) FROM collection_items ci JOIN items i ON i.key = ci.item_key
	 WHERE ci.collection_key = c.key AND i.deleted = 0 AND i.parent_key IS NULL) AS item_count
	FROM collections c`;

function toCollection(r: CollectionRow): Collection {
	return { key: r.key, name: r.name, parentKey: r.parent_key, itemCount: r.item_count };
}

export function listCollections(db: Database): Collection[] {
	const rows = db.query(`${COLLECTION_SQL} ORDER BY c.name COLLATE NOCASE, c.key`).all() as CollectionRow[];
	return rows.map(toCollection);
}

export function getCollection(db: Database, key: string): Collection | null {
	const r = db.query(`${COLLECTION_SQL} WHERE c.key = ?`).get(key) as CollectionRow | null;
	return r ? toCollection(r) : null;
}

function collectionExists(db: Database, key: string): boolean {
	return !!db.query("SELECT 1 FROM collections WHERE key = ?").get(key);
}

export function createCollection(db: Database, name: string, parentKey?: string | null): Collection {
	name = (name ?? "").trim();
	if (!name) throw new HttpError(400, "name is required");
	if (parentKey && !collectionExists(db, parentKey)) throw new HttpError(404, "parent collection not found");
	let key = generateKey();
	while (collectionExists(db, key)) key = generateKey();
	db.query("INSERT INTO collections(key, name, parent_key) VALUES(?, ?, ?)").run(key, name, parentKey || null);
	return getCollection(db, key)!;
}

function descendantKeys(db: Database, key: string): string[] {
	const rows = db
		.query(
			`WITH RECURSIVE d(key) AS (
				SELECT ? UNION ALL SELECT c.key FROM collections c JOIN d ON c.parent_key = d.key
			) SELECT key FROM d`,
		)
		.all(key) as { key: string }[];
	return rows.map((r) => r.key);
}

export function updateCollection(
	db: Database,
	key: string,
	patch: { name?: string; parentKey?: string | null },
): Collection {
	if (!collectionExists(db, key)) throw new HttpError(404, "collection not found");
	if (patch.name !== undefined) {
		const name = String(patch.name).trim();
		if (!name) throw new HttpError(400, "name must not be empty");
		db.query("UPDATE collections SET name = ? WHERE key = ?").run(name, key);
	}
	if (patch.parentKey !== undefined) {
		const parent = patch.parentKey || null;
		if (parent) {
			if (!collectionExists(db, parent)) throw new HttpError(404, "parent collection not found");
			if (descendantKeys(db, key).includes(parent)) throw new HttpError(400, "cannot move a collection into itself");
		}
		db.query("UPDATE collections SET parent_key = ? WHERE key = ?").run(parent, key);
	}
	return getCollection(db, key)!;
}

export function deleteCollection(db: Database, key: string): void {
	if (!collectionExists(db, key)) throw new HttpError(404, "collection not found");
	db.transaction(() => {
		const keys = descendantKeys(db, key);
		const itemKeys = new Set<string>();
		const q = db.query("SELECT item_key FROM collection_items WHERE collection_key = ?");
		for (const ck of keys) for (const r of q.all(ck) as { item_key: string }[]) itemKeys.add(r.item_key);
		for (const ck of keys) db.query("DELETE FROM collection_items WHERE collection_key = ?").run(ck);
		db.query("DELETE FROM collections WHERE key = ?").run(key); // cascades to child collections
		for (const ik of itemKeys) syncDataCollections(db, ik);
	})();
}

function itemExists(db: Database, key: string): boolean {
	return !!db.query("SELECT 1 FROM items WHERE key = ?").get(key);
}

function syncDataCollections(db: Database, itemKey: string): void {
	const rows = db
		.query("SELECT collection_key FROM collection_items WHERE item_key = ? ORDER BY collection_key")
		.all(itemKey) as { collection_key: string }[];
	db.query("UPDATE items SET data = json_set(data, '$.collections', json(?), '$.dateModified', ?), date_modified = ? WHERE key = ?").run(
		JSON.stringify(rows.map((r) => r.collection_key)),
		nowIso(),
		nowIso(),
		itemKey,
	);
}

export function addItemsToCollection(db: Database, collectionKey: string, itemKeys: string[]): void {
	if (!collectionExists(db, collectionKey)) throw new HttpError(404, "collection not found");
	db.transaction(() => {
		for (const k of itemKeys) {
			if (!itemExists(db, k)) throw new HttpError(404, `item not found: ${k}`);
			db.query("INSERT OR IGNORE INTO collection_items(collection_key, item_key) VALUES(?, ?)").run(collectionKey, k);
			syncDataCollections(db, k);
		}
	})();
}

export function removeItemsFromCollection(db: Database, collectionKey: string, itemKeys: string[]): void {
	if (!collectionExists(db, collectionKey)) throw new HttpError(404, "collection not found");
	db.transaction(() => {
		for (const k of itemKeys) {
			db.query("DELETE FROM collection_items WHERE collection_key = ? AND item_key = ?").run(collectionKey, k);
			if (itemExists(db, k)) syncDataCollections(db, k);
		}
	})();
}

// ---------------------------------------------------------------- item list

export interface ListOptions {
	collection?: string;
	tag?: string;
	q?: string;
	sort?: string;
	dir?: string;
	limit?: number;
	offset?: number;
	unfiled?: boolean;
	trash?: boolean;
	fields?: string[];
	include?: string[]; // "creators", "tags"
	search?: string; // saved search key: restrict to its results
	searchDef?: SearchDefinition; // ad-hoc (unsaved) search, same semantics
	qmode?: string; // quick search mode for q: titleCreatorYear (default) | fields | everything
}

interface SummaryRow {
	key: string;
	item_type: string;
	title: string | null;
	creators_summary: string | null;
	year: number | null;
	publication: string | null;
	date_added: string;
}

const SORT_EXPR: Record<string, string> = {
	title: "i.title COLLATE NOCASE",
	creator: "i.creators_summary COLLATE NOCASE",
	year: "i.year",
	dateAdded: "i.date_added",
};

// Sorts on plain columns or computed values with no partial index.
const EXTRA_SORT_EXPR: Record<string, string> = {
	itemType: "i.item_type COLLATE NOCASE",
	dateModified: "i.date_modified",
	publication: "i.publication COLLATE NOCASE",
	noteCount: "(SELECT count(*) FROM items c WHERE c.parent_key = i.key AND c.item_type = 'note' AND c.deleted = 0)",
	attachmentCount: "(SELECT count(*) FROM items c WHERE c.parent_key = i.key AND c.item_type = 'attachment' AND c.deleted = 0)",
};

// Returns the ORDER BY expression for a sort name, or null if it is not a known sort.
// Field names are matched against the schema whitelist, so the interpolated JSON path is safe.
function resolveSort(sort: string): { expr: string; nullsLast: boolean } | null {
	if (SORT_EXPR[sort]) return { expr: SORT_EXPR[sort], nullsLast: false };
	if (EXTRA_SORT_EXPR[sort]) return { expr: EXTRA_SORT_EXPR[sort], nullsLast: sort === "publication" };
	const field = canonicalField(sort);
	if (!field) return null;
	return { expr: `NULLIF(json_extract(i.data, '$.${field}'), '') COLLATE NOCASE`, nullsLast: true };
}

function likeEscape(s: string): string {
	return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function listItems(db: Database, opts: ListOptions = {}): ItemList {
	const where: string[] = ["i.parent_key IS NULL", "i.item_type <> 'annotation'", `i.deleted = ${opts.trash ? 1 : 0}`];
	const params: (string | number)[] = [];
	// A collection or tag filter drives the join (CROSS JOIN fixes the loop order), so the
	// planner never walks all items probing per row.
	let driver = "";
	const driverParams: string[] = [];
	// Tag drives when both are given (tags are usually the more selective filter).
	if (opts.tag) {
		driver = "(SELECT item_key AS k FROM item_tags WHERE tag = ?)";
		driverParams.push(opts.tag);
	}
	if (opts.collection) {
		if (!driver) {
			driver = "(SELECT item_key AS k FROM collection_items WHERE collection_key = ?)";
			driverParams.push(opts.collection);
		} else {
			where.push("EXISTS (SELECT 1 FROM collection_items ci WHERE ci.collection_key = ? AND ci.item_key = i.key)");
			params.push(opts.collection);
		}
	}
	if (opts.unfiled) where.push("NOT EXISTS (SELECT 1 FROM collection_items ci WHERE ci.item_key = i.key)");
	if (opts.qmode) assertQuickMode(opts.qmode);
	if (opts.search || opts.searchDef) {
		ensureSearchSchema(db);
		const def = opts.searchDef ?? getSavedSearch(db, opts.search!);
		if (!def) throw new HttpError(404, "saved search not found");
		const c = compileSearch(db, def);
		if (c.includeTrash) where[2] = "1";
		where.push(c.sql);
		params.push(...c.params);
	}
	if (opts.q && opts.qmode && opts.qmode !== "titleCreatorYear") {
		ensureSearchSchema(db);
		const c = quickSearchClause(opts.q, opts.qmode as QuickSearchMode);
		where.push(c.sql);
		params.push(...c.params);
	} else if (opts.q) {
		for (const term of opts.q.split(/\s+/).filter(Boolean)) {
			const like = `%${likeEscape(term)}%`;
			where.push(
				"(i.title LIKE ? ESCAPE '\\' OR i.creators_summary LIKE ? ESCAPE '\\' OR CAST(i.year AS TEXT) LIKE ? ESCAPE '\\')",
			);
			params.push(like, like, like);
		}
	}
	const whereSql = where.join(" AND ");
	const sortSpec = resolveSort(opts.sort ?? "dateAdded");
	if (!sortSpec) throw new HttpError(400, `invalid sort: ${opts.sort}`);
	const sortExpr = sortSpec.nullsLast ? `(${sortSpec.expr} IS NULL), ${sortSpec.expr}` : sortSpec.expr;
	const fieldNames = (opts.fields ?? []).map((f) => {
		const c = canonicalField(f);
		if (!c) throw new HttpError(400, `invalid field: ${f}`);
		return c;
	});
	const dir = (opts.dir ?? "desc").toLowerCase();
	if (dir !== "asc" && dir !== "desc") throw new HttpError(400, `invalid dir: ${opts.dir}`);
	const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 1000);
	const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);

	// Unfiltered listings walk a partial sort index (see openDb); without stats the planner
	// would otherwise pick items_parent and sort every row.
	const unfiltered = where.length === 3 && !opts.trash && !driver;
	const indexName = { title: "items_top_title", creator: "items_top_creator", year: "items_top_year", dateAdded: "items_top_added" }[
		opts.sort ?? "dateAdded"
	];
	const from = driver
		? `${driver} f CROSS JOIN items i ON i.key = f.k`
		: unfiltered && indexName
			? `items i INDEXED BY ${indexName}`
			: "items i";
	params.unshift(...driverParams);
	let total: number;
	let rows: SummaryRow[];
	if (opts.search || opts.searchDef || (opts.q && opts.qmode && opts.qmode !== "titleCreatorYear")) {
		// Expensive predicates: evaluate the filter once and get the total from a window count.
		const r = db
			.query(
				`SELECT i.key, i.item_type, i.title, i.creators_summary, i.year, i.publication, i.date_added, count(*) OVER () AS total
				 FROM ${from} WHERE ${whereSql}
				 ORDER BY ${sortExpr} ${dir}, i.key ${dir} LIMIT ? OFFSET ?`,
			)
			.all(...params, limit, offset) as (SummaryRow & { total: number })[];
		rows = r;
		total = r.length
			? r[0].total
			: offset > 0
				? (db.query(`SELECT count(*) AS n FROM ${from} WHERE ${whereSql}`).get(...params) as { n: number }).n
				: 0;
	} else {
		total = (db.query(`SELECT count(*) AS n FROM ${from} WHERE ${whereSql}`).get(...params) as { n: number }).n;
		rows = db
			.query(
				`SELECT i.key, i.item_type, i.title, i.creators_summary, i.year, i.publication, i.date_added
				 FROM ${from} WHERE ${whereSql}
				 ORDER BY ${sortExpr} ${dir}, i.key ${dir} LIMIT ? OFFSET ?`,
			)
			.all(...params, limit, offset) as SummaryRow[];
	}
	const items = summarize(db, rows);
	if (fieldNames.length > 0) attachFields(db, items, fieldNames);
	const inc = new Set(opts.include ?? []);
	for (const x of inc) if (x !== "creators" && x !== "tags") throw new HttpError(400, `invalid include: ${x}`);
	if (inc.has("creators")) attachCreators(db, items);
	if (inc.has("tags")) attachTags(db, items);
	return { total, items };
}

// "Amsalem, Eli" -> "Amsalem E"; single-field names stay as they are.
export function formatCreatorInitials(c: { firstName?: string; lastName?: string; name?: string }): string {
	if (c.name) return c.name.trim();
	const last = (c.lastName ?? "").trim();
	const initials = (c.firstName ?? "")
		.split(/[\s\-.]+/)
		.filter(Boolean)
		.map((p) => Array.from(p)[0].toUpperCase())
		.join("");
	return [last, initials].filter(Boolean).join(" ");
}

function attachCreators(db: Database, items: ItemSummary[]): void {
	if (items.length === 0) return;
	const rows = db
		.query("SELECT i.key, json_extract(i.data, '$.creators') AS c FROM json_each(?) j CROSS JOIN items i ON i.key = j.value")
		.all(JSON.stringify(items.map((it) => it.key))) as { key: string; c: string | null }[];
	const byKey = new Map(rows.map((r) => [r.key, r.c]));
	for (const it of items) {
		let list: { firstName?: string; lastName?: string; name?: string }[] = [];
		const raw = byKey.get(it.key);
		if (raw) {
			try {
				const p = JSON.parse(raw);
				if (Array.isArray(p)) list = p;
			} catch {
				// malformed creators: treat as none
			}
		}
		it.creators = list.map(formatCreatorInitials).filter(Boolean);
	}
}

function attachTags(db: Database, items: ItemSummary[]): void {
	if (items.length === 0) return;
	const rows = db
		.query(
			"SELECT t.item_key, t.tag, t.type FROM json_each(?) j JOIN item_tags t ON t.item_key = j.value ORDER BY t.tag COLLATE NOCASE",
		)
		.all(JSON.stringify(items.map((it) => it.key))) as { item_key: string; tag: string; type: number }[];
	const byKey = new Map<string, { tag: string; type: number }[]>();
	for (const r of rows) {
		let l = byKey.get(r.item_key);
		if (!l) byKey.set(r.item_key, (l = []));
		l.push({ tag: r.tag, type: r.type });
	}
	for (const it of items) it.tags = byKey.get(it.key) ?? [];
}

// ---------------------------------------------------------------- tag colours

export function getTagColors(db: Database): TagColor[] {
	const row = db.query("SELECT value FROM meta WHERE name = 'tagColors'").get() as { value: string } | null;
	if (!row) return [];
	try {
		const p = JSON.parse(row.value);
		return Array.isArray(p) ? (p as TagColor[]) : [];
	} catch {
		return [];
	}
}

// Validates and normalises (hex colours, unique names, positions renumbered 0..n-1).
export function normalizeTagColors(input: unknown): TagColor[] {
	if (!Array.isArray(input)) throw new HttpError(400, "body must be an array of {name, color}");
	const seen = new Set<string>();
	const out: TagColor[] = [];
	for (const e of input) {
		if (!e || typeof e !== "object") throw new HttpError(400, "invalid tag colour entry");
		const { name, color } = e as { name?: unknown; color?: unknown };
		if (typeof name !== "string" || !name.trim()) throw new HttpError(400, "tag colour name is required");
		if (typeof color !== "string" || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
			throw new HttpError(400, `invalid colour for "${name}": expected hex like #FF6666`);
		}
		const n = name.trim();
		if (seen.has(n)) throw new HttpError(400, `duplicate tag colour name: ${n}`);
		seen.add(n);
		out.push({ name: n, color, position: out.length });
	}
	return out;
}

export function setTagColors(db: Database, input: unknown): TagColor[] {
	const colors = normalizeTagColors(input);
	db.query("INSERT INTO meta(name, value) VALUES('tagColors', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(
		JSON.stringify(colors),
	);
	return colors;
}

// Fills ItemSummary.fields from items.data (field names are already whitelisted).
function attachFields(db: Database, items: ItemSummary[], fields: string[]): void {
	if (items.length === 0) return;
	const cols = fields.map((f, i) => `json_extract(i.data, '$.${f}') AS f${i}`).join(", ");
	const rows = db
		.query(`SELECT i.key, ${cols} FROM json_each(?) j CROSS JOIN items i ON i.key = j.value`)
		.all(JSON.stringify(items.map((it) => it.key))) as Record<string, unknown>[];
	const byKey = new Map(rows.map((r) => [r.key as string, r]));
	for (const it of items) {
		const r = byKey.get(it.key);
		const out: Record<string, string | null> = {};
		fields.forEach((f, i) => {
			const v = r?.[`f${i}`];
			out[f] = v === null || v === undefined || v === "" ? null : String(v);
		});
		it.fields = out;
	}
}

const CONTENT_RANK = (ct: string | null): number => {
	if (!ct) return 99;
	if (ct === "application/pdf") return 0;
	if (ct === "application/epub+zip") return 1;
	if (ct === "text/html" || ct === "application/xhtml+xml") return 2;
	return 99;
};

export function pickPrimary(children: { key: string; contentType: string | null }[]): { key: string; contentType: string } | null {
	let best: { key: string; contentType: string } | null = null;
	let bestRank = 99;
	for (const c of children) {
		const r = CONTENT_RANK(c.contentType);
		if (r < bestRank) {
			bestRank = r;
			best = { key: c.key, contentType: c.contentType! };
		}
	}
	return best;
}

function summarize(db: Database, rows: SummaryRow[]): ItemSummary[] {
	if (rows.length === 0) return [];
	const kids = db
		.query(
			`SELECT i.parent_key AS parent, i.key, i.item_type, a.content_type
			 FROM json_each(?) j CROSS JOIN items i ON i.parent_key = j.value
			 LEFT JOIN attachments a ON a.item_key = i.key
			 WHERE i.deleted = 0 AND i.item_type IN ('attachment', 'note')
			 ORDER BY i.date_added, i.key`,
		)
		.all(JSON.stringify(rows.map((r) => r.key))) as {
		parent: string;
		key: string;
		item_type: string;
		content_type: string | null;
	}[];
	const byParent = new Map<string, typeof kids>();
	for (const k of kids) {
		const l = byParent.get(k.parent);
		if (l) l.push(k);
		else byParent.set(k.parent, [k]);
	}
	return rows.map((r) => {
		const ch = byParent.get(r.key) ?? [];
		const atts = ch.filter((c) => c.item_type === "attachment");
		return {
			key: r.key,
			itemType: r.item_type,
			title: r.title ?? "",
			creatorsSummary: r.creators_summary ?? "",
			year: r.year,
			publication: r.publication,
			dateAdded: r.date_added,
			primaryAttachment: pickPrimary(atts.map((a) => ({ key: a.key, contentType: a.content_type }))),
			attachmentCount: atts.length,
			noteCount: ch.length - atts.length,
		};
	});
}

// ---------------------------------------------------------------- item detail

export function getItemDetail(db: Database, key: string): ItemDetail | null {
	const row = db.query("SELECT data FROM items WHERE key = ?").get(key) as { data: string } | null;
	if (!row) return null;
	const data = JSON.parse(row.data) as ZoteroItemData;
	const kids = db
		.query(
			`SELECT i.key, i.item_type, i.title, a.content_type, a.link_mode, a.path,
				(SELECT count(*) FROM annotations an WHERE an.attachment_key = i.key) AS ann_count
			 FROM items i LEFT JOIN attachments a ON a.item_key = i.key
			 WHERE i.parent_key = ? AND i.item_type IN ('attachment', 'note') AND i.deleted = 0
			 ORDER BY i.date_added, i.key`,
		)
		.all(key) as {
		key: string;
		item_type: "attachment" | "note";
		title: string | null;
		content_type: string | null;
		link_mode: string | null;
		path: string | null;
		ann_count: number;
	}[];
	const children: ChildSummary[] = kids.map((k) => ({
		key: k.key,
		itemType: k.item_type,
		title: k.title ?? "",
		contentType: k.content_type,
		linkMode: k.link_mode,
		hasFile: k.item_type === "attachment" && fileExists(k.path),
		annotationCount: k.ann_count,
	}));
	const collections = (
		db.query("SELECT collection_key FROM collection_items WHERE item_key = ? ORDER BY collection_key").all(key) as {
			collection_key: string;
		}[]
	).map((r) => r.collection_key);
	const tags = db.query("SELECT tag, type FROM item_tags WHERE item_key = ? ORDER BY tag COLLATE NOCASE").all(key) as {
		tag: string;
		type: number;
	}[];
	const detail: ItemDetail = { data, children, collections, tags };
	const related = resolveRelated(db, data);
	if (related.length > 0) detail.related = related;
	return detail;
}

// ---------------------------------------------------------------- related items

const RELATION = "dc:relation";

function relationUris(data: ZoteroItemData): string[] {
	const v = data.relations?.[RELATION];
	return Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
}

// Item key at the end of a Zotero item URI, whatever user/library it names.
function uriKey(uri: string): string | null {
	return /\/items\/([A-Z0-9]{8})$/.exec(uri)?.[1] ?? null;
}

function resolveRelated(db: Database, data: ZoteroItemData): NonNullable<ItemDetail["related"]> {
	const keys = [...new Set(relationUris(data).map(uriKey).filter((k): k is string => !!k))];
	if (keys.length === 0) return [];
	const rows = db
		.query(
			`SELECT i.key, i.item_type, i.title, i.creators_summary, i.year
			 FROM json_each(?) j CROSS JOIN items i ON i.key = j.value WHERE i.deleted = 0`,
		)
		.all(JSON.stringify(keys)) as { key: string; item_type: string; title: string | null; creators_summary: string | null; year: number | null }[];
	const byKey = new Map(rows.map((r) => [r.key, r]));
	const out: NonNullable<ItemDetail["related"]> = [];
	for (const k of keys) {
		const r = byKey.get(k);
		if (r) out.push({ key: r.key, itemType: r.item_type, title: r.title ?? "", creatorsSummary: r.creators_summary ?? "", year: r.year });
	}
	return out;
}

// Local library id used in relation URIs (http://zotero.org/users/local/<id>/items/<KEY>).
function libraryKey(db: Database): string {
	const row = db.query("SELECT value FROM meta WHERE name = 'library_key'").get() as { value: string } | null;
	if (row) return row.value;
	const key = generateKey();
	db.query("INSERT INTO meta(name, value) VALUES('library_key', ?)").run(key);
	return key;
}

function setRelations(db: Database, key: string, uris: string[]): void {
	const row = db.query("SELECT data FROM items WHERE key = ?").get(key) as { data: string };
	const data = JSON.parse(row.data) as ZoteroItemData;
	const relations = { ...(data.relations ?? {}) };
	if (uris.length === 0) delete relations[RELATION];
	else relations[RELATION] = uris.length === 1 ? uris[0] : uris;
	data.relations = relations;
	const now = nowIso();
	data.dateModified = now;
	db.query("UPDATE items SET data = ?, date_modified = ? WHERE key = ?").run(JSON.stringify(data), now, key);
}

function changeRelated(db: Database, key: string, others: string[], add: boolean): ItemDetail {
	if (!itemExists(db, key)) throw new HttpError(404, "item not found");
	for (const k of others) {
		if (k === key) throw new HttpError(400, "an item cannot be related to itself");
		if (add && !itemExists(db, k)) throw new HttpError(404, `item not found: ${k}`);
	}
	db.transaction(() => {
		const lib = libraryKey(db);
		const apply = (from: string, to: string) => {
			const row = db.query("SELECT data FROM items WHERE key = ?").get(from) as { data: string } | null;
			if (!row) return;
			const uris = relationUris(JSON.parse(row.data) as ZoteroItemData);
			const has = uris.some((u) => uriKey(u) === to);
			if (add && !has) setRelations(db, from, [...uris, `http://zotero.org/users/local/${lib}/items/${to}`]);
			else if (!add && has) setRelations(db, from, uris.filter((u) => uriKey(u) !== to));
		};
		for (const k of others) {
			apply(key, k);
			apply(k, key);
		}
	})();
	return getItemDetail(db, key)!;
}

export function addRelated(db: Database, key: string, others: string[]): ItemDetail {
	return changeRelated(db, key, others, true);
}

export function removeRelated(db: Database, key: string, others: string[]): ItemDetail {
	return changeRelated(db, key, others, false);
}

// ---------------------------------------------------------------- create item

export function createItem(db: Database, input: Partial<ZoteroItemData>): ItemDetail {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "data must be an object");
	const itemType = input.itemType;
	if (typeof itemType !== "string" || !itemType) throw new HttpError(400, "data.itemType is required");
	if (!hasItemType(itemType)) throw new HttpError(400, `unknown itemType: ${itemType}`);
	const parent = input.parentItem ?? null;
	if (parent !== null && typeof parent !== "string") throw new HttpError(400, "parentItem must be a string");
	if (parent) {
		const p = db.query("SELECT parent_key FROM items WHERE key = ?").get(parent) as { parent_key: string | null } | null;
		if (!p) throw new HttpError(404, "parent item not found");
		if (p.parent_key) throw new HttpError(400, "parent item must be a top-level item");
		if (itemType !== "note" && itemType !== "attachment") throw new HttpError(400, "only notes and attachments can have a parent");
	} else if (input.parentItem !== undefined && input.parentItem !== null && input.parentItem !== "") {
		throw new HttpError(400, "invalid parentItem");
	}
	const {
		key: _k,
		dateAdded: _a,
		dateModified: _m,
		deleted: _d,
		version: _v,
		tags: tagsIn,
		collections: collsIn,
		parentItem: _p,
		...rest
	} = input as Record<string, unknown> & Partial<ZoteroItemData>;
	if (tagsIn !== undefined && !Array.isArray(tagsIn)) throw new HttpError(400, "tags must be an array");
	if (collsIn !== undefined && (!Array.isArray(collsIn) || collsIn.some((c) => typeof c !== "string"))) {
		throw new HttpError(400, "collections must be an array of strings");
	}
	const collections = parent ? [] : [...new Set((collsIn ?? []) as string[])];
	for (const c of collections) if (!collectionExists(db, c)) throw new HttpError(404, `collection not found: ${c}`);
	const tags: { tag: string; type?: number }[] = [];
	const seen = new Set<string>();
	for (const t of (tagsIn ?? []) as { tag?: unknown; type?: number }[]) {
		const tag = String(typeof t === "string" ? t : (t?.tag ?? "")).trim();
		if (!tag || seen.has(tag)) continue;
		seen.add(tag);
		tags.push(typeof t === "object" && t?.type ? { tag, type: t.type } : { tag });
	}

	let key = generateKey();
	while (itemExists(db, key)) key = generateKey();
	const now = nowIso();
	const data: ZoteroItemData = { key, ...(rest as object), itemType, dateAdded: now, dateModified: now } as ZoteroItemData;
	if (parent) data.parentItem = parent;
	data.tags = tags;
	data.collections = collections;
	if (typeof data.relations !== "object" || data.relations === null) data.relations = {};
	if (itemType === "attachment" && !data.linkMode) data.linkMode = "linked_url";
	const cols = deriveColumns(data);
	db.transaction(() => {
		db.query(
			`INSERT INTO items(key, item_type, parent_key, title, creators_summary, year, publication, data, date_added, date_modified, deleted)
			 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		).run(key, itemType, parent || null, cols.title, cols.creators_summary, cols.year, cols.publication, JSON.stringify(data), now, now);
		for (const t of tags) db.query("INSERT INTO item_tags(item_key, tag, type) VALUES(?, ?, ?)").run(key, t.tag, t.type ?? 0);
		for (const c of collections) db.query("INSERT INTO collection_items(collection_key, item_key) VALUES(?, ?)").run(c, key);
		if (itemType === "attachment") {
			db.query("INSERT INTO attachments(item_key, link_mode, content_type, path, url) VALUES(?, ?, ?, NULL, ?)").run(
				key,
				String(data.linkMode),
				typeof data.contentType === "string" ? data.contentType : null,
				typeof data.url === "string" ? data.url : null,
			);
		}
	})();
	return getItemDetail(db, key)!;
}

export function patchItem(db: Database, key: string, patch: Partial<ZoteroItemData>): ItemDetail {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "data must be an object");
	const row = db.query("SELECT data FROM items WHERE key = ?").get(key) as { data: string } | null;
	if (!row) throw new HttpError(404, "item not found");
	let data = JSON.parse(row.data) as ZoteroItemData;
	const { key: _k, itemType, dateAdded: _a, ...rest } = patch;
	// Changing the item type remaps fields and creator types first (Zotero's rules);
	// any other fields in the same patch then apply to the new type.
	if (itemType !== undefined && itemType !== data.itemType) {
		if (typeof itemType !== "string" || !hasItemType(itemType)) throw new HttpError(400, `unknown item type: ${String(itemType)}`);
		try {
			data = convertItemType(data, itemType).data;
		} catch (e) {
			throw new HttpError(400, (e as Error).message);
		}
	}
	db.transaction(() => {
		Object.assign(data, rest);
		const now = nowIso();
		data.dateModified = now;
		const cols = deriveColumns(data);
		if (rest.tags !== undefined) {
			db.query("DELETE FROM item_tags WHERE item_key = ?").run(key);
			const seen = new Set<string>();
			const norm: { tag: string; type?: number }[] = [];
			for (const t of rest.tags ?? []) {
				const tag = String(t.tag ?? "").trim();
				if (!tag || seen.has(tag)) continue;
				seen.add(tag);
				db.query("INSERT INTO item_tags(item_key, tag, type) VALUES(?, ?, ?)").run(key, tag, t.type ?? 0);
				norm.push(t.type ? { tag, type: t.type } : { tag });
			}
			data.tags = norm;
		}
		if (rest.collections !== undefined) {
			db.query("DELETE FROM collection_items WHERE item_key = ?").run(key);
			const valid: string[] = [];
			for (const ck of rest.collections ?? []) {
				if (!collectionExists(db, ck)) continue;
				db.query("INSERT OR IGNORE INTO collection_items(collection_key, item_key) VALUES(?, ?)").run(ck, key);
				valid.push(ck);
			}
			data.collections = valid;
		}
		// Trash uses Zotero's convention: data.deleted = 1 while in the trash, absent otherwise.
		if (rest.deleted !== undefined) {
			if (rest.deleted) data.deleted = 1;
			else delete data.deleted;
		}
		db.query(
			"UPDATE items SET data = ?, item_type = ?, title = ?, creators_summary = ?, year = ?, publication = ?, date_modified = ?, deleted = ? WHERE key = ?",
		).run(JSON.stringify(data), data.itemType, cols.title, cols.creators_summary, cols.year, cols.publication, now, data.deleted ? 1 : 0, key);
	})();
	return getItemDetail(db, key)!;
}

// ---------------------------------------------------------------- tags

function syncDataTags(db: Database, itemKey: string): void {
	const rows = db.query("SELECT tag, type FROM item_tags WHERE item_key = ? ORDER BY tag").all(itemKey) as {
		tag: string;
		type: number;
	}[];
	const now = nowIso();
	db.query("UPDATE items SET data = json_set(data, '$.tags', json(?), '$.dateModified', ?), date_modified = ? WHERE key = ?").run(
		JSON.stringify(rows.map((r) => (r.type ? { tag: r.tag, type: r.type } : { tag: r.tag }))),
		now,
		now,
		itemKey,
	);
}

export function addTags(db: Database, itemKey: string, tags: string[]): void {
	if (!itemExists(db, itemKey)) throw new HttpError(404, "item not found");
	db.transaction(() => {
		for (const raw of tags) {
			const tag = raw.trim();
			if (tag) db.query("INSERT OR IGNORE INTO item_tags(item_key, tag, type) VALUES(?, ?, 0)").run(itemKey, tag);
		}
		syncDataTags(db, itemKey);
	})();
}

export function removeTags(db: Database, itemKey: string, tags: string[]): void {
	if (!itemExists(db, itemKey)) throw new HttpError(404, "item not found");
	db.transaction(() => {
		for (const tag of tags) db.query("DELETE FROM item_tags WHERE item_key = ? AND tag = ?").run(itemKey, tag);
		syncDataTags(db, itemKey);
	})();
}

export function listTags(db: Database): { tag: string; count: number }[] {
	return db
		.query(
			`SELECT t.tag, count(*) AS count FROM item_tags t JOIN items i ON i.key = t.item_key
			 WHERE i.deleted = 0 GROUP BY t.tag ORDER BY t.tag COLLATE NOCASE`,
		)
		.all() as { tag: string; count: number }[];
}

// ---------------------------------------------------------------- attachments

export interface AttachmentRow {
	item_key: string;
	link_mode: string;
	content_type: string | null;
	path: string | null;
	url: string | null;
}

export function getAttachment(db: Database, key: string): AttachmentRow | null {
	return db.query("SELECT * FROM attachments WHERE item_key = ?").get(key) as AttachmentRow | null;
}

function requireAttachment(db: Database, key: string): void {
	if (!db.query("SELECT 1 FROM items WHERE key = ? AND item_type = 'attachment'").get(key)) {
		throw new HttpError(404, "attachment not found");
	}
}

export function getAnnotations(db: Database, attachmentKey: string): ReaderAnnotation[] {
	requireAttachment(db, attachmentKey);
	const rows = db.query("SELECT data FROM annotations WHERE attachment_key = ?").all(attachmentKey) as { data: string }[];
	const anns = rows.map((r) => JSON.parse(r.data) as ReaderAnnotation);
	anns.sort((a, b) => (a.sortIndex < b.sortIndex ? -1 : a.sortIndex > b.sortIndex ? 1 : 0));
	return anns;
}

export function upsertAnnotations(db: Database, attachmentKey: string, anns: ReaderAnnotation[]): void {
	requireAttachment(db, attachmentKey);
	if (!Array.isArray(anns)) throw new HttpError(400, "body must be an array of annotations");
	for (const a of anns) if (!a || typeof a.id !== "string" || !a.id) throw new HttpError(400, "annotation id is required");
	db.transaction(() => {
		const q = db.query(
			`INSERT INTO annotations(key, attachment_key, data, date_modified) VALUES(?, ?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET data = excluded.data, date_modified = excluded.date_modified,
			 attachment_key = excluded.attachment_key`,
		);
		for (const a of anns) q.run(a.id, attachmentKey, JSON.stringify(a), a.dateModified || nowIso());
	})();
}

export function deleteAnnotations(db: Database, attachmentKey: string, ids: string[]): void {
	requireAttachment(db, attachmentKey);
	db.transaction(() => {
		for (const id of ids) db.query("DELETE FROM annotations WHERE key = ? AND attachment_key = ?").run(id, attachmentKey);
	})();
}

export function getViewState(db: Database, attachmentKey: string): unknown | null {
	requireAttachment(db, attachmentKey);
	const row = db.query("SELECT data FROM view_state WHERE attachment_key = ?").get(attachmentKey) as { data: string } | null;
	return row ? JSON.parse(row.data) : null;
}

export function putViewState(db: Database, attachmentKey: string, state: unknown): void {
	requireAttachment(db, attachmentKey);
	db.query(
		"INSERT INTO view_state(attachment_key, data) VALUES(?, ?) ON CONFLICT(attachment_key) DO UPDATE SET data = excluded.data",
	).run(attachmentKey, JSON.stringify(state));
}
