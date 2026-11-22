// bun test src/reader/reflow/html.test.ts -- numeric entities in the structure converter's inline HTML.
import { describe, expect, test } from "bun:test";
import { htmlToMarkdown, htmlToPlain } from "./html";

describe("numeric character references", () => {
	test("ordinary ones are decoded", () => {
		expect(htmlToPlain("caf&#233; &#x1F4DA; &amp; more")).toBe("caf\u00e9 \u{1F4DA} & more");
	});

	test("a number past the last code point stays as text instead of throwing", () => {
		expect(htmlToPlain("a &#99999999; b")).toBe("a &#99999999; b");
		expect(htmlToPlain("a &#x110000; b")).toBe("a &#x110000; b");
		expect(htmlToPlain("a &#xFFFFFFFFFFFFFFFF; b")).toBe("a &#xFFFFFFFFFFFFFFFF; b");
		expect(() => htmlToMarkdown("<p>x &#99999999; <i>y</i></p>")).not.toThrow();
		expect(htmlToMarkdown("<i>y</i> &#x7FFFFFFF;")).toContain("y");
	});
});
