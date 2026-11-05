// bun test src/locate/openurl.test.ts -- the Locate links for a journal article, a book, a chapter and the edge cases.
import { describe, expect, test } from "bun:test";
import {
	buildOpenUrl, googleScholarUrl, hasLookupData, normalizeDoi, openUrlParams, pageRange, pmidOf, viewOnlineUrl,
	type LocateItem,
} from "./openurl";

const RESOLVER = "https://library.example.edu/openurl/";

const article: LocateItem = {
	itemType: "journalArticle",
	title: "Deep learning",
	DOI: "https://doi.org/10.1038/nature14539",
	date: "2015-05-28",
	publicationTitle: "Nature",
	volume: "521",
	issue: "7553",
	pages: "436-444",
	ISSN: "0028-0836",
	creators: [
		{ creatorType: "author", firstName: "Yann", lastName: "LeCun" },
		{ creatorType: "author", firstName: "Yoshua", lastName: "Bengio" },
	],
};

const params = (item: LocateItem, resolver = RESOLVER) => {
	const url = buildOpenUrl(item, resolver);
	if (!url) throw new Error("no OpenURL built");
	return new URL(url).searchParams;
};

describe("buildOpenUrl", () => {
	test("journal article: KEV journal fields and both identifiers", () => {
		const q = params({ ...article, PMID: "26017442" });
		expect(q.get("url_ver")).toBe("Z39.88-2004");
		expect(q.get("ctx_ver")).toBe("Z39.88-2004");
		expect(q.get("rft_val_fmt")).toBe("info:ofi/fmt:kev:mtx:journal");
		expect(q.get("rft.genre")).toBe("article");
		expect(q.get("rft.atitle")).toBe("Deep learning");
		expect(q.get("rft.jtitle")).toBe("Nature");
		expect(q.get("rft.volume")).toBe("521");
		expect(q.get("rft.issue")).toBe("7553");
		expect(q.get("rft.spage")).toBe("436");
		expect(q.get("rft.epage")).toBe("444");
		expect(q.get("rft.date")).toBe("2015-05-28");
		expect(q.get("rft.issn")).toBe("0028-0836");
		expect(q.get("rft.aulast")).toBe("LeCun");
		expect(q.get("rft.aufirst")).toBe("Yann");
		expect(q.getAll("rft_id")).toEqual(["info:doi/10.1038/nature14539", "info:pmid/26017442"]);
	});

	test("book: KEV book fields, ISBN and no journal title", () => {
		const q = params({
			itemType: "book",
			title: "A Brief History of Time",
			date: "1988",
			ISBN: "978-0-553-38016-3",
			creators: [{ firstName: "Stephen", lastName: "Hawking" }],
		});
		expect(q.get("rft_val_fmt")).toBe("info:ofi/fmt:kev:mtx:book");
		expect(q.get("rft.genre")).toBe("book");
		expect(q.get("rft.btitle")).toBe("A Brief History of Time");
		expect(q.get("rft.atitle")).toBeNull();
		expect(q.get("rft.jtitle")).toBeNull();
		expect(q.get("rft.isbn")).toBe("978-0-553-38016-3");
		expect(q.get("rft.aulast")).toBe("Hawking");
	});

	test("book chapter: chapter title in atitle, book in btitle", () => {
		const q = params({
			itemType: "bookSection",
			title: "The chapter",
			bookTitle: "The edited volume",
			pages: "12–34",
			ISBN: "978-1-234-56789-0",
			creators: [{ name: "World Health Organization" }],
		});
		expect(q.get("rft_val_fmt")).toBe("info:ofi/fmt:kev:mtx:book");
		expect(q.get("rft.genre")).toBe("bookitem");
		expect(q.get("rft.atitle")).toBe("The chapter");
		expect(q.get("rft.btitle")).toBe("The edited volume");
		expect(q.get("rft.spage")).toBe("12");
		expect(q.get("rft.epage")).toBe("34");
		expect(q.get("rft.isbn")).toBe("978-1-234-56789-0");
		expect(q.get("rft.aulast")).toBe("World Health Organization");
		expect(q.get("rft.aufirst")).toBeNull();
	});

	test("preprint uses the journal format and its genre", () => {
		const q = params({ itemType: "preprint", title: "A preprint", publicationTitle: "bioRxiv", DOI: "10.1101/2020.01.01.1" });
		expect(q.get("rft_val_fmt")).toBe("info:ofi/fmt:kev:mtx:journal");
		expect(q.get("rft.genre")).toBe("preprint");
		expect(q.get("rft.jtitle")).toBe("bioRxiv");
	});

	test("other types default to the journal format; reports use the book format", () => {
		const page = params({ itemType: "webpage", title: "A page", url: "https://example.org/" });
		expect(page.get("rft_val_fmt")).toBe("info:ofi/fmt:kev:mtx:journal");
		expect(page.get("rft.genre")).toBe("document");
		expect(page.get("rft.atitle")).toBe("A page");
		const report = params({ itemType: "report", title: "A report", ISBN: "978-0-00-000000-0" });
		expect(report.get("rft_val_fmt")).toBe("info:ofi/fmt:kev:mtx:book");
		expect(report.get("rft.btitle")).toBe("A report");
	});

	test("DOI and PMID may come from Extra", () => {
		const q = params({ itemType: "journalArticle", title: "T", extra: "PMID: 12345678\nDOI: 10.1000/xyz" });
		expect(q.getAll("rft_id")).toEqual(["info:doi/10.1000/xyz", "info:pmid/12345678"]);
	});

	test("an existing query string gets an ampersand, a bare resolver a question mark", () => {
		const withQuery = buildOpenUrl(article, "https://lib.example.edu/openurl?institution=inst")!;
		expect(withQuery).toContain("?institution=inst&url_ver=");
		const bare = buildOpenUrl(article, "https://lib.example.edu/openurl/")!;
		expect(bare).toContain("?url_ver=");
	});

	test("no usable resolver or no metadata gives no link", () => {
		expect(buildOpenUrl(article, "")).toBeNull();
		expect(buildOpenUrl(article, "   ")).toBeNull();
		expect(buildOpenUrl(article, "ftp://library.example.edu/openurl")).toBeNull();
		expect(buildOpenUrl(article, "not a url")).toBeNull();
		expect(buildOpenUrl({ itemType: "note" }, RESOLVER)).toBeNull();
	});
});

