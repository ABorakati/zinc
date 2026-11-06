// Ported from zotero/utilities test/tests/utilitiesTest.js @ 4051881d59c6c12d34417d4c226f37218051be90 (AGPL-3.0, see README.md).
// Subject: zotero-next's own creator-name parser, core/src/io/common.ts parseName (used by the BibTeX and RIS importers);
// Zotero's is Zotero.Utilities.cleanAuthor. Intended differences: zotero-next keeps name particles with the family name
// ("van Gogh", Zotero: given "Vincent van", family "Gogh"; both render the same through citeproc-js) and keeps initials as typed.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parseRis } from "../../src/io/ris";
import { parseName } from "../../src/io/common";
import { startOracle, type Oracle } from "./oracle";

const clean = (s: string) => {
	const c = parseName(s, "author") as { firstName?: string; lastName?: string } | null;
	return { firstName: c?.firstName, lastName: c?.lastName };
};

setDefaultTimeout(60_000); // the oracle child (and citeproc-js) take a few seconds to start on a loaded machine

describe("Zotero.Utilities", () => {
	describe("cleanAuthor", () => {
		test("should parse author names", () => {
			for (const useComma of [false, true]) {
				// pairs that Zotero keeps as typed; the others in upstream's list expand initials ("F.R.S." -> "F. R. S.")
				for (const [first, expected] of [["First", "First"], ["First Middle", "First Middle"], ["F. R. S.", "F. R. S."]] as const) {
					const str = useComma ? `Last, ${first}` : `${first} Last`;
					const author = clean(str);
					expect(author.firstName).toBe(expected);
					expect(author.lastName).toBe("Last");
				}
			}
		});

		test.todo("should parse author names (initials without spaces are expanded: F.R.S. / F R S / FRS -> F. R. S.)");

		// Zotero's own comment: "The current output is not ideal"; zotero-next splits at the last word instead
		test.todo("should not parse words starting with symbols as last name (Last [CountryName)");

		test("should parse names starting with unicode characters correctly", () => {
			const author = clean("Ąžuolas Žolynas");
			expect(author.firstName).toBe("Ąžuolas");
			expect(author.lastName).toBe("Žolynas");
		});

		test("RIS 'Last, First, Suffix' reads as Last and First", () => {
			const { items } = parseRis("TY  - JOUR\nAU  - Smith, John, Jr.\nAU  - King, Martin Luther, Jr.\nTI  - T\nER  - \n");
			expect(items[0]!.data.creators).toEqual([
				{ creatorType: "author", lastName: "Smith", firstName: "John" },
				{ creatorType: "author", lastName: "King", firstName: "Martin Luther" },
			]);
		});
	});

	describe("agrees with cleanAuthor on plain names", () => {
		let oracle: Oracle;
		beforeAll(() => {
			oracle = startOracle();
		});
		afterAll(() => oracle.close());

		test("given/family order and comma order", async () => {
			const names = [
				"First Last", "First Middle Last", "F. R. S. Last", "Last, First", "Last, First Middle", "Last, F. R. S.", "Ąžuolas Žolynas",
				"Madonna", "de la Fontaine, Jean", "O'Brien, Pat", "Mary-Jane Smith", "Smith, Mary-Jane", "J. R. R. Tolkien", "Tolkien, J. R. R.",
			];
			const problems: string[] = [];
			for (const n of names) {
				const z = await oracle.call<{ firstName: string; lastName: string }>("cleanAuthor", n, "author", n.includes(","));
				const m = clean(n);
				if (z.firstName !== (m.firstName ?? "") || z.lastName !== m.lastName) problems.push(`${n}: zotero ${z.firstName}|${z.lastName} vs zotero-next ${m.firstName}|${m.lastName}`);
			}
			expect(problems).toEqual([]);
		});
	});
});
