import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setOpener } from "../src/api";
import { buildFixture, call, type Fixture } from "./fixture";

let fx: Fixture;
const opened: string[] = [];
beforeEach(() => {
	fx = buildFixture();
	opened.length = 0;
	setOpener({
		reveal: (p) => opened.push(`reveal:${p}`),
		openFile: (p) => opened.push(`file:${p}`),
		openUrl: (u) => opened.push(`url:${u}`),
	});
});
afterEach(() => setOpener());

const j = async (r: Response) => (await r.json()) as any;

describe("items fields= and sort", () => {
	test("fields returns requested data fields", async () => {
		const r = await j(await call(fx.db, "GET", "/api/items?fields=publicationTitle,date,DOI,itemType&sort=title&dir=asc"));
		const a = r.items.find((i: any) => i.key === "AAAAAAA1");
		expect(a.fields).toEqual({ publicationTitle: "Journal of Medical AI", date: "2020-05-01", DOI: null, itemType: "journalArticle" });
	});
	test("field names are case-insensitive and validated", async () => {
		const ok = await j(await call(fx.db, "GET", "/api/items?fields=doi"));
		expect(ok.items[0].fields).toEqual({ DOI: null });
		expect((await call(fx.db, "GET", "/api/items?fields=title);DROP TABLE items")).status).toBe(400);
		expect((await call(fx.db, "GET", "/api/items?sort=nope")).status).toBe(400);
		expect((await call(fx.db, "GET", "/api/items?sort=title'));--")).status).toBe(400);
	});
	test("no fields key without fields param", async () => {
		const r = await j(await call(fx.db, "GET", "/api/items"));
		expect(r.items[0].fields).toBeUndefined();
	});
	test("sort by itemType, dateModified, publication, counts", async () => {
		const keys = async (q: string) => (await j(await call(fx.db, "GET", `/api/items?${q}`))).items.map((i: any) => i.key);
		expect((await keys("sort=itemType&dir=asc"))[0]).toBe("BBBBBBB2"); // book < journalArticle
		expect((await keys("sort=attachmentCount&dir=desc"))[0]).toBe("AAAAAAA1");
		expect((await keys("sort=noteCount&dir=desc"))[0]).toBe("AAAAAAA1");
		expect((await keys("sort=dateModified&dir=asc")).length).toBe(3);
		// publication: only AAAAAAA1 has one; NULLs last both ways
		expect((await keys("sort=publication&dir=asc"))[0]).toBe("AAAAAAA1");
		expect((await keys("sort=publication&dir=desc"))[0]).toBe("AAAAAAA1");
	});
	test("sort by a data field puts NULLs last in both directions", async () => {
		const asc = (await j(await call(fx.db, "GET", "/api/items?sort=abstractNote&dir=asc"))).items.map((i: any) => i.key);
		const desc = (await j(await call(fx.db, "GET", "/api/items?sort=ABSTRACTNOTE&dir=desc"))).items.map((i: any) => i.key);
		expect(asc[0]).toBe("AAAAAAA1");
		expect(desc[0]).toBe("AAAAAAA1");
		const dates = (await j(await call(fx.db, "GET", "/api/items?sort=date&dir=asc&fields=date"))).items.map((i: any) => i.fields.date);
		expect(dates).toEqual(["2018", "2020-05-01", "March 2022"]);
	});
});

describe("GET /api/schema", () => {
	test("item types, ordered fields, creator types, labels", async () => {
		const s = await j(await call(fx.db, "GET", "/api/schema"));
		expect(s.version).toBeNumber();
		const ja = s.itemTypes.find((t: any) => t.itemType === "journalArticle");
		expect(ja.label).toBe("Journal Article");
		expect(ja.fields[0]).toEqual({ field: "title", label: "Title" });
		expect(ja.fields.map((f: any) => f.field)).toContain("publicationTitle");
		expect(ja.creatorTypes[0]).toMatchObject({ creatorType: "author", primary: true });
		expect(ja.creatorTypes.filter((c: any) => c.primary)).toHaveLength(1);
		const bs = s.itemTypes.find((t: any) => t.itemType === "bookSection");
		expect(bs.fields.find((f: any) => f.field === "bookTitle").baseField).toBe("publicationTitle");
		expect(s.fieldLabels.DOI).toBe("DOI");
		expect(s.itemTypes.some((t: any) => t.itemType === "annotation")).toBe(false);
		expect((await call(fx.db, "POST", "/api/schema", {})).status).toBe(405);
	});
});

