import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
// @ts-expect-error untyped JS
import { packStructuredDocumentText } from "../../../vendor/reader/structured-document-text/src/pack/writer.js";
import { captionLabel, cleanText, convertSdt, joinFragments, type Sdt } from "../../src/structure/convert";
import { openPack } from "../../src/structure/vendor";
import paper from "./fixtures/paper.sdt.json";

const sdt = paper as unknown as Sdt;
const doc = convertSdt(sdt);

const tn = (text: string, extra: object = {}) => ({ text, ...extra });
const rect = (page: number, x1: number, y1: number, x2: number, y2: number) => ({ pageRects: [[page, x1, y1, x2, y2]] });
const tiny = (content: object[], pages = 1): Sdt => ({
	metadata: {},
	catalog: { pages: Array.from({ length: pages }, () => ({ viewRect: [0, 0, 612, 792] })), outline: [] },
	content,
} as Sdt);

describe("convertSdt on a real paper (Zotero SDT fixture)", () => {
	test("produces typed blocks in reading order", () => {
		const types = new Set(doc.blocks.map((b) => b.type));
		for (const t of ["title", "heading", "paragraph", "list", "figure", "caption", "reference", "footnote"]) expect(types.has(t as never)).toBe(true);
		expect(doc.blocks[0].type).toBe("title");
		expect(doc.blocks[0].text).toStartWith("Trace-based Just-in-Time");
		expect(doc.blocks.every((b) => b.rects.length > 0 || b.type === "figure")).toBe(true);
	});

	test("rects are PDF-space [x1,y1,x2,y2] with y2 > y1", () => {
		for (const b of doc.blocks) for (const r of b.rects) { expect(r[2]).toBeGreaterThanOrEqual(r[0]); expect(r[3]).toBeGreaterThanOrEqual(r[1]); }
	});

	test("figures link to their captions with labels", () => {
		expect(doc.figures.length).toBe(13);
		const f2 = doc.figures.find((f) => f.label === "Figure 2")!;
		expect(f2.page).toBe(1);
		expect(f2.caption).toStartWith("Figure 2. State machine");
		const cap = doc.blocks.find((b) => b.id === f2.captionBlockId)!;
		expect(cap.type).toBe("caption");
		expect(cap.captionOf).toBe(f2.id);
		expect(doc.blocks.find((b) => b.id === f2.id)!.type).toBe("figure");
		expect(f2.rect[2]).toBeGreaterThan(f2.rect[0]);
	});

	test("code listing (no image) is captured as a figure region", () => {
		const f3 = doc.figures.find((f) => f.label === "Figure 3")!;
		expect(f3).toBeDefined();
		expect(f3.page).toBe(2);
	});

	test("reference list entries are extracted in order with markers stripped", () => {
		expect(doc.references.length).toBe(19);
		expect(doc.references[0].index).toBe(1);
		expect(doc.references[0].text).toStartWith("LuaJIT roadmap");
		expect(doc.references[11].text).toStartWith("C. Garrett");
		expect(doc.references[0].page).toBe(13);
	});

	test("in-text citations become internal links with destinations", () => {
		const p = doc.blocks.find((b) => b.html?.includes('class="rx-cite"') && b.text.includes("hot loops to be mostly type-stable"))!;
		expect(p.html).toContain('data-page="13"');
		const fig = doc.blocks.find((b) => b.html?.includes('data-page="1"') && b.html.includes("Figure 1"));
		expect(fig).toBeDefined();
	});

	test("external links keep their URL", () => {
		expect(doc.blocks.some((b) => b.html?.includes('href="http://www.mozilla.com"'))).toBe(true);
	});

	test("outline comes from the catalog with levels", () => {
		expect(doc.outline[0].title).toStartWith("Trace-based");
		const sub = doc.outline.find((o) => o.title === "3.1 Traces")!;
		expect(sub.level).toBe(2);
		expect(doc.blocks.some((b) => b.id === sub.blockId)).toBe(true);
	});

	test("heading levels follow section numbering", () => {
		const h = (s: string) => doc.blocks.find((b) => b.type === "heading" && b.text.startsWith(s))!;
		expect(h("1. Introduction").level).toBe(2);
		expect(h("3.1 Traces").level).toBe(3);
	});

	test("lists drop bullet glyphs and render as html lists", () => {
		const l = doc.blocks.find((b) => b.type === "list")!;
		expect(l.html).toStartWith("<ul><li>");
		expect(l.text).not.toContain("•");
	});

	test("survives a real SDT pack round trip (pako inflate + pack reader)", async () => {
		const withHash = { ...sdt, metadata: { processor: { type: "pdf", version: 1 }, dateCreated: "2000-01-01T00:00:00.000Z", source: { contentType: "application/pdf", hash: "4b3eba8b56059fd5c4b90ff1974970aa" } } };
		const bytes: Uint8Array = packStructuredDocumentText(structuredClone(withHash), { deflate: (b: Uint8Array) => deflateRawSync(b) });
		const reader = await openPack(bytes);
		const back = convertSdt((await reader.materialize()) as Sdt);
		expect(back.blocks.length).toBe(doc.blocks.length);
		expect(back.figures.length).toBe(doc.figures.length);
		expect(back.references.length).toBe(doc.references.length);
	});
});

