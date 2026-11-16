// Better BibTeX / BibLaTeX / CSL exports against BBT-style expected output (tricky items: unicode, capital protection,
// several creators, dates, Extra tex fields). The expectations follow BBT's own test fixtures for the same inputs.
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { exportBetterBib } from "../../src/bbt/export/bibtex";
import { exportBetterCslJson, exportBetterCslYaml } from "../../src/bbt/export/csl";
import { protectPieces } from "../../src/bbt/export/latex";
import { DEFAULT_SETTINGS } from "../../src/bbt/settings";
import { exportItems } from "../../src/io/export";
import { openDb } from "../../src/db";
import { insertItem, tempDir } from "../fixture";
import type { ZoteroItemData } from "../../src/api-types";

const S = DEFAULT_SETTINGS;
const bib = (d: Partial<ZoteroItemData>, flavor: "bibtex" | "biblatex", extra: Partial<typeof S> = {}, tags: string[] = []) =>
	exportBetterBib([{ data: { key: "K", ...d } as ZoteroItemData, tags }], ["key1"], flavor, { ...S, ...extra }).trimEnd();

describe("case protection", () => {
	test("capitalised words are protected, the first word and lower-case words are not", () => {
		expect(
			bib({ itemType: "journalArticle", title: "Technical Report: Towards a Formally Verified Proof Assistant" }, "biblatex"),
		).toBe(
			"@article{key1,\n  title = {Technical Report: {{Towards}} a {{Formally Verified Proof Assistant}}}\n}".replace(
				"Technical Report:",
				"Technical {{Report}}:",
			),
		);
	});
	test("acronyms, hyphenated numbers and first-word acronyms", () => {
		expect(bib({ itemType: "journalArticle", title: "ELUDE: Generating explanations with GPT-3 on DNA" }, "bibtex")).toBe(
			"@article{key1,\n  title = {{{ELUDE}}: {{Generating}} explanations with {{GPT-3}} on {{DNA}}}\n}",
		);
	});
	test("protection can be turned off, and is skipped for non-English items", () => {
		expect(bib({ itemType: "book", title: "The Big Idea" }, "biblatex", { exportBraceProtection: false })).toContain(
			"title = {The Big Idea}",
		);
		expect(bib({ itemType: "book", title: "Formes Normales Semi-Classiques", language: "fr" }, "biblatex")).toContain(
			"title = {Formes Normales Semi-Classiques}",
		);
	});
	test("protectPieces splits plain text into protected and unprotected runs", () => {
		expect(protectPieces("Using Foo Bar here", { v: true })).toEqual([
			{ text: "Using ", nocase: false },
			{ text: "Foo Bar", nocase: true },
			{ text: " here", nocase: false },
		]);
	});
	test("html markup: emphasis and explicit nocase spans", () => {
		expect(bib({ itemType: "book", title: 'On <i>Homo sapiens</i> and <span class="nocase">iPhone</span> use' }, "biblatex")).toContain(
			"title = {On \\mkbibemph{{{Homo}} sapiens} and {{iPhone}} use}",
		);
		expect(bib({ itemType: "book", title: "On <i>Homo</i> use" }, "bibtex")).toContain("\\emph{{{Homo}}}");
	});
});

