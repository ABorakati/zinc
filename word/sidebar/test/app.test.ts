// The controller against the in-memory host: numbering, refresh after a library edit, style change, cursor view, edit/delete,
// merge/split, bibliography editor, unlink, note conversion, delayed updates, manual edits.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { App, buildSearchArgs, changesFromEntries } from "../src/app";
import { buildItemCode, isHandEdited, parseFieldCode, parsePrefsXml, uriToKey } from "../src/fields";
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
		expect(buildSearchArgs("liver trans")).toEqual({
			match: '{title creators abstract publication tags} : ("liver" "trans"*)',
			limit: 30,
		});
		expect(buildSearchArgs("liver ").match).toBe('{title creators abstract publication tags} : ("liver")');
		expect(buildSearchArgs("smith 2021")).toEqual({
			match: '{title creators abstract publication tags} : ("smith"*)',
			year: 2021,
			limit: 30,
		});
		expect(buildSearchArgs("2021")).toEqual({ year: 2021, limit: 30 });
		expect(buildSearchArgs("https://doi.org/10.1000/tx.2021.001")).toEqual({ doi: "10.1000/tx.2021.001", limit: 30 });
		expect(buildSearchArgs("")).toEqual({ limit: 30 });
		expect(buildSearchArgs('"graft survival"').match).toBe('{title creators abstract publication tags} : ("graft survival")');
		expect(buildSearchArgs("Al-Mansoor").match).toBe('{title creators abstract publication tags} : ("Al Mansoor"*)');
		expect(buildSearchArgs("O'Brien").match).toBe('{title creators abstract publication tags} : ("O Brien"*)');
	});

	test("app.search finds items by author name, title, author + year, and DOI", async () => {
		const { app } = setup();
		await app.init();
		expect((await app.search("Smith")).map((r) => r.key)).toEqual(["AAAA1111"]);
		expect((await app.search("Kovacs")).map((r) => r.key)).toEqual(["CCCC3333"]);
		expect((await app.search("Machine perfusion")).map((r) => r.key)).toEqual(["BBBB2222"]);
		expect((await app.search("Smith 2021")).map((r) => r.key)).toEqual(["AAAA1111"]);
		expect((await app.search("Smith 2019")).map((r) => r.key)).toEqual([]);
		expect((await app.search("10.1000/jh.2019.044")).map((r) => r.key)).toEqual(["BBBB2222"]);
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
		expect(citeData(host.fields[0].code).citationItems[0]!.itemData!.title).toBe(
			"Outcomes after liver transplantation: a revised title",
		);
		expect(host.fields[1].text).toContain("a revised title");
		const again = await app.refreshAll();
		expect(again.updated).toBe(0); // idempotent
	});

	test("a field code left as old + new by a tracked rewrite is rewritten (cleaned) by the next refresh, once", async () => {
		const { app, host } = setup();
		await app.init();
		await app.insertCitation([(await app.pickFromKey("AAAA1111"))!]);
		await app.insertBibliography();
		expect((await app.refreshAll()).updated).toBe(0);
		// what the add-in reports for codes with tracked changes inside: the code as it reads accepted, flagged
		const before = host.fields.map((f: any) => f.code);
		for (const f of host.fields) f.tracked = true;
		const r = await app.refreshAll();
		expect(r.updated).toBe(2); // the citation and the bibliography, though their JSON and text are already right
		expect(host.fields.map((f: any) => f.code)).toEqual(before);
		expect(host.fields.every((f: any) => !f.tracked)).toBe(true);
		expect((await app.refreshAll()).updated).toBe(0);
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
		const zoteroPrefs =
			'<data data-version="3" zotero-version="7.0.3"><session id="mAGnqnH1"/><style id="http://www.zotero.org/styles/apa" locale="en-US" hasBibliography="0" bibliographyStyleHasBeenSet="1"/><prefs><pref name="fieldType" value="Field"/><pref name="automaticJournalAbbreviations" value="false"/><pref name="noteType" value="0"/></prefs></data>';
		const { app, host } = setup(zoteroPrefs);
		await app.init();
		host.fields.push({
			story: "main",
			idx: 1,
			kind: "item",
			start: 0,
			end: 0,
			text: "(old)",
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

// ---------------------------------------------------------------- Zotero-plugin parity features

const MINI_NOTE = `<?xml version="1.0" encoding="utf-8"?><style xmlns="http://purl.org/net/xbiblio/csl" class="note" version="1.0"><info><title>Mini note</title><id>http://www.zotero.org/styles/mininote</id><updated>2020-01-01T00:00:00+00:00</updated></info><citation><layout delimiter="; "><text variable="title"/></layout></citation><bibliography><layout><text variable="title"/></layout></bibliography></style>`;

function setupNote(prefsXml: string | null = null) {
	const items = structuredClone(SAMPLE_ITEMS);
	const host = createMockHost({
		items,
		userId: "5106252",
		prefsXml,
		styleXml: async (id) => (id === "mininote" ? MINI_NOTE : read(`${id}.csl`)),
		localeXml: async (l) => (l === "en-US" ? read("locales-en-US.xml") : null),
	});
	return { items, host, app: new App(host) };
}

const pickAll = async (app: App, ...keys: string[]) => Promise.all(keys.map(async (k) => (await app.pickFromKey(k))!));
const biblOf = (host: any) => host.fields.find((f: any) => f.kind === "bibl");

describe("merging adjacent citations on refresh", () => {
	test("touching citations are folded into the first one, duplicates dropped, later fields deleted", async () => {
		const { app, host } = setup();
		await app.init();
		const [a, b, c] = await pickAll(app, "AAAA1111", "BBBB2222", "CCCC3333");
		await app.insertCitation([a!]);
		await app.insertCitation([b!]);
		await app.insertCitation([a!]); // the same item again: dropped by the merge
		await app.insertCitation([c!]);
		expect(host.fields.length).toBe(4);
		// typed text between the fields (the mock leaves one character): nothing merges
		await app.refreshAll({ merge: true });
		expect(host.fields.length).toBe(4);
		// make them touch
		for (const f of host.fields.slice(1)) f.gap = 0;
		// a plain refresh (the other flows) still leaves them alone
		await app.refreshAll();
		expect(host.fields.length).toBe(4);
		const r = await app.refreshAll({ merge: true });
		expect(r.merged).toBe(3);
		expect(host.fields.length).toBe(1);
		const d = citeData(host.fields[0].code);
		expect(d.citationItems.map((i: any) => uriToKey(i.uris[0]))).toEqual(["AAAA1111", "BBBB2222", "CCCC3333"]);
		expect(host.fields[0].text).toBe("(1–3)");
		expect(d.properties.plainCitation).toBe("(1–3)");
	});

	test("fields in different stories, hand-edited fields and dontUpdate fields never merge", async () => {
		const { app, host } = setup();
		await app.init();
		const [a, b, c] = await pickAll(app, "AAAA1111", "BBBB2222", "CCCC3333");
		await app.insertCitation([a!]);
		await app.insertCitation([b!]);
		await app.insertCitation([c!]);
		// the second one touches the first but lives in a footnote: never adjacent
		host.fields[1].story = "fn";
		host.fields[1].gap = 0;
		await app.refreshAll({ merge: true });
		expect(host.fields.length).toBe(3);
		// dontUpdate
		host.fields[1].story = "main";
		host.fields[1].gap = 0;
		host.fields[2].gap = 0;
		const d = citeData(host.fields[0].code);
		d.properties.dontUpdate = true;
		host.fields[0].code = buildItemCode(d);
		await app.refreshAll({ merge: true });
		expect(host.fields.length).toBe(2); // the last two merged, the dontUpdate one stayed alone
		expect(citeData(host.fields[0].code).citationItems.length).toBe(1);
		expect(citeData(host.fields[1].code).citationItems.length).toBe(2);
	});

	test("citations in the same footnote merge, in different footnotes they do not", async () => {
		const { app, host } = setupNote();
		await app.init();
		await app.setStyle("mininote", "en-US");
		const [a, b, c] = await pickAll(app, "AAAA1111", "BBBB2222", "CCCC3333");
		await app.insertCitation([a!]);
		await app.insertCitation([b!]);
		expect(host.fields.map((f: any) => f.story)).toEqual(["fn", "fn"]);
		await app.refreshAll({ merge: true });
		expect(host.fields.length).toBe(2); // two notes
		await app.insertCitation([c!]);
		host.fields[1].gap = 0; // B joins A's note
		await app.refreshAll({ merge: true });
		expect(host.fields.length).toBe(2);
		expect(citeData(host.fields[0].code).citationItems.length).toBe(2);
	});
});

describe("splitting a citation", () => {
	test("one citation per item, keeping locator/prefix/suffix, then Refresh merges them back", async () => {
		const { app, host } = setup();
		await app.init();
		const [a, b, c] = await pickAll(app, "AAAA1111", "BBBB2222", "CCCC3333");
		Object.assign(b!, { locator: "12", label: "page", prefix: "see" });
		await app.insertCitation([a!, b!, c!]);
		expect(host.fields.length).toBe(1);
		const before = citeData(host.fields[0].code);
		await app.splitCitation({ story: "main", idx: 1 }, before.citationID);
		expect(host.fields.length).toBe(3);
		expect(host.calls).toContain("doc.insert");
		const parts = host.fields.map((f: any) => citeData(f.code));
		expect(parts.map((p: any) => p.citationItems.length)).toEqual([1, 1, 1]);
		expect(parts.map((p: any) => uriToKey(p.citationItems[0].uris[0]))).toEqual(["AAAA1111", "BBBB2222", "CCCC3333"]);
		expect(new Set(parts.map((p: any) => p.citationID)).size).toBe(3);
		expect(parts[1]!.citationItems[0]!.locator).toBe("12");
		expect(parts[1]!.citationItems[0]!.prefix).toBe("see");
		expect(host.fields.map((f: any) => f.text)).toEqual(["(1)", "(see 2)", "(3)"]);
		// they touch each other now, so Refresh joins them again
		const r = await app.refreshAll({ merge: true });
		expect(r.merged).toBe(2);
		expect(host.fields.length).toBe(1);
		expect(citeData(host.fields[0].code).citationItems.length).toBe(3);
		await expect(app.splitCitation({ story: "main", idx: 1 }, "nope")).rejects.toThrow(); // stale id
	});
});

describe("bibliography editor", () => {
	async function withBib() {
		const t = setup();
		await t.app.init();
		const [a, b] = await pickAll(t.app, "AAAA1111", "BBBB2222");
		await t.app.insertCitation([a!]);
		await t.app.insertCitation([b!]);
		await t.app.insertBibliography();
		return t;
	}

	test("lists cited entries; exclude, custom text and an uncited item are stored the way Zotero stores them", async () => {
		const { app, host } = await withBib();
		let entries = (await app.bibliographyEditor())!;
		expect(entries.length).toBe(2);
		expect(entries.map((e) => e.cslId)).toEqual(["AAAA1111", "BBBB2222"]);
		expect(entries.every((e) => e.cited && !e.omitted && !e.custom && !e.uncited)).toBe(true);
		expect(entries[0]!.uris).toEqual(["http://zotero.org/users/5106252/items/AAAA1111"]);
		expect(entries[0]!.title).toContain("Outcomes");

		// exclude B, rewrite A's text, add the uncited book C
		const c = (await app.pickFromKey("CCCC3333"))!;
		entries[1]!.omitted = true;
		entries[0]!.custom = true;
		entries[0]!.runs = [{ t: "My own " }, { t: "entry", i: 1 }, { t: " é" }];
		const changes = changesFromEntries(entries);
		changes.uncited.push(c.uris);
		await app.saveBibliography(changes);

		const bib = biblOf(host);
		expect(bib.text.split("\r")).toEqual(["My own entry é", expect.stringContaining("Clinical Transplantation Handbook")]);
		const data = parseFieldCode(bib.code);
		if (data?.kind !== "bibl") throw new Error("bibl expected");
		expect(data.data.omitted).toEqual([["http://zotero.org/users/5106252/items/BBBB2222"]]);
		expect(data.data.uncited).toEqual([["http://zotero.org/users/5106252/items/CCCC3333"]]);
		expect(data.data.custom).toEqual([[["http://zotero.org/users/5106252/items/AAAA1111"], "My own {\\i{}entry} \\uc0\\u233{}"]]);
		// the citations in the text are untouched by the bibliography edit
		expect(host.fields[0].text).toBe("(1)");
		expect((await app.refreshAll()).updated).toBe(0); // idempotent

		entries = (await app.bibliographyEditor())!;
		expect(entries.map((e) => [e.cslId, e.omitted, e.custom, e.uncited, e.cited])).toEqual([
			["AAAA1111", false, true, false, true],
			["BBBB2222", true, false, false, true],
			["CCCC3333", false, false, true, false],
		]);
		expect(entries[0]!.runs).toEqual([{ t: "My own " }, { t: "entry", i: 1 }, { t: " é" }]);
		expect(entries[0]!.defaultRuns.map((r) => r.t).join("")).toContain("Outcomes after liver");

		// revert all: back to the defaults (the uncited item stays listed)
		for (const e of entries) {
			e.custom = false;
			e.omitted = false;
		}
		await app.saveBibliography(changesFromEntries(entries));
		const back = parseFieldCode(biblOf(host).code);
		if (back?.kind !== "bibl") throw new Error("bibl expected");
		expect(back.data.omitted).toEqual([]);
		expect(back.data.custom).toEqual([]);
		expect(back.data.uncited.length).toBe(1);
		expect(biblOf(host).text.split("\r").length).toBe(3);
	});

	test("custom text applies only to single-item entries read from a Zotero-written field, and survives a plain refresh", async () => {
		const { app, host } = await withBib();
		const bib = biblOf(host);
		bib.code =
			'ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[["http://zotero.org/users/5106252/items/AAAA1111"]],"custom":[[["http://zotero.org/users/5106252/items/BBBB2222"],"{\\\\i{}Chen}, custom"]]} CSL_BIBLIOGRAPHY';
		await app.refreshAll();
		expect(biblOf(host).text).toBe("Chen, custom");
		expect(biblOf(host).code).toContain('"omitted":[["http://zotero.org/users/5106252/items/AAAA1111"]]'); // the field code is not rewritten by a refresh
		const entries = (await app.bibliographyEditor())!;
		expect(entries.find((e) => e.cslId === "AAAA1111")!.omitted).toBe(true);
		expect(entries.find((e) => e.cslId === "BBBB2222")!.runs).toEqual([{ t: "Chen", i: 1 }, { t: ", custom" }]);
	});

	test("omitting every entry empties the bibliography; no bibliography field -> no editor", async () => {
		const { app, host } = await withBib();
		const entries = (await app.bibliographyEditor())!;
		for (const e of entries) e.omitted = true;
		await app.saveBibliography(changesFromEntries(entries));
		expect(biblOf(host).text).toBe("");
		const t = setup();
		await t.app.init();
		expect(await t.app.bibliographyEditor()).toBeNull();
		await expect(t.app.saveBibliography({ omitted: [] })).rejects.toThrow();
	});
});

describe("unlink citations", () => {
	test("every Zotero field is unlinked (last first), the text stays and the preferences are kept", async () => {
		const { app, host } = setup();
		await app.init();
		const [a, b] = await pickAll(app, "AAAA1111", "BBBB2222");
		await app.insertCitation([a!]);
		await app.insertCitation([b!]);
		await app.insertBibliography();
		const texts = host.fields.map((f: any) => f.text);
		const r = await app.unlinkCitations();
		expect(r.unlinked).toBe(3);
		expect(host.fields.length).toBe(0);
		expect(host.unlinked.map((u: any) => u.text)).toEqual([...texts].reverse());
		expect(host.calls.filter((c: string) => c === "doc.unlink").length).toBe(3);
		expect(host.calls).not.toContain("doc.delete");
		expect(parsePrefsXml(host.prefsXml)).not.toBeNull();
		expect((await app.unlinkCitations()).unlinked).toBe(0);
	});
});

describe("document preferences", () => {
	test("note style on/off converts the existing citations, skipping dontUpdate and bibliographies", async () => {
		const { app, host } = setupNote();
		await app.init();
		const [a, b, c] = await pickAll(app, "AAAA1111", "BBBB2222", "CCCC3333");
		await app.insertCitation([a!]);
		await app.insertCitation([b!]);
		await app.insertCitation([c!]);
		await app.insertBibliography();
		const frozen = citeData(host.fields[1].code);
		frozen.properties.dontUpdate = true;
		host.fields[1].code = buildItemCode(frozen);
		await app.setStyle("mininote", "en-US");
		expect(host.fields.map((f: any) => [f.kind, f.story])).toEqual([
			["item", "fn"],
			["item", "main"],
			["item", "fn"],
			["bibl", "main"],
		]);
		expect(parsePrefsXml(host.prefsXml)!.noteType).toBe(1);
		expect(host.fields[0].text).toBe("Outcomes after liver transplantation in the United Kingdom");
		expect(citeData(host.fields[0].code).properties.noteIndex).toBe(1);
		// footnotes -> endnotes
		expect(await app.setNoteType(2)).not.toBeNull();
		expect(host.fields.map((f: any) => f.story)).toEqual(["en", "main", "en", "main"]);
		expect(parsePrefsXml(host.prefsXml)!.noteType).toBe(2);
		// a new citation goes where the setting says
		await app.insertCitation([a!]);
		expect(host.fields.filter((f: any) => f.kind === "item").map((f: any) => f.story)).toEqual(["en", "main", "en", "en"]);
		// back to an in-text style: everything moves into the text
		await app.setStyle("vancouver", "en-US");
		expect(host.fields.map((f: any) => f.story)).toEqual(["main", "main", "main", "main", "main"]);
		expect(parsePrefsXml(host.prefsXml)!.noteType).toBe(0);
		expect(host.fields[0].text).toBe("(1)");
		// the style class did not change: no conversion
		const n = host.calls.filter((c: string) => c === "doc.convert").length;
		await app.setStyle("apa", "en-US");
		expect(host.calls.filter((c: string) => c === "doc.convert").length).toBe(n);
		// the note type does nothing for an in-text style
		expect(await app.setNoteType(1)).toBeNull();
	});

	test("a style change that fails halfway writes no preferences, and trying again moves the rest", async () => {
		const { app, host } = setupNote();
		await app.init();
		const [a, b] = await pickAll(app, "AAAA1111", "BBBB2222");
		await app.insertCitation([a!]);
		await app.insertCitation([b!]);
		const real = host.call.bind(host);
		let converts = 0;
		const start = host.calls.length;
		host.call = (async (method: string, params?: Record<string, unknown>) => {
			if (method === "doc.convert" && ++converts === 2) throw new Error("Word refused");
			return real(method, params);
		}) as typeof host.call;
		await expect(app.setStyle("mininote", "en-US")).rejects.toThrow(/Moving citations failed/);
		host.call = real;
		// the preferences are written inside the edit, after the move, so the failure left them as they were
		expect(parsePrefsXml(host.prefsXml)!.noteType).toBe(0);
		const run = host.calls.slice(start);
		expect(run.filter((c: string) => c === "doc.setPrefs").length).toBe(0);
		expect(run.lastIndexOf("doc.end")).toBeGreaterThan(run.indexOf("doc.begin"));
		expect(host.fields.map((f: any) => f.story).sort()).toEqual(["fn", "main"]);
		// a second try converts what is left (it used to see the new class already written and move nothing)
		const before = host.calls.length;
		await app.setStyle("mininote", "en-US");
		expect(host.fields.map((f: any) => f.story)).toEqual(["fn", "fn"]);
		const second = host.calls.slice(before);
		expect(second.indexOf("doc.begin")).toBeLessThan(second.indexOf("doc.setPrefs"));
		expect(second.indexOf("doc.setPrefs")).toBeLessThan(second.lastIndexOf("doc.end"));
		expect(parsePrefsXml(host.prefsXml)!.noteType).toBe(1);
	});

	test("Automatically update citations off: a new or edited citation is formatted alone, Refresh does the rest", async () => {
		const { app, host } = setup();
		await app.init();
		const [a, b] = await pickAll(app, "AAAA1111", "BBBB2222");
		await app.insertCitation([b!]);
		await app.insertBibliography();
		await app.setAutoUpdate(false);
		expect(parsePrefsXml(host.prefsXml)!.delayCitationUpdates).toBe(true);
		const bibBefore = biblOf(host).text;
		host.calls.length = 0;
		await app.insertCitation([a!]);
		expect(host.fields.filter((f: any) => f.kind === "item").map((f: any) => f.text)).toEqual(["(1)", "(1)"]); // only a standalone preview
		expect(biblOf(host).text).toBe(bibBefore);
		expect(host.calls.filter((c: string) => c === "doc.set").length).toBe(0); // nothing else was touched
		// editing is the same
		const cur = host.fields[2]; // the new citation (appended after the bibliography)
		const { picks, citationID } = (await app.picksFromCitation(cur.code))!;
		picks.push((await app.pickFromKey("CCCC3333"))!);
		await app.updateCitation({ story: "main", idx: 3 }, citationID, picks);
		expect(host.fields[2].text).toBe("(1,2)");
		expect(host.fields[0].text).toBe("(1)");
		expect(biblOf(host).text).toBe(bibBefore);
		// Refresh updates everything
		await app.refreshAll();
		expect(host.fields.filter((f: any) => f.kind === "item").map((f: any) => f.text)).toEqual(["(1)", "(2,3)"]);
		expect(biblOf(host).text.split("\r").length).toBe(3);
		await app.setAutoUpdate(true);
		expect(parsePrefsXml(host.prefsXml)!.delayCitationUpdates).toBe(false);
	});

	test("fieldType (bookmarks) and automaticJournalAbbreviations are kept as they are", async () => {
		const zot =
			'<data data-version="3" zotero-version="7.0.3"><session id="mAGnqnH1"/><style id="http://www.zotero.org/styles/vancouver" locale="en-US" hasBibliography="0" bibliographyStyleHasBeenSet="1"/><prefs><pref name="fieldType" value="Bookmark"/><pref name="automaticJournalAbbreviations" value="true"/><pref name="noteType" value="0"/></prefs></data>';
		const { app, host } = setup(zot);
		await app.init();
		await app.insertCitation([(await app.pickFromKey("AAAA1111"))!]);
		await app.setStyle("apa", "en-US");
		await app.setAutoUpdate(false);
		const p = parsePrefsXml(host.prefsXml)!;
		expect(p.fieldType).toBe("Bookmark");
		expect(p.automaticJournalAbbreviations).toBe(true);
	});
});

describe("manual edits, custom text and unsorted items", () => {
	test("a citation typed into is kept (dontUpdate) by default and not rewritten again", async () => {
		const { app, host } = setup();
		await app.init();
		const [a, b] = await pickAll(app, "AAAA1111", "BBBB2222");
		await app.insertCitation([a!]);
		await app.insertCitation([b!]);
		host.fields[0].text = "(my own words)";
		const r = await app.refreshAll();
		expect(r.kept).toBe(1);
		expect(host.fields[0].text).toBe("(my own words)");
		expect(host.fields[1].text).toBe("(2)"); // it still counts for the numbering
		const d = citeData(host.fields[0].code);
		expect(d.properties.dontUpdate).toBe(true);
		expect(d.properties.plainCitation).toBe("(1)");
		const again = await app.refreshAll();
		expect(again.updated).toBe(0);
		expect(again.kept).toBe(0);
	});

	test("overwrite replaces the text; the callback gets the list and decides", async () => {
		const { app, host } = setup();
		await app.init();
		await app.insertCitation([(await app.pickFromKey("AAAA1111"))!]);
		host.fields[0].text = "(typed)";
		let seen: any[] = [];
		const r = await app.refreshAll({
			onModified: async (list): Promise<"overwrite"> => {
				seen = list;
				return "overwrite";
			},
		});
		expect(seen).toEqual([
			{ ref: { story: "main", idx: 1 }, citationID: citeData(host.fields[0].code).citationID, was: "(1)", now: "(typed)" },
		]);
		expect(host.fields[0].text).toBe("(1)");
		expect(r.kept).toBe(0);
		expect(citeData(host.fields[0].code).properties.dontUpdate).toBeUndefined();
		// not called when nothing was edited
		let called = false;
		await app.refreshAll({ onModified: () => ((called = true), "keep") });
		expect(called).toBe(false);
		// string forms
		host.fields[0].text = "(typed again)";
		await app.refreshAll({ onModified: "overwrite" });
		expect(host.fields[0].text).toBe("(1)");
		host.fields[0].text = "(typed 3)";
		await app.refreshAll({ onModified: () => "keep" });
		expect(host.fields[0].text).toBe("(typed 3)");
	});

	test("editing keeps custom text and unsorted, drops dontUpdate and the cached text", async () => {
		const { app, host } = setup();
		await app.init();
		await app.setStyle("apa", "en-US");
		const [a, b] = await pickAll(app, "AAAA1111", "BBBB2222");
		await app.insertCitation([a!, b!]);
		expect(host.fields[0].text).toBe("(Chen, 2019; Smith & Haddad, 2021)"); // the style sorts
		const d = citeData(host.fields[0].code);
		d.properties.unsorted = true;
		d.properties.dontUpdate = true;
		host.fields[0].code = buildItemCode(d);
		host.fields[0].text = "(hand made)";
		const cid = d.citationID;
		const { picks } = (await app.picksFromCitation(host.fields[0].code))!;
		expect(picks.map((p) => p.key)).toEqual(["AAAA1111", "BBBB2222"]);
		await app.updateCitation({ story: "main", idx: 1 }, cid, picks);
		const after = citeData(host.fields[0].code);
		expect(after.properties.unsorted).toBe(true);
		expect(after.properties.dontUpdate).toBeUndefined();
		expect(host.fields[0].text).toBe("(Smith & Haddad, 2021; Chen, 2019)"); // unsorted: the order given
		// custom text: shown as is, still part of the numbering
		after.properties.custom = "see {\\i{}everything}";
		host.fields[0].code = buildItemCode(after);
		await app.refreshAll();
		expect(host.fields[0].text).toBe("see everything");
		expect(citeData(host.fields[0].code).properties.plainCitation).toBe("see everything");
		expect(citeData(host.fields[0].code).properties.formattedCitation).toBe("see {\\i{}everything}");
		await app.updateCitation({ story: "main", idx: 1 }, cid, picks);
		expect(citeData(host.fields[0].code).properties.custom).toBe("see {\\i{}everything}");
		expect(host.fields[0].text).toBe("see everything");
		expect(isHandEdited(citeData(host.fields[0].code).properties, host.fields[0].text)).toBe(false);
		expect(isHandEdited(citeData(host.fields[0].code).properties, "other")).toBe(true);
		// updateCitation refuses a stale reference
		await expect(app.updateCitation({ story: "main", idx: 1 }, "nope", picks)).rejects.toThrow();
	});
});

describe("failure safety (split, edit URIs)", () => {
	test("a split that fails halfway leaves the original citation and no stray fields", async () => {
		const { app, host } = setup();
		await app.init();
		const [a, b, c] = await pickAll(app, "AAAA1111", "BBBB2222", "CCCC3333");
		await app.insertCitation([a!, b!, c!]);
		const before = host.fields[0].code;
		const id = citeData(before).citationID;
		const real = host.call.bind(host);
		let inserts = 0;
		host.call = (async (method: string, params?: Record<string, unknown>) => {
			if (method === "doc.insert" && ++inserts === 2) throw new Error("Word refused");
			return real(method, params);
		}) as typeof host.call;
		await expect(app.splitCitation({ story: "main", idx: 1 }, id)).rejects.toThrow(/original citation is unchanged/);
		host.call = real;
		expect(host.fields.length).toBe(1);
		expect(host.fields[0].code).toBe(before);
	});

	test("a citation with custom text is not split without the confirmed flag", async () => {
		const { app, host } = setup();
		await app.init();
		const [a, b] = await pickAll(app, "AAAA1111", "BBBB2222");
		await app.insertCitation([a!, b!]);
		const data = citeData(host.fields[0].code);
		data.properties.custom = "my own wording";
		host.fields[0].code = buildItemCode(data);
		await expect(app.splitCitation({ story: "main", idx: 1 }, data.citationID)).rejects.toThrow(/Confirm the split/);
		expect(host.fields.length).toBe(1);
		await app.splitCitation({ story: "main", idx: 1 }, data.citationID, { allowProtected: true });
		expect(host.fields.length).toBe(2);
	});

	test("editing a citation keeps the URIs it was written with (a group item stays in its group)", async () => {
		const { app, host } = setup();
		await app.init();
		const [a] = await pickAll(app, "AAAA1111");
		await app.insertCitation([a!]);
		const data = citeData(host.fields[0].code);
		data.citationItems[0]!.uris = ["http://zotero.org/groups/777/items/AAAA1111"];
		host.fields[0].code = buildItemCode(data);
		const res = await app.picksFromCitation(host.fields[0].code);
		expect(res!.picks[0]!.uris).toEqual(["http://zotero.org/groups/777/items/AAAA1111"]);
	});
});

describe("a document with locked Track Changes", () => {
	test("the state reports the lock, and a citation is refused with the reason, nothing written", async () => {
		const host = createMockHost({
			items: structuredClone(SAMPLE_ITEMS),
			userId: "5106252",
			trackingLocked: true,
			styleXml: async (id) => read(`${id}.csl`),
			localeXml: async (l) => (l === "en-US" ? read("locales-en-US.xml") : null),
		});
		const app = new App(host);
		await app.init();
		expect((await app.docState()).trackingLocked).toBe(true);
		const [a] = await pickAll(app, "AAAA1111");
		await expect(app.insertCitation([a!])).rejects.toThrow(/Track Changes is locked/);
		expect((host as any).fields.length).toBe(0);
	});
});

describe("the Bibliography style's format, as Zotero sets it", () => {
	test("sent with the first bibliography write only, recorded in the document preferences, and again after a style change", async () => {
		const { app, host } = setup();
		const sent: unknown[] = [];
		const call = host.call.bind(host);
		(host as any).call = async (method: string, params: any = {}) => {
			if (method === "doc.setMany") for (const it of params.items ?? []) if (it.styleFormat) sent.push(it.styleFormat);
			return call(method, params);
		};
		await app.init();
		const [a] = await pickAll(app, "AAAA1111");
		await app.insertCitation([a!]);
		await app.insertBibliography();
		expect(sent.length).toBe(1);
		expect(sent[0]).toMatchObject({ lineSpacing: expect.any(Number), entrySpacing: expect.any(Number), tabStops: expect.any(Array) });
		expect(parsePrefsXml((host as any).prefsXml)?.bibliographyStyleHasBeenSet).toBe(true);
		await app.refreshAll();
		const [b] = await pickAll(app, "BBBB2222");
		await app.insertCitation([b!]); // the bibliography changes: no style format this time
		expect(sent.length).toBe(1);
		await app.setStyle("apa", "en-US");
		expect(sent.length).toBe(2); // a new style: its format once more
		expect(parsePrefsXml((host as any).prefsXml)?.bibliographyStyleHasBeenSet).toBe(true);
	});
});

describe("field type of a new document", () => {
	test("a host that stores citations as reference marks (LibreOffice) gets fieldType ReferenceMark; Word keeps Field", async () => {
		for (const [fieldType, want] of [
			["ReferenceMark", "ReferenceMark"],
			[undefined, "Field"],
		] as const) {
			const { host, app } = setup();
			const call = host.call.bind(host);
			host.call = async (m: string, p?: Record<string, unknown>) => {
				const r = await call(m, p);
				return m === "host.info" && fieldType ? { ...r, fieldType } : r;
			};
			await app.init();
			await app.insertCitation([(await app.pickFromKey("AAAA1111"))!]);
			expect(parsePrefsXml(host.prefsXml)!.fieldType).toBe(want);
		}
	});
});
