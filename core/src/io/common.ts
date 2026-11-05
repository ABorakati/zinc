// Shared helpers for import/export: schema-aware field access, names, dates, text.
import type { Creator, ZoteroItemData } from "../api-types";
import { getSchema } from "../schema-data";

/** A child attachment an importer found: a file next to the import, or a link. */
export interface ParsedAttachment {
	title?: string;
	path?: string; // file path as written in the import; relative paths resolve against the import folder
	url?: string; // a link instead of a file
	contentType?: string;
}

/** What a parser produces: item data (type-specific field names), tags and child notes (HTML). */
export interface ParsedItem {
	data: Partial<ZoteroItemData> & { itemType: string };
	notes: string[];
	/** Child attachments to create; files are copied into the library's storage. */
	attachments?: ParsedAttachment[];
	/** Collection paths ("Parent", "Parent/Child") the item belongs to, for formats that carry collections. */
	collections?: string[][];
}

type SchemaType = ReturnType<typeof getSchema>["itemTypes"][number];
const typeCache = new Map<string, SchemaType | null>();
function schemaType(itemType: string): SchemaType | null {
	let t = typeCache.get(itemType);
	if (t === undefined) {
		t = getSchema().itemTypes.find((x) => x.itemType === itemType) ?? null;
		typeCache.set(itemType, t);
	}
	return t;
}

/** The item type's own field name for a base field ("publicationTitle" -> "bookTitle" for a book section), or null. */
export function fieldFor(itemType: string, base: string): string | null {
	const t = schemaType(itemType);
	if (!t) return null;
	const direct = t.fields.find((f) => f.field === base);
	if (direct) return direct.field;
	return t.fields.find((f) => f.baseField === base)?.field ?? null;
}

/** Set a field by base name for the item's type. Returns false when the type has no such field. */
export function setBase(data: Record<string, unknown>, base: string, value: string | undefined | null, overwrite = false): boolean {
	const v = (value ?? "").trim();
	if (!v) return false;
	const f = fieldFor(String(data.itemType), base);
	if (!f) return false;
	if (!overwrite && typeof data[f] === "string" && data[f]) return true;
	data[f] = v;
	return true;
}

/** First of several base fields the type has. */
export function setFirst(data: Record<string, unknown>, bases: string[], value: string | undefined | null): boolean {
	for (const b of bases) if (setBase(data, b, value)) return true;
	return false;
}

/** Value of a base field, whatever the type calls it. */
export function getBase(data: Record<string, unknown>, base: string): string {
	const direct = data[base];
	if (typeof direct === "string" && direct) return direct;
	const t = schemaType(String(data.itemType));
	if (t) {
		for (const f of t.fields) {
			if (f.baseField === base) {
				const v = data[f.field];
				if (typeof v === "string" && v) return v;
			}
		}
	}
	return "";
}

export function appendExtra(data: Record<string, unknown>, line: string): void {
	const cur = typeof data.extra === "string" ? data.extra : "";
	if (cur.split("\n").includes(line)) return;
	data.extra = cur ? `${cur}\n${line}` : line;
}

/** A creator type the item type allows: the wanted one, else a fallback, else the primary. */
export function creatorTypeFor(itemType: string, wanted: string, ...fallbacks: string[]): string {
	const t = schemaType(itemType);
	if (!t) return wanted;
	const ok = (c: string) => t.creatorTypes.some((x) => x.creatorType === c);
	for (const c of [wanted, ...fallbacks]) if (ok(c)) return c;
	return t.creatorTypes.find((c) => c.primary)?.creatorType ?? t.creatorTypes[0]?.creatorType ?? wanted;
}

export function hasField(itemType: string, field: string): boolean {
	return !!schemaType(itemType)?.fields.some((f) => f.field === field);
}

// ---------------------------------------------------------------- DOI, text

export function normDoi(s: string | undefined | null): string {
	return (s ?? "")
		.trim()
		.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "")
		.toLowerCase();
}

export function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === "#") {
			const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
		}
		return ENTITIES[e.toLowerCase()] ?? m;
	});
}

