import { describe, expect, test } from "bun:test";
import type { PdfRect } from "../../src/contract";
import {
	annotationAt, hitsAnnotation, mergeLineRects, rectsOnPage, resizeRect, sameLine, selectionToPosition, thinInk,
} from "../../src/annotations/geometry";
import {
	areaPosition, bySortIndex, closestOffset, COLORS, formatSortIndex, generateKey, inkPosition, isDisplayable, isKey, makeAnnotation,
	matchesFilter, notePosition, notesHtml, nowIso, pageLabelFor, roundPosition, sortIndexFor, textPosition, toWire, translatePosition,
	withRect, type Annotation,
} from "../../src/annotations/model";

const ann = (over: Partial<Annotation> = {}): Annotation => ({
	id: "ABCD2345", type: "highlight", color: "#ffd400", sortIndex: "00000|000010|00100",
	position: { pageIndex: 0, rects: [[10, 700, 60, 712]] }, text: "hello", comment: "", tags: [], pageLabel: "1", dateModified: "2026-01-01T00:00:00Z", ...over,
});

describe("keys", () => {
	test("generateKey makes Zotero keys", () => {
		for (let i = 0; i < 200; i++) expect(isKey(generateKey())).toBe(true);
		expect(generateKey(() => 0)).toBe("22222222");
		expect(generateKey(() => 0.999999)).toBe("ZZZZZZZZ");
	});
	test("isKey rejects look-alikes", () => {
		expect(isKey("abcd2345")).toBe(false); // lowercase
		expect(isKey("ABCDE10O")).toBe(false); // 0, 1, O are not allowed
		expect(isKey("ABC")).toBe(false);
		expect(isKey("4W3K7HFS")).toBe(true);
	});
});

describe("sortIndex", () => {
	test("format matches Zotero (PPPPP|OOOOOO|TTTTT)", () => {
		expect(formatSortIndex(0, 112, 28)).toBe("00000|000112|00028");
		expect(formatSortIndex(5, 3135, 101.9)).toBe("00005|003135|00101");
		expect(formatSortIndex(12, 0, 0)).toBe("00012|000000|00000");
	});
	test("offset is the closest character, top is the distance from the page top", () => {
		const chars: PdfRect[] = [[0, 0, 0, 0], [10, 700, 15, 710], [20, 700, 25, 710], [10, 100, 15, 110]];
		expect(closestOffset(chars, [19, 701, 24, 709])).toBe(2);
		const si = sortIndexFor({ pageIndex: 3, rects: [[19, 701, 24, 709]] }, 792, chars);
		expect(si).toBe("00003|000002|00083"); // 792 - 709
	});
	test("uses the topmost rect of a multi-line highlight", () => {
		const si = sortIndexFor({ pageIndex: 0, rects: [[10, 600, 50, 612], [10, 700, 50, 712]] }, 800, []);
		expect(si).toBe("00000|000000|00088");
	});
	test("sorts lexicographically by page, offset, top", () => {
		const a = ann({ sortIndex: "00001|000005|00010" }), b = ann({ sortIndex: "00000|999999|00099" }), c = ann({ sortIndex: "00001|000005|00200" });
		expect([a, c, b].sort(bySortIndex).map((x) => x.sortIndex)).toEqual([b.sortIndex, a.sortIndex, c.sortIndex]);
	});
});

