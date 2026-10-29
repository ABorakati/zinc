// Catalogue of fields that can appear on a card's meta line (line 3).
import { labelOf, MENU_COLUMNS, moreColumns, schema } from "../columns/defs";
import type { ItemSummary } from "../api";

export interface MetaField {
	id: string;
	label: string;
	/** Zotero data fields to request via `fields=` */
	fields: string[];
	/** text shown before the value ("Added", "Vol.") */
	prefix?: string;
	/** rendered in the accent colour (the venue) */
	accent?: boolean;
	get(it: ItemSummary): string;
}

const date10 = (s: string | null | undefined) => (s ? s.slice(0, 10) : "");
const f = (it: ItemSummary, k: string) => it.fields?.[k] ?? "";

const SPECIAL: Record<string, Omit<MetaField, "id" | "label"> & { label?: string }> = {
	itemType: {
		fields: [],
		get: (it) => schema()?.itemTypes.find((t) => t.itemType === it.itemType)?.label ?? it.itemType.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()),
	},
	year: { label: "Year", fields: [], get: (it) => (it.year ? String(it.year) : "") },
	date: { fields: ["date"], get: (it) => f(it, "date") },
	dateAdded: { fields: [], prefix: "Added", get: (it) => date10(it.dateAdded) },
	dateModified: { fields: ["dateModified"], prefix: "Modified", get: (it) => date10(f(it, "dateModified")) },
	accessDate: { fields: ["accessDate"], prefix: "Accessed", get: (it) => date10(f(it, "accessDate")) },
	publication: { label: "Publication / venue", fields: [], accent: true, get: (it) => it.publication ?? "" },
	DOI: { fields: ["DOI"], prefix: "doi:", get: (it) => f(it, "DOI") },
	volIssuePages: {
		label: "Volume / Issue / Pages",
		fields: ["volume", "issue", "pages"],
		get: (it) => {
			const [v, i, p] = [f(it, "volume"), f(it, "issue"), f(it, "pages")];
			return (v + (i ? `(${i})` : "") + (p ? (v || i ? ":" : "pp. ") + p : "")).trim();
		},
	},
	extra: { fields: ["extra"], get: (it) => f(it, "extra").split("\n")[0] },
	volume: { fields: ["volume"], prefix: "Vol.", get: (it) => f(it, "volume") },
	issue: { fields: ["issue"], prefix: "Issue", get: (it) => f(it, "issue") },
	pages: { fields: ["pages"], prefix: "pp.", get: (it) => f(it, "pages") },
};

/** Fields offered first in the "add field" menu. */
export const COMMON_FIELDS = ["publication", "year", "itemType", "date", "dateAdded", "dateModified", "DOI", "volIssuePages", "extra"];

const cache = new Map<string, MetaField>();
export function getMetaField(id: string): MetaField {
	let m = cache.get(id);
	if (!m) {
		const s = SPECIAL[id];
		const base = s
			? { id, fields: s.fields, prefix: s.prefix, accent: s.accent, get: s.get }
			: { id, fields: [id], prefix: undefined, accent: false, get: (it: ItemSummary) => f(it, id) };
		m = Object.defineProperty(base, "label", { get: () => s?.label ?? labelOf(id), enumerable: true }) as MetaField;
		cache.set(id, m);
	}
	return m;
}

/** Text of a field including its prefix; generic schema fields are prefixed with their label. */
export function metaText(m: MetaField, it: ItemSummary): string {
	const v = m.get(it);
	if (!v) return "";
	if (m.prefix) return m.prefix.endsWith(":") ? m.prefix + v : `${m.prefix} ${v}`;
	if (!SPECIAL[m.id] && m.id !== "title") return `${m.label}: ${v}`;
	return v;
}

/** Everything else the user can add: the picker's other columns plus every remaining schema field. */
export function otherFieldIds(): string[] {
	const skip = new Set([...COMMON_FIELDS, "title", "creator", "attachments", "notes", "publicationTitle", "accessDate"]);
	const ids = [...MENU_COLUMNS, ...moreColumns().map((c) => c.id)].filter((id) => !skip.has(id));
	return [...new Set(["accessDate", ...ids])];
}

export const isKnownMeta = (id: string) => id in SPECIAL || /^[A-Za-z][A-Za-z0-9]*$/.test(id);
