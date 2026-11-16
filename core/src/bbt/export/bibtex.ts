// Better BibTeX and Better BibLaTeX exporters.
//
// Field mapping, entry types, field order, name and date handling follow Better BibTeX's translators
// (https://github.com/retorquere/zotero-better-bibtex, MIT, see core/src/bbt/NOTICE); the implementation is original.
import type { Creator, ZoteroItemData } from "../../api-types";
import { creatorLast, dateParts, getBase, isSingleField, isoDate, normalizeDate, normDoi } from "../../io/common";
import { parseExtra, type ExtraFields, type TexField } from "../text";
import type { BbtSettings } from "../types";
import { encodeChars, textToLatex, verbatim, type TexOptions } from "./latex";

export interface BbtExportItem {
	data: ZoteroItemData;
	tags: string[];
	/** child notes as HTML, when exporting notes */
	noteHtml?: string[];
	/** absolute paths of attached files */
	files?: string[];
}
export interface BibOptions {
	/** override settings.asciiBibTeX / asciiBibLaTeX */
	ascii?: boolean;
	includeNotes?: boolean;
}
type Flavor = "bibtex" | "biblatex";

const FIELD_ORDER = [
	"type",
	"entrysubtype",
	"ids",
	"title",
	"shorttitle",
	"booktitle",
	"author",
	"authortype",
	"editor",
	"editortype",
	"editora",
	"editoratype",
	"editorb",
	"editorbtype",
	"editorc",
	"editorctype",
	"translator",
	"translatortype",
	"holder",
	"holdertype",
	"with",
	"namea",
	"nameatype",
	"nameb",
	"namebtype",
	"namec",
	"nameatype",
	"options",
	"date",
	"origdate",
	"year",
	"month",
	"journal",
	"journaltitle",
	"shortjournal",
	"series",
	"edition",
	"volume",
	"number",
	"eprint",
	"eprinttype",
	"eprintclass",
	"primaryclass",
	"pages",
	"publisher",
	"address",
	"institution",
	"location",
	"issn",
	"doi",
	"url",
	"urldate",
	"-keywords",
	"-annotation",
	"-note",
	"-groups",
	"-timestamp",
	"-files",
	"-file",
].reduce<Record<string, number>>((acc, f, i) => {
	if (f[0] === "-") acc[f.slice(1)] = -(i + 1);
	else acc[f] = i + 1;
	return acc;
}, {});

function fieldCompare(a: string, b: string): number {
	const fa = FIELD_ORDER[a];
	const fb = FIELD_ORDER[b];
	if (fa && fb) return Math.abs(fa) - Math.abs(fb);
	if (fa) return -fa;
	if (fb) return fb;
	return a < b ? -1 : a > b ? 1 : 0;
}

