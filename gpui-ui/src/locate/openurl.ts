// Pure helpers behind the Locate menu: the item's web address, a Google Scholar search for its title, and the OpenURL 1.0
// (Z39.88-2004 / KEV) link the user's resolver opens. No app state, no I/O: unit-tested in openurl.test.ts.
//
// OpenURL field names follow Zotero's OpenURL.createContextObject (xpcom/openurl.js): journal articles use the journal
// format, books and chapters the book format, and the identifiers travel as repeated rft_id values.

export interface LocateCreator {
	creatorType?: string;
	firstName?: string;
	lastName?: string;
	/** Single-field name ("Aristotle", "World Health Organization"). */
	name?: string;
}

/** The item fields the Locate menu reads (Zotero's item data, or a summary row filled in from its `fields`). */
export interface LocateItem {
	itemType: string;
	title?: string;
	DOI?: string;
	url?: string;
	date?: string;
	publicationTitle?: string;
	journalAbbreviation?: string;
	bookTitle?: string;
	proceedingsTitle?: string;
	containerTitle?: string;
	volume?: string;
	issue?: string;
	pages?: string;
	ISSN?: string;
	ISBN?: string;
	PMID?: string;
	extra?: string;
	creators?: LocateCreator[];
}

/** A lone surrogate (it happens in metadata copied from PDFs) makes encodeURI / encodeURIComponent throw a URIError: U+FFFD instead. */
export const wellFormed = (s: string): string => s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�");
const text = (v: unknown): string => (typeof v === "string" ? wellFormed(v.trim()) : typeof v === "number" ? String(v) : "");

/** Book-format item types (info:ofi/fmt:kev:mtx:book), including chapters and reports; all others use the journal format. */
const BOOK_TYPES: Record<string, true> = {
	book: true,
	bookSection: true,
	encyclopediaArticle: true,
	dictionaryEntry: true,
	thesis: true,
	report: true,
};

/** OpenURL genre (rft.genre) per Zotero item type. */
const GENRE: Record<string, string> = {
	journalArticle: "article",
	magazineArticle: "article",
	newspaperArticle: "article",
	conferencePaper: "conference",
	preprint: "preprint",
	book: "book",
	bookSection: "bookitem",
	encyclopediaArticle: "bookitem",
	dictionaryEntry: "bookitem",
	thesis: "dissertation",
	report: "report",
	manuscript: "document",
	webpage: "document",
	blogPost: "document",
	document: "document",
};

/** "doi:10.1/x", "https://doi.org/10.1/x" and "10.1/x" all become "10.1/x". */
export function normalizeDoi(raw: unknown): string {
	return text(raw)
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
		.replace(/^doi:\s*/i, "")
		.trim();
}

