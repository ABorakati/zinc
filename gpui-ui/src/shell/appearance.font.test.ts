// bun test src/shell/appearance.font.test.ts -- the "System" interface font is the operating system's own, not Windows' everywhere.
import { describe, expect, test } from "bun:test";

process.env.ZN_UI_STATE = "off";

describe("the System interface font", () => {
	test("Windows keeps Segoe UI Variable, macOS and Linux get GPUI's system UI font", async () => {
		const { sansFor } = await import("./appearance");
		const { DEFAULT_THEME } = await import("./schemes");
		const sys = { ...DEFAULT_THEME, font: "system" as const };
		expect(sansFor(sys, "win32")).toBe("Segoe UI Variable Text");
		expect(sansFor(sys, "darwin")).toBe(".SystemUIFont");
		expect(sansFor(sys, "linux")).toBe(".SystemUIFont");
	});
	test("a custom font with no name falls back to the same system font", async () => {
		const { sansFor } = await import("./appearance");
		const { DEFAULT_THEME } = await import("./schemes");
		const custom = { ...DEFAULT_THEME, font: "custom" as const, fontCustom: "" };
		expect(sansFor(custom, "win32")).toBe("Segoe UI Variable Text");
		expect(sansFor(custom, "darwin")).toBe(".SystemUIFont");
		expect(sansFor({ ...custom, fontCustom: "Georgia" }, "darwin")).toBe("Georgia");
	});
	test("the bundled choices are the same everywhere", async () => {
		const { sansFor } = await import("./appearance");
		const { DEFAULT_THEME } = await import("./schemes");
		for (const platform of ["win32", "darwin", "linux"] as const) {
			expect(sansFor({ ...DEFAULT_THEME, font: "inter" }, platform)).toBe("inter");
			expect(sansFor({ ...DEFAULT_THEME, font: "plex" }, platform)).toBe("plex");
		}
	});
});
