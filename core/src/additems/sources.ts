// Metadata sources for "add by identifier": PubMed (E-utilities efetch), Europe PMC (PMCID), arXiv (Atom), OpenLibrary and
// Google Books (ISBN). Crossref (DOI) lives in references/add.ts. All network calls go through references/net.ts (mockable).
import type { Database } from "bun:sqlite";
import type { ZoteroItemData } from "../api-types";
import { crossrefToItem } from "../references/add";
import { normalizeDoi } from "../references/ids";
import { NetError, USER_AGENT, getJson, mailtoFor, net, withMailto } from "../references/net";
import { compact, crossrefWork, stripMarkup } from "../references/sources";

type Creator = NonNullable<ZoteroItemData["creators"]>[number];
export type ItemData = Partial<ZoteroItemData>;

/** GET text with the shared fetch (timeout + retries on 429/5xx). Returns null on 404. */
export async function getText(url: string, accept = "application/xml, text/xml, */*"): Promise<string | null> {
	let last: unknown;
	for (let attempt = 0; attempt <= net.retries; attempt++) {
		try {
			const res = await net.fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: accept }, signal: AbortSignal.timeout(net.timeoutMs) });
			if (res.status === 404) return null;
			if (res.status === 429 || res.status >= 500) {
				last = new NetError(res.status, `${res.status} from ${new URL(url).host}`);
				if (attempt < net.retries) await new Promise((r) => setTimeout(r, net.backoffMs * 2 ** attempt));
				continue;
			}
			if (!res.ok) throw new NetError(res.status, `${res.status} from ${new URL(url).host}`);
			return await res.text();
		} catch (e) {
			if (e instanceof NetError && e.status < 500 && e.status !== 429) throw e;
			last = e;
			if (attempt < net.retries) await new Promise((r) => setTimeout(r, net.backoffMs * 2 ** attempt));
		}
	}
	throw last instanceof Error ? last : new Error(String(last));
}

// ---------------------------------------------------------------- tiny XML helpers

const decodeEntities = (s: string) =>
	s
		.replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");

/** Text of every <tag ...>...</tag> (tags stripped, entities decoded, whitespace collapsed). */
export function xmlAll(xml: string, tag: string): string[] {
	const out: string[] = [];
	const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
	for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(decodeEntities(m[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim());
	return out;
}
export const xmlOne = (xml: string, tag: string): string | undefined => xmlAll(xml, tag)[0] || undefined;
/** Raw inner XML blocks of every <tag>. */
export function xmlBlocks(xml: string, tag: string): string[] {
	const out: string[] = [];
	const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
	for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1]);
	return out;
}
function xmlAttr(xml: string, tag: string, attr: string, where?: string): string | undefined {
	const re = new RegExp(`<${tag}\\s[^>]*${where ? where + "[^>]*" : ""}\\b${attr}="([^"]*)"`, "i");
	return xml.match(re)?.[1];
}