describe("unicode", () => {
	const item = {
		itemType: "journalArticle",
		title: "café society: naïve ångström über-ideas",
		creators: [
			{ creatorType: "author", firstName: "Vũ", lastName: "Ngọc" },
			{ creatorType: "author", firstName: "José", lastName: "García-Márquez" },
		],
		publicationTitle: "Études & Éclats",
	};
	test("Better BibTeX writes LaTeX commands by default", () => {
		const out = bib(item, "bibtex");
		expect(out).toContain('title = {caf\\\'e society: na\\"{\\i}ve {\\aa}ngstr\\"om \\"uber-ideas}');
		expect(out).toContain("author = {Ng{\\d{o}}c, V{\\~u} and {Garc{\\'{\\i}}a-M{\\'a}rquez}, Jos{\\'e}}");
		expect(out).toContain("journal = {\\'Etudes \\& \\'Eclats}");
	});
	test("Better BibLaTeX keeps unicode by default and escapes only what LaTeX needs", () => {
		const out = bib(item, "biblatex");
		expect(out).toContain("title = {café society: naïve ångström über-ideas}");
		expect(out).toContain("author = {Ngọc, Vũ and García-Márquez, José}");
		expect(out).toContain("journaltitle = {Études \\& Éclats}");
	});
	test("the unicode option can be flipped for either flavour", () => {
		expect(bib(item, "biblatex", { asciiBibLaTeX: true })).toContain("caf\\'e");
		expect(bib(item, "bibtex", { asciiBibTeX: false })).toContain("title = {café society");
	});
	test("LaTeX specials are escaped in values and left alone in url and doi", () => {
		const out = bib(
			{ itemType: "journalArticle", title: "50% of r&d_cost #1 $5", url: "http://x.org/a_b?c=1&d=2#frag", DOI: "10.1000/a_b" },
			"biblatex",
		);
		expect(out).toContain("title = {50\\% of r\\&d\\_cost \\#1 \\$5}");
		expect(out).toContain("url = {http://x.org/a_b?c=1&d=2#frag}");
		expect(out).toContain("doi = {10.1000/a_b}");
	});
});

describe("creators", () => {
	const creators = [
		{ creatorType: "author", firstName: "Ann", lastName: "Smith" },
		{ creatorType: "author", name: "World Health Organization" },
		{ creatorType: "author", firstName: "Jan", lastName: "van der Berg" },
		{ creatorType: "editor", firstName: "Ed", lastName: "Itor" },
		{ creatorType: "translator", firstName: "Tran", lastName: "Slator" },
	];
	test("BibLaTeX: and-separated, corporate names double-braced, particles kept", () => {
		const out = bib({ itemType: "book", title: "x", creators }, "biblatex");
		expect(out).toContain("author = {Smith, Ann and {World Health Organization} and van der Berg, Jan}");
		expect(out).toContain("editor = {Itor, Ed}");
		expect(out).toContain("translator = {Slator, Tran}");
	});
	test("BibTeX: particles are braced so BibTeX does not misparse them", () => {
		expect(bib({ itemType: "book", title: "x", creators }, "bibtex")).toContain(
			"author = {Smith, Ann and {World Health Organization} and {van der Berg}, Jan}",
		);
	});
	test("other creator types map to biblatex name fields", () => {
		const out = bib(
			{
				itemType: "book",
				title: "x",
				creators: [
					{ creatorType: "author", lastName: "A", firstName: "B" },
					{ creatorType: "contributor", lastName: "C", firstName: "D" },
					{ creatorType: "seriesEditor", lastName: "E", firstName: "F" },
					{ creatorType: "bookAuthor", lastName: "G", firstName: "H" },
				],
			},
			"biblatex",
		);
		expect(out).toContain("namea = {C, D}");
		expect(out).toContain("nameatype = {collaborator}");
		expect(out).toContain("editora = {E, F}");
		expect(out).toContain("bookauthor = {G, H}");
	});
});

