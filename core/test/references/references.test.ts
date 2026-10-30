import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ItemDetail, ReferenceDetail, ReferenceList } from "../../src/api-types";
import { openDb } from "../../src/db";
import { addHooks } from "../../src/references/add";
import { handleReferencesApi } from "../../src/references/api";
import { buildLibraryIndex, normalizeDoi } from "../../src/references/ids";
import { net, setFetch } from "../../src/references/net";
import { findReferencesSection, parseBibliography, parseEntry } from "../../src/references/parse";
import { hooks } from "../../src/references/resolve";
import { reconstructAbstract } from "../../src/references/sources";
import { insertAttachment, insertItem, tempDir } from "../fixture";

let db: Database;
let calls: string[];
let routes: [RegExp, (url: URL) => unknown | null][];

function mock(): void {
	calls = [];
	setFetch(async (input) => {
		calls.push(input);
		const url = new URL(input);
		for (const [re, fn] of routes) {
			if (re.test(input)) {
				const body = fn(url);
				if (body === null) return new Response("not found", { status: 404 });
				return Response.json(body);
			}
		}
		return new Response("not found", { status: 404 });
	});
}

const OA_W: Record<string, any> = {
	W1: { id: "https://openalex.org/W1", doi: "https://doi.org/10.1000/AAA", title: "Alpha paper", publication_year: 2020, authorships: [{ author: { display_name: "Jane Q. Smith" } }], primary_location: { source: { display_name: "Journal A" } }, open_access: { oa_url: "https://oa.example/alpha.pdf" }, cited_by_count: 12 },
	W2: { id: "https://openalex.org/W2", doi: null, title: "Machine learning in liver transplantation outcomes", publication_year: 2020, authorships: [], primary_location: null, open_access: {}, cited_by_count: 3 },
	W3: { id: "https://openalex.org/W3", doi: "https://doi.org/10.1000/ccc", title: "Gamma paper", publication_year: 2018, authorships: [{ author: { display_name: "Ana Lopez" } }], primary_location: null, open_access: {}, cited_by_count: 0 },
};

beforeEach(() => {
	db = openDb(join(tempDir(), "lib.sqlite"));
	net.backoffMs = 1;
	insertItem(db, { key: "PAPER001", itemType: "journalArticle", title: "The citing paper", DOI: "10.1234/Citing.1", date: "2023" });
	insertItem(db, { key: "LIBDOI01", itemType: "journalArticle", title: "Different title entirely", DOI: "10.1000/aaa", date: "2020" });
	insertItem(db, { key: "LIBTIT01", itemType: "journalArticle", title: "Machine Learning in Liver Transplantation: Outcomes!", date: "2019-03" });
	routes = [
		[/api\.openalex\.org\/works\/doi:10\.1234\/citing\.1/i, () => ({ id: "https://openalex.org/W9", referenced_works: ["https://openalex.org/W3", "https://openalex.org/W1", "https://openalex.org/W2"] })],
		[/api\.openalex\.org\/works\?filter=openalex_id/, () => ({ results: [OA_W.W1, OA_W.W2, OA_W.W3] })],
	];
	mock();
});

afterEach(() => {
	setFetch();
	db.close(true);
});

describe("ids", () => {
	test("normalizeDoi", () => {
		expect(normalizeDoi("https://doi.org/10.1000/ABC.")).toBe("10.1000/abc");
		expect(normalizeDoi("doi: 10.1016/S0140-6736(20)30183-5).")).toBe("10.1016/s0140-6736(20)30183-5");
		expect(normalizeDoi("nothing")).toBeNull();
	});
	test("library index matches by DOI and by title+year", () => {
		const idx = buildLibraryIndex(db);
		expect(idx.match({ doi: "https://doi.org/10.1000/AAA" })).toBe("LIBDOI01");
		expect(idx.match({ title: "Machine learning in liver transplantation outcomes", year: 2020 })).toBe("LIBTIT01");
		expect(idx.match({ title: "Machine learning in liver transplantation outcomes", year: 2015 })).toBeUndefined();
		expect(idx.match({ title: "Unknown", year: 2020 })).toBeUndefined();
	});
});

