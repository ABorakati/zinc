import { describe, expect, test } from "bun:test";
import { LEFT_PARTS, move, normalize, RIGHT_PARTS, setShown, visible } from "./sidebarLayout";

describe("sidebar layout", () => {
	test("a missing or broken value gives the default order", () => {
		expect(normalize(undefined, RIGHT_PARTS).order).toEqual(RIGHT_PARTS.map((p) => p.id));
		expect(normalize({ order: "x", hidden: 3 }, RIGHT_PARTS)).toEqual({ order: RIGHT_PARTS.map((p) => p.id), hidden: [] });
	});
	test("unknown and duplicate ids are dropped; a new section goes after its default predecessor", () => {
		const l = normalize({ order: ["tags", "info", "tags", "gone"], hidden: ["gone", "abstract"] }, RIGHT_PARTS);
		expect(l.order).toEqual(["tags", "related", "info", "abstract", "notes", "attachments", "collections"]);
		expect(l.hidden).toEqual(["abstract"]);
	});
	test("Tags stays last in the left sidebar", () => {
		const l = normalize({ order: ["tags", "collections", "library"] }, LEFT_PARTS);
		expect(l.order.at(-1)).toBe("tags");
		expect(move(l, "tags", -1, LEFT_PARTS)).toBe(l);
		expect(move(l, l.order.at(-2)!, 1, LEFT_PARTS)).toBe(l); // nothing goes below Tags
	});
	test("move swaps neighbours and stops at the ends", () => {
		const l = normalize(undefined, RIGHT_PARTS);
		expect(move(l, "abstract", -1, RIGHT_PARTS).order.slice(0, 2)).toEqual(["abstract", "info"]);
		expect(move(l, "info", -1, RIGHT_PARTS)).toBe(l);
		expect(move(l, "related", 1, RIGHT_PARTS)).toBe(l);
	});
	test("hiding: never the last shown part", () => {
		let l = normalize(undefined, LEFT_PARTS);
		for (const p of LEFT_PARTS) l = setShown(l, p.id, false);
		expect(visible(l)).toHaveLength(1);
		expect(visible(setShown(l, "library", true))).toContain("library");
		expect(normalize({ hidden: LEFT_PARTS.map((p) => p.id) }, LEFT_PARTS).hidden).toHaveLength(LEFT_PARTS.length - 1);
	});
});
