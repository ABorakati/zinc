// CSL-JSON: parse -> Zotero items, and Zotero items -> CSL-JSON (via cite/csl.ts).
import type { Creator, ZoteroItemData } from "../api-types";
import { itemToCsl } from "../cite/csl";
import type { ExportItem } from "./bibtex";
import { citationKeys } from "./bibtex";
import { appendExtra, creatorTypeFor, isoDate, normalizeDate, setBase, setFirst, splitKeywords, textToNoteHtml, type ParsedItem } from "./common";

const CSL_TO_TYPE: Record<string, string> = {
	"article-journal": "journalArticle", "article-magazine": "magazineArticle", "article-newspaper": "newspaperArticle",
	article: "preprint", book: "book", chapter: "bookSection", "paper-conference": "conferencePaper", thesis: "thesis",
	report: "report", webpage: "webpage", "post-weblog": "blogPost", post: "forumPost", patent: "patent", software: "computerProgram",
	dataset: "dataset", manuscript: "manuscript", map: "map", graphic: "artwork", legal_case: "case", legislation: "statute",
	bill: "bill", hearing: "hearing", interview: "interview", personal_communication: "letter", song: "audioRecording",
	broadcast: "tvBroadcast", motion_picture: "film", speech: "presentation", standard: "standard",
	"entry-encyclopedia": "encyclopediaArticle", "entry-dictionary": "dictionaryEntry", entry: "encyclopediaArticle",
	pamphlet: "document", review: "journalArticle", "review-book": "journalArticle", figure: "artwork", treaty: "document",
	musical_score: "document", document: "document",
};

type CslName = { family?: string; given?: string; literal?: string; "dropping-particle"?: string; "non-dropping-particle"?: string; suffix?: string };

function cslNames(v: unknown, ct: string, itemType: string, ...fb: string[]): Creator[] {
	if (!Array.isArray(v)) return [];
	const type = creatorTypeFor(itemType, ct, ...fb);
	const out: Creator[] = [];
	for (const n of v as CslName[]) {
		if (!n || typeof n !== "object") continue;
		if (n.literal) out.push({ creatorType: type, name: n.literal });
		else {
			const family = [n["non-dropping-particle"], n.family].filter(Boolean).join(" ").trim();
			const given = [n.given, n["dropping-particle"]].filter(Boolean).join(" ").trim();
			if (family || given) out.push({ creatorType: type, lastName: family, firstName: given });
		}
	}
	return out;
}

function cslDate(v: unknown): string {
	if (!v) return "";
	if (typeof v === "string") return normalizeDate(v);
	const o = v as { "date-parts"?: unknown[][]; raw?: string; literal?: string };
	const p = o["date-parts"]?.[0];
	if (Array.isArray(p) && p.length) {
		const [y, m, d] = p.map((x) => Number(x));
		if (Number.isFinite(y)) return isoDate(y!, Number.isFinite(m) ? m : null, Number.isFinite(d) ? d : null);
	}
	return normalizeDate(String(o.raw ?? o.literal ?? ""));
}

const s = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