function splitName(full: string): Creator {
	const t = full.trim();
	if (t.includes(",")) {
		const [last, first] = t.split(",", 2);
		return { creatorType: "author", firstName: (first ?? "").trim(), lastName: last.trim() };
	}
	const parts = t.split(/\s+/);
	if (parts.length < 2) return { creatorType: "author", name: t };
	return { creatorType: "author", firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

// ---------------------------------------------------------------- PubMed

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

function pubmedDate(article: string): string | undefined {
	const d = xmlBlocks(article, "PubDate")[0];
	if (d) {
		const y = xmlOne(d, "Year");
		const m = xmlOne(d, "Month");
		const day = xmlOne(d, "Day");
		if (y) {
			const mm = m ? (/^\d+$/.test(m) ? m.padStart(2, "0") : MONTHS[m.slice(0, 3).toLowerCase()]) : undefined;
			return [y, mm, mm && day ? day.padStart(2, "0") : undefined].filter(Boolean).join("-");
		}
		const medline = xmlOne(d, "MedlineDate");
		const my = medline?.match(/\d{4}/)?.[0];
		if (my) return my;
	}
	return undefined;
}

export function pubmedToItem(article: string): ItemData {
	const med = xmlBlocks(article, "MedlineCitation")[0] ?? article;
	const pmid = xmlOne(med, "PMID");
	const art = xmlBlocks(med, "Article")[0] ?? med;
	const creators: Creator[] = [];
	for (const a of xmlBlocks(art, "Author")) {
		const last = xmlOne(a, "LastName");
		const first = xmlOne(a, "ForeName") ?? xmlOne(a, "Initials");
		const coll = xmlOne(a, "CollectiveName");
		if (last) creators.push({ creatorType: "author", firstName: first ?? "", lastName: last });
		else if (coll) creators.push({ creatorType: "author", name: coll });
	}
	const abstractParts: string[] = [];
	const absRe = /<AbstractText\b([^>]*)>([\s\S]*?)<\/AbstractText>/g;
	for (let m = absRe.exec(art); m; m = absRe.exec(art)) {
		const label = m[1].match(/\bLabel="([^"]*)"/)?.[1];
		const text = decodeEntities(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
		if (text) abstractParts.push(label ? `${decodeEntities(label)}: ${text}` : text);
	}
	const ids = xmlBlocks(article, "PubmedData")[0] ?? "";
	const doi = normalizeDoi(
		(ids.match(/<ArticleId\s+IdType="doi">([^<]+)</)?.[1]) ?? (art.match(/<ELocationId[^>]*EIdType="doi"[^>]*>([^<]+)</)?.[1]),
	);
	const pmcid = ids.match(/<ArticleId\s+IdType="pmc">([^<]+)</)?.[1];
	const journal = xmlBlocks(art, "Journal")[0] ?? "";
	const issn = xmlOne(journal, "ISSN");
	const extraLines = [pmid ? `PMID: ${pmid}` : "", pmcid ? `PMCID: ${pmcid}` : ""].filter(Boolean).join("\n");
	return {
		itemType: "journalArticle",
		...compact({
			title: stripMarkup(xmlOne(art, "ArticleTitle") ?? "").replace(/\.$/, ""),
			creators,
			abstractNote: abstractParts.join("\n\n"),
			publicationTitle: xmlOne(journal, "Title"),
			journalAbbreviation: xmlOne(med, "ISOAbbreviation") ?? xmlOne(journal, "ISOAbbreviation"),
			volume: xmlOne(journal, "Volume"),
			issue: xmlOne(journal, "Issue"),
			pages: xmlOne(art, "MedlinePgn"),
			date: pubmedDate(art),
			DOI: doi ?? undefined,
			ISSN: issn,
			language: xmlOne(art, "Language"),
			url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : undefined,
			extra: extraLines,
		}),
	} as ItemData;
}

export async function fetchPubmed(pmid: string, db: Database): Promise<ItemData | null> {
	const url = withMailto(`${EUTILS}/efetch.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}&retmode=xml`, mailtoFor(db));
	const xml = await getText(url);
	if (!xml) return null;
	const art = xmlBlocks(xml, "PubmedArticle")[0] ?? xmlBlocks(xml, "PubmedBookArticle")[0];
	if (!art) return null;
	const item = pubmedToItem(art);
	return item.title ? item : null;
}

// ---------------------------------------------------------------- Europe PMC (PMCID)

export function europePmcToItem(r: any): ItemData {
	const creators: Creator[] = (r.authorList?.author ?? []).map((a: any) =>
		a.lastName ? { creatorType: "author", firstName: a.firstName ?? a.initials ?? "", lastName: a.lastName } : a.collectiveName ? { creatorType: "author", name: a.collectiveName } : splitName(a.fullName ?? ""),
	);
	const j = r.journalInfo ?? {};
	const doi = normalizeDoi(r.doi);
	const extra = [r.pmid ? `PMID: ${r.pmid}` : "", r.pmcid ? `PMCID: ${r.pmcid}` : ""].filter(Boolean).join("\n");
	return {
		itemType: "journalArticle",
		...compact({
			title: stripMarkup(String(r.title ?? "")).replace(/\.$/, ""),
			creators,
			abstractNote: r.abstractText ? stripMarkup(String(r.abstractText)) : undefined,
			publicationTitle: j.journal?.title,
			journalAbbreviation: j.journal?.isoabbreviation,
			volume: j.volume,
			issue: j.issue,
			pages: r.pageInfo,
			date: r.firstPublicationDate ?? (j.yearOfPublication ? String(j.yearOfPublication) : r.pubYear),
			DOI: doi ?? undefined,
			ISSN: j.journal?.issn,
			url: r.pmcid ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${r.pmcid}/` : doi ? `https://doi.org/${doi}` : undefined,
			extra,
		}),
	} as ItemData;
}

export async function fetchPmc(pmcid: string): Promise<ItemData | null> {
	const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(`PMCID:${pmcid}`)}&format=json&resultType=core&pageSize=1`;
	const res = await getJson<{ resultList?: { result?: any[] } }>(url);
	const r = res?.resultList?.result?.[0];
	if (!r?.title) return null;
	return europePmcToItem(r);
}

// ---------------------------------------------------------------- arXiv

export function arxivToItem(entry: string, id: string): ItemData {
	const creators: Creator[] = xmlBlocks(entry, "author").map((a) => splitName(xmlOne(a, "name") ?? "")).filter((c) => c.name || c.lastName);
	const doi = normalizeDoi(xmlOne(entry, "arxiv:doi"));
	const published = xmlOne(entry, "published")?.slice(0, 10);
	const category = xmlAttr(entry, "arxiv:primary_category", "term") ?? xmlAttr(entry, "category", "term");
	const journalRef = xmlOne(entry, "arxiv:journal_ref");
	const extra = [`arXiv:${id}${category ? ` [${category}]` : ""}`, journalRef ? `Journal reference: ${journalRef}` : ""].filter(Boolean).join("\n");
	return {
		itemType: "preprint",
		...compact({
			title: xmlOne(entry, "title"),
			creators,
			abstractNote: xmlOne(entry, "summary"),
			date: published,
			repository: "arXiv",
			archiveID: `arXiv:${id}`,
			DOI: doi ?? `10.48550/arXiv.${id}`,
			url: `https://arxiv.org/abs/${id}`,
			extra,
		}),
	} as ItemData;
}

