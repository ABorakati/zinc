import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ItemDetail } from "../../src/api-types";
import { openDb } from "../../src/db";
import { hooks } from "../../src/additems/files";
import { findArxivId, normalizeIsbn, parseIdentifiers } from "../../src/additems/identifiers";
import { shutdownExtractPool } from "../../src/extract";
import { net, setFetch } from "../../src/references/net";
import { call, insertItem, tempDir } from "../fixture";

let db: Database;
let dir: string;
let calls: string[];
let routes: [RegExp, (url: URL) => Response | object | null][];

function mock(): void {
	calls = [];
	setFetch(async (input) => {
		calls.push(input);
		const url = new URL(input);
		for (const [re, fn] of routes) {
			if (!re.test(input)) continue;
			const body = fn(url);
			if (body === null) return new Response("not found", { status: 404 });
			return body instanceof Response ? body : Response.json(body);
		}
		return new Response("not found", { status: 404 });
	});
}

const xml = (s: string) => new Response(s, { headers: { "Content-Type": "application/xml" } });

const CROSSREF = {
	message: {
		type: "journal-article",
		title: ["Outcomes after liver transplantation"],
		author: [{ given: "Jane", family: "Smith" }, { given: "Raj", family: "Patel" }],
		"container-title": ["BMJ"],
		issued: { "date-parts": [[2023, 11, 2]] },
		volume: "383",
		page: "e078378",
		URL: "https://doi.org/10.1136/bmj-2023-078378",
	},
};

const PUBMED_XML = `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID Version="1">31452104</PMID>
<Article><Journal><ISSN>1469-0705</ISSN><JournalIssue><Volume>55</Volume><Issue>2</Issue><PubDate><Year>2020</Year><Month>Feb</Month></PubDate></JournalIssue><Title>Ultrasound in obstetrics &amp; gynecology</Title><ISOAbbreviation>Ultrasound Obstet Gynecol</ISOAbbreviation></Journal>
<ArticleTitle>Fetal growth: a <i>new</i> chart.</ArticleTitle><Pagination><MedlinePgn>150-160</MedlinePgn></Pagination>
<Abstract><AbstractText Label="OBJECTIVE">To build a chart.</AbstractText><AbstractText Label="METHODS">We measured.</AbstractText></Abstract>
<AuthorList><Author><LastName>Doe</LastName><ForeName>John</ForeName></Author><Author><CollectiveName>The Fetal Group</CollectiveName></Author></AuthorList><Language>eng</Language></Article></MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="pubmed">31452104</ArticleId><ArticleId IdType="doi">10.1002/UOG.20123</ArticleId><ArticleId IdType="pmc">PMC7000001</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>`;

const ARXIV_XML = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/1706.03762v7</id><published>2017-06-12T17:57:34Z</published>
<title>Attention Is
 All You Need</title><summary>The dominant sequence transduction models.</summary><author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author>
<arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL" scheme="x"/></entry></feed>`;

const OPENLIB = { "ISBN:9780134685991": { title: "Effective Java", authors: [{ name: "Joshua Bloch" }], publishers: [{ name: "Addison-Wesley" }], publish_date: "2018", number_of_pages: 412, publish_places: [{ name: "Boston" }] } };

const EPMC = { resultList: { result: [{ title: "A PMC paper.", pmid: "111", pmcid: "PMC1234567", doi: "10.1000/pmc.1", authorList: { author: [{ firstName: "Ann", lastName: "Lee" }] }, journalInfo: { volume: "5", issue: "1", yearOfPublication: 2021, journal: { title: "Gut" } }, abstractText: "Abstract here" }] } };

