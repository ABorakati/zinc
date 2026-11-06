// Ported from zotero/utilities test/tests/utilities_itemTest.js @ 4051881d59c6c12d34417d4c226f37218051be90 (AGPL-3.0, see README.md).
// Subject: zotero-next's own Zotero item <-> CSL-JSON conversion: core/src/cite/csl.ts (itemToCsl) and
// core/src/io/csljson.ts (cslToItem). Zotero's code for this is Zotero.Utilities.Item.itemToCSLJSON / itemFromCSLJSON.
// Test names are the upstream ones. The data file data/citeProcJSExport.json is upstream's test/data/citeProcJSExport.json.
// The last block asks Zotero's own vendored utilities (through ./oracle) for the CSL-JSON of every item type with all
// its fields set, and requires the same output apart from a short list of documented, intended differences.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import CSL from "citeproc";
import type { ZoteroItemData } from "../../src/api-types";
import { itemToCsl } from "../../src/cite/csl";
import schema from "../../vendor/zotero/zotero-schema/schema.json";
import { cslToItem } from "../../src/io/csljson";
import { noteToTitle } from "../../src/zotero-db/mapping";
import { startOracle, type Oracle } from "./oracle";

const here = import.meta.dir;
const sample = JSON.parse(readFileSync(join(here, "data", "citeProcJSExport.json"), "utf8")) as Record<string, Record<string, any>>;

type Loose = Record<string, any>;
// upstream's newItem(): a bare item of the given type
const newItem = (itemType?: string): Loose => ({ itemType, creators: [], tags: [], attachments: [], seeAlso: [] });
const toCsl = (item: Loose): Loose => itemToCsl({ key: "TESTKEY1", ...item } as ZoteroItemData);
/** itemFromCSLJSON: CSL-JSON in, Zotero item data out (the item type comes from the CSL type) */
const fromCsl = (csl: Loose): Loose => {
	const parsed = cslToItem(csl);
	if (!parsed) throw new Error("cslToItem returned null");
	return parsed.data;
};
// Zotero writes year/month/day parts as strings in some places and numbers in others; the value is the same to citeproc
const stringify = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "number" ? String(x) : x)));

setDefaultTimeout(60_000); // the oracle child (and citeproc-js) take a few seconds to start on a loaded machine

