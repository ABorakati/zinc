import { beforeEach, describe, expect, test } from "bun:test";
import { handleApi } from "../src/api";
import { buildFixture, call, PDF_BYTES, type Fixture } from "./fixture";

let fx: Fixture;
beforeEach(() => {
	fx = buildFixture();
});

const j = async (r: Response) => (await r.json()) as any;

describe("routing", () => {
	test("non-api returns null", async () => {
		expect(await handleApi(new Request("http://x/app/index.html"), fx.db)).toBeNull();
	});
	test("unknown api route 404 json", async () => {
		const r = await call(fx.db, "GET", "/api/nope");
		expect(r.status).toBe(404);
		expect((await j(r)).error).toBeString();
	});
	test("wrong method 405", async () => {
		expect((await call(fx.db, "DELETE", "/api/tags")).status).toBe(405);
	});
	test("bad JSON 400", async () => {
		const r = await handleApi(new Request("http://x/api/collections", { method: "POST", body: "{nope" }), fx.db);
		expect(r!.status).toBe(400);
	});
});

describe("collections", () => {
	test("list with counts", async () => {
		const list = await j(await call(fx.db, "GET", "/api/collections"));
		expect(list).toEqual([
			{ key: "COLLAAA1", name: "Radiology", parentKey: null, itemCount: 1 },
			{ key: "COLLAAA2", name: "Sub", parentKey: "COLLAAA1", itemCount: 0 },
		]);
	});
	test("create / rename / reparent / delete", async () => {
		const created = await j(await call(fx.db, "POST", "/api/collections", { name: "New", parentKey: "COLLAAA1" }));
		// Zotero's key alphabet: 2-9 and A-Z without O (I is allowed).
		expect(created.key).toMatch(/^[2-9A-NP-Z]{8}$/);
		expect(created.parentKey).toBe("COLLAAA1");
		const renamed = await j(await call(fx.db, "PATCH", `/api/collections/${created.key}`, { name: "Renamed", parentKey: null }));
		expect(renamed.name).toBe("Renamed");
		expect(renamed.parentKey).toBeNull();
		expect((await call(fx.db, "PATCH", "/api/collections/COLLAAA1", { parentKey: "COLLAAA2" })).status).toBe(400);
		expect((await call(fx.db, "DELETE", `/api/collections/${created.key}`)).status).toBe(200);
		expect((await call(fx.db, "DELETE", `/api/collections/${created.key}`)).status).toBe(404);
		expect((await call(fx.db, "POST", "/api/collections", { name: " " })).status).toBe(400);
	});
	test("add/remove items keeps data.collections in sync", async () => {
		await call(fx.db, "POST", "/api/collections/COLLAAA2/items", { keys: ["BBBBBBB2"] });
		let d = await j(await call(fx.db, "GET", "/api/items/BBBBBBB2"));
		expect(d.collections).toEqual(["COLLAAA2"]);
		expect(d.data.collections).toEqual(["COLLAAA2"]);
		await call(fx.db, "DELETE", "/api/collections/COLLAAA2/items", { keys: ["BBBBBBB2"] });
		d = await j(await call(fx.db, "GET", "/api/items/BBBBBBB2"));
		expect(d.collections).toEqual([]);
		expect(d.data.collections).toEqual([]);
		expect((await call(fx.db, "POST", "/api/collections/COLLAAA2/items", { keys: ["ZZZZZZZZ"] })).status).toBe(404);
	});
	test("deleting a collection keeps items and cleans data.collections", async () => {
		await call(fx.db, "DELETE", "/api/collections/COLLAAA1");
		const d = await j(await call(fx.db, "GET", "/api/items/AAAAAAA1"));
		expect(d.collections).toEqual([]);
		expect(d.data.collections).toEqual([]);
		expect(await j(await call(fx.db, "GET", "/api/collections"))).toEqual([]);
	});
});

