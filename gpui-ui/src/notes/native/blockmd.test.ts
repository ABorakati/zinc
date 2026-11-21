import { describe, expect, test } from "bun:test";
import { blockToMarkdown, markdownToBlocks } from "./blockmd";
import { loadNoteParser, type NoteNode } from "./parse";

const parser = (await loadNoteParser())!;
const blocks = (html: string): NoteNode[] => parser.parse(`<div data-schema-version="10">${html}</div>`).content ?? [];
const one = (html: string): NoteNode => blocks(html)[0]!;

const EDITABLE: Record<string, string> = {
	"inline marks": `<p>Plain <strong>bold</strong> <em>it</em> <span style="text-decoration: line-through">s</span> <code>c</code> <a href="https://x.org/">link</a></p>`,
	h1: `<h1>Title</h1>`,
	h2: `<h2>Title</h2>`,
	h3: `<h3>Title</h3>`,
	h4: `<h4>Title</h4>`,
	h5: `<h5>Title</h5>`,
	h6: `<h6>Title</h6>`,
	"bullet list": `<ul><li><p>one</p></li><li><p>two</p></li></ul>`,
	"nested bullets": `<ul><li><p>one</p><ul><li><p>nested</p></li></ul></li><li><p>two</p></li></ul>`,
	"ordered list": `<ol><li><p>one</p></li><li><p>two</p></li></ol>`,
	"ordered from 3": `<ol start="3"><li><p>three</p></li><li><p>four</p></li></ol>`,
	"nested ordered": `<ol><li><p>one</p><ol><li><p>sub</p></li></ol></li></ol>`,
	blockquote: `<blockquote><p>quoted <em>text</em></p></blockquote>`,
	"code block": `<pre>code\nblock</pre>`,
	hr: `<hr>`,
	"hard break": `<p>line one<br>line two</p>`,
};

const NOT_EDITABLE: Record<string, string> = {
	"text colour": `<p>a <span style="color: #ff2020">red</span> b</p>`,
	underline: `<p>a <u>under</u> b</p>`,
	highlight: `<p><span class="highlight" data-annotation="${encodeURIComponent(JSON.stringify({ annotationKey: "K1", color: "#ffd400" }))}">quoted</span></p>`,
	citation: `<p><span class="citation" data-citation="${encodeURIComponent(JSON.stringify({ citationItems: [{ uris: ["http://zotero.org/users/local/abcd1234/items/PARENT01"] }], properties: {} }))}">(<span class="citation-item">Beck, 2026</span>)</span></p>`,
	"sub/sup": `<p>x<sup>2</sup></p>`,
	table: `<table><tbody><tr><th><p>A</p></th></tr><tr><td><p>1</p></td></tr></tbody></table>`,
	image: `<p><img data-attachment-key="ABCD1234" alt="" width="10" height="10"></p>`,
	"display math": `<pre class="math">$$x^2$$</pre>`,
	"inline math": `<p>inline <span class="math">$y$</span></p>`,
	"indented paragraph": `<p style="padding-left: 40px">indented</p>`,
};

describe("blockToMarkdown / markdownToBlocks round trip", () => {
	for (const [name, html] of Object.entries(EDITABLE)) {
		test(`${name} is editable and round-trips`, () => {
			const b = one(html);
			const md = blockToMarkdown(b);
			expect(md).not.toBeNull();
			expect(markdownToBlocks(md!)).toEqual([b]);
		});
	}
	for (const [name, html] of Object.entries(NOT_EDITABLE)) {
		test(`${name} is not editable`, () => {
			expect(blockToMarkdown(one(html))).toBeNull();
		});
	}
	test("an empty paragraph is not editable", () => {
		expect(blockToMarkdown({ type: "paragraph" })).toBeNull();
	});
});

describe("markdownToBlocks", () => {
	test("empty and whitespace-only text is no blocks", () => {
		expect(markdownToBlocks("")).toEqual([]);
		expect(markdownToBlocks("  \n\n ")).toEqual([]);
	});
	test("blank lines split paragraphs", () => {
		const out = markdownToBlocks("a\n\nb");
		expect(out.map((n) => n.type)).toEqual(["paragraph", "paragraph"]);
	});
	test("# T is a level 1 heading", () => {
		const [h] = markdownToBlocks("# T");
		expect(h!.type).toBe("heading");
		expect(h!.attrs?.level).toBe(1);
	});
	test("a bullet list with two items", () => {
		const [l, ...rest] = markdownToBlocks("- x\n- y");
		expect(rest).toEqual([]);
		expect(l!.type).toBe("bulletList");
		expect(l!.content).toHaveLength(2);
	});
	test("a single newline is a hard break", () => {
		const [p] = markdownToBlocks("a\nb");
		expect(p!.content!.map((n) => n.type)).toEqual(["text", "hardBreak", "text"]);
	});
});
