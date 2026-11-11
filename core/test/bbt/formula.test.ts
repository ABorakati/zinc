// Citation-key formula language: parsing and evaluation against the examples in Better BibTeX's documentation.
import { describe, expect, test } from "bun:test";
import type { ZoteroItemData } from "../../src/api-types";
import { compile, FormulaError, formatPostfix, generate, MARK, validPostfix } from "../../src/bbt/formula";
import { formulaConfig } from "../../src/bbt/keys";
import { DEFAULT_FORMULA, DEFAULT_SETTINGS } from "../../src/bbt/settings";

const cfg = formulaConfig(DEFAULT_SETTINGS);
const keyWith = (c: typeof cfg) => (formula: string, d: Partial<ZoteroItemData>) => generate(compile(formula), { key: "ITEM0001", itemType: "journalArticle", ...d } as ZoteroItemData, c).text.replace(MARK, "");
// whitespace is always removed from a finished key; with folding on, non-ASCII is transliterated
const key = keyWith(cfg);
const keyU = keyWith({ ...cfg, fold: false });

const paper: Partial<ZoteroItemData> = {
	title: "Deep learning for chest radiology: a systematic review of the field",
	creators: [
		{ creatorType: "author", firstName: "Ann", lastName: "Smith" },
		{ creatorType: "author", firstName: "Bob", lastName: "Jones" },
		{ creatorType: "author", firstName: "Cy", lastName: "Wu" },
		{ creatorType: "editor", firstName: "Ed", lastName: "Itor" },
	],
	date: "2020-05-17",
	publicationTitle: "Journal of Medical Imaging",
	journalAbbreviation: "J Med Imaging",
	pages: "123-145",
};

describe("default formula", () => {
	test("auth.lower + shorttitle(3,3) + year", () => {
		expect(DEFAULT_FORMULA).toBe("auth.lower + shorttitle(3,3) + year");
		// skip words (for, of, a, the) are dropped; the first three remaining words are capitalised and joined
		expect(key(DEFAULT_FORMULA, paper)).toBe("smithDeepLearningChest2020");
	});
	test("no creators and no date still produce what is there", () => {
		expect(key(DEFAULT_FORMULA, { title: "Standalone Title Words Here" })).toBe("StandaloneTitleWords");
	});
});

describe("functions", () => {
	test("auth variants", () => {
		expect(key("auth", paper)).toBe("Smith");
		expect(key("auth(3)", paper)).toBe("Smi");
		expect(key("auth(0,2)", paper)).toBe("Jones");
		expect(key("authors", paper)).toBe("SmithJonesWu");
		expect(key("authorsAlpha", paper)).toBe("SJW");
		expect(key("authEtAl", paper)).toBe("SmithEtAl");
		expect(key("authEtal2", paper)).toBe("Smith.etal");
		expect(key("authAuthEa", paper)).toBe("Smith.Jones.ea");
		expect(key("authshort", paper)).toBe("S.J.W");
		expect(key("authorLast", paper)).toBe("Wu");
		expect(key("authForeIni", paper)).toBe("A");
		expect(key("authorIni", paper)).toBe("Smith.J.W");
		expect(key("authIni", paper)).toBe("Smith.Jones.Wu");
		expect(key("authorsn(2)", paper)).toBe("SmithJonesEtAl");
	});
	test("authors falls back to editors when there are no authors", () => {
		expect(key("auth", { creators: [{ creatorType: "editor", firstName: "E", lastName: "Edwards" }] })).toBe("Edwards");
		expect(key("editors", paper)).toBe("Itor");
	});
	test("single-field names use the whole name", () => {
		expect(key("auth.lower", { creators: [{ creatorType: "author", name: "World Health Organization" }] })).toBe("worldhealthorganization");
	});
	test("particles", () => {
		const d = { creators: [{ creatorType: "author", firstName: "Jan", lastName: "van der Berg" }] };
		expect(key("auth.lower", d)).toBe("vanderberg");
		expect(key("creators(0,'*','%(F)s')", d)).toBe("Berg");
	});
	test("year, shortyear, date, month, origyear", () => {
		expect(key("year", paper)).toBe("2020");
		expect(key("shortyear", paper)).toBe("20");
		expect(key("date", paper)).toBe("2020-05-17");
		expect(key("date('%Y%m')", paper)).toBe("202005");
		expect(key("month", paper)).toBe("may");
		expect(key("origyear", { ...paper, extra: "Original Date: 1856" })).toBe("1856");
		expect(key("year", { date: "" })).toBe("");
	});
	test("titles", () => {
		expect(key("title", paper)).toBe("Deeplearningchestradiologysystematicreviewfield");
		expect(key("shorttitle", paper)).toBe("Deeplearningchest");
		expect(key("shorttitle(2,1)", paper)).toBe("Deeplearning");
		expect(key("shorttitle(3,3)", paper)).toBe("DeepLearningChest");
		expect(key("veryshorttitle", paper)).toBe("Deep");
		expect(key("veryshorttitle(2,2)", paper)).toBe("DeepLearning");
	});
	test("title words drop punctuation and single letters", () => {
		expect(key("shorttitle(3,3)", { title: "State-of-the-art: a (very) good X method" })).toBe("StateoftheartVeryGood");
	});
	test("journal, pages", () => {
		expect(key("journal", paper)).toBe("JMedImaging");
		expect(key("journal('full')", paper)).toBe("JournalofMedicalImaging");
		expect(key("firstpage", paper)).toBe("123");
		expect(key("lastpage", paper)).toBe("145");
	});
	test("extra, field access and keyword", () => {
		const d = { ...paper, extra: "tex.shortauthor: WHO\nOriginal Date: 1856", tags: [{ tag: "zeta" }, { tag: "alpha" }], DOI: "10.1/x" };
		expect(key("extra('tex.shortauthor')", d)).toBe("WHO");
		expect(key("Title", { title: "A Plain Title" })).toBe("APlainTitle");
		expect(key("DOI", d)).toBe("10.1/x");
		expect(key("keyword(0)", d)).toBe("alpha");
		expect(key("type", d)).toBe("journalArticle");
	});
	test("verbatim text", () => {
		expect(key("'pre' + year + \"post\"", paper)).toBe("pre2020post");
	});
	test("unknown formulas and bad syntax raise a FormulaError with a position", () => {
		expect(() => compile("nosuchfunction + year")).toThrow(FormulaError);
		expect(() => compile("auth.nosuchfilter")).toThrow("unknown filter");
		expect(() => compile("auth +")).toThrow(FormulaError);
		expect(() => compile("auth + (year")).toThrow(FormulaError);
		expect(() => compile("")).toThrow("empty");
		try {
			compile("auth + $$");
		} catch (e) {
			expect((e as FormulaError).position).toBeGreaterThan(5);
		}
	});
});

