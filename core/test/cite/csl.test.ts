import { describe, expect, test } from "bun:test";
import type { ZoteroItemData } from "../../src/api-types";
import { itemToCsl, parseExtra, toCslDate } from "../../src/cite/csl";

const d = (x: Partial<ZoteroItemData> & { itemType: string }): ZoteroItemData => ({ key: "ABCD2345", ...x });

describe("itemToCsl", () => {
	test("a statute's code number is its volume, not also its number (Zotero's schema mapping)", () => {
		const c = itemToCsl(d({ itemType: "statute", nameOfAct: "Data Protection Act", code: "c.", codeNumber: "12" } as never));
		expect(c.volume).toBe("12");
		expect(c.number).toBeUndefined();
	});

	test("journal article", () => {
		const c = itemToCsl(
			d({
				itemType: "journalArticle",
				title: "A trial",
				creators: [
					{ creatorType: "author", firstName: "Jane", lastName: "Smith" },
					{ creatorType: "author", name: "The Trial Group" },
					{ creatorType: "editor", firstName: "Ed", lastName: "Itor" },
				],
				publicationTitle: "N Engl J Med",
				journalAbbreviation: "NEJM",
				volume: "382",
				issue: "5",
				pages: "123-130",
				date: "2020-03-15",
				DOI: "10.1000/xyz",
				ISSN: "0028-4793",
				url: "https://example.org/a",
				accessDate: "2021-01-02T10:00:00Z",
				series: "Ser",
			}),
		);
		expect(c).toMatchObject({
			id: "ABCD2345",
			type: "article-journal",
			title: "A trial",
			"container-title": "N Engl J Med",
			"container-title-short": "NEJM",
			volume: "382",
			issue: "5",
			page: "123-130",
			DOI: "10.1000/xyz",
			ISSN: "0028-4793",
			URL: "https://example.org/a",
			"collection-title": "Ser",
			issued: { "date-parts": [[2020, 3, 15]] },
		});
		expect(c.author).toEqual([{ family: "Smith", given: "Jane" }, { literal: "The Trial Group" }]);
		expect(c.editor).toEqual([{ family: "Itor", given: "Ed" }]);
		expect(c.accessed).toBeDefined();
	});

	test("book", () => {
		const c = itemToCsl(
			d({
				itemType: "book",
				title: "The Book",
				creators: [
					{ creatorType: "author", firstName: "A", lastName: "Writer" },
					{ creatorType: "translator", firstName: "T", lastName: "Rans" },
				],
				publisher: "Oxford University Press",
				place: "Oxford",
				edition: "3rd",
				numPages: "320",
				numberOfVolumes: "2",
				ISBN: "9780000000000",
				seriesTitle: "Great Books",
				seriesNumber: "7",
				date: "May 2019",
			}),
		);
		expect(c).toMatchObject({
			type: "book",
			publisher: "Oxford University Press",
			"publisher-place": "Oxford",
			edition: "3rd",
			"number-of-pages": "320",
			"number-of-volumes": "2",
			ISBN: "9780000000000",
			"collection-title": "Great Books",
			"collection-number": "7",
			issued: { "date-parts": [[2019, 5]] },
		});
		expect(c.translator).toEqual([{ family: "Rans", given: "T" }]);
		expect(c["event-place"]).toBeUndefined();
	});

	test("book section: bookTitle is the container", () => {
		const c = itemToCsl(
			d({
				itemType: "bookSection",
				title: "A chapter",
				bookTitle: "The Handbook",
				creators: [
					{ creatorType: "author", firstName: "C", lastName: "Hapter" },
					{ creatorType: "editor", firstName: "E", lastName: "Ditor" },
					{ creatorType: "bookAuthor", firstName: "B", lastName: "Ook" },
				],
				pages: "10-20",
				publisher: "Springer",
				date: "2015",
			}),
		);
		expect(c.type).toBe("chapter");
		expect(c["container-title"]).toBe("The Handbook");
		expect(c.editor).toEqual([{ family: "Ditor", given: "E" }]);
		expect(c["container-author"]).toEqual([{ family: "Ook", given: "B" }]);
		expect(c.page).toBe("10-20");
	});

	test("conference paper", () => {
		const c = itemToCsl(
			d({
				itemType: "conferencePaper",
				title: "A talk",
				proceedingsTitle: "Proc. of X",
				conferenceName: "XCon 2020",
				place: "Berlin",
				date: "2020-06",
				pages: "1-9",
				creators: [{ creatorType: "author", firstName: "P", lastName: "Resenter" }],
			}),
		);
		expect(c).toMatchObject({
			type: "paper-conference",
			"container-title": "Proc. of X",
			event: "XCon 2020",
			"event-title": "XCon 2020",
			"event-place": "Berlin",
			"publisher-place": "Berlin",
			issued: { "date-parts": [[2020, 6]] },
		});
	});

	test("webpage", () => {
		const c = itemToCsl(
			d({
				itemType: "webpage",
				title: "Page title",
				websiteTitle: "Some Site",
				url: "https://example.org/p",
				accessDate: "2023-04-05",
				date: "4 July 2022",
				creators: [{ creatorType: "author", firstName: "W", lastName: "Eb" }],
			}),
		);
		expect(c).toMatchObject({
			type: "webpage",
			"container-title": "Some Site",
			URL: "https://example.org/p",
			accessed: { "date-parts": [[2023, 4, 5]] },
			issued: { "date-parts": [[2022, 7, 4]] },
		});
	});

	test("thesis", () => {
		const c = itemToCsl(
			d({
				itemType: "thesis",
				title: "My thesis",
				thesisType: "PhD thesis",
				university: "King's College London",
				place: "London",
				date: "2021",
				numPages: "250",
				creators: [{ creatorType: "author", firstName: "T", lastName: "Hesis" }],
			}),
		);
		expect(c).toMatchObject({
			type: "thesis",
			genre: "PhD thesis",
			publisher: "King's College London",
			"publisher-place": "London",
			"number-of-pages": "250",
		});
	});

	test("report", () => {
		const c = itemToCsl(
			d({
				itemType: "report",
				title: "A report",
				reportNumber: "WHO/2020/1",
				reportType: "Technical report",
				institution: "WHO",
				place: "Geneva",
				seriesTitle: "WHO Reports",
				date: "2020-11-30",
				creators: [{ creatorType: "author", name: "World Health Organization" }],
			}),
		);
		expect(c).toMatchObject({
			type: "report",
			number: "WHO/2020/1",
			genre: "Technical report",
			publisher: "WHO",
			"publisher-place": "Geneva",
			"collection-title": "WHO Reports",
		});
		expect(c.author).toEqual([{ literal: "World Health Organization" }]);
	});

	test("Extra: CSL variables, original-date, type override, leftovers", () => {
		const c = itemToCsl(
			d({
				itemType: "journalArticle",
				title: "T",
				date: "2020",
				extra: "PMID: 12345678\nPMCID: PMC999\nOriginal Date: 1999-05\ntype: article-newspaper\nsomething else\nnot a var: x",
			}),
		);
		expect(c.PMID).toBe("12345678");
		expect(c.PMCID).toBe("PMC999");
		expect(c["original-date"]).toEqual({ "date-parts": [[1999, 5]] });
		expect(c.type).toBe("article-newspaper");
		expect(c.note).toBe("something else\nnot a var: x");
	});

	test("Extra: invalid type ignored, author lines", () => {
		const e = parseExtra("type: nonsense\nauthor: Doe || John\nTitle: ignored title");
		expect(e.type).toBeUndefined();
		expect(e.names.author).toEqual([{ family: "Doe", given: "John" }]);
		expect(itemToCsl(d({ itemType: "book", title: "Real", extra: "Title: Other" })).title).toBe("Real");
	});

	test("unknown item types fall back to document", () => {
		expect(itemToCsl(d({ itemType: "weird" })).type).toBe("document");
	});
});

describe("toCslDate", () => {
	test("formats", () => {
		expect(toCslDate("2020")).toEqual({ "date-parts": [[2020]] });
		expect(toCslDate("2020-02")).toEqual({ "date-parts": [[2020, 2]] });
		expect(toCslDate("2020-02-29")).toEqual({ "date-parts": [[2020, 2, 29]] });
		expect(toCslDate("March 5, 2019")).toEqual({ "date-parts": [[2019, 3, 5]] });
		expect(toCslDate("5 Mar 2019")).toEqual({ "date-parts": [[2019, 3, 5]] });
		expect(toCslDate("2019-2021")).toEqual({ "date-parts": [[2019], [2021]] });
		expect(toCslDate("Spring 2020")).toEqual({ raw: "Spring 2020" });
		expect(toCslDate("n.d.")).toEqual({ literal: "n.d." });
		expect(toCslDate("  ")).toBeNull();
	});
});
