// Duplicate set inspection, merging (Zotero semantics), and "not duplicates" exclusion storage.

import type { Database } from "bun:sqlite";
import { assertWritable, libraryOfItem } from "../libraries";
import type { ItemDetail, ZoteroItemData } from "../api-types";
import { addRelated, generateKey, getItemDetail, HttpError, nowIso, patchItem } from "../db";
import { convertItemType } from "../schema-data";
import { indexItem } from "../search";
import { ensureDuplicatesSchema } from "./detect";

export interface DuplicateSetDetails {
	items: ItemDetail[];
	defaultMasterKey: string;
	differingFields: string[];
}

export interface MergeDuplicatesInput {
	masterKey?: string;
	otherKeys: string[];
	fieldChoices?: Record<string, string>;
}

const INTERNAL_FIELDS = new Set([
	"key",
	"version",
	"dateAdded",
	"dateModified",
	"deleted",
	"parentItem",
	"tags",
	"collections",
	"relations",
]);

function isEmptyValue(v: unknown): boolean {
	if (v === undefined || v === null || v === "") return true;
	if (Array.isArray(v)) return v.length === 0;
	return false;
}

function stableValueString(v: unknown): string {
	if (isEmptyValue(v)) return "";
	if (typeof v === "string") return v;
	return JSON.stringify(v);
}

function relationUris(data: ZoteroItemData, predicate: string): string[] {
	const v = data.relations?.[predicate];
	return Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
}

function uriKey(uri: string): string | null {
	return /\/items\/([A-Z0-9]{8})$/.exec(uri)?.[1] ?? null;
}

function libraryKey(db: Database): string {
	const row = db.query("SELECT value FROM meta WHERE name = 'library_key'").get() as { value: string } | null;
	if (row) return row.value;
	const key = generateKey();
	db.query("INSERT INTO meta(name, value) VALUES('library_key', ?)").run(key);
	return key;
}

function validateTopLevelItem(db: Database, key: string): ItemDetail {
	const row = db
		.query("SELECT parent_key, item_type, deleted FROM items WHERE key = ?")
		.get(key) as { parent_key: string | null; item_type: string; deleted: number } | null;
	if (!row) throw new HttpError(404, `item not found: ${key}`);
	if (row.deleted) throw new HttpError(400, `cannot merge trashed item: ${key}`);
	if (row.parent_key || row.item_type === "attachment" || row.item_type === "note" || row.item_type === "annotation") {
		throw new HttpError(400, `item is not a top-level bibliographic item: ${key}`);
	}
	return getItemDetail(db, key)!;
}

export function computeDifferingFields(items: ItemDetail[]): string[] {
	if (items.length < 2) return [];
	const allFields = new Set<string>();
	for (const it of items) {
		for (const k of Object.keys(it.data)) {
			if (!INTERNAL_FIELDS.has(k)) allFields.add(k);
		}
	}
	const differing: string[] = [];
	for (const f of allFields) {
		const first = stableValueString(items[0].data[f]);
		for (let i = 1; i < items.length; i++) {
			if (stableValueString(items[i].data[f]) !== first) {
				differing.push(f);
				break;
			}
		}
	}
	return differing;
}

export function getDuplicateSetDetails(db: Database, rawKeys: string[]): DuplicateSetDetails {
	const keys = [...new Set(rawKeys.map((k) => k.trim()).filter(Boolean))];
	if (keys.length < 2) throw new HttpError(400, "at least two item keys are required");
	const items = keys.map((k) => {
		const d = getItemDetail(db, k);
		if (!d) throw new HttpError(404, `item not found: ${k}`);
		return d;
	});
	// Sort by dateAdded ascending (oldest first = Zotero's default master)
	const sortedByAge = [...items].sort((a, b) => {
		const da = a.data.dateAdded ?? "";
		const dbDate = b.data.dateAdded ?? "";
		if (da !== dbDate) return da.localeCompare(dbDate);
		return a.data.key.localeCompare(b.data.key);
	});
	return {
		items: sortedByAge,
		defaultMasterKey: sortedByAge[0].data.key,
		differingFields: computeDifferingFields(sortedByAge),
	};
}

