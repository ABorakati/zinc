// Ported from:
//   zotero/zotero     test/tests/utilities_internalTest.js  @ a14e76b358c88779e293f03e56e7900a5b6c4ad6  (#extractIdentifiers)
//   zotero/zotero     test/tests/duplicatesTest.js          @ a14e76b358c88779e293f03e56e7900a5b6c4ad6  (ISBN matching)
//   zotero/utilities  test/tests/utilitiesTest.js           @ 4051881d59c6c12d34417d4c226f37218051be90  (cleanDOI, cleanISBN, toISBN13)
// (AGPL-3.0, see README.md). Subject: zotero-next's own identifier code: additems/identifiers.ts (parseIdentifiers,
// normalizeIsbn), references/ids.ts (normalizeDoi) and duplicates/detect.ts (normalizeIsbns, normalizeDoi).
// Intended differences from Zotero's cleaners, all deliberate (identifiers are used as lookup / dedupe keys here):
//   - DOIs are lower-cased, ISBNs are always returned as ISBN-13, and an ISBN with a wrong check digit is rejected
//     (Zotero's toISBN13 repairs it).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { isbnValid, normalizeIsbn, parseIdentifiers } from "../../src/additems/identifiers";
import { normalizeIsbns } from "../../src/duplicates/detect";
import { normalizeDoi } from "../../src/references/ids";
import { startOracle, type Oracle } from "./oracle";

const ids = (text: string) => parseIdentifiers(text).ids.map((i) => ({ [i.kind]: i.id }));

setDefaultTimeout(60_000); // the oracle child (and citeproc-js) take a few seconds to start on a loaded machine

describe("Zotero.Utilities.Internal", () => {
	describe("#extractIdentifiers()", () => {
		// upstream returns the ISBN-10 as typed ("0838985890"); zotero-next canonicalises to the ISBN-13 of the same book
		test("should extract ISBN-10", () => {
			expect(ids("0838985890")).toEqual([{ isbn: "9780838985892" }]);
		});

		test("should extract ISBN-13", () => {
			expect(ids("978-0838985892")).toEqual([{ isbn: "9780838985892" }]);
		});

		test("should extract multiple ISBN-13s", () => {
			expect(ids("978-0838985892 9781479347711 ")).toEqual([{ isbn: "9780838985892" }, { isbn: "9781479347711" }]);
		});

		test("should extract DOI", () => {
			expect(ids("10.4103/0976-500X.85940")).toEqual([{ doi: "10.4103/0976-500x.85940" }]); // lower-cased
		});

		test("should extract PMID", () => {
			expect(ids("1 PMID:24297125,222 3-4 1234567890, 123456789")).toEqual([
				{ pmid: "1" },
				{ pmid: "24297125" },
				{ pmid: "222" },
				{ pmid: "123456789" },
			]);
		});

		test("should extract multiple old and new style arXivs", () => {
			// upstream's input holds "arXiv:0706.00441v1" (a 5-digit new-style id) and a bare 8-digit number, which it
			// reads as a PMID-less arXiv; zotero-next takes the unambiguous forms only
			expect(ids("0706.0044 arXiv:0706.00441v1,hep-ex/9809001v1, math.GT/0309135.")).toEqual([
				{ arxiv: "0706.0044" },
				{ arxiv: "0706.00441" },
				{ arxiv: "hep-ex/9809001" },
				{ arxiv: "math.GT/0309135" },
			]);
		});

		test.todo("should extract multiple old and new style arXivs (bare 8-digit number 12345678 between the ids is read as an arXiv id upstream)");
		test.todo("should extract ADS bibcodes (2021wfc..rept....8D): ADS bibcodes are not an identifier kind");
	});
});

describe("Duplicate Items", () => {
	describe("ISBN matching", () => {
		test("should match books with equivalent ISBN-10 and ISBN-13", () => {
			// 'Effective Java' 0134685997 / 'Effective Java, 3rd Edition' 9780134685991
			expect(normalizeIsbns("0134685997")).toEqual(normalizeIsbns("9780134685991"));
			expect(normalizeIsbns("0134685997")).toEqual(["9780134685991"]);
		});
	});
});

