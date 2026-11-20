// Citation and bibliography visible result formatting for Office.js (`ResultWriter`).
// Exposes two writing strategies behind `formatOptions.strategy` ("insertText" default, or "ooxml").
import type { ResultWriter } from "../contracts";
import {
	type BibliographyStyleKind,
	ensureBibliographyStyle,
	HANGING_INDENT_PT,
	POINTS_PER_LINE,
	queueBibliographyFormat,
	queueLoadBibliographyStyle,
} from "./bibliography";
import {
	escapeXmlAttr,
	escapeXmlText,
	normalizeRunsForInsertText,
	type OoxmlOptions,
	runsToBodyXml,
	runsToOoxml,
	splitRunsIntoParagraphs,
} from "./ooxml";
import { createResultWriter, queueResultInsertText, queueResultOoxml, type ResultWriterOptions, type WriteStrategy } from "./writer";

/**
 * Shared option controlling how `resultWriter` writes field results:
 * - `"insertText"` (recommended default): `insertText` per run with font properties set on each returned `Word.Range`.
 * - `"ooxml"`: one `field.result.insertOoxml(xml, "Replace")` call with generated WordprocessingML runs/paragraphs.
 */
export const formatOptions: ResultWriterOptions & { strategy: WriteStrategy } = {
	strategy: "insertText",
};

export function setWriteStrategy(strategy: WriteStrategy): void {
	formatOptions.strategy = strategy;
}

export const resultWriter: ResultWriter = createResultWriter(formatOptions);

export {
	type BibliographyStyleKind,
	createResultWriter,
	ensureBibliographyStyle,
	escapeXmlAttr,
	escapeXmlText,
	HANGING_INDENT_PT,
	normalizeRunsForInsertText,
	type OoxmlOptions,
	POINTS_PER_LINE,
	queueBibliographyFormat,
	queueLoadBibliographyStyle,
	queueResultInsertText,
	queueResultOoxml,
	type ResultWriterOptions,
	runsToBodyXml,
	runsToOoxml,
	splitRunsIntoParagraphs,
	type WriteStrategy,
};
