import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { citeService, handleCiteApi } from "../../src/cite/api";
import { openDb } from "../../src/db";
import { insertItem, tempDir } from "../fixture";

const FIX = join(import.meta.dir, "fixtures");
const read = (f: string) => readFileSync(join(FIX, f), "utf8");

const DEPENDENT = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" class="in-text" default-locale="en-US">
  <info><title>Vancouver Dependent</title><id>http://www.zotero.org/styles/vancouver-dep</id>
  <link href="http://www.zotero.org/styles/vancouver-dep" rel="self"/>
  <link href="http://www.zotero.org/styles/vancouver" rel="independent-parent"/>
  <updated>2020-01-01T00:00:00+00:00</updated></info>
</style>`;

const INDEX = JSON.stringify([
	{ title: "Vancouver", name: "vancouver", dependent: 0, categories: { format: "numeric" } },
	{ title: "Vancouver Dependent", name: "vancouver-dep", dependent: 1, categories: { format: "numeric" } },
	{
		title: "American Psychological Association 7th edition",
		name: "apa",
		titleShort: "APA",
		dependent: 0,
		categories: { format: "author-date" },
	},
	{ title: "Journal of Obscure Studies", name: "obscure", dependent: 1 },
]);

let db: Database;
let dir: string;
let calls: string[];
let offline = false;

const mockFetch = async (url: string): Promise<Response> => {
	calls.push(url);
	if (offline) throw new Error("offline");
	if (url.endsWith("/styles/vancouver")) return new Response(read("vancouver.csl"));
	if (url.endsWith("/styles/apa")) return new Response(read("apa.csl"));
	if (url.endsWith("/styles/vancouver-dep")) return new Response(DEPENDENT);
	if (url.endsWith("/styles/missing")) return new Response("nope", { status: 404 });
	if (url.endsWith("locales-en-US.xml")) return new Response(read("locales-en-US.xml"));
	if (url.endsWith("styles.json")) return new Response(INDEX);
	return new Response("nope", { status: 404 });
};

beforeAll(() => {
	dir = tempDir();
	db = openDb(join(dir, "library.sqlite"));
	insertItem(db, {
		key: "JOURNAL1",
		itemType: "journalArticle",
		title: "Enhanced recovery after surgery in liver transplantation",
		creators: [
			{ creatorType: "author", firstName: "Jane", lastName: "Smith" },
			{ creatorType: "author", firstName: "Alan B", lastName: "Jones" },
		],
		publicationTitle: "New England Journal of Medicine",
		journalAbbreviation: "N Engl J Med",
		volume: "382",
		issue: "5",
		pages: "123-130",
		date: "2020-03-15",
		DOI: "10.1000/xyz123",
	});
	insertItem(db, {
		key: "BOOK0001",
		itemType: "book",
		title: "Principles of Surgery",
		creators: [{ creatorType: "author", firstName: "Seymour", lastName: "Schwartz" }],
		publisher: "McGraw-Hill",
		place: "New York",
		date: "2019",
		edition: "11",
	});
	insertItem(
		db,
		{
			key: "ATTACH01",
			itemType: "attachment",
			title: "x.pdf",
			parentItem: "JOURNAL1",
			linkMode: "imported_file",
			contentType: "application/pdf",
		},
		"JOURNAL1",
	);
	insertItem(db, { key: "TRASHED1", itemType: "book", title: "Gone", date: "2000" }, undefined, 1);
});

afterAll(() => db.close(true));

describe("styles", () => {
	test("install caches on disk and fetches only once", async () => {
		calls = [];
		const svc = citeService(db, { dir, fetch: mockFetch });
		const info = await svc.store.install("vancouver");
		expect(info).toMatchObject({ id: "vancouver", installed: true, dependent: false });
		expect(info.title).toContain("Vancouver");
		expect(svc.store.isInstalled("vancouver")).toBe(true);
		expect(readFileSync(join(dir, "styles", "vancouver.csl"), "utf8")).toContain("<style");
		const n = calls.length;
		await svc.store.install("vancouver");
		await svc.store.styleXml("vancouver");
		expect(calls.length).toBe(n);
	});

	test("dependent style installs its parent", async () => {
		calls = [];
		const d2 = tempDir();
		const svc = citeService(db, { dir: d2, fetch: mockFetch });
		const info = await svc.store.install("vancouver-dep");
		expect(info.dependent).toBe(true);
		expect(svc.store.isInstalled("vancouver")).toBe(true);
		expect(calls.some((c) => c.endsWith("/styles/vancouver"))).toBe(true);
	});

	test("unknown style is a 404, bad id a 400", async () => {
		const svc = citeService(db, { dir: tempDir(), fetch: mockFetch });
		await expect(svc.store.install("missing")).rejects.toMatchObject({ status: 404 });
		await expect(svc.store.install("../etc/passwd")).rejects.toMatchObject({ status: 400 });
	});

	test("search: defaults, query, installed flag, index cached", async () => {
		calls = [];
		const d2 = tempDir();
		const svc = citeService(db, { dir: d2, fetch: mockFetch });
		const defaults = await svc.store.search("");
		expect(defaults.map((s) => s.id).slice(0, 3)).toEqual(["vancouver", "apa", "nature"]);
		const hits = await svc.store.search("vancouv");
		expect(hits[0]!.id).toBe("vancouver"); // independent before dependent
		expect(hits.map((h) => h.id)).toContain("vancouver-dep");
		expect((await svc.store.search("apa"))[0]).toMatchObject({ id: "apa", titleShort: "APA", format: "author-date" });
		expect(calls.filter((c) => c.endsWith("styles.json")).length).toBe(1);
		await svc.store.install("apa");
		expect((await svc.store.search("apa"))[0]!.installed).toBe(true);
	});

	test("search works offline from defaults", async () => {
		offline = true;
		try {
			const svc = citeService(db, { dir: tempDir(), fetch: mockFetch });
			const r = await svc.store.search("lancet");
			expect(r[0]).toMatchObject({ id: "the-lancet" });
		} finally {
			offline = false;
		}
	});
});

describe("format", () => {
	test("Vancouver bibliography (text + html)", async () => {
		const svc = citeService(db, { dir, fetch: mockFetch });
		const r = await svc.format(db, { keys: ["JOURNAL1", "BOOK0001"], style: "vancouver", format: ["text", "html"] });
		expect(r.keys).toEqual(["JOURNAL1", "BOOK0001"]);
		expect(r.text).toContain(
			"1. Smith J, Jones AB. Enhanced recovery after surgery in liver transplantation. N Engl J Med. 2020 Mar 15;382(5):123–30. doi:10.1000/xyz123",
		);
		expect(r.text).toContain("2. Schwartz S. Principles of Surgery. 11th ed. New York: McGraw-Hill; 2019.");
		expect(r.html).toContain('<div class="csl-bib-body">');
		expect(r.html).toContain('<div class="csl-entry">');
	});

	test("APA bibliography and citation", async () => {
		const svc = citeService(db, { dir, fetch: mockFetch });
		const r = await svc.format(db, { keys: ["JOURNAL1"], style: "apa", format: ["text", "html"] });
		expect(r.text).toContain(
			"Smith, J., & Jones, A. B. (2020). Enhanced recovery after surgery in liver transplantation. New England Journal of Medicine, 382(5), 123–130.",
		);
		expect(r.text).toContain("https://doi.org/10.1000/xyz123");
		expect(r.html).toContain("<i>New England Journal of Medicine</i>");
		const c = await svc.format(db, { keys: ["JOURNAL1", "BOOK0001"], style: "apa", mode: "citation", format: "text" });
		expect(c.text).toBe("(Schwartz, 2019; Smith & Jones, 2020)");
		const v = await svc.format(db, { keys: ["JOURNAL1", "BOOK0001"], style: "vancouver", mode: "citation", format: "text" });
		expect(v.text).toBe("(1,2)");
	});

	test("rtf output has a full header", async () => {
		const svc = citeService(db, { dir, fetch: mockFetch });
		const r = await svc.format(db, { keys: ["JOURNAL1"], style: "apa", format: "rtf" });
		expect(r.rtf!.startsWith("{\\rtf1\\ansi")).toBe(true);
		expect(r.rtf!.endsWith("}")).toBe(true);
	});

	test("children resolve to parents, duplicates/trashed/missing dropped, empty -> 404", async () => {
		const svc = citeService(db, { dir, fetch: mockFetch });
		const r = await svc.format(db, { keys: ["ATTACH01", "JOURNAL1", "TRASHED1", "NOPE1234"], style: "vancouver", format: "text" });
		expect(r.keys).toEqual(["JOURNAL1"]);
		await expect(svc.format(db, { keys: ["TRASHED1"], style: "vancouver" })).rejects.toMatchObject({ status: 404 });
	});

	test("dependent style formats like its parent", async () => {
		const svc = citeService(db, { dir, fetch: mockFetch });
		const a = await svc.format(db, { keys: ["JOURNAL1"], style: "vancouver-dep", format: "text" });
		const b = await svc.format(db, { keys: ["JOURNAL1"], style: "vancouver", format: "text" });
		expect(a.text).toBe(b.text);
	});
});

describe("HTTP routes", () => {
	const call = async (method: string, path: string, body?: unknown) => {
		// the handler builds its service from the db, which uses the real fetch: install the mock service first
		citeService(db, { dir, fetch: mockFetch });
		const res = await handleCiteApi(
			new Request("http://x" + path, {
				method,
				headers: { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			db,
		);
		return { status: res!.status, json: (await res!.json()) as any };
	};

	test("non-cite paths are not handled", async () => {
		expect(await handleCiteApi(new Request("http://x/api/items"), db)).toBeNull();
	});

	test("settings round trip and validation", async () => {
		// handler uses the service registered for this db; make sure it is the dir-bound one
		const s0 = await call("GET", "/api/cite/settings");
		expect(s0.json).toEqual({ quickCopy: { style: "vancouver", locale: "", mode: "bibliography", format: "html" } });
		const s1 = await call("PUT", "/api/cite/settings", { quickCopy: { style: "apa", mode: "citation" } });
		expect(s1.json.quickCopy).toEqual({ style: "apa", locale: "", mode: "citation", format: "html" });
		expect((await call("GET", "/api/cite/settings")).json.quickCopy.style).toBe("apa");
		expect((await call("PUT", "/api/cite/settings", { quickCopy: { mode: "bogus" } })).status).toBe(400);
		await call("PUT", "/api/cite/settings", { quickCopy: { style: "vancouver", mode: "bibliography" } });
	});

	test("format + styles routes", async () => {
		const f = await call("POST", "/api/cite/format", { keys: ["JOURNAL1"], style: "vancouver", format: "text" });
		expect(f.status).toBe(200);
		expect(f.json.text).toContain("Smith J, Jones AB.");
		expect((await call("POST", "/api/cite/format", { keys: [] })).status).toBe(400);
		expect((await call("POST", "/api/cite/format", { keys: ["JOURNAL1"], format: "pdf" })).status).toBe(400);
		expect((await call("POST", "/api/cite/styles", { id: "missing" })).status).toBe(404);
		const inst = await call("POST", "/api/cite/styles", { id: "apa" });
		expect(inst.json).toMatchObject({ id: "apa", installed: true });
		const list = await call("GET", "/api/cite/styles?q=apa");
		expect(list.json[0].id).toBe("apa");
	});
});
