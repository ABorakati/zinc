import { describe, expect, test } from "bun:test";
import type { Block, DocStructure } from "../../src/contract";
import { buildItems, continuesInto, dehyphenate, firstItemOnPage, fixGlyphs, joinHtml } from "../../src/reflow/build";
import {
	contrastColor, contrastRatio, DEFAULT_SETTINGS, fontStack, loadSettings, palette, parseHex, sanitize, saveSettings, STORAGE_KEY,
} from "../../src/reflow/settings";
import { convertSdt, type Sdt } from "../../src/structure/convert";
import paper from "../structure/fixtures/paper.sdt.json";

const blk = (id: string, type: Block["type"], text: string, page = 0, extra: Partial<Block> = {}): Block =>
	({ id, type, page, rects: [[50, 100, 300, 120]], text, ...extra });
const doc = (blocks: Block[], extra: Partial<DocStructure> = {}): DocStructure => ({ blocks, figures: [], tables: [], references: [], outline: [], ...extra });

describe("hyphen joining", () => {
	test("dehyphenate joins line-break hyphens and soft hyphens only", () => {
		expect(dehyphenate("infor-\nmation and re­action")).toBe("information and reaction");
		expect(dehyphenate("state-of-the-art")).toBe("state-of-the-art");
		expect(dehyphenate("a\nb")).toBe("a b");
	});
	test("joinHtml drops the hyphen only before a lower-case continuation", () => {
		expect(joinHtml("an informa-", "tion system")).toBe("an information system");
		expect(joinHtml("<i>informa-</i>", "tion")).toBe("<i>informa</i>tion");
		expect(joinHtml("long-", "Term")).toBe("long- Term");
		expect(joinHtml("one", "two")).toBe("one two");
	});
	test("continuesInto detects paragraphs split by columns/pages", () => {
		expect(continuesInto("the results were", "significant in all groups.")).toBe(true);
		expect(continuesInto("the results were.", "significant")).toBe(false);
		expect(continuesInto("the results were", "The next sentence")).toBe(false);
		expect(continuesInto("informa-", "tion")).toBe(true);
	});
	test("an unfinished sentence continues across a page/column break even before a capital", () => {
		expect(continuesInto("the European Society for", "Organ Transplantation, and", true)).toBe(true);
		expect(continuesInto("the European Society for", "Organ Transplantation, and", false)).toBe(false);
		expect(continuesInto("a finished sentence.", "Organ Transplantation", true)).toBe(false);
	});
	test("fixGlyphs turns the spaced quarter glyph some fonts use for '=' back into '='", () => {
		expect(fixGlyphs("attendees (N ¼ 88) and")).toBe("attendees (N = 88) and");
		expect(fixGlyphs("(N 1⁄4 88)")).toBe("(N = 88)");
		expect(fixGlyphs("¼ cup")).toBe("¼ cup");
	});
	test("a paragraph continuing on the next page is merged across an intervening figure", () => {
		const items = buildItems(doc([
			blk("b1", "paragraph", "This sentence runs over the informa-", 0),
			blk("b2", "figure", "", 1),
			blk("b3", "paragraph", "tion boundary and ends here.", 1),
			blk("b4", "paragraph", "A new paragraph.", 1),
		]));
		const paras = items.filter((i) => i.kind === "para");
		expect(paras.length).toBe(2);
		expect((paras[0] as { html: string }).html).toBe("This sentence runs over the information boundary and ends here.");
	});
});

describe("skipping furniture", () => {
	test("headers, footers and sub-captions are not rendered", () => {
		const items = buildItems(doc([
			blk("h", "header", "Running head"),
			blk("p", "paragraph", "Body."),
			blk("f", "footer", "12"),
			blk("c", "caption", "(a) (b)", 0, { captionOf: "x" }),
		]));
		expect(items.map((i) => i.kind)).toEqual(["para"]);
	});
	test("footnotes are deferred to the end of the section", () => {
		const items = buildItems(doc([
			blk("p1", "paragraph", "First para"),
			blk("n1", "footnote", "A note"),
			blk("p2", "paragraph", "second para of the same section"),
			blk("h", "heading", "Next", 0, { level: 2 }),
		]));
		expect(items.map((i) => i.kind)).toEqual(["para", "notes", "heading"]);
	});
	test("figures carry their caption and label; tiny images are dropped", () => {
		const items = buildItems(doc([
			blk("fig", "figure", "", 2, { rects: [[50, 300, 400, 500]] }),
			blk("cap", "caption", "Figure 1. Caption.", 2, { captionOf: "fig", html: "Figure 1. <i>Caption</i>." }),
			blk("logo", "figure", "", 0, { rects: [[0, 0, 20, 10]] }),
		], { figures: [{ id: "fig", kind: "figure", label: "Figure 1", page: 2, rect: [50, 300, 400, 500], captionBlockId: "cap", caption: "Figure 1. Caption." }] }));
		expect(items.length).toBe(1);
		expect(items[0]).toMatchObject({ kind: "figure", label: "Figure 1", captionHtml: "Figure 1. <i>Caption</i>.", page: 2, wide: true });
	});
	test("real paper: no header/footer text leaks, figures and refs present", () => {
		const items = buildItems(convertSdt(paper as unknown as Sdt));
		const kinds = new Set(items.map((i) => i.kind));
		for (const k of ["title", "heading", "para", "figure", "refs"]) expect(kinds.has(k as never)).toBe(true);
		expect(items.filter((i) => i.kind === "figure").length).toBe(13);
		expect(JSON.stringify(items)).not.toContain("PLDI");
	});
	test("firstItemOnPage", () => {
		const its = [{ page: 0 }, { page: 0 }, { page: 2 }, { page: 3 }];
		expect(firstItemOnPage(its, 2)).toBe(2);
		expect(firstItemOnPage(its, 1)).toBe(2);
		expect(firstItemOnPage(its, 9)).toBe(3);
	});
});

