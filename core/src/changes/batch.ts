// POST /api/batch: many changes in one transaction (the host side of WIT `library.apply`).
//
// `changes` is the WIT `change` variant in jco's JSON form: {tag: "create-item", val: {key?, library?, data}} ... with
// camelCase record fields. Tags and their `val`:
//   create-item {key?, library?, data}          update-item {key, patch, expectedModified?}
//   trash-items / restore-items / erase-items  string[]  (erase: every item must be in the trash already)
//   add-to-collection / remove-from-collection {collection, items[]}
//   add-tags / remove-tags {items[], tags: {name, kind?: "manual"|"automatic"}[]}
//   add-related / remove-related {a, b}
//   add-to-publications / remove-from-publications string[]
//   create-collection {key?, library?, name, parent?}   update-collection {key, name?, parent?: string|null}
//   erase-collection {key, trashItems}
//   create-saved-search {key?, library?, name, conditions, options}   update-saved-search {key, name?, conditions?, options?}
//   erase-saved-search string
// (saved-search conditions/options are core's own shape: core/src/searches/types.ts.)
// Changes run in order; the first failure rolls everything back and throws BatchError with the change's index. Imported attachment
// files that `erase-items` removed from disk are not restored by a rollback: put erase-items last when a batch can fail.
import type { Database } from "bun:sqlite";
import {
	addRelated,
	createCollection,
	createItem,
	deleteCollection,
	HttpError,
	patchItem,
	removeRelated,
	updateCollection,
	addItemsToCollection,
	removeItemsFromCollection,
} from "../db";
import { ownStorage } from "../maintenance/api";
import { eraseItems } from "../maintenance/erase";
import { indexItem } from "../search";
import { createSavedSearch, deleteSavedSearch, updateSavedSearch } from "../searches/store";
import { assertItemWritable } from "../libraries";
import { withOrigin } from "./log";

export class BatchError extends Error {
	constructor(
		public status: number,
		message: string,
		public index: number | null,
	) {
		super(message);
	}
}

export interface BatchChange {
	tag: string;
	val: any;
}

export interface BatchResult {
	created: string[];
	changed: number;
}

const strs = (v: unknown, what: string): string[] => {
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new HttpError(400, `${what} must be an array of strings`);
	return v as string[];
};

function inTrash(db: Database, key: string): boolean {
	const r = db.query("SELECT deleted FROM items WHERE key = ?").get(key) as { deleted: number } | null;
	if (!r) throw new HttpError(404, `item not found: ${key}`);
	return r.deleted === 1;
}

function tagsOf(db: Database, key: string): { tag: string; type?: number }[] {
	const rows = db.query("SELECT tag, type FROM item_tags WHERE item_key = ? ORDER BY tag").all(key) as { tag: string; type: number }[];
	return rows.map((r) => (r.type ? { tag: r.tag, type: r.type } : { tag: r.tag }));
}