/** The item's URL (http/https only), else https://doi.org/<DOI>; null when it has neither. */
export function viewOnlineUrl(item: Pick<LocateItem, "url" | "DOI">): string | null {
	const url = text(item.url);
	if (/^https?:\/\//i.test(url)) return url;
	const doi = normalizeDoi(item.DOI);
	return doi ? "https://doi.org/" + encodeURI(doi) : null;
}

/** Google Scholar search for the item's title (Zotero's Locate > Search Google Scholar). */
export function googleScholarUrl(title: string | undefined): string | null {
	const q = text(title);
	return q ? "https://scholar.google.com/scholar?q=" + encodeURIComponent(q) : null;
}

/** PMID from the field, else from an "PMID: 1234" line of Extra. */
export function pmidOf(item: Pick<LocateItem, "PMID" | "extra">): string {
	const direct = text(item.PMID);
	if (direct) return direct;
	return /^\s*PMID:\s*(\d+)\b/im.exec(text(item.extra))?.[1] ?? "";
}

/** "123-145", "123–145" and "123--145" split; a single page ("e1001744", "A12") stays as spage. */
export function pageRange(pages: string | undefined): { spage?: string; epage?: string } {
	const s = text(pages);
	if (!s) return {};
	const m = /^(\S+?)\s*(?:[-–—]+|\bto\b)\s*(\S+)$/i.exec(s);
	if (!m || /\s/.test(m[1]! + m[2]!)) return { spage: s };
	return { spage: m[1], epage: m[2] };
}

/** True when the item has enough to ask a resolver about (a title, a standard number or an identifier). */
export function hasLookupData(item: LocateItem): boolean {
	return !!(
		text(item.title) ||
		normalizeDoi(item.DOI) ||
		text(item.ISSN) ||
		text(item.ISBN) ||
		text(item.publicationTitle) ||
		text(item.bookTitle)
	);
}

/**
 * The OpenURL 1.0 (KEV) query for the item, without the resolver address: `url_ver`, `ctx_ver`, `rft_val_fmt`, `rft.genre`,
 * the title fields, the container, volume/issue/pages/date, ISSN/ISBN, the first creator and the DOI/PMID `rft_id`s.
 */
export function openUrlParams(item: LocateItem): [string, string][] {
	const jtitle = text(item.publicationTitle) || text(item.journalAbbreviation) || text(item.proceedingsTitle);
	// own-property lookups: an item type of "constructor" or "toString" must not find Object.prototype members
	const journal = !Object.hasOwn(BOOK_TYPES, item.itemType);
	const out: [string, string][] = [];
	const put = (k: string, v: string | undefined) => {
		const s = text(v);
		if (s) out.push([k, s]);
	};

	out.push(["url_ver", "Z39.88-2004"]);
	out.push(["ctx_ver", "Z39.88-2004"]);
	out.push(["rft_val_fmt", journal ? "info:ofi/fmt:kev:mtx:journal" : "info:ofi/fmt:kev:mtx:book"]);
	out.push(["rft.genre", Object.hasOwn(GENRE, item.itemType) ? GENRE[item.itemType]! : "document"]);

	// title: article/chapter title in atitle, book title in btitle
	if (journal) put("rft.atitle", item.title);
	else if (item.itemType === "bookSection" || item.itemType === "encyclopediaArticle" || item.itemType === "dictionaryEntry") {
		put("rft.atitle", item.title);
		put("rft.btitle", text(item.bookTitle));
	} else put("rft.btitle", item.title);

	if (journal) put("rft.jtitle", jtitle || text(item.containerTitle));
	put("rft.volume", item.volume);
	put("rft.issue", item.issue);

	const { spage, epage } = pageRange(item.pages);
	put("rft.spage", spage);
	put("rft.epage", epage);

	put("rft.date", item.date);
	put("rft.issn", item.ISSN);
	put("rft.isbn", item.ISBN);

	const creators = Array.isArray(item.creators) ? item.creators.filter((c) => c && typeof c === "object") : [];
	const creator = creators.find((c) => text(c.lastName) || text(c.name)) ?? creators[0];
	if (creator) {
		const last = text(creator.lastName) || text(creator.name);
		if (last) out.push(["rft.aulast", last]);
		put("rft.aufirst", creator.firstName);
	}

	const doi = normalizeDoi(item.DOI) || normalizeDoi(/^\s*DOI:\s*(\S+)\s*$/im.exec(text(item.extra))?.[1] ?? "");
	if (doi) out.push(["rft_id", `info:doi/${doi}`]);
	const pmid = pmidOf(item);
	if (pmid) out.push(["rft_id", `info:pmid/${pmid}`]);
	return out;
}

/**
 * The complete resolver link, or null when no valid resolver / no lookup data is available. A resolver that already has a
 * query string gets `&` instead of `?`.
 */
export function buildOpenUrl(item: LocateItem, resolver: string | null | undefined): string | null {
	const base = text(resolver);
	// only http(s) reaches the core's open-url route
	if (!/^https?:\/\/\S+$/i.test(base) || !hasLookupData(item)) return null;
	const query = new URLSearchParams();
	for (const [k, v] of openUrlParams(item)) query.append(k, v);
	// the query goes before a #fragment: after it the resolver would never receive it
	const hash = base.indexOf("#");
	const head = hash < 0 ? base : base.slice(0, hash);
	const sep = head.includes("?") ? (head.endsWith("?") || head.endsWith("&") ? "" : "&") : "?";
	return head + sep + query.toString() + (hash < 0 ? "" : base.slice(hash));
}
