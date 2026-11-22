// The XML reader of the EndNote, MODS and Zotero RDF importers: text order for mixed content, and identical importer output.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseEndnoteXml } from "../../src/io/endnote";
import { parseMods } from "../../src/io/mods";
import { parseZoteroRdf } from "../../src/io/rdf";
import { blockText, parseXml, textOf } from "../../src/io/xml";
import { endnoteXml, modsXml, rdfXml } from "./xml-fixtures";

describe("parseXml text", () => {
	test("mixed content keeps document order", () => {
		const a = parseXml("<a>one<b>two</b>three<c>four<d>five</d></c>six</a>").children[0]!;
		expect(a.text).toBe("onetwothreefourfivesix");
		expect(a.own).toBe("onethreesix");
		expect(a.children[0]!.text).toBe("two");
		expect(a.children[1]!.text).toBe("fourfive");
		expect(a.children[1]!.own).toBe("four");
		expect(textOf(a)).toBe("onetwothreefourfivesix");
	});

	test("the root holds everything, in order", () => {
		const root = parseXml("<?xml version='1.0'?><!-- c --><r>a <x>b</x> c<y/>d<z><![CDATA[<e>]]></z></r>");
		expect(root.text).toBe("a b cd<e>");
		expect(root.own).toBe("");
		expect(root.children[0]!.own).toBe("a  cd");
	});

	test("entities are decoded, whitespace is collapsed by textOf and kept by blockText", () => {
		const n = parseXml("<p>R&amp;D  and\n\n\n\n  more <b>bold &lt;x&gt;</b></p>").children[0]!;
		expect(n.text).toBe("R&D  and\n\n\n\n  more bold <x>");
		expect(textOf(n)).toBe("R&D and more bold <x>");
		expect(blockText(n)).toBe("R&D and\n\n more bold <x>");
	});

	test("a closing tag with nothing open and an unclosed element do not throw", () => {
		expect(parseXml("</x><a>text").children[0]!.text).toBe("text");
	});

	test("a document nested 50000 deep is read without recursion", () => {
		const depth = 50_000;
		const root = parseXml(`${"<a>".repeat(depth)}deep${"</a>".repeat(depth)}`);
		expect(root.text).toBe("deep");
		expect(root.children[0]!.text).toBe("deep");
	});

	test("deep nesting with many text pieces stays fast", () => {
		const depth = 3000;
		const text = `${"<a>".repeat(depth)}${"piece <i>x</i>".repeat(20_000)}${"</a>".repeat(depth)}`;
		const t0 = performance.now();
		const root = parseXml(text);
		expect(performance.now() - t0).toBeLessThan(5000); // minutes of work and gigabytes when every open element copied every piece
		expect(root.text.length).toBe("piece x".length * 20_000);
	});
});

const sha = (v: unknown) => createHash("sha1").update(JSON.stringify(v)).digest("hex");

describe("importers return what they returned before the text was kept per element", () => {
	// hashes of the importers' output on these fixtures, taken with the reader that appended every piece to every ancestor
	test("EndNote XML", () => {
		const r = parseEndnoteXml(endnoteXml(150));
		expect(r.errors).toEqual([]);
		expect(r.items.length).toBe(150);
		expect(sha(r)).toBe("8bce358b81682db598642c2ae5e2f7f43cb005f1");
	});

	test("MODS", () => {
		const r = parseMods(modsXml(150));
		expect(r.errors).toEqual([]);
		expect(r.items.length).toBe(150);
		expect(sha(r)).toBe("e3d06d7e5b36c0dc5a7f230c4536a87d13d94248");
	});

	test("Zotero RDF", () => {
		const r = parseZoteroRdf(rdfXml(150));
		expect(r.errors).toEqual([]);
		expect(r.items.length).toBe(150);
		expect(sha(r)).toBe("87bf0d39f0304eb242143881a8d1844b01cf6add");
	});

	test("EndNote title and note built from several styled runs", () => {
		const r = parseEndnoteXml(endnoteXml(1));
		expect(r.items[0]!.data.title).toBe("Cells and tissues 0 part two");
		expect(r.items[0]!.notes[0]).toContain("Remember this 0 and more afterwards");
	});
});
