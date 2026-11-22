// formatItems with several output formats must give, for every format, what asking for that format alone gives
// (each of those runs on a new citeproc engine): author-date with disambiguation, numeric, and a note style
// with ibid/subsequent forms, in bibliography and in citation mode.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZoteroItemData } from "../../src/api-types";
import { StyleStore, formatItems } from "../../src/cite/engine";
import type { CiteFormat, CiteMode } from "../../src/cite/types";
import { tempDir } from "../fixture";

const FIX = join(import.meta.dir, "fixtures");
const read = (f: string) => readFileSync(join(FIX, f), "utf8");

// a note style: full form first, "ibid" / "supra" afterwards, a year suffix to tell same-year works apart
const NOTE = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="note" version="1.0" default-locale="en-US">
  <info><title>Mini Note</title><id>http://www.zotero.org/styles/mini-note</id><updated>2020-01-01T00:00:00+00:00</updated></info>
  <citation disambiguate-add-year-suffix="true" disambiguate-add-names="true">
    <layout delimiter="; " suffix=".">
      <choose>
        <if position="ibid-with-locator"><text term="ibid"/></if>
        <else-if position="ibid"><text term="ibid"/></else-if>
        <else-if position="subsequent"><names variable="author"><name form="short"/></names><text value=", supra"/></else-if>
        <else>
          <names variable="author"><name/></names>
          <text variable="title" font-style="italic" prefix=", "/>
          <date variable="issued" prefix=" (" suffix=")"><date-part name="year"/></date>
        </else>
      </choose>
    </layout>
  </citation>
  <bibliography><sort><key variable="author"/></sort><layout><names variable="author"><name/></names><text variable="title" prefix=". " font-style="italic"/></layout></bibliography>
</style>`;

const item = (key: string, family: string, title: string, year: string): ZoteroItemData => ({
	key,
	itemType: "journalArticle",
	title,
	creators: [{ creatorType: "author", firstName: "Anna", lastName: family }],
	publicationTitle: "Journal of <i>Tests</i> & Trials",
	volume: "4",
	pages: "10-19",
	date: year,
});
// two works by one author in one year (disambiguation), a title with markup and an ampersand
const ITEMS: ZoteroItemData[] = [
	item("ITEM0001", "Smith", "Alpha & omega: <i>first</i> results", "2020"),
	item("ITEM0002", "Smith", "Beta results", "2020"),
	item("ITEM0003", "Jones", "Gamma results", "2019"),
	item("ITEM0004", "Patel", "Delta results", "2018"),
];

const mockFetch = async (url: string): Promise<Response> => {
	if (url.endsWith("/styles/vancouver")) return new Response(read("vancouver.csl"));
	if (url.endsWith("/styles/apa")) return new Response(read("apa.csl"));
	if (url.endsWith("/styles/mini-note")) return new Response(NOTE);
	if (url.endsWith("locales-en-US.xml")) return new Response(read("locales-en-US.xml"));
	return new Response("nope", { status: 404 });
};

const ALL: CiteFormat[] = ["html", "text", "rtf"];

async function run(store: StyleStore, style: string, mode: CiteMode, formats: CiteFormat[]) {
	return formatItems(store, { items: ITEMS, style, mode, formats, locale: "en-US" });
}

describe("formatItems with several formats", () => {
	for (const style of ["apa", "vancouver", "mini-note"]) {
		for (const mode of ["bibliography", "citation"] as const) {
			test(`${style} ${mode}: every format equals its own single-format run`, async () => {
				const store = new StyleStore(tempDir(), mockFetch);
				const together = await run(store, style, mode, ALL);
				for (const f of ALL) {
					const alone = await run(store, style, mode, [f]);
					expect(together[f]).toBeDefined();
					expect(together[f]).toBe(alone[f]!);
				}
				// a different order of the same formats changes nothing
				const reversed = await run(store, style, mode, [...ALL].reverse());
				for (const f of ALL) expect(reversed[f]).toBe(together[f]!);
				// the formats really differ (so the comparison above is not trivially equal)
				if (mode === "bibliography") {
					expect(together.html).not.toBe(together.text!);
					expect(together.rtf).not.toBe(together.html!);
				}
			}, 120_000);
		}
	}
});
