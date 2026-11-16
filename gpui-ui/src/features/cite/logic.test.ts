// bun test src/features/cite/logic.test.ts -- Quick Copy plan (style vs export, bibliography vs citation), CF_HTML byte offsets.
import { describe, expect, test } from "bun:test";
import type { QuickCopySettings } from "../../../../core/src/cite/types";
import { cfHtml, parseCfHtml } from "../cfhtml";
import { copiedMessage, dropText, flipMode, formatRequest, planKey, planQuickCopy } from "./logic";

const base: QuickCopySettings = { style: "vancouver", locale: "", mode: "bibliography", format: "html" };

describe("planQuickCopy", () => {
	test("default result is the bibliography in the stored style", () => {
		expect(planQuickCopy(base, "")).toEqual({ kind: "style", style: "vancouver", locale: "", mode: "bibliography", includeHtml: true });
	});
	test("Shift drags a citation", () => {
		expect(planQuickCopy(base, "", { shift: true })).toMatchObject({ kind: "style", mode: "citation" });
	});
	test("Shift flips whichever default is stored", () => {
		expect(planQuickCopy({ ...base, mode: "citation" }, "")).toMatchObject({ mode: "citation" });
		expect(planQuickCopy({ ...base, mode: "citation" }, "", { shift: true })).toMatchObject({ mode: "bibliography" });
	});
	test("an explicit mode (the keyboard shortcuts) beats the default and Shift", () => {
		expect(planQuickCopy(base, "", { mode: "citation" })).toMatchObject({ mode: "citation" });
		expect(planQuickCopy({ ...base, mode: "citation" }, "", { mode: "bibliography", shift: true })).toMatchObject({
			mode: "bibliography",
		});
	});
	test("an export format wins over style and mode", () => {
		for (const how of [{}, { shift: true }, { mode: "citation" as const }])
			expect(planQuickCopy(base, "bibtex", how)).toEqual({ kind: "export", format: "bibtex" });
	});
	test("plain-text output drops the HTML", () => {
		expect(planQuickCopy({ ...base, format: "text" }, "")).toMatchObject({ includeHtml: false });
		expect(planQuickCopy({ ...base, format: "rtf" }, "")).toMatchObject({ includeHtml: true });
	});
	test("locale and style are carried", () => {
		expect(planQuickCopy({ ...base, style: "apa", locale: "en-GB" }, "")).toMatchObject({ style: "apa", locale: "en-GB" });
	});
});

describe("request, key and message", () => {
	test("formatRequest asks for html+text, or text only", () => {
		const p = planQuickCopy(base, "") as Extract<ReturnType<typeof planQuickCopy>, { kind: "style" }>;
		expect(formatRequest(["A"], p)).toEqual({
			keys: ["A"],
			style: "vancouver",
			locale: "",
			mode: "bibliography",
			format: ["html", "text"],
		});
		expect(formatRequest(["A"], { ...p, includeHtml: false }).format).toEqual(["text"]);
	});
	test("planKey differs by mode, style and export format", () => {
		const keys = new Set([
			planKey(planQuickCopy(base, "")),
			planKey(planQuickCopy(base, "", { shift: true })),
			planKey(planQuickCopy({ ...base, style: "apa" }, "")),
			planKey(planQuickCopy(base, "ris")),
		]);
		expect(keys.size).toBe(4);
		expect(planKey(planQuickCopy(base, "ris", { shift: true }))).toBe(planKey(planQuickCopy(base, "ris")));
	});
	test("copiedMessage", () => {
		expect(copiedMessage(planQuickCopy(base, ""), 1)).toBe("Bibliography copied (1 item, vancouver)");
		expect(copiedMessage(planQuickCopy(base, "", { shift: true }), 3)).toBe("Citation copied (3 items, vancouver)");
		expect(copiedMessage(planQuickCopy(base, "bibtex"), 2)).toBe("bibtex copied (2 items)");
	});
	test("flipMode, dropText", () => {
		expect(flipMode("citation")).toBe("bibliography");
		expect(dropText("1. Smith J. Title.\r\n\n")).toBe("1. Smith J. Title.");
	});
});

describe("cfHtml", () => {
	const slice = (doc: string, from: number, to: number) => Buffer.from(doc, "utf8").subarray(from, to).toString("utf8");

	test("offsets are byte-exact for ASCII", () => {
		const doc = cfHtml("<p>Hi</p>");
		const o = parseCfHtml(doc)!;
		expect(slice(doc, o.startFragment, o.endFragment)).toBe("<p>Hi</p>");
		expect(slice(doc, o.startHtml, o.endHtml)).toBe("<html><body><!--StartFragment--><p>Hi</p><!--EndFragment--></body></html>");
		expect(o.endHtml).toBe(Buffer.byteLength(doc, "utf8"));
	});
	test("offsets count bytes, not characters (accents, curly quotes, emoji, CJK)", () => {
		const frag = "<i>Théo “quoted” \u{1F4DA} 文献</i>";
		const doc = cfHtml(frag);
		expect(Buffer.byteLength(frag, "utf8")).toBeGreaterThan(frag.length);
		const o = parseCfHtml(doc)!;
		expect(slice(doc, o.startFragment, o.endFragment)).toBe(frag);
		expect(o.endHtml).toBe(Buffer.byteLength(doc, "utf8"));
		expect(slice(doc, o.startHtml, o.startHtml + 6)).toBe("<html>");
	});
	test("the header is fixed width and CRLF separated, the fragment markers sit right around the fragment", () => {
		const doc = cfHtml("x");
		expect(doc.startsWith("Version:0.9\r\nStartHTML:")).toBe(true);
		const o = parseCfHtml(doc)!;
		expect(o.startHtml).toBe(doc.indexOf("<html>"));
		expect(doc.slice(o.startFragment - "<!--StartFragment-->".length, o.startFragment)).toBe("<!--StartFragment-->");
		expect(doc.slice(o.endFragment, o.endFragment + "<!--EndFragment-->".length)).toBe("<!--EndFragment-->");
		expect(cfHtml("").length).toBe(cfHtml("x").length - 1);
	});
	test("an empty fragment and a big one both stay consistent", () => {
		for (const f of ["", "<p>".repeat(20000)]) {
			const doc = cfHtml(f);
			const o = parseCfHtml(doc)!;
			expect(o.endFragment - o.startFragment).toBe(Buffer.byteLength(f, "utf8"));
			expect(o.endHtml).toBe(Buffer.byteLength(doc, "utf8"));
		}
	});
});