const TYPE_BIBTEX: Record<string, string> = {
	artwork: "misc",
	audioRecording: "misc",
	bill: "misc",
	blogPost: "misc",
	book: "book",
	bookSection: "incollection",
	case: "misc",
	computerProgram: "misc",
	conferencePaper: "inproceedings",
	dictionaryEntry: "misc",
	document: "misc",
	email: "misc",
	encyclopediaArticle: "article",
	film: "misc",
	forumPost: "misc",
	hearing: "misc",
	instantMessage: "misc",
	interview: "misc",
	journalArticle: "article",
	letter: "misc",
	magazineArticle: "article",
	manuscript: "unpublished",
	map: "misc",
	newspaperArticle: "article",
	patent: "patent",
	podcast: "misc",
	preprint: "misc",
	presentation: "misc",
	radioBroadcast: "misc",
	report: "techreport",
	standard: "standard",
	statute: "misc",
	thesis: "phdthesis",
	tvBroadcast: "misc",
	videoRecording: "misc",
	webpage: "misc",
	dataset: "misc",
};
const TYPE_BIBLATEX: Record<string, string | { type: string; subtype: string }> = {
	artwork: "artwork",
	audioRecording: "audio",
	bill: "legislation",
	blogPost: "online",
	book: "book",
	bookSection: "incollection",
	case: "jurisdiction",
	computerProgram: "software",
	conferencePaper: "inproceedings",
	dictionaryEntry: "inreference",
	dataset: "dataset",
	document: "misc",
	email: "letter",
	encyclopediaArticle: "inreference",
	film: "video",
	forumPost: "online",
	hearing: "jurisdiction",
	instantMessage: "misc",
	interview: "misc",
	journalArticle: "article",
	letter: "letter",
	magazineArticle: { type: "article", subtype: "magazine" },
	manuscript: "unpublished",
	map: "misc",
	newspaperArticle: { type: "article", subtype: "newspaper" },
	patent: "patent",
	podcast: "audio",
	preprint: "online",
	presentation: "unpublished",
	radioBroadcast: "audio",
	report: "report",
	standard: "standard",
	statute: "legislation",
	thesis: "thesis",
	tvBroadcast: "video",
	videoRecording: "video",
	webpage: "online",
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function thesisType(t: string, phd: string, masters: string, bachelors?: string, cand?: string): string | undefined {
	const k = t
		.toLowerCase()
		.replace(/[^a-z]/g, "")
		.replace(/thesis$/, "");
	if (["phd", "dissertation", "phddissertation", "doctoraldissertation", "phddiss", "doctoral", "doctorate"].includes(k)) return phd;
	if (["ma", "master", "masters", "mphil", "msc"].includes(k)) return masters;
	if (["ba", "bachelor", "bachelors", "undergrad", "undergraduate"].includes(k)) return bachelors;
	if (["cand", "candidate", "candidates"].includes(k)) return cand;
	return undefined;
}

function normalizeDashes(ranges: string): string {
	return ranges
		.trim()
		.replace(/⁓/g, "~")
		.replace(/[—―]/g, "---")
		.replace(/[‒–]/g, "--")
		.split(/(,\s*)/)
		.map((range) => {
			if (/^,\s+/.test(range)) return ", ";
			if (range === ",") return range;
			return range
				.replace(/^([0-9]+)\s*(-+)\s*([0-9]+)\s*$/, "$1$2$3")
				.replace(/^([0-9]+)-([0-9]+)$/, "$1--$2")
				.replace(/^([0-9]+)-{4,}([0-9]+)$/, "$1---$2");
		})
		.join("");
}

/** Zotero date string -> ISO (possibly a range "a/b"), or null when it cannot be read as a date. */
function isoOf(raw: string): string | null {
	const s = raw.trim();
	if (!s) return null;
	const range = s.split(/\s*\/\s*|\s+-\s+/);
	if (range.length === 2) {
		const [a, b] = range.map(isoOf);
		return a && b ? `${a}/${b}` : null;
	}
	const norm = normalizeDate(s);
	if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(norm)) return norm;
	const parts = dateParts(s);
	if (parts && /^\s*\d{4}\b/.test(norm)) return isoDate(parts[0]!, parts[1], parts[2]);
	return null;
}

interface Field {
	name: string;
	bibtex: string;
	value: string;
}

class Entry {
	has = new Map<string, Field>();
	type: string;
	subtype = "";
	english: boolean;
	readonly tex: TexOptions;
	readonly extra: ExtraFields;

	constructor(
		readonly item: BbtExportItem,
		readonly flavor: Flavor,
		readonly st: BbtSettings,
		readonly ascii: boolean,
	) {
		const d = item.data;
		this.extra = parseExtra(typeof d.extra === "string" ? d.extra : "");
		const lang = String(d.language ?? "").toLowerCase();
		this.english = !lang || /^en(\b|[-_])|^english/.test(lang);
		this.tex = { flavor, ascii, protect: false };
		if (flavor === "bibtex") {
			this.type = TYPE_BIBTEX[d.itemType] ?? "misc";
		} else {
			const t = TYPE_BIBLATEX[d.itemType] ?? "misc";
			this.type = typeof t === "string" ? t : t.type;
			if (typeof t !== "string") this.subtype = t.subtype;
		}
	}

	g(name: string): string {
		return getBase(this.item.data as Record<string, unknown>, name).trim();
	}

	/** add a field: literal (escaped, optionally case-protected), verbatim or raw; first write wins unless `replace` */
	add(
		name: string,
		value: string | number | undefined | null,
		o: { enc?: "literal" | "verbatim" | "raw"; protect?: boolean; bare?: boolean; replace?: boolean; html?: boolean } = {},
	): void {
		if (value === undefined || value === null) return;
		const v = typeof value === "number" ? String(value) : value;
		if (!v.trim()) return;
		if (this.has.has(name) && !o.replace) return;
		let bibtex: string;
		if (o.bare && /^[A-Za-z0-9]+$/.test(v)) bibtex = v;
		else {
			const enc = o.enc ?? "literal";
			let body: string;
			if (enc === "raw") body = v;
			else if (enc === "verbatim") body = verbatim(v);
			else {
				body = textToLatex(
					v.replace(/\r?\n+/g, " "),
					{ ...this.tex, protect: !!o.protect && this.english && this.st.exportBraceProtection },
					{ html: o.html !== false },
				);
			}
			bibtex = `{${body.trim()}}`;
		}
		this.has.set(name, { name, bibtex, value: v });
	}

