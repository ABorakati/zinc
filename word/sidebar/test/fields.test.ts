import { describe, expect, test } from "bun:test";
import {
	CITATION_SCHEMA,
	buildBiblCode,
	buildItemCode,
	buildPrefsXml,
	defaultPrefs,
	htmlToRuns,
	itemUri,
	newCitationID,
	numericId,
	parseFieldCode,
	parsePrefsXml,
	runsToPlain,
	runsToRtf,
	styleIdToUrl,
	styleUrlToId,
	uriToKey,
} from "../src/fields";

const sample = {
	citationID: "a1B2c3D4",
	properties: { formattedCitation: "\\super 1\\nosupersub{}", plainCitation: "1", noteIndex: 0 },
	citationItems: [{ id: 123, uris: ["http://zotero.org/users/5106252/items/223L2GC8"], itemData: { id: 123, type: "article-journal", title: 'A "quoted" \\ title – é “x”' } }],
	schema: CITATION_SCHEMA,
};

describe("field codes", () => {
	test("citation code round trip keeps backslashes, quotes and unicode", () => {
		const code = buildItemCode(sample as any);
		expect(code.startsWith("ADDIN ZOTERO_ITEM CSL_CITATION {")).toBe(true);
		const p = parseFieldCode(` ${code} `);
		expect(p?.kind).toBe("item");
		expect(p && p.kind === "item" && p.data).toEqual(sample as any);
	});

	test("bibliography code is exactly Zotero's", () => {
		expect(buildBiblCode()).toBe('ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY');
		const p = parseFieldCode(buildBiblCode({ uncited: [["http://zotero.org/users/1/items/AAAAAAAA"]], omitted: [], custom: [] }));
		expect(p?.kind).toBe("bibl");
		expect(p && p.kind === "bibl" && p.data.uncited).toEqual([["http://zotero.org/users/1/items/AAAAAAAA"]]);
	});

	test("reads a field written by Zotero (spaces, trailing space, no schema)", () => {
		const zot = ' ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"x","properties":{"formattedCitation":"(Smith, 2020)","plainCitation":"(Smith, 2020)","noteIndex":0},"citationItems":[{"id":1,"uris":["http://zotero.org/users/local/abc12345/items/ABCD1234"],"itemData":{"id":1,"type":"book","title":"T"}}]} ';
		const p = parseFieldCode(zot);
		expect(p?.kind).toBe("item");
		expect(p && p.kind === "item" && p.data.citationItems[0]!.uris[0]).toContain("local/abc12345");
	});

	test("non-Zotero and broken fields are rejected", () => {
		expect(parseFieldCode("PAGE")).toBeNull();
		expect(parseFieldCode("ADDIN EN.CITE foo")).toBeNull();
		expect(parseFieldCode("ADDIN ZOTERO_ITEM CSL_CITATION {not json")).toBeNull();
	});

	test("citation ids are 8 alphanumerics and differ", () => {
		const a = newCitationID();
		expect(a).toMatch(/^[A-Za-z0-9]{8}$/);
		expect(newCitationID()).not.toBe(a);
	});
});

describe("item URIs and keys", () => {
	test("uriToKey handles synced, local and group URIs", () => {
		expect(uriToKey("http://zotero.org/users/5106252/items/223L2GC8")).toBe("223L2GC8");
		expect(uriToKey("http://zotero.org/users/local/abcdEFGH/items/22DDNX3Z")).toBe("22DDNX3Z");
		expect(uriToKey("http://zotero.org/groups/99/items/ABCDEFGH")).toBe("ABCDEFGH");
		expect(uriToKey("https://www.zotero.org/users/1/items/ABCDEFGH/")).toBe("ABCDEFGH");
		expect(uriToKey("http://example.com/items/ABCDEFGH")).toBeNull();
		expect(uriToKey("http://zotero.org/users/1/items/short")).toBeNull();
	});
	test("itemUri", () => {
		expect(itemUri("http://zotero.org/users/5106252/", "ABCD1234")).toBe("http://zotero.org/users/5106252/items/ABCD1234");
	});
	test("numericId is stable and positive", () => {
		expect(numericId("223L2GC8")).toBe(numericId("223L2GC8"));
		expect(numericId("223L2GC8")).not.toBe(numericId("22DDNX3Z"));
		expect(numericId("ZZZZZZZZ")).toBeGreaterThan(0);
	});
});