describe("items", () => {
	test("list default excludes trash and children", async () => {
		const l = await j(await call(fx.db, "GET", "/api/items"));
		expect(l.total).toBe(3);
		expect(l.items.map((i: any) => i.key)).toEqual(["DDDDDDD4", "AAAAAAA1", "BBBBBBB2"]); // dateAdded desc
	});
	test("summary fields", async () => {
		const l = await j(await call(fx.db, "GET", "/api/items?sort=title&dir=asc"));
		expect(l.items.map((i: any) => i.title)).toEqual(["Deep learning for radiology", "Surgical anatomy", "Zebra genetics"]);
		const a = l.items[0];
		expect(a.creatorsSummary).toBe("Smith and Jones");
		expect(a.year).toBe(2020);
		expect(a.publication).toBe("Journal of Medical AI");
		expect(a.primaryAttachment).toEqual({ key: "ATT00002", contentType: "application/pdf" });
		expect(a.attachmentCount).toBe(2);
		expect(a.noteCount).toBe(1);
		expect(l.items[2].creatorsSummary).toBe("Lee et al.");
		expect(l.items[2].year).toBe(2022);
		expect(l.items[1].primaryAttachment).toBeNull();
	});
	test("filters", async () => {
		expect((await j(await call(fx.db, "GET", "/api/items?collection=COLLAAA1"))).items.map((i: any) => i.key)).toEqual(["AAAAAAA1"]);
		expect((await j(await call(fx.db, "GET", "/api/items?tag=imaging&sort=year&dir=asc"))).items.map((i: any) => i.key)).toEqual([
			"BBBBBBB2",
			"AAAAAAA1",
		]);
		expect((await j(await call(fx.db, "GET", "/api/items?unfiled=1&sort=creator&dir=asc"))).items.map((i: any) => i.key)).toEqual([
			"BBBBBBB2",
			"DDDDDDD4",
		]);
		expect((await j(await call(fx.db, "GET", "/api/items?trash=1"))).items.map((i: any) => i.key)).toEqual(["CCCCCCC3"]);
		expect((await j(await call(fx.db, "GET", "/api/items?q=smith 2020"))).items.map((i: any) => i.key)).toEqual(["AAAAAAA1"]);
		expect((await j(await call(fx.db, "GET", "/api/items?q=100%25"))).total).toBe(0);
	});
	test("pagination", async () => {
		const l = await j(await call(fx.db, "GET", "/api/items?sort=title&dir=asc&limit=1&offset=1"));
		expect(l.total).toBe(3);
		expect(l.items.map((i: any) => i.key)).toEqual(["BBBBBBB2"]);
	});
	test("invalid sort 400", async () => {
		expect((await call(fx.db, "GET", "/api/items?sort=bogus")).status).toBe(400);
	});
	test("detail with children", async () => {
		const d = await j(await call(fx.db, "GET", "/api/items/AAAAAAA1"));
		expect(d.data.title).toBe("Deep learning for radiology");
		const byKey = Object.fromEntries(d.children.map((c: any) => [c.key, c]));
		expect(byKey.ATT00002).toMatchObject({ itemType: "attachment", hasFile: true, annotationCount: 1, contentType: "application/pdf" });
		expect(byKey.ATT00001).toMatchObject({ hasFile: false, annotationCount: 0 });
		expect(byKey.NOTE0001.itemType).toBe("note");
		expect(d.collections).toEqual(["COLLAAA1"]);
		expect(d.tags.map((t: any) => t.tag)).toEqual(["imaging", "ml"]);
		const d4 = await j(await call(fx.db, "GET", "/api/items/DDDDDDD4"));
		expect(d4.children[0].hasFile).toBe(false);
		expect((await call(fx.db, "GET", "/api/items/NOPE0000")).status).toBe(404);
	});
	test("patch merges data, updates columns and search", async () => {
		const r = await call(fx.db, "PATCH", "/api/items/BBBBBBB2", {
			data: { title: "Quantum Gravity", date: "1999", creators: [{ creatorType: "author", lastName: "Hawking" }] },
		});
		const d = await j(r);
		expect(d.data.title).toBe("Quantum Gravity");
		expect(d.data.dateModified).not.toBe("2024-01-01T00:00:00Z");
		const l = await j(await call(fx.db, "GET", "/api/items?q=hawking"));
		expect(l.items[0]).toMatchObject({ key: "BBBBBBB2", title: "Quantum Gravity", year: 1999, creatorsSummary: "Hawking" });
		const s = await j(await call(fx.db, "GET", "/api/search?q=gravity"));
		expect(s.hits.map((h: any) => h.key)).toEqual(["BBBBBBB2"]);
		const s2 = await j(await call(fx.db, "GET", "/api/search?q=surgical"));
		expect(s2.total).toBe(0);
		expect((await call(fx.db, "PATCH", "/api/items/BBBBBBB2", {})).status).toBe(400);
		expect((await call(fx.db, "PATCH", "/api/items/NOPE0000", { data: {} })).status).toBe(404);
	});
	test("patch itemType converts fields and creators like Zotero", async () => {
		// DDDDDDD4 is a journalArticle by Lee, Kim and Park.
		await call(fx.db, "PATCH", "/api/items/DDDDDDD4", { data: { publicationTitle: "Proc. Genetics", volume: "12", issue: "3" } });
		const d = await j(await call(fx.db, "PATCH", "/api/items/DDDDDDD4", { data: { itemType: "bookSection" } }));
		expect(d.data.itemType).toBe("bookSection");
		expect(d.data.bookTitle).toBe("Proc. Genetics"); // publicationTitle shares the base field
		expect(d.data.publicationTitle).toBeUndefined();
		expect(d.data.volume).toBe("12");
		expect(d.data.issue).toBeUndefined(); // book sections have no issue
		expect(d.data.creators.map((c: any) => c.creatorType)).toEqual(["author", "author", "author"]);
		const l = await j(await call(fx.db, "GET", "/api/items?q=zebra%20genetics&fields=itemType"));
		expect(l.items[0].itemType).toBe("bookSection");
		const back = await j(await call(fx.db, "PATCH", "/api/items/DDDDDDD4", { data: { itemType: "journalArticle" } }));
		expect(back.data.publicationTitle).toBe("Proc. Genetics");
		expect((await call(fx.db, "PATCH", "/api/items/DDDDDDD4", { data: { itemType: "nonsense" } })).status).toBe(400);
		expect((await call(fx.db, "PATCH", "/api/items/DDDDDDD4", { data: { itemType: "note" } })).status).toBe(400);
	});
	test("patch deleted moves to trash and restores", async () => {
		const before = (await j(await call(fx.db, "GET", "/api/items"))).total;
		let d = await j(await call(fx.db, "PATCH", "/api/items/BBBBBBB2", { data: { deleted: 1 } }));
		expect(d.data.deleted).toBe(1);
		expect((await j(await call(fx.db, "GET", "/api/items"))).total).toBe(before - 1);
		const trash = await j(await call(fx.db, "GET", "/api/items?trash=1"));
		expect(trash.items.map((i: any) => i.key)).toContain("BBBBBBB2");
		d = await j(await call(fx.db, "PATCH", "/api/items/BBBBBBB2", { data: { deleted: 0 } }));
		expect(d.data.deleted).toBeUndefined();
		expect((await j(await call(fx.db, "GET", "/api/items"))).total).toBe(before);
	});
	test("tags add/remove sync data and search", async () => {
		await call(fx.db, "POST", "/api/items/BBBBBBB2/tags", { tags: ["newtag", " spaced ", "imaging"] });
		let d = await j(await call(fx.db, "GET", "/api/items/BBBBBBB2"));
		expect(d.tags.map((t: any) => t.tag).sort()).toEqual(["imaging", "newtag", "spaced"]);
		expect(d.data.tags.map((t: any) => t.tag).sort()).toEqual(["imaging", "newtag", "spaced"]);
		expect((await j(await call(fx.db, "GET", "/api/search?q=newtag"))).total).toBe(1);
		await call(fx.db, "DELETE", "/api/items/BBBBBBB2/tags", { tags: ["newtag"] });
		d = await j(await call(fx.db, "GET", "/api/items/BBBBBBB2"));
		expect(d.data.tags.map((t: any) => t.tag).sort()).toEqual(["imaging", "spaced"]);
		expect((await j(await call(fx.db, "GET", "/api/search?q=newtag"))).total).toBe(0);
		const tags = await j(await call(fx.db, "GET", "/api/tags"));
		expect(tags.find((t: any) => t.tag === "imaging").count).toBe(2);
		expect((await call(fx.db, "POST", "/api/items/BBBBBBB2/tags", { tags: "x" })).status).toBe(400);
	});
});