export function mergeDuplicateItems(db: Database, input: MergeDuplicatesInput): ItemDetail {
	if (!input || typeof input !== "object") throw new HttpError(400, "body must be an object");
	if (!Array.isArray(input.otherKeys) || input.otherKeys.some((k) => typeof k !== "string" || !k.trim())) {
		throw new HttpError(400, "otherKeys must be an array of item keys");
	}

	let masterKey = typeof input.masterKey === "string" ? input.masterKey.trim() : "";
	let otherKeys = [...new Set(input.otherKeys.map((k) => k.trim()).filter(Boolean))];

	if (!masterKey) {
		if (otherKeys.length < 2) throw new HttpError(400, "masterKey and at least one otherKey are required");
		const details = otherKeys.map((k) => validateTopLevelItem(db, k));
		details.sort((a, b) => {
			const da = a.data.dateAdded ?? "";
			const dbDate = b.data.dateAdded ?? "";
			return da !== dbDate ? da.localeCompare(dbDate) : a.data.key.localeCompare(b.data.key);
		});
		masterKey = details[0].data.key;
		otherKeys = details.slice(1).map((d) => d.data.key);
	} else {
		otherKeys = otherKeys.filter((k) => k !== masterKey);
		if (otherKeys.length === 0) throw new HttpError(400, "at least one otherKey different from masterKey is required");
	}

	const masterDetail = validateTopLevelItem(db, masterKey);
	const otherDetails = otherKeys.map((k) => validateTopLevelItem(db, k));
	const allDetails = [masterDetail, ...otherDetails];
	const validKeySet = new Set(allDetails.map((d) => d.data.key));
	// items of two libraries are never merged, and nothing is merged in a library that is read-only for this user
	const libs = new Set(allDetails.map((d) => libraryOfItem(db, d.data.key)));
	if (libs.size !== 1) throw new HttpError(400, "items of different libraries cannot be merged");
	assertWritable(db, [...libs][0]!);

	const fieldChoices = input.fieldChoices ?? {};
	if (typeof fieldChoices !== "object" || Array.isArray(fieldChoices)) {
		throw new HttpError(400, "fieldChoices must be an object mapping field names to item keys");
	}
	for (const [field, srcKey] of Object.entries(fieldChoices)) {
		if (typeof srcKey !== "string" || !validKeySet.has(srcKey)) {
			throw new HttpError(400, `invalid source key "${String(srcKey)}" for field "${field}"`);
		}
	}

	// Determine target itemType (from fieldChoices.itemType if chosen, else master's itemType)
	const typeSourceKey = fieldChoices.itemType ?? masterKey;
	const targetItemType = allDetails.find((d) => d.data.key === typeSourceKey)!.data.itemType;

	// Convert each item's data to targetItemType so field names align across e.g. journalArticle & preprint
	const convertedByKey = new Map<string, ZoteroItemData>();
	for (const d of allDetails) {
		if (d.data.itemType !== targetItemType) {
			try {
				convertedByKey.set(d.data.key, convertItemType(d.data, targetItemType).data);
			} catch {
				convertedByKey.set(d.data.key, { ...d.data, itemType: targetItemType });
			}
		} else {
			convertedByKey.set(d.data.key, { ...d.data });
		}
	}

	const masterConverted = convertedByKey.get(masterKey)!;
	const otherConvertedByAge = [...otherDetails]
		.sort((a, b) => (a.data.dateAdded ?? "").localeCompare(b.data.dateAdded ?? ""))
		.map((d) => convertedByKey.get(d.data.key)!);

	// Collect all metadata field names present across all converted items
	const allMetadataFields = new Set<string>();
	for (const data of convertedByKey.values()) {
		for (const k of Object.keys(data)) {
			if (!INTERNAL_FIELDS.has(k) && k !== "itemType") allMetadataFields.add(k);
		}
	}
	for (const k of Object.keys(fieldChoices)) {
		if (!INTERNAL_FIELDS.has(k) && k !== "itemType") allMetadataFields.add(k);
	}

	const patch: Partial<ZoteroItemData> = { itemType: targetItemType };

	for (const field of allMetadataFields) {
		if (field in fieldChoices) {
			const chosenData = convertedByKey.get(fieldChoices[field])!;
			const val = chosenData[field];
			patch[field] = val === undefined ? "" : structuredClone(val);
		} else {
			const masterVal = masterConverted[field];
			if (!isEmptyValue(masterVal)) {
				patch[field] = structuredClone(masterVal);
			} else {
				// Fill empty master fields from the oldest other item that has a value
				for (const otherData of otherConvertedByAge) {
					if (!isEmptyValue(otherData[field])) {
						patch[field] = structuredClone(otherData[field]);
						break;
					}
				}
			}
		}
	}

	// Union tags (manual type=0 wins over automatic type=1)
	const tagMap = new Map<string, number>();
	for (const d of allDetails) {
		for (const t of d.tags) {
			const existing = tagMap.get(t.tag);
			if (existing === undefined || (t.type === 0 && existing !== 0)) {
				tagMap.set(t.tag, t.type);
			}
		}
	}
	patch.tags = [...tagMap.entries()].map(([tag, type]) => (type ? { tag, type } : { tag }));

	// Union collections
	patch.collections = [...new Set(allDetails.flatMap((d) => d.collections))];

	// Union relations (dc:relation and dc:replaces)
	const existingRelations: Record<string, string | string[]> = { ...(masterDetail.data.relations ?? {}) };
	const dcRelationUris = new Set<string>();
	const inLibRelatedKeys = new Set<string>();
	const replacesUris = new Set<string>();

	for (const d of allDetails) {
		for (const u of relationUris(d.data, "dc:relation")) {
			const k = uriKey(u);
			if (k && validKeySet.has(k)) continue; // don't relate master to itself or a replaced duplicate
			dcRelationUris.add(u);
			if (k) inLibRelatedKeys.add(k);
		}
		for (const u of relationUris(d.data, "dc:replaces")) {
			const k = uriKey(u);
			if (k === masterKey) continue;
			replacesUris.add(u);
		}
	}

	db.transaction(() => {
		const lib = libraryKey(db);
		for (const ok of otherKeys) {
			replacesUris.add(`http://zotero.org/users/local/${lib}/items/${ok}`);
		}
		const repList = [...replacesUris];
		if (repList.length > 0) {
			existingRelations["dc:replaces"] = repList.length === 1 ? repList[0] : repList;
		}
		const relList = [...dcRelationUris];
		if (relList.length > 0) {
			existingRelations["dc:relation"] = relList.length === 1 ? relList[0] : relList;
		} else {
			delete existingRelations["dc:relation"];
		}
		patch.relations = existingRelations;

		// 1. Update the master item (fires sync triggers for item, tags, collections)
		patchItem(db, masterKey, patch);

		// 2. Ensure bidirectional dc:relation for any in-library related items
		const existingRelatedInDb = [...inLibRelatedKeys].filter(
			(k) => !!db.query("SELECT 1 FROM items WHERE key = ? AND deleted = 0").get(k),
		);
		if (existingRelatedInDb.length > 0) {
			addRelated(db, masterKey, existingRelatedInDb);
		}

		// 3. Move all non-deleted child notes and attachments of otherKeys under masterKey
		const now = nowIso();
		const moveChildStmt = db.query(
			`UPDATE items
			 SET parent_key = ?,
			     data = json_set(data, '$.parentItem', ?, '$.dateModified', ?),
			     date_modified = ?
			 WHERE parent_key = ?
			   AND deleted = 0
			   AND item_type IN ('attachment', 'note')`,
		);
		for (const ok of otherKeys) {
			moveChildStmt.run(masterKey, masterKey, now, now, ok);
		}

		// 4. Move the other items to the trash via patchItem (sets data.deleted = 1 and fires trash trigger)
		for (const ok of otherKeys) {
			patchItem(db, ok, { deleted: 1 });
		}
	})();

	// Update FTS5 search index for master and trashed items
	indexItem(db, masterKey);
	for (const ok of otherKeys) {
		indexItem(db, ok);
	}

	return getItemDetail(db, masterKey)!;
}

export function markNotDuplicates(db: Database, rawKeys: unknown): { ok: true } {
	if (!Array.isArray(rawKeys) || rawKeys.some((k) => typeof k !== "string" || !k.trim())) {
		throw new HttpError(400, "keys must be an array of item keys");
	}
	const keys = [...new Set((rawKeys as string[]).map((k) => k.trim()).filter(Boolean))].sort();
	if (keys.length < 2) throw new HttpError(400, "at least two distinct item keys are required");

	ensureDuplicatesSchema(db);
	db.transaction(() => {
		const stmt = db.query("INSERT OR IGNORE INTO duplicate_exclusions(key_a, key_b) VALUES(?, ?)");
		for (let i = 0; i < keys.length; i++) {
			for (let j = i + 1; j < keys.length; j++) {
				stmt.run(keys[i], keys[j]);
			}
		}
	})();
	return { ok: true };
}
