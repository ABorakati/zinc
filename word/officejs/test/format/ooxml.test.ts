import { describe, expect, test } from "bun:test";
import type { Run } from "../../src/contracts";
import {
	escapeXmlAttr,
	escapeXmlText,
	normalizeRunsForInsertText,
	runsToBodyXml,
	runsToOoxml,
	splitRunsIntoParagraphs,
} from "../../src/format";

describe("XML escaping and sanitization", () => {
	test("escapes &, <, >, ]]> sequences, quotes, and apostrophes accurately", () => {
		expect(escapeXmlText(`Smith & Sons <2021> ]]> "quote" 'apos'`)).toBe(`Smith &amp; Sons &lt;2021&gt; ]]&gt; "quote" 'apos'`);
		expect(escapeXmlAttr(`Smith & Sons <2021> "quote" 'apos'`)).toBe(
			`Smith &amp; Sons &lt;2021&gt; &quot;quote&quot; &apos;apos&apos;`,
		);
	});

	test("strips illegal XML 1.0 control characters and lone surrogates while keeping tab, LF, CR, and astral emoji/CJK", () => {
		const dirty = "A\x00\x02\x08\tB\nC\x0b\x0c\rD\x1f \ud800lone \udc00low 𝕳𝖊𝖑𝖑𝖔 中";
		expect(escapeXmlText(dirty)).toBe("A\tB\nC\rD lone low 𝕳𝖊𝖑𝖑𝖔 中");
	});
});

describe("run normalization and paragraph splitting", () => {
	test("merges adjacent runs with identical marks and normalizes CRLF / CR to LF", () => {
		const runs: Run[] = [{ t: "" }, { t: "Smith", i: 1 }, { t: " et al.", i: 1 }, { t: "\r\n2. " }, { t: "Chen\r3. Rossi" }];
		expect(normalizeRunsForInsertText(runs)).toEqual([{ t: "Smith et al.", i: 1 }, { t: "\n2. Chen\n3. Rossi" }]);
	});

	test("returns a single empty run when given no runs or only empty text", () => {
		expect(normalizeRunsForInsertText([])).toEqual([{ t: "" }]);
		expect(normalizeRunsForInsertText([{ t: "", b: 1 }, { t: "" }])).toEqual([{ t: "" }]);
	});

	test("splits runs across \\r, \\n, and \\r\\n while preserving formatting across paragraph breaks", () => {
		const runs: Run[] = [{ t: "1. Smith. " }, { t: "Book One\rBook Two", i: 1 }, { t: ".\r\n\n3. Rossi." }];
		expect(splitRunsIntoParagraphs(runs)).toEqual([
			[{ t: "1. Smith. " }, { t: "Book One", i: 1 }],
			[{ t: "Book Two", i: 1 }, { t: "." }],
			[],
			[{ t: "3. Rossi." }],
		]);
	});
});

