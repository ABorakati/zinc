// JSON-RPC 2.0 for tools built for Better BibTeX (served at /better-bibtex/json-rpc on the Zotero port).
// Method names, parameters and result shapes follow BBT's documented API
// (https://retorque.re/zotero-better-bibtex/exporting/json-rpc/); the implementation is original (BBT is MIT, see NOTICE).
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import type { ZoteroItemData } from "../api-types";
import { itemToCsl } from "../cite/csl";
import { citeService } from "../cite/api";
import * as repo from "../db";
import { addAutoExport } from "./autoexport";
import { translatorFormat } from "./cite";
import { exportBetterFormat } from "./export";
import { getKeyInfos, itemsForCitekey, refreshKeys } from "./keys";
import { selectedItemKeys } from "./hooks";

const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMETERS = -32602;
const INTERNAL_ERROR = -32603;
const PARSE_ERROR = -32700;
const LIBRARY = "My Library";

class RpcError extends Error {
	constructor(public code: number, message: string) {
		super(message);
	}
}
const invalid = (message: string): never => {
	throw new RpcError(INVALID_PARAMETERS, message);
};

/** Single-library app: every way of naming the user library resolves, anything else is an error. */
function checkLibrary(library: unknown): void {
	if (library === undefined || library === null || library === "" || library === "*") return;
	const l = String(library);
	if (["0", "1", LIBRARY, "library"].includes(l) || l.toLowerCase() === LIBRARY.toLowerCase()) return;
	throw new RpcError(INTERNAL_ERROR, `could not find library ${l}`);
}

const stripAt = (k: string) => k.replace(/^@/, "");

function loadData(db: Database, key: string): ZoteroItemData | null {
	const r = db.query("SELECT data FROM items WHERE key = ?").get(key) as { data: string } | null;
	return r ? (JSON.parse(r.data) as ZoteroItemData) : null;
}

/** Regular, non-deleted top-level item keys. */
function regularKeys(db: Database): string[] {
	return (db.query("SELECT key FROM items WHERE deleted = 0 AND parent_key IS NULL AND item_type NOT IN ('note','attachment','annotation') ORDER BY date_added, key").all() as { key: string }[]).map((r) => r.key);
}

function cslFor(db: Database, key: string): Record<string, unknown> | null {
	const d = loadData(db, key);
	if (!d) return null;
	const info = getKeyInfos(db, [key])[key];
	const csl = itemToCsl(d) as Record<string, unknown>;
	csl.id = `http://zotero.org/users/local/items/${key}`;
	return { ...csl, library: LIBRARY, citekey: info?.key ?? "" };
}

// ---------------------------------------------------------------- item.search

type Term = string[];
const norm = (s: unknown) => String(s ?? "").toLowerCase();

function fieldValues(db: Database, d: ZoteroItemData, field: string, tags: string[], citekey: string): string[] {
	const f = field.toLowerCase();
	const creators = (d.creators ?? []) as { firstName?: string; lastName?: string; name?: string }[];
	switch (f) {
		case "creator": return creators.map((c) => [c.firstName, c.lastName, c.name].filter(Boolean).join(" "));
		case "lastname": return creators.map((c) => c.lastName ?? c.name ?? "");
		case "firstname": return creators.map((c) => c.firstName ?? "");
		case "tag": return tags;
		case "citationkey": case "citekey": return [citekey, String(d.citationKey ?? "")];
		case "year": return [String(d.date ?? "").match(/\d{4}/)?.[0] ?? ""];
		case "itemtype": return [d.itemType];
		case "collection": {
			const names = (d.collections ?? []).map((k) => (db.query("SELECT name FROM collections WHERE key = ?").get(k) as { name: string } | null)?.name ?? "");
			return [...(d.collections ?? []), ...names];
		}
		case "dateadded": case "datemodified": return [String((d as Record<string, unknown>)[field] ?? "")];
		default: {
			const hit = Object.keys(d).find((k) => k.toLowerCase() === f);
			return [String(hit ? (d as Record<string, unknown>)[hit] ?? "" : "")];
		}
	}
}

function quickMatch(d: ZoteroItemData, citekey: string, q: string): boolean {
	const t = norm(q);
	const creators = ((d.creators ?? []) as { firstName?: string; lastName?: string; name?: string }[]).map((c) => [c.firstName, c.lastName, c.name].filter(Boolean).join(" "));
	const hay = [d.title, d.publicationTitle, d.shortTitle, d.court, String(d.date ?? "").match(/\d{4}/)?.[0], citekey, d.citationKey, ...creators];
	return hay.some((h) => norm(h).includes(t));
}

