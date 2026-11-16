// Quick Copy decisions, kept free of UI / network so they are unit tested (logic.test.ts).
//
// Zotero's Quick Copy: one format for "copy" and for dragging items into another app. The format is either a citation style
// (bibliography entries, or in-text citations) or an export format (BibTeX, RIS…, in which case the text is the export and the
// bibliography / citation distinction does not apply). The default result is a bibliography; Shift flips it to a citation.
import type { CiteFormat, CiteMode, QuickCopySettings } from "../../../../core/src/cite/types";

/** What a Quick Copy produces: an export in an export format, or a style-formatted bibliography / citation. */
export type QuickCopyPlan =
	{ kind: "export"; format: string } | { kind: "style"; style: string; locale: string; mode: CiteMode; includeHtml: boolean };

export const flipMode = (m: CiteMode): CiteMode => (m === "citation" ? "bibliography" : "citation");

/**
 * @param s        the stored Quick Copy settings (style, locale, default mode, HTML or plain)
 * @param exportFormat  "" = use the citation style; otherwise an export format id (bibtex, ris, csljson…)
 * @param how      `mode`: an explicit result (the Copy Bibliography / Copy Citation shortcuts);
 *                 `shift`: a drag, where the stored default mode applies and Shift flips it
 */
export function planQuickCopy(s: QuickCopySettings, exportFormat: string, how: { mode?: CiteMode; shift?: boolean } = {}): QuickCopyPlan {
	if (exportFormat) return { kind: "export", format: exportFormat };
	const mode = how.mode ?? (how.shift ? flipMode(s.mode) : s.mode);
	// "Include HTML" off (output format "Plain text") puts plain text only on the clipboard / drag
	return { kind: "style", style: s.style, locale: s.locale, mode, includeHtml: (s.format as CiteFormat) !== "text" };
}

/** Stable key of a plan, to memoise the formatted result while one drag is under way. */
export const planKey = (p: QuickCopyPlan): string =>
	p.kind === "export" ? `export:${p.format}` : `style:${p.style}:${p.locale}:${p.mode}:${p.includeHtml ? "h" : "t"}`;

/** The request for POST /api/cite/format. */
export function formatRequest(
	keys: string[],
	p: Extract<QuickCopyPlan, { kind: "style" }>,
): { keys: string[]; style: string; locale: string; mode: CiteMode; format: CiteFormat[] } {
	return { keys, style: p.style, locale: p.locale, mode: p.mode, format: p.includeHtml ? ["html", "text"] : ["text"] };
}

/** The toast after a copy: "Bibliography copied (3 items, vancouver)". */
export function copiedMessage(p: QuickCopyPlan, count: number): string {
	const items = `${count} ${count === 1 ? "item" : "items"}`;
	if (p.kind === "export") return `${p.format} copied (${items})`;
	return `${p.mode === "citation" ? "Citation" : "Bibliography"} copied (${items}, ${p.style})`;
}

/** Normalised text for the drop: no trailing newlines (a bibliography ends with one, which would leave an empty line in a text box). */
export const dropText = (t: string): string => t.replace(/[\r\n]+$/, "");