export async function fetchArxiv(id: string): Promise<ItemData | null> {
	const xml = await getText(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`, "application/atom+xml, application/xml");
	if (!xml) return null;
	const entry = xmlBlocks(xml, "entry")[0];
	if (!entry) return null;
	const title = xmlOne(entry, "title");
	// arXiv answers unknown IDs with an "Error" entry
	if (!title || /^error$/i.test(title) || /api\/errors/.test(entry)) return null;
	return arxivToItem(entry, id);
}

// ---------------------------------------------------------------- ISBN

export function openLibraryToItem(b: any, isbn: string): ItemData {
	const creators: Creator[] = (b.authors ?? []).map((a: any) => splitName(a.name ?? ""));
	const publisher = b.publishers?.[0]?.name;
	const place = b.publish_places?.[0]?.name;
	return {
		itemType: "book",
		...compact({
			title: b.subtitle ? `${b.title}: ${b.subtitle}` : b.title,
			creators,
			date: b.publish_date,
			publisher,
			place,
			numPages: b.number_of_pages ? String(b.number_of_pages) : undefined,
			ISBN: isbn,
			url: b.url,
		}),
	} as ItemData;
}

export function googleBooksToItem(v: any, isbn: string): ItemData {
	const creators: Creator[] = (v.authors ?? []).map((a: string) => splitName(a));
	return {
		itemType: "book",
		...compact({
			title: v.subtitle ? `${v.title}: ${v.subtitle}` : v.title,
			creators,
			date: v.publishedDate,
			publisher: v.publisher,
			numPages: v.pageCount ? String(v.pageCount) : undefined,
			abstractNote: v.description ? stripMarkup(String(v.description)) : undefined,
			language: v.language,
			ISBN: isbn,
			url: v.canonicalVolumeLink ?? v.infoLink,
		}),
	} as ItemData;
}

export async function fetchIsbn(isbn: string): Promise<ItemData | null> {
	try {
		const res = await getJson<Record<string, any>>(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
		const b = res?.[`ISBN:${isbn}`];
		if (b?.title) return openLibraryToItem(b, isbn);
	} catch {
		/* fall through to Google Books */
	}
	const g = await getJson<{ items?: { volumeInfo?: any }[] }>(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=1`);
	const v = g?.items?.[0]?.volumeInfo;
	return v?.title ? googleBooksToItem(v, isbn) : null;
}

// ---------------------------------------------------------------- DOI

export async function fetchDoi(doi: string, db: Database): Promise<ItemData | null> {
	const arx = doi.match(/^10\.48550\/arxiv\.(.+)$/i);
	if (arx) {
		const a = await fetchArxiv(arx[1]).catch(() => null);
		if (a) return a;
	}
	const m = await crossrefWork(doi, mailtoFor(db));
	if (!m) return null;
	const item = crossrefToItem(m, doi);
	return item.title ? item : null;
}
