// BBT's HTTP endpoints on the Zotero port (a test port, never 23119): cayw, json-rpc, pull exports.
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { setCawyPicker, setSelectionProvider } from "../../src/bbt";
import { addItemsToCollection, createCollection, openDb } from "../../src/db";
import { startZoteroPort } from "../../src/zport";
import { insertItem, tempDir } from "../fixture";

const PORT = 23477;
const BASE = `http://127.0.0.1:${PORT}`;
let db: Database;
let zport: ReturnType<typeof startZoteroPort>;
let collKey: string;

beforeAll(() => {
	db = openDb(join(tempDir(), "lib.sqlite"));
	insertItem(db, { key: "AAAAAAA1", itemType: "journalArticle", title: "Deep learning for radiology", creators: [{ creatorType: "author", firstName: "Ann", lastName: "Smith" }], date: "2020-05-01", dateAdded: "2024-01-01T00:00:00Z", tags: [{ tag: "ml" }] });
	insertItem(db, { key: "BBBBBBB2", itemType: "book", title: "Surgical anatomy", creators: [{ creatorType: "author", firstName: "Cara", lastName: "Brown" }], date: "2018", dateAdded: "2024-01-02T00:00:00Z", citationKey: "brown-anatomy" });
	insertItem(db, { key: "NOTE0001", itemType: "note", note: "<p>my note</p>", parentItem: "AAAAAAA1" }, "AAAAAAA1");
	insertItem(db, { key: "ATT00001", itemType: "attachment", title: "pdf", contentType: "application/pdf", linkMode: "imported_file", parentItem: "AAAAAAA1" }, "AAAAAAA1");
	db.query("INSERT INTO attachments(item_key, link_mode, content_type, path) VALUES('ATT00001', 'imported_file', 'application/pdf', 'C:/x/p.pdf')").run();
	collKey = createCollection(db, "Thesis").key;
	addItemsToCollection(db, collKey, ["AAAAAAA1"]);
	zport = startZoteroPort(db, { port: PORT });
});
afterAll(() => {
	zport.stop();
	setSelectionProvider(null);
	setCawyPicker(null);
});

