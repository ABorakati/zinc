// EndNote XML import (File > Export > XML).
import type { Creator, ZoteroItemData } from "../api-types";
import { appendExtra, creatorTypeFor, decodeEntities, normalizeDate, setBase, setFirst, splitKeywords, textToNoteHtml, type ParsedItem } from "./common";

interface XNode {
	name: string;
	attrs: Record<string, string>;
	children: XNode[];
	text: string; // direct + descendant text (styles flattened)
}

/** Minimal XML reader: elements, attributes, text, CDATA. Enough for EndNote exports. */
function parseXml(xml: string): XNode {
	const root: XNode = { name: "#root", attrs: {}, children: [], text: "" };
	const stack: XNode[] = [root];
	const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
	let m: RegExpExecArray | null;
	const addText = (t: string) => {
		for (const n of stack) n.text += t;
	};
	while ((m = re.exec(xml))) {
		if (m[1] !== undefined) addText(m[1]);
		else if (m[6] !== undefined) addText(decodeEntities(m[6]));
		else if (m[3]) {
			if (m[2]) {
				if (stack.length > 1) stack.pop();
			} else {
				const attrs: Record<string, string> = {};
				for (const a of m[4]!.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? "");
				const node: XNode = { name: m[3]!, attrs, children: [], text: "" };
				stack[stack.length - 1]!.children.push(node);
				if (!m[5]) stack.push(node);
			}
		}
	}
	return root;
}

const find = (n: XNode, ...path: string[]): XNode[] => {
	let cur = [n];
	for (const p of path) cur = cur.flatMap((c) => c.children.filter((k) => k.name === p));
	return cur;
};
const txt = (n: XNode | undefined) => (n ? n.text.replace(/\s+/g, " ").trim() : "");

const TYPES: Record<string, string> = {
	"journal article": "journalArticle", "book": "book", "edited book": "book", "book section": "bookSection",
	"conference proceedings": "conferencePaper", "conference paper": "conferencePaper", "thesis": "thesis", "report": "report",
	"web page": "webpage", "electronic article": "journalArticle", "magazine article": "magazineArticle",
	"newspaper article": "newspaperArticle", "patent": "patent", "computer program": "computerProgram", "generic": "document",
	"manuscript": "manuscript", "unpublished work": "manuscript", "dataset": "dataset", "blog": "blogPost", "film or broadcast": "film",
	"artwork": "artwork", "map": "map", "online database": "document", "online multimedia": "videoRecording",
};
const TYPE_BY_NUMBER: Record<string, string> = {
	"17": "journalArticle", "6": "book", "28": "book", "5": "bookSection", "10": "conferencePaper", "47": "conferencePaper",
	"32": "thesis", "27": "report", "12": "webpage", "19": "magazineArticle", "23": "newspaperArticle", "25": "patent",
	"9": "computerProgram", "13": "document", "36": "manuscript", "59": "dataset", "56": "blogPost", "21": "film", "2": "artwork",
};

