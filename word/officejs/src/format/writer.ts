// Queueing citation and bibliography result text into `Word.Field.result` via two selectable strategies:
//   (a) "insertText": `insertText` per normalized run ("Replace" first, then "End") with explicit character-effect resets and
//       activations on each returned `Word.Range.font` (avoids Office.js `insertHtml` field corruption bugs #3613 / #4388 / #4891).
//   (b) "ooxml": one `field.result.insertOoxml(xml, "Replace")` call with generated Flat OPC WordprocessingML runs/paragraphs.
import type { BibliographyFormat, ResultWriter, Run } from "../contracts";
import { type BibliographyStyleKind, queueBibliographyFormat } from "./bibliography";
import { normalizeRunsForInsertText, type OoxmlOptions, runsToOoxml } from "./ooxml";

export type WriteStrategy = "insertText" | "ooxml";

export interface ResultWriterOptions {
	/** Writing strategy used by `queueResult`. Default: `"insertText"`. */
	strategy?: WriteStrategy;
	/** Optional override when the caller already knows whether `"Bibliography"` is `"builtIn"` or `"custom"`. */
	bibliographyStyleKind?: BibliographyStyleKind;
	/** When `strategy === "ooxml"`, emit explicit `w:val="0"` / `baseline` resets in `<w:rPr>`. */
	ooxmlResetFormatting?: boolean;
}

function replaceLocation(): string {
	return (typeof Word !== "undefined" && Word?.InsertLocation?.replace) || "Replace";
}

function endLocation(): string {
	return (typeof Word !== "undefined" && Word?.InsertLocation?.end) || "End";
}

/**
 * `Word.Font.smallCaps` belongs to `WordApiDesktop 1.3`. When running in a host whose `Office.context.requirements` explicitly
 * reports `WordApiDesktop 1.3` unsupported (e.g. Word on the web), skip touching `font.smallCaps` so `context.sync()` does not
 * fail with `PropertyNotAvailable`.
 */
function supportsSmallCapsFont(): boolean {
	try {
		if (typeof Office !== "undefined" && typeof Office?.context?.requirements?.isSetSupported === "function") {
			return !!Office.context.requirements.isSetSupported("WordApiDesktop", "1.3");
		}
	} catch {
		// Ignore host probe errors and assume desktop / test capability.
	}
	return true;
}

/**
 * Clear inherited character effects first (`false`) and then enable the run's own marks (`true`). Setting `false` before
 * `true` guarantees mutually exclusive `superscript` / `subscript` never clobber each other while issuing at most one write
 * per font property.
 */
function applyRunFont(font: any, run: Run, canSetSmallCaps: boolean): void {
	if (!font) return;
	const wantItalic = !!run.i;
	const wantBold = !!run.b;
	const wantSup = !!run.sup;
	const wantSub = !wantSup && !!run.sub;
	const wantSc = !!run.sc;

	if (!wantItalic) font.italic = false;
	if (!wantBold) font.bold = false;
	if (!wantSup) font.superscript = false;
	if (!wantSub) font.subscript = false;
	if (canSetSmallCaps && !wantSc) font.smallCaps = false;

	if (wantItalic) font.italic = true;
	if (wantBold) font.bold = true;
	if (wantSup) font.superscript = true;
	if (wantSub) font.subscript = true;
	if (canSetSmallCaps && wantSc) font.smallCaps = true;
}

/** Strategy (a): `insertText` per run (`"Replace"` for the first run, `"End"` inside `field.result` for subsequent runs). */
export function queueResultInsertText(field: Word.Field, runs: Run[]): void {
	const normalized = normalizeRunsForInsertText(runs);
	const res = field.result;
	const replaceLoc = replaceLocation();
	const endLoc = endLocation();
	const canSetSmallCaps = supportsSmallCapsFont();

	for (let i = 0; i < normalized.length; i++) {
		const run = normalized[i]!;
		const rng = res.insertText(run.t, i === 0 ? replaceLoc : endLoc);
		applyRunFont(rng?.font, run, canSetSmallCaps);
	}
}

/** Strategy (b): one `field.result.insertOoxml(xml, "Replace")` of generated WordprocessingML runs/paragraphs. */
export function queueResultOoxml(field: Word.Field, runs: Run[], options?: OoxmlOptions): void {
	const xml = runsToOoxml(runs, options);
	field.result.insertOoxml(xml, replaceLocation());
}

/** Create a standalone `ResultWriter` bound to the given options (or reading dynamically from a shared options object). */
export function createResultWriter(options: ResultWriterOptions = {}): ResultWriter {
	return {
		queueResult(field: Word.Field, runs: Run[]): void {
			const strategy = options.strategy ?? "insertText";
			if (strategy === "ooxml") {
				queueResultOoxml(field, runs, options.ooxmlResetFormatting ? { resetFormatting: true } : undefined);
			} else {
				queueResultInsertText(field, runs);
			}
		},
		queueBibliographyFormat(field: Word.Field, fmt: BibliographyFormat): void {
			queueBibliographyFormat(field, fmt, options.bibliographyStyleKind);
		},
	};
}
