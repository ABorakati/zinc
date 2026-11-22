// bun test src/reader/annotations/selection.test.ts -- a highlight made from a selection that crosses a page break keeps both pages.
import { describe, expect, test } from "bun:test";
import { positionFromSelection } from "./geometry";

const size = (page: number) => (page === 0 ? { w: 600, h: 800 } : { w: 300, h: 400 }); // two pages of different sizes
const round = (rs: number[][] | undefined) => rs?.map((r) => r.map((v) => Math.round(v * 1000) / 1000));

describe("positionFromSelection", () => {
	test("a selection over two pages: the second page's rects go to nextPageRects, converted with that page's own size", () => {
		const first = { x: 0.1, y: 0.9, w: 0.5, h: 0.05 };
		const second = { x: 0.2, y: 0.05, w: 0.5, h: 0.1 };
		const pos = positionFromSelection({ page: 0, rects: [first], pages: [{ page: 0, rects: [first] }, { page: 1, rects: [second] }] }, size);
		expect(pos).not.toBeNull();
		expect(pos!.pageIndex).toBe(0);
		expect(round(pos!.rects)).toEqual([[60, 40, 360, 80]]);
		// page 1 is 300 x 400: x 0.2*300, y (1-0.05-0.1)*400 ... (1-0.05)*400
		expect(round(pos!.nextPageRects)).toEqual([[60, 340, 210, 380]]);
	});

	test("one page: the same as before, from page + rects alone or from pages", () => {
		const r = { x: 0.25, y: 0.5, w: 0.5, h: 0.1 };
		const alone = positionFromSelection({ page: 1, rects: [r] }, size);
		const viaPages = positionFromSelection({ page: 1, rects: [r], pages: [{ page: 1, rects: [r] }] }, size);
		expect(alone).toEqual(viaPages);
		expect({ ...alone, rects: round(alone!.rects) }).toEqual({ pageIndex: 1, rects: [[75, 160, 225, 200]] });
	});

	test("an empty selection gives nothing", () => {
		expect(positionFromSelection({ page: 0, rects: [], pages: [] }, size)).toBeNull();
	});

	test("pages that are not neighbours are not joined", () => {
		const r = { x: 0, y: 0, w: 0.5, h: 0.5 };
		const pos = positionFromSelection({ page: 0, rects: [r], pages: [{ page: 0, rects: [r] }, { page: 3, rects: [r] }] }, size);
		expect(pos!.nextPageRects).toBeUndefined();
	});
});