// Smallest useful PDF: one page of Helvetica text.
function tinyPdf(lines: string[]): Uint8Array {
	const stream = `BT /F1 14 Tf 72 720 Td 16 TL ${lines.map((l) => `(${l}) Tj T*`).join(" ")} ET`;
	const objs = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objs.forEach((o, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(out);
}

const origAfterImport = hooks.afterImport;
// net is shared with other test files (references); restore what these tests change.
const origNet = { backoffMs: net.backoffMs, retries: net.retries };

beforeEach(() => {
	dir = tempDir();
	db = openDb(join(dir, "lib.sqlite"));
	net.backoffMs = 1;
	net.retries = 0;
	db.query("INSERT INTO collections(key, name) VALUES('COLLAAA1', 'Coll')").run();
	hooks.afterImport = () => {}; // no background extraction unless a test asks for it
	routes = [
		[/api\.crossref\.org\/works\/10\.1136\/bmj-2023-078378/i, () => CROSSREF],
		[/api\.crossref\.org\/works\/10\.1000\/pmc\.1/i, () => ({ message: { ...CROSSREF.message, title: ["Wrong"] } })],
		[/eutils\.ncbi\.nlm\.nih\.gov.*efetch.*id=31452104/, () => xml(PUBMED_XML)],
		[/europepmc.*PMCID%3APMC1234567/, () => EPMC],
		[/export\.arxiv\.org.*id_list=1706\.03762/, () => xml(ARXIV_XML)],
		[/openlibrary\.org\/api\/books.*9780134685991/, () => OPENLIB],
		[/googleapis\.com\/books.*isbn:9780306406157/, () => ({ items: [{ volumeInfo: { title: "Gb Book", subtitle: "Sub", authors: ["Zed Quill"], publisher: "P", publishedDate: "1999-01-01" } }] })],
	];
	mock();
});

afterEach(() => {
	setFetch();
	Object.assign(net, origNet);
	hooks.afterImport = origAfterImport;
	db.close(true);
});

afterAll(() => shutdownExtractPool());

const post = async <T = any>(path: string, body: unknown, status = 200): Promise<T> => {
	const res = await call(db, "POST", path, body);
	expect(res.status).toBe(status);
	return (await res.json()) as T;
};

describe("identifier parsing", () => {
	test("recognises DOI, PMID, PMCID, arXiv and ISBN in mixed input", () => {
		const { ids, unknown } = parseIdentifiers("10.1136/BMJ-2023-078378, PMID: 31452104\nPMC1234567; arXiv:1706.03762v5\nISBN 978-0-13-468599-1 https://doi.org/10.1000/xyz\nblargh");
		expect(ids.map((i) => `${i.kind}:${i.id}`)).toEqual([
			"doi:10.1136/bmj-2023-078378",
			"pmid:31452104",
			"pmcid:PMC1234567",
			"arxiv:1706.03762",
			"isbn:9780134685991",
			"doi:10.1000/xyz",
		]);
		expect(unknown).toEqual(["blargh"]);
	});
	test("bare numbers, URLs and ISBN-10", () => {
		const { ids } = parseIdentifiers("31452104\nhttps://pubmed.ncbi.nlm.nih.gov/123456/\nhttps://arxiv.org/abs/2101.01234v2\n0306406152\nhep-th/9901001");
		expect(ids.map((i) => `${i.kind}:${i.id}`)).toEqual(["pmid:31452104", "pmid:123456", "arxiv:2101.01234", "isbn:9780306406157", "arxiv:hep-th/9901001"]);
		expect(normalizeIsbn("0-306-40615-2")).toBe("9780306406157");
		expect(normalizeIsbn("0-306-40615-3")).toBeNull();
		expect(findArxivId("see arXiv:1706.03762v7 [cs.CL]")).toBe("1706.03762");
	});
});

describe("POST /api/add/identifier", () => {
	test("adds from every source", async () => {
		const r = await post("/api/add/identifier", {
			text: "10.1136/bmj-2023-078378\n31452104\nPMC1234567\narXiv:1706.03762\n9780134685991\n0306406152",
			collectionKey: "COLLAAA1",
		});
		expect(r.failed).toEqual([]);
		expect(r.added.length).toBe(6);
		const by = (t: string) => r.added.find((d: ItemDetail) => d.data.itemType === t || d.data.title === t) as ItemDetail;
		const doi = r.added[0] as ItemDetail;
		expect(doi.data.title).toBe("Outcomes after liver transplantation");
		expect(doi.data.DOI).toBe("10.1136/bmj-2023-078378");
		expect(doi.collections).toEqual(["COLLAAA1"]);

		const pm = r.added[1] as ItemDetail;
		expect(pm.data.title).toBe("Fetal growth: a new chart");
		expect(pm.data.DOI).toBe("10.1002/uog.20123");
		expect(pm.data.date).toBe("2020-02");
		expect(pm.data.abstractNote).toBe("OBJECTIVE: To build a chart.\n\nMETHODS: We measured.");
		expect(pm.data.extra).toContain("PMID: 31452104");
		expect(pm.data.publicationTitle).toBe("Ultrasound in obstetrics & gynecology");
		expect(pm.data.creators).toEqual([
			{ creatorType: "author", firstName: "John", lastName: "Doe" },
			{ creatorType: "author", name: "The Fetal Group" },
		]);

		const pmc = r.added[2] as ItemDetail;
		expect(pmc.data.title).toBe("A PMC paper");
		expect(pmc.data.extra).toContain("PMCID: PMC1234567");

		const ax = r.added[3] as ItemDetail;
		expect(ax.data.itemType).toBe("preprint");
		expect(ax.data.title).toBe("Attention Is All You Need");
		expect(ax.data.archiveID).toBe("arXiv:1706.03762");
		expect(ax.data.creators?.[0]).toEqual({ creatorType: "author", firstName: "Ashish", lastName: "Vaswani" });

		const book = r.added[4] as ItemDetail;
		expect(book.data.itemType).toBe("book");
		expect(book.data.ISBN).toBe("9780134685991");
		expect(book.data.publisher).toBe("Addison-Wesley");
		const gb = r.added[5] as ItemDetail;
		expect(gb.data.title).toBe("Gb Book: Sub");
		expect(calls.some((c) => c.includes("googleapis"))).toBe(true);
		void by;
		expect((db.query("SELECT count(*) AS n FROM items").get() as { n: number }).n).toBe(6);
	});

	test("skips duplicates by DOI, PMID and ISBN and reports them as existing", async () => {
		insertItem(db, { key: "OLDDOI01", itemType: "journalArticle", title: "Has doi", DOI: "10.1136/BMJ-2023-078378" });
		insertItem(db, { key: "OLDPMID1", itemType: "journalArticle", title: "Has pmid", extra: "PMID: 31452104" });
		insertItem(db, { key: "OLDISBN1", itemType: "book", title: "Has isbn", ISBN: "978-0-13-468599-1" });
		const before = calls.length;
		const r = await post("/api/add/identifier", { text: "10.1136/bmj-2023-078378 31452104 9780134685991" });
		expect(r.added).toEqual([]);
		expect(r.existing.map((e: any) => e.key)).toEqual(["OLDDOI01", "OLDPMID1", "OLDISBN1"]);
		expect(calls.length).toBe(before); // known identifiers never hit the network
	});

	test("PMC paper whose DOI is already in the library is not duplicated", async () => {
		insertItem(db, { key: "OLDDOI02", itemType: "journalArticle", title: "x", DOI: "10.1000/PMC.1" });
		const r = await post("/api/add/identifier", { text: "PMC1234567" });
		expect(r.added).toEqual([]);
		expect(r.existing[0].key).toBe("OLDDOI02");
	});

	test("failures are reported per identifier; others still added", async () => {
		const r = await post("/api/add/identifier", { text: "10.9999/nope 10.1136/bmj-2023-078378 notanid1" });
		expect(r.added.length).toBe(1);
		expect(r.failed.map((f: any) => f.id).sort()).toEqual(["10.9999/nope", "notanid1"]);
		const bad = await call(db, "POST", "/api/add/identifier", { text: "   " });
		expect(bad.status).toBe(400);
	});

	test("unknown route and wrong method", async () => {
		expect((await call(db, "POST", "/api/add/zzz", {})).status).toBe(404);
		expect((await call(db, "GET", "/api/add/identifier")).status).toBe(405);
	});
});

describe("attachments", () => {
	const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

	test("imported file is stored under storage/<KEY>/<name>", async () => {
		insertItem(db, { key: "PARENT01", itemType: "journalArticle", title: "Parent" });
		const bytes = new Uint8Array([1, 2, 3, 250]);
		const d = await post<ItemDetail>("/api/add/file", { name: "my:file?.bin", dataBase64: b64(bytes), parentKey: "PARENT01" }, 201);
		expect(d.data.linkMode).toBe("imported_file");
		expect(d.data.parentItem).toBe("PARENT01");
		expect(d.data.filename).toBe("myfile.bin");
		const row = db.query("SELECT path, link_mode FROM attachments WHERE item_key = ?").get(d.data.key) as { path: string; link_mode: string };
		expect(row.path).toBe(join(dir, "storage", d.data.key, "myfile.bin"));
		expect([...readFileSync(row.path)]).toEqual([...bytes]);
	});

	test("standalone import goes into the collection; linked file keeps its path", async () => {
		const local = join(dir, "paper.pdf");
		writeFileSync(local, tinyPdf(["x"]));
		const imp = await post<ItemDetail>("/api/add/file", { name: "paper.pdf", dataBase64: b64(tinyPdf(["x"])), collectionKey: "COLLAAA1" }, 201);
		expect(imp.collections).toEqual(["COLLAAA1"]);
		expect(imp.data.contentType).toBe("application/pdf");
		const lnk = await post<ItemDetail>("/api/add/file", { mode: "linked_file", path: local, collectionKey: "COLLAAA1" }, 201);
		const row = db.query("SELECT path, link_mode FROM attachments WHERE item_key = ?").get(lnk.data.key) as { path: string; link_mode: string };
		expect(row).toEqual({ path: local, link_mode: "linked_file" });
		expect(existsSync(join(dir, "storage", lnk.data.key))).toBe(false);
		expect((await call(db, "POST", "/api/add/file", { mode: "linked_file", path: "relative.pdf" })).status).toBe(400);
		expect((await call(db, "POST", "/api/add/file", { mode: "linked_file", path: join(dir, "missing.pdf") })).status).toBe(404);
		expect((await call(db, "POST", "/api/add/file", { name: "a.txt", dataBase64: "AA==", parentKey: "NOPE0000" })).status).toBe(404);
	});

	test("custom storage location: file goes to <folder>/<pattern>/<name>, linked by default, imported when asked", async () => {
		const { setStorage } = await import("../../src/files/storage");
		insertItem(db, { key: "PARENT01", itemType: "journalArticle", title: "Parent", date: "2021" });
		const custom = join(dir, "custom-store");
		setStorage(db, { dir: custom, subfolder: "{%y}" });
		const a = await post<ItemDetail>("/api/add/file", { name: "a.pdf", dataBase64: "AA==", parentKey: "PARENT01" }, 201);
		const rowA = db.query("SELECT path, link_mode FROM attachments WHERE item_key = ?").get(a.data.key) as { path: string; link_mode: string };
		expect(a.data.linkMode).toBe("linked_file");
		expect(rowA.link_mode).toBe("linked_file");
		expect(a.data.path).toBe(join(custom, "2021", "a.pdf"));
		expect(existsSync(join(custom, "2021", "a.pdf"))).toBe(true);
		expect(existsSync(join(dir, "storage", a.data.key))).toBe(false);
		setStorage(db, { linked: false });
		const b = await post<ItemDetail>("/api/add/file", { name: "a.pdf", dataBase64: "AA==", parentKey: "PARENT01" }, 201);
		expect(b.data.linkMode).toBe("imported_file");
		expect(b.data.filename).toBe("a (2).pdf"); // unique inside the shared folder
		expect(existsSync(join(custom, "2021", "a (2).pdf"))).toBe(true);
	});

	test("multipart upload also works through the handler", async () => {
		const fd = new FormData();
		fd.set("file", new File([new Uint8Array([9, 9])], "up.txt", { type: "text/plain" }));
		fd.set("collectionKey", "COLLAAA1");
		const { handleApi } = await import("../../src/api");
		const res = await handleApi(new Request("http://127.0.0.1:23120/api/add/file", { method: "POST", body: fd }), db);
		expect(res!.status).toBe(201);
		const d = (await res!.json()) as ItemDetail;
		expect(d.data.contentType).toBe("text/plain");
		expect(readFileSync(join(dir, "storage", d.data.key, "up.txt")).length).toBe(2);
	});

	test("link attachment and notes", async () => {
		insertItem(db, { key: "PARENT01", itemType: "journalArticle", title: "Parent" });
		const l = await post<ItemDetail>("/api/add/link", { parentKey: "PARENT01", url: "https://example.org/a", title: "Example" }, 201);
		expect(l.data.linkMode).toBe("linked_url");
		expect(l.data.title).toBe("Example");
		expect((await call(db, "POST", "/api/add/link", { url: "javascript:alert(1)" })).status).toBe(400);
		expect((await call(db, "POST", "/api/add/link", { url: "" })).status).toBe(400);
		const n = await post<ItemDetail>("/api/items", { data: { itemType: "note", note: "<p>hi</p>", parentItem: "PARENT01" } }, 201);
		expect(n.data.parentItem).toBe("PARENT01");
		const sn = await post<ItemDetail>("/api/items", { data: { itemType: "note", note: "<p>solo</p>", collections: ["COLLAAA1"] } }, 201);
		expect(sn.collections).toEqual(["COLLAAA1"]);
	});
});

describe("retrieve metadata for PDFs", () => {
	async function importPdf(lines: string[], coll = "COLLAAA1"): Promise<string> {
		const d = await post<ItemDetail>("/api/add/file", { name: "scan.pdf", dataBase64: Buffer.from(tinyPdf(lines)).toString("base64"), collectionKey: coll }, 201);
		return d.data.key;
	}

	test("DOI in the first page creates the parent and moves the PDF under it", async () => {
		const att = await importPdf(["Outcomes after liver transplantation", "doi: 10.1136/bmj-2023-078378"]);
		const r = await post("/api/add/retrieve-metadata", { attachmentKeys: [att] });
		expect(r.results[0]).toMatchObject({ attachmentKey: att, status: "retrieved", via: "doi" });
		const parent = r.results[0].itemKey as string;
		expect(r.items[0].data.title).toBe("Outcomes after liver transplantation");
		expect(r.items[0].collections).toEqual(["COLLAAA1"]);
		const row = db.query("SELECT parent_key FROM items WHERE key = ?").get(att) as { parent_key: string };
		expect(row.parent_key).toBe(parent);
		expect(db.query("SELECT 1 FROM collection_items WHERE item_key = ?").get(att)).toBeNull();
		// the stored file was renamed from the parent's metadata (Zotero's default) and still exists
		const path = (db.query("SELECT path FROM attachments WHERE item_key = ?").get(att) as { path: string }).path;
		expect(existsSync(path)).toBe(true);
		expect(r.results[0].renamed).toBe(true);
		expect(basename(path)).toBe("Smith and Patel - 2023 - Outcomes after liver transplantation.pdf");
		expect((JSON.parse((db.query("SELECT data FROM items WHERE key = ?").get(att) as { data: string }).data) as { filename: string }).filename).toBe(basename(path));
		// a second PDF with the same DOI attaches to the existing item
		const att2 = await importPdf(["doi: 10.1136/bmj-2023-078378"]);
		const r2 = await post("/api/add/retrieve-metadata", { attachmentKeys: [att2] });
		expect(r2.results[0]).toMatchObject({ status: "existing", itemKey: parent });
	});

	test("arXiv ID is used when there is no DOI", async () => {
		const att = await importPdf(["Attention Is All You Need", "arXiv:1706.03762v7 [cs.CL] 12 Jun 2017"]);
		const r = await post("/api/add/retrieve-metadata", { attachmentKeys: [att] });
		expect(r.results[0]).toMatchObject({ status: "retrieved", via: "arxiv" });
		expect(r.items[0].data.itemType).toBe("preprint");
	});

	test("falls back to a Crossref bibliographic query on the title", async () => {
		routes.unshift([
			/api\.crossref\.org\/works\?query\.bibliographic/,
			() => ({ message: { items: [{ DOI: "10.1136/bmj-2023-078378", title: ["Outcomes after liver transplantation"], issued: { "date-parts": [[2023]] } }] } }),
		]);
		const att = await importPdf(["Outcomes after liver transplantation", "Jane Smith and Raj Patel", "Department of Surgery"]);
		const r = await post("/api/add/retrieve-metadata", { attachmentKeys: [att] });
		expect(r.results[0]).toMatchObject({ status: "retrieved", via: "title" });
	});

	test("several PDFs at once: found ones get parents, the unidentifiable one is left alone", async () => {
		const a = await importPdf(["doi: 10.1136/bmj-2023-078378"]);
		const b = await importPdf(["Attention Is All You Need", "arXiv:1706.03762v7 [cs.CL]"]);
		const c = await importPdf(["Nothing identifiable lives in this particular document at all"]);
		const cPath = (db.query("SELECT path FROM attachments WHERE item_key = ?").get(c) as { path: string }).path;
		const r = await post("/api/add/retrieve-metadata", { attachmentKeys: [a, b, c] });
		expect(r.results.map((x: any) => x.status)).toEqual(["retrieved", "retrieved", "failed"]);
		expect(r.items.length).toBe(2);
		const parentOf = (k: string) => (db.query("SELECT parent_key FROM items WHERE key = ?").get(k) as { parent_key: string | null }).parent_key;
		expect(parentOf(a)).toBe(r.results[0].itemKey);
		expect(parentOf(b)).toBe(r.results[1].itemKey);
		// the failed PDF: still standalone, in its collection, file name untouched
		expect(parentOf(c)).toBeNull();
		expect(db.query("SELECT 1 FROM collection_items WHERE item_key = ? AND collection_key = 'COLLAAA1'").get(c)).not.toBeNull();
		expect((db.query("SELECT path FROM attachments WHERE item_key = ?").get(c) as { path: string }).path).toBe(cPath);
		expect(existsSync(cPath)).toBe(true);
	});

	test("rename:false keeps the file name", async () => {
		const att = await importPdf(["doi: 10.1136/bmj-2023-078378"]);
		const r = await post("/api/add/retrieve-metadata", { attachmentKeys: [att], rename: false });
		expect(r.results[0].status).toBe("retrieved");
		expect(r.results[0].renamed).toBeUndefined();
		expect(basename((db.query("SELECT path FROM attachments WHERE item_key = ?").get(att) as { path: string }).path)).toBe("scan.pdf");
	});

	test("a linked PDF gets a parent but its file is never renamed", async () => {
		const local = join(dir, "linked.pdf");
		writeFileSync(local, tinyPdf(["doi: 10.1136/bmj-2023-078378"]));
		const lnk = await post<ItemDetail>("/api/add/file", { mode: "linked_file", path: local }, 201);
		const r = await post("/api/add/retrieve-metadata", { attachmentKeys: [lnk.data.key] });
		expect(r.results[0].status).toBe("retrieved");
		expect(existsSync(local)).toBe(true);
		expect((db.query("SELECT path FROM attachments WHERE item_key = ?").get(lnk.data.key) as { path: string }).path).toBe(local);
	});

	test("the sync outbox records the new parent and the moved attachment; a failed lookup records nothing", async () => {
		const fail = await importPdf(["Nothing identifiable lives in this particular document at all"]);
		const att = await importPdf(["doi: 10.1136/bmj-2023-078378"]);
		db.query("DELETE FROM sync_outbox").run();
		await post("/api/add/retrieve-metadata", { attachmentKeys: [fail] });
		expect(db.query("SELECT count(*) AS n FROM sync_outbox").get()).toEqual({ n: 0 });
		const r = await post("/api/add/retrieve-metadata", { attachmentKeys: [att] });
		const rows = db.query("SELECT type, key, op FROM sync_outbox").all() as { type: string; key: string; op: string }[];
		expect(rows).toContainEqual({ type: "item", key: r.results[0].itemKey, op: "upsert" });
		expect(rows).toContainEqual({ type: "item", key: att, op: "upsert" });
	});

	test("failures: not found, not a PDF, already has a parent", async () => {
		const att = await importPdf(["Nothing identifiable lives in this particular document at all"]);
		const txt = await post<ItemDetail>("/api/add/file", { name: "a.txt", dataBase64: "AA==" }, 201);
		const r = await post("/api/add/retrieve-metadata", { attachmentKeys: [att, txt.data.key, "NOPE0000"] });
		expect(r.results.map((x: any) => x.status)).toEqual(["failed", "failed", "failed"]);
		expect(r.results[1].error).toBe("not a PDF");
		expect((await call(db, "POST", "/api/add/retrieve-metadata", { attachmentKeys: [] })).status).toBe(400);
		// untouched: still standalone
		expect((db.query("SELECT parent_key FROM items WHERE key = ?").get(att) as { parent_key: string | null }).parent_key).toBeNull();
	});
});
