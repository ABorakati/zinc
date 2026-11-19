// PubMed / MEDLINE (.nbib, "PubMed" format) import.
import type { Creator, ZoteroItemData } from "../api-types";
import { appendExtra, normalizeDate, setBase, type ParsedItem } from "./common";

export function parseNbib(text: string): { items: ParsedItem[]; errors: string[] } {
	const items: ParsedItem[] = [];
	const errors: string[] = [];
	const records: [string, string][][] = [];
	let cur: [string, string][] | null = null;
	let last: [string, string] | null = null;
	for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
		const m = /^([A-Z][A-Z0-9]{1,3})\s*-\s?(.*)$/.exec(line);
		if (m) {
			if (m[1] === "PMID" || !cur) {
				cur = [];
				records.push(cur);
			}
			last = [m[1]!, m[2]!.trim()];
			cur.push(last);
		} else if (/^\s{4,}\S/.test(line) && last) {
			last[1] += " " + line.trim();
		} else if (!line.trim()) last = null;
	}
	records.forEach((rec, i) => {
		try {
			const it = nbibToItem(rec);
			if (it) items.push(it);
			else errors.push(`record ${i + 1} has no title`);
		} catch (e) {
			errors.push(`record ${i + 1}: ${e instanceof Error ? e.message : e}`);
		}
	});
	return { items, errors };
}

function nbibToItem(rec: [string, string][]): ParsedItem | null {
	const all = (t: string) => rec.filter(([k]) => k === t).map(([, v]) => v);
	const one = (t: string) => all(t)[0] ?? "";
	const data: Partial<ZoteroItemData> & { itemType: string } = { itemType: "journalArticle" };
	const title = one("TI").replace(/\.$/, "");
	setBase(data, "title", title || one("BTI"));
	setBase(data, "abstractNote", one("AB"));
	setBase(data, "publicationTitle", one("JT"));
	setBase(data, "journalAbbreviation", one("TA"));
	setBase(data, "volume", one("VI"));
	setBase(data, "issue", one("IP"));
	setBase(data, "pages", one("PG").replace(/-/g, "–"));
	setBase(data, "ISSN", one("IS").replace(/\s*\(.*\)\s*$/, ""));
	setBase(data, "language", one("LA"));
	setBase(data, "place", one("PL"));
	const date = normalizeDate(
		one("DP")
			.replace(/\s+\d{1,2}\s*-\s*\S+$/, "")
			.replace(/\s*-\s*\S+$/, ""),
	);
	if (date) setBase(data, "date", date);
	let doi = "";
	for (const v of [...all("LID"), ...all("AID")]) {
		const m = /^(\S+)\s*\[doi\]/i.exec(v);
		if (m) {
			doi = m[1]!;
			break;
		}
	}
	setBase(data, "DOI", doi);
	const pmid = one("PMID");
	if (pmid) setBase(data, "PMID", pmid) || appendExtra(data, `PMID: ${pmid}`);
	const pmc = one("PMC");
	if (pmc) setBase(data, "PMCID", pmc) || appendExtra(data, `PMCID: ${pmc}`);
	if (pmid && !data.url) setBase(data, "url", `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`);

	const full = all("FAU");
	const abbr = all("AU");
	const creators: Creator[] = [];
	/** A name as last + first; an empty line is no creator, and a lone given name becomes the last name (never an empty one). */
	const person = (creatorType: string, last: string | undefined, first: string | undefined): void => {
		const l = (last ?? "").trim();
		const f = (first ?? "").trim();
		if (!l && !f) return;
		creators.push(l ? { creatorType, lastName: l, firstName: f } : { creatorType, lastName: f, firstName: "" });
	};
	if (full.some((n) => n.trim())) {
		for (const n of full) {
			const [last, first] = n.split(/,\s*/, 2);
			person("author", last, first);
		}
	} else {
		for (const n of abbr) {
			const m = /^(.*)\s+(\S+)$/.exec(n.trim());
			person("author", m ? m[1] : n, m ? m[2] : "");
		}
	}
	for (const n of all("FED")) {
		const [last, first] = n.split(/,\s*/, 2);
		person("editor", last, first);
	}
	if (creators.length) data.creators = creators;
	const tags = [...all("MH"), ...all("OT"), ...all("KW")].map((t) => t.replace(/^\*/, "").trim()).filter(Boolean);
	if (tags.length) data.tags = [...new Set(tags)].map((tag) => ({ tag }));
	if (!data.title) return null;
	return { data, notes: [] };
}
