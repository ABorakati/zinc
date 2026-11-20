// Pure WordprocessingML (Flat OPC package) generation for `Range.insertOoxml(..., "Replace")`.
// No Office.js or DOM globals: safe to test and run anywhere.
import type { BibliographyFormat, Run } from "../contracts";

const PKG_NS = "http://schemas.microsoft.com/office/2006/xmlPackage";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOC_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const MAIN_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const RELS_CONTENT_TYPE = "application/vnd.openxmlformats-package.relationships+xml";
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const TWIPS_PER_POINT = 20;
const POINTS_PER_LINE = 12;
const HANGING_TWIPS = 36 * TWIPS_PER_POINT; // 36 pt = 720 dxa
const LINE_TWIPS = POINTS_PER_LINE * TWIPS_PER_POINT; // 12 pt / 1 auto line = 240

export interface OoxmlOptions {
	/**
	 * Apply the Bibliography paragraph style (`<w:pStyle w:val="Bibliography"/>`), or a custom style ID string, to each
	 * generated paragraph.
	 */
	bibliographyStyle?: boolean | string;
	/** Optional bibliography paragraph formatting (`<w:tabs>`, `<w:spacing>`, `<w:ind>`) emitted in `<w:pPr>`. */
	bibliographyFormat?: BibliographyFormat;
	/**
	 * Emit explicit `w:val="0"` / `w:val="baseline"` resets in `<w:rPr>` for inactive character effects so an inline
	 * replacement cannot inherit character formatting from adjacent range markers.
	 */
	resetFormatting?: boolean;
}

/**
 * Strip illegal XML 1.0 control characters (everything < U+0020 except TAB, LF, CR, plus lone UTF-16 surrogates) that
 * occasionally appear in imported citation metadata and would make Word reject `insertOoxml` with `InvalidArgument`.
 */
function stripInvalidXmlChars(s: string): string {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
			if (next >= 0xdc00 && next <= 0xdfff) {
				out += s[i]! + s[i + 1]!;
				i++;
			}
			continue;
		}
		if (code >= 0xdc00 && code <= 0xdfff) continue;
		if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
		if (code === 0xfffe || code === 0xffff) continue;
		out += s[i]!;
	}
	return out;
}

