import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { citeService, handleCiteApi } from "../../src/cite/api";
import { StyleStore } from "../../src/cite/engine";
import { openDb } from "../../src/db";
import { insertItem, tempDir } from "../fixture";

const FIX = join(import.meta.dir, "fixtures");
const read = (f: string) => readFileSync(join(FIX, f), "utf8");

const dependent = (id: string, parent: string, title: string) => `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" class="in-text" default-locale="en-US">
  <info><title>${title}</title><id>http://www.zotero.org/styles/${id}</id>
  <link href="http://www.zotero.org/styles/${id}" rel="self"/>
  <link href="http://www.zotero.org/styles/${parent}" rel="independent-parent"/>
  <category citation-format="numeric"/><category field="medicine"/>
  <updated>2020-01-01T00:00:00+00:00</updated></info>
</style>`;

type E = {
	title: string;
	name: string;
	titleShort?: string;
	dependent: number;
	categories: { format?: string; fields?: string[] };
	updated?: string;
};
const entry = (name: string, title: string, format: string | undefined, fields: string[], dep = 0, titleShort?: string): E => ({
	title,
	name,
	titleShort,
	dependent: dep,
	categories: { format, fields },
	updated: "2024-01-01 00:00:00",
});
const INDEX: E[] = [
	entry("vancouver", "Vancouver", "numeric", ["medicine"]),
	entry("vancouver-dep", "Vancouver Dependent", "numeric", ["medicine"], 1),
	entry("apa", "American Psychological Association 7th edition", "author-date", ["psychology", "social_science"], 0, "APA"),
	entry("nature", "Nature", "numeric", ["science"]),
	entry("nature-communications", "Nature Communications", "numeric", ["science"], 1),
	entry("the-lancet", "The Lancet", "numeric", ["medicine"]),
	entry("lancet-oncology", "The Lancet Oncology", "numeric", ["medicine"], 1),
	entry("chicago-note", "Chicago Manual of Style (note)", "note", ["generic-base", "humanities"]),
	entry("cite-them-right", "Cite Them Right 12th edition - Harvard", "author-date", ["generic-base"]),
	entry("obscure", "Journal of Obscure Studies", undefined, []),
	entry("botany-letters", "Botany Letters", "author-date", ["botany", "biology"], 1),
];

let calls: string[] = [];
let offline = false;
let indexBody = JSON.stringify(INDEX);

const mockFetch = async (url: string): Promise<Response> => {
	calls.push(url);
	if (offline) throw new Error("offline");
	if (url.endsWith("/styles/vancouver")) return new Response(read("vancouver.csl"));
	if (url.endsWith("/styles/apa")) return new Response(read("apa.csl"));
	if (url.endsWith("/styles/vancouver-dep")) return new Response(dependent("vancouver-dep", "vancouver", "Vancouver Dependent"));
	if (url.endsWith("/styles/lancet-oncology")) return new Response(dependent("lancet-oncology", "the-lancet", "The Lancet Oncology"));
	if (url.endsWith("/styles/the-lancet")) return new Response(read("vancouver.csl").replace("<title>Vancouver", "<title>The Lancet"));
	if (url.endsWith("/styles/missing")) return new Response("nope", { status: 404 });
	if (url.endsWith("locales-en-US.xml")) return new Response(read("locales-en-US.xml"));
	if (url.endsWith("styles.json")) return new Response(indexBody);
	return new Response("nope", { status: 404 });
};

let db: Database;
let dir: string;

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
		volume: "382",
		issue: "5",
		pages: "123-130",
		date: "2020-03-15",
	});
	insertItem(db, {
		key: "BOOK0001",
		itemType: "book",
		title: "Principles of Surgery",
		creators: [{ creatorType: "author", firstName: "Seymour", lastName: "Schwartz" }],
		publisher: "McGraw-Hill",
		place: "New York",
		date: "2019",
	});
});
afterAll(() => db.close(true));

const fresh = () => {
	calls = [];
	return new StyleStore(tempDir(), mockFetch);
};

