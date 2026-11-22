// Field codes, document data and rich-text helpers shared by the Word add-in and the word-processor integration endpoints.
import { describe, expect, test } from "bun:test";
import {
	buildBiblCode,
	buildItemCode,
	buildPrefsXml,
	defaultPrefs,
	parseFieldCode,
	parsePrefsXml,
	richToRuns,
	rtfToRuns,
	runsToHtml,
	runsToRtf,
} from "../../src/cite/docfields";

describe("rtf <-> runs", () => {
	test("round trip with formatting, non-ASCII, braces, backslash and tab", () => {
		const runs = [{ t: "Smith J. " }, { t: "A – title", i: 1 as const }, { t: " 5", sup: 1 as const }, { t: "x{y}\\z\t" }];
		expect(rtfToRuns(runsToRtf(runs))).toEqual(runs);
	});
	test("Zotero's own output shapes", () => {
		expect(rtfToRuns("{\\i{}Nature}, \\super 2\\nosupersub{}")).toEqual([{ t: "Nature", i: 1 }, { t: ", " }, { t: "2", sup: 1 }]);
		expect(rtfToRuns("{\\rtf (Smith, 2020)}")).toEqual([{ t: "(Smith, 2020)" }]);
		expect(rtfToRuns("caf\\uc0\\u233{} \\uc0\\u-10179{}\\uc0\\u-8704{}")).toEqual([{ t: "café \u{1F600}" }]);
	});
	test("a bare fragment ending in an escaped brace keeps it; the {\\rtf} wrapper's own brace is dropped", () => {
		expect(rtfToRuns("{\\i{}x}\\}")).toEqual([{ t: "x", i: 1 }, { t: "}" }]);
		expect(rtfToRuns("a\\}")).toEqual([{ t: "a}" }]);
		expect(rtfToRuns("{\\rtf a\\}}")).toEqual([{ t: "a}" }]);
		expect(richToRuns("{\\i{}x}\\}")).toEqual([{ t: "x", i: 1 }, { t: "}" }]);
	});
	test("richToRuns picks RTF, HTML or plain", () => {
		expect(richToRuns("<i>a</i> b")).toEqual([{ t: "a", i: 1 }, { t: " b" }]);
		expect(richToRuns("{\\i{}a} b")).toEqual([{ t: "a", i: 1 }, { t: " b" }]);
		expect(richToRuns("1 < 2")).toEqual([{ t: "1 < 2" }]);
	});
	test("runsToHtml escapes and nests", () => {
		expect(
			runsToHtml([
				{ t: "a<b", i: 1 },
				{ t: "2", sup: 1 },
			]),
		).toBe("<i>a&lt;b</i><sup>2</sup>");
	});
});

describe("document data", () => {
	test("delayed updates round trip and are absent when off (like Zotero)", () => {
		const p = defaultPrefs("vancouver", "en-GB");
		expect(buildPrefsXml(p)).not.toContain("delayCitationUpdates");
		p.delayCitationUpdates = true;
		p.dontAskDelayCitationUpdates = true;
		p.noteType = 2;
		const back = parsePrefsXml(buildPrefsXml(p))!;
		expect(back.delayCitationUpdates).toBe(true);
		expect(back.dontAskDelayCitationUpdates).toBe(true);
		expect(back.noteType).toBe(2);
		expect(back.locale).toBe("en-GB");
		expect(back.extraPrefs).toEqual({});
	});
	test("reads the JSON form (data version 4)", () => {
		const j = JSON.stringify({
			style: {
				styleID: "http://www.zotero.org/styles/apa",
				locale: "en-US",
				hasBibliography: true,
				bibliographyStyleHasBeenSet: false,
			},
			prefs: { fieldType: "Bookmark", noteType: 1, automaticJournalAbbreviations: true },
			sessionID: "abc",
			dataVersion: 4,
		});
		const p = parsePrefsXml(j)!;
		expect(p.styleId).toBe("http://www.zotero.org/styles/apa");
		expect(p.fieldType).toBe("Bookmark");
		expect(p.noteType).toBe(1);
		expect(p.hasBibliography).toBe(true);
		expect(p.automaticJournalAbbreviations).toBe(true);
	});
});

describe("field codes", () => {
	test("citation code round trip keeps unknown keys", () => {
		const code = buildItemCode({
			citationID: "abc12345",
			properties: { noteIndex: 0, custom: "see x", unsorted: true },
			citationItems: [{ id: 1, uris: ["http://zotero.org/users/1/items/ABCD2345"] }],
		});
		const p = parseFieldCode(code);
		expect(p?.kind).toBe("item");
		if (p?.kind === "item") expect(p.data.properties.custom).toBe("see x");
	});
	test("bibliography code with omitted and custom", () => {
		const code = buildBiblCode({
			uncited: [],
			omitted: [["http://zotero.org/users/1/items/ABCD2345"]],
			custom: [[["http://zotero.org/users/1/items/EFGH2345"], "My text"]],
		});
		const p = parseFieldCode(code);
		expect(p?.kind).toBe("bibl");
		if (p?.kind === "bibl") {
			expect(p.data.omitted.length).toBe(1);
			expect(p.data.custom.length).toBe(1);
		}
	});
	test("non-Zotero field codes are not parsed", () => {
		expect(parseFieldCode("ADDIN EN.CITE x")).toBeNull();
		expect(parseFieldCode("ADDIN ZOTERO_ITEM CSL_CITATION {bad json")).toBeNull();
	});
});

describe("merging citations", () => {
	const cite = (id: string, ...items: Record<string, unknown>[]) => ({
		citationID: id,
		properties: { formattedCitation: "", plainCitation: "", noteIndex: 0 },
		citationItems: items.map((i) => ({ id: 1, uris: ["http://zotero.org/users/1/items/AAAAAAA1"], ...i })),
		schema: "x",
	});

	test("the same work at different pages keeps both locators", async () => {
		const { mergeCitationData } = await import("../../src/cite/docfields");
		const merged = mergeCitationData(cite("a", { locator: "5", label: "page" }) as never, [
			cite("b", { locator: "9", label: "page" }) as never,
		]);
		expect(merged.citationItems.map((i) => i.locator)).toEqual(["5", "9"]);
	});

	test("prefix, suffix and author flags also keep citations apart; exact duplicates collapse", async () => {
		const { mergeCitationData } = await import("../../src/cite/docfields");
		const a = cite("a", {}) as never;
		expect(mergeCitationData(a, [cite("b", { prefix: "see" }) as never]).citationItems).toHaveLength(2);
		expect(mergeCitationData(a, [cite("b", { suffix: "ff." }) as never]).citationItems).toHaveLength(2);
		expect(mergeCitationData(a, [cite("b", { "suppress-author": true }) as never]).citationItems).toHaveLength(2);
		expect(mergeCitationData(a, [cite("b", {}) as never]).citationItems).toHaveLength(1);
	});
});

describe("hand-edit detection", () => {
	test("line endings written by Word do not count as an edit", async () => {
		const { isHandEdited } = await import("../../src/cite/docfields");
		const props = { formattedCitation: "", plainCitation: "(Smith 2020;\nJones 2021)", noteIndex: 0 };
		expect(isHandEdited(props, "(Smith 2020;\rJones 2021)")).toBe(false);
		expect(isHandEdited(props, "(Smith 2020;\r\nJones 2021)")).toBe(false);
		expect(isHandEdited(props, "(Smith 2020; Jones 2022)")).toBe(true);
	});
});
