// Fuzz: the bibliography importers (RIS, BibTeX, CSL JSON, EndNote XML, Zotero RDF, MODS, PubMed nbib), the format
// auto-detection and the importText path into a database.
//
// Properties: no importer throws (they report problems in `errors`); no case hangs; every item an importer returns is
// valid Zotero item JSON for the schema; the DB stays consistent; export -> import keeps the core fields.
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Creator, ZoteroItemData } from "../../src/api-types";
import { hooks } from "../../src/additems/files";
import { createItem, openDb } from "../../src/db";
import { HttpError } from "../../src/db";
import { exportBibtex, parseBibtex, parseBibRecords, type ExportItem } from "../../src/io/bibtex";
import { exportCslJson, parseCslJson } from "../../src/io/csljson";
import { exportCsv } from "../../src/io/csv";
import { parseEndnoteXml } from "../../src/io/endnote";
import { detectFormat, importText, IMPORT_FORMATS, type ImportFormat } from "../../src/io/import";
import { exportMods, parseMods } from "../../src/io/mods";
import { parseNbib } from "../../src/io/pubmed";
import { exportZoteroRdf, parseZoteroRdf } from "../../src/io/rdf";
import { exportRis, parseRis } from "../../src/io/ris";
import type { ParsedItem } from "../../src/io/common";
import { fieldLookup, getSchema } from "../../src/schema-data";
import { tempDir } from "../fixture";
import { describeError, fc, fuzz, messyText, mutated } from "./harness";

// ---------------------------------------------------------------- valid items (generators)

