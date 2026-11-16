// Zotero's item schema (vendored from github.com/zotero/zotero-schema) turned into the
// ZoteroSchema API response, plus field-name lookups used to validate sort/fields.

import type { ZoteroSchema, ZoteroSchemaItemType } from "../api-types";
import raw from "./schema.json" with { type: "json" };

interface RawItemType {
	itemType: string;
	fields: { field: string; baseField?: string }[];
	creatorTypes: { creatorType: string; primary?: boolean }[];
}

const rawTypes = raw.itemTypes as RawItemType[];
const loc = raw.locales["en-US"] as {
	itemTypes: Record<string, string>;
	fields: Record<string, string>;
	creatorTypes: Record<string, string>;
};

let cached: ZoteroSchema | null = null;

export function getSchema(): ZoteroSchema {
	if (cached) return cached;
	const itemTypes: ZoteroSchemaItemType[] = [];
	for (const t of rawTypes) {
		if (t.itemType === "annotation") continue; // annotations live in the reader, not the item list
		const creatorTypes = t.creatorTypes.map((c) => ({
			creatorType: c.creatorType,
			label: loc.creatorTypes[c.creatorType] ?? c.creatorType,
			primary: !!c.primary,
		}));
		creatorTypes.sort((a, b) => Number(b.primary) - Number(a.primary)); // stable: keeps Zotero's order otherwise
		itemTypes.push({
			itemType: t.itemType,
			label: loc.itemTypes[t.itemType] ?? t.itemType,
			fields: t.fields.map((f) => ({
				field: f.field,
				label: loc.fields[f.field] ?? f.field,
				...(f.baseField ? { baseField: f.baseField } : {}),
			})),
			creatorTypes,
		});
	}
	cached = { version: raw.version, itemTypes, fieldLabels: { ...loc.fields } };
	return cached;
}

export function hasItemType(itemType: string): boolean {
	return getSchema().itemTypes.some((t) => t.itemType === itemType);
}

// Extra data fields the API accepts beside the schema's own.
const EXTRA_FIELDS = ["itemType", "dateAdded", "dateModified", "accessDate", "extra"];

let fieldIndex: Map<string, string> | null = null;

// Lower-cased field name -> canonical name, for every field a client may sort by or request.
export function fieldLookup(): Map<string, string> {
	if (fieldIndex) return fieldIndex;
	fieldIndex = new Map();
	for (const t of rawTypes) for (const f of t.fields) fieldIndex.set(f.field.toLowerCase(), f.field);
	for (const f of Object.keys(loc.fields)) fieldIndex.set(f.toLowerCase(), f);
	for (const f of EXTRA_FIELDS) fieldIndex.set(f.toLowerCase(), f);
	return fieldIndex;
}

export function canonicalField(name: string): string | null {
	return fieldLookup().get(name.toLowerCase()) ?? null;
}

// Item types that can't be converted to or from (they aren't regular metadata items).
const FIXED_TYPES = new Set(["note", "attachment", "annotation"]);

/**
 * Change an item's type the way Zotero does: each field moves to the new type's field
 * with the same name or the same base field (publicationTitle -> bookTitle), fields the
 * new type lacks are dropped, and creators with a type the new item type doesn't allow
 * become its primary creator type. Returns the new data and the dropped field names.
 */
export function convertItemType<T extends Record<string, unknown>>(data: T, itemType: string): { data: T; dropped: string[] } {
	const from = rawTypes.find((t) => t.itemType === data.itemType);
	const to = rawTypes.find((t) => t.itemType === itemType);
	if (!from || !to || FIXED_TYPES.has(from.itemType) || FIXED_TYPES.has(to.itemType)) {
		throw new Error(`cannot change item type from ${String(data.itemType)} to ${itemType}`);
	}
	const base = (f: { field: string; baseField?: string }) => f.baseField ?? f.field;
	const out: Record<string, unknown> = { ...data, itemType };
	const dropped: string[] = [];
	for (const f of from.fields) {
		const value = data[f.field];
		delete out[f.field];
		if (value === undefined || value === "") continue;
		const target = to.fields.find((t) => t.field === f.field) ?? to.fields.find((t) => base(t) === base(f));
		if (target) out[target.field] = value;
		else dropped.push(f.field);
	}
	if (Array.isArray(data.creators)) {
		const allowed = new Set(to.creatorTypes.map((c) => c.creatorType));
		const primary = to.creatorTypes.find((c) => c.primary)?.creatorType ?? to.creatorTypes[0]?.creatorType;
		out.creators = (data.creators as { creatorType: string }[]).map((c) =>
			allowed.has(c.creatorType) || !primary ? c : { ...c, creatorType: primary },
		);
	}
	return { data: out as T, dropped };
}
