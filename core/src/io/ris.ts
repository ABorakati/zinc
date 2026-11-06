// RIS: parse -> Zotero items, and Zotero items -> RIS.
import type { Creator, ZoteroItemData } from "../api-types";
import { parseYear } from "../db";
import { toCslDate } from "../cite/csl";
import {
	appendExtra, creatorFamilyGiven, creatorTypeFor, getBase, isSingleField, normalizeDate, parseName, setBase,
	setFirst, textToNoteHtml, type ParsedItem,
} from "./common";
import type { ExportItem } from "./bibtex";

const TY_TO_TYPE: Record<string, string> = {
	JOUR: "journalArticle", JFULL: "journalArticle", EJOUR: "journalArticle", ABST: "journalArticle", INPR: "journalArticle",
	BOOK: "book", EBOOK: "book", EDBOOK: "book", SER: "book", CHAP: "bookSection", ECHAP: "bookSection",
	CONF: "conferencePaper", CPAPER: "conferencePaper", THES: "thesis", RPRT: "report", ELEC: "webpage", WEB: "webpage",
	BLOG: "blogPost", MGZN: "magazineArticle", NEWS: "newspaperArticle", UNPB: "manuscript", MANSCPT: "manuscript",
	PAT: "patent", COMP: "computerProgram", DATA: "dataset", ENCYC: "encyclopediaArticle", DICT: "dictionaryEntry",
	SLIDE: "presentation", MAP: "map", CARTO: "map", MPCT: "film", VIDEO: "videoRecording", SOUND: "audioRecording",
	MUSIC: "audioRecording", ART: "artwork", ICOMM: "email", PCOMM: "letter", STAT: "statute", BILL: "bill", CASE: "case",
	HEAR: "hearing", PPRINT: "preprint", STAND: "standard", GEN: "document", GOVDOC: "report", AGGR: "document",
	ADVS: "videoRecording", CTLG: "document", CLSWK: "document", DBASE: "dataset", EQUA: "document", FIGURE: "artwork",
	GRANT: "document", MULTI: "document", PAMP: "document", UNBILL: "bill",
};
const TYPE_TO_TY: Record<string, string> = {
	journalArticle: "JOUR", book: "BOOK", bookSection: "CHAP", conferencePaper: "CPAPER", thesis: "THES", report: "RPRT",
	webpage: "ELEC", blogPost: "BLOG", magazineArticle: "MGZN", newspaperArticle: "NEWS", manuscript: "UNPB", patent: "PAT",
	computerProgram: "COMP", dataset: "DATA", encyclopediaArticle: "ENCYC", dictionaryEntry: "DICT", presentation: "SLIDE",
	map: "MAP", film: "MPCT", videoRecording: "VIDEO", audioRecording: "SOUND", artwork: "ART", email: "ICOMM", letter: "PCOMM",
	statute: "STAT", bill: "BILL", case: "CASE", hearing: "HEAR", preprint: "PPRINT", standard: "STAND", document: "GEN",
};

// ================================================================ parsing

export interface RisRecord {
	ty: string;
	lines: [string, string][];
}

export function parseRisRecords(text: string): RisRecord[] {
	const out: RisRecord[] = [];
	let cur: RisRecord | null = null;
	let last: [string, string] | null = null;
	for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
		const m = /^([A-Z][A-Z0-9])\s{1,2}-(?: ?([^\n]*))?$/.exec(line);
		if (m) {
			const tag = m[1]!;
			const val = (m[2] ?? "").trim();
			if (tag === "TY") {
				cur = { ty: val.toUpperCase(), lines: [] };
				out.push(cur);
				last = null;
			} else if (tag === "ER") {
				cur = null;
				last = null;
			} else if (cur) {
				last = [tag, val];
				cur.lines.push(last);
			}
		} else if (cur && last && line.trim()) {
			// continuation of a long value
			last[1] += (last[1] ? "\n" : "") + line.trim();
		}
	}
	return out;
}

function risDate(s: string): { y: number; m?: number; d?: number } | null {
	const m = /^(\d{4})(?:\/(\d{0,2}))?(?:\/(\d{0,2}))?/.exec(s.trim());
	if (m) return { y: +m[1]!, m: m[2] ? +m[2] : undefined, d: m[3] ? +m[3] : undefined };
	const n = normalizeDate(s);
	const m2 = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(n);
	return m2 ? { y: +m2[1]!, m: m2[2] ? +m2[2] : undefined, d: m2[3] ? +m2[3] : undefined } : null;
}
const risIso = (d: { y: number; m?: number; d?: number }) =>
	d.m ? (d.d ? `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}` : `${d.y}-${String(d.m).padStart(2, "0")}`) : String(d.y);

