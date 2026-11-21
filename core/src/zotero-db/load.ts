// Reads Zotero's lookup tables and bulk-loads items (any type) into the shared mapping shapes.
import type { Database } from "bun:sqlite";
import { type AnnotationInput, type Creator, type ItemInput, type Row, toIso } from "./mapping";

export interface Lookups {
	typeName: Map<number, string>;
	typeId: Map<string, number>;
	fieldName: Map<number, string>;
	fieldId: Map<string, number>;
	validFields: Map<number, Set<number>>; // itemTypeID -> valid fieldIDs
	baseMapped: Map<string, number>; // `${itemTypeID}:${baseFieldID}` -> type-specific fieldID
	baseOfField: Map<number, number>; // type-specific fieldID -> baseFieldID
	creatorTypeName: Map<number, string>;
	creatorTypeId: Map<string, number>;
	validCreatorTypes: Map<number, Set<number>>;
	primaryCreatorType: Map<number, number>;
	charsetName: Map<number, string>;
	charsetId: Map<string, number>;
}

function tryAll(db: Database, sql: string): Row[] {
	try {
		return db.query(sql).all() as Row[];
	} catch {
		return [];
	}
}

export function loadLookups(db: Database): Lookups {
	const lk: Lookups = {
		typeName: new Map(),
		typeId: new Map(),
		fieldName: new Map(),
		fieldId: new Map(),
		validFields: new Map(),
		baseMapped: new Map(),
		baseOfField: new Map(),
		creatorTypeName: new Map(),
		creatorTypeId: new Map(),
		validCreatorTypes: new Map(),
		primaryCreatorType: new Map(),
		charsetName: new Map(),
		charsetId: new Map(),
	};
	for (const r of db.query("SELECT itemTypeID, typeName FROM itemTypesCombined").all() as Row[]) {
		lk.typeName.set(r.itemTypeID, r.typeName);
		lk.typeId.set(r.typeName, r.itemTypeID);
	}
	for (const r of db.query("SELECT fieldID, fieldName FROM fieldsCombined").all() as Row[]) {
		lk.fieldName.set(r.fieldID, r.fieldName);
		lk.fieldId.set(r.fieldName, r.fieldID);
	}
	for (const r of db.query("SELECT itemTypeID, fieldID FROM itemTypeFieldsCombined").all() as Row[]) {
		let s = lk.validFields.get(r.itemTypeID);
		if (!s) lk.validFields.set(r.itemTypeID, (s = new Set()));
		s.add(r.fieldID);
	}
	for (const r of db.query("SELECT itemTypeID, baseFieldID, fieldID FROM baseFieldMappingsCombined").all() as Row[]) {
		lk.baseMapped.set(`${r.itemTypeID}:${r.baseFieldID}`, r.fieldID);
		lk.baseOfField.set(r.fieldID, r.baseFieldID);
	}
	for (const r of db.query("SELECT creatorTypeID, creatorType FROM creatorTypes").all() as Row[]) {
		lk.creatorTypeName.set(r.creatorTypeID, r.creatorType);
		lk.creatorTypeId.set(r.creatorType, r.creatorTypeID);
	}
	for (const r of tryAll(db, "SELECT itemTypeID, creatorTypeID, primaryField FROM itemTypeCreatorTypes")) {
		let s = lk.validCreatorTypes.get(r.itemTypeID);
		if (!s) lk.validCreatorTypes.set(r.itemTypeID, (s = new Set()));
		s.add(r.creatorTypeID);
		if (r.primaryField) lk.primaryCreatorType.set(r.itemTypeID, r.creatorTypeID);
	}
	for (const r of tryAll(db, "SELECT charsetID, charset FROM charsets")) {
		lk.charsetName.set(r.charsetID, r.charset);
		lk.charsetId.set(String(r.charset).toLowerCase(), r.charsetID);
	}
	return lk;
}

export function userLibraryID(db: Database, wanted?: number): number {
	if (wanted !== undefined) return wanted;
	const lib = db.query("SELECT libraryID FROM libraries WHERE type = 'user' ORDER BY libraryID LIMIT 1").get() as Row | null;
	if (!lib) throw new Error("no user library in zotero.sqlite");
	return lib.libraryID as number;
}