const text = (re: RegExp, _min = 1, _max = 24) => fc.stringMatching(re); // the lengths are carried by the patterns
const word = text(/^[A-Za-z]{2,8}( [A-Za-z]{2,8}){0,2}$/); // single spaces: the XML formats collapse runs of whitespace
// characters the exporters must escape or encode
const tricky = fc.constantFrom("R&D", "50% of {x}", "Müller_test #1", "café ß ø", "$5 effects", "tilde~here", "caret^up", "Zoë Łódź");
const titleArb = fc.oneof(
	word,
	fc.tuple(word, tricky, word).map((a) => a.join(" ")),
);
const creatorArb: fc.Arbitrary<Creator> = fc.oneof(
	fc.record({
		creatorType: fc.constant("author"),
		firstName: text(/^[A-Z][a-z]{1,9}$/, 2, 10),
		lastName: text(/^[A-Z][a-z]{2,11}$/, 3, 12),
	}),
	fc.record({ creatorType: fc.constant("author"), name: text(/^[A-Z][a-z]{2,9} [A-Z][a-z]{2,9}$/, 6, 20) }),
);
const dateArb = fc.oneof(
	fc.integer({ min: 1800, max: 2030 }).map(String),
	fc.tuple(fc.integer({ min: 1800, max: 2030 }), fc.integer({ min: 1, max: 12 })).map(([y, m]) => `${y}-${String(m).padStart(2, "0")}`),
	fc
		.tuple(fc.integer({ min: 1800, max: 2030 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }))
		.map(([y, m, d]) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`),
);

const itemDataArb: fc.Arbitrary<ZoteroItemData> = fc
	.record({
		kind: fc.constantFrom("journalArticle", "book", "bookSection", "conferencePaper", "thesis", "webpage"),
		title: titleArb,
		creators: fc.array(creatorArb, { minLength: 1, maxLength: 4 }),
		date: dateArb,
		container: word,
		volume: fc.integer({ min: 1, max: 999 }).map(String),
		pages: fc.tuple(fc.integer({ min: 1, max: 900 }), fc.integer({ min: 1, max: 99 })).map(([a, n]) => `${a}–${a + n}`),
		doi: fc.tuple(fc.integer({ min: 1000, max: 9999 }), fc.stringMatching(/^[a-z0-9]{4,10}$/)).map(([a, b]) => `10.${a}/${b}`),
		tags: fc.uniqueArray(text(/^[a-z]{3,10}$/, 3, 10), { maxLength: 3 }),
		abstract: fc.option(fc.oneof(word, tricky), { nil: undefined }),
	})
	.map((r) => {
		const d: Record<string, unknown> = {
			key: "ABCD2345",
			itemType: r.kind,
			title: r.title,
			creators: r.creators,
			date: r.date,
			tags: r.tags.map((tag) => ({ tag })),
		};
		if (r.abstract) d.abstractNote = r.abstract;
		switch (r.kind) {
			case "journalArticle":
				Object.assign(d, { publicationTitle: r.container, volume: r.volume, pages: r.pages, DOI: r.doi });
				break;
			case "book":
				Object.assign(d, { publisher: r.container, place: "London" });
				break;
			case "bookSection":
				Object.assign(d, { bookTitle: r.container, publisher: "Elsevier", pages: r.pages });
				break;
			case "conferencePaper":
				Object.assign(d, { proceedingsTitle: r.container, pages: r.pages });
				break;
			case "thesis":
				Object.assign(d, { university: r.container, thesisType: "PhD thesis" });
				break;
			case "webpage":
				Object.assign(d, { websiteTitle: r.container, url: "https://example.org/x" });
				break;
		}
		return d as ZoteroItemData;
	});

const asExport = (d: ZoteroItemData): ExportItem => ({ data: d, tags: (d.tags ?? []).map((t) => t.tag), notes: [] });

// ---------------------------------------------------------------- seeds

const SEED_ITEMS: ZoteroItemData[] = [
	{
		key: "AAAAAAA1",
		itemType: "journalArticle",
		title: "Outcomes after liver transplantation: a cohort study",
		date: "2023-11-02",
		creators: [
			{ creatorType: "author", firstName: "Jane", lastName: "Smith" },
			{ creatorType: "author", firstName: "José", lastName: "Müller-García" },
			{ creatorType: "editor", firstName: "Dev", lastName: "Patel" },
		],
		publicationTitle: "The Lancet",
		volume: "383",
		issue: "9",
		pages: "100–110",
		DOI: "10.1016/s0140-6736(23)00001-1",
		url: "https://example.org/a",
		abstractNote: "We studied 100% of patients & found $5 effects.",
		ISSN: "0140-6736",
		tags: [{ tag: "transplant" }, { tag: "liver" }],
	},
	{
		key: "BBBBBBB2",
		itemType: "book",
		title: "Surgical Anatomy",
		date: "2018",
		creators: [{ creatorType: "author", name: "NHS Blood and Transplant" }],
		publisher: "Oxford University Press",
		place: "Oxford",
		ISBN: "9780198000000",
		tags: [],
	},
	{
		key: "CCCCCCC3",
		itemType: "thesis",
		title: "Machine learning in transplant allocation",
		date: "2024-09",
		creators: [{ creatorType: "author", firstName: "Aditya", lastName: "Borakati" }],
		thesisType: "PhD thesis",
		university: "King's College London",
		tags: [],
	},
	{
		key: "DDDDDDD4",
		itemType: "bookSection",
		title: "The spleen",
		date: "2020-05",
		creators: [{ creatorType: "author", firstName: "Ann", lastName: "Lee" }],
		bookTitle: "Textbook of Surgery",
		publisher: "Elsevier",
		pages: "45–67",
		tags: [],
	},
];

const SEEDS: Record<ImportFormat, string> = {
	bibtex: exportBibtex(SEED_ITEMS.map(asExport), "bibtex"),
	ris: exportRis(SEED_ITEMS.map(asExport)),
	csljson: exportCslJson(SEED_ITEMS.map(asExport)),
	rdf: exportZoteroRdf(SEED_ITEMS.map(asExport)),
	mods: exportMods(SEED_ITEMS.map(asExport)),
	"endnote-xml": `<?xml version="1.0" encoding="UTF-8"?><xml><records>
<record><ref-type name="Journal Article">17</ref-type><contributors><authors><author><style face="normal">Smith, Jane</style></author><author>Doe, J.</author></authors></contributors>
<titles><title>A study of things &amp; stuff</title><secondary-title>J Things</secondary-title></titles><periodical><full-title>Journal of Things</full-title></periodical>
<pages>10-20</pages><volume>3</volume><number>2</number><dates><year>2020</year><pub-dates><date>Mar</date></pub-dates></dates>
<keywords><keyword>stuff</keyword><keyword>things</keyword></keywords><electronic-resource-num>10.1000/abc</electronic-resource-num>
<abstract>Abstract text.</abstract><urls><related-urls><url>https://example.org/z</url></related-urls></urls></record>
<record><ref-type name="Book">6</ref-type><titles><title>A Book</title></titles><publisher>Pub</publisher><dates><year>1999</year></dates></record></records></xml>`,
	"pubmed-nbib": `PMID- 12345678
OWN - NLM
STAT- MEDLINE
DP  - 2020 Mar 15
TI  - Liver transplantation outcomes: a cohort study of
      many hundred patients.
AB  - BACKGROUND: Something.
      RESULTS: Something else.
FAU - Smith, Jane A
AU  - Smith JA
FAU - Doe, John
AU  - Doe J
JT  - The Lancet
TA  - Lancet
VI  - 383
IP  - 9
PG  - 100-10
LID - 10.1016/s0140-6736(23)00001-1 [doi]
MH  - Humans
OT  - transplant
PT  - Journal Article

PMID- 87654321
TI  - A second record
DP  - 2019
FAU - Roe, Richard
JT  - Journal of Records
`,
};
const CSV_SEED = exportCsv(SEED_ITEMS.map(asExport));

// ---------------------------------------------------------------- item validity

const FREE_KEYS = new Set([
	"itemType",
	"creators",
	"tags",
	"collections",
	"relations",
	"extra",
	"note",
	"dateAdded",
	"dateModified",
	"accessDate",
	"key",
	"parentItem",
]);

/** The reasons a parsed item is not valid Zotero item JSON for the schema (empty = valid). */
export function itemProblems(it: ParsedItem): string[] {
	const out: string[] = [];
	const d = it.data as Record<string, unknown>;
	if (!d || typeof d !== "object") return ["data is not an object"];
	const type = getSchema().itemTypes.find((t) => t.itemType === d.itemType);
	if (!type) return [`unknown itemType ${JSON.stringify(d.itemType)}`];
	const fields = new Set(type.fields.map((f) => f.field));
	const lookup = fieldLookup();
	for (const [k, v] of Object.entries(d)) {
		if (v === undefined) continue;
		if (k === "creators") {
			if (!Array.isArray(v)) out.push("creators not an array");
			else {
				const types = new Set(type.creatorTypes.map((c) => c.creatorType));
				v.forEach((c: Creator, i) => {
					if (!c || typeof c !== "object") return void out.push(`creator ${i} not an object`);
					if (!types.has(c.creatorType))
						out.push(`creator ${i} type ${JSON.stringify(c.creatorType)} not valid for ${type.itemType}`);
					const single = typeof c.name === "string" && c.name.trim() !== "";
					const dual = typeof c.lastName === "string" || typeof c.firstName === "string";
					if (single === dual) out.push(`creator ${i} must be either name or first/last: ${JSON.stringify(c)}`);
					if (dual && !String(c.lastName ?? "").trim() && !String(c.firstName ?? "").trim()) out.push(`creator ${i} empty`);
					for (const f of ["name", "firstName", "lastName"] as const)
						if (c[f] !== undefined && typeof c[f] !== "string") out.push(`creator ${i}.${f} not a string`);
				});
			}
		} else if (k === "tags") {
			if (!Array.isArray(v)) out.push("tags not an array");
			else
				v.forEach((t, i) => {
					if (!t || typeof t.tag !== "string" || !t.tag.trim()) out.push(`tag ${i} invalid: ${JSON.stringify(t)}`);
				});
		} else if (k === "collections") {
			if (!Array.isArray(v) || v.some((c) => typeof c !== "string")) out.push("collections invalid");
		} else if (k === "relations") {
			if (typeof v !== "object" || v === null) out.push("relations invalid");
		} else if (typeof v !== "string") out.push(`${k} is ${typeof v}, expected string`);
		else if (!FREE_KEYS.has(k) && !fields.has(k) && !lookup.has(k.toLowerCase())) out.push(`unknown field ${k}`);
		else if (!FREE_KEYS.has(k) && !fields.has(k)) out.push(`field ${k} does not belong to ${type.itemType}`);
	}
	if (!Array.isArray(it.notes) || it.notes.some((n) => typeof n !== "string")) out.push("notes invalid");
	for (const a of it.attachments ?? []) {
		if (!a || typeof a !== "object") out.push("attachment invalid");
		else
			for (const f of ["title", "path", "url", "contentType"] as const)
				if (a[f] !== undefined && typeof a[f] !== "string") out.push(`attachment.${f} not a string`);
	}
	for (const c of it.collections ?? [])
		if (!Array.isArray(c) || c.some((s) => typeof s !== "string")) out.push("collection path invalid");
	try {
		const s = JSON.stringify(it.data);
		if (typeof s !== "string") out.push("data not JSON serialisable");
	} catch (e) {
		out.push(`data not JSON serialisable: ${describeError(e)}`);
	}
	return out;
}

type Parser = (t: string) => { items: ParsedItem[]; errors: string[] };
const PARSERS: Record<ImportFormat, Parser> = {
	bibtex: parseBibtex,
	ris: parseRis,
	csljson: parseCslJson,
	"endnote-xml": parseEndnoteXml,
	rdf: parseZoteroRdf,
	mods: parseMods,
	"pubmed-nbib": parseNbib,
};

function checkParse(format: ImportFormat, input: string): void {
	let r: ReturnType<Parser>;
	try {
		r = PARSERS[format](input);
	} catch (e) {
		throw new Error(`${format} importer threw ${describeError(e)}`, { cause: e });
	}
	if (!Array.isArray(r.items) || !Array.isArray(r.errors) || r.errors.some((e) => typeof e !== "string"))
		throw new Error(`${format}: bad result shape`);
	r.items.forEach((it, i) => {
		const p = itemProblems(it);
		if (p.length)
			throw new Error(`${format} item ${i} is not valid Zotero JSON: ${p.join("; ")}\n${JSON.stringify(it.data).slice(0, 400)}`);
	});
}

// ---------------------------------------------------------------- DB

const dbs: Database[] = [];
let db: Database;
const saved = hooks.afterImport;
beforeAll(() => {
	hooks.afterImport = () => {};
	db = openDb(join(tempDir(), "lib.sqlite"));
	dbs.push(db);
});
afterAll(() => {
	hooks.afterImport = saved;
	for (const d of dbs) d.close(true);
});

function expectDbHealthy(d: Database) {
	expect((d.query("PRAGMA integrity_check").all() as { integrity_check: string }[]).map((r) => r.integrity_check)).toEqual(["ok"]);
	expect(d.query("PRAGMA foreign_key_check").all()).toEqual([]);
}

// ---------------------------------------------------------------- properties

for (const format of IMPORT_FORMATS) {
	describe(`importer ${format}`, () => {
		fuzz(`${format}: random text never throws and yields valid items`, [messyText(600)], (s) => checkParse(format, s));
		fuzz(
			`${format}: mutated valid document never throws and yields valid items`,
			[mutated(SEEDS[format])],
			(s) => checkParse(format, s),
			{ normal: 300 },
		);
	});
}

describe("importers on a mutated document of another format", () => {
	const all = IMPORT_FORMATS.map((f) => SEEDS[f]);
	fuzz(
		"each importer survives every other format's text",
		[fc.constantFrom(...all).chain((s) => mutated(s, 3))],
		(s) => {
			for (const f of IMPORT_FORMATS) checkParse(f, s);
		},
		{ normal: 100 },
	);
});

describe("pathological sizes", () => {
	fuzz(
		"deeply nested / long XML stays fast",
		[fc.constantFrom("<a>", "<rdf:RDF><b>", "<mods>", "<record>"), fc.integer({ min: 100, max: 4000 })],
		(open, n) => {
			const doc = `${open.repeat(n)}text`;
			for (const f of ["endnote-xml", "rdf", "mods"] as ImportFormat[]) checkParse(f, doc);
		},
		{ normal: 20, timeBoxMs: 4000 },
	);
	fuzz(
		"long lines of delimiters stay fast",
		[
			fc.constantFrom("{", "}", '"', "@article{", "ER  - \n", "TY  - JOUR\n", "\\", "$", "[", "<![CDATA[", "&amp;"),
			fc.integer({ min: 500, max: 8000 }),
		],
		(tok, n) => {
			const doc = tok.repeat(n);
			for (const f of IMPORT_FORMATS) checkParse(f, doc);
		},
		{ normal: 20, timeBoxMs: 4000 },
	);
});

describe("format detection", () => {
	fuzz(
		"detectFormat never throws and returns a known format or null",
		[fc.oneof(messyText(500), mutated(fc.constantFrom(...Object.values(SEEDS), CSV_SEED)))],
		(s) => {
			const f = detectFormat(s);
			if (f !== null) expect(IMPORT_FORMATS).toContain(f);
		},
	);
	fuzz(
		"detectFormat finds the format of every clean seed",
		[fc.constantFrom(...IMPORT_FORMATS)],
		(f) => {
			expect(detectFormat(SEEDS[f])).toBe(f);
		},
		{ normal: 14 },
	);
});

describe("importText into a database", () => {
	fuzz(
		"only an HttpError escapes, and the database stays consistent",
		[
			fc.oneof(messyText(500), mutated(fc.constantFrom(...Object.values(SEEDS)))),
			fc.constantFrom<ImportFormat | "auto">("auto", ...IMPORT_FORMATS),
		],
		(s, format) => {
			try {
				importText(db, { text: s, format, collectionName: null });
			} catch (e) {
				if (!(e instanceof HttpError)) throw new Error(`importText threw ${describeError(e)}`, { cause: e });
			}
		},
		{ normal: 150 },
	);
	fuzz("database passes integrity_check and foreign_key_check after the fuzzing", [fc.constant(0)], (_n: number) => expectDbHealthy(db), {
		normal: 1,
	});
});

describe("export then import round trip", () => {
	const ROUND: { name: string; make: (items: ZoteroItemData[]) => string; format: ImportFormat; day: boolean }[] = [
		{ name: "bibtex", make: (i) => exportBibtex(i.map(asExport), "bibtex"), format: "bibtex", day: false },
		{ name: "biblatex", make: (i) => exportBibtex(i.map(asExport), "biblatex"), format: "bibtex", day: true },
		{ name: "ris", make: (i) => exportRis(i.map(asExport)), format: "ris", day: true },
		{ name: "csljson", make: (i) => exportCslJson(i.map(asExport)), format: "csljson", day: true },
		{ name: "mods", make: (i) => exportMods(i.map(asExport)), format: "mods", day: true },
		{ name: "rdf", make: (i) => exportZoteroRdf(i.map(asExport)), format: "rdf", day: true },
	];
	for (const r of ROUND) {
		fuzz(
			`${r.name}: generated items keep their core fields`,
			[fc.array(itemDataArb, { minLength: 1, maxLength: 3 })],
			(items) => {
				// the exporters want distinct keys
				items.forEach((d, i) => (d.key = `KEY${String(i).padStart(5, "0")}`));
				const out = PARSERS[r.format](r.make(items));
				expect(out.errors).toEqual([]);
				expect(out.items.length).toBe(items.length);
				items.forEach((d, i) => {
					const got = out.items[i]!.data as Record<string, any>;
					expect(got.itemType).toBe(d.itemType);
					expect(got.title).toBe(d.title);
					const names = (cs?: Creator[]) => (cs ?? []).map((c) => (c.name ?? `${c.lastName}, ${c.firstName}`).trim());
					expect(names(got.creators)).toEqual(names(d.creators));
					expect(String(got.date)).toBe(r.day ? String(d.date) : String(d.date).slice(0, 7));
					for (const f of [
						"publicationTitle",
						"bookTitle",
						"proceedingsTitle",
						"websiteTitle",
						"volume",
						"pages",
						"publisher",
						"university",
						"DOI",
						"url",
					]) {
						if ((d as any)[f] !== undefined) expect(got[f]).toBe((d as any)[f]);
					}
					if (d.abstractNote) expect(got.abstractNote).toBe(d.abstractNote);
					expect((got.tags ?? []).map((t: { tag: string }) => t.tag).sort()).toEqual((d.tags ?? []).map((t) => t.tag).sort());
				});
			},
			{ normal: 100 },
		);
	}
	fuzz(
		"importText of an exported document creates every item and reports no error",
		[fc.constantFrom(...ROUND), fc.array(itemDataArb, { minLength: 1, maxLength: 3 })],
		(r, items) => {
			items.forEach((d, i) => {
				d.key = `KEY${String(i).padStart(5, "0")}`;
				delete (d as any).DOI; // existing DOIs are skipped as duplicates
			});
			const res = importText(db, { text: r.make(items), format: "auto", collectionName: null });
			expect(res.errors).toEqual([]);
			expect(res.created).toBe(items.length);
		},
		{ normal: 60 },
	);
});

describe("item data from createItem on parsed output", () => {
	fuzz(
		"every parsed item can be stored",
		[fc.constantFrom(...IMPORT_FORMATS).chain((f) => mutated(SEEDS[f]).map((s) => [f, s] as const))],
		([f, s]) => {
			for (const it of PARSERS[f](s).items) createItem(db, { ...it.data });
		},
		{ normal: 150 },
	);
	fuzz("BibTeX record parser handles arbitrary text", [messyText(500)], (s) => {
		parseBibRecords(s);
	});
});

describe("seeds and regressions found by the fuzzer", () => {
	for (const f of IMPORT_FORMATS) {
		test(`clean ${f} seed parses to valid items`, () => {
			const r = PARSERS[f](SEEDS[f]);
			expect(r.items.length).toBeGreaterThan(0);
			for (const it of r.items) expect(itemProblems(it)).toEqual([]);
		});
	}
	test("a literal ~ survives BibTeX (it is not a non-breaking space)", () => {
		const d: ZoteroItemData = {
			key: "AAAAAAA1",
			itemType: "journalArticle",
			title: "tilde~here",
			abstractNote: "tilde~here",
			date: "2020",
			tags: [],
		};
		const out = parseBibtex(exportBibtex([asExport(d)], "bibtex")).items[0]!.data;
		expect(out.title).toBe("tilde~here");
		expect(out.abstractNote).toBe("tilde~here");
	});
	test("Zotero RDF keeps the URL of every item, also when two items share one URL", () => {
		const mk = (key: string, title: string): ZoteroItemData => ({
			key,
			itemType: "webpage",
			title,
			websiteTitle: "w",
			url: "https://example.org/x",
			date: "2020",
			tags: [],
		});
		const items = parseZoteroRdf(exportZoteroRdf([asExport(mk("AAAAAAA1", "one")), asExport(mk("BBBBBBB2", "two"))])).items;
		expect(items.map((i) => i.data.url)).toEqual(["https://example.org/x", "https://example.org/x"]);
	});
});