export function runBatch(db: Database, changes: BatchChange[], opts: { origin?: string; skipNotify?: boolean } = {}): BatchResult {
	const created: string[] = [];
	let changed = 0;
	const touched = new Set<string>();
	let index = 0;
	try {
		withOrigin(db, opts.origin, opts.skipNotify === true, () => {
			for (index = 0; index < changes.length; index++) {
				const c = changes[index];
				if (!c || typeof c.tag !== "string") throw new HttpError(400, "each change needs a tag");
				const v = c.val;
				switch (c.tag) {
					case "create-item": {
						if (!v || typeof v.data !== "object" || v.data === null) throw new HttpError(400, "create-item needs data");
						const d = createItem(db, v.data, typeof v.library === "number" ? v.library : undefined, { key: v.key ?? undefined });
						created.push(d.data.key);
						touched.add(d.data.key);
						changed++;
						break;
					}
					case "update-item": {
						if (!v || typeof v.key !== "string" || typeof v.patch !== "object" || v.patch === null) throw new HttpError(400, "update-item needs key and patch");
						if (v.expectedModified) {
							const r = db.query("SELECT date_modified FROM items WHERE key = ?").get(v.key) as { date_modified: string } | null;
							if (!r) throw new HttpError(404, `item not found: ${v.key}`);
							if (r.date_modified !== v.expectedModified) throw new HttpError(409, `item ${v.key} changed since ${v.expectedModified}`);
						}
						patchItem(db, v.key, v.patch);
						touched.add(v.key);
						changed++;
						break;
					}
					case "trash-items":
					case "restore-items": {
						for (const k of strs(v, c.tag)) {
							patchItem(db, k, { deleted: c.tag === "trash-items" ? 1 : 0 });
							touched.add(k);
							changed++;
						}
						break;
					}
					case "erase-items": {
						const keys = strs(v, c.tag);
						for (const k of keys) {
							assertItemWritable(db, k);
							if (!inTrash(db, k)) throw new HttpError(409, `item ${k} is not in the trash`);
						}
						const rep = eraseItems(db, keys, ownStorage(db));
						changed += rep.topLevel;
						break;
					}
					case "add-to-collection":
					case "remove-from-collection": {
						const items = strs(v?.items, "items");
						if (c.tag === "add-to-collection") addItemsToCollection(db, v.collection, items);
						else removeItemsFromCollection(db, v.collection, items);
						for (const k of items) touched.add(k);
						changed += items.length;
						break;
					}
					case "add-tags":
					case "remove-tags": {
						const items = strs(v?.items, "items");
						if (!Array.isArray(v?.tags)) throw new HttpError(400, "tags must be an array");
						for (const k of items) {
							const cur = tagsOf(db, k);
							let next: { tag: string; type?: number }[];
							if (c.tag === "add-tags") {
								const have = new Set(cur.map((t) => t.tag));
								next = [...cur];
								for (const t of v.tags as { name: string; kind?: string }[]) {
									const name = String(t.name ?? "").trim();
									if (name && !have.has(name)) {
										have.add(name);
										next.push(t.kind === "automatic" ? { tag: name, type: 1 } : { tag: name });
									}
								}
							} else {
								const drop = new Set((v.tags as { name: string }[]).map((t) => t.name));
								next = cur.filter((t) => !drop.has(t.tag));
							}
							patchItem(db, k, { tags: next });
							touched.add(k);
							changed++;
						}
						break;
					}
					case "add-related":
					case "remove-related": {
						if (typeof v?.a !== "string" || typeof v?.b !== "string") throw new HttpError(400, `${c.tag} needs a and b`);
						if (c.tag === "add-related") addRelated(db, v.a, [v.b]);
						else removeRelated(db, v.a, [v.b]);
						touched.add(v.a);
						touched.add(v.b);
						changed++;
						break;
					}
					case "add-to-publications":
					case "remove-from-publications": {
						for (const k of strs(v, c.tag)) {
							patchItem(db, k, { inPublications: c.tag === "add-to-publications" });
							changed++;
						}
						break;
					}
					case "create-collection": {
						const col = createCollection(db, v?.name, v?.parent ?? null, typeof v?.library === "number" ? v.library : undefined, {
							key: v?.key ?? undefined,
						});
						created.push(col.key);
						changed++;
						break;
					}
					case "update-collection": {
						if (typeof v?.key !== "string") throw new HttpError(400, "update-collection needs key");
						const patch: { name?: string; parentKey?: string | null } = {};
						if (v.name !== undefined && v.name !== null) patch.name = v.name;
						if ("parentKey" in v) patch.parentKey = v.parentKey;
						updateCollection(db, v.key, patch);
						changed++;
						break;
					}
					case "erase-collection": {
						if (typeof v?.key !== "string") throw new HttpError(400, "erase-collection needs key");
						if (v.trashItems) {
							const only = db
								.query(
									`WITH RECURSIVE d(key) AS (SELECT ? UNION ALL SELECT c.key FROM collections c JOIN d ON c.parent_key = d.key)
									 SELECT DISTINCT ci.item_key AS k FROM collection_items ci JOIN d ON ci.collection_key = d.key
									 WHERE NOT EXISTS (SELECT 1 FROM collection_items o WHERE o.item_key = ci.item_key AND o.collection_key NOT IN (SELECT key FROM d))`,
								)
								.all(v.key) as { k: string }[];
							for (const r of only) {
								patchItem(db, r.k, { deleted: 1 });
								touched.add(r.k);
							}
						}
						deleteCollection(db, v.key);
						changed++;
						break;
					}
					case "create-saved-search": {
						const s = createSavedSearch(db, { name: v?.name, conditions: v?.conditions, options: v?.options, key: v?.key });
						created.push(s.key);
						changed++;
						break;
					}
					case "update-saved-search": {
						updateSavedSearch(db, v?.key, { name: v?.name ?? undefined, conditions: v?.conditions ?? undefined, options: v?.options ?? undefined });
						changed++;
						break;
					}
					case "erase-saved-search": {
						if (typeof v !== "string") throw new HttpError(400, "erase-saved-search takes a key");
						deleteSavedSearch(db, v);
						changed++;
						break;
					}
					default:
						throw new HttpError(400, `unknown change: ${c.tag}`);
				}
			}
			for (const k of touched) if (db.query("SELECT 1 FROM items WHERE key = ?").get(k)) indexItem(db, k);
		});
	} catch (e) {
		if (e instanceof BatchError) throw e;
		if (e instanceof HttpError) throw new BatchError(e.status, e.message, index < changes.length ? index : null);
		throw new BatchError(500, e instanceof Error ? e.message : String(e), index < changes.length ? index : null);
	}
	return { created, changed };
}