describe("convertSdt edge cases", () => {
	test("excluded paragraphs become header/footer by position", () => {
		const d = convertSdt(tiny([
			{ type: "paragraph", flowClass: "excluded", anchor: rect(0, 50, 760, 300, 775), content: [tn("Journal of Things 2020")] },
			{ type: "paragraph", anchor: rect(0, 50, 400, 500, 600), content: [tn("Body text here.")] },
			{ type: "paragraph", flowClass: "excluded", anchor: rect(0, 300, 20, 320, 30), content: [tn("12")] },
		]));
		expect(d.blocks.map((b) => b.type)).toEqual(["header", "paragraph", "footer"]);
	});

	test("hyphenated line breaks are joined", () => {
		expect(cleanText("informa-\ntion about the infor­mation")).toBe("information about the information");
		expect(cleanText("well-\nKnown")).toBe("well- Known"); // capital: a real hyphen
		expect(joinFragments("a long informa-", "tion system")).toBe("a long information system");
		expect(joinFragments("end of sentence.", "Start")).toBe("end of sentence. Start");
	});

	test("parts of one paragraph on the same page are merged and de-hyphenated", () => {
		const d = convertSdt(tiny([
			{ type: "paragraph", anchor: rect(0, 50, 400, 290, 700), content: [tn("The informa-")], nextPart: [1] },
			{ type: "paragraph", anchor: rect(0, 320, 400, 560, 700), content: [tn("tion flows on.")], previousPart: [0] },
		]));
		expect(d.blocks.length).toBe(1);
		expect(d.blocks[0].text).toBe("The information flows on.");
		expect(d.blocks[0].rects.length).toBe(2);
	});

	test("inline styles become html; refs and urls become links", () => {
		const d = convertSdt(tiny([
			{ type: "paragraph", anchor: rect(0, 50, 400, 290, 700), content: [
				tn("H"), tn("2", { style: { sub: true } }), tn("O is "), tn("wet", { style: { italic: true } }),
				tn(" [1]", { refs: [[1]] }), tn(" <x> & ", {}), tn("site", { target: { url: "https://e.org/?a=1&b=2" } }),
			] },
			{ type: "paragraph", reference: true, anchor: rect(1, 50, 600, 290, 640), content: [tn("[1] Smith. A paper.")] },
		], 2));
		const p = d.blocks[0];
		expect(p.html).toContain("H<sub>2</sub>O is <i>wet</i>");
		expect(p.html).toContain('<a class="rx-cite" href="#" data-kind="ref" data-page="1" data-top="640"> [1]</a>');
		expect(p.html).toContain("&lt;x&gt; &amp; ");
		expect(p.html).toContain('href="https://e.org/?a=1&amp;b=2"');
		expect(d.references[0]).toMatchObject({ index: 1, text: "Smith. A paper.", page: 1 });
	});

	test("references fall back to the section after a References heading", () => {
		const d = convertSdt(tiny([
			{ type: "heading", anchor: rect(0, 50, 700, 200, 720), content: [tn("References")] },
			{ type: "paragraph", anchor: rect(0, 50, 650, 500, 690), content: [tn("1. First ref.")] },
			{ type: "paragraph", anchor: rect(0, 50, 600, 500, 640), content: [tn("2. Second ref.")] },
		]));
		expect(d.references.map((r) => r.text)).toEqual(["First ref.", "Second ref."]);
	});

	test("a caption without a detected image gets a region from the open space above it", () => {
		const d = convertSdt(tiny([
			{ type: "paragraph", anchor: rect(0, 50, 650, 290, 740), content: [tn("Some text above.")] },
			{ type: "caption", flowClass: "auxiliary", anchor: rect(0, 50, 380, 290, 400), content: [tn("Fig. 4: A vector plot.")] },
			{ type: "paragraph", anchor: rect(0, 50, 100, 290, 360), content: [tn("Text below.")] },
		]));
		expect(d.figures.length).toBe(1);
		expect(d.figures[0].label).toBe("Figure 4");
		expect(d.figures[0].rect[1]).toBeGreaterThan(400);
		expect(d.figures[0].rect[3]).toBeLessThan(651);
	});

	test("table captions pair with table blocks", () => {
		const d = convertSdt(tiny([
			{ type: "caption", flowClass: "auxiliary", anchor: rect(0, 50, 600, 500, 620), content: [tn("Table 2. Results.")] },
			{ type: "table", flowClass: "auxiliary", anchor: rect(0, 50, 400, 500, 595), content: [tn("a b c")] },
		]));
		expect(d.tables.length).toBe(1);
		expect(d.tables[0]).toMatchObject({ kind: "table", label: "Table 2", page: 0 });
		expect(d.blocks.find((b) => b.id === d.tables[0].id)!.type).toBe("table");
	});

	test("a running head inside a figure's bounding box is cropped off", () => {
		const d = convertSdt(tiny([
			{ type: "paragraph", flowClass: "excluded", anchor: rect(0, 50, 770, 500, 780), content: [tn("Author et al. Journal 2022")] },
			{ type: "image", flowClass: "auxiliary", anchor: rect(0, 50, 400, 500, 785), content: [] },
			{ type: "caption", flowClass: "auxiliary", anchor: rect(0, 50, 370, 500, 390), content: [tn("Figure 1. Plot.")] },
		]));
		expect(d.figures[0].rect[3]).toBeLessThan(770);
		expect(d.figures[0].rect[1]).toBe(400);
	});

	test("caption labels", () => {
		expect(captionLabel("Figure 2: foo")).toEqual({ label: "Figure 2", kind: "figure" });
		expect(captionLabel("Fig. 3A. foo")).toEqual({ label: "Figure 3A", kind: "figure" });
		expect(captionLabel("TABLE 1 Baseline")).toEqual({ label: "Table 1", kind: "table" });
		expect(captionLabel("Supplementary Figure S2. x")?.label).toBe("Supplementary Figure S2");
		expect(captionLabel("(a) left panel")).toBeNull();
		expect(captionLabel("Figures were produced")).toBeNull();
	});
});