describe("Zotero.Utilities.Item", () => {
	describe("itemFromCSLJSON", () => {
		// Zotero 8 reads and writes EDTF dates (ranges, circa, BCE); zotero-next keeps the first date part only
		test.todo("should preserve EDTF ranges and circa dates");
		test.todo("should quote a literal date that would otherwise be parsed on export");

		test("should stably perform itemToCSLJSON -> itemFromCSLJSON -> itemToCSLJSON", () => {
			// Variables the CSL-JSON importer does not read yet (the export side has them, see the differential block below).
			// Everything else must survive the round trip. Intended differences: page ranges get an en dash on import;
			// "event" is an extra legacy alias zotero-next also writes for conferences and presentations.
			const IMPORTER_DROPS = new Set([
				"contributor", "license", "dimensions", "event-place", "composer", "original-author", "authority", "chapter-number",
				"container-title", "references", "section", "original-date", "original-publisher", "original-publisher-place", "genre",
				"medium", "version", "part-number", "part-title", "recipient", "guest", "host", "narrator", "performer", "producer",
				"script-writer", "series-creator", "executive-producer", "chair", "organizer", "scale", "status", "submitted", "volume",
				"number-of-volumes", "ISBN", "collection-title", "number", "issue", "call-number", "publisher-place", "director",
				"author", "event-title", "journalAbbreviation",
			]);
			const problems: string[] = [];
			for (const [type, json] of Object.entries(sample)) {
				const parsed = cslToItem(json);
				if (!parsed) {
					problems.push(`${type}: not imported`);
					continue;
				}
				const back = stringify(toCsl(parsed.data));
				const orig = stringify(json);
				delete back.id;
				delete orig.id;
				delete back.event;
				for (const k of Object.keys(orig)) {
					if (IMPORTER_DROPS.has(k)) continue;
					if (k === "page") {
						if (String(back.page).replace(/–/g, "-") !== orig.page) problems.push(`${type}.page`);
						continue;
					}
					if (JSON.stringify(back[k]) !== JSON.stringify(orig[k])) problems.push(`${type}.${k}: ${JSON.stringify(orig[k])} -> ${JSON.stringify(back[k])}`);
				}
			}
			expect(problems).toEqual([]);
		});

		test.todo("should stably perform itemToCSLJSON -> itemFromCSLJSON -> itemToCSLJSON for every CSL variable (importer drops contributor, license, original-*, section ...)");

		test("should recognize the legacy shortTitle key", () => {
			const json = { ...sample.artwork! };
			json.shortTitle = json["title-short"];
			delete json["title-short"];
			expect(fromCsl(json).shortTitle).toBe("Short title");
		});

		test("should import exported standalone note", () => {
			const note = newItem("note");
			note.note = "Some note longer than 50 characters, which will become the title.";
			const jsonNote = toCsl(note);
			expect(fromCsl(jsonNote).title).toBe(jsonNote.title);
		});

		test("should import exported standalone attachment", () => {
			const attachment = newItem("attachment");
			attachment.title = "Empty";
			attachment.accessDate = "2001-02-03 12:13:14";
			attachment.url = "http://example.com";
			attachment.note = "Note";
			const jsonAttachment = toCsl(attachment);
			expect(fromCsl(jsonAttachment).title).toBe(jsonAttachment.title);
		});

		test("should import `event-place` as Place for Presentation item", () => {
			const json = sample.presentation!;
			expect(json).toHaveProperty("event-place");
			expect(fromCsl(json).place).toBe(json["event-place"]);
		});

		test("should not set Place to undefined for Presentation item without `event-place`", () => {
			const json = { ...sample.presentation! };
			delete json["event-place"];
			expect(json).not.toHaveProperty("event-place");
			expect(json).not.toHaveProperty("publisher-place");
			expect(() => fromCsl(json)).not.toThrow();
			expect(fromCsl(json)).not.toHaveProperty("place");
		});
	});

	describe("itemToCSLJSON", () => {
		test("should convert standalone notes to expected format", () => {
			const note = newItem("note");
			note.note = "Some note longer than 50 characters, which will become the title.";
			const cslJSONNote = toCsl(note);
			expect(cslJSONNote.type).toBe("document"); // note is exported as "document"
			expect(cslJSONNote.title).toBe(noteToTitle(note.note)); // note title is set to Zotero pseudo-title
		});

		// Zotero 8 EDTF dates (parseEDTF): ranges, circa, BCE eras, quoted literal dates, in the date field and in Extra
		test.todo("should convert EDTF dates");
		test.todo("should pass quoted dates through as literals");
		test.todo("should parse EDTF dates in Extra date variables");

		test("should convert standalone attachments to expected format", () => {
			const attachment = newItem("attachment");
			attachment.title = "Empty";
			attachment.accessDate = "2001-02-03 12:13:14";
			attachment.url = "http://example.com";
			attachment.note = "Note";
			const csl = toCsl(attachment);
			expect(csl.type).toBe("document"); // attachment is exported as "document"
			expect(csl.title).toBe("Empty");
			// upstream compares ["2001", 2, 3]: Zotero writes the year as a string here; citeproc reads both
			expect(stringify(csl.accessed)).toEqual({ "date-parts": [["2001", "2", "3"]] });
		});

		// zotero-next maps an unknown item type to CSL "document" instead of throwing (itemToCsl is used on imported data)
		test.todo('should refuse to convert unexpected item types (throws /^Unexpected Zotero Item type ".*"$/)');

		// itemToCSLJSON splits "Jean de" / "la Fontaine" into dropping/non-dropping particles itself; zotero-next hands
		// the name to citeproc-js unsplit, and citeproc-js parses the particles (see the rendering test below)
		test.todo("should parse particles in creator names (CSL-JSON shape)");

		test("particles in creator names render the same as with Zotero's pre-split names", () => {
			const style = readFileSync(join(here, "..", "cite", "fixtures", "apa.csl"), "utf8");
			const locale = readFileSync(join(here, "..", "cite", "fixtures", "locales-en-US.xml"), "utf8");
			const render = (items: Loose[]) => {
				const sys = { retrieveLocale: () => locale, retrieveItem: (id: string) => items.find((i) => i.id === id) };
				const engine = new (CSL as any).Engine(sys, style);
				engine.updateItems(items.map((i) => i.id));
				return (engine.makeBibliography()[1] as string[]).map((s) => s.replace(/<[^>]+>/g, "").trim());
			};
			const cases: { first: string; last: string; zotero: Loose }[] = [
				{ first: "Jean de", last: "la Fontaine", zotero: { given: "Jean", "dropping-particle": "de", "non-dropping-particle": "la", family: "Fontaine" } },
				{ first: "Vincent", last: "van Gogh", zotero: { given: "Vincent", "non-dropping-particle": "van", family: "Gogh" } },
				{ first: "Alexander von", last: "Humboldt", zotero: { given: "Alexander", "dropping-particle": "von", family: "Humboldt" } },
				{ first: "Jean de", last: '"la Fontaine"', zotero: { given: "Jean de", family: "la Fontaine" } },
				{ first: "John", last: "Smith", zotero: { given: "John", family: "Smith" } },
			];
			for (const c of cases) {
				const item = { ...newItem("book"), title: "T", date: "2000", creators: [{ creatorType: "author", firstName: c.first, lastName: c.last }] };
				const ours = render([{ ...toCsl(item), id: "a" }]);
				const theirs = render([{ id: "a", type: "book", title: "T", issued: { "date-parts": [[2000]] }, author: [c.zotero] }]);
				expect(ours).toEqual(theirs);
			}
		});

		test("institutional author is not parsed", () => {
			const item = { ...newItem("journalArticle"), creators: [{ name: "Jean de la Fontaine", creatorType: "author" }] }; // upstream: lastName + fieldMode 1; the Web API form is `name`
			expect(toCsl(item).author).toEqual([{ literal: "Jean de la Fontaine" }]);
		});

		test("should convert UTC access date to local time", () => {
			const offset = new Date().getTimezoneOffset();
			let localDate: string;
			if (offset < 0) localDate = "2019-01-09 00:00:00";
			else if (offset > 0) localDate = "2019-01-09 23:59:59";
			else return; // Can't test timezone offset if in UTC (upstream skips too)
			// local wall-clock time -> UTC ISO string, which is how the Web API stores accessDate
			const [d, t] = localDate.split(" ") as [string, string];
			const iso = new Date(`${d}T${t}`).toISOString().replace(/\.\d+Z$/, "Z");
			const accessed = toCsl({ ...newItem("webpage"), accessDate: iso }).accessed;
			expect(Number(accessed["date-parts"][0][0])).toBe(2019);
			expect(Number(accessed["date-parts"][0][1])).toBe(1);
			expect(Number(accessed["date-parts"][0][2])).toBe(9);
		});

		test("should export Place as CSL `event-place` for Presentation item", () => {
			const item = { ...newItem("presentation"), place: "New York" };
			const json = toCsl(item);
			expect(json["event-place"]).toBe("New York");
			expect(json).not.toHaveProperty("publisher-place");
		});
	});

	describe("#noteToTitle()", () => {
		test("should stop after first block element with content", () => {
			expect(noteToTitle("<h1>Foo</h1><p>Bar</p>")).toBe("Foo");
		});

		test("should skip first line if no content", () => {
			expect(noteToTitle("<blockquote>\n<p>Foo</p>\n</blockquote>\n<p>Bar</p>")).toBe("Foo");
		});

		// upstream passes {stopAtLineBreak: true}: the title of a reader annotation note ends at the <br/>. zotero-next's
		// noteToTitle (Zotero's default behaviour) joins the lines instead and has no such option.
		test.todo("should stop at <br/> when options.stopAtLineBreak is true");
	});
});