function searchItems(db: Database, terms: unknown, library: unknown): string[] {
	checkLibrary(library);
	const keys = regularKeys(db);
	if (terms === undefined || terms === null || terms === "" || (Array.isArray(terms) && !terms.length)) return keys;
	if (typeof terms !== "string" && !Array.isArray(terms)) invalid("terms must be a string or an array of conditions");
	const infos = getKeyInfos(db, keys);
	const tagQ = db.query("SELECT tag FROM item_tags WHERE item_key = ?");
	const out: string[] = [];
	let any = false;
	const conds: Term[] = [];
	if (Array.isArray(terms)) {
		for (const t of terms as Term[]) {
			if (t[0] === "joinMode") any = t[1] === "any";
			else if (t.length >= 3) conds.push(t);
		}
	}
	for (const k of keys) {
		const d = loadData(db, k);
		if (!d) continue;
		const ck = infos[k]?.key ?? "";
		if (typeof terms === "string") {
			if (quickMatch(d, ck, terms)) out.push(k);
			continue;
		}
		const tags = (tagQ.all(k) as { tag: string }[]).map((r) => r.tag);
		const results = conds.map(([field, op, value]) => {
			const v = norm(value);
			if (/^quicksearch/i.test(field!)) return quickMatch(d, ck, String(value));
			if (field === "libraryID" || field === "library") return true;
			const vals = fieldValues(db, d, field!, tags, ck).map(norm);
			switch (op) {
				case "is": return vals.some((x) => x === v);
				case "isNot": return !vals.some((x) => x === v);
				case "contains": return vals.some((x) => x.includes(v));
				case "doesNotContain": return !vals.some((x) => x.includes(v));
				case "beginsWith": return vals.some((x) => x.startsWith(v));
				default: return invalid(`unsupported search operator ${String(op)}`);
			}
		});
		if (!results.length || (any ? results.some(Boolean) : results.every(Boolean))) out.push(k);
	}
	return out;
}

// ---------------------------------------------------------------- collections by path

interface CollRow { key: string; name: string; parent_key: string | null }

function pathSegments(path: string): string[] {
	const parts = path.split("/").filter((p, i) => !(i === 0 && p === ""));
	// "//a/b" means "my library" with an empty name; "/My Library/a/b" names it
	const all = path.startsWith("//") ? path.slice(2).split("/") : parts;
	if (all[0] !== undefined && (all[0] === "" || all[0].toLowerCase() === LIBRARY.toLowerCase()) && !path.startsWith("//")) all.shift();
	return all.filter(Boolean);
}

export function resolveCollectionPath(db: Database, path: string, create: boolean): string | null {
	let parent: string | null = null;
	for (const name of pathSegments(path)) {
		const row = db.query("SELECT key FROM collections WHERE name = ? AND parent_key IS ?").get(name, parent) as { key: string } | null;
		if (row) parent = row.key;
		else if (create) parent = repo.createCollection(db, name, parent).key;
		else return null;
	}
	return parent;
}

/** A collection key or a path ("/My Library/a/b", "a/b"). */
export function resolveCollection(db: Database, keyOrPath: string, create = false): string | null {
	if (/^[A-Z0-9]{8}$/.test(keyOrPath) && db.query("SELECT 1 FROM collections WHERE key = ?").get(keyOrPath)) return keyOrPath;
	return resolveCollectionPath(db, keyOrPath, create);
}

const collectionJson = (db: Database, key: string, parents: boolean): Record<string, unknown> => {
	const c = db.query("SELECT key, name, parent_key FROM collections WHERE key = ?").get(key) as CollRow;
	const out: Record<string, unknown> = { key: c.key, name: c.name, parentCollection: c.parent_key ?? false };
	if (parents && c.parent_key) out.parentCollection = collectionJson(db, c.parent_key, true);
	return out;
};

// ---------------------------------------------------------------- the API

type Method = (db: Database, params: unknown[]) => unknown | Promise<unknown>;

