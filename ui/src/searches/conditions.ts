// Field and operator catalogue for the condition editor (mirrors core/src/searches/compile.ts).
import type { Operator, SearchCondition, ZoteroSchema } from "~/api";

export type Kind = "text" | "creator" | "year" | "date" | "datetime" | "itemType" | "tag" | "collection" | "note" | "fileType" | "fulltext" | "any";

export interface FieldDef {
	id: string;
	label: string;
	kind: Kind;
}

export const BASE_FIELDS: FieldDef[] = [
	{ id: "title", label: "Title", kind: "text" },
	{ id: "creator", label: "Creator", kind: "creator" },
	{ id: "year", label: "Year", kind: "year" },
	{ id: "date", label: "Date", kind: "date" },
	{ id: "dateAdded", label: "Date Added", kind: "datetime" },
	{ id: "dateModified", label: "Date Modified", kind: "datetime" },
	{ id: "publicationTitle", label: "Publication", kind: "text" },
	{ id: "itemType", label: "Item Type", kind: "itemType" },
	{ id: "tag", label: "Tag", kind: "tag" },
	{ id: "collection", label: "Collection", kind: "collection" },
	{ id: "note", label: "Note", kind: "note" },
	{ id: "attachmentFileType", label: "Attachment File Type", kind: "fileType" },
	{ id: "fulltextContent", label: "Attachment Content", kind: "fulltext" },
	{ id: "anyField", label: "All Fields & Tags", kind: "any" },
];

const TEXT: Operator[] = ["contains", "doesNotContain", "is", "isNot", "beginsWith"];
const DATE: Operator[] = ["is", "isNot", "isBefore", "isAfter", "isInTheLast"];

export const OPERATORS_BY_KIND: Record<Kind, Operator[]> = {
	text: TEXT,
	creator: TEXT,
	year: ["is", "isNot", "isBefore", "isAfter", "contains", "beginsWith"],
	date: DATE,
	datetime: DATE,
	itemType: ["is", "isNot", "contains", "doesNotContain"],
	tag: TEXT,
	collection: ["is", "isNot"],
	note: ["contains", "doesNotContain"],
	fileType: ["is", "isNot"],
	fulltext: ["contains", "doesNotContain"],
	any: TEXT,
};

export const OPERATOR_LABELS: Record<Operator, string> = {
	is: "is",
	isNot: "is not",
	contains: "contains",
	doesNotContain: "does not contain",
	beginsWith: "begins with",
	isBefore: "is before",
	isAfter: "is after",
	isInTheLast: "is in the last",
};

export const FILE_TYPES = [
	["pdf", "PDF"],
	["image", "Image"],
	["snapshot", "Web page snapshot"],
	["epub", "EPUB"],
	["audio", "Audio"],
	["video", "Video"],
	["document", "Document"],
] as const;

export const PERIOD_UNITS = ["days", "weeks", "months", "years"] as const;

const BASE_IDS = new Set(BASE_FIELDS.map((f) => f.id.toLowerCase()));

/** Everything else from the item schema ("More fields"), sorted by label. */
export function schemaFields(schema: ZoteroSchema | undefined): FieldDef[] {
	if (!schema) return [];
	const out: FieldDef[] = [];
	for (const [id, label] of Object.entries(schema.fieldLabels)) {
		if (BASE_IDS.has(id.toLowerCase())) continue;
		out.push({ id, label, kind: /Date$/.test(id) ? "date" : "text" });
	}
	return out.sort((a, b) => a.label.localeCompare(b.label));
}

export function fieldKind(id: string, extra: FieldDef[]): Kind {
	return BASE_FIELDS.find((f) => f.id === id)?.kind ?? extra.find((f) => f.id === id)?.kind ?? "text";
}

/** A sensible starting condition for a field (first operator, empty value). */
export function blankCondition(field: string, extra: FieldDef[]): SearchCondition {
	return { field, operator: OPERATORS_BY_KIND[fieldKind(field, extra)][0], value: "" };
}

export function parsePeriod(v: string): { n: string; unit: (typeof PERIOD_UNITS)[number] } {
	const m = /^\s*(\d+)\s*(day|week|month|year)s?\s*$/i.exec(v);
	return m ? { n: m[1], unit: (m[2].toLowerCase() + "s") as (typeof PERIOD_UNITS)[number] } : { n: "", unit: "months" };
}
