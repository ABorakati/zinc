import { describe, expect, test } from "bun:test";
import { baseDir, blockAlign, blockDir, fieldDirection, isRtl, languageToISO6391 } from "./bidi";

describe("baseDir", () => {
	test("Arabic, Hebrew, Persian, Urdu are rtl", () => {
		expect(baseDir("مرحبا بالعالم")).toBe("rtl");
		expect(baseDir("שלום עולם")).toBe("rtl");
		expect(baseDir("سلام دنیا")).toBe("rtl");
		expect(baseDir("اردو زبان")).toBe("rtl");
		expect(baseDir("ﭐﹰ")).toBe("rtl");
	});
	test("Latin and other scripts are ltr", () => {
		expect(baseDir("Hello")).toBe("ltr");
		expect(baseDir("日本語")).toBe("ltr");
		expect(baseDir("Ελληνικά")).toBe("ltr");
	});
	test("first strong character wins in mixed strings", () => {
		expect(baseDir("مقدمة to Machine Learning")).toBe("rtl");
		expect(baseDir("Machine Learning مقدمة")).toBe("ltr");
		expect(baseDir("שלום Hello")).toBe("rtl");
	});
	test("digits, punctuation, spaces and emoji are skipped", () => {
		expect(baseDir("2024: מבוא")).toBe("rtl");
		expect(baseDir("(1) كتاب")).toBe("rtl");
		expect(baseDir("« Hello »")).toBe("ltr");
		expect(baseDir("  — 12.5 ✨ Abc")).toBe("ltr");
	});
	test("no strong character falls back", () => {
		expect(baseDir("")).toBe("ltr");
		expect(baseDir(null)).toBe("ltr");
		expect(baseDir("123 -- 4.5")).toBe("ltr");
		expect(baseDir("123", "rtl")).toBe("rtl");
		expect(baseDir("", "rtl")).toBe("rtl");
	});
	test("direction marks", () => {
		expect(baseDir("‏123 abc")).toBe("rtl");
		expect(baseDir("‎א")).toBe("ltr");
	});
	test("astral RTL scripts", () => {
		expect(baseDir("\u{10840}")).toBe("rtl");
		expect(baseDir("\u{1E900}")).toBe("rtl");
		expect(baseDir("\u{1F600}x")).toBe("ltr");
	});
	test("isRtl", () => {
		expect(isRtl("عنوان")).toBe(true);
		expect(isRtl("title")).toBe(false);
	});
});

describe("field direction (Zotero's ItemFields.getDirection)", () => {
	test("ids, numbers and dates are ltr; text fields follow their text", () => {
		for (const f of ["DOI", "ISBN", "url", "pages", "volume", "extra", "language", "dateAdded", "accessDate"])
			expect(fieldDirection(f, undefined, "ar")).toBe("ltr");
		expect(fieldDirection("title", undefined, undefined)).toBe("auto");
		expect(fieldDirection("abstractNote", undefined, "")).toBe("auto");
	});
	test("a type-specific field is judged by its base field", () => {
		expect(fieldDirection("reportNumber", "number", "ar")).toBe("ltr");
		expect(fieldDirection("firstPage", "pages", "he")).toBe("ltr");
		expect(fieldDirection("bookTitle", "publicationTitle", "ar")).toBe("rtl");
	});
	test("the item's language decides the other fields", () => {
		for (const lang of ["ar", "he-IL", "fa_IR", "ur", "Arabic", "Hebrew", "Persian", "arabic", "العربية", "עברית", "ara", "yi"])
			expect(fieldDirection("title", undefined, lang)).toBe("rtl");
		for (const lang of ["en", "en-US", "English", "fr", "Deutsch", "zh-Hans", "ja"])
			expect(fieldDirection("title", undefined, lang)).toBe("ltr");
		// a language Intl cannot read is "ltr", as in Zotero (not "auto")
		expect(fieldDirection("title", undefined, "Klingon!")).toBe("ltr");
	});
	test("languageToISO6391", () => {
		expect(languageToISO6391("Arabic")).toBe("ar");
		expect(languageToISO6391("Français")).toBe("fr");
		expect(languageToISO6391("en_US")).toBe("en-US");
		expect(languageToISO6391("de-AT")).toBe("de-AT");
		expect(languageToISO6391("Klingon!")).toBe("Klingon!");
		expect(languageToISO6391("")).toBe("");
	});
});

describe("note blocks", () => {
	test("attrs.dir wins over the text", () => {
		expect(blockDir({ dir: "ltr" }, "مرحبا")).toBe("ltr");
		expect(blockDir({ dir: "rtl" }, "abc")).toBe("rtl");
		expect(blockDir({ dir: null }, "مرحبا")).toBe("rtl");
		expect(blockDir(undefined, "abc")).toBe("ltr");
	});
	test("attrs.align wins over dir", () => {
		expect(blockAlign({ align: "center" }, "rtl")).toBe("center");
		expect(blockAlign({ align: "left" }, "rtl")).toBe("left");
		expect(blockAlign({}, "rtl")).toBe("right");
		expect(blockAlign({ align: "justify" }, "ltr")).toBe("left");
		expect(blockAlign(undefined, "ltr")).toBe("left");
	});
});