describe("entry types and fields", () => {
	test("article / book / chapter / thesis / webpage mappings", () => {
		expect(bib({ itemType: "bookSection", title: "Ch", publicationTitle: "The Book", pages: "10-20" }, "biblatex")).toBe(
			"@incollection{key1,\n  title = {Ch},\n  booktitle = {The {{Book}}},\n  pages = {10--20}\n}",
		);
		expect(
			bib({ itemType: "thesis", title: "T", thesisType: "PhD thesis", type: "PhD thesis", publisher: "Uni" }, "biblatex"),
		).toContain("@thesis{key1,");
		expect(bib({ itemType: "thesis", title: "T", type: "Master's thesis", publisher: "Uni" }, "bibtex")).toContain(
			"@mastersthesis{key1,",
		);
		expect(bib({ itemType: "webpage", title: "W", url: "http://a.b/", accessDate: "2024-03-05T10:00:00Z" }, "biblatex")).toContain(
			"urldate = {2024-03-05}",
		);
		expect(bib({ itemType: "magazineArticle", title: "M", publicationTitle: "Mag" }, "biblatex")).toContain(
			"entrysubtype = {magazine}",
		);
		expect(bib({ itemType: "report", title: "R", publisher: "Inst" }, "bibtex")).toContain("@techreport{key1,");
	});
	test("doi and url handling (DOIandURL)", () => {
		const d = { itemType: "journalArticle", title: "T", DOI: "https://doi.org/10.1/X", url: "http://x.org" };
		expect(bib(d, "biblatex")).toContain("doi = {10.1/x}");
		expect(bib(d, "biblatex", { doiAndUrl: "doi" })).not.toContain("url =");
		expect(bib(d, "biblatex", { doiAndUrl: "url" })).not.toContain("doi =");
	});
	test("keywords are sorted and unescaped commas removed", () => {
		expect(bib({ itemType: "book", title: "x" }, "biblatex", {}, ["phusis", "Aristotle", "Aristotle's Physics"])).toContain(
			"keywords = {Aristotle,Aristotle's Physics,phusis}",
		);
	});
	test("field order follows BBT", () => {
		const out = bib(
			{
				itemType: "journalArticle",
				title: "T",
				creators: [{ creatorType: "author", lastName: "A", firstName: "B" }],
				date: "2020",
				publicationTitle: "J",
				volume: "3",
				pages: "1-2",
				DOI: "10.1/x",
			},
			"biblatex",
		);
		expect(
			out
				.split("\n")
				.slice(1, -1)
				.map((l) => l.trim().split(" ")[0]),
		).toEqual(["title", "author", "date", "journaltitle", "volume", "pages", "doi"]);
	});
});

describe("dates", () => {
	test("BibLaTeX date, BibTeX year/month", () => {
		const d = { itemType: "journalArticle", title: "T" };
		expect(bib({ ...d, date: "2014-05-01" }, "biblatex")).toContain("date = {2014-05-01}");
		expect(bib({ ...d, date: "March 2022" }, "biblatex")).toContain("date = {2022-03}");
		expect(bib({ ...d, date: "2022" }, "biblatex")).toContain("date = {2022}");
		expect(bib({ ...d, date: "2014-05-01" }, "bibtex")).toContain("year = 2014,\n  month = may");
		expect(bib({ ...d, date: "2022" }, "bibtex")).toContain("year = 2022");
	});
	test("date ranges and the original date from Extra", () => {
		expect(bib({ itemType: "book", title: "T", date: "2010/2012", extra: "Original Date: 1856" }, "biblatex")).toContain(
			"date = {2010/2012},\n  origdate = {1856}",
		);
	});
	test("an unparseable date is kept verbatim as year", () => {
		expect(bib({ itemType: "book", title: "T", date: "sometime in spring" }, "biblatex")).toContain("year = {sometime in spring}");
	});
});

describe("Extra", () => {
	const d = {
		itemType: "journalArticle",
		title: "T",
		extra: "Citation Key: pinned\ntex.corp: Black & Decker\ntex.formula= $\\sum_i x_i$\nbibtex.onlybibtex: yes\nbiblatex.onlybiblatex: yes\nTeX.cased: Some Words\nOriginal Date: 1990\nplain line: ignored",
	};
	test("tex.* lines pass through (escaped with `:`, raw with `=`, flavour specific with a prefix)", () => {
		const out = bib(d, "biblatex");
		expect(out).toContain("corp = {Black \\& Decker}");
		expect(out).toContain("formula = {$\\sum_i x_i$}");
		expect(out).toContain("onlybiblatex = {yes}");
		expect(out).not.toContain("onlybibtex");
		expect(out).toContain("cased = {Some {{Words}}}");
		expect(out).not.toContain("plain line");
		expect(out).not.toContain("Citation");
		expect(bib(d, "bibtex")).toContain("onlybibtex = {yes}");
	});
	test("tex.entrytype changes the type and an empty tex field removes a field", () => {
		expect(bib({ itemType: "journalArticle", title: "T", date: "2020", extra: "tex.entrytype: book\ntex.date:" }, "biblatex")).toBe(
			"@book{key1,\n  title = {T}\n}",
		);
	});
	test("Extra can be exported as annotation", () => {
		expect(
			bib({ itemType: "book", title: "T", extra: "Citation Key: k\nsome note" }, "biblatex", { exportExtraAsNote: true }),
		).toContain("annotation = {some note}");
	});
});