export interface LoadedItem {
	itemID: number;
	key: string;
	typeName: string;
	version: number;
	clientVersion: number;
	dateAdded: string; // SQL
	dateModified: string; // SQL
	clientDateModified: string; // SQL
	deleted: boolean;
	parentID: number | null;
	parentKey: string | null;
	/** Items (incl. notes/attachments); absent for annotations. */
	input?: ItemInput;
	/** Annotations only. */
	annotation?: AnnotationInput & { parentID: number; parentKey: string | null };
	/** Raw itemAttachments row (attachments only). */
	attRow?: Row;
}

const CHUNK = 400;

function placeholders(n: number): string {
	return new Array(n).fill("?").join(",");
}

function group<T extends Row>(rows: T[], key: string): Map<number, T[]> {
	const m = new Map<number, T[]>();
	for (const r of rows) {
		let l = m.get(r[key]);
		if (!l) m.set(r[key], (l = []));
		l.push(r);
	}
	return m;
}

/** Bulk-load the given items (by itemID). Feed items are returned like any other. */
export function loadItems(db: Database, lk: Lookups, ids: number[]): Map<number, LoadedItem> {
	const out = new Map<number, LoadedItem>();
	for (let i = 0; i < ids.length; i += CHUNK) {
		loadChunk(db, lk, ids.slice(i, i + CHUNK), out);
	}
	return out;
}

