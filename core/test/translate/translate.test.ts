// Zotero translators inside zotero-next (src/translate): web (against a local fixture server, never a real site),
// import (the translators' own test cases), export round trips, sandbox and limits.
// Every test uses a fresh temp library.
import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hooks } from "../../src/additems/files";
import { createItem, getItemDetail, openDb } from "../../src/db";
import { shutdownTranslatePool } from "../../src/translate/pool";
import { handleTranslateApi } from "../../src/translate/api";
import { translateLimits } from "../../src/translate/service";
import { VENDORED_TRANSLATORS_DIR } from "../../src/translate/translators";
import { tempDir } from "../fixture";

const origAfterImport = hooks.afterImport;
let db: Database;
let dir: string;
let server: Bun.Server<unknown>;
let base: string;

const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

const journalPage = `<!doctype html><html lang="en"><head><title>Deep learning for X | Journal of Tests</title>
<meta name="citation_title" content="Deep learning for X">
<meta name="citation_author" content="Smith, Jane"><meta name="citation_author" content="Doe, John">
<meta name="citation_journal_title" content="Journal of Tests"><meta name="citation_publication_date" content="2021/03/04">
<meta name="citation_volume" content="12"><meta name="citation_issue" content="3"><meta name="citation_firstpage" content="100"><meta name="citation_lastpage" content="110">
<meta name="citation_doi" content="10.1234/jot.2021.0001"><meta name="citation_pdf_url" content="/pdf/1.pdf">
<meta name="citation_abstract" content="An abstract."><meta name="citation_keywords" content="alpha; beta"></head>
<body><h1>Deep learning for X</h1></body></html>`;

const ARTICLES: Record<string, { title: string; author: string; first: string }> = {
	a1: { title: "Liver outcomes after transplantation", author: "Smith", first: "Jane" },
	a2: { title: "Kidney graft survival in older recipients", author: "Doe", first: "John" },
	a3: { title: "Pancreas allocation policy", author: "Roe", first: "Rita" },
};

const tocPage = `<!doctype html><html><head><title>Volume 12 Issue 3</title></head><body><div class="table-of-content">
${Object.entries(ARTICLES)
	.map(
		([id, a]) =>
			`<div class="articleEntry"><div class="art_title">${a.title}</div><div><a href="/doi/abs/10.1234/${id}">Abstract</a></div></div>`,
	)
	.join("\n")}
</div></body></html>`;

const articlePage = (id: string) => `<!doctype html><html><head><title>${ARTICLES[id]!.title}</title></head><body>
<div class="pill__item"></div><input name="downloadFileName" value="${id}-citation"><h1>${ARTICLES[id]!.title}</h1></body></html>`;

const risFor = (id: string) => {
	const a = ARTICLES[id]!;
	return `TY  - JOUR\nTI  - ${a.title}\nAU  - ${a.author}, ${a.first}\nPY  - 2022\nJO  - Journal of Tests\nVL  - 12\nIS  - 3\nSP  - 1\nEP  - 9\nDO  - 10.1234/${id}\nKW  - transplant\nER  - \n`;
};

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const u = new URL(req.url);
			const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
			if (u.pathname === "/article/1") return html(journalPage);
			if (u.pathname === "/plain")
				return html(
					'<html><head><title>Just a page</title><meta name="description" content="About nothing"></head><body>hi</body></html>',
				);
			if (u.pathname === "/toc/jtest/12/3") return html(tocPage);
			const doi = /^\/doi\/abs\/10\.1234\/(a\d)$/.exec(u.pathname);
			if (doi) return html(articlePage(doi[1]!));
			if (u.pathname === "/action/downloadCitation") {
				const form = new URLSearchParams(await req.text());
				const id = /10\.1234\/(a\d)/.exec(form.get("doi") ?? "")?.[1] ?? "a1";
				return new Response(risFor(id), { headers: { "content-type": "application/x-research-info-systems" } });
			}
			if (u.pathname === "/pdf/1.pdf") return new Response(PDF, { headers: { "content-type": "application/pdf" } });
			if (u.pathname === "/refs.ris")
				return new Response(risFor("a1") + risFor("a2"), { headers: { "content-type": "application/x-research-info-systems" } });
			if (u.pathname === "/slow") {
				await Bun.sleep(5000);
				return html("<html><head><title>slow</title></head></html>");
			}
			return new Response("not found", { status: 404 });
		},
	});
	base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
	server.stop(true);
	shutdownTranslatePool();
	hooks.afterImport = origAfterImport;
});

