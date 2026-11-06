// Shared mapping between Zotero's EAV tables and Zotero Web API item JSON, plus the small
// Zotero utility functions the writer must mimic (date multipart, search normalisation, note title).
// Used by both the importer (core/src/import/zotero.ts) and the live reader/writer in this folder.
import { codePointChar } from "../entity";
import { zoteroRawPathFilename } from "../import/resolve-files";
import { strToMultipart } from "./zotero-date";

export const LINK_MODES = ["imported_file", "imported_url", "linked_file", "linked_url"];
export const ANNOTATION_TYPES: Record<number, string> = {
	1: "highlight",
	2: "note",
	3: "image",
	4: "ink",
	5: "underline",
	6: "text",
};
export const ANNOTATION_TYPE_IDS: Record<string, number> = Object.fromEntries(
	Object.entries(ANNOTATION_TYPES).map(([id, name]) => [name, Number(id)]),
);
export const PUBLICATION_FIELDS = [
	"publicationTitle",
	"bookTitle",
	"proceedingsTitle",
	"websiteTitle",
	"blogTitle",
	"forumTitle",
	"encyclopediaTitle",
	"dictionaryTitle",
	"programTitle",
	"university",
	"publisher",
];
export const DEFAULT_ANNOTATION_COLOR = "#ffd400";
export const NOTE_PREFIX = '<div class="zotero-note znv1">';
export const NOTE_SUFFIX = "</div>";
// Zotero.Utilities.allowedKeyChars
export const KEY_CHARS = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";

export type Row = Record<string, any>;

export interface Creator {
	creatorType: string;
	firstName?: string;
	lastName?: string;
	name?: string;
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

// "2026-05-27 21:24:45" (UTC) -> "2026-05-27T21:24:45Z"
export function toIso(s: string | null | undefined): string {
	if (!s) return new Date(0).toISOString().replace(".000", "");
	return `${s.replace(" ", "T")}Z`;
}

/** ISO ("2026-05-27T21:24:45Z" or with millis) -> Zotero SQL datetime "2026-05-27 21:24:45". */
export function isoToSql(s: string | null | undefined): string | null {
	if (!s) return null;
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
	const d = new Date(s);
	if (Number.isNaN(d.getTime())) return null;
	return sqlNow(d);
}

export function sqlNow(d: Date = new Date()): string {
	return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

// Zotero stores dates as "YYYY-MM-DD original text"; the API returns the original text.
export function dateForApi(v: string): string {
	const m = /^\d{4}-\d{2}-\d{2} ([\s\S]*)$/.exec(v);
	return m ? m[1] : v;
}

export function parseYear(raw: string | undefined): number | null {
	if (!raw) return null;
	const sortable = /^(\d{4})-\d{2}-\d{2}/.exec(raw);
	if (sortable && sortable[1] !== "0000") return Number(sortable[1]);
	const m = /(?<!\d)(\d{4})(?!\d)/.exec(dateForApi(raw));
	return m ? Number(m[1]) : null;
}

/**
 * Zotero.Date.strToMultipart: "YYYY-MM-DD <original text>" with 00 for missing parts and 0000 when no year is found
 * (see zotero-date.ts for the port of Zotero's date parser this uses).
 */
export function dateToMultipart(text: string): string {
	return strToMultipart(text);
}

// ---------------------------------------------------------------------------------------------
// Search normalisation (Zotero.Utilities.Internal.normalizeForSearch / ...Storage)
// ---------------------------------------------------------------------------------------------

const SEARCH_MAP: Record<string, string> = {
	"ø": "o", "œ": "oe", "æ": "ae", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ß": "ss", "ı": "i", "\u2044": "/",
};
const SEARCH_FORMATTING_TAG_RE =
	/<\/?(?:i|b|sub|sup)>|<span (?:style="font-variant:small-caps;"|class="nocase")>|<\/span>/g;

export function normalizeForSearch(str: string): string {
	if (!str) return str;
	if (str.includes("<")) str = str.replace(SEARCH_FORMATTING_TAG_RE, "");
	return str
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[øœæłđðþßı\u2044]/g, (c) => SEARCH_MAP[c])
		.replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
		.replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.normalize("NFC");
}

/** Value for the *Normalized columns: null unless normalising changes more than ASCII case. */
export function normalizeForSearchStorage(value: unknown): string | null {
	if (typeof value !== "string" || !value) return null;
	const normalized = normalizeForSearch(value);
	const asciiLowercased = value.replace(/[A-Z]/g, (c) => c.toLowerCase());
	return normalized === asciiLowercased ? null : normalized;
}

// ---------------------------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function unescapeHtml(s: string): string {
	return s
		.replace(/<[^>]*>/g, "")
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
			if (e[0] === "#") {
				const code = e[1].toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
				return Number.isFinite(code) ? codePointChar(code) : m;
			}
			return ENTITIES[e.toLowerCase()] ?? m;
		});
}

/** Zotero.Utilities.Item.noteToTitle */
export function noteToTitle(text: string): string {
	const MAX = 120;
	const orig = text;
	text = text.trim();
	text = text.replace(/(<\/(h\d|p|div)+>)/g, "$1\n");
	text = text.replace(/<br\s*\/?>/g, " ");
	text = unescapeHtml(text);
	if (/^<[^>\n]+[^/]>\n/.test(orig)) text = text.trim();
	let t = text.substring(0, MAX);
	const ln = t.indexOf("\n");
	if (ln > -1 && ln < MAX) t = t.substring(0, ln);
	return t;
}

