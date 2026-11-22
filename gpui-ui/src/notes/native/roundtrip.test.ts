// HTML -> ProseMirror JSON (parse.ts) -> HTML (serialize.ts) -> JSON is stable for every synthetic note in fixtures/, and the raw
// citation / annotation attributes survive byte for byte.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { loadNoteParser, type NoteNode } from "./parse";
import { serializeNote, stableDoc } from "./serialize";

const DIR = new URL("./fixtures/", import.meta.url);
const files = readdirSync(DIR)
	.filter((f) => f.endsWith(".html"))
	.sort();
const parser = (await loadNoteParser())!;

const json = (n: NoteNode) => JSON.stringify(stableDoc(n));
/** every data-citation / data-annotation attribute value, in document order */
const rawAttrs = (html: string) => [...html.matchAll(/ data-(citation|annotation)="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`);

test("fixtures exist", () => expect(files.length).toBeGreaterThanOrEqual(12));

describe("round trip", () => {
	for (const f of files) {
		const html = readFileSync(new URL(f, DIR), "utf8").trim();
		test(`${f}: HTML -> JSON -> HTML -> JSON is stable`, () => {
			const doc = parser.parse(html);
			const out = serializeNote(doc, html);
			expect(out.startsWith("<div ")).toBe(true);
			expect(json(parser.parse(out))).toBe(json(doc));
			// serializing what was serialized changes nothing: the output is Zotero's normal form
			expect(serializeNote(parser.parse(out), out)).toBe(out);
		});
		test(`${f}: citation and annotation attributes are byte-identical`, () => {
			const out = serializeNote(parser.parse(html), html);
			expect(rawAttrs(out)).toEqual(rawAttrs(html));
			// the metadata keeps the items that citations and annotations use, as Zotero's editor does (it drops the others when it opens a note)
			const items = (h: string) =>
				JSON.parse(decodeURIComponent(/data-citation-items="([^"]*)"/.exec(h)?.[1] ?? "%5B%5D")) as { uris: string[] }[];
			const used = decodeURIComponent(rawAttrs(html).join(" "));
			expect(items(out)).toEqual(items(html).filter((i) => i.uris.some((u) => used.includes(u))));
		});
	}
});

test("known normalisation: consecutive spaces in a code block become space + no-break space on the first save, then stay", () => {
	const html = `<div data-schema-version="10"><pre>a  b</pre></div>`;
	const once = serializeNote(parser.parse(html), html);
	expect(once).toContain("a &#160;b");
	expect(serializeNote(parser.parse(once), once)).toBe(once);
});

test("the fixtures between them use every node and mark the editor must carry", () => {
	const seen = new Set<string>();
	const walk = (n: NoteNode) => {
		seen.add(n.type);
		for (const m of n.marks ?? []) seen.add(`mark:${m.type}`);
		for (const c of n.content ?? []) walk(c);
	};
	for (const f of files) walk(parser.parse(readFileSync(new URL(f, DIR), "utf8")));
	for (const t of [
		"paragraph",
		"heading",
		"blockquote",
		"codeBlock",
		"math_display",
		"math_inline",
		"bulletList",
		"orderedList",
		"listItem",
		"table",
		"table_row",
		"table_header",
		"table_cell",
		"horizontalRule",
		"hardBreak",
		"citation",
		"image",
		"highlight",
		"underline_annotation",
		"mark:strong",
		"mark:em",
		"mark:underline",
		"mark:strike",
		"mark:code",
		"mark:subsup",
		"mark:textColor",
		"mark:backgroundColor",
		"mark:link",
	])
		expect(seen.has(t) ? t : `missing ${t}`).toBe(t);
});