function oneItemFor(db: Database, citekeys: string[]): { key: string; citekey: string }[] {
	const out: { key: string; citekey: string }[] = [];
	for (const raw of citekeys) {
		const ck = stripAt(raw);
		const found = itemsForCitekey(db, ck);
		if (!found.length) throw new RpcError(INVALID_PARAMETERS, `zero matches for ${ck}`);
		for (const key of found) out.push({ key, citekey: ck });
	}
	return out;
}

const arrayOfStrings = (v: unknown, name: string): string[] => {
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) invalid(`${name} must be an array of strings`);
	return v as string[];
};

const METHODS: Record<string, Method> = {
	"api.ready": () => ({ zotero: "7.0.0", betterbibtex: "zotero-next" }),

	"user.groups": (db, [includeCollections]) => [
		{
			id: 1,
			name: LIBRARY,
			collections: includeCollections
				? (db.query("SELECT key FROM collections ORDER BY name").all() as { key: string }[]).map((c) => collectionJson(db, c.key, false))
				: null,
		},
	],

	"item.search": (db, [terms, library]) => searchItems(db, terms, library).map((k) => cslFor(db, k)),

	"item.citationkey": async (db, [itemKeys]) => {
		let keys: string[];
		if (itemKeys === "selected") keys = await selectedItemKeys();
		else keys = arrayOfStrings(itemKeys, "item_keys");
		const out: Record<string, string | null> = {};
		// "[libraryID]:[itemKey]" or a bare item key
		const bare = keys.map((k) => {
			if (!k.includes(":")) return k;
			const [lib, key] = k.split(":");
			if (Number.isNaN(parseInt(lib!, 10))) throw new RpcError(INTERNAL_ERROR, `Could not parse library ID from ${k}`);
			return key!;
		});
		const infos = getKeyInfos(db, bare);
		keys.forEach((k, i) => {
			out[k] = infos[bare[i]!]?.key ?? null;
		});
		return out;
	},

	"item.attachments": (db, [citekey, library]) => {
		checkLibrary(library);
		const found = itemsForCitekey(db, stripAt(String(citekey)));
		if (!found.length) throw new RpcError(INVALID_PARAMETERS, `${citekey} not found`);
		const rows = db
			.query(
				`SELECT i.key, a.path FROM items i JOIN attachments a ON a.item_key = i.key
				 WHERE i.parent_key = ? AND i.deleted = 0 ORDER BY i.date_added, i.key`,
			)
			.all(found[0]) as { key: string; path: string | null }[];
		return rows.map((r) => ({ open: `zotero://open-pdf/library/items/${r.key}`, path: r.path ?? false }));
	},

	"item.collections": (db, [citekeys, includeParents]) => {
		const out: Record<string, unknown[]> = {};
		for (const { key, citekey } of oneItemFor(db, arrayOfStrings(citekeys, "citekeys"))) {
			const d = loadData(db, key);
			out[citekey] = (d?.collections ?? []).filter((c) => db.query("SELECT 1 FROM collections WHERE key = ?").get(c)).map((c) => collectionJson(db, c, !!includeParents));
		}
		return out;
	},

	"item.notes": (db, [citekeys]) => {
		const out: Record<string, string[]> = {};
		for (const { key, citekey } of oneItemFor(db, arrayOfStrings(citekeys, "citekeys"))) {
			out[citekey] = (db.query("SELECT data FROM items WHERE parent_key = ? AND item_type = 'note' AND deleted = 0 ORDER BY date_added").all(key) as { data: string }[]).map(
				(r) => String((JSON.parse(r.data) as ZoteroItemData).note ?? ""),
			);
		}
		return out;
	},

	"item.bibliography": async (db, [citekeys, format, library]) => {
		checkLibrary(library);
		const f = (format ?? {}) as { quickCopy?: boolean; contentType?: "html" | "text"; locale?: string; id?: string };
		const svc = citeService(db);
		const style = f.id ? f.id.replace(/^https?:\/\/www\.zotero\.org\/styles\//, "") : f.quickCopy ? svc.getSettings().quickCopy.style : "";
		if (!style) invalid("no style specified");
		const keys: string[] = [];
		for (const ck of arrayOfStrings(citekeys, "citekeys")) keys.push(...itemsForCitekey(db, stripAt(ck)).slice(0, 1));
		const contentType = f.contentType ?? "text";
		const r = await svc.format(db, { keys, style, locale: f.locale || undefined, mode: "bibliography", format: contentType });
		return r[contentType] ?? "";
	},

	"item.regenerate_key": (db, [citekeys, library]) => {
		checkLibrary(library);
		const out: Record<string, string | null> = {};
		for (const raw of arrayOfStrings(citekeys, "citekeys")) {
			const ck = stripAt(raw);
			const found = itemsForCitekey(db, ck)[0];
			if (!found) {
				out[raw] = null;
				continue;
			}
			refreshKeys(db, [found]);
			out[raw] = getKeyInfos(db, [found])[found]?.key ?? ck;
		}
		return out;
	},

	"item.export": async (db, [citekeys, translator, library]) => {
		checkLibrary(library);
		const list = arrayOfStrings(citekeys, "citekeys").map(stripAt);
		const format = translatorFormat(String(translator));
		if (!format) throw new RpcError(INVALID_PARAMETERS, `Unknown translator '${String(translator)}'`);
		const missing: string[] = [];
		const duplicates: string[] = [];
		const keys: string[] = [];
		for (const ck of list) {
			const found = itemsForCitekey(db, ck);
			if (found.length === 0) missing.push(ck);
			else if (found.length > 1) duplicates.push(ck);
			else keys.push(found[0]!);
		}
		if (missing.length || duplicates.length) {
			throw new RpcError(
				INVALID_PARAMETERS,
				[missing.length ? `not found: ${missing.join(", ")}` : "", duplicates.length ? `duplicates found: ${duplicates.join(", ")}` : ""].filter(Boolean).join("\n"),
			);
		}
		const { gatherItems } = await import("../io/export");
		return exportBetterFormat(db, format, gatherItems(db, { format: "bibtex", keys }));
	},

	"item.pandoc_filter": (db, [citekeys, asCSL, library]) => {
		checkLibrary(Array.isArray(library) ? library[0] : library);
		const result: { errors: Record<string, number>; items: Record<string, unknown> } = { errors: {}, items: {} };
		for (const ck of [...new Set(arrayOfStrings(citekeys, "citekeys").map(stripAt))]) {
			const found = itemsForCitekey(db, ck);
			if (found.length !== 1) {
				result.errors[ck] = found.length;
				continue;
			}
			const d = loadData(db, found[0]!)!;
			if (asCSL) {
				const csl = itemToCsl(d) as Record<string, unknown>;
				csl.id = ck;
				csl["citation-key"] = ck;
				const authors = ((d.creators ?? []) as { creatorType: string; lastName?: string; name?: string }[]).filter((c) => c.creatorType === "author").map((c) => c.lastName ?? c.name ?? "");
				result.items[ck] = { ...csl, custom: { itemID: found[0], author: authors.join(", ") } };
			} else result.items[ck] = { ...d, citationKey: ck };
		}
		return result;
	},

	"collection.scanAUX": (db, [collection, aux]) => {
		if (typeof collection !== "string" || typeof aux !== "string") invalid("collection and aux must be strings");
		if (!existsSync(aux as string)) throw new RpcError(INVALID_PARAMETERS, `${aux} does not exist`);
		const text = readFileSync(aux as string, "utf8");
		const cited = new Set<string>();
		for (const m of text.matchAll(/\\citation\{([^}]*)\}/g)) for (const k of m[1]!.split(",")) if (k.trim() && k.trim() !== "*") cited.add(k.trim());
		for (const m of text.matchAll(/\\abx@aux@cite\{[^}]*\}\{([^}]*)\}/g)) if (m[1]!.trim()) cited.add(m[1]!.trim());
		const key = resolveCollectionPath(db, collection as string, true);
		if (!key) throw new RpcError(INVALID_PARAMETERS, "collection path is empty");
		const existing = (db.query("SELECT item_key FROM collection_items WHERE collection_key = ?").all(key) as { item_key: string }[]).map((r) => r.item_key);
		if (existing.length) repo.removeItemsFromCollection(db, key, existing);
		const keys = [...cited].flatMap((ck) => itemsForCitekey(db, ck).slice(0, 1));
		if (keys.length) repo.addItemsToCollection(db, key, keys);
		return { libraryID: 1, key };
	},

	"autoexport.add": (db, [collection, translator, path, displayOptions, replace]) => {
		const format = translatorFormat(String(translator));
		if (!format) throw new RpcError(INVALID_PARAMETERS, `Unknown translator '${String(translator)}'`);
		const key = resolveCollectionPath(db, String(collection), true);
		if (!key) throw new RpcError(INVALID_PARAMETERS, "collection path is empty");
		const existing = db.query("SELECT id, format, scope_key FROM bbt_autoexport WHERE path = ?").get(String(path)) as { id: number; format: string; scope_key: string | null } | null;
		if (existing) {
			if (existing.format === format && existing.scope_key === key) return { libraryID: 1, key, id: existing.id };
			if (!replace) throw new RpcError(INVALID_PARAMETERS, "Auto-export exists with incompatible parameters, but no 'replace' was requested");
			db.query("DELETE FROM bbt_autoexport WHERE id = ?").run(existing.id);
		}
		const opts = (displayOptions ?? {}) as { exportNotes?: boolean };
		const ae = addAutoExport(db, { path: String(path), format, scope: { type: "collection", key }, options: { includeNotes: !!opts.exportNotes } });
		return { libraryID: 1, key, id: ae.id };
	},
};
// BBT exposes the item methods under both item.* and items.*
for (const name of Object.keys(METHODS)) if (name.startsWith("item.")) METHODS[`items.${name.slice(5)}`] = METHODS[name]!;