describe("positions", () => {
	test("note is a 22pt box centred on the click", () => {
		expect(notePosition(2, 100, 200)).toEqual({ pageIndex: 2, rects: [[89, 189, 111, 211]] });
	});
	test("note stays on the page", () => {
		expect(notePosition(0, 0, 0, 600, 800).rects![0]).toEqual([0, 0, 22, 22]);
		expect(notePosition(0, 999, 999, 600, 800).rects![0]).toEqual([578, 778, 600, 800]);
	});
	test("area normalises corners and clamps to the page", () => {
		expect(areaPosition(1, [300, 400], [100, 500], 612, 792)).toEqual({ pageIndex: 1, rects: [[100, 400, 300, 500]] });
		expect(areaPosition(0, [-20, 10], [700, 900], 612, 792).rects![0]).toEqual([0, 10, 612, 792]);
	});
	test("positions are rounded to 3 decimals like Zotero", () => {
		expect(roundPosition({ pageIndex: 0, rects: [[1.23456, 2.34567, 3.45678, 4.56789]], width: 2.00049 })).toEqual({
			pageIndex: 0, rects: [[1.235, 2.346, 3.457, 4.568]], width: 2,
		});
		expect(inkPosition(0, 2, [[1.0004, 2.0006, 3, 4]]).paths).toEqual([[1, 2.001, 3, 4]]);
	});
	test("text position keeps a continuation on the next page", () => {
		expect(textPosition(4, [[1, 2, 3, 4]], [[5, 6, 7, 8]])).toEqual({ pageIndex: 4, rects: [[1, 2, 3, 4]], nextPageRects: [[5, 6, 7, 8]] });
		expect(textPosition(4, [[1, 2, 3, 4]], [])).toEqual({ pageIndex: 4, rects: [[1, 2, 3, 4]] });
	});
	test("translate and resize", () => {
		expect(translatePosition({ pageIndex: 0, rects: [[0, 0, 10, 10]] }, 5, -2).rects).toEqual([[5, -2, 15, 8]]);
		expect(translatePosition({ pageIndex: 0, width: 2, paths: [[1, 1, 2, 2]] }, 10, 20).paths).toEqual([[11, 21, 12, 22]]);
		expect(withRect({ pageIndex: 0, rects: [[0, 0, 1, 1]] }, [1.00004, 2, 3, 4]).rects).toEqual([[1, 2, 3, 4]]);
		expect(resizeRect([10, 10, 50, 50], "se", 80, 0)).toEqual([10, 0, 80, 50]);
		expect(resizeRect([10, 10, 50, 50], "nw", 100, 100)).toEqual([42, 10, 50, 100]); // minimum size keeps x1 < x2
	});
});

describe("selection -> rects", () => {
	const word = (x: number, y: number, w = 20): PdfRect => [x, y, x + w, y + 10];
	test("words on one line merge into one rect", () => {
		expect(mergeLineRects([word(10, 700), word(34, 700), word(58, 700)])).toEqual([[10, 700, 78, 710]]);
	});
	test("a new line starts a new rect", () => {
		expect(mergeLineRects([word(10, 700), word(34, 700), word(10, 686), word(34, 686)])).toEqual([[10, 700, 54, 710], [10, 686, 54, 696]]);
	});
	test("words in distant columns stay separate", () => {
		expect(mergeLineRects([word(10, 700), word(300, 700)])).toHaveLength(2);
	});
	test("slightly different heights on one line (superscripts) still merge", () => {
		expect(mergeLineRects([[10, 700, 30, 710], [31, 703, 36, 711]])).toEqual([[10, 700, 36, 711]]);
	});
	test("empty and zero-size rects are dropped", () => {
		expect(mergeLineRects([[1, 1, 1, 5], [0, 0, 0, 0]])).toEqual([]);
		expect(sameLine([0, 0, 10, 10], [0, 9, 10, 19])).toBe(false);
	});
	test("a selection over two pages becomes rects + nextPageRects, further pages are ignored", () => {
		const pos = selectionToPosition([
			{ page: 6, rects: [word(10, 20)] }, { page: 5, rects: [word(10, 700), word(34, 700)] }, { page: 7, rects: [word(1, 1)] },
		]);
		expect(pos).toEqual({ pageIndex: 5, rects: [[10, 700, 54, 710]], nextPageRects: [[10, 20, 30, 30]] });
	});
	test("non-adjacent pages do not become a continuation", () => {
		expect(selectionToPosition([{ page: 1, rects: [word(0, 0)] }, { page: 3, rects: [word(0, 0)] }])).toEqual({ pageIndex: 1, rects: [[0, 0, 20, 10]] });
		expect(selectionToPosition([])).toBeNull();
		expect(selectionToPosition([{ page: 0, rects: [] }])).toBeNull();
	});
});

