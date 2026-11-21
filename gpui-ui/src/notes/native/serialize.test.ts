import { describe, expect, test } from "bun:test";
import { loadNoteParser, type NoteNode } from "./parse";
import { serializeBlocks, serializeNote } from "./serialize";

const enc = (o: unknown) => encodeURIComponent(JSON.stringify(o));
const URI = "http://zotero.org/users/local/abcd1234/items/PARENT01";
const items = [{ uris: [URI], itemData: { type: "book", title: "T", author: [{ family: "Beck" }], issued: { "date-parts": [["2026"]] } } }];
const NOTES: Record<string, string> = {
	formatting: `<div data-schema-version="10"><h1>Title</h1><p>Plain <strong>bold</strong> <em>it</em> <u>u</u> <span style="text-decoration: line-through">s</span> <code>c</code> x<sup>2</sup> <a href="https://x.org/">link</a> <span style="color: #ff2020">red</span></p></div>`,
	lists: `<div data-schema-version="10"><ul><li><p>one</p><ul><li><p>nested</p></li></ul></li><li><p>two</p></li></ul><ol start="3"><li><p>three</p></li></ol><blockquote><p>quoted</p></blockquote><pre>code\nblock</pre><hr><p style="padding-left: 40px">indented</p></div>`,
	table: `<div data-schema-version="10"><table><tbody><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table></div>`,
	citations: `<div data-citation-items="${enc(items)}" data-schema-version="9"><p><span class="highlight" data-annotation="${enc({ annotationKey: "K1", color: "#ffd400" })}">"quoted"</span> <span class="citation" data-citation="${enc({ citationItems: [{ uris: [URI], locator: "3" }], properties: {} })}">(<span class="citation-item">Beck, 2026, p. 3</span>)</span> comment</p></div>`,
	math: `<div data-schema-version="10"><pre class="math">$$x^2$$</pre><p>inline <span class="math">$y$</span></p></div>`,
};

const parser = (await loadNoteParser())!;
/** JSON without random citation node ids and the display text parse.ts adds */
const comparable = (n: NoteNode): string =>
	JSON.stringify(n, (k, v) => (k === "nodeID" || (k === "text" && typeof v === "string" && v.startsWith("(")) ? undefined : v));

describe("serializeNote", () => {
	for (const [name, html] of Object.entries(NOTES)) {
		test(`${name}: parse -> serialize -> parse gives the same document`, () => {
			const doc = parser.parse(html);
			const out = serializeNote(doc, html);
			expect(out.startsWith("<div ")).toBe(true);
			expect(comparable(parser.parse(out))).toBe(comparable(doc));
		});
	}

	test("keeps the note's citation metadata and schema version", () => {
		const out = serializeNote(parser.parse(NOTES.citations!), NOTES.citations!);
		expect(out).toContain("data-citation-items=");
		expect(out).toContain('data-schema-version="');
		expect(out).toContain('class="citation"');
	});

	test("an empty note is the empty string, as in Zotero", () => {
		expect(serializeNote({ type: "doc", content: [{ type: "paragraph" }] }, "")).toBe("");
	});

	test("serializeBlocks writes a fragment without the root div", () => {
		const doc = parser.parse(NOTES.lists!);
		const html = serializeBlocks(doc.content!.slice(0, 1));
		expect(html.startsWith("<ul>")).toBe(true);
		// a list item with a nested list keeps its <p>; a lone <p> is unwrapped (as Zotero writes it)
		expect(html).toContain("<li>\n<p>one</p>");
		expect(html).toContain("<li>\ntwo\n</li>");
	});
});
