// The controller against the in-memory host: numbering, refresh after a library edit, style change, cursor view, edit/delete.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { App, buildSearchArgs } from "../src/app";
import { parseFieldCode, parsePrefsXml, uriToKey } from "../src/fields";
import { SAMPLE_ITEMS, createMockHost } from "../src/mockhost";

const FIX = join(import.meta.dir, "..", "..", "..", "core", "test", "cite", "fixtures");
const read = (f: string) => readFileSync(join(FIX, f), "utf8");

function setup(prefsXml: string | null = null) {
	const items = structuredClone(SAMPLE_ITEMS);
	const host = createMockHost({
		items,
		userId: "5106252",
		prefsXml,
		styleXml: async (id) => read(`${id}.csl`),
		localeXml: async (l) => (l === "en-US" ? read("locales-en-US.xml") : null),
	});
	return { items, host, app: new App(host) };
}

const citeData = (code: string) => {
	const p = parseFieldCode(code);
	if (!p || p.kind !== "item") throw new Error("not a citation: " + code);
	return p.data;
};

describe("buildSearchArgs", () => {
	test("as-you-type prefix on the last word, year and DOI shortcuts", () => {
		expect(buildSearchArgs("liver trans")).toEqual({ match: '{title creators abstract publication tags} : ("liver" "trans"*)', limit: 30 });
		expect(buildSearchArgs("liver ").match).toBe('{title creators abstract publication tags} : ("liver")');
		expect(buildSearchArgs("smith 2021")).toEqual({ match: '{title creators abstract publication tags} : ("smith"*)', year: 2021, limit: 30 });
		expect(buildSearchArgs("2021")).toEqual({ year: 2021, limit: 30 });
		expect(buildSearchArgs("https://doi.org/10.1000/tx.2021.001")).toEqual({ doi: "10.1000/tx.2021.001", limit: 30 });
		expect(buildSearchArgs("")).toEqual({ limit: 30 });
		expect(buildSearchArgs('"graft survival"').match).toBe('{title creators abstract publication tags} : ("graft survival")');
	});
});

