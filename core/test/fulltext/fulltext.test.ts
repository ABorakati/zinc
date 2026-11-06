import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { FullTextJob } from "../../src/api-types";
import { openDb } from "../../src/db";
import { handleFulltextApi } from "../../src/fulltext/api";
import { CookieJar, HttpClient } from "../../src/fulltext/http";
import { PersistStore } from "../../src/fulltext/host";
import { type FulltextService, fulltextService, disposeFulltextService } from "../../src/fulltext/service";
import { WasmHost } from "../../src/fulltext/wasm";
import { insertAttachment, insertItem } from "../fixture";
import { HAVE_FULLTEXT_WASM } from "../needs";

const DOI = "10.1371/journal.pmed.1000097";
const PDF_URL = "https://oa.example.test/paper.pdf";
const PDF = new TextEncoder().encode(`%PDF-1.4\n${"% filler line of ordinary pdf comment text................\n".repeat(900)}trailer\n<< /Root 1 0 R >>\n%%EOF\n`);

const loc = {
	is_oa: true,
	landing_page_url: "https://oa.example.test/article",
	pdf_url: PDF_URL,
	license: "cc-by",
	version: "publishedVersion",
	source: { display_name: "Example OA Journal", type: "journal" },
};
const OPENALEX_HIT = {
	id: "https://openalex.org/W1",
	doi: `https://doi.org/${DOI}`,
	title: "PRISMA",
	open_access: { is_oa: true, oa_status: "gold", oa_url: PDF_URL },
	best_oa_location: loc,
	primary_location: loc,
	locations: [loc],
};
const OPENALEX_CLOSED = { id: "https://openalex.org/W2", open_access: { is_oa: false, oa_status: "closed" }, locations: [] };

type Mock = (url: string, init?: RequestInit) => Response | Promise<Response>;

interface Env {
	dir: string;
	db: Database;
	svc: FulltextService;
	calls: string[];
	extracted: string[];
}

let wasm: WasmHost;
beforeAll(async () => {
	if (HAVE_FULLTEXT_WASM) wasm = await WasmHost.load();
});

const dbs: Database[] = [];
afterAll(async () => {
	for (const db of dbs) {
		await disposeFulltextService(db);
		db.close(true);
	}
});

function env(mock: Mock): Env {
	const dir = mkdtempSync(join(tmpdir(), "zn-ft-"));
	const db = openDb(join(dir, "library.sqlite"));
	dbs.push(db);
	const calls: string[] = [];
	const extracted: string[] = [];
	const svc = fulltextService(db, {
		wasm,
		fetch: async (url, init) => {
			calls.push(url);
			return mock(url, init);
		},
		extract: async (_db, key) => {
			extracted.push(key);
		},
	});
	return { dir, db, svc, calls, extracted };
}

function article(db: Database, key: string, doi: string, title = "Cold-stored whole blood") {
	insertItem(db, { key, itemType: "journalArticle", title, DOI: doi, date: "2009-07-21", creators: [{ creatorType: "author", lastName: "Moher", firstName: "David" }] });
}

const openAccessMock: Mock = (url) => {
	if (url.startsWith("https://api.openalex.org/works/doi:")) return Response.json(OPENALEX_HIT);
	if (url === PDF_URL) return new Response(PDF, { headers: { "content-type": "application/pdf" } });
	return new Response("not found", { status: 404 });
};