describe("catalogue search", () => {
	test("ranking: exact id/short title, prefix, word prefix, all words", async () => {
		const s = fresh();
		expect((await s.search("apa"))[0]).toMatchObject({
			id: "apa",
			titleShort: "APA",
			format: "author-date",
			fields: ["psychology", "social_science"],
		});
		expect((await s.search("nature")).map((x) => x.id)).toEqual(["nature", "nature-communications"]); // exact before prefix
		expect((await s.search("oncology"))[0]!.id).toBe("lancet-oncology"); // word prefix
		const hv = (await s.search("harvard cite")).map((x) => x.id);
		expect(hv).toContain("cite-them-right"); // all words, any order
		expect(hv[0]).toBe("harvard-cite-them-right"); // the built-in default ranks first
		expect((await s.search("vancouv")).map((x) => x.id)).toEqual(["vancouver", "vancouver-dep"]); // independent first
		expect(await s.search("zzzzzz")).toEqual([]);
		expect(calls.filter((c) => c.endsWith("styles.json")).length).toBe(1);
	});

	test("installed styles come first, flagged, and removable unless built in", async () => {
		const s = fresh();
		await s.install("apa");
		await s.install("lancet-oncology");
		const r = (await s.searchStyles({ q: "a" })).styles;
		const flags = r.map((x) => x.installed);
		expect(flags.indexOf(false)).toBeGreaterThan(flags.lastIndexOf(true)); // all installed ahead of all uninstalled
		const apa = r.find((x) => x.id === "apa")!;
		expect(apa).toMatchObject({ installed: true, bundled: true, removable: false });
		expect(r.find((x) => x.id === "lancet-oncology")).toMatchObject({ installed: true, removable: true, dependent: true });
		expect(r.find((x) => x.id === "the-lancet")!.installed).toBe(true); // parent came along
	});

	test("filters: format, field, installed, combined, pagination and total", async () => {
		const s = fresh();
		const byFormat = await s.searchStyles({ format: "note" });
		expect(byFormat.styles.map((x) => x.id)).toEqual(["chicago-note"]);
		const med = await s.searchStyles({ field: "medicine" });
		expect(med.styles.map((x) => x.id).sort()).toEqual(["lancet-oncology", "the-lancet", "vancouver", "vancouver-dep"]);
		const both = await s.searchStyles({ q: "lancet", field: "medicine", format: "numeric" });
		expect(both.styles.map((x) => x.id)).toEqual(["the-lancet", "lancet-oncology"]); // the built-in default outranks an id-prefix match
		expect((await s.searchStyles({ field: "botany" })).styles.map((x) => x.id)).toEqual(["botany-letters"]);
		expect((await s.searchStyles({ installed: true })).total).toBe(0);
		await s.install("nature").catch(() => {}); // not served by the mock -> 404, nothing installed
		await s.install("vancouver");
		const inst = await s.searchStyles({ installed: true });
		expect(inst.styles.map((x) => x.id)).toEqual(["vancouver"]);
		const page1 = await s.searchStyles({ limit: 4, offset: 0 });
		const page2 = await s.searchStyles({ limit: 4, offset: 4 });
		expect(page1.total).toBe(page2.total);
		expect(page1.total).toBeGreaterThanOrEqual(INDEX.length);
		expect(new Set([...page1.styles, ...page2.styles].map((x) => x.id)).size).toBe(8);
	});

	test("empty query: installed first then repository A-Z; quick = defaults + installed", async () => {
		const s = fresh();
		await s.install("apa");
		const all = (await s.searchStyles({})).styles;
		expect(all[0]!.id).toBe("apa");
		const repo = all.filter((x) => !x.installed);
		expect(repo.map((x) => x.dependent)).toEqual([...repo.map((x) => x.dependent)].sort((a, b) => Number(a) - Number(b))); // independent first
		const quick = (await s.searchStyles({ quick: true })).styles;
		expect(quick.map((x) => x.id)).toContain("vancouver");
		expect(quick.map((x) => x.id)).not.toContain("botany-letters");
		expect(quick[0]!.id).toBe("apa"); // installed first
	});

	test("styles installed outside the repository (browser connector) are searchable", async () => {
		const s = fresh();
		const xml = read("vancouver.csl")
			.replace(/<id>[^<]*<\/id>/, "<id>http://example.org/my-own-style</id>")
			.replace(/<title>[^<]*<\/title>/, "<title>My Department Style</title>");
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(join(s.dir, "styles"), { recursive: true });
		writeFileSync(join(s.dir, "styles", "my-own-style.csl"), xml);
		const r = await s.search("department");
		expect(r[0]).toMatchObject({ id: "my-own-style", title: "My Department Style", installed: true, removable: true });
	});
});

