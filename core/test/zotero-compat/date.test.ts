// Ported from Zotero's date tests (AGPL-3.0, see README.md in this folder):
//   zotero/utilities  test/tests/dateTest.js  @ 4051881d59c6c12d34417d4c226f37218051be90  (strToMultipart; parseEDTF is internal to it)
//   zotero/zotero     test/tests/dateTest.js  @ a14e76b358c88779e293f03e56e7900a5b6c4ad6  (strToDate, sqlToDate)
// Subject: zotero-next's own date code that writes Zotero's "YYYY-MM-DD <text>" storage (core/src/zotero-db/zotero-date.ts,
// mapping.ts) and the SQL <-> ISO helpers. Test names are the upstream ones. The last block asks Zotero's own vendored
// date.js (through ./oracle) for the answer on a larger corpus and requires the same output.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { dateToMultipart, isoToSql, toIso } from "../../src/zotero-db/mapping";
import { strToDate, strToMultipart } from "../../src/zotero-db/zotero-date";
import { startOracle, type Oracle } from "./oracle";

setDefaultTimeout(60_000); // the oracle child (and citeproc-js) take a few seconds to start on a loaded machine

describe("Zotero.Date (utilities)", () => {
	describe("strToMultipart", () => {
		test("should convert a plain date", () => {
			expect(strToMultipart("2021-05-13")).toBe("2021-05-13 2021-05-13");
		});

		test("should sort an EDTF interval by its start", () => {
			expect(strToMultipart("2021/2026")).toBe("2021-00-00 2021/2026");
			expect(strToMultipart("2021-05/2021-06")).toBe("2021-05-00 2021-05/2021-06");
		});

		test("should ignore EDTF qualifiers", () => {
			expect(strToMultipart("2004-06~")).toBe("2004-06-00 2004-06~");
			expect(strToMultipart("ca. 1900")).toBe("1900-00-00 ca. 1900");
		});

		test("should sort a year with a CE marker", () => {
			expect(strToMultipart("429 CE")).toBe("0429-00-00 429 CE");
		});

		test("should not give a date with an unusable era a year", () => {
			expect(strToMultipart("-500/-750")).toBe("0000-00-00 -500/-750");
			expect(strToMultipart("500-750 BCE")).toBe("0000-00-00 500-750 BCE");
			// A reversed CE range still sorts by the year it starts with
			expect(strToMultipart("1996-1995")).toBe("1996-00-00 1996-1995");
		});

		test("should drop a negative year", () => {
			expect(strToMultipart("-0429")).toBe("0000-00-00 -0429");
			expect(strToMultipart("429 BCE")).toBe("0000-00-00 429 BCE");
		});

		test("dateToMultipart (what the Zotero writer stores) is strToMultipart", () => {
			expect(dateToMultipart("2021/2026")).toBe("2021-00-00 2021/2026");
			expect(dateToMultipart("")).toBe("");
		});
	});
});

describe("Zotero.Date (zotero)", () => {
	describe("#strToDate()", () => {
		// upstream also asserts the `order` property ('m', 'd'); zotero-next does not compute it (nothing uses it)
		test("should return object without date parts for null", () => {
			expect(strToDate(null)).not.toHaveProperty("year");
		});
		test("should return object without date parts for undefined", () => {
			expect(strToDate(undefined)).not.toHaveProperty("year");
		});
		test("should return object without date parts for false", () => {
			expect(strToDate(false)).not.toHaveProperty("year");
		});
		test("should return object without date parts for empty string", () => {
			expect(strToDate("")).not.toHaveProperty("year");
		});
		test("should return object without date parts for blank string", () => {
			expect(strToDate(" ")).not.toHaveProperty("year");
		});

		test("should parse English month before date", () => {
			const o = strToDate("June 26, 2010");
			expect(o.month).toBe(5);
			expect(o.day).toBe(26);
			expect(Number(o.year)).toBe(2010);
		});

		test("should parse English month after date", () => {
			const o = strToDate("26 June 2010");
			expect(o.month).toBe(5);
			expect(o.day).toBe(26);
			expect(Number(o.year)).toBe(2010);
		});

		// Zotero reads month names of the UI locale; zotero-next's date parser knows English months only
		test.todo("should parse Chinese month (四月 26, 2010): non-English month names are not supported");

		test("should parse two- and three-digit dates with leading zeros", () => {
			expect(Number(strToDate("001").year)).toBe(1);
			expect(Number(strToDate("0001").year)).toBe(1);
			expect(Number(strToDate("012").year)).toBe(12);
			expect(Number(strToDate("0012").year)).toBe(12);
			expect(Number(strToDate("0123").year)).toBe(123);
			expect(Number(strToDate("01/01/08").year)).toBe(2008);
		});

		test("should parse two-digit year greater than current year as previous century", () => {
			expect(Number(strToDate("1/1/68", new Date("2026-06-01")).year)).toBe(1968);
		});

		test("should parse two-digit year less than or equal to current year as current century", () => {
			expect(Number(strToDate("1/1/19", new Date("2026-06-01")).year)).toBe(2019);
		});

		test("should parse one-digit month and four-digit year", () => {
			const o = strToDate("8/2020");
			expect(o.month).toBe(7);
			expect(o.day).toBeUndefined();
			expect(Number(o.year)).toBe(2020);
		});

		test("should parse two-digit month with leading zero and four-digit year", () => {
			const o = strToDate("08/2020");
			expect(o.month).toBe(7);
			expect(o.day).toBeUndefined();
			expect(Number(o.year)).toBe(2020);
		});

		test("should parse string with just month number", () => {
			const o = strToDate("1");
			expect(o.month).toBe(0);
			expect(o.year).toBeUndefined();
		});

		test("should parse string with just day number", () => {
			const o = strToDate("25");
			expect(o.day).toBe(25);
			expect(o.month).toBeUndefined();
			expect(o.year).toBeUndefined();
		});

		test("should work in translator sandbox: the multipart value starts with the ISO date of 2017-01-17", () => {
			expect(dateToMultipart("2017-01-17")).toBe("2017-01-17 2017-01-17");
		});
	});

	describe("#sqlToDate()", () => {
		// zotero-next keeps ISO strings; toIso/isoToSql are its SQL <-> ISO converters (Zotero's SQL dates are UTC)
		test("should convert an SQL UTC date into a JS Date object", () => {
			expect(new Date(toIso("2016-02-27 22:00:00")).getTime()).toBe(1456610400000);
		});

		test("should convert an SQL UTC date without seconds into a JS Date object", () => {
			expect(new Date(toIso("2016-02-27 22:00")).getTime()).toBe(1456610400000);
		});

		test("isoToSql is the inverse of toIso", () => {
			expect(isoToSql(toIso("2016-02-27 22:00:00"))).toBe("2016-02-27 22:00:00");
		});
	});
});