export function htmlToText(html: string): string {
	return decodeEntities(
		html
			.replace(/<\s*br\s*\/?>/gi, "\n")
			.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
			.replace(/<[^>]+>/g, ""),
	)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Plain text -> a note's HTML (paragraphs per blank-line-separated block, line breaks kept). */
export function textToNoteHtml(text: string): string {
	const paras = text
		.replace(/\r\n?/g, "\n")
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean);
	return (paras.length ? paras : [""]).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`).join("");
}

// ---------------------------------------------------------------- names

const LOWER_WORD = /^[a-zà-ÿ]/;

/** "Given Family" / "Family, Given" / "Family, Jr, Given" into a creator. */
export function parseName(raw: string, creatorType: string): Creator | null {
	const s = raw.trim().replace(/\s+/g, " ");
	if (!s || s.toLowerCase() === "others") return null;
	if (s.includes(",")) {
		const parts = s.split(",").map((p) => p.trim());
		const last = parts.length >= 3 ? `${parts[0]} ${parts[1]}`.trim() : parts[0]!;
		const first = parts.length >= 3 ? parts.slice(2).join(", ") : parts.slice(1).join(", ");
		if (!first) return { creatorType, name: last };
		return { creatorType, lastName: last, firstName: first };
	}
	const tokens = s.split(" ");
	if (tokens.length === 1) return { creatorType, lastName: s, firstName: "" };
	// particles (van, de, von…) travel with the family name
	let firstLower = -1;
	for (let i = 1; i < tokens.length - 1; i++) {
		if (LOWER_WORD.test(tokens[i]!)) {
			firstLower = i;
			break;
		}
	}
	const cut = firstLower > 0 ? firstLower : tokens.length - 1;
	return { creatorType, firstName: tokens.slice(0, cut).join(" "), lastName: tokens.slice(cut).join(" ") };
}

export function creatorLast(c: Creator): string {
	return (c.lastName ?? c.name ?? "").trim();
}
export function isSingleField(c: Creator): boolean {
	return !!c.name && !c.lastName && !c.firstName;
}
/** "Family, Given" (single-field names unchanged). */
export function creatorFamilyGiven(c: Creator): string {
	if (isSingleField(c)) return c.name!.trim();
	const l = (c.lastName ?? "").trim();
	const f = (c.firstName ?? "").trim();
	return f ? `${l}, ${f}` : l;
}

// ---------------------------------------------------------------- dates

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
export function monthNum(s: string): number | null {
	const t = s.trim().toLowerCase().replace(/\.$/, "");
	if (/^\d{1,2}$/.test(t)) {
		const n = +t;
		return n >= 1 && n <= 12 ? n : null;
	}
	if (t.length < 3) return null;
	const i = MONTHS.findIndex((m) => m === t || (t.length === 3 && m.startsWith(t)) || (t === "sept" && m === "september"));
	return i >= 0 ? i + 1 : null;
}

const pad = (n: number) => String(n).padStart(2, "0");
export function isoDate(y: number | string, m?: number | null, d?: number | null): string {
	const ys = String(y).padStart(4, "0");
	return m ? (d ? `${ys}-${pad(m)}-${pad(d)}` : `${ys}-${pad(m)}`) : ys;
}

/** Loose date text ("2020 Feb 15", "March 2022", "2020-05") into ISO where recognisable, else unchanged. */
export function normalizeDate(raw: string): string {
	const s = raw.trim();
	if (!s) return "";
	let m: RegExpMatchArray | null;
	if ((m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?$/))) return isoDate(+m[1]!, +m[2]!, m[3] ? +m[3] : null);
	if ((m = s.match(/^(\d{4})\s+([A-Za-z]{3,9})\.?(?:\s+(\d{1,2}))?/))) {
		const mo = monthNum(m[2]!);
		if (mo) return isoDate(+m[1]!, mo, m[3] ? +m[3] : null);
	}
	if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{4})$/))) {
		const mo = monthNum(m[1]!);
		if (mo) return isoDate(+m[3]!, mo, m[2] ? +m[2] : null);
	}
	if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/))) {
		const mo = monthNum(m[2]!);
		if (mo) return isoDate(+m[3]!, mo, +m[1]!);
	}
	return s;
}

/** [year, month?, day?] when the (Zotero) date string starts with a numeric ISO-ish date. */
export function dateParts(raw: string | undefined): number[] | null {
	const s = normalizeDate(raw ?? "");
	const m = s.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?(?:\s|$)/);
	if (!m) {
		const y = s.match(/\b(\d{4})\b/);
		return y ? [+y[1]!] : null;
	}
	const out = [+m[1]!];
	if (m[2] && +m[2] > 0) out.push(+m[2]);
	if (m[3] && +m[3] > 0 && out.length === 2) out.push(+m[3]);
	return out;
}

export function uniq<T>(xs: T[]): T[] {
	return [...new Set(xs)];
}

export function splitKeywords(s: string): string[] {
	return uniq(
		s
			.split(/\s*[;,\n]\s*/)
			.map((k) => k.trim())
			.filter(Boolean),
	);
}
