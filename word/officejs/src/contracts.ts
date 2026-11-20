// The seams between the Office.js add-in's parts. Each part lives in its own folder and is written separately; they meet only
// here. Results and parameters of every method are exactly those of the Windows COM add-in (word/addin/Bridge.cs, WordDoc.cs),
// which the sidebar (word/sidebar) already speaks; word/sidebar/src/mockhost.ts is an in-memory copy of the same contract.
import type { Run } from "../../../core/src/cite/docfields";

export type { Run };

/** One bridge method: params in, JSON-able result out (or a thrown Error whose message the sidebar shows). */
export type Method = (params: Record<string, unknown>) => Promise<unknown>;
export type Methods = Record<string, Method>;

export interface HostContext {
	/** Raise a sidebar event ("cursor" for the cursor watcher, "command" for ribbon commands). */
	emit(event: string, data: unknown): void;
}

/** src/host: every doc.* method (doc.state, doc.fields, doc.insert, doc.set, doc.setMany, ...). */
export type CreateDocMethods = (ctx: HostContext) => Methods;

/** src/services: host.info, settings.*, lib.*, style.*, locale.*, zn.*, app.openUrl. */
export type CreateServiceMethods = (ctx: HostContext) => Methods;

/** The bibliography's paragraph format, as the sidebar sends it with a bibliography write (doc.set / doc.setMany "format"). */
export interface BibliographyFormat {
	hanging?: boolean;
	secondFieldAlign?: boolean;
	/** CSL entry-spacing: lines between entries */
	entrySpacing?: number;
	/** CSL line-spacing: 1, 1.5, 2 */
	lineSpacing?: number;
}

/**
 * src/format: writes a field's visible result. Both functions only QUEUE Office.js commands on the field's request context;
 * the caller syncs (so a refresh writes every field in one batch). Called with Track Changes already switched off.
 */
export interface ResultWriter {
	/** Replace the result of `field` by `runs` (italic, bold, superscript, subscript, small caps; "\r" or "\n" = new paragraph). */
	queueResult(field: Word.Field, runs: Run[]): void;
	/** Give a bibliography field's paragraphs the Bibliography style, hanging indent and entry spacing. */
	queueBibliographyFormat(field: Word.Field, fmt: BibliographyFormat): void;
}