function loadChunk(db: Database, lk: Lookups, ids: number[], out: Map<number, LoadedItem>): void {
	if (ids.length === 0) return;
	const ph = placeholders(ids.length);
	const q = (sql: string): Row[] => db.query(sql.replaceAll("{IDS}", ph)).all(...ids) as Row[];

	const base = q(
		"SELECT itemID, itemTypeID, dateAdded, dateModified, clientDateModified, key, version, clientVersion FROM items WHERE itemID IN ({IDS})",
	);
	const deleted = new Set(q("SELECT itemID FROM deletedItems WHERE itemID IN ({IDS})").map((r) => r.itemID as number));
	const fields = group(
		q("SELECT d.itemID, d.fieldID, v.value FROM itemData d JOIN itemDataValues v ON v.valueID = d.valueID WHERE d.itemID IN ({IDS})"),
		"itemID",
	);
	const creators = group(
		q(
			`SELECT ic.itemID, ic.creatorTypeID, c.firstName, c.lastName, c.fieldMode
			 FROM itemCreators ic JOIN creators c ON c.creatorID = ic.creatorID
			 WHERE ic.itemID IN ({IDS}) ORDER BY ic.itemID, ic.orderIndex`,
		),
		"itemID",
	);
	const tags = group(
		q(
			"SELECT it.itemID, t.name, it.type FROM itemTags it JOIN tags t ON t.tagID = it.tagID WHERE it.itemID IN ({IDS}) ORDER BY it.itemID, t.name",
		),
		"itemID",
	);
	const colls = group(
		q(
			"SELECT ci.itemID, c.key FROM collectionItems ci JOIN collections c ON c.collectionID = ci.collectionID WHERE ci.itemID IN ({IDS})",
		),
		"itemID",
	);
	const rels = group(
		q(
			"SELECT ir.itemID, rp.predicate, ir.object FROM itemRelations ir JOIN relationPredicates rp ON rp.predicateID = ir.predicateID WHERE ir.itemID IN ({IDS}) ORDER BY ir.itemID, rp.predicate, ir.object",
		),
		"itemID",
	);
	const pubs = new Set(q("SELECT itemID FROM publicationsItems WHERE itemID IN ({IDS})").map((r) => r.itemID as number));
	const notes = new Map<number, Row>(
		q("SELECT itemID, parentItemID, note, title FROM itemNotes WHERE itemID IN ({IDS})").map((r) => [r.itemID, r]),
	);
	const atts = new Map<number, Row>(
		q(
			"SELECT itemID, parentItemID, linkMode, contentType, charsetID, path, syncState, storageModTime, storageHash FROM itemAttachments WHERE itemID IN ({IDS})",
		).map((r) => [r.itemID, r]),
	);
	const anns = new Map<number, Row>(
		q(
			"SELECT itemID, parentItemID, type, authorName, text, comment, color, pageLabel, sortIndex, position FROM itemAnnotations WHERE itemID IN ({IDS})",
		).map((r) => [r.itemID, r]),
	);

	// parent keys
	const parentIDs = new Set<number>();
	for (const r of notes.values()) if (r.parentItemID) parentIDs.add(r.parentItemID);
	for (const r of atts.values()) if (r.parentItemID) parentIDs.add(r.parentItemID);
	for (const r of anns.values()) if (r.parentItemID) parentIDs.add(r.parentItemID);
	const parentKey = new Map<number, string>();
	if (parentIDs.size) {
		const pids = [...parentIDs];
		for (let i = 0; i < pids.length; i += CHUNK) {
			const part = pids.slice(i, i + CHUNK);
			for (const r of db
				.query(`SELECT itemID, key FROM items WHERE itemID IN (${placeholders(part.length)})`)
				.all(...part) as Row[]) {
				parentKey.set(r.itemID, r.key);
			}
		}
	}

	for (const r of base) {
		const typeName = lk.typeName.get(r.itemTypeID) ?? `type${r.itemTypeID}`;
		const n = notes.get(r.itemID);
		const a = atts.get(r.itemID);
		const an = anns.get(r.itemID);
		const parentID: number | null = n?.parentItemID ?? a?.parentItemID ?? an?.parentItemID ?? null;
		const pKey = parentID ? (parentKey.get(parentID) ?? null) : null;
		const item: LoadedItem = {
			itemID: r.itemID,
			key: r.key,
			typeName,
			version: r.version,
			clientVersion: r.clientVersion,
			dateAdded: r.dateAdded,
			dateModified: r.dateModified,
			clientDateModified: r.clientDateModified,
			deleted: deleted.has(r.itemID),
			parentID,
			parentKey: pKey,
		};
		const tagList = (tags.get(r.itemID) ?? []).map((t) => ({ tag: t.name as string, type: t.type as number }));
		if (an) {
			item.annotation = {
				key: r.key,
				type: an.type,
				authorName: an.authorName,
				text: an.text,
				comment: an.comment,
				color: an.color,
				pageLabel: an.pageLabel,
				sortIndex: an.sortIndex,
				position: an.position,
				tags: tagList,
				dateModified: toIso(r.dateModified),
				parentID: an.parentItemID,
				parentKey: pKey,
			};
			out.set(r.itemID, item);
			continue;
		}
		const f: Record<string, string> = {};
		for (const d of fields.get(r.itemID) ?? []) {
			const name = lk.fieldName.get(d.fieldID);
			if (!name || d.value === null || d.value === "") continue;
			f[name] = String(d.value);
		}
		const cl: Creator[] = (creators.get(r.itemID) ?? []).map((c) => {
			const creatorType = lk.creatorTypeName.get(c.creatorTypeID) ?? "author";
			return c.fieldMode === 1
				? { creatorType, name: c.lastName ?? "" }
				: { creatorType, firstName: c.firstName ?? "", lastName: c.lastName ?? "" };
		});
		const relations: Record<string, string | string[]> = {};
		for (const rel of rels.get(r.itemID) ?? []) {
			const cur = relations[rel.predicate];
			if (cur === undefined) relations[rel.predicate] = rel.object;
			else if (Array.isArray(cur)) cur.push(rel.object);
			else relations[rel.predicate] = [cur, rel.object];
		}
		const input: ItemInput = {
			key: r.key,
			version: r.version,
			type: typeName,
			parentKey: pKey,
			fields: f,
			creators: cl,
			tags: tagList,
			collections: (colls.get(r.itemID) ?? []).map((c) => c.key as string),
			relations,
			dateAdded: toIso(r.dateAdded),
			dateModified: toIso(r.dateModified),
			noteText: n?.note ?? undefined,
			inPublications: pubs.has(r.itemID),
		};
		if (a) {
			item.attRow = a;
			input.attachment = {
				linkMode: a.linkMode,
				contentType: a.contentType,
				charset: a.charsetID ? (lk.charsetName.get(a.charsetID) ?? "") : "",
				rawPath: a.path,
				storageHash: a.storageHash,
				storageModTime: a.storageModTime,
			};
		}
		item.input = input;
		out.set(r.itemID, item);
	}
}