/** Escape text content for an XML element (`&`, `<`, `>`), stripping illegal XML 1.0 characters. */
export function escapeXmlText(s: string): string {
	return stripInvalidXmlChars(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape a value for a double-quoted XML attribute (`&`, `"`, `<`, `>`, `'`), stripping illegal XML 1.0 characters. */
export function escapeXmlAttr(s: string): string {
	return escapeXmlText(s).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function sameMarks(a: Run, b: Run): boolean {
	return !!a.i === !!b.i && !!a.b === !!b.b && !!a.sup === !!b.sup && !!a.sub === !!b.sub && !!a.sc === !!b.sc;
}

function copyMarks(r: Run): Omit<Run, "t"> {
	const m: Omit<Run, "t"> = {};
	if (r.i) m.i = 1;
	if (r.b) m.b = 1;
	if (r.sup) m.sup = 1;
	else if (r.sub) m.sub = 1;
	if (r.sc) m.sc = 1;
	return m;
}

function normalizeNewlines(s: string): string {
	return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Normalize runs for `Range.insertText`: `\r\n` and `\r` become `\n`, empty runs are dropped, adjacent runs with identical
 * character formatting are merged, and an empty input yields a single `[{ t: "" }]` run so the caller still clears the field.
 */
export function normalizeRunsForInsertText(runs: Run[]): Run[] {
	const merged: Run[] = [];
	for (const r of runs) {
		const t = normalizeNewlines(r.t);
		if (!t) continue;
		const next: Run = { t, ...copyMarks(r) };
		const prev = merged[merged.length - 1];
		if (prev && sameMarks(prev, next)) prev.t += t;
		else merged.push(next);
	}
	return merged.length > 0 ? merged : [{ t: "" }];
}

/**
 * Split `runs` on `\r\n`, `\r`, or `\n` into per-paragraph run lists (`Run[][]`). Always returns at least one paragraph so
 * `<w:body>` contains a valid `<w:p>` element even when `runs` is empty.
 */
export function splitRunsIntoParagraphs(runs: Run[]): Run[][] {
	const paragraphs: Run[][] = [[]];
	for (const r of runs) {
		if (!r.t) continue;
		const marks = copyMarks(r);
		const parts = normalizeNewlines(r.t).split("\n");
		for (let p = 0; p < parts.length; p++) {
			if (p > 0) paragraphs.push([]);
			const text = parts[p]!;
			if (!text) continue;
			const cur = paragraphs[paragraphs.length - 1]!;
			const next: Run = { t: text, ...marks };
			const prev = cur[cur.length - 1];
			if (prev && sameMarks(prev, next)) prev.t += text;
			else cur.push(next);
		}
	}
	return paragraphs;
}

/**
 * `<w:rPr>` children in ECMA-376 `EG_RPrBase` sequence order: `w:b`, `w:i`, `w:smallCaps`, `w:vertAlign`.
 */
function buildRunPropertiesXml(r: Run, resetFormatting: boolean): string {
	let inner = "";
	if (r.b) inner += "<w:b/>";
	else if (resetFormatting) inner += '<w:b w:val="0"/>';

	if (r.i) inner += "<w:i/>";
	else if (resetFormatting) inner += '<w:i w:val="0"/>';

	if (r.sc) inner += "<w:smallCaps/>";
	else if (resetFormatting) inner += '<w:smallCaps w:val="0"/>';

	if (r.sup) inner += '<w:vertAlign w:val="superscript"/>';
	else if (r.sub) inner += '<w:vertAlign w:val="subscript"/>';
	else if (resetFormatting) inner += '<w:vertAlign w:val="baseline"/>';

	return inner ? `<w:rPr>${inner}</w:rPr>` : "";
}

function buildTextSegmentXml(seg: string): string {
	const escaped = escapeXmlText(seg);
	if (!escaped) return "";
	const preserve = /^\s|\s$/.test(escaped) ? ' xml:space="preserve"' : "";
	return `<w:t${preserve}>${escaped}</w:t>`;
}

function buildRunXml(r: Run, resetFormatting: boolean): string {
	const clean = stripInvalidXmlChars(r.t);
	if (!clean) return "";
	const parts = clean.split("\t");
	let content = "";
	for (let i = 0; i < parts.length; i++) {
		if (i > 0) content += "<w:tab/>";
		if (parts[i]) content += buildTextSegmentXml(parts[i]!);
	}
	if (!content) return "";
	return `<w:r>${buildRunPropertiesXml(r, resetFormatting)}${content}</w:r>`;
}

/**
 * `<w:pPr>` children in ECMA-376 `CT_PPrBase` sequence order: `w:pStyle`, `w:tabs`, `w:spacing`, `w:ind`.
 */
function buildParagraphPropertiesXml(options?: OoxmlOptions): string {
	if (!options) return "";
	let inner = "";

	if (options.bibliographyStyle) {
		const styleId = typeof options.bibliographyStyle === "string" ? options.bibliographyStyle : "Bibliography";
		inner += `<w:pStyle w:val="${escapeXmlAttr(styleId)}"/>`;
	}

	const fmt = options.bibliographyFormat;
	if (fmt) {
		if (fmt.secondFieldAlign) {
			inner += `<w:tabs><w:tab w:val="left" w:pos="${HANGING_TWIPS}"/></w:tabs>`;
		}

		const hasAfter = fmt.entrySpacing !== undefined && Number.isFinite(fmt.entrySpacing) && fmt.entrySpacing >= 0;
		const hasLine = fmt.lineSpacing !== undefined && Number.isFinite(fmt.lineSpacing) && fmt.lineSpacing > 0;
		if (hasAfter || hasLine) {
			const afterAttr = hasAfter ? ` w:after="${Math.round(fmt.entrySpacing! * LINE_TWIPS)}"` : "";
			const lineAttr = hasLine ? ` w:line="${Math.round(fmt.lineSpacing! * LINE_TWIPS)}" w:lineRule="auto"` : "";
			inner += `<w:spacing${afterAttr}${lineAttr}/>`;
		}

		if (fmt.hanging || fmt.secondFieldAlign) {
			inner += `<w:ind w:left="${HANGING_TWIPS}" w:hanging="${HANGING_TWIPS}"/>`;
		}
	}

	return inner ? `<w:pPr>${inner}</w:pPr>` : "";
}

/** Inner `<w:p>...</w:p>` XML placed inside `<w:body>`. */
export function runsToBodyXml(runs: Run[], options?: OoxmlOptions): string {
	const paragraphs = splitRunsIntoParagraphs(runs);
	const pPr = buildParagraphPropertiesXml(options);
	const reset = !!options?.resetFormatting;
	let out = "";
	for (const pRuns of paragraphs) {
		let runsXml = "";
		for (const r of pRuns) runsXml += buildRunXml(r, reset);
		if (!pPr && !runsXml) out += "<w:p/>";
		else out += `<w:p>${pPr}${runsXml}</w:p>`;
	}
	return out;
}

/**
 * Pure conversion from `Run[]` to a complete Flat OPC WordprocessingML package string suitable for
 * `field.result.insertOoxml(xml, "Replace")`.
 */
export function runsToOoxml(runs: Run[], options?: OoxmlOptions): string {
	const bodyXml = runsToBodyXml(runs, options);
	return (
		`<pkg:package xmlns:pkg="${PKG_NS}">` +
		`<pkg:part pkg:name="/_rels/.rels" pkg:contentType="${RELS_CONTENT_TYPE}">` +
		`<pkg:xmlData>` +
		`<Relationships xmlns="${RELS_NS}">` +
		`<Relationship Id="rId1" Type="${DOC_REL_TYPE}" Target="word/document.xml"/>` +
		`</Relationships>` +
		`</pkg:xmlData>` +
		`</pkg:part>` +
		`<pkg:part pkg:name="/word/document.xml" pkg:contentType="${MAIN_CONTENT_TYPE}">` +
		`<pkg:xmlData>` +
		`<w:document xmlns:w="${W_NS}"><w:body>${bodyXml}</w:body></w:document>` +
		`</pkg:xmlData>` +
		`</pkg:part>` +
		`</pkg:package>`
	);
}
