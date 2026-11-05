// Column catalogue for the Classic table (ui/src/columns/defs.ts). A column is either one of a few "special" ones backed by
// ItemRow properties, or any Zotero data field (value delivered through the row's `fields`).
import { createSignal } from "solid-js";
import { api, type ZoteroSchema } from "../api";
import type { ItemRow } from "../contracts";

export interface Column {
	id: string;
	label: string;
	/** server-side sort key (GET /api/items?sort=) */
	sort: string;
	/** Zotero data field to request via `fields=` (absent when the summary already carries the value) */
	field?: string;
	width: number;
	align?: "right" | "center";
	/** header shows an icon instead of the label */
	icon?: "attachments" | "notes";
	get(it: ItemRow): string;
}

export const FALLBACK_LABELS: Record<string, string> = {
	title: "Title", creator: "Creator", itemType: "Item Type", date: "Date", year: "Year", publisher: "Publisher",
	publicationTitle: "Publication", journalAbbreviation: "Journal Abbr", language: "Language", accessDate: "Accessed",
	libraryCatalog: "Library Catalog", callNumber: "Call Number", rights: "Rights", dateAdded: "Date Added",
	dateModified: "Date Modified", archive: "Archive", archiveLocation: "Loc. in Archive", place: "Place",
	volume: "Volume", edition: "Edition", number: "Number", pages: "Pages", issue: "Issue", series: "Series",
	section: "Section", shortTitle: "Short Title", extra: "Extra", citationKey: "Citation Key", attachments: "Attachments", notes: "Notes", DOI: "DOI",
};

/** The columns listed directly in the picker, in Zotero's order (also the "Restore Column Order" order). */
export const MENU_COLUMNS = [
	"title", "creator", "itemType", "date", "year", "publisher", "publicationTitle", "journalAbbreviation", "language",
	"accessDate", "libraryCatalog", "callNumber", "rights", "dateAdded", "dateModified", "archive", "archiveLocation",
	"place", "volume", "edition", "number", "pages", "issue", "series", "section", "shortTitle", "extra",
	"citationKey", "attachments", "notes", "DOI",
];
export const DEFAULT_COLUMNS = ["title", "creator", "year", "publicationTitle", "dateAdded", "attachments"];
/** Fields that are not columns in their own right (collections, internal bookkeeping). */
const HIDDEN_FIELDS = new Set(["key", "version", "parentItem", "collections", "relations", "tags", "creators", "note", "deleted"]);

const [schema, setSchema] = createSignal<ZoteroSchema | null>(null);
export { schema };
let requested = false;
/** Fetch the schema once; failures fall back to the built-in labels. */
export function loadSchema() {
	if (requested) return;
	requested = true;
	api.schema().then(setSchema).catch(() => { requested = false; });
}

const date10 = (s: string | null | undefined) => (s ? s.slice(0, 10) : "");
/** A Zotero data field of a row (requested through `fields=`). */
export const fieldOf = (it: ItemRow, f: string): string => ((it.fields as Record<string, string | null> | undefined)?.[f]) ?? "";
const field = (f: string) => (it: ItemRow) => fieldOf(it, f);

/** "journalArticle" -> "Journal Article" (the schema label once it has loaded). */
export const itemTypeLabel = (t: string): string =>
	schema()?.itemTypes.find((x) => x.itemType === t)?.label ?? t.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

const SPECIAL: Record<string, Partial<Column> & Pick<Column, "get" | "sort">> = {
	title: { sort: "title", width: 360, get: (it) => it.title },
	creator: { sort: "creator", width: 160, get: (it) => it.creatorsSummary ?? "" },
	year: { sort: "year", width: 56, align: "right", get: (it) => (it.year ? String(it.year) : "") },
	itemType: { sort: "itemType", width: 120, get: (it) => itemTypeLabel(it.itemType) },
	publicationTitle: { sort: "publication", width: 160, get: (it) => it.publication ?? "" },
	dateAdded: { sort: "dateAdded", width: 96, get: (it) => date10(it.dateAdded) },
	dateModified: { sort: "dateModified", field: "dateModified", width: 96, get: (it) => date10(fieldOf(it, "dateModified")) },
	accessDate: { sort: "accessDate", field: "accessDate", width: 96, get: (it) => date10(fieldOf(it, "accessDate")) },
	attachments: { sort: "attachmentCount", width: 40, align: "center", icon: "attachments", get: (it) => (it.attachmentCount ? String(it.attachmentCount) : "") },
	notes: { sort: "noteCount", width: 48, align: "center", icon: "notes", get: (it) => (it.noteCount ? String(it.noteCount) : "") },
	citationKey: { sort: "citationKey", field: "citationKey", width: 160, get: (it) => fieldOf(it, "citationKey") },
};

export function labelOf(id: string): string {
	if (id === "creator" || id === "year" || id === "attachments" || id === "notes") return FALLBACK_LABELS[id]!;
	return schema()?.fieldLabels?.[id] ?? FALLBACK_LABELS[id] ?? id;
}

const cache = new Map<string, Column>();
/** Column definition for an id; the label is read live so it follows the schema once it arrives. */
export function getColumn(id: string): Column {
	let c = cache.get(id);
	if (!c) {
		const s = SPECIAL[id];
		const f = s ? s.field : id;
		const base: Column = s
			? { id, width: 120, field: f, ...s, label: "" }
			: { id, sort: id, width: 120, field: f, get: field(id), label: "" };
		c = Object.defineProperty(base, "label", { get: () => labelOf(id), enumerable: true }) as Column;
		cache.set(id, c);
	}
	return c;
}

/** Every schema field that is not already in the picker's main list, sorted by label. */
export function moreColumns(): { id: string; label: string }[] {
	const labels = schema()?.fieldLabels;
	if (!labels) return [];
	const main = new Set(MENU_COLUMNS);
	return Object.entries(labels)
		.filter(([id]) => !main.has(id) && !HIDDEN_FIELDS.has(id) && id !== "creator")
		.map(([id, label]) => ({ id, label }))
		.sort((a, b) => a.label.localeCompare(b.label));
}

export const isKnownColumn = (id: string) => id in SPECIAL || MENU_COLUMNS.includes(id) || /^[A-Za-z][A-Za-z0-9]*$/.test(id);

/** Sort keys of the common columns (SortBar chips list these first). */
export const SORT_OPTIONS = [
	{ key: "title", label: "Title" },
	{ key: "creator", label: "Creator" },
	{ key: "year", label: "Year" },
	{ key: "dateAdded", label: "Date Added" },
	{ key: "dateModified", label: "Date Modified" },
	{ key: "itemType", label: "Item Type" },
	{ key: "publication", label: "Publication" },
	{ key: "noteCount", label: "Notes" },
	{ key: "attachmentCount", label: "Attachments" },
];
export const sortLabel = (key: string) => SORT_OPTIONS.find((o) => o.key === key)?.label ?? labelOf(key);
/** Numeric / date keys read as arrows; text keys read "A-Z / Z-A". */
export const isNumericKey = (key: string) => /^(year|dateAdded|dateModified|accessDate|noteCount|attachmentCount)$/.test(key);