describe("filters", () => {
	test("lower upper capitalize condense", () => {
		expect(key("auth.upper", paper)).toBe("SMITH");
		expect(key("title.select(1,2).capitalize", paper)).toBe("DeepLearning");
		expect(key("title.select(1,2).condense('_')", paper)).toBe("Deep_learning");
		expect(key("title.lower.condense('-')", paper)).toBe("deep-learning-chest-radiology-systematic-review-field");
	});
	test("select, substring", () => {
		expect(key("title.select(2,2)", paper)).toBe("learningchest");
		expect(key("title.select(n=1)", paper)).toBe("Deep");
		expect(key("title.select(-1)", paper)).toBe("field");
		expect(key("title.substring(1,4)", paper)).toBe("Deep");
		expect(key("auth.substring(2)", paper)).toBe("mith");
	});
	test("nopunct, ascii, alphanum, abbr, clean, fold", () => {
		const d = { title: "Über-café: naïve (ideas)", creators: [{ creatorType: "author", lastName: "O'Brien-Nuñez", firstName: "A" }] };
		expect(keyU("Title.nopunct", d)).toBe("Über-cafénaïveideas");
		expect(keyU("Title.nopunctordash", d)).toBe("Übercafénaïveideas");
		expect(keyU("Title.ascii", d)).toBe("ber-caf:naveideas");
		expect(keyU("Title.alphanum", d)).toBe("Übercafénaïveideas");
		expect(keyU("Title.abbr", d)).toBe("Ün"); // first letters of "Über-café:", "naïve", "(ideas)"; "(" is an unsafe key character
		expect(key("Title.nopunct", d)).toBe("Uber-cafenaiveideas");
		expect(key("auth.clean", d)).toBe("OBrien-Nunez");
		expect(key("auth.fold.lower", d)).toBe("obrien-nunez");
	});
	test("skipwords, prefix, postfix, default, replace, discard", () => {
		expect(key("Title.skipwords", { title: "On the origin of species" })).toBe("originspecies");
		expect(key("auth.prefix('_')", paper)).toBe("_Smith");
		expect(key("auth.postfix('_')", paper)).toBe("Smith_");
		expect(key("Pages.replace('-','_')", paper)).toBe("123_145");
		expect(key("Pages.replace(/\\d+/, 'N')", paper)).toBe("N-145");
		expect(key("title.discard + year", paper)).toBe("2020");
		expect(key("Extra.default('none')", { title: "x" })).toBe("none");
	});
	test("formatDate", () => {
		expect(key("Date.formatDate('%Y')", paper)).toBe("2020");
		expect(key("Date.formatDate('%y/%m/%d')", paper)).toBe("20/05/17");
	});
	test("len, numeric, match, find", () => {
		expect(key("auth.len + year", paper)).toBe("Smith2020");
		expect(key("title.match(/(deep)/i)", paper)).toBe("Deep");
		expect(key("Date.numeric", paper)).toBe("2020-05-17");
		expect(key("Title.find(/(learning)/i)", paper)).toBe("learning");
		expect(key("Title.find(/(zebra)/i)", paper)).toBe("");
		expect(key("Title.find(/(zebra)/i, true)", { title: "Abc" })).toBe("Abc");
	});
});

