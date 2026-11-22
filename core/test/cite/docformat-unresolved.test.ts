// A citation none of whose items can be resolved (library item gone, no embedded data) must not stop the rest of the
// document from formatting, and the citations that remain must be numbered and disambiguated as if it were not there.
// Also: a document that lost every citation must lose its bibliography, with a kept engine as well as a fresh one.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CslFormatter, type DocCitation, type FormatResult, type StyleSource } from "../../src/cite/docformat";
import type { CslItem } from "../../src/cite/docfields";

const FIX = join(import.meta.dir, "fixtures");
const src: StyleSource = {
	styleXml: async (id) => readFileSync(join(FIX, `${id}.csl`), "utf8"),
	localeXml: async (l) => (l === "en-US" ? readFileSync(join(FIX, "locales-en-US.xml"), "utf8") : null),
};

const item = (id: string, family: string, year: number): CslItem =>
	({
		id,
		type: "article-journal",
		title: `Study ${id}`,
		author: [{ family, given: "Anna" }],
		"container-title": "Journal of Tests",
		volume: "3",
		page: "1-9",
		issued: { "date-parts": [[year]] },
	}) as unknown as CslItem;
const items = new Map<string, CslItem>([
	["a", item("a", "Smith", 2020)],
	["c", item("c", "Jones", 2019)],
	["d", item("d", "Patel", 2018)],
]);
const cite = (citationID: string, ...ids: string[]): DocCitation => ({
	citationID,
	noteIndex: 0,
	items: ids.map((id) => ({ id })),
});

/** what each citation and bibliography entry shows, for comparing two results */
function shape(r: FormatResult) {
	return {
		citations: [...r.citations].map(([id, o]) => [id, o.plain]),
		bibliography: r.bibliography?.entries ?? null,
	};
}

describe("a citation with no resolvable item", () => {
	for (const style of ["apa", "vancouver"]) {
		const docs: [string, DocCitation[], DocCitation[]][] = [
			["in the middle", [cite("1", "a"), cite("2", "b"), cite("3", "c")], [cite("1", "a"), cite("3", "c")]],
			["first", [cite("2", "b"), cite("1", "a"), cite("3", "c")], [cite("1", "a"), cite("3", "c")]],
			["several in a row", [cite("1", "a"), cite("2", "b"), cite("4", "b"), cite("3", "c")], [cite("1", "a"), cite("3", "c")]],
			["after a repeat", [cite("1", "a"), cite("2", "x"), cite("3", "a"), cite("4", "d")], [cite("1", "a"), cite("3", "a"), cite("4", "d")]],
		];
		for (const [name, doc, without] of docs) {
			test(`${style}: ${name} - format() gives what the document without it gives`, async () => {
				const f = await CslFormatter.create(src, style, "en-US");
				const got = f.format(doc, items);
				const want = (await CslFormatter.create(src, style, "en-US")).format(without, items);
				expect(got.citations.has("2")).toBe(false);
				expect(shape(got)).toEqual(shape(want));
			});
			test(`${style}: ${name} - formatDocument() gives what format() gives`, async () => {
				const f = await CslFormatter.create(src, style, "en-US");
				const got = f.formatDocument(doc, items);
				const want = (await CslFormatter.create(src, style, "en-US")).format(doc, items);
				expect(shape(got)).toEqual(shape(want));
			});
		}
	}

	test("an item that goes missing between two refreshes of a kept engine", async () => {
		const f = await CslFormatter.create(src, "apa", "en-US");
		const fresh = await CslFormatter.create(src, "apa", "en-US");
		const doc = [cite("1", "a"), cite("2", "c"), cite("3", "d"), cite("4", "a", "c")];
		expect(shape(f.formatDocument(doc, items))).toEqual(shape(fresh.format(doc, items)));
		// c is gone: citation 2 has nothing left, citation 4 only a, and the kept engine must not show the old text
		const left = new Map(items);
		left.delete("c");
		expect(shape(f.formatDocument(doc, left))).toEqual(shape(fresh.format(doc, left)));
	});
});

describe("a document with no citations left", () => {
	for (const style of ["apa", "vancouver"]) {
		test(`${style}: formatDocument([]) has no bibliography entries`, async () => {
			const f = await CslFormatter.create(src, style, "en-US");
			const before = f.formatDocument([cite("1", "a"), cite("2", "c"), cite("3", "d")], items);
			expect(before.bibliography?.entries.length).toBe(3);
			const after = f.formatDocument([], items);
			const fresh = (await CslFormatter.create(src, style, "en-US")).format([], items);
			expect(after.citations.size).toBe(0);
			expect(after.bibliography?.entries ?? []).toEqual(fresh.bibliography?.entries ?? []);
			expect(after.bibliography?.entries ?? []).toEqual([]);
		});
	}
});
