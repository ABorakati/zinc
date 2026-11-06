// Zotero Web API item JSON (items.data) -> CSL-JSON, following Zotero's own mapping (Zotero.Utilities.Item.itemToCSLJSON).
import type { ZoteroItemData } from "../api-types";
import raw from "../schema-data/schema.json" with { type: "json" };
import { noteToTitle } from "../zotero-db/mapping";

export type CslItem = Record<string, unknown> & { id: string; type: string };

// Zotero's own CSL name mapping (zotero-schema "csl.names"): creator type -> CSL name variable. The item type's
// primary creator type is the CSL "author" when it has no entry of its own.
const SCHEMA_NAMES = (raw.csl as { names: Record<string, string> }).names;
const PRIMARY_CREATOR = new Map<string, string>();
// itemType -> (field -> base field), so a value stored in a type-specific field (caseName, codePages, format ...)
// is found under the base field the CSL mapping is written in terms of
const BASE_FIELDS = new Map<string, [string, string][]>();
for (const t of raw.itemTypes as { itemType: string; fields: { field: string; baseField?: string }[]; creatorTypes: { creatorType: string; primary?: boolean }[] }[]) {
	const primary = t.creatorTypes.find((c) => c.primary)?.creatorType;
	if (primary) PRIMARY_CREATOR.set(t.itemType, primary);
	BASE_FIELDS.set(t.itemType, t.fields.filter((f) => f.baseField).map((f) => [f.field, f.baseField!]));
}

export const CSL_TYPE_MAP: Record<string, string> = {
	artwork: "graphic",
	attachment: "document",
	audioRecording: "song",
	bill: "bill",
	blogPost: "post-weblog",
	book: "book",
	bookSection: "chapter",
	case: "legal_case",
	computerProgram: "software",
	conferencePaper: "paper-conference",
	dataset: "dataset",
	dictionaryEntry: "entry-dictionary",
	document: "document",
	email: "personal_communication",
	encyclopediaArticle: "entry-encyclopedia",
	film: "motion_picture",
	forumPost: "post",
	hearing: "hearing",
	instantMessage: "personal_communication",
	interview: "interview",
	journalArticle: "article-journal",
	letter: "personal_communication",
	magazineArticle: "article-magazine",
	manuscript: "manuscript",
	map: "map",
	newspaperArticle: "article-newspaper",
	note: "document",
	patent: "patent",
	podcast: "broadcast",
	preprint: "article",
	presentation: "speech",
	radioBroadcast: "broadcast",
	report: "report",
	standard: "standard",
	statute: "legislation",
	thesis: "thesis",
	tvBroadcast: "broadcast",
	videoRecording: "motion_picture",
	webpage: "webpage",
};

