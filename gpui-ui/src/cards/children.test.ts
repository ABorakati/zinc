import { describe, expect, test } from "bun:test";
import type { ChildSummary } from "../api";
import { DOUBLE_CLICK_MS, isDoubleClick, keepSame } from "./children";

const pdf = (key: string, title = "PDF"): ChildSummary =>
	({ key, itemType: "attachment", title, contentType: "application/pdf" }) as ChildSummary;

describe("children reloaded after a refresh", () => {
	test("an unchanged list keeps the very same array and objects (the rows stay mounted)", () => {
		const old = [pdf("A"), pdf("B")];
		expect(keepSame(old, [pdf("A"), pdf("B")])).toBe(old);
	});
	test("a changed child is replaced, the others keep their objects", () => {
		const old = [pdf("A"), pdf("B")];
		const next = keepSame(old, [pdf("A"), pdf("B", "Renamed")]);
		expect(next).not.toBe(old);
		expect(next[0]).toBe(old[0]);
		expect(next[1]!.title).toBe("Renamed");
	});
	test("an added or removed child gives a new list", () => {
		const old = [pdf("A")];
		expect(keepSame(old, [pdf("A"), pdf("B")])).toHaveLength(2);
		expect(keepSame(old, [])).toHaveLength(0);
		expect(keepSame(undefined, [pdf("A")])).toHaveLength(1);
	});
});

describe("double-click on a child row", () => {
	test("the system's click count opens", () => {
		expect(isDoubleClick("A", 1, 0)).toBe(false);
		expect(isDoubleClick("A", 2, 100)).toBe(true);
	});
	test("two single clicks on the same row in time open (the count was lost when the row was rebuilt)", () => {
		expect(isDoubleClick("B", 1, 1000)).toBe(false);
		expect(isDoubleClick("B", 1, 1000 + DOUBLE_CLICK_MS - 50)).toBe(true);
	});
	test("too slow, or another row, is not a double-click", () => {
		expect(isDoubleClick("C", 1, 5000)).toBe(false);
		expect(isDoubleClick("C", 1, 5000 + DOUBLE_CLICK_MS + 50)).toBe(false);
		expect(isDoubleClick("D", 1, 5000 + DOUBLE_CLICK_MS + 100)).toBe(false);
	});
	test("a third quick click does not open a second time", () => {
		expect(isDoubleClick("E", 1, 9000)).toBe(false);
		expect(isDoubleClick("E", 2, 9100)).toBe(true);
		expect(isDoubleClick("E", 1, 9200)).toBe(false);
	});
});
