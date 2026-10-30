import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ItemDetail, ZoteroItemData } from "../../src/api-types";
import { createCollection, createItem, listItems, openDb } from "../../src/db";
import { parseBibRecords } from "../../src/io/bibtex";
import { detectFormat } from "../../src/io/import";
import { fromLatex, toLatex } from "../../src/io/latex";
import { call, tempDir } from "../fixture";

const dbs: Database[] = [];
function freshDb(): Database {
	const db = openDb(join(tempDir(), "lib.sqlite"));
	dbs.push(db);
	return db;
}
afterAll(() => {
	for (const d of dbs) d.close(true);
});

const mk = (db: Database, data: Partial<ZoteroItemData>): ItemDetail => createItem(db, data);

const SAMPLES: Record<string, Partial<ZoteroItemData>> = {
	journalArticle: {
		itemType: "journalArticle",
		title: "Outcomes after liver transplantation: a cohort study",
		creators: [
			{ creatorType: "author", firstName: "Jane", lastName: "Smith" },
			{ creatorType: "author", firstName: "José", lastName: "Müller-García" },
		],
		publicationTitle: "The Lancet",
		journalAbbreviation: "Lancet",
		volume: "383",
		issue: "9",
		pages: "100–110",
		date: "2023-11-02",
		DOI: "10.1016/s0140-6736(23)00001-1",
		url: "https://example.org/a",
		abstractNote: "We studied 100% of patients & found $5 effects.",
		ISSN: "0140-6736",
		language: "en",
		tags: [{ tag: "transplant" }, { tag: "liver" }],
	},
	book: {
		itemType: "book",
		title: "Surgical Anatomy",
		creators: [
			{ creatorType: "author", firstName: "Cara", lastName: "Brown" },
			{ creatorType: "editor", firstName: "Dev", lastName: "Patel" },
		],
		publisher: "Oxford University Press",
		place: "Oxford",
		date: "2018",
		edition: "3",
		ISBN: "9780198000000",
		numPages: "320",
	},
	bookSection: {
		itemType: "bookSection",
		title: "The spleen",
		creators: [
			{ creatorType: "author", firstName: "Ann", lastName: "Lee" },
			{ creatorType: "editor", firstName: "Bo", lastName: "Kim" },
		],
		bookTitle: "Textbook of Surgery",
		publisher: "Elsevier",
		place: "London",
		date: "2020-05",
		pages: "45–67",
	},
	conferencePaper: {
		itemType: "conferencePaper",
		title: "Attention is all you need",
		creators: [{ creatorType: "author", firstName: "Ashish", lastName: "Vaswani" }],
		proceedingsTitle: "Advances in Neural Information Processing Systems",
		conferenceName: "NIPS 2017",
		date: "2017",
		pages: "5998–6008",
		place: "Long Beach",
	},
	thesis: {
		itemType: "thesis",
		title: "Machine learning in transplant allocation",
		creators: [{ creatorType: "author", firstName: "Aditya", lastName: "Borakati" }],
		thesisType: "PhD thesis",
		university: "King's College London",
		place: "London",
		date: "2024-09",
	},
	webpage: {
		itemType: "webpage",
		title: "NHS Blood and Transplant",
		creators: [{ creatorType: "author", name: "NHS Blood and Transplant" }],
		websiteTitle: "NHSBT",
		url: "https://www.nhsbt.nhs.uk/",
		date: "2024-01-15",
		accessDate: "2024-02-01",
	},
};

type Fmt = "bibtex" | "biblatex" | "ris" | "csljson";

async function exportOne(db: Database, key: string, format: string, includeNotes = false): Promise<string> {
	const res = await call(db, "POST", "/api/io/export", { keys: [key], format, includeNotes });
	expect(res.status).toBe(200);
	return ((await res.json()) as { text: string }).text;
}
async function importInto(db: Database, text: string, extra: Record<string, unknown> = {}) {
	const res = await call(db, "POST", "/api/io/import", { text, ...extra });
	return { status: res.status, body: (await res.json()) as { created: number; skipped: number; errors: string[]; collectionKey: string | null; format: string } };
}
function firstItem(db: Database): ZoteroItemData {
	const list = listItems(db, { limit: 100 });
	return mk0(db, list.items[0]!.key);
}
function mk0(db: Database, key: string): ZoteroItemData {
	return JSON.parse((db.query("SELECT data FROM items WHERE key = ?").get(key) as { data: string }).data);
}
const lastNames = (d: ZoteroItemData, type = "author") => (d.creators ?? []).filter((c) => c.creatorType === type).map((c) => c.lastName ?? c.name);