export function cslToItem(c: Record<string, any>): ParsedItem | null {
	let itemType = CSL_TO_TYPE[String(c.type)] ?? "document";
	if (itemType === "preprint" && !(c.DOI || c.URL || c.number || /arxiv|preprint/i.test(`${c.publisher ?? ""} ${c.source ?? ""} ${c.genre ?? ""}`))) itemType = "document";
	const data: Partial<ZoteroItemData> & { itemType: string } = { itemType };
	const notes: string[] = [];
	setBase(data, "title", s(c.title));
	setBase(data, "publicationTitle", s(c["container-title"]));
	setBase(data, "journalAbbreviation", s(c["container-title-short"]));
	setBase(data, "shortTitle", s(c["title-short"]));
	setFirst(data, ["seriesTitle", "series"], s(c["collection-title"]));
	setBase(data, "seriesNumber", s(c["collection-number"]));
	setBase(data, "volume", s(c.volume));
	setFirst(data, ["issue", "reportNumber", "patentNumber", "number"], s(c.issue ?? c.number));
	if (c.issue !== undefined && c.number !== undefined) setFirst(data, ["number", "reportNumber", "patentNumber"], s(c.number));
	setBase(data, "pages", s(c.page).replace(/-+/g, "–"));
	setBase(data, "numPages", s(c["number-of-pages"]));
	setBase(data, "numberOfVolumes", s(c["number-of-volumes"]));
	setBase(data, "edition", s(c.edition));
	setBase(data, "publisher", s(c.publisher));
	setBase(data, "place", s(c["publisher-place"] ?? c["event-place"]));
	setBase(data, "abstractNote", s(c.abstract));
	setBase(data, "DOI", s(c.DOI).replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, ""));
	setBase(data, "url", s(c.URL));
	setBase(data, "ISBN", s(c.ISBN));
	setBase(data, "ISSN", s(c.ISSN));
	setBase(data, "language", s(c.language));
	setBase(data, "archive", s(c.archive));
	setBase(data, "archiveLocation", s(c.archive_location));
	setBase(data, "callNumber", s(c["call-number"]));
	setBase(data, "libraryCatalog", s(c.source));
	setBase(data, "conferenceName", s(c.event ?? c["event-title"]));
	setBase(data, "type", s(c.genre));
	setBase(data, "medium", s(c.medium));
	const issued = cslDate(c.issued);
	if (issued) setBase(data, "date", issued);
	const accessed = cslDate(c.accessed);
	if (accessed) setBase(data, "accessDate", accessed);
	if (c.PMID) setBase(data, "PMID", s(c.PMID)) || appendExtra(data, `PMID: ${s(c.PMID)}`);
	if (c.PMCID) setBase(data, "PMCID", s(c.PMCID)) || appendExtra(data, `PMCID: ${s(c.PMCID)}`);
	const ck = s(c["citation-key"]);
	if (ck && !setBase(data, "citationKey", ck)) appendExtra(data, `Citation Key: ${ck}`);
	if (c.note) {
		const note = s(c.note);
		if (note) appendExtra(data, note);
	}
	if (itemType === "thesis" && !data.thesisType) setBase(data, "type", "Thesis");

	const creators = [
		...cslNames(c.author, "author", itemType),
		...cslNames(c.editor, "editor", itemType, "contributor"),
		...cslNames(c.translator, "translator", itemType, "contributor"),
		...cslNames(c["container-author"], "bookAuthor", itemType, "contributor"),
		...cslNames(c["collection-editor"], "seriesEditor", itemType, "editor", "contributor"),
		...cslNames(c.director, "director", itemType, "contributor"),
		...cslNames(c.interviewer, "interviewer", itemType, "contributor"),
		...cslNames(c["reviewed-author"], "reviewedAuthor", itemType, "contributor"),
	];
	if (creators.length) data.creators = creators;
	const kw = c.keyword ?? c.keywords;
	if (kw) {
		const list = Array.isArray(kw) ? kw.map(String) : splitKeywords(String(kw));
		data.tags = list.filter(Boolean).map((tag) => ({ tag }));
	}
	if (c.annote) notes.push(textToNoteHtml(s(c.annote)));
	if (!data.title && !creators.length && !issued) return null;
	return { data, notes };
}

export function parseCslJson(text: string): { items: ParsedItem[]; errors: string[] } {
	const errors: string[] = [];
	let json: unknown;
	try {
		json = JSON.parse(text.replace(/^﻿/, ""));
	} catch (e) {
		return { items: [], errors: [`invalid JSON: ${e instanceof Error ? e.message : e}`] };
	}
	let list: unknown[];
	if (Array.isArray(json)) list = json;
	else if (json && typeof json === "object" && Array.isArray((json as any).items)) list = (json as any).items;
	else if (json && typeof json === "object") list = [json];
	else return { items: [], errors: ["CSL-JSON must be an array of items"] };
	const items: ParsedItem[] = [];
	list.forEach((o, i) => {
		if (!o || typeof o !== "object") return void errors.push(`entry ${i + 1} is not an object`);
		try {
			const it = cslToItem(o as Record<string, unknown>);
			if (it) items.push(it);
			else errors.push(`entry ${i + 1} has no title, author or date`);
		} catch (e) {
			errors.push(`entry ${i + 1}: ${e instanceof Error ? e.message : e}`);
		}
	});
	return { items, errors };
}

export function exportCslJson(items: ExportItem[]): string {
	const keys = citationKeys(items.map((i) => i.data));
	const out = items.map((it, i) => {
		const csl = itemToCsl(it.data) as Record<string, unknown>;
		csl.id = keys[i]!;
		csl["citation-key"] = keys[i]!;
		if (it.tags.length) csl.keyword = it.tags.join(", ");
		if (it.notes.length) csl.annote = it.notes.join("\n\n");
		return csl;
	});
	return JSON.stringify(out, null, 2) + "\n";
}