// CSL text variable -> Zotero fields (first non-empty wins). Zotero base-field mappings are included explicitly
// (bookTitle -> publicationTitle etc.) because the Web API JSON uses the item-type-specific field names.
const TEXT_MAP: Record<string, string[]> = {
	"title": ["title"],
	"container-title": [
		"publicationTitle", "reporter", "code", "bookTitle", "proceedingsTitle", "encyclopediaTitle",
		"dictionaryTitle", "websiteTitle", "blogTitle", "forumTitle", "programTitle",
	],
	"collection-title": ["seriesTitle", "series"],
	"collection-number": ["seriesNumber"],
	"publisher": ["publisher", "distributor", "institution", "university", "studio", "label", "company", "repository"],
	"publisher-place": ["place"],
	"authority": ["authority", "court", "legislativeBody", "issuingAuthority"],
	"page": ["pages"],
	"volume": ["volume", "codeNumber", "codeVolume", "reporterVolume"],
	"issue": ["issue", "priorityNumbers"],
	"number-of-volumes": ["numberOfVolumes"],
	"number-of-pages": ["numPages"],
	"edition": ["edition"],
	"version": ["versionNumber"],
	"section": ["section", "committee"],
	"genre": ["type", "programmingLanguage", "reportType", "thesisType", "letterType", "manuscriptType", "mapType", "presentationType", "websiteType", "postType", "genre"],
	"medium": ["medium", "system", "interviewMedium", "artworkMedium", "audioFileType"],
	"archive": ["archive"],
	"archive_location": ["archiveLocation"],
	"event": ["meetingName", "conferenceName"],
	"event-title": ["conferenceName", "meetingName"],
	"original-publisher": ["originalPublisher"],
	"original-publisher-place": ["originalPlace"],
	"part-number": ["partNumber"],
	"part-title": ["partTitle"],
	"source": ["libraryCatalog"],
	"license": ["rights"],
	"citation-key": ["citationKey"],
	"PMID": ["PMID"],
	"PMCID": ["PMCID"],
	"abstract": ["abstractNote"],
	"URL": ["url"],
	"DOI": ["DOI"],
	"ISBN": ["ISBN"],
	"ISSN": ["ISSN"],
	"call-number": ["callNumber", "applicationNumber"],
	"note": ["extra"],
	"number": ["number", "patentNumber", "reportNumber", "billNumber", "docketNumber", "documentNumber", "publicLawNumber", "episodeNumber", "codeNumber", "archiveID", "identifier", "issueNumber"],
	"chapter-number": ["session"],
	"references": ["history", "references"],
	"title-short": ["shortTitle"],
	"container-title-short": ["journalAbbreviation"],
	"status": ["status", "legalStatus"],
	"language": ["language"],
	"dimensions": ["artworkSize", "runningTime"],
	"scale": ["scale"],
	"jurisdiction": ["jurisdiction"],
};

/** CSL name variable for a creator type (Zotero's schema mapping; the item type's primary creator type is the author). */
export function cslNameVariable(itemType: string, creatorType: string): string | undefined {
	return SCHEMA_NAMES[creatorType] ?? (PRIMARY_CREATOR.get(itemType) === creatorType ? "author" : undefined);
}

// Zotero field -> CSL date variable
const DATE_MAP: Record<string, string> = {
	date: "issued",
	dateDecided: "issued",
	dateEnacted: "issued",
	issueDate: "issued",
	accessDate: "accessed",
	filingDate: "submitted",
	originalDate: "original-date",
};

// Variables a "Name: value" line in the Extra field may set (Zotero.Utilities.Internal.extractExtraFields + CSL spec).
const EXTRA_TEXT_VARS = [
	"abstract", "annote", "archive", "archive_location", "archive-place", "authority", "call-number", "chapter-number",
	"citation-key", "citation-label", "collection-number", "collection-title", "container-title", "container-title-short",
	"dimensions", "division", "DOI", "event", "event-title", "event-place", "genre", "ISBN", "ISSN", "issue", "jurisdiction",
	"keyword", "language", "license", "locator", "medium", "names", "number", "number-of-pages", "number-of-volumes",
	"original-publisher", "original-publisher-place", "original-title", "page", "page-first", "PMCID", "PMID", "publisher",
	"publisher-place", "references", "reviewed-genre", "reviewed-title", "scale", "section", "source", "status", "title",
	"title-short", "URL", "version", "volume", "volume-title", "year-suffix",
];
const EXTRA_DATE_VARS = ["accessed", "available-date", "event-date", "issued", "original-date", "submitted"];
const EXTRA_NAME_VARS = [
	"author", "chair", "collection-editor", "compiler", "composer", "container-author", "contributor", "curator",
	"director", "editor", "editorial-director", "executive-producer", "guest", "host", "illustrator", "interviewer",
	"narrator", "organizer", "original-author", "performer", "producer", "recipient", "reviewed-author", "script-writer",
	"series-creator", "translator",
];
const EXTRA_ALIASES: Record<string, string> = {
	"original-container-title": "original-title", // not valid CSL; keep a sane target
	"pmid": "PMID", "pmcid": "PMCID", "doi": "DOI", "isbn": "ISBN", "issn": "ISSN", "url": "URL",
};

