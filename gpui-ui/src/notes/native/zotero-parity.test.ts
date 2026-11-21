// Where Zinc's parse.ts / serialize.ts used to differ from Zotero's own note editor, found by scripts/fuzz (the differential fuzzer):
// each test is one behaviour of the editor (EditorCore's constructor on open, buildToHTML on save) written down.
import { expect, test } from "bun:test";
import { loadNoteParser, type NoteNode } from "./parse";
import { serializeNote } from "./serialize";

const parser = (await loadNoteParser())!;
const enc = (o: unknown) => encodeURIComponent(JSON.stringify(o));
const walk = (n: NoteNode, f: (n: NoteNode) => void) => {
	f(n);
	for (const c of n.content ?? []) walk(c, f);
};
const find = (n: NoteNode, type: string) => {
	const out: NoteNode[] = [];
	walk(n, (x) => x.type === type && out.push(x));
	return out;
};
const save = (html: string) => serializeNote(parser.parse(html), html);

test("save: the schema version is 9 unless the note has an underline annotation (buildToHTML)", () => {
	expect(save(`<div data-schema-version="10"><p>a</p></div>`)).toContain('data-schema-version="9"');
	const ann = enc({ annotationKey: "K", color: "#ffd400" });
	expect(save(`<div data-schema-version="10"><p><span class="underline" data-annotation="${ann}">u</span></p></div>`)).toContain(
		'data-schema-version="10"',
	);
});

test("save: text is NFC-normalised", () => {
	expect(save(`<div data-schema-version="10"><p>é 한</p></div>`)).toContain("é 한");
});

test("save: a note of one empty text block is '' whatever the block (heading, code, maths)", () => {
	for (const html of ["<h2></h2>", "<pre></pre>", '<pre class="math"></pre>', "<p></p>"])
		expect(save(`<div data-schema-version="10">${html}</div>`)).toBe("");
	expect(save(`<div data-schema-version="10"><h2></h2><p></p></div>`)).not.toBe("");
});

test("save: <hr> is a void element (no newline inside it, no </hr>)", () => {
	const out = save(`<div data-schema-version="10"><p>a</p><hr><p>b</p></div>`);
	expect(out).toContain("<hr>\n<p>b</p>");
	expect(out).not.toContain("</hr>");
});

test("save: citation items no citation of the note as loaded uses are dropped; the rest keep their order", () => {
	const uri = (n: number) => `http://zotero.org/users/local/x/items/I${n}`;
	const items = [1, 2, 3].map((n) => ({ uris: [uri(n)], itemData: { id: `i${n}`, type: "book", title: `T${n}` } }));
	const cite = (n: number) =>
		`<span class="citation" data-citation="${enc({ citationItems: [{ uris: [uri(n)] }], properties: {} })}">(x)</span>`;
	const html = `<div data-citation-items="${enc(items)}" data-schema-version="10"><p>${cite(3)} ${cite(1)}</p></div>`;
	const got = (h: string) => JSON.parse(decodeURIComponent(/data-citation-items="([^"]*)"/.exec(h)![1]!)) as { uris: string[] }[];
	expect(got(save(html)).map((i) => i.uris[0])).toEqual([uri(1), uri(3)]);
	// edits do not prune: a citation deleted since the note was opened keeps its item until the next open
	const doc = parser.parse(html);
	doc.content![0]!.content = (doc.content![0]!.content ?? []).filter((c) => c.type !== "citation");
	expect(got(serializeNote(doc, html)).map((i) => i.uris[0])).toEqual([uri(1), uri(3)]);
	// a note from a newer schema opens read-only in Zotero: its metadata is left alone
	expect(got(save(html.replace('data-schema-version="10"', 'data-schema-version="11"')))).toHaveLength(3);
});

test("metadata is read from a top-level <div data-schema-version> only", () => {
	const items = [{ uris: ["u"], itemData: { id: "i", type: "book", title: "T" } }];
	const cite = `<span class="citation" data-citation="${enc({ citationItems: [{ uris: ["u"] }], properties: {} })}">(x)</span>`;
	expect(save(`<div data-citation-items="${enc(items)}"><p>${cite}</p></div>`)).not.toContain("data-citation-items");
	expect(save(`<div data-citation-items="${enc(items)}" data-schema-version="10"><p>${cite}</p></div>`)).toContain("data-citation-items");
});

test("load: an image keeps no marks, and only text keeps the code mark (schemaTransform)", () => {
	const doc = parser.parse(
		`<div data-schema-version="10"><p><a href="https://x.org/"><img src="a.png"></a> <code>a<br><span class="citation" data-citation="${enc({ citationItems: [], properties: {} })}"></span></code></p></div>`,
	);
	expect(find(doc, "image")[0]!.marks).toBeUndefined();
	for (const t of ["hardBreak", "citation"]) expect(find(doc, t)[0]!.marks?.some((m) => m.type === "code") ?? false).toBe(false);
	expect(find(doc, "text").some((t) => t.marks?.some((m) => m.type === "code"))).toBe(true);
});

test("load: an element with a src (not <img>) gets a link to it, a background-image url becomes an image (preprocessHTML)", () => {
	const doc = parser.parse(
		`<div data-schema-version="10"><p>a<iframe src="https://example.org/f"></iframe><span style="background-image: url('https://example.org/bg.png')">b</span></p></div>`,
	);
	const link = find(doc, "text").find((t) => t.marks?.some((m) => m.type === "link"));
	expect(link?.text).toBe("https://example.org/f");
	expect(find(doc, "image")[0]!.attrs?.src).toBe("https://example.org/bg.png");
});

test("load: a style on the root div reaches the text; NUL is dropped; the newline after <pre> is not content", () => {
	const doc = parser.parse(`<div data-schema-version="10" style="color: red"><p>a\u0000b</p><pre>\ncode</pre></div>`);
	expect(find(doc, "text")[0]!.marks?.[0]).toMatchObject({ type: "textColor" });
	expect(find(doc, "text")[0]!.text).toBe("ab");
	expect(find(doc, "codeBlock")[0]!.content![0]!.text).toBe("code");
	expect(find(parser.parse(`<pre>\n\n\ncode</pre>`), "codeBlock")[0]!.content![0]!.text).toBe("\ncode");
});

test("load: text next to an entity is one text node, so leading white space is collapsed across it", () => {
	const doc = parser.parse(`<div data-schema-version="10"><pre>x</pre>\n\n\n&#38;&#60;\n<p>b</p></div>`);
	expect(find(doc, "text").map((t) => t.text)).toEqual(["x", " &<", "b"]);
});
