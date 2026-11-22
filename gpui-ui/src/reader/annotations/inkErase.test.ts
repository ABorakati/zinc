// bun test src/reader/annotations/inkErase.test.ts -- the eraser must never duplicate strokes it does not touch.
import { describe, expect, test } from "bun:test";
import { erasePaths } from "./inkErase";

const line = [0, 0, 10, 0, 20, 0, 30, 0, 40, 0]; // five points along y = 0

describe("erasePaths", () => {
	test("an untouched stroke is kept once, unchanged", () => {
		const r = erasePaths([line], 500, 500);
		expect(r.changed).toBe(false);
		expect(r.paths).toEqual([line]);
		expect(r.paths[0]).toBe(line);
	});

	test("repeated moves away from the ink do not grow the stroke count", () => {
		let paths: number[][] = [line, [0, 50, 10, 50, 20, 50]];
		for (let i = 0; i < 10; i++) paths = erasePaths(paths, 500 + i, 500).paths;
		expect(paths).toHaveLength(2);
		expect(paths[0]).toEqual(line);
	});

	test("repeated erasing near, but not on, one stroke leaves the others single", () => {
		let paths: number[][] = [line, [0, 100, 10, 100, 20, 100]];
		for (let i = 0; i < 6; i++) paths = erasePaths(paths, 20, 0, 5).paths; // cuts the first stroke only
		expect(paths).toHaveLength(3);
		expect(paths.filter((s) => s[1] === 100)).toHaveLength(1);
	});

	test("a hit in the middle splits the stroke", () => {
		const r = erasePaths([line], 20, 0, 5);
		expect(r.changed).toBe(true);
		expect(r.paths).toEqual([
			[0, 0, 10, 0],
			[30, 0, 40, 0],
		]);
	});

	test("erasing at either end shortens the stroke", () => {
		expect(erasePaths([line], 0, 0, 5).paths).toEqual([[10, 0, 20, 0, 30, 0, 40, 0]]);
		expect(erasePaths([line], 40, 0, 5).paths).toEqual([[0, 0, 10, 0, 20, 0, 30, 0]]);
	});

	test("erasing everything removes the stroke", () => {
		const r = erasePaths([line], 20, 0, 100);
		expect(r.changed).toBe(true);
		expect(r.paths).toEqual([]);
	});

	test("a lone surviving point is dropped (it cannot be drawn)", () => {
		expect(erasePaths([[0, 0, 10, 0, 20, 0]], 10, 0, 5).paths).toEqual([]);
	});

	test("a single-dot stroke (a repeated point) is kept when missed and removed when hit", () => {
		const dot = [5, 5, 5, 5];
		expect(erasePaths([dot], 500, 500).paths).toEqual([dot]);
		const r = erasePaths([dot], 5, 5, 3);
		expect(r.changed).toBe(true);
		expect(r.paths).toEqual([]);
	});

	test("malformed short paths are kept once when missed and never multiplied", () => {
		const bad = [[], [1], [1, 2], [1, 2, 3]];
		let paths: number[][] = bad;
		for (let i = 0; i < 5; i++) paths = erasePaths(paths, 500, 500).paths;
		expect(paths).toEqual(bad);
		expect(erasePaths([[1, 2]], 1, 2, 3).paths).toEqual([]);
	});

	test("only the touched stroke changes; the others are kept in order", () => {
		const a = [0, 0, 10, 0], b = [0, 50, 10, 50, 20, 50, 30, 50], c = [0, 90, 10, 90];
		const r = erasePaths([a, b, c], 20, 50, 5);
		expect(r.paths).toEqual([a, [0, 50, 10, 50], [30, 50], c].filter((s) => s.length >= 4));
		expect(r.paths[0]).toBe(a);
		expect(r.paths[r.paths.length - 1]).toBe(c);
	});
});