/** Item.setNote text cleaning + the <div class="zotero-note znv1"> wrapper added when saving. */
export function cleanNote(text: string): string {
	return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}
export function wrapNote(text: string): string {
	return /^<div class="zotero-note znv[0-9]+">[\s\S]*<\/div>$/.test(text) ? text : NOTE_PREFIX + text + NOTE_SUFFIX;
}

/** Zotero.File.getValidFileName */
export function validFileName(name: string): string {
	let f = name
		.replace(/[/\\?*:|"<>]/g, "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\u2000-\u200a]/g, " ")
		.replace(/[\u200b-\u200e]/g, "")
		.replace(/[\u2028-\u2029]/g, " ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "");
	f = f.normalize().replace(/[\u2068\u2069]/g, "").replace(/^\./, "");
	if (!f || f === "." || f === "..") f = "_";
	return f;
}

// ---------------------------------------------------------------------------------------------
// Creators / summaries
// ---------------------------------------------------------------------------------------------

export function creatorsSummary(creators: Creator[]): string {
	let pool = creators.filter((c) => c.creatorType === "author");
	if (pool.length === 0) pool = creators.slice(0, 1);
	const names = pool.map((c) => c.lastName ?? c.name ?? "").filter((n) => n);
	if (names.length === 0) return "";
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names[0]} et al.`;
}

export function publicationOf(fields: Record<string, string>): string | null {
	for (const pf of PUBLICATION_FIELDS) if (fields[pf]) return fields[pf];
	return null;
}

// ---------------------------------------------------------------------------------------------
// Row -> Web API JSON
// ---------------------------------------------------------------------------------------------

export interface AttachmentInput {
	linkMode: number;
	contentType: string | null;
	charset: string; // charset name or ""
	rawPath: string | null; // Zotero's raw path ('storage:x.pdf', 'attachments:x.pdf', absolute)
	storageHash: string | null;
	storageModTime: number | null;
	/** Filename override (importer resolves it); default derived from rawPath. */
	filename?: string;
	/** Reader: absolute path of the file; used as data.path for linked files. */
	resolvedPath?: string | null;
}

export interface ItemInput {
	key: string;
	version: number;
	type: string;
	parentKey: string | null;
	fields: Record<string, string>;
	creators: Creator[];
	tags: { tag: string; type: number }[];
	collections: string[]; // only used for top-level items
	relations: Record<string, string | string[]>;
	dateAdded: string; // ISO
	dateModified: string; // ISO
	noteText?: string; // itemNotes.note (notes, and embedded notes of attachments)
	inPublications?: boolean; // has a publicationsItems row (My Publications)
	attachment?: AttachmentInput;
}

/** Build the Zotero Web API JSON for one item (the importer's items.data shape). */
export function buildItemData(it: ItemInput): Record<string, unknown> {
	const f = it.fields;
	const data: Record<string, unknown> = { key: it.key, version: it.version, itemType: it.type };
	if (it.parentKey) data.parentItem = it.parentKey;

	const a = it.attachment;
	if (a) {
		const linkMode = LINK_MODES[a.linkMode] ?? "imported_file";
		data.linkMode = linkMode;
		if (f.title !== undefined) data.title = f.title;
		if (f.accessDate) data.accessDate = f.accessDate;
		if (f.url) data.url = f.url;
		if (f.note) data.note = f.note;
		data.contentType = a.contentType ?? "";
		data.charset = a.charset;
		const filename = a.filename ?? (linkMode === "linked_url" ? undefined : zoteroRawPathFilename(a.rawPath));
		if (filename && linkMode !== "linked_url") data.filename = filename;
		if (a.storageHash) data.md5 = a.storageHash;
		if (a.storageModTime) data.mtime = a.storageModTime;
		if (linkMode === "linked_file") {
			const p = a.resolvedPath ?? a.rawPath;
			if (p) data.path = p;
		}
		if (f.extra) data.extra = f.extra;
	} else if (it.type === "note") {
		data.note = it.noteText ?? "";
	} else {
		for (const [k, v] of Object.entries(f)) data[k] = k === "date" ? dateForApi(v) : v;
		data.creators = it.creators.length ? it.creators : [];
	}
	data.tags = it.tags.map((t) => (t.type ? { tag: t.tag, type: t.type } : { tag: t.tag }));
	if (!it.parentKey) data.collections = [...it.collections].sort();
	if (it.inPublications) data.inPublications = true;
	data.relations = it.relations;
	data.dateAdded = it.dateAdded;
	data.dateModified = it.dateModified;
	return data;
}

export interface AnnotationInput {
	key: string;
	type: number;
	authorName: string | null;
	text: string | null;
	comment: string | null;
	color: string | null;
	pageLabel: string | null;
	sortIndex: string;
	position: string; // JSON text
	tags: { tag: string; type: number }[];
	dateModified: string; // ISO
}

/** Reader annotation JSON (the importer's annotations.data shape). Returns null if position is bad. */
export function buildAnnotationData(a: AnnotationInput): Record<string, unknown> | null {
	let position: unknown;
	try {
		position = JSON.parse(a.position);
	} catch {
		return null;
	}
	return {
		id: a.key,
		type: ANNOTATION_TYPES[a.type] ?? `type${a.type}`,
		color: a.color ?? undefined,
		sortIndex: a.sortIndex,
		position,
		text: a.text ?? undefined,
		comment: a.comment ?? undefined,
		tags: a.tags.map((t) => ({ name: t.tag })),
		pageLabel: a.pageLabel ?? undefined,
		dateModified: a.dateModified,
		authorName: a.authorName ?? undefined,
	};
}
