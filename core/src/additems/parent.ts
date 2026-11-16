// "Create Parent Item" for a standalone attachment or note: create the parent from an identifier (the add-by-identifier
// code) or empty of a chosen item type, then move the attachment / note under it. Zotero's dialog does the same.
import type { Database } from "bun:sqlite";
import { assertWritable, libraryOfItem } from "../libraries";
import type { ItemDetail, ZoteroItemData } from "../api-types";
import { HttpError, addItemsToCollection, createItem, getItemDetail } from "../db";
import { indexItem } from "../search";
import { addOne, loadKnown } from "./add";
import { reparentItem } from "./files";
import { parseIdentifiers } from "./identifiers";

export interface CreateParentRequest {
	/** the standalone attachment or note that gets the parent */
	itemKey: string;
	/** a DOI, PMID, PMCID, arXiv ID or ISBN; the parent is looked up and created from it */
	text?: string;
	/** else: the new parent's item type (empty item) */
	itemType?: string;
}

export interface CreateParentResult {
	parent: ItemDetail;
	/** the attachment or note, now a child of `parent` */
	item: ItemDetail;
}

const CHILD_TYPE: Record<string, true> = { attachment: true, note: true, annotation: true };

export async function createParent(db: Database, req: Partial<CreateParentRequest>): Promise<CreateParentResult> {
	const itemKey = typeof req?.itemKey === "string" ? req.itemKey : "";
	if (!itemKey) throw new HttpError(400, "itemKey is required");
	const row = db.query("SELECT item_type, parent_key FROM items WHERE key = ?").get(itemKey) as {
		item_type: string;
		parent_key: string | null;
	} | null;
	if (!row) throw new HttpError(404, "item not found");
	if (row.item_type !== "attachment" && row.item_type !== "note")
		throw new HttpError(400, "only a standalone attachment or note can get a parent item");
	if (row.parent_key) throw new HttpError(400, "the item already has a parent");
	// The parent takes the child's collections (the child leaves them, as for any child item).
	const collections = (
		db.query("SELECT collection_key FROM collection_items WHERE item_key = ? ORDER BY collection_key").all(itemKey) as {
			collection_key: string;
		}[]
	).map((r) => r.collection_key);

	// the new parent lives in the same library as the item it adopts
	const lib = libraryOfItem(db, itemKey) ?? 1;
	assertWritable(db, lib);
	let parentKey: string;
	const text = typeof req.text === "string" ? req.text.trim() : "";
	if (text) {
		const { ids, unknown } = parseIdentifiers(text);
		if (ids.length === 0) {
			throw new HttpError(
				400,
				unknown.length
					? `${unknown[0]} is not a recognised identifier (DOI, PMID, PMCID, arXiv ID or ISBN)`
					: "no identifier found",
			);
		}
		if (ids.length > 1) throw new HttpError(400, "enter one identifier");
		const r = await addOne(db, ids[0]!, loadKnown(db, lib), collections[0], true, lib);
		parentKey = r.added?.data.key ?? r.existing!;
		if (r.added) {
			for (const c of collections.slice(1))
				db.query("INSERT OR IGNORE INTO collection_items(collection_key, item_key) VALUES(?, ?)").run(c, parentKey);
		} else {
			// The work was already in the library: the attachment is about to leave its collections, so the parent joins them
			// (else the work would drop out of the collection view it was filed in).
			for (const c of collections) addItemsToCollection(db, c, [parentKey]);
		}
	} else {
		const itemType = typeof req.itemType === "string" ? req.itemType : "";
		if (!itemType) throw new HttpError(400, "itemType is required when no identifier is given");
		if (CHILD_TYPE[itemType]) throw new HttpError(400, `a ${itemType} cannot be a parent item`);
		const detail = createItem(db, { itemType, collections } as Partial<ZoteroItemData>, lib);
		indexItem(db, detail.data.key);
		parentKey = detail.data.key;
	}

	reparentItem(db, itemKey, parentKey);
	return { parent: getItemDetail(db, parentKey)!, item: getItemDetail(db, itemKey)! };
}
