// Citation popup helpers and the App method behind it, against the in-memory host.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { App, plainReference, stripNumberLabel } from "../src/app";
import { escapeHtml, metaLine, noteChips, popupHeight, runsToHtml, targetFromCursor } from "../src/cited";
import { SAMPLE_ITEMS, createMockHost } from "../src/mockhost";

const FIX = join(import.meta.dir, "..", "..", "..", "core", "test", "cite", "fixtures");
const read = (f: string) => readFileSync(join(FIX, f), "utf8");

async function citationCode(host: ReturnType<typeof createMockHost>, app: App, keys: string[]) {
	await app.init();
	await app.insertCitation(await Promise.all(keys.map(async (k) => (await app.pickFromKey(k))!)));
	return host.fields[host.fields.length - 1].code as string;
}
function setup(prefsXml: string | null = null) {
	const items = structuredClone(SAMPLE_ITEMS);
	const host = createMockHost({ items, userId: "5106252", prefsXml, styleXml: async (id) => read(`${id}.csl`), localeXml: async (l) => (l === "en-US" ? read("locales-en-US.xml") : null) });
	return { items, host, app: new App(host) };
}

describe("cited helpers", () => {
	test("targetFromCursor accepts a Zotero citation field only", () => {
		const code = 'ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"x","properties":{},"citationItems":[]}';
		expect(targetFromCursor({ code, ref: { story: "main", idx: 3 } })).toEqual({ code, ref: { story: "main", idx: 3 } });
		expect(targetFromCursor({ code })?.ref).toBeNull();
		expect(targetFromCursor({ code: "ADDIN ZOTERO_BIBL {} CSL_BIBLIOGRAPHY" })).toBeNull();
		expect(targetFromCursor({ code: "ADDIN ZOTERO_ITEM CSL_CITATION {broken" })).toBeNull();
		expect(targetFromCursor({})).toBeNull();
		expect(targetFromCursor(null)).toBeNull();
	});
	test("runsToHtml escapes and styles", () => {
		expect(runsToHtml([{ t: "A <b> & " }, { t: "Journal", i: 1 }, { t: "2", sup: 1 }])).toBe("A &lt;b&gt; &amp; <i>Journal</i><sup>2</sup>");
		expect(escapeHtml(`"'`)).toBe("&quot;&#39;");
	});
	test("metaLine, noteChips, popupHeight", () => {
		expect(metaLine({ authors: "Smith J", year: "2021", journal: "" })).toBe("Smith J · 2021");
		expect(noteChips({ locator: "23", prefix: "see", suffix: "" })).toEqual(["loc. 23", "prefix: see"]);
		expect(popupHeight(300.2)).toBe(301);
		expect(popupHeight(2000)).toBe(520);
		expect(popupHeight(5)).toBe(80);
	});
	test("stripNumberLabel and plainReference", () => {
		expect(stripNumberLabel([{ t: "1. Smith J. " }, { t: "Title", i: 1 }])).toEqual([{ t: "Smith J. " }, { t: "Title", i: 1 }]);
		expect(stripNumberLabel([{ t: "[12] Smith" }])[0]!.t).toBe("Smith");
		expect(stripNumberLabel([{ t: "2021 report. Smith" }])[0]!.t).toBe("2021 report. Smith");
		expect(plainReference({ authors: "Smith J", title: "A title", journal: "Tx", year: "2021" })).toBe("Smith J. A title. Tx 2021.");
	});
});

describe("App.describeForPopup", () => {
	test("formats each cited item as a full reference with its abstract", async () => {
		const { app, host } = setup();
		const code = await citationCode(host, app, ["AAAA1111", "BBBB2222"]);
		const v = (await app.describeForPopup(code))!;
		expect(v.items.length).toBe(2);
		const text = (i: number) => v.items[i]!.reference.map((r) => r.t).join("");
		expect(text(0)).toContain("Outcomes after liver transplantation");
		expect(text(0)).not.toMatch(/^\s*1[.)]/); // numeric label stripped
		expect(text(1)).toContain("Machine perfusion");
		expect(v.items[0]!.abstract).toContain("graft survival");
		expect(v.items[0]!.inLibrary).toBe(true);
	});
	test("an item gone from the library falls back to the embedded copy", async () => {
		const { app, host, items } = setup();
		const code = await citationCode(host, app, ["AAAA1111"]);
		items.length = 0;
		const v = (await app.describeForPopup(code))!;
		expect(v.items[0]!.inLibrary).toBe(false);
		expect(v.items[0]!.missing).toBe(false);
		expect(v.items[0]!.reference.map((r) => r.t).join("")).toContain("Outcomes after liver transplantation");
	});
	test("returns null for a non-citation field", async () => {
		const { app } = setup();
		expect(await app.describeForPopup("ADDIN ZOTERO_BIBL {} CSL_BIBLIOGRAPHY")).toBeNull();
	});
});