describe("runsToOoxml and runsToBodyXml", () => {
	test("wraps body XML in a valid Flat OPC WordprocessingML package", () => {
		const xml = runsToOoxml([{ t: "(Smith, 2021)" }]);
		expect(xml).toContain('xmlns:pkg="http://schemas.microsoft.com/office/2006/xmlPackage"');
		expect(xml).toContain('pkg:name="/_rels/.rels"');
		expect(xml).toContain('Target="word/document.xml"');
		expect(xml).toContain('pkg:name="/word/document.xml"');
		expect(xml).toContain(
			'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>(Smith, 2021)</w:t></w:r></w:p></w:body></w:document>',
		);
	});

	test("produces a single empty <w:p/> for empty runs", () => {
		expect(runsToBodyXml([])).toBe("<w:p/>");
		expect(runsToBodyXml([{ t: "" }])).toBe("<w:p/>");
	});

	test("emits italic, bold, smallCaps, superscript, and subscript in ECMA-376 rPr sequence order", () => {
		const runs: Run[] = [{ t: "all", i: 1, b: 1, sc: 1, sup: 1 }, { t: "H" }, { t: "2", sub: 1 }, { t: "O" }];
		expect(runsToBodyXml(runs)).toBe(
			"<w:p>" +
				'<w:r><w:rPr><w:b/><w:i/><w:smallCaps/><w:vertAlign w:val="superscript"/></w:rPr><w:t>all</w:t></w:r>' +
				"<w:r><w:t>H</w:t></w:r>" +
				'<w:r><w:rPr><w:vertAlign w:val="subscript"/></w:rPr><w:t>2</w:t></w:r>' +
				"<w:r><w:t>O</w:t></w:r>" +
				"</w:p>",
		);
	});

	test("supersedes sub when both sup and sub are set so <w:vertAlign> is never duplicated", () => {
		const xml = runsToBodyXml([{ t: "1", sup: 1, sub: 1 }]);
		expect(xml).toBe('<w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>1</w:t></w:r></w:p>');
	});

	test("supports resetFormatting to explicitly turn off inactive character effects in <w:rPr>", () => {
		const xml = runsToBodyXml([{ t: "plain" }, { t: "em", i: 1 }], { resetFormatting: true });
		expect(xml).toBe(
			"<w:p>" +
				'<w:r><w:rPr><w:b w:val="0"/><w:i w:val="0"/><w:smallCaps w:val="0"/><w:vertAlign w:val="baseline"/></w:rPr><w:t>plain</w:t></w:r>' +
				'<w:r><w:rPr><w:b w:val="0"/><w:i/><w:smallCaps w:val="0"/><w:vertAlign w:val="baseline"/></w:rPr><w:t>em</w:t></w:r>' +
				"</w:p>",
		);
	});

	test('preserves leading and trailing spaces with xml:space="preserve" and converts \\t to <w:tab/>', () => {
		const runs: Run[] = [{ t: "1.\t" }, { t: "see ", i: 1 }, { t: "Smith & <Co.>" }];
		expect(runsToBodyXml(runs)).toBe(
			"<w:p>" +
				"<w:r><w:t>1.</w:t><w:tab/></w:r>" +
				'<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">see </w:t></w:r>' +
				"<w:r><w:t>Smith &amp; &lt;Co.&gt;</w:t></w:r>" +
				"</w:p>",
		);
	});

	test("generates multi-paragraph Bibliography OOXML with Bibliography style and optional spacing/indents/tabs", () => {
		const runs: Run[] = [
			{ t: "1.\tSmith J. " },
			{ t: "Transplantation", i: 1 },
			{ t: ".\r2.\tChen L. " },
			{ t: "J Hepatol", i: 1 },
			{ t: "." },
		];
		const styleOnly = runsToBodyXml(runs, { bibliographyStyle: true });
		expect(styleOnly).toBe(
			"<w:p>" +
				'<w:pPr><w:pStyle w:val="Bibliography"/></w:pPr>' +
				'<w:r><w:t>1.</w:t><w:tab/><w:t xml:space="preserve">Smith J. </w:t></w:r>' +
				"<w:r><w:rPr><w:i/></w:rPr><w:t>Transplantation</w:t></w:r>" +
				"<w:r><w:t>.</w:t></w:r>" +
				"</w:p>" +
				"<w:p>" +
				'<w:pPr><w:pStyle w:val="Bibliography"/></w:pPr>' +
				'<w:r><w:t>2.</w:t><w:tab/><w:t xml:space="preserve">Chen L. </w:t></w:r>' +
				"<w:r><w:rPr><w:i/></w:rPr><w:t>J Hepatol</w:t></w:r>" +
				"<w:r><w:t>.</w:t></w:r>" +
				"</w:p>",
		);

		const withFmt = runsToBodyXml([{ t: "1.\tEntry" }], {
			bibliographyStyle: true,
			bibliographyFormat: { secondFieldAlign: true, entrySpacing: 1, lineSpacing: 1.5 },
		});
		expect(withFmt).toBe(
			"<w:p>" +
				"<w:pPr>" +
				'<w:pStyle w:val="Bibliography"/>' +
				'<w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs>' +
				'<w:spacing w:after="240" w:line="360" w:lineRule="auto"/>' +
				'<w:ind w:left="720" w:hanging="720"/>' +
				"</w:pPr>" +
				"<w:r><w:t>1.</w:t><w:tab/><w:t>Entry</w:t></w:r>" +
				"</w:p>",
		);
	});
});