describe("document preferences", () => {
	test("round trip", () => {
		const p = defaultPrefs("vancouver", "en-GB");
		p.hasBibliography = true;
		p.bibliographyStyleHasBeenSet = true;
		p.noteType = 1;
		const xml = buildPrefsXml(p);
		expect(xml).toContain('<style id="http://www.zotero.org/styles/vancouver" locale="en-GB" hasBibliography="1" bibliographyStyleHasBeenSet="1"/>');
		expect(xml).toContain('<pref name="fieldType" value="Field"/>');
		const back = parsePrefsXml(xml)!;
		expect(back.styleId).toBe("http://www.zotero.org/styles/vancouver");
		expect(back.locale).toBe("en-GB");
		expect(back.sessionId).toBe(p.sessionId);
		expect(back.hasBibliography).toBe(true);
		expect(back.noteType).toBe(1);
	});
	test("reads Zotero's own document data and keeps unknown prefs", () => {
		const zot = '<data data-version="3" zotero-version="7.0.3"><session id="mAGnqnH1"/><style id="http://www.zotero.org/styles/the-lancet" locale="en-US" hasBibliography="true" bibliographyStyleHasBeenSet="true"/><prefs><pref name="fieldType" value="Field"/><pref name="automaticJournalAbbreviations" value="true"/><pref name="noteType" value="0"/><pref name="dontAskDelayCitationUpdates" value="true"/></prefs></data>';
		const p = parsePrefsXml(zot)!;
		expect(styleUrlToId(p.styleId)).toBe("the-lancet");
		expect(p.hasBibliography).toBe(true);
		expect(p.automaticJournalAbbreviations).toBe(true);
		expect(p.dontAskDelayCitationUpdates).toBe(true); // now a typed DocPref, no longer an extra pref
		expect(buildPrefsXml(p)).toContain('<pref name="dontAskDelayCitationUpdates" value="true"/>');
	});
	test("style ids", () => {
		expect(styleIdToUrl("nature")).toBe("http://www.zotero.org/styles/nature");
		expect(styleIdToUrl("http://example.com/s")).toBe("http://example.com/s");
		expect(parsePrefsXml("")).toBeNull();
	});
});

describe("formatted text", () => {
	test("html -> runs: italic, superscript, small caps, entities", () => {
		const runs = htmlToRuns('Smith &#38; Jones. <i>Lancet</i> 2020;<sup>3</sup> <span style="font-variant:small-caps;">Abc</span> &lt;x&gt;');
		expect(runsToPlain(runs)).toBe("Smith & Jones. Lancet 2020;3 Abc <x>");
		expect(runs.find((r) => r.t === "Lancet")?.i).toBe(1);
		expect(runs.find((r) => r.t === "3")?.sup).toBe(1);
		expect(runs.find((r) => r.t === "Abc")?.sc).toBe(1);
	});
	test("second-field-align entries get a tab after the label", () => {
		const runs = htmlToRuns('<div class="csl-entry"><div class="csl-left-margin">1.</div><div class="csl-right-inline">Text.</div></div>');
		expect(runsToPlain(runs)).toBe("1.\tText.");
	});
	test("rtf matches Zotero's conventions", () => {
		expect(runsToRtf([{ t: "1", sup: 1 }])).toBe("\\super 1\\nosupersub{}");
		expect(runsToRtf([{ t: "(" }, { t: "Lancet", i: 1 }, { t: " 2020–21)" }])).toBe("({\\i{}Lancet} 2020\\uc0\\u8211{}21)");
		expect(runsToRtf([{ t: "a\\b{c}" }])).toBe("a\\\\b\\{c\\}");
		// the RTF is a JSON string value inside the field: it must survive a JSON round trip unchanged
		const rtf = runsToRtf([{ t: "é", sup: 1 }]);
		expect(JSON.parse(JSON.stringify({ rtf })).rtf).toBe(rtf);
	});
});
