import { describe, expect, test } from "bun:test";
import type { PdfRect } from "../../src/contract";
import type { Reference } from "../../../core/src/api-types";
import {
	entryCandidates, expandCitationGroup, findRefStartInPages, isInReferences, parseCitationNumbers, resolveAuthorYear, resolveCitation,
} from "../../src/academic/citations";
import { captionStart, findAuthorYear, findFigureMentions, findSupplementaryMentions } from "../../src/academic/mentions";
import { classifyAttachment, matchSupplement, supplementaryItems } from "../../src/academic/supp";
import { scanCaptionsInPage } from "../../src/academic/figures";
import { charsInRect } from "../../src/academic/textlines";

/** Build page text + char rects from lines {x, top, text}; glyph 5 wide, 10 high. */
function page(lines: { x: number; top: number; text: string }[]) {
	let text = "";
	const rects: PdfRect[] = [];
	for (const l of lines) {
		for (let i = 0; i < l.text.length; i++) {
			text += l.text[i];
			rects.push([l.x + i * 5, l.top - 10, l.x + i * 5 + 5, l.top]);
		}
		text += "\n";
		rects.push([0, 0, 0, 0]);
	}
	return { text, rects };
}

const refs: Reference[] = [
	{ index: 1, raw: "Smith J, Jones K. Deep learning for liver segmentation. Nature Methods 2020", title: "Deep learning for liver segmentation", authors: ["Smith J", "Jones K"], year: 2020, doi: "10.1000/abc" },
	{ index: 2, raw: "Brown A. Transplant outcomes in older donors. Lancet 2018", title: "Transplant outcomes in older donors", authors: ["Brown A"], year: 2018 },
	{ index: 3, title: "Graft survival after reperfusion", authors: ["Lee C", "Wu D", "Patel R"], year: 2019 },
];

describe("citation numbers", () => {
	test("single, list, range", () => {
		expect(parseCitationNumbers("[12]")).toEqual([12]);
		expect(parseCitationNumbers("[3,5,9]")).toEqual([3, 5, 9]);
		expect(parseCitationNumbers("[3–6]")).toEqual([3, 4, 5, 6]);
		expect(parseCitationNumbers("(1, 3-4)")).toEqual([1, 3, 4]);
		expect(parseCitationNumbers("Smith 2020")).toEqual([]);
		expect(parseCitationNumbers("[6-3]")).toEqual([]);
	});
	test("expand link text to its bracket group", () => {
		const t = "as shown [3, 5, 9] before";
		const a = t.indexOf("5");
		expect(expandCitationGroup(t, [a, a + 1])).toBe("[3, 5, 9]");
		const sup = "over the past 2 decades,10–16 leading to";
		const k = sup.indexOf("10");
		expect(expandCitationGroup(sup, [k, k + 2])).toBe("10–16");
		expect(parseCitationNumbers("10–16")).toEqual([10, 11, 12, 13, 14, 15, 16]);
	});
});

describe("reference list detection", () => {
	test("heading page and destination test", () => {
		const p0 = page([{ x: 50, top: 700, text: "Introduction" }]);
		const p1 = page([{ x: 50, top: 700, text: "Discussion" }, { x: 50, top: 400, text: "References" }, { x: 50, top: 380, text: "[1] A" }]);
		const start = findRefStartInPages([p0, p1])!;
		expect(start.page).toBe(1);
		expect(isInReferences(start, 1, 380)).toBe(true);
		expect(isInReferences(start, 1, 650)).toBe(false);
		expect(isInReferences(start, 0, 100)).toBe(false);
		expect(isInReferences(start, 2, 100)).toBe(true);
	});
});

describe("destination -> reference", () => {
	const numeric = page([
		{ x: 50, top: 700, text: "[1] J. Smith, K. Jones. Deep learning for" },
		{ x: 50, top: 688, text: "liver segmentation. Nature Methods 2020." },
		{ x: 50, top: 670, text: "[2] A. Brown. Transplant outcomes in older" },
		{ x: 50, top: 658, text: "donors. Lancet 2018." },
		{ x: 50, top: 640, text: "[3] C. Lee, D. Wu, R. Patel. Graft survival after" },
		{ x: 50, top: 628, text: "reperfusion. 2019." },
	]);
	test("numeric entry is isolated and matched", () => {
		const c = entryCandidates(4, numeric, 701);
		expect(c.length).toBe(1);
		expect(c[0]!.marker).toBe(1);
		expect(c[0]!.text).toContain("liver segmentation");
		expect(c[0]!.text).not.toContain("Brown");
		const r = resolveCitation({ refs, page: 4, top: 671, pageText: numeric, number: 2 });
		expect(r.ref?.index).toBe(2);
		expect(r.entry?.text).toContain("Transplant outcomes");
	});
	test("falls back to index when no text is available", () => {
		const r = resolveCitation({ refs, page: 4, top: 0, pageText: null, number: 3 });
		expect(r.ref?.index).toBe(3);
		expect(r.via).toBe("index");
	});
	test("author-year hanging indent entries + DOI match", () => {
		const ay = page([
			{ x: 50, top: 700, text: "Brown, A. (2018). Transplant outcomes in older" },
			{ x: 60, top: 688, text: "donors. Lancet, 12, 1-9." },
			{ x: 50, top: 670, text: "Smith, J., & Jones, K. (2020). Deep learning for" },
			{ x: 60, top: 658, text: "liver segmentation. Nature Methods. https://doi.org/10.1000/abc" },
		]);
		const a = resolveCitation({ refs, page: 0, top: 701, pageText: ay });
		expect(a.ref?.index).toBe(2);
		const b = resolveCitation({ refs, page: 0, top: 671, pageText: ay });
		expect(b.ref?.index).toBe(1);
		expect(b.via).toBe("doi");
	});
	test("two columns: marker picks the right candidate", () => {
		const cols = page([
			{ x: 50, top: 700, text: "[4] Left column entry about other things." },
			{ x: 300, top: 700, text: "[2] A. Brown. Transplant outcomes in older donors. Lancet 2018." },
		]);
		const r = resolveCitation({ refs, page: 0, top: 701, pageText: cols, number: 2 });
		expect(r.ref?.index).toBe(2);
	});
	test("charsInRect finds the link text", () => {
		const p = page([{ x: 100, top: 500, text: "see [3, 5] now" }]);
		const i = p.text.indexOf("5");
		const idx = charsInRect(p.rects, [100 + i * 5, 490, 100 + i * 5 + 5, 500], 0.5)!;
		expect(p.text.slice(idx[0], idx[1])).toBe("5");
	});
});