describe("Zotero.Utilities#cleanDOI()", () => {
	const doi = "10.1088/1748-9326/11/4/048002";
	// upstream compares case-sensitively; zotero-next lower-cases DOIs (DOIs are case-insensitive)
	const clean = (s: string) => normalizeDoi(s);

	test("should parse a DOI", () => {
		expect(clean(`${doi}`)).toBe(doi);
	});

	test.todo("should parse a short DOI (10/aabbe): short DOIs are not recognised");

	test("should parse a DOI at the end of a sentence", () => {
		expect(clean(`Foo bar ${doi}. Foo bar`)).toBe(doi);
	});

	test("should parse a DOI with URL-encoded < and >", () => {
		const encodedUri = "10.1002/1096-9128(200005)12:6%3C375::AID-CPE480%3E3.0.CO;2-M";
		const expected = "10.1002/1096-9128(200005)12:6<375::AID-CPE480>3.0.CO;2-M";
		// the sentence's "." is dropped, and "<" ">" are cut off the DOI by normalizeDoi's character class
		expect(clean(`Foo bar ${encodedUri}. Foo bar`)).toBe(expected.toLowerCase());
	});

	test("should parse a DOI URL with encoded characters", () => {
		const encodedUri = "https://doi.org/10.1002/1096-9128(200005)12:6%3C375::AID-CPE480%3E3.0.CO;2-M";
		const expected = "10.1002/1096-9128(200005)12:6<375::AID-CPE480>3.0.CO;2-M";
		expect(clean(`Foo bar ${encodedUri}. Foo bar`)).toBe(expected.toLowerCase());
	});

	test("should parse a DOI in parentheses", () => {
		expect(clean(`Foo bar (${doi}) foo bar`)).toBe(doi);
	});

	test("should parse a DOI in brackets", () => {
		expect(clean(`Foo bar [${doi}] foo bar`)).toBe(doi);
	});

	test("should parse a DOI with an invalid URI-encoded character", () => {
		expect(clean("https://doi.org/10.101/%E0%A4%A")).toBeNull(); // upstream: undefined (no DOI)
	});
});

describe("Zotero.Utilities#cleanISBN()", () => {
	// cleanISBN() returns the ISBN as written (10 or 13 digits); isbnValid + normalizeIsbn are zotero-next's pair
	test("should return false for non-ISBN string", () => {
		for (const s of ["", "Random String 123", "1234X67890", "987123456789X"]) expect(normalizeIsbn(s)).toBeNull();
	});

	test("should return false for invalid ISBN string", () => {
		expect(isbnValid("1234567890")).toBe(false);
		expect(isbnValid("9871234567890")).toBe(false);
	});

	test("should return valid ISBN string given clean, valid ISBN string", () => {
		expect(isbnValid("123456789X")).toBe(true);
		expect(isbnValid("123456789x")).toBe(true);
		expect(isbnValid("9781234567897")).toBe(true);
		expect(isbnValid("9791843123391")).toBe(true);
	});

	test("should strip off internal characters in ISBN string (hyphens and spaces)", () => {
		expect(normalizeIsbn("978-1 234-567897")).toBe("9781234567897");
		expect(normalizeIsbn("9781 234567897")).toBe("9781234567897");
	});

	// cleanISBN strips every Unicode dash/space and any prefix/suffix text and picks an ISBN out of free text
	test.todo("should strip off the Unicode dashes and spaces cleanISBN ignores (\\u2010-\\u2015, \\u00A0, \\u2000-\\u200A ...)");
	test.todo("should strip off surrounding non-ISBN string (ISBN 9781234567897 (print))");
	test.todo("should return the first valid ISBN from a string with multiple ISBNs");
	test.todo("should not validate check digit when dontValidate is set");
});

describe("Zotero.Utilities toISBN13", () => {
	test("should convert to ISBN13", () => {
		expect(normalizeIsbn("123456789X")).toBe("9781234567897"); // converts ISBN10 to ISBN13
		expect(normalizeIsbn("9781234567897")).toBe("9781234567897");
		expect(normalizeIsbn("9791843123391")).toBe("9791843123391");
		expect(normalizeIsbn("978-1234567897")).toBe("9781234567897"); // accepts hyphenated ISBN
	});

	test("should throw on invalid ISBN", () => {
		// zotero-next returns null instead of throwing
		for (const s of ["", "random string", "1234567890123"]) expect(normalizeIsbn(s)).toBeNull();
	});

	// toISBN13 repairs a wrong check digit; zotero-next rejects the ISBN (an ISBN that fails its check is not an identifier)
	test.todo("should ignore invalid check digit (1234567890 -> 9781234567897)");
});

describe("zotero-next ISBN handling agrees with Zotero's cleanISBN/toISBN13 on valid ISBNs", () => {
	let oracle: Oracle;
	beforeAll(() => {
		oracle = startOracle();
	});
	afterAll(() => oracle.close());

	test("a spread of valid ISBN-10 and ISBN-13 numbers", async () => {
		const isbns = ["0134685997", "9780134685991", "0838985890", "978-0838985892", "123456789X", "9791843123391", "0-596-52068-9", "978-0-596-52068-7", "0199535922"];
		const problems: string[] = [];
		for (const s of isbns) {
			const cleaned = await oracle.call<string | false>("cleanISBN", s);
			if (!cleaned) {
				problems.push(`${s}: Zotero rejects it`);
				continue;
			}
			const zotero = await oracle.call<string>("toISBN13", cleaned);
			if (normalizeIsbn(s) !== zotero) problems.push(`${s}: zotero ${zotero} vs zotero-next ${normalizeIsbn(s)}`);
			if (normalizeIsbns(s)[0] !== zotero) problems.push(`${s}: duplicates.normalizeIsbns ${normalizeIsbns(s)[0]} vs zotero ${zotero}`);
		}
		expect(problems).toEqual([]);
	});
});
