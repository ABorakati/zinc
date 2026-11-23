import { describe, expect, test } from "bun:test";
import { createVisibleRange } from "./visible";

describe("createVisibleRange", () => {
	test("a real range passes through and sets the span", () => {
		const vr = createVisibleRange(() => 30, () => 600);
		expect(vr.range(10, 30, 500)).toEqual([10, 30]);
		expect(vr.span()).toBe(20);
	});

	test("before any real range, the span comes from the view's height", () => {
		const vr = createVisibleRange(() => 30, () => 600);
		expect(vr.span()).toBe(20);
	});

	test("scrollToItem's one-row range is widened, with the row where the scroll put it", () => {
		const vr = createVisibleRange(() => 30, () => 600);
		vr.range(0, 25, 500); // real: 25 rows
		vr.scrolling(-300); // the row sits 300 px (10 rows) below the top
		expect(vr.range(200, 201, 500)).toEqual([190, 215]);
		vr.scrolling(0);
		expect(vr.range(50, 51, 500)).toEqual([50, 75]);
	});

	test("the widened range stays inside the list", () => {
		const vr = createVisibleRange(() => 30, () => 600);
		vr.scrolling(-300);
		expect(vr.range(499, 500, 500)).toEqual([489, 500]);
		vr.scrolling(-300);
		expect(vr.range(3, 4, 500)).toEqual([0, 20]);
	});

	test("a list of one row keeps its one-row range", () => {
		const vr = createVisibleRange(() => 30, () => 600);
		expect(vr.range(0, 1, 1)).toEqual([0, 1]);
	});
});
