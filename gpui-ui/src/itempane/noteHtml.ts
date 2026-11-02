// Note HTML <-> Markdown. Zotero notes are HTML; GPUIX has no web view (the web UI embeds Zotero's note-editor in an iframe), so the
// pane shows a note through the native <markdown> element and edits it as Markdown text in a <textarea>.
//   * htmlToMarkdown(html)  turndown (+ GFM: tables, strikethrough, task lists)
//   * markdownToHtml(md)    marked (single newlines become <br>, like Zotero paragraphs typed with Shift+Enter)
//   * isSimpleNoteHtml(html) true when the HTML only uses constructs that survive that round trip. Notes with anything else (spans
//     with attributes such as annotation highlights and citations, images, sub/superscripts, styles) are edited as raw HTML so no
//     data is lost. noteWrapper() keeps Zotero's <div data-schema-version=...> wrapper intact on save.
import { marked } from "marked";
import TurndownService from "turndown";
// @ts-expect-error no types for the GFM plugin
import { gfm } from "turndown-plugin-gfm";
import { decodeEntities } from "./util";

type El = { t: string; a: Record<string, string>; c: N[] };
type N = string | El;

const VOID = new Set(["br", "hr", "img", "meta", "link", "input", "wbr"]);

function parse(html: string): N[] {
	const root: El = { t: "#root", a: {}, c: [] };
	const stack = [root];
	const re = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|[^<]+|</g;
	for (let m: RegExpExecArray | null; (m = re.exec(html)); ) {
		const top = stack[stack.length - 1]!;
		if (m[0].startsWith("<!--")) continue;
		if (m[2] === undefined) { top.c.push(m[0]); continue; }
		const tag = m[2].toLowerCase();
		if (m[1]) {
			// closing: pop to the matching open element (tolerate unbalanced markup)
			for (let i = stack.length - 1; i > 0; i--) if (stack[i]!.t === tag) { stack.length = i; break; }
			continue;
		}
		const a: Record<string, string> = {};
		for (const am of m[3]!.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
			a[am[1]!.toLowerCase()] = decodeEntities(am[2] ?? am[3] ?? am[4] ?? "");
		}
		const el: El = { t: tag, a, c: [] };
		top.c.push(el);
		if (!VOID.has(tag) && !m[0].endsWith("/>")) stack.push(el);
	}
	return root.c;
}

let td: TurndownService | undefined;
export function htmlToMarkdown(html: string): string {
	if (!td) {
		td = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced", emDelimiter: "*", strongDelimiter: "**", hr: "---" });
		td.use(gfm);
	}
	// <li><p>text</p>…</li> (what Zotero's editor writes) would become a loose list with blank lines: unwrap single paragraphs
	const tight = html.replace(/<li>\s*<p>((?:(?!<\/?p[ >]).)*?)<\/p>\s*(?=<ul|<ol|<\/li>)/gis, "<li>$1");
	return td.turndown(tight).trim();
}

export function markdownToHtml(md: string): string {
	const html = (marked.parse(md, { async: false, gfm: true, breaks: true }) as string).trim();
	// like Zotero's editor, keep quotes literal in text (marked writes &quot; / &#39;); tags and their attributes are left alone
	return html.replace(/(<[^>]*>)|&quot;|&#39;/g, (m, tag: string | undefined) => (tag ? tag : m === "&quot;" ? '"' : "'"));
}

// ---- which notes can be edited as Markdown without loss ----

const OK_TAGS = new Set(["p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "s", "strike", "del", "code", "pre", "a", "ul", "ol", "li", "blockquote", "hr", "div"]);

export function isSimpleNoteHtml(html: string): boolean {
	let simple = true;
	const check = (nodes: N[], top: boolean) => {
		for (const n of nodes) {
			if (typeof n === "string" || !simple) continue;
			if (!OK_TAGS.has(n.t)) { simple = false; return; }
			const attrs = Object.keys(n.a);
			const allowed = n.t === "a" ? ["href"] : n.t === "ol" ? ["start"] : n.t === "div" && top ? ["data-schema-version", "class"] : [];
			if (attrs.some((k) => !allowed.includes(k))) { simple = false; return; }
			if (n.t === "div" && !top) { simple = false; return; }
			check(n.c, false);
		}
	};
	check(parse(html), true);
	return simple;
}

/** Zotero's wrapper element, kept when the note had one so the note-editor keeps recognising the schema version. */
export function noteWrapper(html: string): { open: string; close: string } {
	// a single top-level <div ...>...</div> (Zotero writes <div class="zotero-note znv1"> or <div data-schema-version="9">)
	const top = parse(html).filter((n) => typeof n !== "string" || n.trim());
	const m = /^\s*(<div\b[^>]*>)[\s\S]*<\/div>\s*$/.exec(html);
	return m && top.length === 1 && typeof top[0] !== "string" && top[0]!.t === "div" ? { open: m[1]!, close: "</div>" } : { open: "", close: "" };
}