describe("alternatives and conditions", () => {
	test("; and | pick the first alternative that yields text", () => {
		expect(key("auth.lower + year; title.lower.select(1,1)", { title: "Only A Title" })).toBe("only");
		expect(key("auth.lower + year | title.lower.select(1,1)", { title: "Only A Title" })).toBe("only");
		expect(key("auth.lower + year; 'fallback'", {})).toBe("fallback");
	});
	test("|| takes the first non-empty, && needs both", () => {
		expect(key("(auth || title).lower + year", { title: "Fine Title", date: "2001" })).toBe("fine title2001".replace(" ", ""));
		expect(key("(auth && year)", paper)).toBe("2020");
		expect(key("(auth && year)", { title: "x" })).toBe("");
	});
	test("ternary", () => {
		expect(key("(auth ? year : title)", paper)).toBe("2020");
		expect(key("(auth ? year : title)", { title: "Alone Title", date: "1999" })).toBe("AloneTitle");
	});
	test("length comparison shorthand skips to the next alternative", () => {
		expect(key("(title > 1) + year; auth + year", { title: "x", date: "2000", creators: [{ creatorType: "author", lastName: "Ng" }] })).toBe("Ng2000");
		expect(key("(auth > 3) + year; 'short' + year", { creators: [{ creatorType: "author", lastName: "Ng" }], date: "2000" })).toBe("short2000");
		expect(key("title.len('>',1) + year", { title: "Hello", date: "2001" })).toBe("Hello2001");
	});
	test("type() and language() conditions", () => {
		expect(key("type(book) + 'B'; type(journalArticle) + 'J'", paper)).toBe("J");
		expect(key("language(en) + 'E'; 'other'", { ...paper, language: "en-GB" })).toBe("E");
		expect(key("language(de) + 'E'; 'other'", paper)).toBe("other");
	});
	test("the creator selection function", () => {
		expect(key("creators(2, 'author', '%(f)s', 'et al.', '-')", paper)).toBe("Smith-Jonesetal.");
		expect(key("creators(0,'editor','%(g)s %(f)s')", paper)).toBe("EdItor");
	});
});

describe("postfix", () => {
	test("duplicate postfix formats", () => {
		expect(formatPostfix("%(a)s", 0)).toBe("a");
		expect(formatPostfix("%(a)s", 25)).toBe("z");
		expect(formatPostfix("%(a)s", 26)).toBe("aa");
		expect(formatPostfix("%(A)s", 1)).toBe("B");
		expect(formatPostfix("-%(n)s", 0)).toBe("-1");
		expect(validPostfix("%(a)s")).toBe(true);
		expect(validPostfix("%(a)s%(n)s")).toBe(false);
		expect(validPostfix("x")).toBe(false);
	});
	// found by the nightly fuzz (fc.double()): Infinity looped forever and the runner was killed when it ran out of memory
	test("regression: a non-finite, negative or fractional index counts as the first duplicate, and does not hang", () => {
		for (const bad of [Infinity, -Infinity, NaN, -1, -1e9]) {
			expect(formatPostfix("%(a)s", bad)).toBe("a");
			expect(formatPostfix("%(n)s", bad)).toBe("1");
		}
		expect(formatPostfix("%(a)s", 1.9)).toBe("b");
		expect(formatPostfix("%(n)s", Number.MAX_VALUE)).toBe(String(Number.MAX_SAFE_INTEGER + 1));
	});
	test("regression: a huge zero-padding width is capped (it allocated a gigabyte string)", () => {
		expect(formatPostfix("%(n)999999999d", 0)).toBe("1".padStart(16, "0"));
		expect(formatPostfix("%(n)03d", 4)).toBe("005");
	});
	test("postfix() and infix() set the template and the position", () => {
		const g = generate(compile("auth.lower + postfix('-%(n)s') + year"), { key: "X", itemType: "book", creators: [{ creatorType: "author", lastName: "Li" }], date: "2000" } as ZoteroItemData, cfg);
		expect(g.postfix.template).toBe("-%(n)s");
		expect(g.text).toBe(`li2000${MARK}`);
		const h = generate(compile("auth.lower + infix('%(A)s') + year"), { key: "X", itemType: "book", creators: [{ creatorType: "author", lastName: "Li" }], date: "2000" } as ZoteroItemData, cfg);
		expect(h.text).toBe(`li${MARK}2000`);
	});
});