describe.skipIf(!HAVE_FULLTEXT_WASM)("Find Full Text: open access hit", () => {
	test("attaches the PDF, writes the rows and extracts text", async () => {
		const e = env(openAccessMock);
		article(e.db, "ITEM0001", DOI);
		const id = await e.svc.start(["ITEM0001"], true);
		const job = await e.svc.waitJob(id);
		expect(job.done).toBe(true);
		expect(job.items).toHaveLength(1);
		const it = job.items[0];
		expect(it.state).toBe("attached");
		expect(it.source).toBe("OpenAlex");
		expect(it.attachmentKey).toMatch(/^[0-9A-Z]{8}$/);

		const att = e.db.query("SELECT * FROM attachments WHERE item_key = ?").get(it.attachmentKey!) as any;
		expect(att.link_mode).toBe("imported_url");
		expect(att.content_type).toBe("application/pdf");
		expect(att.url).toBe(PDF_URL);
		expect(att.path).toBe(join(e.dir, "storage", it.attachmentKey!, "Moher - 2009 - Cold-stored whole blood.pdf"));
		expect(existsSync(att.path)).toBe(true);
		expect(readFileSync(att.path).subarray(0, 5).toString()).toBe("%PDF-");
		expect(readFileSync(att.path).length).toBe(PDF.length);

		const row = e.db.query("SELECT item_type, parent_key, data FROM items WHERE key = ?").get(it.attachmentKey!) as any;
		expect(row.item_type).toBe("attachment");
		expect(row.parent_key).toBe("ITEM0001");
		const data = JSON.parse(row.data);
		expect(data).toMatchObject({ itemType: "attachment", parentItem: "ITEM0001", linkMode: "imported_url", contentType: "application/pdf", title: "Full Text PDF" });

		await e.svc.idle();
		expect(e.extracted).toEqual([it.attachmentKey!]);
		// the temp slot directories are gone
		expect(existsSync(join(e.dir, "storage", ".fulltext-tmp")) ? readdirCount(join(e.dir, "storage", ".fulltext-tmp")) : 0).toBe(0);
	});

	test("an item that already has a PDF is not fetched again", async () => {
		const e = env(openAccessMock);
		article(e.db, "ITEM0002", DOI);
		const file = join(e.dir, "existing.pdf");
		writeFileSync(file, PDF);
		insertAttachment(e.db, "ATT00002", "ITEM0002", "application/pdf", file);
		const job = await e.svc.waitJob(await e.svc.start(["ITEM0002"], true));
		expect(job.items[0].state).toBe("already-has-pdf");
		expect(e.calls).toEqual([]);
	});

	test("unknown keys fail without breaking the job", async () => {
		const e = env(openAccessMock);
		article(e.db, "ITEM0003", DOI);
		const job = await e.svc.waitJob(await e.svc.start(["NOSUCHKY", "ITEM0003"], true));
		expect(job.items.map((i) => [i.key, i.state])).toEqual([
			["NOSUCHKY", "failed"],
			["ITEM0003", "attached"],
		]);
	});
});

describe.skipIf(!HAVE_FULLTEXT_WASM)("Find Full Text: not found", () => {
	test("no open access copy anywhere", async () => {
		const e = env(() => new Response("{}", { status: 404 }));
		article(e.db, "ITEM0010", DOI);
		const job = await e.svc.waitJob(await e.svc.start(["ITEM0010"], true));
		expect(job.items[0].state).toBe("not-found");
		expect(job.items[0].handoffUrl).toBeUndefined();
		expect(e.calls.some((u) => u.includes("openalex"))).toBe(true);
		expect(e.calls.every((u) => !u.includes("kcl.ac.uk") && !u.includes("openathens"))).toBe(true);
	});

	test("an item without any identifier", async () => {
		const e = env(() => new Response("{}", { status: 404 }));
		insertItem(e.db, { key: "ITEM0011", itemType: "book", title: "A book without identifiers" });
		const job = await e.svc.waitJob(await e.svc.start(["ITEM0011"], true));
		expect(job.items[0].state).toBe("not-found");
		expect(e.calls).toEqual([]);
	});

	test("a broken download falls through to not-found", async () => {
		const e = env((url) => {
			if (url.startsWith("https://api.openalex.org/works/doi:")) return Response.json(OPENALEX_HIT);
			if (url === PDF_URL) return new Response("<html>nope</html>", { headers: { "content-type": "text/html" } });
			return new Response("{}", { status: 404 });
		});
		article(e.db, "ITEM0012", DOI);
		const job = await e.svc.waitJob(await e.svc.start(["ITEM0012"], true));
		expect(job.items[0].state).toBe("not-found");
		expect(e.db.query("SELECT count(*) n FROM attachments").get()).toEqual({ n: 0 });
	});
});

