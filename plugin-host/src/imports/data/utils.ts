// Pure helpers behind `data-utils` (library.wit) and the summaries the library handlers build. No I/O.

// ------------------------------------------------------------------------------------------------ dates
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export interface DateParts {
	year: number | undefined;
	month: number | undefined; // 0-11
	day: number | undefined;
	part: string | undefined;
	order: string;
}

const monthIndex = (s: string): number => {
	const t = s.toLowerCase().replace(/\.$/, "");
	if (t.length < 3) return -1;
	return MONTHS.findIndex((m) => m === t || m.startsWith(t.slice(0, 3)) && (m.startsWith(t) || t.length === 3));
};

/** Zotero.Date.strToDate (the common forms). Numeric "a/b/yyyy" is read month-first, as Zotero does in an en-US locale. */
export function parseDate(text: string): DateParts {
	const out: DateParts = { year: undefined, month: undefined, day: undefined, part: undefined, order: "" };
	let s = (text ?? "").trim();
	if (!s) return out;
	// Zotero's multipart form: "2024-03-07 March 7, 2024": the ISO part first
	const multi = /^(\d{4}-\d{2}(?:-\d{2})?)\s+(\S.*)$/.exec(s);
	if (multi) s = multi[1];
	let m = /^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?:[T ].*)?$/.exec(s);
	if (m) {
		out.year = +m[1];
		out.month = +m[2] - 1;
		out.order = "ym";
		if (m[3]) {
			out.day = +m[3];
			out.order = "ymd";
		}
		return out;
	}
	m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
	if (m) {
		out.year = +m[3];
		let a = +m[1];
		let b = +m[2];
		if (a > 12 && b <= 12) [a, b] = [b, a]; // "25/12/2020" can only be day first
		out.month = a - 1;
		out.day = b;
		out.order = "md" + "y";
		return out;
	}
	m = /^(\d{1,2})[-/.](\d{4})$/.exec(s);
	if (m) {
		out.month = +m[1] - 1;
		out.year = +m[2];
		out.order = "my";
		return out;
	}
	m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
	if (m && monthIndex(m[1]) >= 0) {
		out.month = monthIndex(m[1]);
		out.day = +m[2];
		out.year = +m[3];
		out.order = "mdy";
		return out;
	}
	m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s);
	if (m && monthIndex(m[2]) >= 0) {
		out.day = +m[1];
		out.month = monthIndex(m[2]);
		out.year = +m[3];
		out.order = "dmy";
		return out;
	}
	m = /^([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s);
	if (m && monthIndex(m[1]) >= 0) {
		out.month = monthIndex(m[1]);
		out.year = +m[2];
		out.order = "my";
		return out;
	}
	m = /^(\d{4})$/.exec(s);
	if (m) {
		out.year = +m[1];
		out.order = "y";
		return out;
	}
	const y = /\b(\d{4})\b/.exec(s);
	if (y) {
		out.year = +y[1];
		out.order = "y";
		out.part = s.replace(y[1], "").trim() || undefined;
		return out;
	}
	out.part = s;
	return out;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Zotero.Date.strToISO. */
export function toIsoDate(text: string): string | undefined {
	const p = parseDate(text);
	if (p.year === undefined || p.part !== undefined) return undefined;
	if (p.month === undefined || p.month < 0 || p.month > 11) return p.month === undefined ? pad(p.year, 4) : undefined;
	if (p.day === undefined) return `${pad(p.year, 4)}-${pad(p.month + 1)}`;
	if (p.day < 1 || p.day > 31) return undefined;
	return `${pad(p.year, 4)}-${pad(p.month + 1)}-${pad(p.day)}`;
}

/** The part of a multipart date that shows to the user ("2024-03-07 March 7, 2024" -> "March 7, 2024"). */
export function displayDate(text: string): string {
	const s = (text ?? "").trim();
	const m = /^\d{4}-\d{2}(?:-\d{2})?\s+(\S.*)$/.exec(s);
	return m ? m[1] : s;
}

// --------------------------------------------------------------------------------------------- notes, titles
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function htmlText(html: string): string {
	return html
		.replace(/<(br|\/p|\/div|\/h[1-6]|\/li)\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&(#?\w+);/g, (m, e: string) => {
			if (ENTITIES[e] !== undefined) return ENTITIES[e];
			const n = /^#x([0-9a-f]+)$/i.exec(e) ?? /^#(\d+)$/.exec(e);
			if (n) {
				const c = e[1] === "x" || e[1] === "X" ? parseInt(n[1], 16) : +n[1];
				try {
					return String.fromCodePoint(c);
				} catch {
					return m;
				}
			}
			return m;
		});
}

/** Zotero.Utilities.Item.noteToTitle: the first non-empty line, at most 120 characters. */
export function noteToTitle(html: string): string {
	const t = htmlText(html ?? "")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	return (t ?? "").slice(0, 120);
}

type Json = Record<string, any>;

/** Item.getDisplayTitle: notes show their first line, empty titles "(untitled)" is left to the UI: here the empty string stays empty unless a case name applies. */
export function displayTitle(item: Json): string {
	if (item.itemType === "note") return noteToTitle(String(item.note ?? ""));
	let title = String(item.title ?? "");
	if (!title && item.itemType === "case") title = String(item.caseName ?? "");
	if (!title && item.itemType === "email") title = String(item.subject ?? "");
	if (!title && item.itemType === "statute") title = String(item.nameOfAct ?? "");
	if (!title && item.itemType === "attachment") title = String(item.filename ?? "");
	return title;
}

const creatorName = (c: Json): string => (c.name ? String(c.name) : String(c.lastName ?? c.firstName ?? ""));

/** "Smith", "Smith and Jones", "Smith et al." (first creator type of the item: author, else editor, else any). */
export function firstCreator(item: Json): string {
	const all: Json[] = Array.isArray(item.creators) ? item.creators : [];
	const pick = (t: string) => all.filter((c) => c.creatorType === t);
	let list = pick("author");
	if (!list.length) list = pick("editor");
	if (!list.length) list = pick("contributor");
	if (!list.length) list = all;
	const names = list.map(creatorName).filter(Boolean);
	if (names.length === 0) return "";
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names[0]} et al.`;
}

const ARTICLES = /^(the|a|an|der|die|das|le|la|les|el|los|las|il|l'|un|une|ein|eine)\s+/i;
export function sortTitle(title: string): string {
	return (title ?? "")
		.replace(/^[\s"'“‘\[(]+/, "")
		.replace(ARTICLES, "")
		.trim();
}

// ------------------------------------------------------------------------------------------------- extra
export function parseExtra(extra: string): { fields: { name: string; value: string }[]; rest: string } {
	const fields: { name: string; value: string }[] = [];
	const rest: string[] = [];
	let inHead = true;
	for (const line of (extra ?? "").split(/\r?\n/)) {
		const m = inHead ? /^\s*([A-Za-z][A-Za-z0-9 ._-]{0,40}?)\s*:\s*(.+?)\s*$/.exec(line) : null;
		if (m) fields.push({ name: m[1], value: m[2] });
		else {
			inHead = false;
			rest.push(line);
		}
	}
	return { fields, rest: rest.join("\n").trim() };
}

// ------------------------------------------------------------------------------------------- identifiers
export function extractIdentifiers(text: string): { kind: string; value: string }[] {
	const out: { kind: string; value: string }[] = [];
	const seen = new Set<string>();
	const add = (kind: string, value: string) => {
		const k = `${kind}:${value}`;
		if (!seen.has(k)) {
			seen.add(k);
			out.push({ kind, value });
		}
	};
	const s = text ?? "";
	for (const m of s.matchAll(/\b(10\.\d{4,9}\/[^\s"<>]+[^\s"<>.,;:)\]])/g)) add("doi", m[1]);
	for (const m of s.matchAll(/(?:arxiv:?\s*|arxiv\.org\/abs\/)(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)/gi)) add("arxiv", m[1]);
	for (const m of s.matchAll(/\b(PMC\d{4,10})\b/g)) add("pmcid", m[1]);
	for (const m of s.matchAll(/\bpmid:?\s*(\d{4,9})\b/gi)) add("pmid", m[1]);
	for (const m of s.matchAll(/\b(?:97[89][- ]?)?(?:\d[- ]?){9}[\dXx]\b/g)) {
		const digits = m[0].replace(/[- ]/g, "");
		if (isbnOk(digits)) add("isbn", digits.toUpperCase());
	}
	for (const m of s.matchAll(/\b(\d{4}-\d{3}[\dXx])\b/g)) if (issnOk(m[1])) add("issn", m[1].toUpperCase());
	return out;
}

function isbnOk(d: string): boolean {
	if (d.length === 10) {
		let sum = 0;
		for (let i = 0; i < 10; i++) {
			const c = d[i].toUpperCase();
			const v = c === "X" ? 10 : +c;
			if (Number.isNaN(v) || (c === "X" && i !== 9)) return false;
			sum += v * (10 - i);
		}
		return sum % 11 === 0;
	}
	if (d.length === 13 && /^\d{13}$/.test(d)) {
		let sum = 0;
		for (let i = 0; i < 13; i++) sum += +d[i] * (i % 2 ? 3 : 1);
		return sum % 10 === 0;
	}
	return false;
}

function issnOk(s: string): boolean {
	const d = s.replace("-", "").toUpperCase();
	let sum = 0;
	for (let i = 0; i < 7; i++) sum += +d[i] * (8 - i);
	const check = (11 - (sum % 11)) % 11;
	return d[7] === (check === 10 ? "X" : String(check));
}

// ------------------------------------------------------------------------------------------------- CSL
const TYPE_TO_CSL: Record<string, string> = {
	journalArticle: "article-journal",
	magazineArticle: "article-magazine",
	newspaperArticle: "article-newspaper",
	book: "book",
	bookSection: "chapter",
	conferencePaper: "paper-conference",
	thesis: "thesis",
	report: "report",
	webpage: "webpage",
	blogPost: "post-weblog",
	forumPost: "post",
	patent: "patent",
	dataset: "dataset",
	preprint: "article",
	manuscript: "manuscript",
	letter: "personal_communication",
	email: "personal_communication",
	interview: "interview",
	presentation: "speech",
	film: "motion_picture",
	videoRecording: "video",
	audioRecording: "song",
	podcast: "song",
	map: "map",
	artwork: "graphic",
	statute: "legislation",
	bill: "bill",
	case: "legal_case",
	software: "software",
	document: "document",
	standard: "standard",
	encyclopediaArticle: "entry-encyclopedia",
	dictionaryEntry: "entry-dictionary",
};
const CSL_TO_TYPE = Object.fromEntries(Object.entries(TYPE_TO_CSL).reverse().map(([k, v]) => [v, k]));
CSL_TO_TYPE["article-journal"] = "journalArticle";

// Zotero field -> CSL variable (common ones; container title depends on the type)
const FIELD_TO_CSL: Record<string, string> = {
	abstractNote: "abstract",
	volume: "volume",
	issue: "issue",
	pages: "page",
	edition: "edition",
	publisher: "publisher",
	place: "publisher-place",
	DOI: "DOI",
	ISBN: "ISBN",
	ISSN: "ISSN",
	url: "URL",
	language: "language",
	series: "collection-title",
	seriesNumber: "collection-number",
	numberOfVolumes: "number-of-volumes",
	numPages: "number-of-pages",
	archive: "archive",
	archiveLocation: "archive_location",
	callNumber: "call-number",
	shortTitle: "title-short",
	medium: "medium",
	genre: "genre",
	section: "section",
	number: "number",
	institution: "publisher",
	university: "publisher",
	company: "publisher",
	extra: "note",
	rights: "license",
	version: "version",
};
const CONTAINER = ["publicationTitle", "bookTitle", "websiteTitle", "blogTitle", "forumTitle", "proceedingsTitle", "encyclopediaTitle", "dictionaryTitle", "programTitle"];
const CSL_ROLE: Record<string, string> = { author: "author", editor: "editor", translator: "translator", seriesEditor: "collection-editor", director: "director", interviewer: "interviewer", recipient: "recipient", contributor: "contributor", reviewedAuthor: "reviewed-author", bookAuthor: "container-author" };
const ROLE_TO_TYPE = Object.fromEntries(Object.entries(CSL_ROLE).map(([k, v]) => [v, k]));

function cslDate(s: string): { "date-parts": number[][] } | { literal: string } | undefined {
	const p = parseDate(s);
	if (p.year === undefined) return s ? { literal: s } : undefined;
	const parts = [p.year];
	if (p.month !== undefined) parts.push(p.month + 1);
	if (p.month !== undefined && p.day !== undefined) parts.push(p.day);
	return { "date-parts": [parts] };
}

/** Zotero.Utilities.Item.itemToCSLJSON (the fields almost every style uses). */
export function itemToCsl(item: Json): Json {
	const csl: Json = { id: item.key, type: TYPE_TO_CSL[item.itemType] ?? "document" };
	if (item.title) csl.title = item.title;
	for (const [f, v] of Object.entries(FIELD_TO_CSL)) if (item[f] !== undefined && item[f] !== "" && csl[v] === undefined) csl[v] = item[f];
	for (const f of CONTAINER) if (item[f]) {
		csl["container-title"] = item[f];
		break;
	}
	if (item.journalAbbreviation) csl["container-title-short"] = item.journalAbbreviation;
	for (const [f, v] of [["date", "issued"], ["accessDate", "accessed"], ["originalDate", "original-date"]] as const) if (item[f]) {
		const d = cslDate(String(item[f]));
		if (d) csl[v] = d;
	}
	for (const c of Array.isArray(item.creators) ? item.creators : []) {
		const role = CSL_ROLE[c.creatorType] ?? "contributor";
		const n = c.name !== undefined ? { literal: c.name } : { family: c.lastName ?? "", given: c.firstName ?? "" };
		(csl[role] ??= []).push(n);
	}
	return csl;
}

/** Zotero.Utilities.Item.itemFromCSLJSON (the reverse of the above, no key). */
export function itemFromCsl(csl: Json): Json {
	const itemType = CSL_TO_TYPE[csl.type] ?? "document";
	const item: Json = { itemType };
	if (csl.title) item.title = csl.title;
	for (const [f, v] of Object.entries(FIELD_TO_CSL)) if (csl[v] !== undefined && f !== "institution" && f !== "university" && f !== "company" && item[f] === undefined) item[f] = String(csl[v]);
	if (csl["container-title"]) {
		const f = itemType === "bookSection" ? "bookTitle" : itemType === "webpage" ? "websiteTitle" : itemType === "conferencePaper" ? "proceedingsTitle" : "publicationTitle";
		item[f] = csl["container-title"];
	}
	if (csl["container-title-short"]) item.journalAbbreviation = csl["container-title-short"];
	for (const [v, f] of [["issued", "date"], ["accessed", "accessDate"]] as const) {
		const d = csl[v];
		if (d?.["date-parts"]?.[0]) {
			const [y, mo, da] = d["date-parts"][0] as number[];
			item[f] = [y, mo ? pad(mo) : undefined, da ? pad(da) : undefined].filter((x) => x !== undefined).join("-");
		} else if (d?.literal) item[f] = d.literal;
	}
	const creators: Json[] = [];
	for (const [role, type] of Object.entries(ROLE_TO_TYPE)) for (const n of Array.isArray(csl[role]) ? csl[role] : []) {
		creators.push(n.literal || (!n.family && !n.given && n.name) ? { creatorType: type, name: n.literal ?? n.name } : { creatorType: type, firstName: n.given ?? "", lastName: n.family ?? "" });
	}
	if (creators.length) item.creators = creators;
	return item;
}

// ---------------------------------------------------------------------------------------- item summaries
const PUB_FIELDS = ["publicationTitle", "bookTitle", "websiteTitle", "blogTitle", "forumTitle", "proceedingsTitle", "encyclopediaTitle", "dictionaryTitle", "programTitle", "publisher"];

export const yearOf = (date: unknown): number | undefined => {
	const m = /(\d{4})/.exec(String(date ?? ""));
	return m ? +m[1] : undefined;
};
export const publicationOf = (item: Json): string | undefined => PUB_FIELDS.map((f) => item[f]).find((v) => typeof v === "string" && v) as string | undefined;