	remove(name: string): void {
		this.has.delete(name);
	}

	// ---- names

	private enc(text: string, creator = true): string {
		return textToLatex(text, { ...this.tex, protect: false, creator }, { html: false });
	}

	private encName(c: Creator): string {
		if (isSingleField(c) || (c.lastName && !c.firstName && (c as { fieldMode?: number }).fieldMode === 1)) {
			const n = (c.name ?? c.lastName ?? "").replace(/\s+/g, " ").trim();
			if (n === "others") return n;
			return `{${this.enc(n, false)}}`;
		}
		const last = (c.lastName ?? "").replace(/\s+/g, " ").trim();
		const first = (c.firstName ?? "").replace(/\s+/g, " ").trim();
		if (!last && !first) return "";
		let family = last;
		const quoted = /^"(.+)"$/.exec(last);
		let braced = false;
		if (quoted) {
			family = quoted[1]!;
			braced = true;
		} else if (this.flavor === "bibtex") {
			// BibTeX reads lower-case words as "von" parts, and hyphenated names confuse its sorting: protect them
			braced = /^\p{Ll}|\s\p{Ll}|[-\u2013\u2014\u2015\u2012]/u.test(last);
		}
		let out = this.enc(family);
		if (braced) out = `{${out}}`;
		if (first) out += `, ${this.enc(first)}`;
		return out.replace(/ and /g, " {and} ");
	}

	names(list: Creator[]): string {
		return list
			.map((c) => this.encName(c))
			.filter(Boolean)
			.join(" and ");
	}

	addCreators(): void {
		const creators = (this.item.data.creators ?? []) as Creator[];
		if (!creators.length) return;
		const by: Record<string, Creator[]> = {
			author: [],
			editor: [],
			translator: [],
			bookauthor: [],
			commentator: [],
			editora: [],
			namea: [],
		};
		const video = ["video", "movie"].includes(this.type);
		for (const c of creators) {
			switch (c.creatorType) {
				case "author":
				case "inventor":
				case "interviewer":
				case "programmer":
				case "artist":
				case "podcaster":
				case "presenter":
					by.author!.push(c);
					break;
				case "director":
					(video && this.flavor === "biblatex" ? by.editor! : by.author!).push(c);
					break;
				case "editor":
					by.editor!.push(c);
					break;
				case "seriesEditor":
					(this.flavor === "biblatex" ? by.editora! : by.editor!).push(c);
					break;
				case "translator":
					by.translator!.push(c);
					break;
				case "bookAuthor":
					if (this.flavor === "biblatex") by.bookauthor!.push(c);
					break;
				case "commenter":
					if (this.flavor === "biblatex") by.commentator!.push(c);
					break;
				default:
					if (this.flavor === "biblatex") by.namea!.push(c);
			}
		}
		this.has.delete("author");
		for (const [field, list] of Object.entries(by)) {
			if (!list.length) continue;
			const v = this.names(list);
			if (!v) continue;
			this.has.set(field, { name: field, bibtex: `{${v}}`, value: v });
			if (field === "editora") this.add("editoratype", "redactor", { enc: "raw" });
			if (field === "namea") this.add("nameatype", "collaborator", { enc: "raw" });
		}
		if (this.flavor === "bibtex") this.remove("bookauthor");
	}

	hasCreator(type: string): boolean {
		return ((this.item.data.creators ?? []) as Creator[]).some((c) => c.creatorType === type);
	}

	// ---- dates

	addDate(): void {
		const d = this.item.data;
		const raw = String(d.date ?? "").trim();
		if (this.flavor === "biblatex") {
			if (raw) {
				const iso = isoOf(raw);
				if (iso) this.add("date", iso, { enc: "raw" });
				else this.add("year", raw);
			}
			const orig = this.extra.kv.originaldate;
			if (orig) {
				const iso = isoOf(orig);
				if (iso) this.add("origdate", iso, { enc: "raw" });
			}
		} else if (raw) {
			const parts = dateParts(raw);
			if (parts) {
				this.add("year", String(parts[0]), { bare: true });
				if (parts[1]) this.add("month", MONTHS[parts[1] - 1]!, { bare: true });
			} else this.add("year", raw);
		}
	}