describe.skipIf(!HAVE_FULLTEXT_WASM)("Find Full Text: institutional hand-off", () => {
	const paywall: Mock = (url) => {
		if (url.includes("openalex")) return Response.json(OPENALEX_CLOSED);
		if (url.includes("librarysearch.kcl.ac.uk")) return Response.json({});
		return new Response("<html><body>Please sign in to access this article</body></html>", { headers: { "content-type": "text/html" } });
	};

	test("a paywalled paper ends in needs-sign-in with the OpenAthens link", async () => {
		const e = env(paywall);
		article(e.db, "ITEM0020", "10.1097/SLA.0000000000005603");
		const job = await e.svc.waitJob(await e.svc.start(["ITEM0020"], false));
		const it = job.items[0];
		expect(it.state).toBe("needs-sign-in");
		expect(it.handoffUrl).toStartWith("https://go.openathens.net/redirector/kcl.ac.uk?url=");
		expect(it.handoffUrl).toContain(encodeURIComponent("https://doi.org/10.1097/sla.0000000000005603"));
		expect(e.db.query("SELECT count(*) n FROM attachments").get()).toEqual({ n: 0 });
	});

	test("open access only never goes near the institution", async () => {
		const e = env(paywall);
		article(e.db, "ITEM0021", "10.1097/SLA.0000000000005603");
		const job = await e.svc.waitJob(await e.svc.start(["ITEM0021"], true));
		expect(job.items[0].state).toBe("not-found");
		expect(e.calls.some((u) => u.includes("kcl.ac.uk") || u.includes("doi.org/10.1097"))).toBe(false);
	});

	test("institutional access can be switched off in the settings", async () => {
		const dir = mkdtempSync(join(tmpdir(), "zn-ft-"));
		writeFileSync(join(dir, "fulltext-settings.json"), JSON.stringify({ institutional: false }));
		const db = openDb(join(dir, "library.sqlite"));
		dbs.push(db);
		const calls: string[] = [];
		const svc = fulltextService(db, { wasm, fetch: async (u) => (calls.push(u), paywall(u)), extract: async () => {} });
		article(db, "ITEM0022", "10.1097/SLA.0000000000005603");
		const job = await svc.waitJob(await svc.start(["ITEM0022"], false));
		expect(job.items[0].state).toBe("not-found");
		expect(calls.some((u) => u.includes("kcl.ac.uk"))).toBe(false);
	});
});

describe.skipIf(!HAVE_FULLTEXT_WASM)("Find Full Text: cancel", () => {
	test("cancelling aborts the in-flight request", async () => {
		let aborted = false;
		let started!: () => void;
		const inFlight = new Promise<void>((r) => (started = r));
		const e = env(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					started();
					init?.signal?.addEventListener("abort", () => {
						aborted = true;
						reject(new DOMException("aborted", "AbortError"));
					});
				}),
		);
		article(e.db, "ITEM0030", DOI);
		article(e.db, "ITEM0031", "10.1371/journal.pmed.0020124", "Second");
		const id = await e.svc.start(["ITEM0030", "ITEM0031"], true);
		await inFlight;
		expect(e.svc.cancel(id)).toBe(true);
		const job = await e.svc.waitJob(id);
		expect(aborted).toBe(true);
		expect(job.done).toBe(true);
		expect(job.items.map((i) => i.state)).toEqual(["cancelled", "cancelled"]);
		expect(e.db.query("SELECT count(*) n FROM attachments").get()).toEqual({ n: 0 });
	});
});

