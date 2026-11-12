import { describe, expect, test } from "bun:test";
import { matchFonts, tidy } from "../../shell/installedFonts";
import { DEFAULT_SETTINGS, fontFamilyOf, sanitize, themeColors } from "./settings";

describe("reading settings: fonts", () => {
	test("Literata and the system font are choices", () => {
		expect(fontFamilyOf(sanitize({ font: "literata" }))).toBe("Literata");
		expect(fontFamilyOf(sanitize({ font: "system" }))).toBe(".SystemUIFont");
	});
	test("the old Segoe UI choice becomes the system font", () => {
		expect(sanitize({ font: "segoe" }).font).toBe("system");
	});
	test("an unknown font falls back to the default", () => {
		expect(sanitize({ font: "comic" }).font).toBe(DEFAULT_SETTINGS.font);
	});
	test("a custom font reads in the named family, cleaned", () => {
		const s = sanitize({ font: "custom", customFont: '  Aptos;"  Display ' });
		expect(s.customFont).toBe("Aptos Display");
		expect(fontFamilyOf(s)).toBe("Aptos Display");
	});
	test("a custom font without a name reads in the default family", () => {
		expect(fontFamilyOf(sanitize({ font: "custom", customFont: "" }))).toBe("Source Serif 4");
	});
	test("settings without customFont get an empty one", () => {
		expect(sanitize({}).customFont).toBe("");
	});
});

describe("reading settings: theme previews", () => {
	test("each preset has its own paper and ink", () => {
		expect(themeColors("light")).toEqual({ bg: "#fbfaf7", fg: "#1f1e1c" });
		expect(themeColors("sepia")).toEqual({ bg: "#f4ecd8", fg: "#3b2f22" });
		expect(themeColors("dark")).toEqual({ bg: "#17181b", fg: "#dedcd6" });
	});
	test("the custom theme picks readable ink for its paper", () => {
		expect(themeColors("custom", "#101010").fg).toBe("#ece9e2");
	});
});

describe("installed font list", () => {
	test("weight variants of a listed family are dropped; a family named like a weight stays", () => {
		expect(tidy(["Cascadia Code", "Cascadia Code SemiBold", "Cascadia Code ExtraLight", "Segoe UI Black", "Segoe UI", "Arial Black", "@SimSun", "Bahnschrift Light"]))
			.toEqual(["Arial Black", "Bahnschrift Light", "Cascadia Code", "Segoe UI"]);
	});
});

describe("installed font matching", () => {
	const all = ["Aptos", "Aptos Display", "Arial", "Cascadia Code", "Georgia", "Segoe UI"];
	test("names that start with the query come first, then names that contain it", () => {
		expect(matchFonts(all, "a")).toEqual(["Aptos", "Aptos Display", "Arial", "Cascadia Code", "Georgia"]);
		expect(matchFonts(all, "ui")).toEqual(["Segoe UI"]);
	});
	test("an empty query lists the first fonts, up to the limit", () => {
		expect(matchFonts(all, " ", 2)).toEqual(["Aptos", "Aptos Display"]);
	});
});