const canonVar = (k: string): string => k.trim().toLowerCase().replace(/[\s_]+/g, "-");
const VAR_LOOKUP = new Map<string, { name: string; kind: "text" | "date" | "name" | "type" }>();
for (const v of EXTRA_TEXT_VARS) VAR_LOOKUP.set(canonVar(v), { name: v, kind: "text" });
for (const v of EXTRA_DATE_VARS) VAR_LOOKUP.set(canonVar(v), { name: v, kind: "date" });
for (const v of EXTRA_NAME_VARS) VAR_LOOKUP.set(canonVar(v), { name: v, kind: "name" });
VAR_LOOKUP.set("type", { name: "type", kind: "type" });
VAR_LOOKUP.set("archive_location", { name: "archive_location", kind: "text" });
VAR_LOOKUP.set("archive-location", { name: "archive_location", kind: "text" });
VAR_LOOKUP.set("original-date", { name: "original-date", kind: "date" });

export const CSL_TYPES = new Set(Object.values(CSL_TYPE_MAP).concat([
	"article-journal", "article-magazine", "article-newspaper", "bill", "book", "broadcast", "chapter", "dataset", "entry",
	"entry-dictionary", "entry-encyclopedia", "figure", "graphic", "hearing", "interview", "legal_case", "legislation",
	"manuscript", "map", "motion_picture", "musical_score", "pamphlet", "paper-conference", "patent", "personal_communication",
	"post", "post-weblog", "report", "review", "review-book", "song", "speech", "standard", "thesis", "treaty", "webpage",
]));

// ---------------------------------------------------------------- dates

const MONTHS = [
	"january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
];

function monthNumber(s: string): number | null {
	const t = s.toLowerCase().replace(/\.$/, "");
	if (t.length < 3) return null;
	const i = MONTHS.findIndex((m) => m === t || (t.length === 3 && m.startsWith(t)) || (t === "sept" && m === "september"));
	return i >= 0 ? i + 1 : null;
}

/** Date parts of one date, or null when the string is not a recognisable single date. */
function parseSingleDate(s: string): number[] | null {
	const t = s.trim().replace(/,/g, " ").replace(/\s+/g, " ");
	let m: RegExpMatchArray | null;
	if ((m = t.match(/^(-?\d{1,4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/))) {
		const y = +m[1]!;
		if (m[2] && (+m[2] < 1 || +m[2] > 12)) return null;
		if (m[3] && (+m[3] < 1 || +m[3] > 31)) return null;
		return [y, ...(m[2] ? [+m[2]] : []), ...(m[3] ? [+m[3]] : [])];
	}
	// Zotero multipart "2020-00-00 2020" / "2020-05-04 May 4, 2020": use the ISO prefix
	if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2}) /))) {
		const y = +m[1]!, mo = +m[2]!, d = +m[3]!;
		return [y, ...(mo ? [mo] : []), ...(mo && d ? [d] : [])];
	}
	// "May 4 2020", "May 2020", "4 May 2020", "4th May 2020"
	if ((m = t.match(/^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)? (-?\d{1,4})$/))) {
		const mo = monthNumber(m[1]!);
		if (mo) return [+m[3]!, mo, +m[2]!];
	}
	if ((m = t.match(/^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]{3,9})\.? (-?\d{1,4})$/))) {
		const mo = monthNumber(m[2]!);
		if (mo) return [+m[3]!, mo, +m[1]!];
	}
	if ((m = t.match(/^([A-Za-z]{3,9})\.? (-?\d{1,4})$/))) {
		const mo = monthNumber(m[1]!);
		if (mo) return [+m[2]!, mo];
	}
	if ((m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) {
		// ambiguous d/m/y vs m/d/y: Zotero defaults to the US reading unless the first number cannot be a month
		const a = +m[1]!, b = +m[2]!;
		if (a > 12 && b <= 12) return [+m[3]!, b, a];
		if (a <= 12 && b <= 31) return [+m[3]!, a, b];
	}
	return null;
}