	// ---- extra: tex.* overrides

	applyTex(): void {
		for (const [name, f] of Object.entries(this.extra.tex) as [string, TexField][]) {
			if (f.only && f.only !== this.flavor) continue;
			if (name === "entrytype" || name === "referencetype") {
				this.type = f.value;
				continue;
			}
			if (!f.value) {
				this.remove(name);
				continue;
			}
			let field = name;
			if (name === "mr") field = "mrnumber";
			else if (name === "zbl") field = "zmnumber";
			if (this.flavor === "biblatex" && ["pmid", "arxiv", "jstor", "hdl"].includes(name) && !this.has.has("eprinttype")) {
				this.add("eprinttype", name === "arxiv" ? "arXiv" : name, { replace: true });
				this.add("eprint", f.value, { replace: true, enc: "verbatim" });
				continue;
			}
			if (f.mode === "raw") this.add(field, f.value, { enc: "raw", replace: true });
			else this.add(field, f.value, { replace: true, protect: f.mode === "cased", html: false });
		}
	}

	complete(): string {
		const keys = [...this.has.keys()].sort(fieldCompare);
		const st = this.st;
		if (this.has.has("url") && this.has.has("doi")) {
			if (st.doiAndUrl === "url") this.has.delete("doi");
			else if (st.doiAndUrl === "doi") {
				this.has.delete("url");
				this.has.delete("urldate");
			}
		}
		const body = keys.filter((k) => this.has.has(k)).map((k) => `  ${k} = ${this.has.get(k)!.bibtex}`);
		if (!body.length) body.push(`  type = {${this.type}}`);
		return body.join(",\n");
	}
}

function bibtexEntry(e: Entry): void {
	const d = e.item.data;
	const t = d.itemType;
	if (t === "report" && /manual/i.test(e.g("type"))) e.type = "manual";
	if (t === "bookSection" && e.hasCreator("bookAuthor")) e.type = "inbook";
	e.add("address", t === "conferencePaper" ? e.g("place") || e.g("eventPlace") : e.g("place"));
	e.add("chapter", e.g("section"));
	e.add("edition", e.g("edition"));
	e.add("type", e.g("type"));
	e.add("series", e.g("series") || e.g("seriesTitle"), { protect: true });
	e.add("title", e.g("title"), { protect: true });
	e.add("copyright", e.g("rights"));
	e.add("isbn", e.g("ISBN"));
	e.add("issn", e.g("ISSN"));
	e.add("lccn", e.g("callNumber"));
	e.add("shorttitle", e.g("shortTitle"), { protect: true });
	e.add("abstract", e.g("abstractNote"));
	e.add("nationality", e.g("country"));
	e.add("assignee", e.g("assignee"));
	e.add("volume", normalizeDashes(e.g("volume")));
	if (!["book", "inbook", "incollection", "proceedings", "inproceedings"].includes(e.type) || !e.has.has("volume")) {
		e.add("number", e.g("number") || e.g("issue") || e.g("seriesNumber"));
	}
	const access = e.g("accessDate");
	if (access) e.add("urldate", access.replace(/\s*T?\d+:\d+:\d+.*/, "").slice(0, 10), { enc: "raw" });
	const abbr = e.g("journalAbbreviation");
	const pub = e.g("publicationTitle");
	if (t === "conferencePaper") e.add("booktitle", pub || e.g("conferenceName"), { protect: true });
	else if (t === "bookSection") e.add("booktitle", pub || e.g("conferenceName"), { protect: true });
	else e.add("journal", pub || abbr);
	switch (t === "thesis" ? "thesis" : t) {
		case "thesis":
			e.add("school", e.g("publisher"));
			break;
		case "report":
			e.add("institution", e.g("publisher"));
			break;
		case "computerProgram":
			e.add("howpublished", e.g("publisher"));
			break;
		default:
			e.add("publisher", e.g("publisher"));
	}
	const doi = normDoi(e.g("DOI") || e.extra.kv.doi || "");
	const url = e.g("url") || e.extra.kv.url || "";
	// BBT's default ("bibtexURL: off") only exports a URL for web-like items, as howpublished
	if (["webpage", "blogPost", "forumPost"].includes(t)) e.add("howpublished", url, { enc: "verbatim" });
	e.add("doi", doi, { enc: "verbatim" });
	if (t === "thesis") {
		const tt = thesisType(e.g("type"), "phdthesis", "mastersthesis");
		if (tt) {
			e.type = tt;
			e.remove("type");
		}
	}
	if (e.type === "inproceedings") {
		const sponsors = ((d.creators ?? []) as Creator[]).filter((c) => c.creatorType === "sponsor").map((c) => creatorLast(c));
		e.add("organization", sponsors.join(" and "));
	}
	e.addCreators();
	if (e.type === "inbook" && e.has.has("author") && e.has.has("editor")) e.remove("editor");
	e.addDate();
	e.add("pmid", e.g("PMID"));
	e.add("pmcid", e.g("PMCID"));
	if (e.extra.kv.arxiv) {
		e.add("eprint", e.extra.kv.arxiv, { enc: "verbatim" });
		e.add("archiveprefix", "arXiv", { enc: "raw" });
	}
	e.add("pages", normalizeDashes(e.g("pages")));
}

