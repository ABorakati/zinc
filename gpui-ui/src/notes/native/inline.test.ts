import { describe, expect, test } from "bun:test";
import { inlineMarkdown } from "./inline";
import type { NoteNode } from "./parse";

const txt = (text: string, ...marks: (string | { type: string; attrs?: Record<string, unknown> })[]): NoteNode => ({
	type: "text",
	text,
	...(marks.length ? { marks: marks.map((m) => (typeof m === "string" ? { type: m } : m)) } : {}),
});

describe("inlineMarkdown", () => {
	test("plain text is escaped", () => {
		expect(inlineMarkdown([txt("a*b [c] #1")]).source).toBe("a\\*b \\[c\\] \\#1");
	});

	test("adjacent bold and bold-italic stay balanced", () => {
		const { source } = inlineMarkdown([txt("bold ", "strong"), txt("both", "strong", "em"), txt(" after")]);
		expect(source).toBe("**bold *both*** after");
	});

	test("whitespace moves outside the delimiters", () => {
		expect(inlineMarkdown([txt("a"), txt(" b ", "em"), txt("c")]).source).toBe("a *b* c");
	});

	test("links keep their marks inside", () => {
		const link = { type: "link", attrs: { href: "https://x.org/a b" } };
		expect(inlineMarkdown([txt("see "), txt("here", link, "strong")]).source).toBe("see [**here**](https://x.org/a%20b)");
	});

	test("code is atomic and unescaped", () => {
		expect(inlineMarkdown([txt("a*b", "code")]).source).toBe("`a*b`");
	});

	test("super- and subscripts become script characters", () => {
		const sup = { type: "subsup", attrs: { type: "sup" } };
		const sub = { type: "subsup", attrs: { type: "sub" } };
		expect(inlineMarkdown([txt("x"), txt("2", sup), txt(" H"), txt("2", sub), txt("O")]).source).toBe("x² H₂O");
	});

	test("a background colour becomes a highlight mark over its text only", () => {
		const bg = { type: "backgroundColor", attrs: { color: "#ff6666" } };
		const r = inlineMarkdown([txt("a "), txt(" red ", bg, "strong"), txt("b")]);
		expect(r.source).toBe("a  **red** b");
		expect(r.marks).toEqual([{ start: 5, end: 8, color: "#ff666680", kind: "highlight" }]);
		expect(r.source.slice(5, 8)).toBe("red");
	});

	test("an annotation highlight node marks its children", () => {
		const r = inlineMarkdown([
			{ type: "highlight", attrs: { annotation: { color: "#5fb236" } }, content: [txt("quoted "), txt("words", "em")] },
		]);
		expect(r.source).toBe("quoted *words*");
		expect(r.marks.map((m) => r.source.slice(m.start, m.end))).toEqual(["quoted", "words"]);
		expect(r.marks.every((m) => m.color === "#5fb23680" && m.kind === "highlight")).toBe(true);
	});

	test("citations become links with their text", () => {
		const r = inlineMarkdown([
			txt("as shown "),
			{ type: "citation", attrs: { text: "(Smith 2020)", citation: { citationItems: [1] } } },
		]);
		expect(r.source).toBe("as shown [(Smith 2020)](zn-citation:0)");
		expect(r.citations).toEqual([{ citationItems: [1] }]);
	});

	test("hard breaks and inline maths", () => {
		const r = inlineMarkdown([txt("a"), { type: "hardBreak" }, { type: "math_inline", content: [txt("x^2")] }]);
		expect(r.source).toBe("a  \n`$x^2$`");
	});
});