beforeEach(() => {
	dir = tempDir();
	db = openDb(join(dir, "lib.sqlite"));
	hooks.afterImport = () => {};
	translateLimits.timeoutMs = 60_000;
	translateLimits.maxRequests = 25;
	delete process.env.ZN_TRANSLATORS_DIR;
});
afterEach(() => {
	delete process.env.ZN_TRANSLATORS_DIR;
	db.close();
});

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
	const res = await handleTranslateApi(
		new Request(`http://127.0.0.1:23120${path}`, {
			method,
			headers: { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		db,
	);
	if (!res) throw new Error("route not handled");
	const json = await res.json();
	if (res.status >= 400 && process.env.ZN_T_DEBUG) console.error(`[${method} ${path}] ${res.status} ${(json as any).error}`);
	return { status: res.status, json };
}

const items = () =>
	(
		db
			.query(
				"SELECT key FROM items WHERE parent_key IS NULL AND item_type NOT IN ('note','attachment') AND deleted = 0 ORDER BY date_added, key",
			)
			.all() as { key: string }[]
	).map((r) => getItemDetail(db, r.key)!.data as any);
const children = (parent: string) =>
	(db.query("SELECT key FROM items WHERE parent_key = ?").all(parent) as { key: string }[]).map(
		(r) => getItemDetail(db, r.key)!.data as any,
	);

describe("translators and formats", () => {
	test("vendored translators load, by type", async () => {
		const r = await api("GET", "/api/translate/status");
		expect(r.status).toBe(200);
		expect(r.json.source).toBe("vendored");
		expect(r.json.counts.web).toBeGreaterThan(400);
		expect(r.json.counts.import).toBeGreaterThanOrEqual(25);
		expect(r.json.counts.export).toBeGreaterThan(15);
		expect(r.json.counts.search).toBeGreaterThan(5);
	});

	test("export/import format lists leave out the natively handled formats unless asked", async () => {
		const exp = (await api("GET", "/api/translate/export-formats")).json as { id: string; label: string; extension: string }[];
		const all = (await api("GET", "/api/translate/export-formats?all=1")).json as { label: string }[];
		expect(exp.some((f) => f.label === "Refer/BibIX")).toBe(true);
		expect(exp.some((f) => f.label === "BibTeX")).toBe(false);
		expect(all.some((f) => f.label === "BibTeX")).toBe(true);
		const imp = (await api("GET", "/api/translate/import-formats")).json as { label: string }[];
		expect(imp.some((f) => f.label === "PubMed XML")).toBe(true);
		expect(imp.some((f) => f.label === "RIS")).toBe(false);
	});

	test("a translators folder in the data dir wins over the vendored copy", async () => {
		const tdir = join(dir, "translators");
		mkdirSync(tdir);
		// Embedded Metadata hands its RDF-ish parts to the RDF import translator, so the folder needs both
		for (const f of ["Embedded Metadata.js", "RDF.js"]) copyFileSync(join(VENDORED_TRANSLATORS_DIR, f), join(tdir, f));
		const r = await api("GET", "/api/translate/status");
		expect(r.json.source).toBe("data");
		expect(r.json.counts.total).toBe(2);
		const w = await api("POST", "/api/translate/web", { url: `${base}/article/1`, attachments: false });
		expect(w.status).toBe(200);
		expect(w.json.translator).toBe("Embedded Metadata");
	});
});

describe("Add from URL", () => {
	test("a journal page with Highwire meta tags is translated by Embedded Metadata and saved like a connector save", async () => {
		const col = (db.query("INSERT INTO collections(key, name) VALUES('COLLAAA1', 'Reading') RETURNING key").get() as { key: string })
			.key;
		const r = await api("POST", "/api/translate/web", { url: `${base}/article/1`, collectionKey: col });
		expect(r.status).toBe(200);
		expect(r.json.translator).toBe("Embedded Metadata");
		expect(r.json.items).toHaveLength(1);
		const [it] = items();
		expect(it.itemType).toBe("journalArticle");
		expect(it.title).toBe("Deep learning for X");
		expect(it.DOI).toBe("10.1234/jot.2021.0001");
		expect(it.publicationTitle).toBe("Journal of Tests");
		expect(it.volume).toBe("12");
		expect(it.pages).toBe("100-110");
		expect(it.creators.map((c: any) => c.lastName)).toEqual(["Smith", "Doe"]);
		expect(it.collections).toEqual([col]);
		expect(it.url).toBe(`${base}/article/1`);
		// the PDF the page advertises became an imported attachment
		const kids = children(it.key);
		expect(kids.some((k) => k.itemType === "attachment" && k.contentType === "application/pdf")).toBe(true);
	});

	test("a page no translator understands becomes a webpage item", async () => {
		const r = await api("POST", "/api/translate/web", { url: `${base}/plain`, attachments: false });
		expect(r.status).toBe(200);
		expect(r.json.items[0].itemType).toBe("webpage");
		expect(["webpage", "embedded"]).toContain(r.json.fallback);
		const [it] = items();
		expect(it.title).toBe("Just a page");
		expect(it.url).toBe(`${base}/plain`);
	});

	test("a multi-item page returns the choice list, then saves only the chosen items", async () => {
		const r = await api("POST", "/api/translate/web", { url: `${base}/toc/jtest/12/3`, attachments: false });
		expect(r.status).toBe(200);
		expect(r.json.items).toBeUndefined();
		const { session, items: choices } = r.json.choices;
		expect(choices.map((c: any) => c.title).sort()).toEqual(
			Object.values(ARTICLES)
				.map((a) => a.title)
				.sort(),
		);
		expect(items()).toHaveLength(0);

		const bad = await api("POST", "/api/translate/web/select", { session, keys: ["nope"] });
		expect(bad.status).toBe(409);
		const gone = await api("POST", "/api/translate/web/select", { session: "missing", keys: ["x"] });
		expect(gone.status).toBe(404);

		const keys = choices.filter((c: any) => c.title !== ARTICLES.a2!.title).map((c: any) => c.key);
		const done = await api("POST", "/api/translate/web/select", { session, keys });
		expect(done.status).toBe(200);
		expect(done.json.items).toHaveLength(2);
		const saved = items();
		expect(saved.map((i) => i.title).sort()).toEqual([ARTICLES.a1!.title, ARTICLES.a3!.title].sort());
		expect(saved.every((i) => i.itemType === "journalArticle" && /^10\.1234\/a[13]$/.test(i.DOI))).toBe(true);
	});

	test("a link straight to an export file goes through the import translators", async () => {
		const r = await api("POST", "/api/translate/web", { url: `${base}/refs.ris` });
		expect(r.status).toBe(200);
		expect(r.json.items).toHaveLength(2);
		expect(
			items()
				.map((i) => i.title)
				.sort(),
		).toEqual([ARTICLES.a1!.title, ARTICLES.a2!.title].sort());
	});

	test("rejects bad input", async () => {
		expect((await api("POST", "/api/translate/web", { url: "file:///etc/passwd" })).status).toBe(400);
		expect((await api("POST", "/api/translate/web", {})).status).toBe(400);
		expect((await api("POST", "/api/translate/web", { url: `${base}/article/1`, collectionKey: "NOPE0000" })).status).toBe(404);
	});

	test("a run that takes too long is stopped and the next one still works", async () => {
		translateLimits.timeoutMs = 1500;
		const slow = await api("POST", "/api/translate/web", { url: `${base}/slow` });
		expect(slow.status).toBe(504);
		translateLimits.timeoutMs = 60_000;
		const ok = await api("POST", "/api/translate/web", { url: `${base}/article/1`, attachments: false });
		expect(ok.status).toBe(200);
	}, 30_000);

	test("the HTTP request cap stops a translator that fetches too much", async () => {
		const r1 = await api("POST", "/api/translate/web", { url: `${base}/toc/jtest/12/3`, attachments: false });
		const { session, items: choices } = r1.json.choices;
		translateLimits.maxRequests = 1; // two articles need a page and a citation POST each
		const r2 = await api("POST", "/api/translate/web/select", { session, keys: choices.map((c: any) => c.key) });
		expect(r2.status).toBe(502);
		expect(String(r2.json.error)).toMatch(/HTTP (POST|request)|limit of 1/);
		expect(items()).toHaveLength(0);
	});
});

describe("sandbox", () => {
	test("translator code sees no require, process, fetch or Bun", async () => {
		const tdir = join(dir, "translators");
		mkdirSync(tdir);
		for (const f of ["Embedded Metadata.js"]) copyFileSync(join(VENDORED_TRANSLATORS_DIR, f), join(tdir, f));
		writeFileSync(
			join(tdir, "Probe.js"),
			`{
	"translatorID": "11111111-2222-4333-8444-555555555555",
	"label": "Probe",
	"creator": "test",
	"target": "^http://127\\\\.0\\\\.0\\\\.1:\\\\d+/probe",
	"minVersion": "3.0",
	"maxVersion": "",
	"priority": 10,
	"inRepository": false,
	"translatorType": 4,
	"browserSupport": "gcsibv",
	"lastUpdated": "2026-01-01 00:00:00"
}

function detectWeb(doc, url) { return "journalArticle"; }
function doWeb(doc, url) {
	var seen = [typeof require, typeof process, typeof fetch, typeof Bun, typeof globalThis.process].join(",");
	var item = new Zotero.Item("journalArticle");
	item.title = seen;
	item.complete();
}
`,
		);
		const probeServer = Bun.serve({
			port: 0,
			fetch: () => new Response("<html><head><title>p</title></head></html>", { headers: { "content-type": "text/html" } }),
		});
		try {
			const r = await api("POST", "/api/translate/web", { url: `http://127.0.0.1:${probeServer.port}/probe`, attachments: false });
			expect(r.status).toBe(200);
			expect(r.json.translator).toBe("Probe");
			expect(items()[0]!.title).toBe("undefined,undefined,undefined,undefined,undefined");
		} finally {
			probeServer.stop(true);
		}
	});
});

// ---------------------------------------------------------------- import

interface TestCase {
	type: string;
	input?: string;
	items?: any[];
}
function testCases(file: string): TestCase[] {
	const code = readFileSync(join(VENDORED_TRANSLATORS_DIR, file), "utf8");
	const m = /BEGIN TEST CASES \*\*\/\s*var testCases = (\[[\s\S]*\])\s*\/\*\* END TEST CASES/.exec(code);
	return m ? (JSON.parse(m[1]!) as TestCase[]) : [];
}

describe("import through translators", () => {
	test("a format the native importers handle still goes native", async () => {
		const r = await api("POST", "/api/translate/import", { text: risFor("a1"), collectionName: null });
		expect(r.status).toBe(200);
		expect(r.json.translator).toBe("native:ris");
		expect(r.json.created).toBe(1);
	});

	test("an unknown format with no translator is a clear error", { timeout: 60_000 }, async () => {
		const r = await api("POST", "/api/translate/import", { text: "nothing that any translator recognises", collectionName: null });
		expect(r.status).toBe(502);
		expect(String(r.json.error)).toMatch(/No suitable import translator/i);
	});

	for (const [file, label] of [
		["PubMed XML.js", "PubMed XML"],
		["Web of Science Tagged.js", "Web of Science Tagged"],
		["Crossref Unixref XML.js", "Crossref Unixref XML"],
	] as const) {
		test(`${label}: the translator's own test cases import`, async () => {
			const cases = testCases(file)
				.filter((c) => c.type === "import" && typeof c.input === "string" && Array.isArray(c.items) && c.items.length)
				.slice(0, 3);
			expect(cases.length).toBeGreaterThan(0);
			for (const c of cases) {
				const fresh = openDb(join(tempDir(), "lib.sqlite"));
				const prev = db;
				db = fresh;
				try {
					const r = await api("POST", "/api/translate/import", { text: c.input, collectionName: null });
					expect(r.status).toBe(200);
					expect(r.json.translator).toBe(label);
					const wanted = c.items!.filter((i) => i.itemType !== "note" && i.itemType !== "attachment");
					const got = items();
					expect(got.length).toBe(wanted.length);
					expect(got.map((i) => i.title).sort()).toEqual(wanted.map((i) => i.title).sort());
					expect(got.map((i) => i.itemType).sort()).toEqual(wanted.map((i) => i.itemType).sort());
					const firstWanted = wanted.find((i) => i.creators?.length);
					if (firstWanted) {
						const match = got.find((i) => i.title === firstWanted.title)!;
						expect(match.creators?.[0]?.lastName ?? match.creators?.[0]?.name).toBe(
							firstWanted.creators[0].lastName ?? firstWanted.creators[0].name,
						);
					}
				} finally {
					db = prev;
					fresh.close();
				}
			}
		});
	}

	test("a file path is read and imported; DOI duplicates are skipped the second time", async () => {
		const file = join(dir, "pm.xml");
		const c = testCases("PubMed XML.js").find((t) => t.type === "import" && t.items?.length === 1)!;
		writeFileSync(file, c.input!);
		const first = await api("POST", "/api/translate/import", { path: file, collectionName: null });
		expect(first.json.created).toBe(1);
		const again = await api("POST", "/api/translate/import", { path: file, collectionName: null });
		expect(again.json.created + again.json.skipped).toBe(1);
		if (items()[0]!.DOI) expect(again.json.skipped).toBe(1);
	});

	test("translatorID forces a translator and collectionName files the items", async () => {
		const r = await api("POST", "/api/translate/import", {
			text: risFor("a2"),
			translatorID: "32d59d2d-b65a-4da4-b0a3-bdd3cfb979e7",
			collectionName: "From RIS translator",
		});
		expect(r.status).toBe(200);
		expect(r.json.translator).toBe("RIS");
		expect(r.json.created).toBe(1);
		const col = db.query("SELECT name FROM collections WHERE key = ?").get(r.json.collectionKey) as { name: string };
		expect(col.name).toBe("From RIS translator");
	});
});

// ---------------------------------------------------------------- export

const ids = { refer: "881f60f2-0802-411a-9228-ce5f47b64c7d", refworks: "1a3506da-a303-4b0a-a1cd-f216e6138d86" };

function seed(): string[] {
	const a = createItem(db, {
		itemType: "journalArticle",
		title: "Round trip of a transplant study",
		creators: [
			{ creatorType: "author", firstName: "Jane", lastName: "Smith" },
			{ creatorType: "author", firstName: "John", lastName: "Doe" },
		],
		date: "2021",
		publicationTitle: "Journal of Tests",
		volume: "12",
		issue: "3",
		pages: "100-110",
		abstractNote: "An abstract.",
	} as any);
	const b = createItem(db, {
		itemType: "book",
		title: "A book about surgery",
		creators: [{ creatorType: "author", firstName: "Cara", lastName: "Brown" }],
		date: "2018",
		publisher: "Surgical Press",
	} as any);
	createItem(db, { itemType: "note", note: "<p>child note</p>", parentItem: a.data.key } as any);
	return [a.data.key, b.data.key];
}

describe("export through translators", () => {
	test("the translator export is offered and writes a file when asked", async () => {
		const keys = seed();
		const r = await api("POST", "/api/translate/export", { translatorID: ids.refer, keys, dir: join(dir, "out") });
		expect(r.status).toBe(200);
		expect(r.json.count).toBe(2);
		expect(r.json.filename).toMatch(/^Exported Items\./);
		expect(existsSync(r.json.path)).toBe(true);
		expect(readFileSync(r.json.path, "utf8")).toBe(r.json.text);
	});

	for (const [name, id] of [
		["Refer/BibIX", ids.refer],
		["RefWorks Tagged", ids.refworks],
	] as const) {
		test(`${name}: export then import returns the same items`, async () => {
			const keys = seed();
			const out = await api("POST", "/api/translate/export", { translatorID: id, keys });
			expect(out.status).toBe(200);
			expect(out.json.text).toContain("Round trip of a transplant study");
			expect(out.json.text).toContain("Smith");

			const other = openDb(join(tempDir(), "lib.sqlite"));
			const prev = db;
			db = other;
			try {
				const back = await api("POST", "/api/translate/import", { text: out.json.text, translatorID: id, collectionName: null });
				expect(back.status).toBe(200);
				expect(back.json.created).toBe(2);
				const got = items();
				const article = got.find((i) => i.itemType === "journalArticle")!;
				expect(article.title).toBe("Round trip of a transplant study");
				expect(article.creators.map((c: any) => c.lastName)).toEqual(["Smith", "Doe"]);
				expect(article.publicationTitle).toBe("Journal of Tests");
				expect(String(article.date)).toContain("2021");
				expect(got.find((i) => i.itemType === "book")!.title).toBe("A book about surgery");
			} finally {
				db = prev;
				other.close();
			}
		});
	}

	test("unknown translators and bad ids are rejected", async () => {
		expect((await api("POST", "/api/translate/export", { translatorID: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
		expect((await api("POST", "/api/translate/export", {})).status).toBe(400);
		// a web translator is not an export translator
		expect((await api("POST", "/api/translate/export", { translatorID: "951c027d-74ac-47d4-a107-9c3069ab7b48" })).status).toBe(404);
	});
});
