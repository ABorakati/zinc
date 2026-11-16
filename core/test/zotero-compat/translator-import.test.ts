// Zotero's own translator test cases, run through zotero-next's own importers.
// Source: the `testCases` embedded in the import translators vendored in core/vendor/zotero/translators
// (BibTeX.js, RIS.js, CSL JSON.js, Endnote XML.js, MODS.js; zotero/translators @ 9d04f4b8b4e44b46782c8572fdb834147df18979).
// Each case is a pair {input text, expected Zotero items}. The translators themselves already run through core/src/translate
// (test/translate); here the INPUT goes through core/src/io/{bibtex,ris,csljson,endnote,mods}.ts instead, which are zotero-next's
// own, much smaller importers, and the expected items are compared on the fields both sides express: item type, title,
// publication/book/proceedings title, volume, issue, pages, publisher, institution, DOI, ISBN, ISSN, url, place, date (by its
// sortable form), creators (type, last, first), tags. Anything else a translator emits (extra, attachments, notes) is not compared.
// A case listed in KNOWN is a documented difference: it is a todo with the reason, and a guard test fails when such a case
// starts to pass, so the list cannot go stale.
import { describe, expect, test } from "bun:test";
import { parseBibtex } from "../../src/io/bibtex";
import { parseCslJson } from "../../src/io/csljson";
import { parseEndnoteXml } from "../../src/io/endnote";
import { parseMods } from "../../src/io/mods";
import { parseRis } from "../../src/io/ris";
import { compareItem, loadTestCases, type Mismatch } from "./translator-cases";

type Parse = (text: string) => { items: { data: Record<string, any> }[]; errors: string[] };
const SUITES: { file: string; parse: Parse }[] = [
	{ file: "BibTeX.js", parse: parseBibtex as Parse },
	{ file: "RIS.js", parse: parseRis as Parse },
	{ file: "CSL JSON.js", parse: parseCslJson as Parse },
	{ file: "Endnote XML.js", parse: parseEndnoteXml as Parse },
	{ file: "MODS.js", parse: parseMods as Parse },
];

// "<file>#<n>" (n-th import case in the translator) -> why zotero-next's importer differs
const KNOWN: Record<string, string> = {
	"BibTeX.js#3":
		"name suffix: 'von Hicks, III, Michael' - Zotero keeps 'III' in the given name, zotero-next appends it to the family name",
	"BibTeX.js#5": "a bare \\~ (LaTeX tilde accent without a letter) is not turned into the tilde operator",
	"BibTeX.js#6":
		"LaTeX markup (\\textit, \\textbf, \\textsc, $_{..}$, $^{..}$) becomes HTML tags in Zotero (<i>, <b>, <sub>, <sup>); zotero-next keeps the math source / strips the commands",
	"BibTeX.js#7":
		"@misc with a url: Zotero makes a document, zotero-next a webpage; the lowercase word 'at' in 'American Rights at Work' stays with the family name",
	"BibTeX.js#8":
		"Zotero tolerates a missing comma between two fields (title = {..} file = {..}); zotero-next reports a parse error and skips that entry",
	"BibTeX.js#9": "\\textbackslash / escaped braces: the exact text Zotero keeps differs",
	"BibTeX.js#13":
		"@mastersthesis / @phdthesis type text is 'Master's Thesis' / 'PhD Thesis' in Zotero; zotero-next writes and reads 'Master's thesis' / 'PhD thesis' (its own export round-trips)",
	"BibTeX.js#15": "MathSciNet FJOURNAL (full journal name) is not read; zotero-next uses JOURNAL (the abbreviation) as publication title",
	"BibTeX.js#17": "a lowercase word in a corporate-style name ('Corporation for Digital Scholarship') stays with the family name",
	"BibTeX.js#18": "LaTeX symbols (\\textcircled, \\ı, \\textTEL ...) are not all mapped to Unicode",
	"BibTeX.js#19": "initials without spaces ('KC') are expanded by Zotero to 'K. C.'; zotero-next keeps them as typed",
	"BibTeX.js#22": "TeX math ($\\Sigma^0$) is not converted to Unicode (Σ⁰)",
	"RIS.js#1": "patent A2 'Epitope, I.' is dropped by Zotero (assignee-like); zotero-next adds it as a contributor",
	"RIS.js#2":
		"exhaustive mapping test of every RIS tag, with continuation keywords split on ';' and TA/AU variants; zotero-next maps the common tags only",
	"RIS.js#4": "exhaustive mapping test of every RIS type (48 entry types); zotero-next maps the common types and falls back to document",
	"RIS.js#11": "TY - GEN: Zotero makes a journalArticle (its default), zotero-next a document",
	"Endnote XML.js#0":
		"series editors become editors; initials lose their trailing period ('John S.' -> 'John S'); a url in related-urls is not read",
	"Endnote XML.js#1":
		"rich text runs (bold, italic, superscript) are flattened to plain text; Zotero keeps <b> <i> <sup> <sub> in the title",
	"Endnote XML.js#2": "a 'Jr.' suffix keeps its period in zotero-next, Zotero drops it",
	"MODS.js#2": "role 'artist' is a contributor, not an artist creator",
	"MODS.js#4": "originInfo place and copyright dates (c1999) are not read; zotero-next keeps the 'c' prefix",
	"MODS.js#6": "dates in part/date or dateOther are not read",
	"MODS.js#7": "dates in part/date or dateOther are not read",
	"MODS.js#8": "dates in part/date or dateOther are not read",
	"MODS.js#9": "page range '17' is written '17-17'; part/date not read",
	"MODS.js#10": "copyright dates (c1984) keep their 'c' prefix",
	"MODS.js#11": "date ranges (1985-1988) are not reduced to the start year",
	"MODS.js#12": "originInfo place not read; marcrelator roles (programmer) become contributors",
	"MODS.js#13": "originInfo place not read; corporate names lose their colon form",
	"MODS.js#14": "originInfo place not read; marcrelator roles (cartographer) become contributors",
	"MODS.js#15": "copyright dates (c1984) keep their 'c' prefix",
	"MODS.js#16": "originInfo place not read; date prefixes (p1980)",
	"MODS.js#18": "originInfo place not read; initials spacing in names",
	"MODS.js#19": "genre 'letter' is not recognised; recipient role becomes author",
	"MODS.js#20": "genre 'hearing' is not recognised; publisher and corporate names differ",
	"MODS.js#21": "genre 'government publication' is not recognised; publisher and corporate names differ",
	"MODS.js#22": "genre 'bill' is not recognised; the official title is not preferred",
};