describe("index cache", () => {
	test("cached on disk, reused by a new store without network, refreshed after a day", async () => {
		const d = tempDir();
		calls = [];
		const a = new StyleStore(d, mockFetch);
		await a.search("apa");
		expect(existsSync(join(d, "style-cache", "styles-index.json"))).toBe(true);
		expect(calls.filter((c) => c.endsWith("styles.json")).length).toBe(1);
		const b = new StyleStore(d, mockFetch);
		expect((await b.search("apa"))[0]!.id).toBe("apa");
		expect(calls.filter((c) => c.endsWith("styles.json")).length).toBe(1); // reused
		const f = join(d, "style-cache", "styles-index.json");
		const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
		utimesSync(f, old, old);
		indexBody = JSON.stringify([...INDEX, entry("brand-new", "Brand New Style", "numeric", ["physics"])]);
		try {
			const c = new StyleStore(d, mockFetch);
			expect((await c.search("brand new"))[0]!.id).toBe("brand-new");
			expect(calls.filter((x) => x.endsWith("styles.json")).length).toBe(2);
		} finally {
			indexBody = JSON.stringify(INDEX);
		}
	});

	test("offline: a stale cache is still searched; with no cache only installed + defaults", async () => {
		const d = tempDir();
		await new StyleStore(d, mockFetch).search("apa");
		const f = join(d, "style-cache", "styles-index.json");
		const old = new Date(Date.now() - 5 * 24 * 3600 * 1000);
		utimesSync(f, old, old);
		offline = true;
		try {
			const s = new StyleStore(d, mockFetch);
			const r = await s.searchStyles({ q: "botany" });
			expect(r.styles[0]!.id).toBe("botany-letters");
			expect(r.index).toBe("cached");
			const none = new StyleStore(tempDir(), mockFetch);
			const lancet = await none.searchStyles({ q: "lancet" });
			expect(lancet.styles[0]).toMatchObject({ id: "the-lancet" }); // built-in default
			expect(lancet.index).toBe("none");
			const calls0 = calls.length;
			await none.searchStyles({ q: "x" });
			expect(calls.length).toBe(calls0); // does not hammer the network while offline
		} finally {
			offline = false;
		}
	});
});

describe("install and remove", () => {
	test("dependent style installs its parent; both appear installed", async () => {
		const s = fresh();
		const info = await s.install("lancet-oncology");
		expect(info).toMatchObject({ id: "lancet-oncology", dependent: true, installed: true, format: "numeric", fields: ["medicine"] });
		expect(s.isInstalled("the-lancet")).toBe(true);
	});

	test("remove: user styles only; bundled, parents with dependents, missing are refused", async () => {
		const s = fresh();
		await s.install("lancet-oncology");
		await s.install("apa");
		expect(() => s.remove("apa")).toThrow(/built-in/);
		expect(() => s.remove("the-lancet")).toThrow(/built-in/);
		writeFileSync(join(s.dir, "styles", "custom-parent.csl"), read("apa.csl"));
		writeFileSync(join(s.dir, "styles", "custom-child.csl"), dependent("custom-child", "custom-parent", "Custom Child"));
		expect(() => s.remove("custom-parent")).toThrow(/parent of installed style custom-child/);
		s.remove("custom-child");
		s.remove("custom-parent");
		expect(() => s.remove("nature")).toThrow(/not installed/);
		s.remove("lancet-oncology");
		expect(s.isInstalled("lancet-oncology")).toBe(false);
		await s.install("vancouver-dep");
		expect(() => s.remove("vancouver")).toThrow(/built-in|parent/);
		s.remove("vancouver-dep");
		expect((await s.searchStyles({ installed: true })).styles.map((x) => x.id).sort()).toEqual(["apa", "the-lancet", "vancouver"]);
		expect(() => s.remove("../x")).toThrow();
	});

	test("a non-default independent style can be removed again", async () => {
		const s = fresh();
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(join(s.dir, "styles"), { recursive: true });
		writeFileSync(join(s.dir, "styles", "mine.csl"), read("apa.csl"));
		s.remove("mine");
		expect(s.isInstalled("mine")).toBe(false);
	});
});

