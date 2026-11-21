// Block <-> Markdown for native note editing: the user edits one top-level block of a note as Markdown text, and the text becomes
// zero or more blocks again under Zotero's schema (same parser as the view, so the result is what Zotero's editor would load).
import { htmlToMarkdown, markdownToHtml } from "../../itempane/noteHtml";
import { loadNoteParser, type NoteNode } from "./parse";
import { serializeBlocks } from "./serialize";

// loadNoteParser is async only by contract: it resolves immediately, so a top-level await keeps the exports synchronous.
const parser = await loadNoteParser();

/** Markdown typed by the user -> top-level blocks under Zotero's schema ([] for empty / whitespace-only text). */
export function markdownToBlocks(md: string): NoteNode[] {
	if (!parser || md.trim() === "") return [];
	const content = parser.parse(markdownToHtml(md)).content ?? [];
	// a lone empty paragraph is what an empty document parses to
	if (content.length === 1 && content[0]!.type === "paragraph" && !(content[0]!.content ?? []).length) return [];
	for (const n of content) trimCodeBlocks(n);
	return content;
}

/** marked ends a fenced block's text with a newline that is not part of the code (Zotero's <pre> has none). */
function trimCodeBlocks(n: NoteNode): void {
	if (n.type === "codeBlock") for (const t of n.content ?? []) if (t.text?.endsWith("\n")) t.text = t.text.slice(0, -1);
	for (const c of n.content ?? []) trimCodeBlocks(c);
}

/** JSON for comparison: a null attr is the same as an absent one (ProseMirror fills defaults either way). */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x === null ? undefined : x));

/**
 * Zotero writes strike-through as <span style="text-decoration: line-through"> and code blocks as a bare <pre>; turndown only knows
 * <del> and <pre><code>, so it would drop the first and not fence the second. Rewritten here (noteHtml.ts stays as is).
 */
const forTurndown = (html: string): string =>
	html
		.replace(/<span style="text-decoration: line-through">([^<]*)<\/span>/g, "<del>$1</del>")
		.replace(/<pre>([\s\S]*?)<\/pre>/g, "<pre><code>$1</code></pre>");

/** The block as Markdown for editing, or null when it cannot be edited this way without losing something. */
export function blockToMarkdown(block: NoteNode): string | null {
	if (!parser) return null;
	try {
		const md = htmlToMarkdown(forTurndown(serializeBlocks([block])));
		if (md.trim() === "") return null;
		// lossless or not editable: formatting Markdown cannot carry (colour, underline, citations, tables, images, maths, indent...)
		// does not survive the round trip, so the block stays read-only rather than silently losing it
		return canon(markdownToBlocks(md)) === canon([block]) ? md : null;
	} catch {
		return null;
	}
}
