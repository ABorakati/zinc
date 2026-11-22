// BibTeX / BibLaTeX: parse -> Zotero items, and Zotero items -> BibTeX / BibLaTeX.
import type { Creator, ZoteroItemData } from "../api-types";
import { parseYear } from "../db";
import { toCslDate } from "../cite/csl";
import {
	appendExtra,
	creatorFamilyGiven,
	creatorLast,
	creatorTypeFor,
	dateParts,
	getBase,
	hasField,
	isSingleField,
	normDoi,
	normalizeDate,
	monthNum,
	parseName,
	setBase,
	setFirst,
	splitKeywords,
	textToNoteHtml,
	type ParsedItem,
} from "./common";
import { fromLatex, toLatex } from "./latex";

// ================================================================ parsing

export interface BibRecord {
	type: string; // lower-case entry type
	key: string;
	fields: Record<string, string>; // lower-case field name -> raw (LaTeX) value
}

const MONTH_MACROS: Record<string, string> = {
	jan: "January",
	feb: "February",
	mar: "March",
	apr: "April",
	may: "May",
	jun: "June",
	jul: "July",
	aug: "August",
	sep: "September",
	oct: "October",
	nov: "November",
	dec: "December",
};

/** Tokenise BibTeX text into raw records. Malformed entries are skipped and reported in errors. */
export function parseBibRecords(text: string): { records: BibRecord[]; errors: string[] } {
	const records: BibRecord[] = [];
	const errors: string[] = [];
	const macros = new Map<string, string>(Object.entries(MONTH_MACROS));
	const n = text.length;
	let i = 0;

	const skipWs = () => {
		while (i < n && /\s/.test(text[i]!)) i++;
	};
	const closer = (open: string) => (open === "(" ? ")" : "}");

	// balanced {...} starting at the opening brace; returns the inner text
	const readBraced = (): string => {
		let depth = 0;
		const start = i + 1;
		for (; i < n; i++) {
			const c = text[i]!;
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === "{") depth++;
			else if (c === "}") {
				depth--;
				if (depth === 0) {
					const out = text.slice(start, i);
					i++;
					return out;
				}
			}
		}
		throw new Error("unbalanced braces");
	};
	const readQuoted = (): string => {
		let depth = 0;
		const start = i + 1;
		for (i = i + 1; i < n; i++) {
			const c = text[i]!;
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === "{") depth++;
			else if (c === "}") depth--;
			else if (c === '"' && depth === 0) {
				const out = text.slice(start, i);
				i++;
				return out;
			}
		}
		throw new Error("unterminated string");
	};
	const readValue = (end: string): string => {
		let out = "";
		for (;;) {
			skipWs();
			const c = text[i];
			if (c === undefined) throw new Error("unexpected end of input");
			if (c === "{") out += readBraced();
			else if (c === '"') out += readQuoted();
			else {
				const m = /^[^\s,#{}()"=]+/.exec(text.slice(i, i + 200));
				if (!m) throw new Error(`unexpected "${c}"`);
				i += m[0].length;
				out += macros.get(m[0].toLowerCase()) ?? m[0];
			}
			skipWs();
			if (text[i] === "#") {
				i++;
				continue;
			}
			if (text[i] === "," || text[i] === end) return out;
			throw new Error(`unexpected "${text[i] ?? "end"}" after value`);
		}
	};

	while (i < n) {
		const at = text.indexOf("@", i);
		if (at < 0) break;
		i = at + 1;
		const m = /^\s*([A-Za-z]+)\s*/.exec(text.slice(i, i + 64));
		if (!m) continue;
		const type = m[1]!.toLowerCase();
		i += m[0].length;
		const open = text[i];
		if (open !== "{" && open !== "(") continue;
		const end = closer(open);
		try {
			if (type === "comment") {
				if (open === "{") readBraced();
				continue;
			}
			if (type === "preamble") {
				if (open === "{") readBraced();
				continue;
			}
			i++;
			if (type === "string") {
				skipWs();
				const nm = /^[^\s=]+/.exec(text.slice(i, i + 100));
				if (!nm) throw new Error("bad @string");
				i += nm[0].length;
				skipWs();
				if (text[i] !== "=") throw new Error("bad @string");
				i++;
				macros.set(nm[0].toLowerCase(), readValue(end));
				skipWs();
				if (text[i] === end) i++;
				continue;
			}
			// entry: key up to the first comma
			skipWs();
			const km = /^[^,\s{}()"=]*/.exec(text.slice(i, i + 300))!;
			const key = km[0];
			i += key.length;
			skipWs();
			if (text[i] === ",") i++;
			const fields: Record<string, string> = {};
			for (;;) {
				skipWs();
				while (text[i] === ",") {
					i++;
					skipWs();
				}
				if (i >= n) throw new Error(`entry ${key || "(no key)"} is not closed`);
				if (text[i] === end) {
					i++;
					break;
				}
				const fm = /^[^\s=,{}()"]+/.exec(text.slice(i, i + 100));
				if (!fm) throw new Error(`bad field in ${key}`);
				i += fm[0].length;
				skipWs();
				if (text[i] !== "=") throw new Error(`missing "=" after ${fm[0]} in ${key}`);
				i++;
				const v = readValue(end);
				const name = fm[0].toLowerCase();
				if (!(name in fields)) fields[name] = v;
				skipWs();
				if (text[i] === ",") i++;
			}
			records.push({ type, key, fields });
		} catch (e) {
			errors.push(`${e instanceof Error ? e.message : e} (near character ${i})`);
			// resync at the next entry start
			const nx = text.slice(at + 1).search(/\n\s*@[A-Za-z]+\s*[{(]/);
			if (nx < 0) break;
			i = at + 1 + nx;
		}
	}
	return { records, errors };
}

/** Split on " and " at brace depth 0. */
function splitAnd(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const c = s[i]!;
		if (c === "{") depth++;
		else if (c === "}") depth--;
		if (depth === 0 && /\s/.test(c)) {
			const m = /^\s+and\s+/i.exec(s.slice(i));
			if (m) {
				out.push(cur);
				cur = "";
				i += m[0].length - 1;
				continue;
			}
		}
		cur += c;
	}
	out.push(cur);
	return out.map((x) => x.trim()).filter(Boolean);
}

function topLevelCommaSplit(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = "";
	for (const c of s) {
		if (c === "{") depth++;
		else if (c === "}") depth--;
		if (c === "," && depth === 0) {
			out.push(cur);
			cur = "";
		} else cur += c;
	}
	out.push(cur);
	return out;
}

/** True when the first `{` of `s` is closed by its last `}`: "{Univ {x} Z}" is one group, "{Smith}, {John}" is two. */
function isOneBracedGroup(s: string): boolean {
	if (!s.startsWith("{") || !s.endsWith("}")) return false;
	let depth = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "\\") i++;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return i === s.length - 1;
	}
	return false;
}

function bibNames(raw: string, creatorType: string): Creator[] {
	const out: Creator[] = [];
	for (const name of splitAnd(raw)) {
		const t = name.trim();
		if (isOneBracedGroup(t)) {
			const lit = fromLatex(t.slice(1, -1));
			if (lit) out.push({ creatorType, name: lit });
			continue;
		}
		// decode only after splitting so "{Last}, First" and commas inside braces survive
		const parts = topLevelCommaSplit(t).map((p) => fromLatex(p));
		const c = parseName(parts.join(", "), creatorType);
		if (c) out.push(c);
	}
	return out;
}

const TYPE_MAP: Record<string, string> = {
	article: "journalArticle",
	book: "book",
	booklet: "book",
	inbook: "bookSection",
	incollection: "bookSection",
	inproceedings: "conferencePaper",
	conference: "conferencePaper",
	proceedings: "book",
	mvproceedings: "book",
	phdthesis: "thesis",
	mastersthesis: "thesis",
	thesis: "thesis",
	techreport: "report",
	report: "report",
	manual: "report",
	misc: "document",
	online: "webpage",
	electronic: "webpage",
	www: "webpage",
	unpublished: "manuscript",
	patent: "patent",
	software: "computerProgram",
	dataset: "dataset",
	periodical: "magazineArticle",
	suppperiodical: "journalArticle",
	collection: "book",
	mvbook: "book",
	mvcollection: "book",
	bookinbook: "bookSection",
	suppbook: "bookSection",
	suppcollection: "bookSection",
	review: "journalArticle",
	standard: "standard",
	set: "document",
};

function clean(raw: string | undefined): string {
	return raw === undefined ? "" : fromLatex(raw);
}

function bibDate(f: Record<string, string>): string {
	if (f.date) return normalizeDate(clean(f.date));
	const year = clean(f.year);
	if (!year) return "";
	const mo = f.month ? monthNum(clean(f.month)) : null;
	const day = f.day && /^\d{1,2}$/.test(f.day.trim()) ? +f.day : null;
	if (mo && /^\d{4}$/.test(year)) return normalizeDate(`${year}-${mo}${day ? `-${day}` : ""}`);
	return year;
}

export function bibRecordToItem(r: BibRecord): ParsedItem | null {
	const f = r.fields;
	let itemType = TYPE_MAP[r.type] ?? "document";
	if (itemType === "document") {
		const ap = clean(f.archiveprefix ?? f.eprinttype).toLowerCase();
		if (f.eprint && (ap === "arxiv" || ap === "")) itemType = "preprint";
		else if (f.url || f.howpublished?.match(/https?:\/\//)) itemType = "webpage";
		else if (r.type === "misc" && f.journal) itemType = "journalArticle";
	}
	if (r.type === "inbook" && !f.booktitle) itemType = "bookSection";
	const data: Partial<ZoteroItemData> & { itemType: string } = { itemType };
	const notes: string[] = [];

	setBase(data, "title", [clean(f.title), clean(f.subtitle)].filter(Boolean).join(": "));
	const howPublished = f.howpublished && !/https?:\/\/|\\url/.test(f.howpublished) && itemType === "webpage" ? f.howpublished : "";
	const container = clean(f.journaltitle ?? f.journal ?? f.booktitle ?? f.maintitle ?? howPublished);
	if (itemType === "journalArticle" || itemType === "magazineArticle" || itemType === "newspaperArticle") {
		setBase(data, "publicationTitle", clean(f.journaltitle ?? f.journal ?? f.booktitle));
	} else {
		setBase(data, "publicationTitle", container);
	}
	if (itemType === "conferencePaper" && !data.proceedingsTitle) setBase(data, "publicationTitle", container);
	setBase(data, "journalAbbreviation", clean(f.shortjournal));
	if (f.eventtitle) setBase(data, "conferenceName", clean(f.eventtitle));
	if (!(data.title as string) && (container || f.series)) setBase(data, "title", container || clean(f.series));

	// publisher-like
	const publisher = clean(f.publisher ?? f.school ?? f.institution ?? f.organization);
	setBase(data, "publisher", publisher);
	setBase(data, "place", clean(f.address ?? f.location ?? f.venue));
	const date = bibDate(f);
	if (date) setBase(data, "date", date);
	setBase(data, "volume", clean(f.volume));
	setFirst(data, ["issue", "reportNumber", "patentNumber", "seriesNumber", "number"], clean(f.number ?? f.issue));
	setFirst(data, ["pages"], clean(f.pages));
	if (f.pagetotal) setBase(data, "numPages", clean(f.pagetotal));
	setBase(data, "edition", clean(f.edition));
	setFirst(data, ["seriesTitle", "series"], clean(f.series));
	setBase(data, "ISBN", clean(f.isbn));
	setBase(data, "ISSN", clean(f.issn));
	setBase(data, "abstractNote", clean(f.abstract));
	setBase(data, "language", clean(f.language ?? f.langid));
	setBase(data, "accessDate", normalizeDate(clean(f.urldate)));
	setBase(data, "shortTitle", clean(f.shorttitle));
	const doi = clean(f.doi).replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "");
	if (!setBase(data, "DOI", doi) && doi) appendExtra(data, `DOI: ${doi}`);
	// a "~" in a URL is a tilde, not LaTeX's non-breaking space
	const urlText = (v: string | undefined) => clean(v?.replace(/~/g, String.raw`\textasciitilde{}`));
	let url = urlText(f.url);
	if (!url && f.howpublished) {
		const m = /https?:\/\/\S+/.exec(urlText(f.howpublished));
		if (m) url = m[0].replace(/[}\s]+$/, "");
	}
	if (!url && doi === "" && f.eprint && itemType === "preprint") url = `https://arxiv.org/abs/${clean(f.eprint)}`;
	setBase(data, "url", url);
	if (itemType === "thesis") {
		const t = clean(f.type);
		const tt =
			r.type === "phdthesis"
				? "PhD thesis"
				: r.type === "mastersthesis"
					? "Master's thesis"
					: /^phd/i.test(t)
						? "PhD thesis"
						: /^(ma|master|mathesis)/i.test(t)
							? "Master's thesis"
							: t;
		setBase(data, "type", tt);
	} else if (f.type) setFirst(data, ["type"], clean(f.type));
	if (itemType === "preprint") {
		setBase(data, "publisher", /arxiv/i.test(clean(f.archiveprefix ?? f.eprinttype)) || !publisher ? "arXiv" : publisher, true);
		setBase(data, "number", clean(f.eprint));
	} else if (f.eprint) appendExtra(data, `${clean(f.archiveprefix ?? f.eprinttype) || "eprint"}: ${clean(f.eprint)}`);
	if (f.pmid) setBase(data, "PMID", clean(f.pmid)) || appendExtra(data, `PMID: ${clean(f.pmid)}`);
	if (f.pmcid) setBase(data, "PMCID", clean(f.pmcid)) || appendExtra(data, `PMCID: ${clean(f.pmcid)}`);
	if (r.key && !setBase(data, "citationKey", r.key)) appendExtra(data, `Citation Key: ${r.key}`);
	if (f.note) {
		const note = clean(f.note);
		if (hasField(itemType, "extra")) appendExtra(data, note);
		else notes.push(textToNoteHtml(note));
	}
	if (f.annote || f.annotation) notes.push(textToNoteHtml(clean(f.annote ?? f.annotation)));

	// creators
	const creators: Creator[] = [];
	const add = (raw: string | undefined, wanted: string, ...fb: string[]) => {
		if (!raw) return;
		const ct = creatorTypeFor(itemType, wanted, ...fb);
		creators.push(...bibNames(raw, ct));
	};
	add(f.author, "author");
	add(f.editor, "editor", "contributor");
	add(f.translator, "translator", "contributor");
	add(f.bookauthor, "bookAuthor", "contributor");
	if (creators.length) data.creators = creators;
	if (f.keywords || f.keyword) data.tags = splitKeywords(clean(f.keywords ?? f.keyword)).map((tag) => ({ tag }));

	if (!data.title && !creators.length && !date) return null;
	return { data, notes };
}

export function parseBibtex(text: string): { items: ParsedItem[]; errors: string[] } {
	const { records, errors } = parseBibRecords(text);
	const items: ParsedItem[] = [];
	for (const r of records) {
		try {
			const it = bibRecordToItem(r);
			if (it) items.push(it);
			else errors.push(`entry ${r.key || "(no key)"} has no title, author or date`);
		} catch (e) {
			errors.push(`entry ${r.key}: ${e instanceof Error ? e.message : e}`);
		}
	}
	return { items, errors };
}

// ================================================================ writing

export type BibFlavor = "bibtex" | "biblatex";

const STOP_WORDS = new Set([
	"a",
	"an",
	"the",
	"on",
	"of",
	"in",
	"for",
	"and",
	"or",
	"to",
	"with",
	"from",
	"by",
	"at",
	"is",
	"are",
	"as",
	"its",
	"into",
	"using",
	"towards",
	"toward",
	"via",
	"their",
	"this",
	"that",
	"do",
	"does",
	"how",
	"what",
	"why",
]);

const ascii = (s: string) =>
	s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[øØ]/g, "o").replace(/[łŁ]/g, "l").replace(/ß/g, "ss").replace(/[æÆ]/g, "ae");