// ---------------------------------------------------------------- differential: ask Zotero's own code
describe("dateToMultipart agrees with Zotero's own Zotero.Date.strToMultipart", () => {
	let oracle: Oracle;
	beforeAll(() => {
		oracle = startOracle();
	});
	afterAll(() => oracle.close());

	// Not in the list: ordinal day suffixes ("26th June 2010"). Zotero's client reads them (its Node build, which
	// the oracle runs, has no localized suffix list); zotero-next follows the client.
	const corpus = [
		"2021-05-13", "2021/2026", "2021-05/2021-06", "2004-06~", "ca. 1900", "429 CE", "-500/-750", "1996-1995", "-0429", "429 BCE",
		"June 26, 2010", "26 June 2010", "Jun 26, 2010", "June 2010", "2010", "001", "0001", "012", "0123", "01/01/08", "1/1/68",
		"1/1/19", "8/2020", "08/2020", "1", "25", "Spring 2020", "in press", "forthcoming 2021", "2020 Feb 15", "15 Feb 2020",
		"Feb. 15, 2020", "Sept 5, 2019", "Sep. 2019", "2019-5-3", "2019/05/03", "13/05/2019", "05/13/2019", "12/25/2019",
		"25/12/2019", "May 2020-June 2020", "2019-2020", "c. 1950", "1950s", "n.d.", "Winter 2019", "2020-02", "2020-02-30",
		"  2020  ", "2020-05-04T10:00:00Z", "2020-05-04 10:00:00", "Monday, June 3, 2019", "3 June, 2019", "Mar 3", "2012, March 3",
		"1000-900 BCE", "AD 429", "~1995", "1995-96", "1995–1996", "2024-02-29", "2023-02-29", "2021-13", "196X", "2021/..",
		"May 13, 2021", "Summer 429 BCE", "January 10, 200 BCE", "12 March", "March 12", "Sunday", "Q3 2019", "2019 Q3",
	];

	test("on a corpus of real-world date strings", async () => {
		const diffs: string[] = [];
		for (const c of corpus) {
			const zotero = await oracle.call<string>("strToMultipart", c);
			const znext = dateToMultipart(c);
			if (zotero !== znext) diffs.push(`${JSON.stringify(c)}: zotero ${JSON.stringify(zotero)} vs zotero-next ${JSON.stringify(znext)}`);
		}
		expect(diffs).toEqual([]);
	});

	test("on generated dates (month names x day x year x separators)", async () => {
		const months = ["January", "Feb", "March", "Apr.", "May", "June", "Jul", "August", "Sept", "Oct", "November", "Dec"];
		const diffs: string[] = [];
		const forms: ((m: string, mi: number, d: number, y: number) => string)[] = [
			(m, _i, d, y) => `${m} ${d}, ${y}`,
			(m, _i, d, y) => `${d} ${m} ${y}`,
			(m, _i, _d, y) => `${m} ${y}`,
			(m, _i, d, y) => `${y} ${m} ${d}`,
			(_m, i, d, y) => `${y}-${String(i + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
			(_m, i, d, y) => `${i + 1}/${d}/${y}`,
			(_m, i, d, y) => `${d}/${i + 1}/${y}`,
			(_m, i, _d, y) => `${i + 1}/${y}`,
			(m, _i, d, y) => `Published ${m} ${d}, ${y}.`,
			(m, _i, _d, y) => `Spring/${m} ${y}`,
		];
		let n = 0;
		for (const form of forms) {
			for (let mi = 0; mi < months.length; mi++) {
				for (const [d, y] of [[1, 1999], [13, 2005], [28, 2020], [31, 1870]] as const) {
					const s = form(months[mi]!, mi, d, y);
					const zotero = await oracle.call<string>("strToMultipart", s);
					const znext = dateToMultipart(s);
					n++;
					if (zotero !== znext) diffs.push(`${JSON.stringify(s)}: zotero ${JSON.stringify(zotero)} vs zotero-next ${JSON.stringify(znext)}`);
				}
			}
		}
		expect(n).toBeGreaterThan(400);
		expect(diffs).toEqual([]);
	});
});