describe("POST /api/items", () => {
	test("creates a top-level item with tags and collections", async () => {
		const r = await call(fx.db, "POST", "/api/items", {
			data: {
				itemType: "journalArticle",
				title: "Fresh paper",
				date: "2023-02",
				creators: [{ creatorType: "author", firstName: "A", lastName: "Newton" }],
				tags: [{ tag: "new" }],
				collections: ["COLLAAA1"],
			},
		});
		expect(r.status).toBe(201);
		const d = await j(r);
		expect(d.data.key).toMatch(/^[2-9A-NP-Z]{8}$/);
		expect(d.data.dateAdded).toBe(d.data.dateModified);
		expect(d.tags).toEqual([{ tag: "new", type: 0 }]);
		expect(d.collections).toEqual(["COLLAAA1"]);
		const list = await j(await call(fx.db, "GET", "/api/items?sort=dateAdded"));
		const it = list.items.find((i: any) => i.key === d.data.key);
		expect(it).toMatchObject({ title: "Fresh paper", creatorsSummary: "Newton", year: 2023 });
		const hits = await j(await call(fx.db, "GET", "/api/search?q=Fresh"));
		expect(hits.hits.map((h: any) => h.key)).toContain(d.data.key);
	});
	test("child note and attachment", async () => {
		const n = await j(await call(fx.db, "POST", "/api/items", { data: { itemType: "note", note: "<p>child note</p>", parentItem: "BBBBBBB2" } }));
		expect(n.data.parentItem).toBe("BBBBBBB2");
		const att = await j(
			await call(fx.db, "POST", "/api/items", {
				data: { itemType: "attachment", title: "Link", linkMode: "linked_url", url: "https://example.org", contentType: "text/html", parentItem: "BBBBBBB2" },
			}),
		);
		const parent = await j(await call(fx.db, "GET", "/api/items/BBBBBBB2"));
		expect(parent.children.map((c: any) => c.key).sort()).toEqual([n.data.key, att.data.key].sort());
		const top = await j(await call(fx.db, "GET", "/api/items?limit=100"));
		expect(top.items.some((i: any) => i.key === n.data.key)).toBe(false);
	});
	test("validation", async () => {
		const post = (data: unknown) => call(fx.db, "POST", "/api/items", { data });
		expect((await call(fx.db, "POST", "/api/items", {})).status).toBe(400);
		expect((await post({ title: "x" })).status).toBe(400);
		expect((await post({ itemType: "bogus" })).status).toBe(400);
		expect((await post({ itemType: "annotation" })).status).toBe(400);
		expect((await post({ itemType: "note", parentItem: "NOPE0000" })).status).toBe(404);
		expect((await post({ itemType: "note", parentItem: "ATT00002" })).status).toBe(400); // parent not top-level
		expect((await post({ itemType: "book", parentItem: "AAAAAAA1" })).status).toBe(400); // only notes/attachments
		expect((await post({ itemType: "book", collections: ["NOPE0000"] })).status).toBe(404);
		expect((await call(fx.db, "PUT", "/api/items", {})).status).toBe(405);
	});
	test("ignores client-supplied key and dates", async () => {
		const d = await j(await call(fx.db, "POST", "/api/items", { data: { itemType: "book", key: "AAAAAAA1", dateAdded: "1999-01-01T00:00:00Z" } }));
		expect(d.data.key).not.toBe("AAAAAAA1");
		expect(d.data.dateAdded).not.toBe("1999-01-01T00:00:00Z");
	});
});

