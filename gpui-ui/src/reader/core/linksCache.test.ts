// bun test src/reader/core/linksCache.test.ts -- links loaded for a document that is no longer open never reach the cache.
import { describe, expect, test } from "bun:test";
import { settleLinks } from "./linksCache";

describe("settleLinks", () => {
	test("the open document's result is stored", () => {
		const doc = {},
			cache = new Map<number, number[] | Promise<number[]>>();
		expect(settleLinks(cache, doc, doc, 3, [1, 2])).toBe(true);
		expect(cache.get(3)).toEqual([1, 2]);
	});

	test("a late answer or failure of the previous document leaves the new document's cache alone", () => {
		const oldDoc = {},
			newDoc = {},
			cache = new Map<number, number[] | Promise<number[]>>();
		expect(settleLinks(cache, newDoc, oldDoc, 3, [])).toBe(false); // the failed load of a document that was replaced
		expect(cache.has(3)).toBe(false); // so the page asks again for its own links
		expect(settleLinks(cache, undefined, oldDoc, 3, [9])).toBe(false); // closed
		expect(cache.size).toBe(0);
	});
});