export function toCslDate(raw: string): Record<string, unknown> | null {
	const s = raw.trim();
	if (!s) return null;
	// Zotero's multipart storage "YYYY-MM-DD <original text>" is not what the Web API returns, but tolerate it.
	const multi = s.match(/^(\d{4})-(\d{2})-(\d{2}) (.+)$/);
	if (multi) {
		const single = parseSingleDate(s);
		if (single) return { "date-parts": [single] };
	}
	const single = parseSingleDate(s);
	if (single) return { "date-parts": [single] };
	// range "2019-2020", "May 3 - May 5, 2020", "2019/2020"
	const parts = s.split(/\s+[-–—]\s+|(?<=\d)[–—](?=\d)/);
	if (parts.length === 2) {
		const a = parseSingleDate(parts[0]!), b = parseSingleDate(parts[1]!);
		if (a && b) return { "date-parts": [a, b] };
	}
	const years = s.match(/^(\d{4})\s*[-/–—]\s*(\d{4})$/);
	if (years) return { "date-parts": [[+years[1]!], [+years[2]!]] };
	// "Spring 2020", "in press 2021": let citeproc's own raw-date parser extract what it can
	if (/\d{4}/.test(s)) return { raw: s };
	return { literal: s };
}

/** Access dates are UTC timestamps in the Web API; Zotero cites the local calendar day (Zotero.Date.sqlToDate(.., true)). */
function toCslAccessDate(v: string): Record<string, unknown> | null {
	const m = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(Z)?$/.exec(v);
	if (m) {
		const t = new Date(m[1] ? v : v.replace(" ", "T") + "Z"); // SQL datetimes are UTC too
		if (!Number.isNaN(t.getTime())) return { "date-parts": [[t.getFullYear(), t.getMonth() + 1, t.getDate()]] };
	}
	return toCslDate(v);
}

// ---------------------------------------------------------------- names

function toCslName(c: { firstName?: string; lastName?: string; name?: string }): Record<string, unknown> | null {
	if (c.name != null && c.name !== "") return { literal: c.name };
	const family = (c.lastName ?? "").trim();
	const given = (c.firstName ?? "").trim();
	if (!family && !given) return null;
	if (!given) return { family, given: "" };
	return { family, given };
}

function parseExtraName(v: string): Record<string, unknown> | null {
	const [a, b] = v.split("||").map((s) => s.trim());
	if (!a) return null;
	if (b === undefined) return { literal: a };
	return { family: a, given: b };
}

/** Pull "Variable: value" lines out of Extra. Returns the recognised variables and the lines that stay as a note. */
export function parseExtra(extra: string | undefined): {
	text: Record<string, string>;
	dates: Record<string, string>;
	names: Record<string, Record<string, unknown>[]>;
	type?: string;
	rest: string;
} {
	const text: Record<string, string> = {};
	const dates: Record<string, string> = {};
	const names: Record<string, Record<string, unknown>[]> = {};
	let type: string | undefined;
	const rest: string[] = [];
	if (!extra) return { text, dates, names, rest: "" };
	for (const line of extra.split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Za-z][A-Za-z _-]*?)\s*:\s*(.+?)\s*$/);
		if (m) {
			let key = canonVar(m[1]!);
			key = EXTRA_ALIASES[key] ? canonVar(EXTRA_ALIASES[key]!) : key;
			const spec = VAR_LOOKUP.get(key);
			if (spec) {
				const val = m[2]!;
				if (spec.kind === "text") {
					if (!(spec.name in text)) text[spec.name] = val;
				} else if (spec.kind === "date") {
					if (!(spec.name in dates)) dates[spec.name] = val;
				} else if (spec.kind === "name") {
					const n = parseExtraName(val);
					if (n) (names[spec.name] ??= []).push(n);
				} else if (spec.kind === "type" && CSL_TYPES.has(val)) {
					type = val;
				}
				continue;
			}
		}
		rest.push(line);
	}
	return { text, dates, names, type, rest: rest.join("\n").trim() };
}

// ---------------------------------------------------------------- main

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