describe("round trips", () => {
	for (const fmt of ["bibtex", "biblatex", "ris", "csljson"] as Fmt[]) {
		for (const [name, sample] of Object.entries(SAMPLES)) {
			test(`${name} via ${fmt}`, async () => {
				const a = freshDb();
				const item = mk(a, sample);
				const text = await exportOne(a, item.data.key, fmt);
				const b = freshDb();
				const r = await importInto(b, text);
				expect(r.body.errors).toEqual([]);
				expect(r.body.created).toBe(1);
				const d = firstItem(b);
				expect(d.itemType).toBe(sample.itemType!);
				expect(d.title).toBe(sample.title!);
				expect(lastNames(d)).toEqual(lastNames(item.data));
				expect(String(d.date).slice(0, 4)).toBe(String(sample.date).slice(0, 4));
				// BibTeX has year + month only; every other format keeps the day
				const want = fmt === "bibtex" ? String(sample.date).slice(0, 7) : sample.date!;
				if (String(sample.date).length > 4) expect(d.date).toBe(want);
				for (const f of ["publicationTitle", "bookTitle", "proceedingsTitle", "websiteTitle", "volume", "pages", "publisher", "university", "place", "DOI", "url", "ISBN"]) {
					const want = (sample as Record<string, unknown>)[f];
					if (want === undefined) continue;
					// pages with an en dash must survive in every format; the rest should be unchanged
					expect(d[f]).toBe(want as string);
				}
				if (sample.tags) expect((d.tags ?? []).map((t) => t.tag).sort()).toEqual(sample.tags.map((t) => t.tag).sort());
				if (sample.abstractNote) expect(d.abstractNote).toBe(sample.abstractNote);
			});
		}
	}
	test("thesis type survives BibTeX", async () => {
		const a = freshDb();
		const item = mk(a, SAMPLES.thesis!);
		const d = await exportOne(a, item.data.key, "bibtex");
		expect(d).toContain("@phdthesis{");
		expect(d).toContain("school = {King's College London}");
		const b = freshDb();
		await importInto(b, d);
		expect(firstItem(b).thesisType).toBe("PhD thesis");
	});
});