async function handleOne(db: Database, req: unknown): Promise<Record<string, unknown>> {
	const r = req as { jsonrpc?: unknown; method?: unknown; params?: unknown; id?: unknown } | null;
	const id = r && typeof r === "object" ? ((r.id as string | number | null | undefined) ?? null) : null;
	if (!r || typeof r !== "object" || r.jsonrpc !== "2.0" || typeof r.method !== "string") {
		return { jsonrpc: "2.0", error: { code: INVALID_REQUEST, message: "Invalid Request" }, id: null };
	}
	const method = METHODS[r.method];
	if (!method) return { jsonrpc: "2.0", error: { code: METHOD_NOT_FOUND, message: `Method not found: ${r.method}` }, id };
	let params: unknown[] = [];
	if (Array.isArray(r.params)) params = r.params;
	else if (r.params && typeof r.params === "object") {
		const names = PARAM_NAMES[r.method] ?? [];
		for (const [k, v] of Object.entries(r.params as Record<string, unknown>)) {
			const i = names.indexOf(k);
			if (i < 0) return { jsonrpc: "2.0", error: { code: INVALID_PARAMETERS, message: `unsupported argument ${k} for ${r.method}` }, id };
			params[i] = v;
		}
	}
	try {
		return { jsonrpc: "2.0", result: await method(db, params), id };
	} catch (e) {
		if (e instanceof RpcError) return { jsonrpc: "2.0", error: { code: e.code, message: e.message }, id };
		if (e instanceof repo.HttpError) return { jsonrpc: "2.0", error: { code: INVALID_PARAMETERS, message: e.message }, id };
		return { jsonrpc: "2.0", error: { code: INTERNAL_ERROR, message: String(e) }, id };
	}
}