// Item data with every type-specific field also reachable under its base field (caseName -> title, codePages -> pages,
// format -> medium ...), as Zotero.ItemFields.getFieldIDFromTypeAndBase does for itemToCSLJSON.
function withBaseFields(data: ZoteroItemData): Record<string, unknown> {
	const view: Record<string, unknown> = { ...data };
	for (const [field, base] of BASE_FIELDS.get(data.itemType) ?? []) {
		if (!str(view[base]).trim() && str(data[field]).trim()) view[base] = data[field];
	}
	return view;
}

// Types whose Place is the event's place, not the publisher's (Zotero hard-codes this until it has migrated the data to eventPlace)
const EVENT_PLACE_TYPES = new Set(["audioRecording", "presentation", "videoRecording"]);
const ISBN_FIRST = /^(?:97[89]-?)?(?:\d-?){9}[\dx](?!-)\b/i;

export function itemToCsl(data: ZoteroItemData): CslItem {
	const extra = parseExtra(str(data.extra));
	const out: CslItem = { id: data.key, type: extra.type ?? CSL_TYPE_MAP[data.itemType] ?? "document" };
	const view = withBaseFields(data);
	for (const [cslVar, fields] of Object.entries(TEXT_MAP)) {
		for (const f of fields) {
			let v = str(view[f]).trim();
			if (v) {
				if (f === "ISBN") v = ISBN_FIRST.exec(v)?.[0] ?? v; // CSL-JSON carries one ISBN
				if (v.length > 1 && v.startsWith('"') && v.indexOf('"', 1) === v.length - 1) v = v.slice(1, -1); // quotes protect case/parsing in Zotero
				out[cslVar] = v;
				break;
			}
		}
	}
	// Extra no longer counts as the note once variables were taken from it
	if (extra.rest) out.note = extra.rest;
	else delete out.note;

	// Presentation/conference: Zotero puts meetingName in "event"; the CSL "event-title" duplicate is only for conferences
	if (data.itemType !== "conferencePaper" && data.itemType !== "presentation") delete out["event-title"];
	if (data.itemType !== "conferencePaper" && data.itemType !== "presentation" && out.event === undefined) delete out.event;
	// Place: the publisher's place, except for event-like types (event-place only). eventPlace, when set, is the event-place.
	const place = str(data.place).trim();
	const eventPlace = str(data.eventPlace).trim();
	if (EVENT_PLACE_TYPES.has(data.itemType)) {
		delete out["publisher-place"];
		if (place) out["event-place"] = place;
	} else if (eventPlace) out["event-place"] = eventPlace;
	else if (data.itemType === "conferencePaper" && place) out["event-place"] = place;
	// Names (a note or attachment has no creators)
	if (data.itemType !== "note" && data.itemType !== "attachment") {
		for (const c of data.creators ?? []) {
			const cslVar = cslNameVariable(data.itemType, c.creatorType);
			if (!cslVar) continue;
			const n = toCslName(c);
			if (!n) continue;
			const list = (out[cslVar] ??= []) as Record<string, unknown>[];
			list.push(n);
		}
	}
	// Dates (the first mapped field with a value wins per CSL variable)
	for (const [field, cslVar] of Object.entries(DATE_MAP)) {
		if (out[cslVar] !== undefined) continue;
		const v = str(view[field]).trim();
		if (!v) continue;
		const d = field === "accessDate" ? toCslAccessDate(v) : toCslDate(v);
		if (d) out[cslVar] = d;
	}
	// Extra variables override / add
	for (const [k, v] of Object.entries(extra.text)) {
		if (k === "note") continue;
		if (k === "title" && out.title) continue; // never replace a real title by an Extra line
		out[k] = v;
	}
	for (const [k, v] of Object.entries(extra.dates)) {
		const d = toCslDate(v);
		if (d) out[k] = d;
	}
	for (const [k, v] of Object.entries(extra.names)) out[k] = v;
	if (out["archive-place"] && !out.archive_location) delete out["archive-place"];
	// A standalone note is cited by its pseudo-title
	if (data.itemType === "note" && str(data.note)) out.title = noteToTitle(str(data.note));
	return out;
}