const get = (path: string, init?: RequestInit) => fetch(`${BASE}${path}`, init);
const rpc = async (method: string, params?: unknown) => (await (await get("/better-bibtex/json-rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 7 }) })).json()) as any;

const KEY_A = "smithDeepLearningRadiology2020";

describe("cayw", () => {
	test("probe answers ready without a picker (both ?probe and ?probe=1)", async () => {
		expect(await (await get("/better-bibtex/cayw?probe")).text()).toBe("ready");
		expect(await (await get("/better-bibtex/cayw?probe=true")).text()).toBe("ready");
	});

	test("explicit items in the common formats", async () => {
		const f = async (q: string) => (await get(`/better-bibtex/cayw?${q}`)).text();
		expect(await f(`items=${KEY_A}&format=latex`)).toBe(`\\cite{${KEY_A}}`);
		expect(await f(`items=${KEY_A},brown-anatomy&format=cite`)).toBe(`\\cite{${KEY_A},brown-anatomy}`);
		expect(await f(`items=${KEY_A}&format=citep`)).toBe(`\\citep{${KEY_A}}`);
		expect(await f(`items=${KEY_A}&format=biblatex`)).toBe(`\\autocite{${KEY_A}}`);
		expect(await f(`items=${KEY_A}&format=biblatex&command=parencite`)).toBe(`\\parencite{${KEY_A}}`);
		expect(await f(`items=${KEY_A},brown-anatomy&format=pandoc`)).toBe(`@${KEY_A}; @brown-anatomy`);
		expect(await f(`items=${KEY_A},brown-anatomy&format=pandoc&brackets=1`)).toBe(`[@${KEY_A}; @brown-anatomy]`);
		expect(await f(`items=brown-anatomy&format=mmd`)).toBe("[#brown-anatomy][]");
		expect(await f(`items=brown-anatomy&format=typst`)).toBe("@brown-anatomy");
		expect(await f(`items=brown-anatomy&format=scannable-cite`)).toContain("zotero://select/library/items/BBBBBBB2");
	});

	test("an item key works as well as a citation key; json gives the pick data", async () => {
		const r = await (await get("/better-bibtex/cayw?items=BBBBBBB2&format=json")).json() as any[];
		expect(r[0].citationKey).toBe("brown-anatomy");
		expect(r[0].itemData.title).toBe("Surgical anatomy");
	});

	test("translate exports the picks", async () => {
		const t = await (await get(`/better-bibtex/cayw?items=brown-anatomy&format=translate&translator=biblatex`)).text();
		expect(t).toContain("@book{brown-anatomy,");
	});

	test("selected uses the app's selection", async () => {
		setSelectionProvider(() => ["AAAAAAA1"]);
		expect(await (await get("/better-bibtex/cayw?selected=1&format=pandoc&brackets=1")).text()).toBe(`[@${KEY_A}]`);
	});

	test("without a picker and without items the answer is a clear 503; with a picker the picks are formatted (locator, prefix, suffix)", async () => {
		const none = await get("/better-bibtex/cayw?format=pandoc");
		expect(none.status).toBe(503);
		setCawyPicker(async () => [{ itemKey: "BBBBBBB2", citationKey: "brown-anatomy", locator: "12", prefix: "see", suffix: "passim" }]);
		expect(await (await get("/better-bibtex/cayw?format=pandoc&brackets=1")).text()).toBe("[see @brown-anatomy, p. 12 passim]");
		expect(await (await get("/better-bibtex/cayw?format=latex")).text()).toBe("\\cite[see][p. 12 passim]{brown-anatomy}");
		setCawyPicker(async () => null);
		expect(await (await get("/better-bibtex/cayw?format=pandoc")).text()).toBe("");
	});

	test("unknown citation keys and formats are errors", async () => {
		expect((await get("/better-bibtex/cayw?items=nosuchkey")).status).toBe(404);
		expect((await get(`/better-bibtex/cayw?items=${KEY_A}&format=nonsense`)).status).toBe(400);
	});

	test("browsers (a web-page Origin) are refused", async () => {
		const r = await get("/better-bibtex/cayw?probe", { headers: { Origin: "https://evil.example" } });
		expect(r.status).toBe(403);
	});
});

describe("json-rpc", () => {
	test("api.ready and user.groups", async () => {
		const r = await rpc("api.ready");
		expect(r.jsonrpc).toBe("2.0");
		expect(r.id).toBe(7);
		expect(r.result.betterbibtex).toBeTruthy();
		const g = await rpc("user.groups", [true]);
		expect(g.result[0].name).toBe("My Library");
		expect(g.result[0].collections[0].name).toBe("Thesis");
	});

	test("item.search by string returns CSL with citekey and library", async () => {
		const r = await rpc("item.search", ["radiology"]);
		expect(r.result).toHaveLength(1);
		expect(r.result[0].citekey).toBe(KEY_A);
		expect(r.result[0].library).toBe("My Library");
		expect(r.result[0].title).toBe("Deep learning for radiology");
		expect(r.result[0].id).toContain("AAAAAAA1");
		// matches citation keys too
		expect((await rpc("item.search", ["brown-anat"])).result).toHaveLength(1);
		expect((await rpc("item.search", [""])).result).toHaveLength(2);
	});

	test("item.search with condition tuples", async () => {
		const r = await rpc("item.search", [[["creator", "contains", "brown"]]]);
		expect(r.result.map((x: any) => x.citekey)).toEqual(["brown-anatomy"]);
		const any = await rpc("item.search", [[["joinMode", "any"], ["creator", "contains", "brown"], ["title", "contains", "radiology"]]]);
		expect(any.result).toHaveLength(2);
		expect((await rpc("item.search", [[["tag", "is", "ml"]]])).result).toHaveLength(1);
	});

	test("item.citationkey maps item keys to citation keys (null when unknown) and accepts object params", async () => {
		const r = await rpc("item.citationkey", [["AAAAAAA1", "1:BBBBBBB2", "ZZZZZZZZ"]]);
		expect(r.result).toEqual({ AAAAAAA1: KEY_A, "1:BBBBBBB2": "brown-anatomy", ZZZZZZZZ: null });
		const o = await rpc("item.citationkey", { item_keys: ["AAAAAAA1"] });
		expect(o.result).toEqual({ AAAAAAA1: KEY_A });
		setSelectionProvider(() => ["BBBBBBB2"]);
		expect((await rpc("item.citationkey", ["selected"])).result).toEqual({ BBBBBBB2: "brown-anatomy" });
	});

	test("item.export", async () => {
		const r = await rpc("item.export", [[KEY_A], "Better BibLaTeX"]);
		expect(r.result).toContain(`@article{${KEY_A},`);
		const c = await rpc("item.export", [["brown-anatomy"], "betterbibtex"]);
		expect(c.result).toContain("@book{brown-anatomy,");
		const bad = await rpc("item.export", [["nope", KEY_A], "biblatex"]);
		expect(bad.error.code).toBe(-32602);
		expect(bad.error.message).toContain("not found: nope");
		const csl = await rpc("items.export", [[KEY_A], "Better CSL JSON"]); // items.* alias
		expect(JSON.parse(csl.result)[0].id).toBe(KEY_A);
	});

	test("item.attachments, item.notes, item.collections", async () => {
		expect((await rpc("item.attachments", [KEY_A])).result).toEqual([{ open: "zotero://open-pdf/library/items/ATT00001", path: "C:/x/p.pdf" }]);
		expect((await rpc("item.notes", [[KEY_A]])).result[KEY_A]).toEqual(["<p>my note</p>"]);
		expect((await rpc("item.collections", [[KEY_A]])).result[KEY_A][0].name).toBe("Thesis");
	});

	test("item.regenerate_key", async () => {
		db.query("UPDATE items SET data = json_set(data, '$.date', '2021') WHERE key = 'AAAAAAA1'").run();
		const r = await rpc("item.regenerate_key", [[KEY_A, "unknownkey"]]);
		expect(r.result.unknownkey).toBeNull();
		db.query("UPDATE items SET data = json_set(data, '$.date', '2020-05-01') WHERE key = 'AAAAAAA1'").run();
	});

	test("errors: unknown method, invalid request, parse error, batches", async () => {
		expect((await rpc("no.such")).error.code).toBe(-32601);
		const bad = (await (await get("/better-bibtex/json-rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: "x" }) })).json()) as any;
		expect(bad.error.code).toBe(-32600);
		const parse = (await (await get("/better-bibtex/json-rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" })).json()) as any;
		expect(parse.error.code).toBe(-32700);
		const batch = (await (await get("/better-bibtex/json-rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([{ jsonrpc: "2.0", method: "api.ready", id: 1 }, { jsonrpc: "2.0", method: "user.groups", id: 2 }]) })).json()) as any[];
		expect(batch.map((b) => b.id)).toEqual([1, 2]);
		const lib = await rpc("item.search", ["x", "Some Group"]);
		expect(lib.error.message).toContain("could not find library");
	});

	test("GET with the request in the query string", async () => {
		const q = encodeURIComponent(JSON.stringify({ jsonrpc: "2.0", method: "api.ready", id: 3 }));
		const r = (await (await get(`/better-bibtex/json-rpc?${q}`)).json()) as any;
		expect(r.id).toBe(3);
		expect(r.result.betterbibtex).toBeTruthy();
	});

	test("collection.scanAUX fills a collection from an .aux file", async () => {
		const aux = join(tempDir(), "t.aux");
		await Bun.write(aux, `\\citation{${KEY_A},brown-anatomy}\n\\citation{missingkey}\n`);
		const r = await rpc("collection.scanAUX", ["/My Library/Papers/Chapter1", aux]);
		expect(r.result.libraryID).toBe(1);
		const n = db.query("SELECT count(*) AS n FROM collection_items WHERE collection_key = ?").get(r.result.key) as { n: number };
		expect(n.n).toBe(2);
	});
});

describe("pull exports", () => {
	test("library", async () => {
		const r = await get("/better-bibtex/export/library?/0/library.biblatex");
		expect(r.status).toBe(200);
		const t = await r.text();
		expect(t).toContain(`@article{${KEY_A},`);
		expect(t).toContain("@book{brown-anatomy,");
		expect((await (await get("/better-bibtex/library?/1/library.bibtex")).text())).toContain("@book{brown-anatomy,");
		expect(JSON.parse(await (await get("/better-bibtex/export/library?/0/library.json")).text())).toHaveLength(2);
		expect(await (await get("/better-bibtex/export/library?/0/library.yaml")).text()).toStartWith("---\nreferences:");
		expect((await get("/better-bibtex/export/library?/0/library.nonsense")).status).toBe(404);
	});

	test("collection by key and by path", async () => {
		const byKey = await (await get(`/better-bibtex/export/collection?/0/${collKey}.biblatex`)).text();
		expect(byKey).toContain(`@article{${KEY_A},`);
		expect(byKey).not.toContain("brown-anatomy");
		expect(await (await get(`/better-bibtex/collection?/1/My%20Library/Thesis.bibtex`)).text()).toContain(`@article{${KEY_A},`);
		expect((await get("/better-bibtex/export/collection?/0/NoSuchColl.bib")).status).toBe(404);
	});

	test("item with citation keys, optionally as pandoc filter data", async () => {
		const t = await (await get(`/better-bibtex/export/item?libraryID=1&citationKeys=${KEY_A}&translator=biblatex`)).text();
		expect(t).toContain(`@article{${KEY_A},`);
		const p = JSON.parse(await (await get(`/better-bibtex/export/item?libraryID=1&citationKeys=${KEY_A},missing&translator=json&pandocFilterData=true`)).text());
		expect(p.errors.missing).toBe("not found");
		expect(p.items[KEY_A].title).toBe("Deep learning for radiology");
		expect(p.zotero[KEY_A].itemID).toBe("AAAAAAA1");
	});

	test("selected, and the URL form BBT shows for downloads", async () => {
		setSelectionProvider(() => ["BBBBBBB2"]);
		expect(await (await get("/better-bibtex/export/selected?biblatex")).text()).toContain("@book{brown-anatomy,");
		const d = await get("/better-bibtex/export?/library;id:1/My%20Library.bibtex");
		expect(d.headers.get("content-disposition")).toContain("My Library.bibtex");
		expect(await d.text()).toContain("@article{");
	});

	test("exportNotes", async () => {
		const t = await (await get("/better-bibtex/export/library?/0/library.biblatex&exportNotes=true")).text();
		expect(t).toContain("note = {my note}");
	});
});