describe("preview", () => {
	test("not-installed style: fetched into the cache only, library items used", async () => {
		const d = tempDir();
		const svc = citeService(db, { dir: d, fetch: mockFetch });
		calls = [];
		const p = await svc.preview(db, "apa", ["JOURNAL1", "BOOK0001"]);
		expect(p).toMatchObject({ id: "apa", installed: false, sample: false, note: false });
		expect(p.title).toContain("APA");
		expect(p.keys).toEqual(["JOURNAL1", "BOOK0001"]);
		expect(p.citations.length).toBe(2);
		expect(p.citations[0]).toContain("Smith");
		expect(p.citations[1]).toContain("Schwartz");
		expect(p.bibliography).toContain("csl-entry");
		expect(svc.store.isInstalled("apa")).toBe(false);
		expect(existsSync(join(d, "styles", "apa.csl"))).toBe(false);
		expect(existsSync(join(d, "style-cache", "styles", "apa.csl"))).toBe(true);
		// a second preview and a later install reuse the cached download
		const n = calls.filter((c) => c.endsWith("/styles/apa")).length;
		await svc.preview(db, "apa", ["JOURNAL1"]);
		await svc.store.install("apa");
		expect(calls.filter((c) => c.endsWith("/styles/apa")).length).toBe(n);
		expect(svc.store.isInstalled("apa")).toBe(true);
	});

	test("numeric style numbers the citations in order; works for an installed style too", async () => {
		const svc = citeService(db, { dir: tempDir(), fetch: mockFetch });
		await svc.store.install("vancouver");
		const p = await svc.preview(db, "vancouver", ["JOURNAL1", "BOOK0001"]);
		expect(p.installed).toBe(true);
		expect(p.citations.map((c) => c.replace(/<[^>]+>/g, ""))).toEqual(["(1)", "(2)"]);
		expect(p.bibliography).toContain("Smith J");
	});

	test("dependent style not installed: parent also only cached", async () => {
		const d = tempDir();
		const svc = citeService(db, { dir: d, fetch: mockFetch });
		const p = await svc.preview(db, "vancouver-dep", ["JOURNAL1"]);
		expect(p.citations[0]!.replace(/<[^>]+>/g, "")).toBe("(1)");
		expect(p.title).toBe("Vancouver Dependent");
		expect(readdirSync(join(d, "style-cache", "styles")).sort()).toEqual(["vancouver-dep.csl", "vancouver.csl"]);
		expect(existsSync(join(d, "styles"))).toBe(false);
	});

	test("no keys: varied library items; empty library: built-in samples", async () => {
		const svc = citeService(db, { dir: tempDir(), fetch: mockFetch });
		const p = await svc.preview(db, "apa", []);
		expect(p.sample).toBe(false);
		expect(new Set(p.keys)).toEqual(new Set(["JOURNAL1", "BOOK0001"]));
		const empty = openDb(join(tempDir(), "empty.sqlite"));
		try {
			const svc2 = citeService(empty, { dir: tempDir(), fetch: mockFetch });
			const q = await svc2.preview(empty, "apa", ["NOPE0000"]);
			expect(q.sample).toBe(true);
			expect(q.keys).toEqual(["SAMPLE01", "SAMPLE02", "SAMPLE03"]);
			expect(q.citations.length).toBe(3);
		} finally {
			empty.close(true);
		}
	});

	test("offline with the style cached still previews; unknown style 404", async () => {
		const d = tempDir();
		const svc = citeService(db, { dir: d, fetch: mockFetch });
		await svc.preview(db, "apa", ["JOURNAL1"]);
		await svc.store.locale("en-US");
		offline = true;
		try {
			const p = await svc.preview(db, "apa", ["JOURNAL1"]);
			expect(p.citations.length).toBe(1);
		} finally {
			offline = false;
		}
		await expect(svc.preview(db, "missing", ["JOURNAL1"])).rejects.toMatchObject({ status: 404 });
		await expect(svc.preview(db, "../etc", ["JOURNAL1"])).rejects.toMatchObject({ status: 400 });
	});
});