function recordToItem(rec: XNode): ParsedItem | null {
	const rt = find(rec, "ref-type")[0];
	const typeName = (rt?.attrs.name ?? txt(rt)).toLowerCase();
	const itemType = TYPES[typeName] ?? TYPE_BY_NUMBER[txt(rt)] ?? "journalArticle";
	const data: Partial<ZoteroItemData> & { itemType: string } = { itemType };
	const notes: string[] = [];
	const one = (...path: string[]) => txt(find(rec, ...path)[0]);

	setBase(data, "title", one("titles", "title"));
	const secondary = one("titles", "secondary-title");
	const periodical = one("periodical", "full-title");
	if (!setBase(data, "publicationTitle", periodical || secondary) && secondary) setFirst(data, ["series", "seriesTitle"], secondary);
	if (periodical && secondary && itemType === "bookSection") setBase(data, "publicationTitle", secondary, true);
	setBase(data, "journalAbbreviation", one("periodical", "abbr-1"));
	setBase(data, "shortTitle", one("titles", "short-title"));
	setFirst(data, ["seriesTitle", "series"], one("titles", "tertiary-title"));
	setBase(data, "pages", one("pages").replace(/\s*-\s*/g, "–"));
	setBase(data, "volume", one("volume"));
	setFirst(data, ["issue", "reportNumber", "patentNumber", "seriesNumber"], one("number"));
	setBase(data, "edition", one("edition"));
	setBase(data, "publisher", one("publisher"));
	setBase(data, "place", one("pub-location"));
	setBase(data, "abstractNote", one("abstract"));
	setBase(data, "language", one("language"));
	setBase(data, "callNumber", one("call-num"));
	setBase(data, "archiveLocation", one("accession-num"));
	const doiRaw = one("electronic-resource-num");
	const doi = doiRaw.replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, "");
	if (/^10\.\d{4,9}\//.test(doi)) setBase(data, "DOI", doi);
	else if (doiRaw) appendExtra(data, doiRaw);
	for (const sn of find(rec, "isbn")) {
		const v = txt(sn);
		if (/^\d{4}-?\d{3}[\dXx]$/.test(v)) setBase(data, "ISSN", v);
		else setBase(data, "ISBN", v);
	}
	const url = find(rec, "urls", "related-urls", "url")[0];
	setBase(data, "url", txt(url));
	if (itemType === "thesis") setBase(data, "type", one("work-type") || "Thesis");
	else setBase(data, "type", one("work-type"));

	const year = one("dates", "year");
	const pub = one("dates", "pub-dates", "date");
	let date = "";
	if (year && /^\d{4}$/.test(year)) {
		const full = normalizeDate(`${year} ${pub.replace(/\b\d{4}\b/, "").trim()}`.trim());
		date = /^\d{4}-\d{2}/.test(full) ? full : year;
	} else date = normalizeDate(pub || year);
	if (date) setBase(data, "date", date);

	const creators: Creator[] = [];
	const names = (path: string[], wanted: string, ...fb: string[]) => {
		for (const a of find(rec, ...path)) {
			const v = txt(a);
			if (!v) continue;
			const ct = creatorTypeFor(itemType, wanted, ...fb);
			if (v.includes(",")) {
				const [last, ...rest] = v.split(",");
				creators.push({ creatorType: ct, lastName: last!.trim(), firstName: rest.join(",").trim() });
			} else creators.push({ creatorType: ct, name: v });
		}
	};
	names(["contributors", "authors", "author"], "author");
	names(["contributors", "secondary-authors", "author"], "editor", "contributor");
	names(["contributors", "tertiary-authors", "author"], "seriesEditor", "editor", "contributor");
	names(["contributors", "translated-authors", "author"], "translator", "contributor");
	if (creators.length) data.creators = creators;

	const kws = find(rec, "keywords", "keyword").map(txt).flatMap((k) => (k.includes(";") ? splitKeywords(k) : [k])).filter(Boolean);
	if (kws.length) data.tags = [...new Set(kws)].map((tag) => ({ tag }));
	const note = one("notes");
	if (note) notes.push(textToNoteHtml(note));
	const research = one("research-notes");
	if (research) notes.push(textToNoteHtml(research));

	if (!data.title && !creators.length && !date) return null;
	return { data, notes };
}

export function parseEndnoteXml(text: string): { items: ParsedItem[]; errors: string[] } {
	const items: ParsedItem[] = [];
	const errors: string[] = [];
	let root: XNode;
	try {
		root = parseXml(text.replace(/^﻿/, ""));
	} catch (e) {
		return { items, errors: [`invalid XML: ${e instanceof Error ? e.message : e}`] };
	}
	const recs: XNode[] = [];
	const walk = (n: XNode) => {
		for (const c of n.children) {
			if (c.name === "record") recs.push(c);
			else walk(c);
		}
	};
	walk(root);
	recs.forEach((r, i) => {
		try {
			const it = recordToItem(r);
			if (it) items.push(it);
			else errors.push(`record ${i + 1} has no title, author or date`);
		} catch (e) {
			errors.push(`record ${i + 1}: ${e instanceof Error ? e.message : e}`);
		}
	});
	return { items, errors };
}