/** Names of the positional parameters, for requests that pass `params` as an object. */
const PARAM_NAMES: Record<string, string[]> = {
	"user.groups": ["includeCollections"],
	"item.search": ["terms", "library"],
	"item.citationkey": ["item_keys"],
	"item.attachments": ["citekey", "library"],
	"item.collections": ["citekeys", "includeParents"],
	"item.notes": ["citekeys"],
	"item.bibliography": ["citekeys", "format", "library"],
	"item.regenerate_key": ["citekeys", "library"],
	"item.export": ["citekeys", "translator", "libraryID"],
	"item.pandoc_filter": ["citekeys", "asCSL", "libraryID", "style", "locale"],
	"collection.scanAUX": ["collection", "aux"],
	"autoexport.add": ["collection", "translator", "path", "displayOptions", "replace"],
};
for (const [name, names] of Object.entries({ ...PARAM_NAMES })) if (name.startsWith("item.")) PARAM_NAMES[`items.${name.slice(5)}`] = names;

/** Handle a parsed JSON-RPC request or batch. */
export async function handleRpc(db: Database, body: unknown): Promise<unknown> {
	if (Array.isArray(body)) return Promise.all(body.map((r) => handleOne(db, r)));
	return handleOne(db, body);
}

export const rpcParseError = (message: string) => ({ jsonrpc: "2.0", error: { code: PARSE_ERROR, message: `Parse error: ${message}` }, id: null });
export { cslFor };