describe("App against a mock Word document", () => {
	test("insert two citations (Vancouver numbering), then a bibliography", async () => {
		const { app, host } = setup();
		await app.init();
		const a = (await app.pickFromKey("AAAA1111"))!;
		const b = (await app.pickFromKey("BBBB2222"))!;
		await app.insertCitation([b]);
		await app.insertCitation([a]);
		expect(host.fields.length).toBe(2);
		const c1 = citeData(host.fields[0].code);
		expect(c1.citationItems[0]!.uris).toEqual(["http://zotero.org/users/5106252/items/BBBB2222"]);
		expect(c1.citationItems[0]!.itemData!.title).toContain("Machine perfusion");
		expect(c1.properties.plainCitation).toBe("(1)");
		expect(host.fields[0].text).toBe("(1)");
		expect(host.fields[1].text).toBe("(2)");
		await app.insertBibliography();
		const bib = host.fields.find((f: any) => f.kind === "bibl");
		expect(bib.code).toBe('ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY');
		const entries = bib.text.split("\r");
		expect(entries.length).toBe(2);
		expect(entries[0]).toContain("Machine perfusion");
		expect(entries[1]).toContain("Outcomes after liver transplantation");
		const prefs = parsePrefsXml(host.prefsXml)!;
		expect(prefs.styleId).toBe("http://www.zotero.org/styles/vancouver");
		expect(prefs.hasBibliography).toBe(true);
		expect(prefs.fieldType).toBe("Field");
	});

	test("refresh picks up library edits and rewrites embedded item data", async () => {
		const { app, host, items } = setup();
		await app.init();
		await app.insertCitation([(await app.pickFromKey("AAAA1111"))!]);
		await app.insertBibliography();
		items[0]!.title = "Outcomes after liver transplantation: a revised title";
		const r = await app.refreshAll();
		expect(r.updated).toBeGreaterThan(0);
		expect(citeData(host.fields[0].code).citationItems[0]!.itemData!.title).toBe("Outcomes after liver transplantation: a revised title");
		expect(host.fields[1].text).toContain("a revised title");
		const again = await app.refreshAll();
		expect(again.updated).toBe(0); // idempotent
	});

	test("changing the style reformats everything and updates the prefs", async () => {
		const { app, host } = setup();
		await app.init();
		await app.insertCitation([(await app.pickFromKey("AAAA1111"))!]);
		await app.insertBibliography();
		await app.setStyle("apa", "en-US");
		expect(host.fields[0].text).toBe("(Smith & Haddad, 2021)");
		expect(citeData(host.fields[0].code).properties.plainCitation).toBe("(Smith & Haddad, 2021)");
		expect(parsePrefsXml(host.prefsXml)!.styleId).toBe("http://www.zotero.org/styles/apa");
		expect(host.fields[1].text).toContain("Smith, J., & Haddad, O. (2021)");
	});

	test("locator, prefix, suffix and suppress-author reach the output", async () => {
		const { app, host } = setup();
		await app.init();
		await app.setStyle("apa", "en-US");
		const a = (await app.pickFromKey("AAAA1111"))!;
		Object.assign(a, { locator: "23-25", label: "page", prefix: "see", suffix: "for details" });
		await app.insertCitation([a]);
		expect(host.fields[0].text).toBe("(see Smith & Haddad, 2021, pp. 23–25 for details)");
		const d = citeData(host.fields[0].code).citationItems[0]!;
		expect(d.locator).toBe("23-25");
		expect(d.label).toBe("page");
	});

	test("cursor view shows the abstract and library status; unknown items fall back to the embedded data", async () => {
		const { app, host } = setup();
		await app.init();
		await app.insertCitation([(await app.pickFromKey("AAAA1111"))!]);
		const cur = await host.call<any>("doc.cursor");
		const v = (await app.describeCitation(cur))!;
		expect(v.items[0]!.inLibrary).toBe(true);
		expect(v.items[0]!.key).toBe("AAAA1111");
		expect(v.items[0]!.abstract).toContain("registry data");
		expect(v.items[0]!.authors).toBe("Smith J, Haddad O");
		expect(v.items[0]!.journal).toBe("Transplantation");
		// the same citation after the item left the library: embedded itemData, no abstract (CSL itemData has none here), not in library
		const gone = JSON.parse(JSON.stringify(citeData(cur.code)));
		gone.citationItems[0].uris = ["http://zotero.org/users/local/zzzz9999/items/ZZZZ9999"];
		const v2 = (await app.describeCitation({ ...cur, code: "ADDIN ZOTERO_ITEM CSL_CITATION " + JSON.stringify(gone) }))!;
		expect(v2.items[0]!.inLibrary).toBe(false);
		expect(v2.items[0]!.key).toBeNull();
		expect(v2.items[0]!.title).toContain("Outcomes after liver transplantation");
		expect(await app.describeCitation({ inField: false })).toBeNull();
	});

	test("edit and delete", async () => {
		const { app, host } = setup();
		await app.init();
		await app.insertCitation([(await app.pickFromKey("AAAA1111"))!]);
		const cur = await host.call<any>("doc.cursor");
		const { picks, citationID } = (await app.picksFromCitation(cur.code))!;
		picks.push((await app.pickFromKey("BBBB2222"))!);
		await app.updateCitation(cur.ref, citationID, picks);
		const data = citeData(host.fields[0].code);
		expect(data.citationID).toBe(citationID);
		expect(data.citationItems.length).toBe(2);
		expect(host.fields[0].text).toBe("(1,2)");
		await app.deleteCitation({ story: "main", idx: 1 }, citationID);
		expect(host.fields.length).toBe(0);
		expect(uriToKey(data.citationItems[0]!.uris[0]!)).toBe("AAAA1111");
	});

	test("reads and refreshes a document created by Zotero (different style, local URIs)", async () => {
		const zoteroPrefs = '<data data-version="3" zotero-version="7.0.3"><session id="mAGnqnH1"/><style id="http://www.zotero.org/styles/apa" locale="en-US" hasBibliography="0" bibliographyStyleHasBeenSet="1"/><prefs><pref name="fieldType" value="Field"/><pref name="automaticJournalAbbreviations" value="false"/><pref name="noteType" value="0"/></prefs></data>';
		const { app, host } = setup(zoteroPrefs);
		await app.init();
		host.fields.push({
			story: "main", idx: 1, kind: "item", start: 0, end: 0, text: "(old)",
			code: 'ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"q1w2e3r4","properties":{"formattedCitation":"(old)","plainCitation":"(old)","noteIndex":0},"citationItems":[{"id":9,"uris":["http://zotero.org/users/local/abc12345/items/BBBB2222"],"itemData":{"id":9,"type":"article-journal","title":"stale title","author":[{"family":"Chen","given":"Li"}],"issued":{"date-parts":[[2019]]}}}],"schema":"https://github.com/citation-style-language/schema/raw/master/csl-citation.json"} ',
		});
		const r = await app.refreshAll();
		expect(r.style).toBe("apa");
		expect(host.fields[0].text).toBe("(Chen, 2019)");
		const d = citeData(host.fields[0].code);
		expect(d.citationID).toBe("q1w2e3r4");
		expect(d.citationItems[0]!.id).toBe(9); // Zotero's own numeric id is kept
		expect(d.citationItems[0]!.uris[0]).toBe("http://zotero.org/users/local/abc12345/items/BBBB2222"); // URIs untouched
		expect(d.citationItems[0]!.itemData!.title).toContain("Machine perfusion"); // refreshed from the library
	});

	test("duplicated fields with the same citationID stay independent", async () => {
		const { app, host } = setup();
		await app.init();
		await app.insertCitation([(await app.pickFromKey("AAAA1111"))!]);
		host.fields.push({ ...structuredClone(host.fields[0]), idx: 2 });
		const r = await app.refreshAll();
		expect(r.citations).toBe(2);
		expect(host.fields.map((f: any) => f.text)).toEqual(["(1)", "(1)"]);
	});
});
