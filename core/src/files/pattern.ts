// Subfolder patterns for the attachment storage location, in ZotMoov's wildcard language.
//
//   {%a}/{%y}          first author / year (a folder per author, then per year)
//   {%c}               the collection path of the item (Parent/Child)
//   {%b | %I}          the first wildcard of the group that is not empty (citation key, else author initials)
//   {%Y}{-%M}{-%R}     a group is dropped when its wildcard is empty, so "{-%M}" adds "-05" only when there is a month
//   %a - %y            wildcards also work outside braces (an empty one gives nothing)
//
// Wildcards (ZotMoov's set; %F is the exception, see below):
//   %a author  %b citation key  %I author initials  %A / %F first letter of the author
//   %d editor  %D first letter of the editor  %L editor + initial  %l editor initials
//   %y year  %t title  %T item type  %j publication  %p publisher  %w publication, else publisher
//   %s journal abbreviation  %v volume  %e issue  %f pages  %c collection path
//   %Y %M %R year / month / day the item was added  %m %r month / day of the item's date  %U the "undefined" text
// Differences from ZotMoov: %F is the first letter of the author (zotero-next's earlier meaning; ZotMoov's "SmithA"
// form is not offered), and a title is not cut at its first punctuation mark.
// A segment that ends up empty is left out; the folder never leaves the storage folder.
import type { Database } from "bun:sqlite";

export const PATTERN_HELP =
	"{%a} author, {%y} year, {%t} title, {%j} publication, {%T} item type, {%c} collection path, {%A} first letter of the author, " +
	"{%b} citation key, {%I} author initials, {%p} publisher, {%v} volume, {%e} issue, {%Y}/{%M}/{%R} year/month/day added; " +
	"use {%b | %a} for the first of several, and {-%M} to add text only when the value exists";
export const TOKENS = new Set("abIFAdDLlytTjpwsvefcYmrMRU".split(""));
const LEGACY = new Set(["a", "y", "t", "j", "T", "F"]);

/** null when the pattern is acceptable, else why not. */
export function validatePattern(p: string): string | null {
	if (p.length > 200) return "the pattern is too long";
	let depth = 0;
	for (const ch of p) {
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		if (depth < 0 || depth > 1) return "unfinished placeholder";
	}
	if (depth !== 0) return "unfinished placeholder";
	for (const m of p.matchAll(/%([a-zA-Z])/g)) if (!TOKENS.has(m[1]!)) return `unknown placeholder %${m[1]}. Available: ${PATTERN_HELP}`;
	if (/^(?:[a-zA-Z]:|[\\/])/.test(p.trim())) return "the pattern must be relative to the storage folder";
	return null;
}

export interface PatternMeta {
	author: string;
	year: string;
	title: string;
	publication: string;
	itemType: string;
	citekey?: string;
	authorInitials?: string;
	editor?: string;
	editorLastF?: string;
	editorInitials?: string;
	publisher?: string;
	journalAbbrev?: string;
	volume?: string;
	issue?: string;
	pages?: string;
	/** Month and day of the item's own date, two digits. */
	month?: string;
	day?: string;
	addedYear?: string;
	addedMonth?: string;
	addedDay?: string;
	/** Collection names from the top collection down to the one the item is filed in. */
	collectionPath?: string[];
}