describe("related items", () => {
	test("add links both ways with local URIs; delete removes both", async () => {
		const r = await call(fx.db, "POST", "/api/items/AAAAAAA1/related", { keys: ["BBBBBBB2", "DDDDDDD4"] });
		expect(r.status).toBe(200);
		const d = await j(r);
		expect(d.related.map((x: any) => x.key).sort()).toEqual(["BBBBBBB2", "DDDDDDD4"]);
		expect(d.related.find((x: any) => x.key === "BBBBBBB2")).toMatchObject({ itemType: "book", title: "Surgical anatomy", creatorsSummary: "Brown", year: 2018 });
		const uris = d.data.relations["dc:relation"] as string[];
		expect(uris).toHaveLength(2);
		for (const u of uris) expect(u).toMatch(/^http:\/\/zotero\.org\/users\/local\/[2-9A-Z]{8}\/items\/[2-9A-Z]{8}$/);
		const b = await j(await call(fx.db, "GET", "/api/items/BBBBBBB2"));
		expect(b.related.map((x: any) => x.key)).toEqual(["AAAAAAA1"]);
		expect(b.data.relations["dc:relation"]).toMatch(/\/items\/AAAAAAA1$/); // single relation stored as a string
		// idempotent
		const again = await j(await call(fx.db, "POST", "/api/items/AAAAAAA1/related", { keys: ["BBBBBBB2"] }));
		expect(again.data.relations["dc:relation"]).toHaveLength(2);

		const del = await j(await call(fx.db, "DELETE", "/api/items/AAAAAAA1/related", { keys: ["BBBBBBB2"] }));
		expect(del.related.map((x: any) => x.key)).toEqual(["DDDDDDD4"]);
		const b2 = await j(await call(fx.db, "GET", "/api/items/BBBBBBB2"));
		expect(b2.related).toBeUndefined();
		expect(b2.data.relations?.["dc:relation"]).toBeUndefined();
	});
	test("resolves foreign-user URIs and skips missing / trashed items", async () => {
		await call(fx.db, "PATCH", "/api/items/BBBBBBB2", {
			data: { relations: { "dc:relation": ["http://zotero.org/users/5106252/items/AAAAAAA1", "http://zotero.org/users/5106252/items/ZZZZZZZ9", "http://zotero.org/users/5106252/items/CCCCCCC3"] } },
		});
		const b = await j(await call(fx.db, "GET", "/api/items/BBBBBBB2"));
		expect(b.related.map((x: any) => x.key)).toEqual(["AAAAAAA1"]);
	});
	test("errors", async () => {
		expect((await call(fx.db, "POST", "/api/items/NOPE0000/related", { keys: ["AAAAAAA1"] })).status).toBe(404);
		expect((await call(fx.db, "POST", "/api/items/AAAAAAA1/related", { keys: ["NOPE0000"] })).status).toBe(404);
		expect((await call(fx.db, "POST", "/api/items/AAAAAAA1/related", { keys: ["AAAAAAA1"] })).status).toBe(400);
		expect((await call(fx.db, "POST", "/api/items/AAAAAAA1/related", { keys: "x" })).status).toBe(400);
		expect((await call(fx.db, "GET", "/api/items/AAAAAAA1/related")).status).toBe(405);
	});
});

describe("openers", () => {
	test("reveal and open-external use the attachment's path", async () => {
		expect((await call(fx.db, "POST", "/api/attachments/ATT00002/reveal")).status).toBe(200);
		expect((await call(fx.db, "POST", "/api/attachments/ATT00002/open-external")).status).toBe(200);
		expect(opened).toEqual([`reveal:${fx.pdfPath}`, `file:${fx.pdfPath}`]);
	});
	test("404 for missing file or attachment, 405 for GET", async () => {
		expect((await call(fx.db, "POST", "/api/attachments/ATT00001/reveal")).status).toBe(404); // no path
		expect((await call(fx.db, "POST", "/api/attachments/ATT00003/open-external")).status).toBe(404); // not on disk
		expect((await call(fx.db, "POST", "/api/attachments/NOPE0000/reveal")).status).toBe(404);
		expect((await call(fx.db, "GET", "/api/attachments/ATT00002/reveal")).status).toBe(405);
		expect(opened).toEqual([]);
	});
	test("open-url accepts http(s) and doi", async () => {
		expect((await call(fx.db, "POST", "/api/open-url", { url: "https://example.org/a?b=1&c=2" })).status).toBe(200);
		expect((await call(fx.db, "POST", "/api/open-url", { url: "http://example.org" })).status).toBe(200);
		expect((await call(fx.db, "POST", "/api/open-url", { url: "doi:10.1000/xyz 1" })).status).toBe(400); // whitespace
		expect((await call(fx.db, "POST", "/api/open-url", { url: "doi:10.1000/xyz(1)" })).status).toBe(200);
		expect(opened).toEqual(["url:https://example.org/a?b=1&c=2", "url:http://example.org/", "url:https://doi.org/10.1000/xyz(1)"]);
	});
	test("open-url rejects other schemes and junk", async () => {
		for (const url of ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "ms-msdt:/id", "calc.exe", "", "https://a.org/\nx", 5, null, "ftp://x.org"]) {
			expect((await call(fx.db, "POST", "/api/open-url", { url })).status).toBe(400);
		}
		expect((await call(fx.db, "POST", "/api/open-url", {})).status).toBe(400);
		expect((await call(fx.db, "GET", "/api/open-url")).status).toBe(405);
		expect(opened).toEqual([]);
	});
});
