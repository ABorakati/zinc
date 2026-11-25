import { describe, expect, test } from "bun:test";
import {
	annotationColors,
	fromNewAnnotation,
	fromPatch,
	fromWitPosition,
	hexColor,
	menuEntriesToItems,
	nrectToPdf,
	pdfToNrect,
	splitPosition,
	toWitAnnotation,
	toWitSelection,
	witColorToHex,
} from "./convert";
import { annotationHtml, annotationsHtml, spliceNote } from "./notes";
import { textOfRender } from "./view";
import { WitFailure, type MenuEntry, type WitNewAnnotation } from "./types";

const entry = (id: string, extra: Partial<MenuEntry> = {}): MenuEntry => ({
	id,
	kind: "item",
	label: { tag: "plain", val: id },
	...extra,
});

describe("rects", () => {
	test("normalised <-> PDF points round trip", () => {
		const n = { x: 0.1, y: 0.2, w: 0.3, h: 0.05 };
		const r = nrectToPdf(n, 600, 800);
		expect(r).toEqual([60, 800 * (1 - 0.25), 240, 800 * 0.8]);
		const back = pdfToNrect(r, 600, 800);
		expect(back.x).toBeCloseTo(0.1);
		expect(back.y).toBeCloseTo(0.2);
		expect(back.w).toBeCloseTo(0.3);
		expect(back.h).toBeCloseTo(0.05);
	});
});

describe("colours", () => {
	test("hex validation", () => {
		expect(hexColor("#FFD400")).toBe("#ffd400");
		expect(() => hexColor("yellow")).toThrow(WitFailure);
		expect(() => hexColor("#fff")).toThrow(/#rrggbb/);
	});
	test("types.color to hex", () => {
		expect(witColorToHex({ tag: "rgba", val: 0x2ea8e5ff })).toBe("#2ea8e5");
		expect(witColorToHex({ tag: "themed", val: { light: 0xff6666ff, dark: 0 } })).toBe("#ff6666");
		expect(witColorToHex({ tag: "token", val: "primary" })).toBeUndefined();
	});
	test("the palette has Zotero's eight colours, yellow first", () => {
		const c = annotationColors();
		expect(c).toHaveLength(8);
		expect(c[0]).toEqual({ id: "general-yellow", hex: "#ffd400" });
	});
});

describe("annotations", () => {
	const a = {
		id: "ABCD2345",
		type: "highlight" as const,
		color: "#FFD400",
		sortIndex: "00001|000010|00100",
		position: { pageIndex: 1, rects: [[1, 2, 3, 4]] as [number, number, number, number][] },
		text: "hello",
		comment: "",
		tags: [{ name: "x" }],
		pageLabel: "2",
		dateCreated: "2024-01-01T00:00:00Z",
		dateModified: "2024-01-02T00:00:00Z",
	};
	test("to WIT: names, hex, bigint dates, defaults", () => {
		const w = toWitAnnotation(a, { library: 1, attachment: "ATT00002" });
		expect(w.key).toBe("ABCD2345");
		expect(w.kind).toBe("highlight");
		expect(w.color).toBe("#ffd400");
		expect(w.text).toBe("hello");
		expect(w.position.pageIndex).toBe(1);
		expect(w.position.rects[0]).toEqual([1, 2, 3, 4]);
		expect(w.dateAdded).toBe(BigInt(Date.parse("2024-01-01T00:00:00Z")));
		expect(w.isExternal).toBe(false);
		expect(w.readOnly).toBe(false);
	});
	test("an embedded (external) annotation is read-only", () => {
		const w = toWitAnnotation({ ...a, isExternal: true }, { library: 1, attachment: "ATT00002" });
		expect(w.isExternal && w.readOnly).toBe(true);
	});
	test("new annotation: default colour, hex check, position needs a page", () => {
		const n: WitNewAnnotation = {
			kind: "note",
			position: { pageIndex: 0, rects: [[0, 0, 10, 10]], nextPageRects: [], paths: [] },
			tags: ["a"],
			isExternal: false,
		};
		const f = fromNewAnnotation(n);
		expect(f.color).toBe("#ffd400");
		expect(f.tags).toEqual([{ name: "a" }]);
		expect(() => fromNewAnnotation({ ...n, color: "red" })).toThrow(WitFailure);
		expect(() => fromWitPosition({ rects: [], nextPageRects: [], paths: [] })).toThrow(/page-index/);
		expect(() => fromWitPosition({ rects: [], nextPageRects: [], paths: [], selector: "{}" })).toThrow(/EPUB/);
	});
	test("patch changes only what is present", () => {
		expect(fromPatch({ key: "ABCD2345", comment: "c" })).toEqual({ comment: "c" });
		expect(fromPatch({ key: "ABCD2345", kind: "underline", color: "#FF6666", tags: [] })).toEqual({
			type: "underline",
			color: "#ff6666",
			tags: [],
		});
	});
	test("an oversized position is split by rects", () => {
		const rects = Array.from({ length: 4000 }, (_, i) => [i, i, i + 100.123456, i + 10.123456] as [number, number, number, number]);
		const parts = splitPosition({ pageIndex: 0, rects });
		expect(parts.length).toBeGreaterThan(1);
		expect(parts.flatMap((p) => p.rects!)).toHaveLength(4000);
		for (const p of parts) expect(JSON.stringify(p).length).toBeLessThanOrEqual(65000);
		expect(splitPosition({ pageIndex: 0, rects: rects.slice(0, 3) })).toHaveLength(1);
	});
});

describe("selection", () => {
	test("a one-page selection becomes a highlight draft in PDF points", () => {
		const s = toWitSelection(
			{ page: 0, text: "a b", rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.02 }] },
			() => ({ w: 600, h: 800 }),
			"#ffd400",
			"1",
		);
		expect(s.text).toBe("a b");
		expect(s.draft.kind).toBe("highlight");
		expect(s.draft.position.pageIndex).toBe(0);
		expect(s.draft.position.rects).toHaveLength(1);
		expect(s.draft.position.rects[0]![0]).toBeCloseTo(60);
		expect(s.draft.pageLabel).toBe("1");
	});
});

