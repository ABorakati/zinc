// Zotero's Bibliography style format (Zotero.Cite.getBibliographyFormatParameters), ported in docformat.ts.
import { describe, expect, test } from "bun:test";
import { bibliographyStyleFormat } from "../../src/cite/docformat";

describe("bibliographyStyleFormat (Zotero's values, in twips)", () => {
	test("hanging indent: 0.5 in body indent, -0.5 in first line, single spacing, one line after", () => {
		expect(bibliographyStyleFormat({ hangingindent: true, linespacing: 1, entryspacing: 1 })).toEqual({
			tabStops: [],
			indent: 720,
			firstLineIndent: -720,
			lineSpacing: 240,
			entrySpacing: 240,
		});
	});
	test("second-field-align flush: indent and tab at 24 + 120 per character of the widest label", () => {
		// Nature's "1." labels with maxoffset 4: 504 twips, as in a document Zotero formatted
		expect(bibliographyStyleFormat({ "second-field-align": "flush", maxoffset: 4, linespacing: 1, entryspacing: 1 })).toEqual({
			tabStops: [504],
			indent: 504,
			firstLineIndent: -504,
			lineSpacing: 240,
			entrySpacing: 240,
		});
	});
	test("second-field-align margin: the tab at 0 and no body indent", () => {
		expect(bibliographyStyleFormat({ "second-field-align": "margin", maxoffset: 3, linespacing: 2, entryspacing: 0 })).toEqual({
			tabStops: [0],
			indent: 0,
			firstLineIndent: -384,
			lineSpacing: 480,
			entrySpacing: 0,
		});
	});
	test("neither: no indents; missing spacing counts as 1", () => {
		expect(bibliographyStyleFormat({})).toEqual({ tabStops: [], indent: 0, firstLineIndent: 0, lineSpacing: 240, entrySpacing: 240 });
	});
});