describe("hit testing", () => {
	test("highlight rects", () => {
		const a = ann();
		expect(hitsAnnotation(a, 0, 30, 705, 0)).toBe(true);
		expect(hitsAnnotation(a, 0, 30, 690, 0)).toBe(false);
		expect(hitsAnnotation(a, 1, 30, 705, 0)).toBe(false);
	});
	test("continuation rects on the next page", () => {
		const a = ann({ position: { pageIndex: 2, rects: [[0, 0, 5, 5]], nextPageRects: [[10, 10, 50, 20]] } });
		expect(hitsAnnotation(a, 3, 20, 15, 0)).toBe(true);
		expect(hitsAnnotation(a, 2, 20, 15, 0)).toBe(false);
		expect(rectsOnPage(a.position, 3)).toEqual([[10, 10, 50, 20]]);
		expect(rectsOnPage(a.position, 4)).toEqual([]);
	});
	test("ink hits near the stroke only", () => {
		const a = ann({ type: "ink", position: { pageIndex: 0, width: 2, paths: [[0, 0, 100, 0]] } });
		expect(hitsAnnotation(a, 0, 50, 2, 2)).toBe(true);
		expect(hitsAnnotation(a, 0, 50, 10, 2)).toBe(false);
	});
	test("the smallest annotation under the point wins", () => {
		const big = ann({ id: "BIGBIGBG", type: "image", position: { pageIndex: 0, rects: [[0, 0, 500, 500]] } });
		const note = ann({ id: "NOTENOTE", type: "note", position: { pageIndex: 0, rects: [[100, 100, 122, 122]] } });
		expect(annotationAt([big, note], 0, 110, 110)?.id).toBe("NOTENOTE");
		expect(annotationAt([big, note], 0, 400, 400)?.id).toBe("BIGBIGBG");
		expect(annotationAt([big, note], 1, 110, 110)).toBeNull();
	});
	test("thinInk drops near points but keeps the ends", () => {
		const t = thinInk([0, 0, 0.1, 0, 0.2, 0, 5, 0, 5.1, 0, 10, 0]);
		expect(t).toEqual([0, 0, 5, 0, 10, 0]);
		expect(thinInk([1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
	});
});

describe("page labels", () => {
	test("uses the index + 1 without any hint", () => {
		expect(pageLabelFor(4, [])).toBe("5");
	});
	test("reuses an exact label from an existing annotation", () => {
		expect(pageLabelFor(5, [ann({ pageLabel: "1204", position: { pageIndex: 5, rects: [[0, 0, 1, 1]] } })])).toBe("1204");
	});
	test("extrapolates a shared numeric offset (journal pagination)", () => {
		const e = [ann({ pageLabel: "1204", position: { pageIndex: 5, rects: [[0, 0, 1, 1]] } }), ann({ pageLabel: "1206", position: { pageIndex: 7, rects: [[0, 0, 1, 1]] } })];
		expect(pageLabelFor(6, e)).toBe("1205");
	});
	test("falls back when labels are inconsistent or not numeric", () => {
		expect(pageLabelFor(2, [ann({ pageLabel: "iv", position: { pageIndex: 0, rects: [[0, 0, 1, 1]] } })])).toBe("3");
		const e = [ann({ pageLabel: "10", position: { pageIndex: 5, rects: [[0, 0, 1, 1]] } }), ann({ pageLabel: "99", position: { pageIndex: 6, rects: [[0, 0, 1, 1]] } })];
		expect(pageLabelFor(2, e)).toBe("3");
	});
});

describe("wire format (what core/src/zotero-db/writer.ts upsertAnnotation requires)", () => {
	const made = makeAnnotation(
		{ type: "highlight", color: COLORS[3].value, position: { pageIndex: 1, rects: [[10.12345, 20, 30, 40]] }, sortIndex: "00001|000010|00100", pageLabel: "2", text: "some text" },
		{ id: "4W3K7HFS", now: "2026-10-30T12:00:00Z" },
	);
	test("has every field the writer reads, with Zotero's value formats", () => {
		const w = toWire(made);
		expect(w.id).toBe("4W3K7HFS");
		expect(["highlight", "note", "image", "ink", "underline", "text"]).toContain(w.type); // ANNOTATION_TYPE_IDS
		expect(w.color).toMatch(/^#[0-9a-f]{6}$/);
		expect(w.sortIndex).toMatch(/^\d{5}\|\d{6}\|\d{5}$/);
		expect(w.position).toEqual({ pageIndex: 1, rects: [[10.123, 20, 30, 40]] });
		expect(w.tags).toEqual([]);
		expect(w.dateModified).toBe("2026-10-30T12:00:00Z");
		expect(w.pageLabel).toBe("2");
		expect(w.text).toBe("some text");
	});
	test("round-trips through JSON unchanged and drops undefined", () => {
		const w = toWire({ ...made, comment: undefined });
		expect(JSON.parse(JSON.stringify(w))).toEqual(w);
		expect("comment" in w).toBe(false);
	});
	test("unknown fields from Zotero survive", () => {
		const w = toWire({ ...made, authorName: "A", isAuthorNameAuthoritative: true });
		expect(w.isAuthorNameAuthoritative).toBe(true);
		expect(w.authorName).toBe("A");
	});
	test("nowIso has no milliseconds", () => {
		expect(nowIso(new Date("2026-10-30T12:34:56.789Z"))).toBe("2026-10-30T12:34:56Z");
		expect(nowIso()).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
	});
	test("existing Zotero annotations are displayable; broken ones are not", () => {
		expect(isDisplayable(JSON.parse('{"id":"4W3K7HFS","type":"highlight","color":"#2ea8e5","sortIndex":"00000|000112|00028","position":{"pageIndex":0,"rects":[[259.652,736.497,272.517,754.089]]},"text":"May","tags":[],"pageLabel":"1","dateModified":"2025-10-13T11:12:50Z"}'))).toBe(true);
		expect(isDisplayable({ id: "X", type: "highlight", sortIndex: "a", position: { pageIndex: 0 } })).toBe(false);
		expect(isDisplayable(null)).toBe(false);
		expect(isDisplayable({ id: "", type: "ink", sortIndex: "a", position: { pageIndex: 0, paths: [[1, 2]] } })).toBe(false);
	});
});

describe("filtering and note export", () => {
	const list = [
		ann({ id: "AAAAAAAA", text: "Fibrosis markers", color: "#ffd400", tags: [{ name: "methods" }] }),
		ann({ id: "BBBBBBBB", text: "other", comment: "check FIBROSIS later", color: "#ff6666" }),
		ann({ id: "CCCCCCCC", text: "x", color: "#ff6666", pageLabel: "1204" }),
	];
	const f = (o: Partial<{ query: string; colors: string[]; tag: string }>) => list.filter((a) => matchesFilter(a, { query: "", colors: [], tag: "", ...o })).map((a) => a.id);
	test("search matches text, comment, tags and page label, ignoring case", () => {
		expect(f({ query: "fibrosis" })).toEqual(["AAAAAAAA", "BBBBBBBB"]);
		expect(f({ query: "METHODS" })).toEqual(["AAAAAAAA"]);
		expect(f({ query: "1204" })).toEqual(["CCCCCCCC"]);
		expect(f({ query: "  " })).toHaveLength(3);
	});
	test("colour and tag filters combine", () => {
		expect(f({ colors: ["#ff6666"] })).toEqual(["BBBBBBBB", "CCCCCCCC"]);
		expect(f({ colors: ["#ff6666"], query: "later" })).toEqual(["BBBBBBBB"]);
		expect(f({ tag: "methods" })).toEqual(["AAAAAAAA"]);
	});
	test("notesHtml is escaped, in document order, wrapped like a Zotero note", () => {
		const html = notesHtml([
			ann({ id: "BBBBBBBB", sortIndex: "00001|000000|00000", text: "<b>x</b> & y", comment: "my\ncomment", pageLabel: "2" }),
			ann({ id: "AAAAAAAA", sortIndex: "00000|000000|00000", text: "first", color: "#5fb236", pageLabel: "1" }),
			ann({ id: "CCCCCCCC", type: "note", sortIndex: "00002|000000|00000", text: "", comment: "sticky" }),
			ann({ id: "DDDDDDDD", type: "image", sortIndex: "00003|000000|00000", text: "", comment: "" }),
		]);
		expect(html.startsWith('<div class="zotero-note znv1"><h1>Annotations</h1>')).toBe(true);
		expect(html.indexOf("first")).toBeLessThan(html.indexOf("&lt;b&gt;"));
		expect(html).toContain("\u201c&lt;b&gt;x&lt;/b&gt; &amp; y\u201d");
		expect(html).toContain("my<br/>comment");
		expect(html).toContain("background-color: #5fb23680");
		expect(html).toContain("<p>sticky <span>(p. 1)</span></p>");
		expect(html.endsWith("</div>")).toBe(true);
		expect(html).not.toContain("DDDDDDDD");
	});
});