describe("GET /api/references/:key", () => {
	const get = async (path: string) => {
		const res = (await handleReferencesApi(new Request(`http://x/api/references/${path}`), db))!;
		return { status: res.status, body: (await res.json()) as any };
	};

	test("OpenAlex references keep the work's order and flag library items; second call hits the cache", async () => {
		const { status, body } = await get("PAPER001");
		expect(status).toBe(200);
		const list = body as ReferenceList;
		expect(list.source).toBe("openalex");
		expect(list.references.map((r) => r.title)).toEqual(["Gamma paper", "Alpha paper", "Machine learning in liver transplantation outcomes"]);
		expect(list.references.map((r) => r.index)).toEqual([1, 2, 3]);
		expect(list.references[1]).toMatchObject({ doi: "10.1000/aaa", authors: ["Smith JQ"], venue: "Journal A", openAccessUrl: "https://oa.example/alpha.pdf", citedByCount: 12, inLibraryKey: "LIBDOI01" });
		expect(list.references[2].inLibraryKey).toBe("LIBTIT01");
		expect(list.references[0].inLibraryKey).toBeUndefined();

		const n = calls.length;
		const again = await get("PAPER001");
		expect(calls.length).toBe(n); // cache hit: no network
		expect(again.body.references).toHaveLength(3);
		await get("PAPER001?refresh=1");
		expect(calls.length).toBeGreaterThan(n);
	});

	test("an attachment key maps to its parent", async () => {
		insertAttachment(db, "ATTPDF01", "PAPER001", "application/pdf", null);
		const { body } = await get("ATTPDF01");
		expect(body.itemKey).toBe("PAPER001");
		expect(body.references).toHaveLength(3);
	});

	test("unknown item is 404", async () => {
		expect((await get("NOPE0000")).status).toBe(404);
	});

	test("falls back to Crossref (enriched via OpenAlex DOI lookup) when OpenAlex has no list", async () => {
		routes = [
			[/api\.openalex\.org\/works\/doi:/, () => null],
			[/api\.crossref\.org\/works\/10\.1234\/citing\.1/i, () => ({ message: { reference: [{ key: "r1", DOI: "10.1000/ccc" }, { key: "r2", unstructured: "Doe J. A study of livers. J Hepatol. 2017;66:1-9." }] } })],
			[/api\.openalex\.org\/works\?filter=doi:/, () => ({ results: [OA_W.W3] })],
		];
		const { body } = await get("PAPER001");
		expect(body.source).toBe("crossref");
		expect(body.references[0]).toMatchObject({ doi: "10.1000/ccc", title: "Gamma paper", citedByCount: 0 });
		expect(body.references[1]).toMatchObject({ year: 2017, raw: "Doe J. A study of livers. J Hepatol. 2017;66:1-9." });
	});

	test("falls back to Semantic Scholar after Crossref", async () => {
		routes = [
			[/api\.openalex\.org\/works\/doi:/, () => null],
			[/api\.crossref\.org\/works\//, () => ({ message: {} })],
			[/api\.semanticscholar\.org/, () => ({ data: [{ citedPaper: { title: "S2 paper", year: 2015, externalIds: { DOI: "10.5555/X" }, authors: [{ name: "Bo Li" }], citationCount: 7, openAccessPdf: { url: "https://pdf" } } }] })],
		];
		const { body } = await get("PAPER001");
		expect(body.source).toBe("semanticscholar");
		expect(body.references[0]).toMatchObject({ doi: "10.5555/x", authors: ["Li B"], citedByCount: 7, openAccessUrl: "https://pdf" });
	});

	test("retries on 429 then succeeds", async () => {
		let hits = 0;
		const inner = net.fetch;
		setFetch(async (u, i) => {
			if (/works\/doi:10\.1234/i.test(u) && hits++ < 2) return new Response("slow down", { status: 429 });
			return inner(u, i);
		});
		const { body } = await get("PAPER001");
		expect(body.source).toBe("openalex");
		expect(hits).toBe(3);
	});

	test("no DOI: parses the PDF bibliography and resolves entries by DOI / Crossref query", async () => {
		insertItem(db, { key: "NODOI001", itemType: "journalArticle", title: "Paper without DOI" });
		insertAttachment(db, "NODOIPDF", "NODOI001", "application/pdf", null);
		const text = [
			"Abstract blah",
			"References",
			"1. Smith J, Jones A. Hepatic regeneration after resection. Hepatology. 2019;70:11-20. doi:10.1000/ccc",
			"2. Lee K, Park S. Machine learning in liver transplantation outcomes.",
			"J Hepatol. 2020;73:100-110.",
			"3. Wu X. Something with no match whatsoever in any index. Nature. 2001;1:1-2.",
		].join("\n");
		db.query("INSERT INTO fulltext(attachment_key, content, source, indexed_at) VALUES('NODOIPDF', ?, 'test', '2024-01-01T00:00:00Z')").run(text);
		routes = [
			[/api\.openalex\.org\/works\?filter=doi:/, () => ({ results: [OA_W.W3] })],
			[/api\.crossref\.org\/works\?query\.bibliographic=.*Machine/, () => ({ message: { items: [{ DOI: "10.7777/mlt", title: ["Machine learning in liver transplantation outcomes"], issued: { "date-parts": [[2020]] }, "container-title": ["J Hepatol"], "is-referenced-by-count": 5 }] } })],
			[/api\.crossref\.org\/works\?query\.bibliographic/, () => ({ message: { items: [] } })],
		];
		const { body } = await get("NODOI001");
		expect(body.source).toBe("pdf");
		expect(body.references).toHaveLength(3);
		expect(body.references[0]).toMatchObject({ doi: "10.1000/ccc", title: "Hepatic regeneration after resection", citedByCount: 0 });
		expect(body.references[1]).toMatchObject({ doi: "10.7777/mlt", year: 2020, inLibraryKey: "LIBTIT01" });
		expect(body.references[2].doi).toBeUndefined();
		expect(body.references[2].raw).toContain("Something with no match");
	});

	test("extracts the PDF text on demand when the fulltext row is missing", async () => {
		insertItem(db, { key: "NODOI002", itemType: "journalArticle", title: "Another" });
		insertAttachment(db, "NODOIP02", "NODOI002", "application/pdf", null);
		const saved = hooks.extract;
		hooks.extract = async (d, k) => {
			d.query("INSERT INTO fulltext(attachment_key, content, source, indexed_at) VALUES(?, ?, 'test', '2024')").run(
				k,
				"References\n[1] Foo A. First thing here to read about. Lancet. 2010;1:1-3.\n[2] Bar B. Second thing here to read about. BMJ. 2011;2:3-4.\n[3] Baz C. Third thing here to read about. JAMA. 2012;3:5-6.",
			);
		};
		routes = [[/crossref\.org\/works\?query/, () => ({ message: { items: [] } })]];
		try {
			const { body } = await get("NODOI002");
			expect(body.source).toBe("pdf");
			expect(body.references).toHaveLength(3);
		} finally {
			hooks.extract = saved;
		}
	});
});

describe("lookup", () => {
	test("reconstructs the abstract and reports counts and OA link", async () => {
		expect(reconstructAbstract({ World: [1], Hello: [0], again: [2] })).toBe("Hello World again");
		routes = [
			[
				/api\.openalex\.org\/works\/doi:10\.1000\/aaa/,
				() => ({ ...OA_W.W1, referenced_works_count: 40, type: "article", abstract_inverted_index: { We: [0], study: [1], livers: [2], "livers.": [3] } }),
			],
		];
		const res = (await handleReferencesApi(new Request("http://x/api/references/lookup?doi=10.1000/AAA"), db))!;
		const d = (await res.json()) as ReferenceDetail;
		expect(d).toMatchObject({ doi: "10.1000/aaa", abstract: "We study livers livers.", citedByCount: 12, referenceCount: 40, openAccessUrl: "https://oa.example/alpha.pdf", type: "article", inLibraryKey: "LIBDOI01" });
	});

	test("title lookup requires a close match; 404 otherwise", async () => {
		routes = [[/works\?search=/, () => ({ results: [{ ...OA_W.W3, abstract_inverted_index: { Hi: [0] } }] })]];
		const ok = (await handleReferencesApi(new Request("http://x/api/references/lookup?title=Gamma%20paper"), db))!;
		expect(ok.status).toBe(200);
		const miss = (await handleReferencesApi(new Request("http://x/api/references/lookup?title=Something%20else%20completely"), db))!;
		expect(miss.status).toBe(404);
		const bad = (await handleReferencesApi(new Request("http://x/api/references/lookup"), db))!;
		expect(bad.status).toBe(400);
	});

	test("results (and misses) are cached in the database, so a second hover needs no network", async () => {
		let calls = 0;
		routes = [[/api\.openalex\.org\/works\/doi:10\.1000\/cache1/, () => { calls++; return { ...OA_W.W1, doi: "https://doi.org/10.1000/cache1", abstract_inverted_index: { Cached: [0] } }; }]];
		const get = async (q: string) => (await handleReferencesApi(new Request(`http://x/api/references/lookup?${q}`), db))!;
		expect((await (await get("doi=10.1000/cache1")).json() as ReferenceDetail).abstract).toBe("Cached");
		routes = []; // network gone: the cached copy still answers
		const again = await get("doi=10.1000/cache1");
		expect(again.status).toBe(200);
		expect((await again.json() as ReferenceDetail).abstract).toBe("Cached");
		expect(calls).toBe(1);
		expect((await get("doi=10.1000/nothing-here")).status).toBe(404);
		expect((await get("doi=10.1000/nothing-here")).status).toBe(404);
	});
});

describe("POST /api/references/add", () => {
	const CR_MSG = {
		message: {
			DOI: "10.1000/new.1",
			type: "journal-article",
			title: ["A <i>new</i> study of things"],
			author: [{ given: "Ada", family: "Lovelace" }, { name: "The Consortium" }],
			"container-title": ["Journal of Things"],
			volume: "12",
			issue: "3",
			page: "45-67",
			ISSN: ["1234-5678"],
			issued: { "date-parts": [[2021, 5]] },
			abstract: "<jats:p>An abstract.</jats:p>",
			URL: "https://doi.org/10.1000/new.1",
		},
	};
	const post = async (body: unknown) => {
		const res = (await handleReferencesApi(new Request("http://x/api/references/add", { method: "POST", body: JSON.stringify(body) }), db))!;
		return { status: res.status, body: (await res.json()) as any };
	};

	test("creates an item from Crossref metadata, files it in the collection, indexes it", async () => {
		db.query("INSERT INTO collections(key, name) VALUES('COLL0001', 'Reading')").run();
		routes = [[/api\.crossref\.org\/works\/10\.1000\/new\.1/, () => CR_MSG]];
		let ft = null as string | null;
		const saved = addHooks.findFullText;
		addHooks.findFullText = (_d, k) => {
			ft = k;
		};
		try {
			const { status, body } = await post({ doi: "https://doi.org/10.1000/NEW.1", collectionKey: "COLL0001", findFullText: true });
			expect(status).toBe(201);
			const d = (body as ItemDetail).data;
			expect(d).toMatchObject({
				itemType: "journalArticle",
				title: "A new study of things",
				publicationTitle: "Journal of Things",
				volume: "12",
				issue: "3",
				pages: "45-67",
				DOI: "10.1000/new.1",
				ISSN: "1234-5678",
				date: "2021-05",
				abstractNote: "An abstract.",
			});
			expect(d.creators?.[0]).toMatchObject({ creatorType: "author", firstName: "Ada", lastName: "Lovelace" });
			expect(d.creators?.[1]).toMatchObject({ name: "The Consortium" });
			expect(d.collections).toEqual(["COLL0001"]);
			expect(ft).toBe(d.key);
			const hit = db.query("SELECT count(*) AS n FROM search WHERE search MATCH 'lovelace' OR search MATCH 'things'").get() as { n: number };
			expect(hit.n).toBeGreaterThan(0);

			const dup = await post({ doi: "10.1000/new.1" });
			expect(dup.status).toBe(409);
			expect(dup.body.key).toBe(d.key);
		} finally {
			addHooks.findFullText = saved;
		}
	});

	test("maps book chapters and reports 409 for a library DOI", async () => {
		routes = [[/api\.crossref\.org\/works\/10\.2000\/ch/, () => ({ message: { type: "book-chapter", title: ["Chapter"], "container-title": ["The Book"], publisher: "Pub", page: "1-9", issued: { "date-parts": [[2015]] } } })]];
		const { status, body } = await post({ doi: "10.2000/ch" });
		expect(status).toBe(201);
		expect(body.data).toMatchObject({ itemType: "bookSection", bookTitle: "The Book", publisher: "Pub", date: "2015" });
		const dup = await post({ doi: "10.1000/aaa" });
		expect(dup.status).toBe(409);
		expect(dup.body.key).toBe("LIBDOI01");
	});

	test("adds from a reference object when the DOI is unknown", async () => {
		const { status, body } = await post({ reference: { index: 1, title: "A reference only paper", authors: ["Smith JQ"], year: 2012, venue: "Old Journal" } });
		expect(status).toBe(201);
		expect(body.data).toMatchObject({ title: "A reference only paper", date: "2012", publicationTitle: "Old Journal" });
		expect(body.data.creators[0]).toMatchObject({ lastName: "Smith", firstName: "JQ" });
		expect((await post({})).status).toBe(400);
	});
});

describe("PDF bibliography parsing", () => {
	test("numbered references with wrapped lines and DOIs", () => {
		const text = `Discussion text.\n\nReferences\n1. Smith J, Jones AB. Liver transplant outcomes in the modern era.\nLancet. 2019;393(10):100-9. doi:10.1016/S0140-6736(19)30001-1.\n2. Lee K, Park S, Kim Y. Machine-\nlearning prediction of graft failure. J Hepatol. 2020;73:1-10.\n3. World Health Organization. Global report on transplantation. Geneva: WHO; 2018.\n4. Chen L. A fourth entry that is long enough. Hepatology. 2021;1:2-3.\n`;
		const refs = parseBibliography(text);
		expect(refs).toHaveLength(4);
		expect(refs[0]).toMatchObject({ doi: "10.1016/s0140-6736(19)30001-1", year: 2019, title: "Liver transplant outcomes in the modern era" });
		expect(refs[0].authors).toEqual(["Smith J", "Jones AB"]);
		expect(refs[1].raw).toContain("prediction of graft");
		expect(refs[1].year).toBe(2020);
	});

	test("numbered entries run together in one paragraph", () => {
		const text = "References\n1. Boyd NF, Pater JL. Observer variation in records. J Chronic Dis 1979;32:327-32. 2. Horwitz RI, Yu EC. Assessing the reliability of data. J Chronic Dis 1984;37:825-31. 3. Schulz KF, Grimes DA. Case-control studies: research in reverse. Lancet 2002;359:431-4.";
		expect(parseBibliography(text).map((r) => r.year)).toEqual([1979, 1984, 2002]);
	});

	test("bracketed numbering", () => {
		const text = "REFERENCES\n[1] Foo A. First title of a paper here. Nature. 2010;1:1-2.\n[2] Bar B. Second title of a paper here. Science. 2011;2:3-4.\n[3] Baz C. Third title of a paper here. Cell. 2012;3:5-6.";
		expect(parseBibliography(text).map((r) => r.year)).toEqual([2010, 2011, 2012]);
	});

	test("author-year style", () => {
		const text = [
			"Body of the paper.",
			"References",
			"Anderson, J., & Brown, K. (2018). Surgical outcomes after liver resection. Journal of Surgery, 12(3), 45-60.",
			"Clark, P. (2020). Predicting graft survival with neural networks. Transplantation, 104, 1-10.",
			"https://doi.org/10.1097/TP.0000000000003000",
			"Davis, M., Evans, R., & Foster, T. (2015). A long study title that wraps across",
			"two lines in the PDF. Annals of Hepatology, 14, 200-210.",
		].join("\n");
		const refs = parseBibliography(text);
		expect(refs).toHaveLength(3);
		expect(refs[0]).toMatchObject({ year: 2018, title: "Surgical outcomes after liver resection" });
		expect(refs[0].authors).toEqual(["Anderson J", "Brown K"]);
		expect(refs[1].doi).toBe("10.1097/tp.0000000000003000");
		expect(refs[2].title).toContain("two lines in the PDF");
	});

	test("no references heading yields nothing", () => {
		expect(findReferencesSection("just some text without a list")).toBeNull();
		expect(parseBibliography("nothing")).toEqual([]);
		expect(parseEntry("x").raw).toBe("x");
	});
});