export function citationKeyFor(data: ZoteroItemData): string {
	const creators = data.creators ?? [];
	const c = creators.find((x) => x.creatorType === "author") ?? creators.find((x) => x.creatorType === "editor") ?? creators[0];
	let author = c ? creatorLast(c) : "";
	if (c && isSingleField(c)) author = author.split(/\s+/)[0] ?? author; // "World Health Organization" -> world
	author = ascii(author)
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
	const year = parseYear(data.date) ?? "";
	const words =
		ascii(String(data.title ?? ""))
			.toLowerCase()
			.match(/[a-z0-9]+/g) ?? [];
	const word = words.find((w) => w.length > 2 && !STOP_WORDS.has(w)) ?? words[0] ?? "";
	return `${author}${year}${word}` || data.key;
}

function sanitizeKey(k: string): string {
	return ascii(k).replace(/[^A-Za-z0-9:_.\-+/]/g, "");
}

/** Keys for a batch: stored citationKey if there is one, else authorYearTitleword; duplicates get a, b, c… suffixes. */
export function citationKeys(items: ZoteroItemData[]): string[] {
	const used = new Set<string>();
	return items.map((d) => {
		const stored = typeof d.citationKey === "string" ? sanitizeKey(d.citationKey) : "";
		const base = stored || sanitizeKey(citationKeyFor(d)) || d.key;
		let key = base;
		for (let n = 0; used.has(key.toLowerCase()); n++) {
			key = base + suffix(n);
		}
		used.add(key.toLowerCase());
		return key;
	});
}