describe("author-year", () => {
	test("finds forms", () => {
		const m = findAuthorYear("as in (Smith et al., 2020) and Brown (2018), also Smith and Jones, 2020a.");
		expect(m.map((x) => [x.surname, x.year])).toEqual([["Smith", 2020], ["Brown", 2018], ["Smith", 2020]]);
		expect(m[2]!.second).toBe("Jones");
	});
	test("resolves uniquely or not at all", () => {
		const [a, b] = findAuthorYear("(Smith et al., 2020) (Nobody et al., 2020)");
		expect(resolveAuthorYear(refs, a!)?.index).toBe(1);
		expect(resolveAuthorYear(refs, b!)).toBeNull();
		expect(resolveAuthorYear(refs, findAuthorYear("Lee et al. 2019")[0]!)?.index).toBe(3);
	});
});

describe("figure/table mentions", () => {
	test("labels, panels, plurals", () => {
		const m = findFigureMentions("See Figure 2 and Fig. 3a; Tables 1 and 2 show; Table S1; fig 4B-C.");
		expect(m.map((x) => x.key)).toEqual(["figure:2", "figure:3", "table:1", "table:2", "table:S1", "figure:4"]);
		expect(m[1]!.panel).toBe("a");
	});
	test("no false positives", () => {
		expect(findFigureMentions("a stable 3 mg dose, the variable 2")).toEqual([]);
	});
	test("caption lines and scanning", () => {
		expect(captionStart("Figure 1. Overview of the method")?.key).toBe("figure:1");
		expect(captionStart("Table 2 | Baseline")?.key).toBe("table:2");
		expect(captionStart("Figure 1 shows that")).toBeNull();
		const p = page([{ x: 50, top: 300, text: "Figure 3. Survival curves by donor age" }, { x: 50, top: 288, text: "for all patients." }, { x: 50, top: 250, text: "Body text goes on here." }]);
		const items = scanCaptionsInPage(5, p);
		expect(items.length).toBe(1);
		expect(items[0]!.key).toBe("figure:3");
		expect(items[0]!.caption).toContain("for all patients");
		expect(items[0]!.caption).not.toContain("Body text");
	});
});

describe("supplementary", () => {
	test("mentions", () => {
		const t = "(Supplementary Table S1), eTable 2, Supplementary Figure S3, see Appendix B and Supporting Information.";
		const m = findSupplementaryMentions(t);
		expect(m.map((x) => x.kind)).toEqual(["table", "table", "figure", "appendix", "material"]);
		expect(m[0]!.number).toBe("S1");
	});
	test("attachments are classified and matched", () => {
		const kids = [
			{ key: "A", itemType: "attachment", title: "paper.pdf", contentType: "application/pdf", linkMode: "imported_file", hasFile: true, annotationCount: 0 },
			{ key: "B", itemType: "attachment", title: "Supplementary Table S1.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", linkMode: "imported_file", hasFile: true, annotationCount: 0 },
			{ key: "C", itemType: "attachment", title: "media-1.pdf", contentType: "application/pdf", linkMode: "imported_file", hasFile: true, annotationCount: 0 },
			{ key: "D", itemType: "note", title: "n", contentType: null, linkMode: null, hasFile: false, annotationCount: 0 },
		];
		const items = supplementaryItems(kids as any, "A");
		expect(items.map((i) => i.key)).toEqual(["B", "C"]);
		expect(items[0]!.kind).toBe("sheet");
		expect(classifyAttachment({ title: "x", contentType: null, linkMode: "linked_url" })).toBe("link");
		const m = findSupplementaryMentions("Supplementary Table S1")[0]!;
		expect(matchSupplement(m, items)[0]!.item.key).toBe("B");
		const f = findSupplementaryMentions("Supplementary Table S2")[0]!;
		expect(matchSupplement(f, items).find((x) => x.item.key === "B")?.score ?? 0).toBeLessThan(matchSupplement(m, items)[0]!.score);
	});
});
