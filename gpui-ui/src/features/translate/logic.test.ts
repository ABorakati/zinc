// bun test src/features/translate/logic.test.ts -- web-save response parsing, pick-list state, import fallback matching.
import { describe, expect, test } from "bun:test";
import { allKeys, initialChecked, isUnrecognisedFormat, normaliseUrl, parseWebResponse, selectedKeys, summarise, toggleKey } from "./logic";

describe("parseWebResponse", () => {
	test("saved items", () => {
		const r = parseWebResponse({ items: [{ key: "A", title: "T", itemType: "journalArticle" }], translator: "X", fallback: "webpage" });
		expect(r.kind).toBe("saved");
		if (r.kind === "saved")
			expect(r.saved).toEqual({
				items: [{ key: "A", title: "T", itemType: "journalArticle" }],
				translator: "X",
				fallback: "webpage",
			});
	});
	test("choices win over items", () => {
		const r = parseWebResponse({ choices: { session: "s1", url: "u", items: [{ key: "1", title: "a", checked: true }] } });
		expect(r.kind).toBe("choices");
		if (r.kind === "choices") expect(r.choices.session).toBe("s1");
	});
	test("empty body is an empty save", () => {
		const r = parseWebResponse({});
		expect(r.kind === "saved" && r.saved.items).toEqual([]);
	});
});

describe("pick-list", () => {
	const items = [
		{ key: "a", title: "A", checked: true },
		{ key: "b", title: "B" },
		{ key: "c", title: "C", checked: true },
	];
	test("initial, toggle, all, none, order", () => {
		let s = initialChecked(items);
		expect([...s]).toEqual(["a", "c"]);
		s = toggleKey(s, "b");
		expect(selectedKeys(items, s)).toEqual(["a", "b", "c"]);
		s = toggleKey(s, "a");
		expect(selectedKeys(items, s)).toEqual(["b", "c"]);
		expect(selectedKeys(items, allKeys(items))).toEqual(["a", "b", "c"]);
		expect(selectedKeys(items, new Set())).toEqual([]);
	});
});

describe("helpers", () => {
	test("summarise", () => {
		expect(summarise([{ key: "a", title: "One", itemType: "x" }])).toEqual({ title: "Added 1 item", description: "One" });
		const many = ["1", "2", "3", "4", "5"].map((k) => ({ key: k, title: `T${k}`, itemType: "x" }));
		expect(summarise(many).description).toBe("T1\nT2\nT3\n…and 2 more");
		expect(summarise([])).toEqual({ title: "Added 0 items" });
	});
	test("isUnrecognisedFormat matches the core message", () => {
		expect(isUnrecognisedFormat("could not recognise the format; expected BibTeX, RIS")).toBe(true);
		expect(isUnrecognisedFormat("text is required")).toBe(false);
	});
	test("normaliseUrl", () => {
		expect(normaliseUrl(" example.com/x ")).toBe("https://example.com/x");
		expect(normaliseUrl("http://a.b")).toBe("http://a.b");
		expect(normaliseUrl("  ")).toBe("");
	});
});
