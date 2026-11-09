// "Duplicate Item": a top-level item's copy — item type, fields, creators, tags, collections and relations — with no children
// (no attachments, notes or annotations), as Zotero's Duplicate Item. A standalone attachment's copy keeps the file (copied
// for an imported file, the same path for a link, the same URL for a snapshot).
import type { Database } from "bun:sqlite";
import { libraryOfItem } from "../libraries";
import { basename } from "node:path";
import type { ItemDetail, ZoteroItemData } from "../api-types";
import { HttpError, createItem, getItemDetail, patchItem } from "../db";
import { indexItem } from "../search";
import { addFile, addLink } from "./files";

interface ItemRow {
	item_type: string;
	parent_key: string | null;
	data: string;
	link_mode: string | null;
	content_type: string | null;
	path: string | null;
	url: string | null;
}

export function duplicateItem(db: Database, key: string): ItemDetail {
	const row = db
		.query(
			`SELECT i.item_type, i.parent_key, i.data, a.link_mode, a.content_type, a.path, a.url
			 FROM items i LEFT JOIN attachments a ON a.item_key = i.key WHERE i.key = ?`,
		)
		.get(key) as ItemRow | null;
	if (!row) throw new HttpError(404, "item not found");
	if (row.parent_key) throw new HttpError(400, "only top-level items can be duplicated");
	if (row.item_type === "annotation") throw new HttpError(400, "annotations cannot be duplicated");

	const data = JSON.parse(row.data) as ZoteroItemData & Record<string, unknown>;
	const collections = (db.query("SELECT collection_key FROM collection_items WHERE item_key = ? ORDER BY collection_key").all(key) as {
		collection_key: string;
	}[]).map((r) => r.collection_key);
	const tags = (db.query("SELECT tag, type FROM item_tags WHERE item_key = ? ORDER BY tag COLLATE NOCASE").all(key) as {
		tag: string;
		type: number;
	}[]).map((t) => (t.type ? { tag: t.tag, type: t.type } : { tag: t.tag }));
	const relations = data.relations && typeof data.relations === "object" ? (JSON.parse(JSON.stringify(data.relations)) as Record<string, string | string[]>) : {};

	if (row.item_type === "attachment") {
		const title = typeof data.title === "string" ? data.title : "";
		let copy: ItemDetail;
		if (row.link_mode === "linked_url") {
			copy = addLink(db, { url: row.url ?? String(data.url ?? ""), title: title || undefined });
		} else {
			if (!row.path) throw new HttpError(400, "the attachment has no file");
			copy = addFile(db, {
				mode: row.link_mode === "linked_file" ? "linked_file" : "imported_file",
				path: row.path,
				contentType: row.content_type ?? undefined,
				name: basename(row.path),
			});
		}
		const patch: Partial<ZoteroItemData> = {};
		if (collections.length) patch.collections = collections;
		if (tags.length) patch.tags = tags;
		if (Object.keys(relations).length) patch.relations = relations;
		if (title && title !== copy.data.title) patch.title = title;
		if (Object.keys(patch).length) copy = patchItem(db, copy.data.key, patch);
		return copy;
	}

	// Everything the Web API data object holds except this item's own bookkeeping; tags and collections come from the tables
	// (they are the source of truth), and the child list is not copied.
	const {
		key: _k, version: _v, dateAdded: _a, dateModified: _m, deleted: _d, parentItem: _p,
		tags: _t, collections: _c, relations: _r, itemType: _it, ...fields
	} = data;
	// a copy stays in the original's library (the duplicate button never moves an item between libraries)
	const detail = createItem(db, { ...fields, itemType: row.item_type, tags, collections, relations } as Partial<ZoteroItemData>, libraryOfItem(db, key) ?? undefined);
	indexItem(db, detail.data.key);
	return getItemDetail(db, detail.data.key)!;
}