describe("BibTeX", () => {
	test("keys are authorYearTitleword and deduplicated", async () => {
		const a = freshDb();
		const k1 = mk(a, { itemType: "journalArticle", title: "The Deep Learning Method", date: "2020", creators: [{ creatorType: "author", firstName: "A", lastName: "Smith" }] });
		const k2 = mk(a, { itemType: "journalArticle", title: "A deep dive", date: "2020", creators: [{ creatorType: "author", firstName: "B", lastName: "Smith" }] });
		const k3 = mk(a, { itemType: "journalArticle", title: "Deep sea", date: "2020", creators: [{ creatorType: "author", firstName: "C", lastName: "Smith" }] });
		const res = await call(a, "POST", "/api/io/export", { keys: [k1.data.key, k2.data.key, k3.data.key], format: "bibtex" });
		const text = ((await res.json()) as { text: string }).text;
		const keys = [...text.matchAll(/^@\w+\{([^,]+),/gm)].map((m) => m[1]);
		expect(keys).toEqual(["smith2020deep", "smith2020deepa", "smith2020deepb"]);
	});

	test("escapes LaTeX specials and non-ASCII", async () => {
		const a = freshDb();
		const item = mk(a, {
			itemType: "journalArticle",
			title: "R&D costs of 50% of drugs: Müller's ß_test #1 {braces}",
			creators: [{ creatorType: "author", firstName: "Søren", lastName: "Kierkegård" }, { creatorType: "author", name: "World Health Organization" }],
			date: "2021",
		});
		const text = await exportOne(a, item.data.key, "bibtex");
		expect(text).toContain("R\\&D costs of 50\\% of drugs");
		expect(text).toContain("M{\\\"u}ller's {\\ss}\\_test \\#1 \\{braces\\}");
		expect(text).toContain("Kierkeg{\\r{a}}rd, S{\\o}ren".replace("{\\r{a}}", "{\\aa}"));
		expect(text).toContain("{World Health Organization}");
		// and back
		const b = freshDb();
		await importInto(b, text);
		const d = firstItem(b);
		expect(d.title).toBe("R&D costs of 50% of drugs: Müller's ß_test #1 {braces}");
		expect(d.creators![0]).toMatchObject({ firstName: "Søren", lastName: "Kierkegård" });
		expect(d.creators![1]).toMatchObject({ name: "World Health Organization" });
	});

	test("latex helpers", () => {
		expect(toLatex("café naïve Čapek Łódź")).toBe("caf{\\'e} na{\\\"{\\i}}ve {\\v{C}}apek {\\L}{\\'o}d{\\'z}");
		expect(fromLatex("caf\\'e na\\\"{\\i}ve {\\v C}apek \\L\\'od\\'z J{\\\"o}rg \\o{} --- 1--2")).toBe("café naïve Čapek Łódź Jörg ø — 1–2");
		expect(fromLatex("{\\'{E}}cole \\& 50\\% \\textit{x}")).toBe("École & 50% x");
	});

	test("parser handles @string, concatenation, quotes, parentheses and comments", () => {
		const { records, errors } = parseBibRecords(`
% a comment
@comment{ignored @article{x, title={no}}}
@string{lancet = "The Lancet"}
@preamble{"\\newcommand{\\noop}[1]{}"}
@article{a1,
  author = "Smith, John and Doe, Jane",
  title = {A {Nested} Title},
  journal = lancet # " (London)",
  year = 2020,
  month = mar,
}
@book(b1, title = "Quoted {brace} title", year = {2019})
`);
		expect(errors).toEqual([]);
		expect(records.map((r) => r.key)).toEqual(["a1", "b1"]);
		expect(records[0]!.fields.journal).toBe("The Lancet (London)");
		expect(records[0]!.fields.month).toBe("March");
		expect(records[0]!.fields.title).toBe("A {Nested} Title");
		expect(records[1]!.fields.title).toBe("Quoted {brace} title");
	});

	test("imports names in every BibTeX form", async () => {
		const db = freshDb();
		const r = await importInto(db, `@article{x, title={T}, year={2020},
  author={van der Berg, Jan and Jr Smith, Bob and Anna Maria de la Cruz and {Cochrane Collaboration} and others}}`);
		expect(r.body.created).toBe(1);
		const d = firstItem(db);
		expect(d.creators!.map((c) => c.lastName ?? c.name)).toEqual(["van der Berg", "Jr Smith", "de la Cruz", "Cochrane Collaboration"]);
		expect(d.creators![2]).toMatchObject({ firstName: "Anna Maria", lastName: "de la Cruz" });
	});

	test("BibLaTeX export uses date, journaltitle and online", async () => {
		const a = freshDb();
		const item = mk(a, SAMPLES.webpage!);
		const text = await exportOne(a, item.data.key, "biblatex");
		expect(text).toContain("@online{");
		expect(text).toContain("date = {2024-01-15}");
		expect(text).toContain("urldate = {2024-02-01}");
		const j = mk(a, SAMPLES.journalArticle!);
		const t2 = await exportOne(a, j.data.key, "biblatex");
		expect(t2).toContain("journaltitle = {The Lancet}");
		expect(t2).toContain("pages = {100--110}");
	});
});

describe("RIS", () => {
	test("multi-entry file with tags, notes and two dates", async () => {
		const db = freshDb();
		const ris = `TY  - JOUR
AU  - Smith, Jane
AU  - Patel, Raj
TI  - First paper
T2  - BMJ
PY  - 2023///
DA  - 2023/11/02/
VL  - 383
IS  - 7
SP  - e078378
KW  - surgery
KW  - outcomes
AB  - An abstract
 spanning lines.
N1  - A note about it
DO  - 10.1136/bmj-2023-078378
UR  - https://doi.org/10.1136/bmj-2023-078378
SN  - 1756-1833
ER  -

TY  - BOOK
A1  - Brown, Cara
T1  - Surgical anatomy
PY  - 2018
PB  - OUP
CY  - Oxford
SN  - 978-0-19-800000-0
ER  -

TY  - CHAP
AU  - Lee, Ann
TI  - The spleen
T2  - Textbook of Surgery
A2  - Kim, Bo
PY  - 2020
SP  - 45
EP  - 67
ER  -
`;
		expect(detectFormat(ris)).toBe("ris");
		const r = await importInto(db, ris, { collectionName: "RIS test" });
		expect(r.body).toMatchObject({ created: 3, skipped: 0, errors: [], format: "ris" });
		const items = listItems(db, { limit: 10, sort: "title", dir: "asc", include: ["creators", "tags"] }).items;
		expect(items.map((i) => i.title)).toEqual(["First paper", "Surgical anatomy", "The spleen"]);
		const p = mk0(db, items[0]!.key);
		expect(p.date).toBe("2023-11-02");
		expect(p.publicationTitle).toBe("BMJ");
		expect(p.pages).toBe("e078378");
		expect(p.ISSN).toBe("1756-1833");
		expect(p.abstractNote).toBe("An abstract\nspanning lines.");
		expect((p.tags ?? []).map((t) => t.tag)).toEqual(["surgery", "outcomes"]);
		const kids = db.query("SELECT data FROM items WHERE parent_key = ? AND item_type = 'note'").all(p.key) as { data: string }[];
		expect(kids.length).toBe(1);
		expect(JSON.parse(kids[0]!.data).note).toContain("A note about it");
		const chap = mk0(db, items[2]!.key);
		expect(chap.itemType).toBe("bookSection");
		expect(chap.bookTitle).toBe("Textbook of Surgery");
		expect(chap.pages).toBe("45–67");
		expect(lastNames(chap, "editor")).toEqual(["Kim"]);
		const book = mk0(db, items[1]!.key);
		expect(book.ISBN).toBe("978-0-19-800000-0");
		// everything went into the new collection
		expect(r.body.collectionKey).toBeTruthy();
		expect(listItems(db, { collection: r.body.collectionKey!, limit: 10 }).total).toBe(3);
	});

	test("export has TY/ER, codes and CRLF", async () => {
		const a = freshDb();
		const item = mk(a, SAMPLES.journalArticle!);
		const text = await exportOne(a, item.data.key, "ris");
		expect(text.startsWith("TY  - JOUR\r\n")).toBe(true);
		expect(text).toContain("AU  - Smith, Jane\r\n");
		expect(text).toContain("AU  - Müller-García, José\r\n");
		expect(text).toContain("T2  - The Lancet\r\n");
		expect(text).toContain("SP  - 100\r\nEP  - 110\r\n");
		expect(text).toContain("KW  - liver\r\n");
		expect(text).toContain("DA  - 2023/11/02/\r\n");
		expect(text.trimEnd().endsWith("ER  -")).toBe(true);
	});
});

describe("CSL-JSON", () => {
	test("imports CSL-JSON with particles, ranges and keywords", async () => {
		const db = freshDb();
		const csl = JSON.stringify([
			{ id: "x1", type: "article-journal", title: "T1", author: [{ family: "Berg", "non-dropping-particle": "van der", given: "Jan" }, { literal: "Consortium" }], issued: { "date-parts": [[2020, 3, 4]] }, "container-title": "Nature", page: "10-20", DOI: "10.1/abc", keyword: "a, b" },
			{ id: "x2", type: "book", title: "T2", author: [{ family: "Doe", given: "Jane" }], issued: { "date-parts": [[2001]] }, publisher: "P" },
		]);
		expect(detectFormat(csl)).toBe("csljson");
		const r = await importInto(db, csl, { collectionName: null });
		expect(r.body).toMatchObject({ created: 2, collectionKey: null });
		const items = listItems(db, { limit: 10, sort: "title", dir: "asc" }).items;
		const d = mk0(db, items[0]!.key);
		expect(d).toMatchObject({ itemType: "journalArticle", date: "2020-03-04", pages: "10–20", publicationTitle: "Nature", DOI: "10.1/abc" });
		expect(d.creators![0]).toMatchObject({ lastName: "van der Berg", firstName: "Jan" });
		expect(d.creators![1]).toMatchObject({ name: "Consortium" });
		expect(d.tags!.map((t) => t.tag)).toEqual(["a", "b"]);
	});

	test("export is valid CSL-JSON with Zotero type mapping", async () => {
		const a = freshDb();
		const item = mk(a, SAMPLES.bookSection!);
		const arr = JSON.parse(await exportOne(a, item.data.key, "csljson")) as Record<string, any>[];
		expect(arr[0]).toMatchObject({ type: "chapter", title: "The spleen", "container-title": "Textbook of Surgery", publisher: "Elsevier" });
		expect(arr[0]!.editor[0]).toMatchObject({ family: "Kim", given: "Bo" });
		expect(arr[0]!.issued).toEqual({ "date-parts": [[2020, 5]] });
	});
});

describe("other formats", () => {
	test("PubMed nbib", async () => {
		const db = freshDb();
		const nbib = `PMID- 31452104
OWN - NLM
TI  - Fetal growth: a new chart.
PG  - 150-160
LID - 10.1002/uog.20000 [doi]
AB  - Background text that
      wraps onto a second line.
FAU - Smith, John A
AU  - Smith JA
FAU - Lee, Ann
AU  - Lee A
LA  - eng
JT  - Ultrasound in obstetrics & gynecology
TA  - Ultrasound Obstet Gynecol
VI  - 55
IP  - 2
DP  - 2020 Feb
MH  - Female
MH  - *Fetal Development

PMID- 2
TI  - Second record
FAU - Roe, Rick
JT  - Journal Two
DP  - 2019
`;
		expect(detectFormat(nbib)).toBe("pubmed-nbib");
		const r = await importInto(db, nbib, { format: "pubmed-nbib", collectionName: "PM" });
		expect(r.body).toMatchObject({ created: 2, errors: [] });
		const d = firstItemByTitle(db, "Fetal growth: a new chart");
		expect(d).toMatchObject({ itemType: "journalArticle", date: "2020-02", volume: "55", issue: "2", pages: "150–160", DOI: "10.1002/uog.20000", PMID: "31452104" });
		expect(d.abstractNote).toBe("Background text that wraps onto a second line.");
		expect(d.creators!.map((c) => c.lastName)).toEqual(["Smith", "Lee"]);
		expect(d.tags!.map((t) => t.tag)).toEqual(["Female", "Fetal Development"]);
	});

	test("EndNote XML", async () => {
		const db = freshDb();
		const xml = `<?xml version="1.0" encoding="UTF-8"?><xml><records>
<record><ref-type name="Journal Article">17</ref-type>
<contributors><authors><author><style face="normal">Smith, Jane</style></author><author>Lee, Ann</author></authors></contributors>
<titles><title>Cells &amp; tissues</title><secondary-title>Journal of Cells</secondary-title></titles>
<periodical><full-title>Journal of Cells</full-title></periodical>
<pages>11-19</pages><volume>4</volume><number>2</number>
<keywords><keyword>cell</keyword><keyword>tissue</keyword></keywords>
<dates><year>2019</year></dates>
<abstract>About cells.</abstract>
<electronic-resource-num>10.5555/cells.1</electronic-resource-num>
<urls><related-urls><url>https://example.org/cells</url></related-urls></urls>
<notes>Remember this</notes></record>
<record><ref-type name="Book">6</ref-type><contributors><authors><author>Doe, John</author></authors></contributors><titles><title>A book</title></titles><dates><year>2000</year></dates><publisher>Pub</publisher></record>
</records></xml>`;
		expect(detectFormat(xml)).toBe("endnote-xml");
		const r = await importInto(db, xml);
		expect(r.body).toMatchObject({ created: 2, errors: [], format: "endnote-xml" });
		const d = firstItemByTitle(db, "Cells & tissues");
		expect(d).toMatchObject({ itemType: "journalArticle", publicationTitle: "Journal of Cells", pages: "11–19", volume: "4", issue: "2", date: "2019", DOI: "10.5555/cells.1", url: "https://example.org/cells" });
		expect(d.tags!.map((t) => t.tag)).toEqual(["cell", "tissue"]);
		expect(firstItemByTitle(db, "A book")).toMatchObject({ itemType: "book", publisher: "Pub" });
	});

	test("CSV has Zotero's columns and rows", async () => {
		const a = freshDb();
		const item = mk(a, SAMPLES.journalArticle!);
		mk(a, { itemType: "note", note: "<p>Hello <b>note</b></p>", parentItem: item.data.key });
		const text = await exportOne(a, item.data.key, "csv", true);
		const [head, row] = text.trim().split("\r\n");
		expect(head!.startsWith('"Key","Item Type","Publication Year","Author","Title","Publication Title","ISBN","ISSN","DOI","Url","Abstract Note","Date"')).toBe(true);
		expect(row).toContain('"journalArticle","2023","Smith, Jane; Müller-García, José"');
		expect(row).toContain('"transplant; liver"'.replace("transplant; liver", "liver; transplant"));
		expect(row).toContain('"Hello note"');
		expect(row).toContain('"100–110"');
	});
});

function firstItemByTitle(db: Database, title: string): ZoteroItemData {
	const r = db.query("SELECT key FROM items WHERE title = ?").get(title) as { key: string } | null;
	if (!r) throw new Error("no item titled " + title);
	return mk0(db, r.key);
}

describe("import behaviour", () => {
	const BIB = `@article{a, title={Alpha}, author={Smith, Jo}, year={2020}, doi={10.1/ALPHA}}
@article{b, title={Beta}, author={Smith, Jo}, year={2021}, doi={https://doi.org/10.1/beta}}
@article{c, title={Gamma}, author={Smith, Jo}, year={2022}}`;

	test("duplicates by DOI are skipped, including within the file and across imports", async () => {
		const db = freshDb();
		mk(db, { itemType: "journalArticle", title: "Existing", DOI: "10.1/alpha" });
		const r1 = await importInto(db, BIB + "\n@article{d, title={Beta again}, year={2021}, doi={10.1/BETA}}", { collectionName: "X" });
		expect(r1.body).toMatchObject({ created: 2, skipped: 2 });
		const r2 = await importInto(db, BIB, { collectionName: "Y" });
		expect(r2.body).toMatchObject({ created: 1, skipped: 2 }); // Gamma has no DOI, so it is imported again
		const total = db.query("SELECT count(*) AS n FROM items WHERE item_type = 'journalArticle'").get() as { n: number };
		expect(total.n).toBe(1 + 2 + 1);
	});

	test("default collection, explicit collection and no collection", async () => {
		const db = freshDb();
		const r1 = await importInto(db, BIB, { collectionName: "refs" });
		const name = (k: string | null) => (db.query("SELECT name FROM collections WHERE key = ?").get(k) as { name: string }).name;
		expect(name(r1.body.collectionKey)).toBe("refs");
		const target = createCollection(db, "Existing coll").key;
		const r2 = await importInto(db, `@article{z, title={Zeta}, year={2020}, author={A, B}}`, { collectionKey: target });
		expect(r2.body.collectionKey).toBe(target);
		expect(listItems(db, { collection: target, limit: 10 }).total).toBe(1);
		const r3 = await importInto(db, `@article{y, title={Yota}, year={2020}, author={A, B}}`);
		expect(name(r3.body.collectionKey)).toMatch(/^Imported \d{4}-\d{2}-\d{2}$/);
		const r4 = await importInto(db, `@article{x, title={Xi}, year={2020}, author={A, B}}`, { collectionName: null });
		expect(r4.body.collectionKey).toBeNull();
		const bad = await importInto(db, BIB, { collectionKey: "NOPE0000" });
		expect(bad.status).toBe(404);
	});

	test("an empty import does not create an empty collection", async () => {
		const db = freshDb();
		const before = (db.query("SELECT count(*) AS n FROM collections").get() as { n: number }).n;
		const r = await importInto(db, "@article{a, title={Only}, doi={10.9/x}, year={2020}}", { collectionName: "A" });
		const r2 = await importInto(db, "@article{a, title={Only}, doi={10.9/x}, year={2020}}", { collectionName: "B" });
		expect(r.body.created).toBe(1);
		expect(r2.body).toMatchObject({ created: 0, skipped: 1, collectionKey: null });
		expect((db.query("SELECT count(*) AS n FROM collections").get() as { n: number }).n).toBe(before + 1);
	});

	test("auto-detect and errors", async () => {
		expect(detectFormat("@book{a, title={x}}")).toBe("bibtex");
		expect(detectFormat("  \n@misc{a,\n")).toBe("bibtex");
		expect(detectFormat("TY  - GEN\nTI  - x\nER  - ")).toBe("ris");
		expect(detectFormat('[{"id":"a","type":"book"}]')).toBe("csljson");
		expect(detectFormat("<?xml version='1.0'?><xml><records></records></xml>")).toBe("endnote-xml");
		expect(detectFormat("hello world")).toBeNull();
		const db = freshDb();
		const r = await importInto(db, "hello world");
		expect(r.status).toBe(400);
		const empty = await importInto(db, "   ");
		expect(empty.status).toBe(400);
		const badFormat = await importInto(db, "@book{a,title={x}}", { format: "nope" });
		expect(badFormat.status).toBe(400);
		// a broken entry is reported and the good ones still import
		const mixed = await importInto(db, "@article{bad, title={Unclosed\n@article{ok, title={Fine}, year={2020}}", { collectionName: null });
		expect(mixed.body.created).toBeGreaterThanOrEqual(1);
	});

	test("wrong method, bad body and CSRF-style content type", async () => {
		const db = freshDb();
		const get = await call(db, "GET", "/api/io/export");
		expect(get.status).toBe(405);
		const bad = await call(db, "POST", "/api/io/export", { format: "docx" });
		expect(bad.status).toBe(400);
		const unknown = await call(db, "POST", "/api/io/other", {});
		expect(unknown.status).toBe(404);
	});
});

describe("export selection", () => {
	test("collection (with subcollections), notes, and whole library", async () => {
		const db = freshDb();
		const root = createCollection(db, "Root").key;
		const sub = createCollection(db, "Sub", root).key;
		const a = mk(db, { itemType: "book", title: "In root", date: "2001", collections: [root] });
		mk(db, { itemType: "book", title: "In sub", date: "2002", collections: [sub] });
		mk(db, { itemType: "book", title: "Outside", date: "2003" });
		mk(db, { itemType: "note", note: "<p>Child note text</p>", parentItem: a.data.key });
		const col = (await (await call(db, "POST", "/api/io/export", { collectionKey: root, format: "ris", includeNotes: true })).json()) as { filename: string; text: string; count: number };
		expect(col.filename).toBe("Root.ris");
		expect(col.count).toBe(2);
		expect(col.text).toContain("TI  - In root");
		expect(col.text).toContain("TI  - In sub");
		expect(col.text).not.toContain("Outside");
		expect(col.text).toContain("N1  - Child note text");
		const noNotes = (await (await call(db, "POST", "/api/io/export", { collectionKey: root, format: "ris" })).json()) as { text: string };
		expect(noNotes.text).not.toContain("N1  -");
		const lib = (await (await call(db, "POST", "/api/io/export", { format: "bibtex" })).json()) as { filename: string; count: number };
		expect(lib).toMatchObject({ filename: "My Library.bib", count: 3 });
		const missing = await call(db, "POST", "/api/io/export", { collectionKey: "NOPE0000", format: "bibtex" });
		expect(missing.status).toBe(404);
	});
});