describe.skipIf(!HAVE_FULLTEXT_WASM)("HTTP routes", () => {
	const post = (body: unknown) => new Request("http://x/api/fulltext/find", { method: "POST", body: JSON.stringify(body) });

	test("find -> job -> events -> cancel", async () => {
		const e = env(openAccessMock);
		article(e.db, "ITEM0040", DOI);
		const res = await handleFulltextApi(post({ keys: ["ITEM0040"], openAccessOnly: true }), e.db);
		expect(res!.status).toBe(202);
		const { jobId } = (await res!.json()) as { jobId: string };

		const sse = await handleFulltextApi(new Request(`http://x/api/fulltext/jobs/${jobId}/events`), e.db);
		expect(sse!.headers.get("content-type")).toStartWith("text/event-stream");
		const snaps: FullTextJob[] = [];
		const reader = sse!.body!.getReader();
		const dec = new TextDecoder();
		let buf = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += dec.decode(value);
			for (const block of buf.split("\n\n").slice(0, -1)) if (block.startsWith("data: ")) snaps.push(JSON.parse(block.slice(6)));
			buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
		}
		expect(snaps.length).toBeGreaterThan(0);
		expect(snaps[snaps.length - 1].done).toBe(true);
		expect(snaps[snaps.length - 1].items[0].state).toBe("attached");

		const got = await handleFulltextApi(new Request(`http://x/api/fulltext/jobs/${jobId}`), e.db);
		expect(((await got!.json()) as FullTextJob).items[0].state).toBe("attached");
		const cancel = await handleFulltextApi(new Request(`http://x/api/fulltext/jobs/${jobId}/cancel`, { method: "POST" }), e.db);
		expect(await cancel!.json()).toEqual({ ok: true });
	});

	test("validation and 404s", async () => {
		const e = env(openAccessMock);
		expect((await handleFulltextApi(post({ keys: "nope" }), e.db))!.status).toBe(400);
		expect((await handleFulltextApi(post({ keys: [] }), e.db))!.status).toBe(400);
		expect((await handleFulltextApi(new Request("http://x/api/fulltext/jobs/nope"), e.db))!.status).toBe(404);
		expect((await handleFulltextApi(new Request("http://x/api/fulltext/jobs/nope/events"), e.db))!.status).toBe(404);
		expect((await handleFulltextApi(new Request("http://x/api/fulltext/jobs/nope/cancel", { method: "POST" }), e.db))!.status).toBe(404);
		expect((await handleFulltextApi(new Request("http://x/api/fulltext/find"), e.db))!.status).toBe(405);
		expect(await handleFulltextApi(new Request("http://x/api/items"), e.db)).toBeNull();
	});
});

describe.skipIf(!HAVE_FULLTEXT_WASM)("host pieces", () => {
	test("redirects keep cookies and the cookie jar scopes them", async () => {
		const seen: { url: string; cookie: string | null }[] = [];
		const client = new HttpClient({
			fetch: async (url, init) => {
				const headers = new Headers(init?.headers as any);
				seen.push({ url, cookie: headers.get("cookie") });
				if (url === "https://a.example.test/start") {
					const h = new Headers({ location: "https://a.example.test/next" });
					h.append("set-cookie", "sid=abc; Path=/; Secure");
					h.append("set-cookie", "other=1; Path=/other");
					return new Response(null, { status: 302, headers: h });
				}
				return new Response("ok", { headers: { "content-type": "text/plain" } });
			},
		});
		const ac = new AbortController();
		const raw = await client.request(
			{ method: "get", url: "https://a.example.test/start", headers: {}, ua: "default", timeout_ms: 5000, follow_redirects: true, max_bytes: 1000 },
			{ signal: ac.signal, sink: "memory" },
		);
		expect(raw.status).toBe(200);
		expect(raw.final_url).toBe("https://a.example.test/next");
		expect(seen[1].cookie).toBe("sid=abc");
		const jar = new CookieJar();
		jar.store("https://x.example.test/a/b", ["k=v; Domain=example.test; Path=/a"]);
		expect(jar.header("https://y.example.test/a/c")).toBe("k=v");
		expect(jar.header("https://y.example.test/z")).toBe("");
		expect(jar.header("https://other.test/a")).toBe("");
	});

	test("max_bytes aborts an oversized response", async () => {
		const client = new HttpClient({ fetch: async () => new Response(new Uint8Array(5000)) });
		const ac = new AbortController();
		await expect(
			client.request({ method: "get", url: "https://a.example.test/x", headers: {}, ua: "default", timeout_ms: 5000, follow_redirects: true, max_bytes: 1000 }, { signal: ac.signal, sink: "memory" }),
		).rejects.toMatchObject({ kind: "too_large" });
	});

	test("engine state (rate limit ledger and caches) survives a restart", () => {
		const dir = mkdtempSync(join(tmpdir(), "zn-ft-"));
		const path = join(dir, "fulltext-state.json");
		const a = new PersistStore(path);
		a.set("ledger", { committed: [[1, 2]], reserved: [] });
		a.set("halts", { inst_until: 0, hosts: {} });
		const b = new PersistStore(path);
		expect(b.get()).toEqual({ ledger: { committed: [[1, 2]], reserved: [] }, halts: { inst_until: 0, hosts: {} } });
	});
});

function readdirCount(p: string): number {
	return require("node:fs").readdirSync(p).length;
}
