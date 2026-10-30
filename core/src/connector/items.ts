// Translator output (Zotero.Item.toArray() JSON, as the extension sends it to /connector/saveItems) ->
// zotero-next items: creators, tags (automatic, type 1), child notes and linked-URL attachments.
import type { Database } from "bun:sqlite";
import type { Creator, ZoteroItemData } from "../api-types";
import { createItem, nowIso } from "../db";
import { fieldFor } from "../io/common";
import { getSchema, hasItemType } from "../schema-data";
import { indexItem } from "../search";
import { toProper, type ProxyInfo } from "./proxy";

type SchemaType = ReturnType<typeof getSchema>["itemTypes"][number];

// Keys of translator JSON that are not item fields.
const NOT_FIELDS = new Set([
	"id", "sessionID", "attachments", "notes", "seeAlso", "tags", "creators", "key", "version", "dateAdded", "dateModified",
	"complete", "itemID", "libraryID", "collections", "relations", "mimeType", "proxy", "hasAttachmentResolvers",
	"hasPrimaryAttachment", "deleted", "parentItem", "itemType", "uri", "isOpenAccess", "referrer", "snapshot", "linkMode",
]);

let types: Map<string, SchemaType> | null = null;
let baseOf: Map<string, string> | null = null;
function schemaType(itemType: string): SchemaType | undefined {
	if (!types) {
		const s = getSchema();
		types = new Map(s.itemTypes.map((t) => [t.itemType, t]));
		baseOf = new Map();
		for (const t of s.itemTypes) for (const f of t.fields) if (f.baseField) baseOf.set(f.field, f.baseField);
	}
	return types.get(itemType);
}

function str(v: unknown): string {
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	return "";
}

export function normalizeAccessDate(v: unknown): string {
	const s = str(v).trim();
	if (!s || s === "CURRENT_TIMESTAMP") return nowIso();
	return s;
}

/** Creator objects of a translator: {firstName,lastName,creatorType,fieldMode?} / {name,creatorType}. */
export function convertCreators(raw: unknown, itemType: string): Creator[] {
	if (!Array.isArray(raw)) return [];
	const t = schemaType(itemType);
	const valid = new Set(t?.creatorTypes.map((c) => c.creatorType));
	const primary = t?.creatorTypes.find((c) => c.primary)?.creatorType ?? t?.creatorTypes[0]?.creatorType ?? "author";
	const out: Creator[] = [];
	for (const c of raw) {
		if (!c || typeof c !== "object") continue;
		const o = c as Record<string, unknown>;
		const requested = str(o.creatorType);
		const creatorType = requested && valid.has(requested) ? requested : primary;
		const first = str(o.firstName).trim();
		const last = str(o.lastName).trim();
		const single = str(o.name).trim() || (o.fieldMode === 1 || o.fieldMode === "1" ? last : "");
		if (single && !first) out.push({ creatorType, name: single });
		else if (first || last) out.push({ creatorType, firstName: first, lastName: last });
	}
	return out;
}

/** Tags of a translator: strings or {tag, type}. The Connector saves them all as automatic (type 1) tags. */
export function convertTags(raw: unknown, type = 1): { tag: string; type: number }[] {
	if (!Array.isArray(raw)) return [];
	const out: { tag: string; type: number }[] = [];
	const seen = new Set<string>();
	for (const t of raw) {
		const tag = str(typeof t === "object" && t ? (t as { tag?: unknown }).tag : t).trim();
		if (!tag || seen.has(tag)) continue;
		seen.add(tag);
		out.push({ tag, type });
	}
	return out;
}