describe("annotations and view state", () => {
	test("annotation roundtrip", async () => {
		const ann = { id: "ANNO0002", type: "note", sortIndex: "00000|000000|00000", position: { pageIndex: 0 }, comment: "hi", dateModified: "2025-01-01T00:00:00Z" };
		expect((await call(fx.db, "PUT", "/api/attachments/ATT00002/annotations", [ann])).status).toBe(200);
		let list = await j(await call(fx.db, "GET", "/api/attachments/ATT00002/annotations"));
		expect(list.map((a: any) => a.id)).toEqual(["ANNO0002", "ANNO0001"]); // sorted by sortIndex
		await call(fx.db, "PUT", "/api/attachments/ATT00002/annotations", [{ ...ann, comment: "changed" }]);
		list = await j(await call(fx.db, "GET", "/api/attachments/ATT00002/annotations"));
		expect(list.find((a: any) => a.id === "ANNO0002").comment).toBe("changed");
		await call(fx.db, "DELETE", "/api/attachments/ATT00002/annotations", { ids: ["ANNO0002", "ANNO0001"] });
		expect(await j(await call(fx.db, "GET", "/api/attachments/ATT00002/annotations"))).toEqual([]);
		expect((await call(fx.db, "PUT", "/api/attachments/ATT00002/annotations", [{ type: "x" }])).status).toBe(400);
		expect((await call(fx.db, "GET", "/api/attachments/AAAAAAA1/annotations")).status).toBe(404);
	});
	test("view state", async () => {
		expect(await j(await call(fx.db, "GET", "/api/attachments/ATT00002/view-state"))).toBeNull();
		await call(fx.db, "PUT", "/api/attachments/ATT00002/view-state", { pageIndex: 4, scale: "page-width" });
		expect(await j(await call(fx.db, "GET", "/api/attachments/ATT00002/view-state"))).toEqual({ pageIndex: 4, scale: "page-width" });
	});
});