describe("openUrlParams", () => {
	test("keeps creator order: the first creator with a name", () => {
		const pairs = openUrlParams({
			itemType: "journalArticle",
			title: "T",
			publicationTitle: "J",
			creators: [{ creatorType: "editor", lastName: "Editor" }, { creatorType: "author", lastName: "Author", firstName: "A" }],
		});
		expect(pairs.find(([k]) => k === "rft.aulast")?.[1]).toBe("Editor");
	});
});

describe("pageRange", () => {
	test("hyphen, en dash and double hyphen", () => {
		expect(pageRange("436-444")).toEqual({ spage: "436", epage: "444" });
		expect(pageRange("12–34")).toEqual({ spage: "12", epage: "34" });
		expect(pageRange("7--9")).toEqual({ spage: "7", epage: "9" });
	});
	test("a single page stays spage", () => {
		expect(pageRange("e1001744")).toEqual({ spage: "e1001744" });
	});
});

describe("viewOnlineUrl", () => {
	test("the item URL wins over its DOI", () => {
		expect(viewOnlineUrl({ url: "https://example.org/paper", DOI: "10.1/x" })).toBe("https://example.org/paper");
	});
	test("DOI fallback is encoded", () => {
		expect(viewOnlineUrl({ DOI: "doi:10.1000/a b" })).toBe("https://doi.org/10.1000/a%20b");
	});
	test("nothing to open", () => {
		expect(viewOnlineUrl({})).toBeNull();
		expect(viewOnlineUrl({ url: "ftp://example.org/x" })).toBeNull();
	});
});

describe("normalizeDoi / pmidOf / hasLookupData", () => {
	test("DOI prefixes are stripped", () => {
		expect(normalizeDoi("https://dx.doi.org/10.1/x")).toBe("10.1/x");
		expect(normalizeDoi("doi: 10.1/x")).toBe("10.1/x");
	});
	test("PMID from Extra only when the field is empty", () => {
		expect(pmidOf({ PMID: "1", extra: "PMID: 2" })).toBe("1");
		expect(pmidOf({ extra: "note\nPMID: 3\n" })).toBe("3");
		expect(pmidOf({ extra: "no id" })).toBe("");
	});
	test("lookup data needs at least a title or standard number", () => {
		expect(hasLookupData({ itemType: "journalArticle", title: "T" })).toBe(true);
		expect(hasLookupData({ itemType: "journalArticle", ISBN: "1" })).toBe(true);
		expect(hasLookupData({ itemType: "note" })).toBe(false);
	});
});

describe("googleScholarUrl", () => {
	test("encodes the title", () => {
		expect(googleScholarUrl("Deep learning: a review & more")).toBe(
			"https://scholar.google.com/scholar?q=Deep%20learning%3A%20a%20review%20%26%20more",
		);
	});
	test("no title, no search", () => {
		expect(googleScholarUrl("   ")).toBeNull();
	});
});