function run(suite: (typeof SUITES)[number], index: number, input: string, expected: Record<string, any>[]): Mismatch[] {
	const got = suite.parse(input).items.map((i) => i.data);
	const problems: Mismatch[] = [];
	if (got.length !== expected.length) problems.push({ field: "(item count)", expected: expected.length, got: got.length });
	expected.forEach((e, j) => problems.push(...compareItem(e, got[j])));
	return problems;
}

for (const suite of SUITES) {
	describe(`${suite.file} testCases through zotero-next's importer`, () => {
		const cases = loadTestCases(suite.file).filter((c) => c.type === "import" && Array.isArray(c.items));
		cases.forEach((c, i) => {
			const key = `${suite.file}#${i}`;
			const first = (c.items as Record<string, any>[])[0]?.title ?? "";
			const name = `${key} ${String(first).slice(0, 60)}`;
			const known = KNOWN[key];
			if (known) test.todo(`${name}: ${known}`);
			else {
				test(name, () => {
					expect(run(suite, i, c.input, c.items as Record<string, any>[])).toEqual([]);
				});
			}
		});
	});
}

describe("KNOWN differences are still differences", () => {
	test("a case in KNOWN that now passes must be removed from KNOWN (and become a real test)", () => {
		const nowPass: string[] = [];
		for (const suite of SUITES) {
			loadTestCases(suite.file)
				.filter((c) => c.type === "import" && Array.isArray(c.items))
				.forEach((c, i) => {
					const key = `${suite.file}#${i}`;
					if (KNOWN[key] && run(suite, i, c.input, c.items as Record<string, any>[]).length === 0) nowPass.push(key);
				});
		}
		expect(nowPass).toEqual([]);
	});

	test("every KNOWN key names an existing case", () => {
		const keys = new Set<string>();
		for (const suite of SUITES)
			loadTestCases(suite.file)
				.filter((c) => c.type === "import" && Array.isArray(c.items))
				.forEach((_c, i) => keys.add(`${suite.file}#${i}`));
		expect(Object.keys(KNOWN).filter((k) => !keys.has(k))).toEqual([]);
	});
});