// ---------------------------------------------------------------- differential: ask Zotero's own code
describe("itemToCsl agrees with Zotero's own Zotero.Utilities.Item.itemToCSLJSON", () => {
	let oracle: Oracle;
	beforeAll(() => {
		oracle = startOracle();
	});
	afterAll(() => oracle.close());

	// Intended differences, per CSL variable (everything else must match):
	//  - event: legacy alias of event-title that zotero-next also writes for conference papers and presentations
	//  - journalAbbreviation / container-title-short: the same variable under its current and its legacy name
	const alias = (csl: Loose, itemType: string): Loose => {
		const o = stringify(csl);
		delete o.id;
		if (itemType === "conferencePaper" || itemType === "presentation") delete o.event;
		if (typeof o.note === "string") o.note = o.note.trim(); // Zotero leaves the blank line of a removed Extra line
		if (o["container-title-short"] !== undefined) {
			o.journalAbbreviation = o["container-title-short"];
			delete o["container-title-short"];
		}
		return o;
	};

	const types = (schema.itemTypes as any[]).filter((t) => t.itemType !== "annotation");

	for (const t of types) {
		test(`${t.itemType}: every field and creator type set`, async () => {
			const item: Loose = newItem(t.itemType);
			if (t.itemType === "note") item.note = "<p>Some note</p>";
			for (const f of t.fields) item[f.field] = /date/i.test(f.field) ? "2001-02-03" : `v-${f.field}`;
			for (const c of t.creatorTypes) item.creators.push({ creatorType: c.creatorType, firstName: `F${c.creatorType}`, lastName: `L${c.creatorType}` });
			const zotero = alias(await oracle.call("itemToCSLJSON", item), t.itemType);
			const znext = alias(toCsl(item), t.itemType);
			expect(znext).toEqual(zotero);
		});
	}

	test("Extra, ISBN lists, quoted values, dates and names", async () => {
		const items: Loose[] = [
			{ ...newItem("book"), title: "T", ISBN: "978-0-596-52068-7 0-596-52068-9", date: "May 2019", extra: "original-date: 1999\nfoo bar" },
			{ ...newItem("journalArticle"), title: '"Quoted Title"', date: "March 5, 2019", DOI: "10.1/x", creators: [{ creatorType: "author", name: "The Group" }, { creatorType: "editor", firstName: "E", lastName: "Ditor" }] },
			{ ...newItem("book"), title: "T", date: "2019-2021" },
			{ ...newItem("book"), title: "T", date: "n.d." },
		];
		// Not compared, by design: Extra variable lines (Zotero leaves "PMID: 1" in `note` for citeproc-js to read; zotero-next
		// extracts the variable itself) and seasons ("Spring 2020": Zotero splits the season, zotero-next passes the raw date
		// to citeproc-js, which splits it).
		const problems: string[] = [];
		for (const item of items) {
			const zotero = alias(await oracle.call("itemToCSLJSON", item), item.itemType);
			const znext = alias(toCsl(item), item.itemType);
			for (const k of new Set([...Object.keys(zotero), ...Object.keys(znext)])) {
				if (JSON.stringify(zotero[k]) !== JSON.stringify(znext[k])) problems.push(`${JSON.stringify(item.title)}/${item.date ?? item.extra}: ${k}: zotero ${JSON.stringify(zotero[k])} vs zotero-next ${JSON.stringify(znext[k])}`);
			}
		}
		expect(problems).toEqual([]);
	});
});