describe("CSL", () => {
	const items = [
		{
			data: {
				key: "K",
				itemType: "journalArticle",
				title: "T: x",
				creators: [
					{ creatorType: "author", firstName: "Ann", lastName: "Smith" },
					{ creatorType: "author", name: "WHO" },
				],
				date: "2014-05-01",
				publicationTitle: "J",
				extra: "Citation Key: z",
			} as ZoteroItemData,
			tags: ["a", "b"],
		},
	];
	test("Better CSL JSON: id is the citation key", () => {
		const j = JSON.parse(exportBetterCslJson(items, ["smith2014"]));
		expect(j[0].id).toBe("smith2014");
		expect(j[0]["citation-key"]).toBe("smith2014");
		expect(j[0].type).toBe("article-journal");
		expect(j[0].issued["date-parts"][0]).toEqual([2014, 5, 1]);
		expect(j[0].author).toEqual([{ family: "Smith", given: "Ann" }, { literal: "WHO" }]);
		expect(j[0].keyword).toBe("a, b");
	});
	test("Better CSL YAML", () => {
		const y = exportBetterCslYaml(items, ["smith2014"]);
		expect(y.startsWith("---\nreferences:\n- id: smith2014\n")).toBe(true);
		expect(y).toContain("  author:\n  - family: Smith\n    given: Ann\n  - literal: WHO\n");
		expect(y).toContain("    date-parts:\n    - - 2014\n      - 5\n      - 1\n");
		expect(y.trimEnd().endsWith("...")).toBe(true);
	});
});

describe("through the export pipeline (citation keys, formats)", () => {
	let db: Database;
	beforeEach(() => {
		db = openDb(join(tempDir(), "lib.sqlite"));
		insertItem(db, {
			key: "AAAAAAA1",
			itemType: "journalArticle",
			title: "Deep learning for radiology",
			creators: [{ creatorType: "author", firstName: "Ann", lastName: "Smith" }],
			date: "2020-05-01",
			dateAdded: "2024-01-01T00:00:00Z",
		});
		insertItem(db, {
			key: "BBBBBBB2",
			itemType: "journalArticle",
			title: "Deep learning for radiology",
			creators: [{ creatorType: "author", firstName: "Ann", lastName: "Smith" }],
			date: "2020-06-01",
			dateAdded: "2024-01-02T00:00:00Z",
			citationKey: "pinned2020",
		});
	});
	test("betterbiblatex uses generated and pinned keys, in .bib files", () => {
		const r = exportItems(db, { format: "betterbiblatex" });
		expect(r.filename).toBe("My Library.bib");
		expect(r.text).toContain("@article{smithDeepLearningRadiology2020,");
		expect(r.text).toContain("@article{pinned2020,");
		expect(r.count).toBe(2);
	});
	test("betterbibtex, bettercsljson, bettercslyaml", () => {
		expect(exportItems(db, { format: "betterbibtex" }).text).toContain("@article{pinned2020,");
		const j = JSON.parse(exportItems(db, { format: "bettercsljson" }).text);
		expect(j.map((x: { id: string }) => x.id).sort()).toEqual(["pinned2020", "smithDeepLearningRadiology2020"]);
		expect(exportItems(db, { format: "bettercslyaml" }).filename).toBe("My Library.yml");
	});
	test("the plain bibtex/biblatex exports still work", () => {
		expect(exportItems(db, { format: "bibtex" }).text).toContain("@article{");
		expect(exportItems(db, { format: "biblatex" }).text).toContain("@article{");
	});
});