describe("attachment file", () => {
	test("full file", async () => {
		const r = await call(fx.db, "GET", "/api/attachments/ATT00002/file");
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toBe("application/pdf");
		expect(r.headers.get("accept-ranges")).toBe("bytes");
		expect(new Uint8Array(await r.arrayBuffer())).toEqual(PDF_BYTES);
	});
	test("missing file / no path 404", async () => {
		expect((await call(fx.db, "GET", "/api/attachments/ATT00001/file")).status).toBe(404);
		expect((await call(fx.db, "GET", "/api/attachments/ATT00003/file")).status).toBe(404);
		expect((await call(fx.db, "GET", "/api/attachments/NOPE0000/file")).status).toBe(404);
	});
	test("range requests", async () => {
		const get = (range: string) => call(fx.db, "GET", "/api/attachments/ATT00002/file", undefined, { Range: range });
		let r = await get("bytes=0-99");
		expect(r.status).toBe(206);
		expect(r.headers.get("content-range")).toBe("bytes 0-99/1000");
		expect(r.headers.get("content-length")).toBe("100");
		expect(new Uint8Array(await r.arrayBuffer())).toEqual(PDF_BYTES.slice(0, 100));
		r = await get("bytes=900-");
		expect(r.status).toBe(206);
		expect(r.headers.get("content-range")).toBe("bytes 900-999/1000");
		expect(new Uint8Array(await r.arrayBuffer())).toEqual(PDF_BYTES.slice(900));
		r = await get("bytes=-50");
		expect(r.headers.get("content-range")).toBe("bytes 950-999/1000");
		expect(new Uint8Array(await r.arrayBuffer())).toEqual(PDF_BYTES.slice(950));
		r = await get("bytes=990-5000");
		expect(r.headers.get("content-range")).toBe("bytes 990-999/1000");
		r = await get("bytes=1000-1100");
		expect(r.status).toBe(416);
		expect(r.headers.get("content-range")).toBe("bytes */1000");
	});
});