/** Item fields only: maps base/type-specific field names, parks unknown-for-type fields in Extra. */
export function convertFields(raw: Record<string, unknown>, itemType: string): Record<string, unknown> {
	const t = schemaType(itemType);
	const labels = getSchema().fieldLabels;
	const valid = new Set(t?.fields.map((f) => f.field));
	const out: Record<string, unknown> = {};
	const extra: string[] = [];
	for (const [k, v] of Object.entries(raw)) {
		if (NOT_FIELDS.has(k)) continue;
		const value = str(v);
		if (!value.trim()) continue;
		let field: string | null = null;
		if (k === "extra" || k === "accessDate" || valid.has(k)) field = k;
		else if (k === "note" && itemType === "note") field = k;
		else {
			// publicationTitle for a book section is bookTitle, bookTitle for an article is publicationTitle, ...
			const base = baseOf?.get(k) ?? k;
			const mapped = fieldFor(itemType, base);
			if (mapped && valid.has(mapped)) field = mapped;
		}
		if (field) {
			if (field === "accessDate") out.accessDate = normalizeAccessDate(v);
			else if (field === "extra") extra.unshift(value);
			else if (out[field] === undefined) out[field] = value;
		} else if (labels[k]) {
			extra.push(`${labels[k]}: ${value}`);
		}
	}
	if (extra.length) out.extra = extra.join("\n");
	return out;
}

export function noteHtml(raw: unknown): string {
	const s = typeof raw === "object" && raw ? str((raw as { note?: unknown }).note) : str(raw);
	return s.trim();
}

/** Plain text typed in the extension's note box -> HTML (text starting with "<" is taken as HTML already). */
export function userNoteToHtml(s: string): string {
	const t = s.trim();
	if (!t) return "";
	if (t.startsWith("<")) return t;
	const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return t.split(/\r?\n/).map((l) => `<p>${esc(l)}</p>`).join("");
}

export interface SavedItem {
	/** the extension's id for the item (item.id) */
	connectorId: string;
	key: string;
	/** extension attachment id -> key, for attachments created here (linked URLs) */
	attachments: Record<string, string>;
}

/** Create one translated item (with its notes and link attachments) in `collectionKey`. */
export function saveTranslatedItem(db: Database, raw: Record<string, unknown>, collectionKey: string | null, tags: { tag: string; type: number }[] = [], proxy: ProxyInfo | null = null): SavedItem {
	const requested = str(raw.itemType);
	const itemType = hasItemType(requested) && requested !== "attachment" ? requested : "document";
	const fields = convertFields(raw, itemType);
	// a page read through the university proxy: store the publisher's own URL, as Zotero does
	if (typeof fields.url === "string") fields.url = toProper(proxy, fields.url);
	const creators = convertCreators(raw.creators, itemType);
	const mergedTags = [...convertTags(raw.tags, 1), ...tags];
	const data: Partial<ZoteroItemData> = {
		...fields,
		itemType,
		tags: mergedTags,
		collections: collectionKey ? [collectionKey] : [],
		relations: {},
	};
	if (creators.length && itemType !== "note") data.creators = creators;
	if (itemType === "note") data.note = noteHtml(raw.note);

	const connectorId = str(raw.id);
	const saved: SavedItem = { connectorId, key: "", attachments: {} };
	db.transaction(() => {
		const detail = createItem(db, data);
		saved.key = detail.data.key;
		if (itemType === "note") return;
		for (const n of Array.isArray(raw.notes) ? raw.notes : []) {
			const html = noteHtml(n);
			if (html) createItem(db, { itemType: "note", note: html, parentItem: saved.key, tags: convertTags((n as { tags?: unknown })?.tags, 1) });
		}
		// Only link-only attachments (snapshot: false) come with the item; files are uploaded afterwards.
		for (const a of Array.isArray(raw.attachments) ? raw.attachments : []) {
			if (!a || typeof a !== "object" || (a as { snapshot?: unknown }).snapshot !== false) continue;
			const url = toProper(proxy, str((a as { url?: unknown }).url).trim());
			if (!url || !/^https?:\/\//i.test(url)) continue;
			const mime = str((a as { mimeType?: unknown }).mimeType);
			const att = createItem(db, {
				itemType: "attachment",
				linkMode: "linked_url",
				parentItem: saved.key,
				title: str((a as { title?: unknown }).title).trim() || url,
				url,
				accessDate: nowIso(),
				contentType: mime,
				tags: convertTags((a as { tags?: unknown }).tags, 1),
			});
			const aid = str((a as { id?: unknown }).id);
			if (aid) saved.attachments[aid] = att.data.key;
		}
	})();
	indexItem(db, saved.key);
	return saved;
}