function suffix(n: number): string {
	let s = "";
	let x = n;
	do {
		s = String.fromCharCode(97 + (x % 26)) + s;
		x = Math.floor(x / 26) - 1;
	} while (x >= 0);
	return s;
}

const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function entryType(data: ZoteroItemData, flavor: BibFlavor): { type: string; thesisType?: string } {
	const bl = flavor === "biblatex";
	switch (data.itemType) {
		case "journalArticle":
		case "magazineArticle":
		case "newspaperArticle":
			return { type: "article" };
		case "book":
			return { type: "book" };
		case "bookSection":
			return { type: "incollection" };
		case "conferencePaper":
			return { type: "inproceedings" };
		case "thesis": {
			const t = String(data.thesisType ?? data.type ?? "");
			const master = /master|msc|\bma\b|mphil/i.test(t);
			if (bl) return { type: "thesis", thesisType: master ? "mathesis" : "phdthesis" };
			return { type: master ? "mastersthesis" : "phdthesis" };
		}
		case "report":
			return { type: bl ? "report" : "techreport" };
		case "webpage":
		case "blogPost":
		case "forumPost":
			return { type: bl ? "online" : "misc" };
		case "manuscript":
			return { type: "unpublished" };
		case "patent":
			return { type: bl ? "patent" : "misc" };
		case "computerProgram":
			return { type: bl ? "software" : "misc" };
		case "dataset":
			return { type: bl ? "dataset" : "misc" };
		case "preprint":
			return { type: bl ? "online" : "misc" };
		case "standard":
			return { type: bl ? "standard" : "misc" };
		default:
			return { type: "misc" };
	}
}