describe("settings", () => {
	const store = () => {
		const m = new Map<string, string>();
		return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
	};
	test("defaults when storage is empty, missing or corrupt", () => {
		expect(loadSettings(store())).toEqual(DEFAULT_SETTINGS);
		expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
		const s = store(); s.setItem(STORAGE_KEY, "{not json");
		expect(loadSettings(s)).toEqual(DEFAULT_SETTINGS);
	});
	test("persists and restores", () => {
		const s = store();
		const custom = { ...DEFAULT_SETTINGS, font: "dyslexic" as const, size: 24, theme: "custom" as const, customBg: "#112233", justify: true, width: 800 };
		expect(saveSettings(custom, s)).toBe(true);
		expect(loadSettings(s)).toEqual(custom);
	});
	test("save/load never throw when storage throws", () => {
		const boom = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
		expect(saveSettings(DEFAULT_SETTINGS, boom)).toBe(false);
		expect(loadSettings(boom)).toEqual(DEFAULT_SETTINGS);
	});
	test("sanitize clamps and rejects garbage", () => {
		const s = sanitize({ size: 500, lineHeight: -1, width: "wide", theme: "neon", customBg: "red", font: 3, justify: "yes" });
		expect(s.size).toBe(34);
		expect(s.lineHeight).toBe(1.2);
		expect(s.width).toBe(DEFAULT_SETTINGS.width);
		expect(s.theme).toBe("light");
		expect(s.customBg).toBe(DEFAULT_SETTINGS.customBg);
		expect(s.font).toBe("serif");
		expect(s.justify).toBe(false);
	});
	test("font stacks, including a typed custom font", () => {
		expect(fontStack({ ...DEFAULT_SETTINGS, font: "custom", customFont: 'Fira "Code"' })).toStartWith('"Fira Code"');
		expect(fontStack({ ...DEFAULT_SETTINGS, font: "custom", customFont: "  " })).toContain("serif");
		expect(fontStack({ ...DEFAULT_SETTINGS, font: "dyslexic" })).toContain("Atkinson Hyperlegible");
	});
});

describe("contrast colour", () => {
	test("dark text on light backgrounds and light text on dark ones", () => {
		expect(contrastColor("#ffffff")).toBe("#1c1b19");
		expect(contrastColor("#f4ecd8")).toBe("#1c1b19");
		expect(contrastColor("#000000")).toBe("#ece9e2");
		expect(contrastColor("#17181b")).toBe("#ece9e2");
		expect(contrastColor("#fff")).toBe("#1c1b19");
	});
	test("mid-tones pick whichever has the higher contrast, always >= 4.5 for common backgrounds", () => {
		for (const bg of ["#e6efe3", "#cde4f5", "#f2d7d5", "#2b3a55", "#556b2f", "#1e1e2e", "#fdf6e3", "#073642"]) {
			const fg = contrastColor(bg);
			expect(contrastRatio(parseHex(bg)!, parseHex(fg)!)).toBeGreaterThanOrEqual(4.5);
		}
	});
	test("garbage input falls back to dark ink", () => {
		expect(contrastColor("not-a-colour")).toBe("#1c1b19");
	});
	test("custom theme palette uses the automatic text colour", () => {
		const p = palette({ ...DEFAULT_SETTINGS, theme: "custom", customBg: "#10243a" });
		expect(p.bg).toBe("#10243a");
		expect(p.fg).toBe("#ece9e2");
		expect(contrastRatio(parseHex(p.bg)!, parseHex(p.cite)!)).toBeGreaterThanOrEqual(4.5);
		expect(palette({ ...DEFAULT_SETTINGS, theme: "sepia" }).bg).toBe("#f4ecd8");
	});
});