function biblatexEntry(e: Entry): void {
	const d = e.item.data;
	const t = d.itemType;
	const has = (n: string) => e.has.has(n);
	if (e.type === "incollection" && e.hasCreator("bookAuthor")) e.type = "inbook";
	if (e.type === "book" && e.g("numberOfVolumes")) e.type = "mvbook";
	if (e.type === "report" && /manual/i.test(e.g("type"))) e.type = "manual";
	e.add("pubstate", t === "preprint" ? "prepublished" : e.extra.kv.status);
	e.add("entrysubtype", e.subtype, { enc: "raw" });
	if (e.type === "unpublished" && t === "presentation") e.add("venue", e.g("place"));
	else {
		e.add("location", e.g("place") || e.extra.kv.publisherplace);
		if (t === "conferencePaper" && !has("venue")) e.add("venue", e.g("eventPlace"));
	}
	e.add("title", e.g("title"), { protect: true });
	e.add("edition", e.g("edition").replace(/^([0-9]+)(st|nd|th)$/, "$1"));
	e.add("isbn", e.g("ISBN"));
	e.add("issn", e.g("ISSN"));
	const url = e.g("url") || e.extra.kv.url || "";
	e.add("url", url, { enc: "verbatim" });
	e.add("doi", normDoi(e.g("DOI") || e.extra.kv.doi || "").replace(/^https?:\/\/doi.org\//i, ""), { enc: "verbatim" });
	e.add("shorttitle", e.g("shortTitle"), { protect: true });
	e.add("abstract", e.g("abstractNote"));
	e.add("volumes", e.g("numberOfVolumes"));
	e.add("version", e.g("versionNumber"));
	e.add("eventtitle", e.g("conferenceName") || e.g("meetingName"), { protect: true });
	e.add("pagetotal", e.g("numPages"));
	const pre = t === "preprint";
	const arxiv = pre && /arxiv/i.test(`${e.g("publisher")} ${e.g("repository")} ${e.g("archive")}`);
	if (arxiv || e.extra.kv.arxiv) {
		e.add("eprinttype", "arXiv", { enc: "raw" });
		e.add("eprint", e.extra.kv.arxiv || e.g("number").replace(/^arxiv:\s*/i, ""), { enc: "verbatim" });
	}
	if (!(e.g("number").match(/arxiv/i) && has("eprint"))) {
		if (t === "patent") e.add("number", normalizeDashes(e.g("number")));
		else {
			e.add("number", normalizeDashes(e.g("seriesNumber")));
			const issue = normalizeDashes(e.g("issue"));
			const numberish = /^[A-Z]?[0-9]+(\.[0-9]+)?([-–]+[A-Z]?[0-9]+)?$/i.test(issue);
			e.add(!(numberish && !has("number")) && ["article"].includes(e.type) ? "issue" : "number", issue);
			e.add(has("number") && !pre ? "eid" : "number", normalizeDashes(e.g("number")));
		}
	}
	const pub = e.g("publicationTitle");
	const abbr = e.g("journalAbbreviation");
	switch (e.type) {
		case "jurisdiction":
			e.add("journaltitle", e.g("reporter") || pub);
			break;
		case "legislation":
			e.add("journaltitle", e.g("code") || pub);
			break;
		case "incollection":
		case "inproceedings":
		case "inreference":
		case "movie":
		case "video":
		case "inbook":
			e.add("booktitle", pub, { protect: true });
			break;
		case "online":
			e.add("organization", pub);
			break;
		case "article":
			e.add("journaltitle", pub || abbr);
			if (e.subtype === "newspaper") e.add("journalsubtitle", e.g("section"));
			else if (pub) e.add("shortjournal", abbr);
			break;
		default:
			if (pub && pub !== e.g("title")) e.add("journaltitle", pub);
	}
	e.add("series", e.g("series") || e.g("seriesTitle"), { protect: true });
	switch (e.type) {
		case "report":
		case "thesis":
			e.add("institution", e.g("publisher"));
			break;
		case "jurisdiction":
			e.add("institution", e.g("court") || e.g("authority"));
			break;
		case "software":
		case "misc":
			e.add("organization", e.g("publisher"));
			break;
		default:
			if (!pre) e.add("publisher", e.g("publisher"));
	}
	switch (e.type) {
		case "letter":
			e.add("type", e.g("type") || (t === "email" ? "E-mail" : "Letter"));
			break;
		case "thesis":
			e.add("type", thesisType(e.g("type"), "phdthesis", "mathesis", "bathesis", "candthesis") || e.g("type"), { enc: "raw" });
			break;
		case "report":
			e.add("type", e.g("type"));
			break;
		case "dataset":
			e.add("type", e.g("type") || e.g("medium"));
			break;
		default:
			if (e.type === "unpublished" && t !== "presentation") e.add("howpublished", e.g("type"));
			else e.add("type", e.g("type"));
	}
	const access = e.g("accessDate");
	if (access && url) {
		const iso = isoOf(access.slice(0, 10));
		if (iso) e.add("urldate", iso, { enc: "raw" });
	}
	e.addDate();
	e.add("pages", normalizeDashes(e.g("pages")));
	e.add("volume", normalizeDashes(e.g("volume")));
	e.addCreators();
	e.add("pmid", e.g("PMID"));
	e.add("pmcid", e.g("PMCID"));
	if (e.has.has("eprint") === false && e.g("archive") && e.g("archiveLocation")) {
		const a = e.g("archive").toLowerCase();
		if (["jstor", "pubmed", "hdl", "arxiv"].includes(a)) {
			e.add("eprinttype", a === "arxiv" ? "arXiv" : a, { enc: "raw" });
			e.add("eprint", e.g("archiveLocation"), { enc: "verbatim" });
		}
	}
	if (e.has.has("pmid") && !has("eprint")) {
		e.add("eprinttype", "pubmed", { enc: "raw" });
		e.add("eprint", e.g("PMID"), { enc: "verbatim" });
		e.remove("pmid");
	}
	if (e.extra.kv.callnumber) e.add("lccn", e.extra.kv.callnumber);
}

/** The text of one entry (no trailing newline). */
export function bibEntry(item: BbtExportItem, key: string, flavor: Flavor, st: BbtSettings, opts: BibOptions = {}): string {
	const ascii = opts.ascii ?? (flavor === "bibtex" ? st.asciiBibTeX : st.asciiBibLaTeX);
	const e = new Entry(item, flavor, st, ascii);
	if (flavor === "bibtex") bibtexEntry(e);
	else biblatexEntry(e);
	const keywords = [...new Set(item.tags)].map((t) => t.replace(/[#%]/g, "").trim()).filter(Boolean);
	if (keywords.length) {
		const enc = keywords.map((t) => encodeChars(t.replace(/[{,}]/g, ""), { flavor, ascii, protect: false }));
		e.add("keywords", enc.sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })).join(","), { enc: "raw" });
	}
	if (item.files?.length) {
		const files = item.files.filter(Boolean);
		if (files.length === 1) e.add("file", files[0], { enc: "verbatim" });
		else if (files.length > 1) e.add("file", files.map((p) => p.replace(/([\\{}:;])/g, "\\$1")).join(";"), { enc: "raw" });
	}
	if (opts.includeNotes || st.exportNotes) {
		const notes = (item.noteHtml ?? []).join("</p><p>");
		if (notes) e.add("note", notes, { html: true });
	}
	if (st.exportExtraAsNote && typeof item.data.extra === "string") {
		const rest = item.data.extra
			.split(/\r?\n/)
			.filter((l) => l.trim() && !/^\s*(citation\s*key|(bib)?(la)?tex\.)/i.test(l))
			.join("\n");
		if (rest) e.add("annotation", rest);
	}
	e.applyTex();
	const body = e.complete();
	return `@${e.type}{${key},\n${body}\n}`;
}

export function exportBetterBib(items: BbtExportItem[], keys: string[], flavor: Flavor, st: BbtSettings, opts: BibOptions = {}): string {
	const out = items.map((it, i) => bibEntry(it, keys[i]!, flavor, st, opts));
	return out.length ? `${out.join("\n\n")}\n` : "";
}