export function risRecordToItem(r: RisRecord): ParsedItem | null {
	const itemType = TY_TO_TYPE[r.ty] ?? "document";
	const data: Partial<ZoteroItemData> & { itemType: string } = { itemType };
	const notes: string[] = [];
	const creators: Creator[] = [];
	const tags: { tag: string }[] = [];
	const get = (...tags: string[]) => r.lines.filter(([t]) => tags.includes(t)).map(([, v]) => v);
	const first = (...tags: string[]) => get(...tags)[0] ?? "";

	let title = first("TI", "T1", "CT");
	let secondary = first("T2", "JO", "JF", "J1", "BT");
	if (first("BT") && !title && (itemType === "book" || itemType === "thesis" || itemType === "report")) {
		title = first("BT");
		secondary = first("T2", "JO", "JF");
	}
	setBase(data, "title", title);
	if (!setBase(data, "publicationTitle", secondary) && secondary) setFirst(data, ["series", "seriesTitle"], secondary);
	setBase(data, "journalAbbreviation", first("J2", "JA", "J1") && first("J2", "JA", "J1") !== secondary ? first("J2", "JA", "J1") : "");
	setFirst(data, ["seriesTitle", "series"], first("T3"));
	if (itemType === "conferencePaper") setBase(data, "conferenceName", first("C3"));

	for (const [tag, val] of r.lines) {
		if (!val) continue;
		const add = (wanted: string, ...fb: string[]) => {
			// RIS names are "Last, First" or "Last, First, Suffix" (parseName reads three parts the BibTeX way, "Last, Jr, First"); like Zotero, drop the suffix
			const parts = val.split(",").map((x) => x.trim());
			const c = parseName(parts.length >= 3 && parts[1] ? `${parts[0]}, ${parts[1]}` : val, creatorTypeFor(itemType, wanted, ...fb));
			if (c) creators.push(c);
		};
		if (tag === "AU" || tag === "A1") add("author");
		else if (tag === "A2" || tag === "ED") add("editor", "contributor");
		else if (tag === "A3") add("seriesEditor", "editor", "contributor");
		else if (tag === "A4" || tag === "TA") add("translator", "contributor");
		else if (tag === "KW") {
			for (const k of val.split(/\n/)) if (k.trim()) tags.push({ tag: k.trim() });
		} else if (tag === "N1") notes.push(textToNoteHtml(val));
	}

	const ab = first("AB", "N2");
	setBase(data, "abstractNote", ab);
	setBase(data, "volume", first("VL"));
	setFirst(data, ["issue", "reportNumber", "patentNumber", "seriesNumber"], first("IS"));
	const sp = first("SP");
	const ep = first("EP");
	if (sp || ep) {
		const spTxt = sp.replace(/\s*-\s*/g, "–");
		const pages = ep && sp && !/[-–]/.test(sp) ? `${sp}–${ep}` : spTxt || ep;
		if (!setBase(data, "pages", pages)) setBase(data, "numPages", pages);
	}
	setBase(data, "publisher", first("PB"));
	setBase(data, "place", first("CY", "PP"));
	setBase(data, "language", first("LA"));
	setBase(data, "edition", first("ET"));
	setBase(data, "url", first("UR", "L2"));
	const doi = first("DO").replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "");
	if (doi) setBase(data, "DOI", doi);
	else {
		const m = /\b(10\.\d{4,9}\/\S+)/.exec(first("UR", "L3", "M3"));
		if (m && itemType !== "report") setBase(data, "DOI", m[1]!.replace(/[.,;]+$/, ""));
	}
	for (const sn of get("SN")) {
		const compact = sn.replace(/[\s-]/g, "");
		const isIssn = /^\d{7}[\dXx]$/.test(compact) && /^\d{4}-?\d{3}[\dXx]$/.test(sn.trim());
		if (isIssn || (/^(JOUR|MGZN|NEWS|EJOUR)$/.test(r.ty) && !/^\d{10}(\d{3})?$/.test(compact))) setBase(data, "ISSN", sn);
		else setBase(data, "ISBN", sn);
	}
	const m3 = first("M3");
	if (m3) setBase(data, "type", m3);
	const m1 = first("M1");
	if (m1) setFirst(data, ["reportNumber", "patentNumber", "number", "seriesNumber", "issue"], m1); // M1 is the issue of a journal article
	if (first("M2")) appendExtra(data, first("M2"));
	setBase(data, "shortTitle", first("ST"));
	setBase(data, "callNumber", first("CN"));
	setBase(data, "libraryCatalog", first("DB"));
	const accessed = risDate(first("Y2"));
	if (accessed) setBase(data, "accessDate", risIso(accessed));

	// date: DA is full, PY is the year; prefer the fuller one when they agree
	// Y1 is the deprecated form of PY/DA: it only counts when neither is present
	const py = risDate(first("PY"));
	const da = risDate(first("DA"));
	const y1 = risDate(first("Y1"));
	const date = da && (!py || da.y === py.y) ? da : py ?? da ?? y1;
	if (date) setBase(data, "date", risIso(date));
	else if (first("PY", "DA", "Y1")) setBase(data, "date", first("PY", "DA", "Y1"));

	if (creators.length) data.creators = creators;
	if (tags.length) data.tags = tags;
	if (!data.title && !creators.length && !date) return null;
	return { data, notes };
}

