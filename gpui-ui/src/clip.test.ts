// bun test src/clip.test.ts -- the JS pre-clipping of single-line text.
import { describe, expect, test } from "bun:test";
import { clipText, textWidth } from "./clip";

/** No lone surrogate (String.isWellFormed, which the ES2022 typings lack). */
const wellFormed = (s: string) => !/[�-�](?![�-�])|(?<![�-�])[�-�]/.test(s);

describe("clipText with characters outside the BMP", () => {
	test("never cuts an emoji in half", () => {
		const s = "😀".repeat(60);
		for (let px = 20; px < 400; px += 3) {
			const out = clipText(s, px, 13);
			expect(wellFormed(out), `width ${px}`).toBe(true);
			expect(out.endsWith("…")).toBe(true);
		}
	});
	test("a mixed string keeps whole characters and stays within the budget", () => {
		const s = "Résumé 😀 of 𝒜 text 🧪 and more words after the emoji 😀😀😀";
		for (let px = 20; px < 300; px += 7) {
			const out = clipText(s, px, 13);
			expect(wellFormed(out), `width ${px}`).toBe(true);
			expect(textWidth(out, 13)).toBeLessThanOrEqual(px);
		}
	});
	test("an emoji counts as one wide character, not as two units", () => {
		expect(textWidth("😀", 10)).toBeCloseTo(11, 5); // the 1.1 em class
		expect(textWidth("a😀", 10)).toBeCloseTo(textWidth("a", 10) + 11, 5);
	});
	test("a string that fits is returned as it is", () => {
		expect(clipText("short 😀", 500, 13)).toBe("short 😀");
	});
});