describe("menus", () => {
	test("a flat entry list with parents becomes nested items; separators are tidied", () => {
		const got: string[] = [];
		const items = menuEntriesToItems(
			[
				entry("sep0", { kind: "separator" }),
				entry("a"),
				entry("sub", { kind: "submenu" }),
				entry("b", { parent: "sub", swatch: { tag: "rgba", val: 0xff0000ff } as never, check: true }),
				entry("sep1", { kind: "separator" }),
				entry("c"),
				entry("sep2", { kind: "separator" }),
			],
			(id) => got.push(id),
		);
		expect(items.map((i) => i.label ?? "-")).toEqual(["a", "sub", "-", "c"]);
		const sub = typeof items[1]!.submenu === "function" ? items[1]!.submenu() : items[1]!.submenu!;
		expect(sub[0]).toMatchObject({ label: "b", icon: "circle", iconColor: "#ff0000", checked: true });
		items[0]!.onSelect!();
		sub[0]!.onSelect!();
		expect(got).toEqual(["a", "b"]);
	});
	test("a localized label falls back to its fallback text or id", () => {
		const items = menuEntriesToItems(
			[entry("x", { label: { tag: "localized", val: { id: "m", args: [], fallback: "Fallback" } } })],
			() => {},
		);
		expect(items[0]!.label).toBe("Fallback");
	});
});

describe("note HTML", () => {
	const wit = (extra = {}) =>
		toWitAnnotation(
			{
				id: "ABCD2345",
				type: "highlight",
				color: "#ffd400",
				sortIndex: "0",
				position: { pageIndex: 0, rects: [[0, 0, 1, 1]] },
				text: "quoted <b>",
				comment: "my\ncomment",
				pageLabel: "7",
				dateModified: "2024-01-01T00:00:00Z",
				...extra,
			},
			{ library: 1, attachment: "ATT00002" },
		);
	test("highlight template: quote, citation page, comment, escaped", () => {
		const html = annotationHtml(wit());
		expect(html).toContain("“quoted &lt;b&gt;”");
		expect(html).toContain("(p. 7)");
		expect(html).toContain("my<br/>comment");
		expect(html).toContain('data-annotation="');
		expect(html.startsWith("<p>") && html.endsWith("</p>")).toBe(true);
	});
	test("a custom template and skipped annotations", () => {
		expect(annotationHtml(wit(), "<li>{{comment}} {{color}}</li>")).toBe("<li>my<br/>comment #ffd400</li>");
		expect(annotationHtml(wit({ type: "ink", text: "" }))).toBe("");
		expect(annotationsHtml([wit(), wit({ type: "highlight", text: "" })])).not.toContain("\n");
	});
	test("splice into the note's wrapper div", () => {
		const note = '<div data-schema-version="9"><p>one</p></div>';
		expect(spliceNote(note, "<p>new</p>", "end")).toBe('<div data-schema-version="9"><p>one</p><p>new</p></div>');
		expect(spliceNote(note, "<p>new</p>", "start")).toBe('<div data-schema-version="9"><p>new</p><p>one</p></div>');
		expect(spliceNote("plain", "X", "end")).toBe("plainX");
	});
});

describe("stand-in view text", () => {
	test("reads the JSON form and the plain text variant", () => {
		expect(textOfRender({ content: { tag: "json", val: JSON.stringify({ root: { type: "text", text: "Hello" } }) } })).toBe("Hello");
		expect(textOfRender({ content: { tag: "unchanged" } })).toBe("");
	});
});