function nameList(creators: Creator[]): string {
	return creators
		.map((c) => (isSingleField(c) ? `{${toLatex(c.name!.trim())}}` : toLatex(creatorFamilyGiven(c))))
		.filter(Boolean)
		.join(" and ");
}

export interface ExportItem {
	data: ZoteroItemData;
	tags: string[];
	notes: string[]; // plain text of child notes, when requested
}

/** One entry. Returns BibTeX source (no trailing newline). */
export function bibEntry(item: ExportItem, key: string, flavor: BibFlavor): string {
	const d = item.data;
	const bl = flavor === "biblatex";
	const fields: [string, string][] = [];
	const put = (name: string, value: string | undefined | null, raw = false) => {
		const v = (value ?? "").trim();
		if (v) fields.push([name, raw ? v : toLatex(v)]);
	};
	const { type, thesisType } = entryType(d, flavor);
	const creators = d.creators ?? [];
	const NOT_AUTHOR = ["editor", "seriesEditor", "translator", "bookAuthor", "reviewedAuthor"];
	const authorish = creators.some((c) => c.creatorType === "author")
		? creators.filter((c) => c.creatorType === "author")
		: creators.filter((c) => !NOT_AUTHOR.includes(c.creatorType));
	const authors = nameList(authorish);
	if (authors) fields.push(["author", authors]);
	const editors = nameList(creators.filter((c) => c.creatorType === "editor" || c.creatorType === "seriesEditor"));
	if (editors) fields.push(["editor", editors]);
	if (bl) {
		const tr = nameList(creators.filter((c) => c.creatorType === "translator"));
		if (tr) fields.push(["translator", tr]);
		const ba = nameList(creators.filter((c) => c.creatorType === "bookAuthor"));
		if (ba) fields.push(["bookauthor", ba]);
	}
	put("title", String(d.title ?? ""));
	const container = getBase(d, "publicationTitle");
	if (type === "article") put(bl ? "journaltitle" : "journal", container);
	else if (type === "incollection" || type === "inproceedings") put("booktitle", container);
	else if (container) put(bl ? "journaltitle" : "howpublished", container);
	if (type === "article" && bl) put("shortjournal", getBase(d, "journalAbbreviation"));
	if (type === "inproceedings") put(bl ? "eventtitle" : "organization", String(d.conferenceName ?? ""));
	put("series", getBase(d, "series") || String(d.seriesTitle ?? ""));
	put("volume", String(d.volume ?? ""));
	const number =
		type === "article"
			? String(d.issue ?? "")
			: String(d.reportNumber ?? d.patentNumber ?? d.issue ?? d.seriesNumber ?? d.number ?? "");
	put("number", number);
	put(
		"pages",
		String(d.pages ?? "")
			.replace(/[–—]/g, "--")
			.replace(/(?<!-)-(?!-)/g, "--"),
	);
	const publisher = getBase(d, "publisher");
	put(
		type === "phdthesis" || type === "mastersthesis"
			? "school"
			: bl && (type === "thesis" || type === "report")
				? "institution"
				: type === "techreport"
					? "institution"
					: "publisher",
		publisher,
	);
	put(bl ? "location" : "address", String(d.place ?? ""));
	put("edition", String(d.edition ?? ""));
	// date
	const parts = d.date ? (toCslDate(String(d.date)) as { "date-parts"?: number[][] } | null)?.["date-parts"]?.[0] : null;
	if (bl) {
		const iso = parts ? parts.map((p, i) => (i === 0 ? String(p).padStart(4, "0") : String(p).padStart(2, "0"))).join("-") : "";
		if (iso) fields.push(["date", iso]);
		else if (d.date) put("date", String(d.date));
	} else {
		const y = parts?.[0] ?? parseYear(d.date);
		if (y) fields.push(["year", String(y)]);
		if (parts?.[1]) fields.push(["month", MONTH_ABBR[parts[1] - 1]!]);
	}
	if (bl && thesisType) put("type", thesisType, true);
	else if (!bl && type === "techreport") put("type", String(d.reportType ?? ""));

	const doi = normDoi(String(d.DOI ?? ""));
	if (doi) fields.push(["doi", bl ? doi : toLatex(doi).replace(/\\_/g, "\\_")]);
	put("issn", String(d.ISSN ?? ""));
	put("isbn", String(d.ISBN ?? ""));
	put("url", String(d.url ?? ""), true);
	if (d.accessDate) put("urldate", normalizeDate(String(d.accessDate).slice(0, 10)), true);
	put("abstract", String(d.abstractNote ?? ""));
	put("language", String(d.language ?? ""));
	put("shorttitle", String(d.shortTitle ?? ""));
	if (d.itemType === "preprint" && d.number) {
		put("eprint", String(d.number), true);
		put(
			bl ? "eprinttype" : "archiveprefix",
			/arxiv/i.test(String(d.publisher ?? d.repository ?? "")) ? "arXiv" : String(d.publisher ?? d.repository ?? ""),
			true,
		);
	}
	if (item.tags.length) put("keywords", item.tags.join(", "));
	const extra = String(d.extra ?? "")
		.split(/\r?\n/)
		.filter((l) => l.trim() && !/^\s*citation key\s*:/i.test(l))
		.join("; ");
	put("note", extra);
	if (item.notes.length) put("annote", item.notes.join("\n\n"));
	const body = fields.map(([k, v]) => (k === "month" && !bl ? `  ${k} = ${v}` : `  ${k} = {${v}}`)).join(",\n");
	return `@${type}{${key},\n${body}\n}`;
}

export function exportBibtex(items: ExportItem[], flavor: BibFlavor): string {
	const keys = citationKeys(items.map((i) => i.data));
	return items.map((it, i) => bibEntry(it, keys[i]!, flavor)).join("\n\n") + (items.length ? "\n" : "");
}