export function parseRis(text: string): { items: ParsedItem[]; errors: string[] } {
	const items: ParsedItem[] = [];
	const errors: string[] = [];
	const recs = parseRisRecords(text);
	recs.forEach((r, i) => {
		try {
			const it = risRecordToItem(r);
			if (it) items.push(it);
			else errors.push(`record ${i + 1} has no title, author or date`);
		} catch (e) {
			errors.push(`record ${i + 1}: ${e instanceof Error ? e.message : e}`);
		}
	});
	return { items, errors };
}

// ================================================================ writing

const oneLine = (s: string) => s.replace(/\s*\r?\n\s*/g, " ").trim();

export function risRecord(item: ExportItem): string {
	const d = item.data;
	const lines: string[] = [];
	const put = (tag: string, v: unknown) => {
		const s = oneLine(String(v ?? ""));
		if (s) lines.push(`${tag}  - ${s}`);
	};
	lines.push(`TY  - ${TYPE_TO_TY[d.itemType] ?? "GEN"}`);
	put("TI", d.title);
	const creators = d.creators ?? [];
	const NOT_AUTHOR = ["editor", "seriesEditor", "translator", "bookAuthor", "reviewedAuthor"];
	const hasAuthor = creators.some((c) => c.creatorType === "author");
	for (const c of creators) {
		const isAuthor = hasAuthor ? c.creatorType === "author" : !NOT_AUTHOR.includes(c.creatorType);
		const tag = isAuthor ? "AU" : c.creatorType === "editor" ? "ED" : c.creatorType === "seriesEditor" ? "A3" : c.creatorType === "translator" ? "A4" : c.creatorType === "bookAuthor" ? "A1" : null;
		if (tag) put(tag, isSingleField(c) ? `${c.name},` : creatorFamilyGiven(c)); // trailing comma marks an institutional name
	}
	const container = getBase(d, "publicationTitle");
	put("T2", container);
	if (d.itemType === "journalArticle") put("J2", d.journalAbbreviation);
	put("T3", d.seriesTitle || getBase(d, "series"));
	if (d.itemType === "conferencePaper") put("C3", d.conferenceName);
	const parts = d.date ? (toCslDate(String(d.date)) as { "date-parts"?: number[][] } | null)?.["date-parts"]?.[0] : null;
	const y = parts?.[0] ?? parseYear(d.date);
	if (y) put("PY", y);
	if (parts && parts.length > 1) put("DA", parts.map((p, i) => (i === 0 ? String(p) : String(p).padStart(2, "0"))).join("/") + "/");
	else if (!y && d.date) put("DA", d.date);
	put("AB", d.abstractNote);
	put("VL", d.volume);
	put("IS", d.issue);
	const pages = String(d.pages ?? "");
	const pm = /^\s*([^\s–—-]+)\s*[-–—]+\s*([^\s–—-]+)\s*$/.exec(pages);
	if (pm) {
		put("SP", pm[1]);
		put("EP", pm[2]);
	} else put("SP", pages);
	put("PB", getBase(d, "publisher"));
	put("CY", d.place);
	put("LA", d.language);
	put("ET", d.edition);
	put("SN", d.ISBN);
	put("SN", d.ISSN);
	put("DO", d.DOI);
	put("UR", d.url);
	put("ST", d.shortTitle);
	put("CN", d.callNumber);
	put("DB", d.libraryCatalog);
	if (d.accessDate) {
		const a = risDate(String(d.accessDate).slice(0, 10).replace(/-/g, "/"));
		if (a) put("Y2", `${a.y}/${String(a.m ?? "").padStart(a.m ? 2 : 0, "0")}/${String(a.d ?? "").padStart(a.d ? 2 : 0, "0")}/`);
	}
	const type = d.thesisType ?? d.reportType ?? d.websiteType ?? d.genre ?? d.type;
	put("M3", type);
	put("M1", d.reportNumber ?? d.patentNumber ?? d.number ?? d.seriesNumber);
	put("M2", String(d.extra ?? "").replace(/\r?\n/g, "; "));
	for (const t of item.tags) put("KW", t);
	for (const n of item.notes) put("N1", n);
	lines.push("ER  - ");
	return lines.join("\r\n");
}

export function exportRis(items: ExportItem[]): string {
	return items.map(risRecord).join("\r\n\r\n") + (items.length ? "\r\n" : "");
}