describe("HTTP routes", () => {
	const d = tempDir();
	const call = async (method: string, path: string, body?: unknown) => {
		citeService(db, { dir: d, fetch: mockFetch });
		const res = await handleCiteApi(
			new Request("http://x" + path, {
				method,
				headers: { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			db,
		);
		return { status: res!.status, json: (await res!.json()) as any, headers: res!.headers };
	};

	test("a style's XML and a locale's XML (the Office.js add-in formats in its task pane)", async () => {
		const st = await call("GET", "/api/cite/styles/the-lancet");
		expect(st.status).toBe(200);
		expect(st.json.id).toBe("the-lancet");
		expect(st.json.xml).toContain('<style xmlns="http://purl.org/net/xbiblio/csl"');
		expect((await call("GET", "/api/cite/styles?installed=1")).json).toEqual([]); // reading a style installs nothing
		expect((await call("GET", "/api/cite/styles/missing")).status).toBe(404);
		expect((await call("GET", "/api/cite/styles/..%2Fetc")).status).toBe(400);
		const lo = await call("GET", "/api/cite/locales/en-US");
		expect(lo.status).toBe(200);
		expect(lo.json.lang).toBe("en-US");
		expect(lo.json.xml).toContain("<locale");
		expect((await call("GET", "/api/cite/locales/not a locale")).json).toEqual({ lang: "not a locale", xml: null });
		expect((await call("POST", "/api/cite/locales/en-US", {})).status).toBe(405);
	});

	test("search endpoint: filters, headers, install/preview/delete flow", async () => {
		const r = await call("GET", "/api/cite/styles?q=lancet&field=medicine&format=numeric&limit=1");
		expect(r.status).toBe(200);
		expect(r.json.length).toBe(1);
		expect(r.headers.get("X-Total")).toBe("2");
		expect(r.headers.get("X-Styles-Index")).toBe("fresh");
		expect((await call("GET", "/api/cite/styles?installed=1")).json).toEqual([]);

		const pv = await call("GET", "/api/cite/styles/preview?id=lancet-oncology&items=JOURNAL1");
		expect(pv.status).toBe(200);
		expect(pv.json).toMatchObject({ id: "lancet-oncology", installed: false, keys: ["JOURNAL1"] });
		expect((await call("GET", "/api/cite/styles?installed=1")).json).toEqual([]); // preview installed nothing
		expect((await call("GET", "/api/cite/styles/preview")).status).toBe(400);

		const inst = await call("POST", "/api/cite/styles/install", { id: "lancet-oncology" });
		expect(inst.json).toMatchObject({ id: "lancet-oncology", installed: true, removable: true });
		expect((await call("GET", "/api/cite/styles?installed=1")).json.map((x: any) => x.id).sort()).toEqual([
			"lancet-oncology",
			"the-lancet",
		]);

		expect((await call("DELETE", "/api/cite/styles/the-lancet")).status).toBe(409);
		expect((await call("DELETE", "/api/cite/styles/lancet-oncology")).json).toEqual({ id: "lancet-oncology", removed: true });
		expect((await call("DELETE", "/api/cite/styles/lancet-oncology")).status).toBe(404);
		expect((await call("DELETE", "/api/cite/styles/apa")).status).toBe(404);
		await call("POST", "/api/cite/styles", { id: "apa" });
		expect((await call("DELETE", "/api/cite/styles/apa")).status).toBe(409); // built-in default
		expect((await call("POST", "/api/cite/styles/install", {})).status).toBe(400);
	});

	test("the Quick Copy style cannot be removed", async () => {
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(join(d, "styles"), { recursive: true });
		writeFileSync(join(d, "styles", "mine.csl"), read("apa.csl"));
		await call("PUT", "/api/cite/settings", { quickCopy: { style: "mine" } });
		const r = await call("DELETE", "/api/cite/styles/mine");
		expect(r.status).toBe(409);
		expect(r.json.error).toContain("Quick Copy");
		await call("PUT", "/api/cite/settings", { quickCopy: { style: "vancouver" } });
		expect((await call("DELETE", "/api/cite/styles/mine")).status).toBe(200);
	});
});