export interface PatternOptions {
	/** What %U stands for. */
	undefinedStr?: string;
	stripDiacritics?: boolean;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function stripAccents(s: string): string {
	return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function cleanSegment(s: string, max = 80): string {
	let out = s
		// eslint-disable-next-line no-control-regex
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/[\\/:*?"<>|]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[.\s]+|[.\s]+$/g, "");
	if (out.length > max) out = out.slice(0, max).trim().replace(/[.\s]+$/, "");
	if (RESERVED.test(out)) out = `_${out}`;
	return out;
}

const SEP = "\u0001"; // joins the folders of a collection path inside one substituted value

function raw(t: string, m: PatternMeta, undef: string): string {
	switch (t) {
		case "a": return m.author;
		case "b": return m.citekey ?? "";
		case "I": return (m.authorInitials ?? "").toUpperCase();
		case "A":
		case "F": return m.author ? m.author.charAt(0).toUpperCase() : "";
		case "d": return m.editor ?? "";
		case "D": return m.editor ? m.editor.charAt(0).toUpperCase() : "";
		case "L": return m.editorLastF ?? "";
		case "l": return m.editorInitials ?? "";
		case "y": return m.year;
		case "t": return m.title;
		case "T": return m.itemType;
		case "j": return m.publication;
		case "p": return m.publisher ?? "";
		case "w": return m.publication || (m.publisher ?? "");
		case "s": return m.journalAbbrev ?? "";
		case "v": return m.volume ?? "";
		case "e": return m.issue ?? "";
		case "f": return m.pages ?? "";
		case "c": return (m.collectionPath ?? []).map((n) => cleanSegment(n)).filter(Boolean).join(SEP);
		case "Y": return m.addedYear ?? "";
		case "M": return m.addedMonth ?? "";
		case "R": return m.addedDay ?? "";
		case "m": return m.month ?? "";
		case "r": return m.day ?? "";
		case "U": return undef;
		default: return "";
	}
}

/** What an empty %a, %y ... used to give before the wildcard language grew (kept so existing folders stay stable). */
function legacyFallback(t: string, m: PatternMeta): string {
	switch (t) {
		case "a": return "Unknown author";
		case "y": return "undated"; // not "n.d.": Windows folder names cannot end with a dot
		case "t": return "Untitled";
		case "j": return "No publication";
		case "T": return m.itemType || "item";
		case "F": return "?";
		default: return "";
	}
}

/** One {...} group (ZotMoov's rules): optional text, "|" separated alternatives, dropped when no wildcard has a value. */
function group(inner: string, m: PatternMeta, undef: string): string {
	const solo = inner.match(/^%([a-zA-Z])$/);
	if (solo && LEGACY.has(solo[1]!)) return raw(solo[1]!, m, undef) || legacyFallback(solo[1]!, m);
	const pre = inner.replace(/(%[a-zA-Z])([^|]*)\|/g, "$1|").replace(/\|([^%]*)(%[a-zA-Z])/g, "|$2");
	const parts = pre.split(/(%[a-zA-Z]|\|)/);
	const optional = parts.includes("|");
	let substituted = false;
	const out: string[] = [];
	for (const part of parts) {
		if (optional && substituted && part.startsWith("%")) continue;
		let v = part;
		if (part.startsWith("%")) {
			v = raw(part[1]!, m, undef);
			if (v) substituted = true;
			else if (!optional) return "";
		} else if (part === "|") v = "";
		out.push(v);
	}
	return substituted ? out.join("") : "";
}

/** Split on / and \ outside braces. */
function splitTop(p: string): string[] {
	const out: string[] = [];
	let cur = "";
	let depth = 0;
	for (const ch of p) {
		if (ch === "{") depth++;
		else if (ch === "}") depth = Math.max(0, depth - 1);
		if (depth === 0 && (ch === "/" || ch === "\\")) {
			out.push(cur);
			cur = "";
		} else cur += ch;
	}
	out.push(cur);
	return out;
}

/** Folder names for a pattern such as "{%a}/{%y}" (empty a/y/t/j/T values become Unknown author / undated / ...). */
export function expandPattern(pattern: string, meta: PatternMeta, opts: PatternOptions = {}): string[] {
	const undef = opts.undefinedStr ?? "undefined";
	const out: string[] = [];
	for (const seg of splitTop(pattern)) {
		const text = seg.replace(/\{([^{}]*)\}|%([a-zA-Z])/g, (_m, inner: string | undefined, tok: string | undefined) =>
			inner !== undefined ? group(inner, meta, undef) : TOKENS.has(tok!) ? raw(tok!, meta, undef) : _m,
		);
		for (const piece of text.split(SEP)) {
			let s = cleanSegment(piece);
			if (opts.stripDiacritics) s = stripAccents(s);
			if (s) out.push(s);
		}
	}
	return out;
}

// ---------------------------------------------------------------- item metadata

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** Month and day (two digits, "" when unknown) of a Zotero date string such as 2020-05-01, "May 2020" or "3 May 2020". */
export function monthDayOf(date: unknown): { month: string; day: string } {
	if (typeof date !== "string") return { month: "", day: "" };
	const iso = date.match(/(?<!\d)(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/);
	if (iso) return { month: two(Number(iso[2])), day: iso[3] ? two(Number(iso[3])) : "" };
	const mon = (s: string) => MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;
	let m = date.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+\d{4}/);
	if (m && mon(m[1]!) > 0) return { month: two(mon(m[1]!)), day: two(Number(m[2])) };
	m = date.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+\d{4}/);
	if (m && mon(m[2]!) > 0) return { month: two(mon(m[2]!)), day: two(Number(m[1])) };
	m = date.match(/([A-Za-z]{3,9})\.?,?\s+\d{4}/);
	if (m && mon(m[1]!) > 0) return { month: two(mon(m[1]!)), day: "" };
	return { month: "", day: "" };
}

interface Creator { creatorType?: string; lastName?: string; name?: string; firstName?: string }

function collectionPathOf(db: Database, itemKey: string, preferred?: string | null): string[] {
	const rows = db.query("SELECT collection_key FROM collection_items WHERE item_key = ? ORDER BY collection_key").all(itemKey) as { collection_key: string }[];
	if (!rows.length) return [];
	let start = rows[0]!.collection_key;
	if (preferred && rows.some((r) => r.collection_key === preferred)) start = preferred;
	const names: string[] = [];
	let cur: string | null = start;
	for (let i = 0; i < 10 && cur; i++) {
		const c = db.query("SELECT name, parent_key FROM collections WHERE key = ?").get(cur) as { name: string; parent_key: string | null } | null;
		if (!c) break;
		names.unshift(c.name);
		cur = c.parent_key;
	}
	return names;
}

export function metaOfItem(db: Database, itemKey: string | null | undefined, opts: { collectionKey?: string | null } = {}): PatternMeta {
	const blank: PatternMeta = { author: "", year: "", title: "", publication: "", itemType: "" };
	if (!itemKey) return blank;
	const row = db.query("SELECT item_type, title, year, publication, data, date_added FROM items WHERE key = ?").get(itemKey) as
		| { item_type: string; title: string | null; year: number | null; publication: string | null; data: string; date_added: string | null }
		| null;
	if (!row) return blank;
	const meta: PatternMeta = { ...blank, year: row.year ? String(row.year) : "", title: row.title ?? "", publication: row.publication ?? "", itemType: row.item_type };
	let d: Record<string, unknown> = {};
	try {
		d = JSON.parse(row.data) as Record<string, unknown>;
	} catch {
		// no further metadata
	}
	const creators = (Array.isArray(d.creators) ? d.creators : []) as Creator[];
	const a = creators.find((x) => x.creatorType === "author") ?? creators[0];
	meta.author = (a?.lastName || a?.name || a?.firstName || "").trim();
	meta.authorInitials = a ? `${(a.firstName ?? "").charAt(0)}${(a.lastName ?? a.name ?? "").charAt(0)}` : "";
	const e = creators.find((x) => x.creatorType === "editor");
	if (e) {
		meta.editor = (e.lastName || e.name || "").trim();
		meta.editorLastF = `${meta.editor}${(e.firstName ?? "").charAt(0).toUpperCase()}`;
		meta.editorInitials = `${(e.firstName ?? "").charAt(0)}${(e.lastName ?? "").charAt(0)}`.toUpperCase();
	}
	const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string).trim() : "");
	meta.publisher = str("publisher");
	meta.journalAbbrev = str("journalAbbreviation");
	meta.volume = str("volume");
	meta.issue = str("issue");
	meta.pages = str("pages");
	meta.citekey = str("citationKey") || /^Citation Key:\s*(\S+)/m.exec(str("extra"))?.[1] || "";
	const md = monthDayOf(d.date);
	meta.month = md.month;
	meta.day = md.day;
	const added = row.date_added?.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (added) {
		meta.addedYear = added[1];
		meta.addedMonth = added[2];
		meta.addedDay = added[3];
	}
	meta.collectionPath = collectionPathOf(db, itemKey, opts.collectionKey);
	return meta;
}
