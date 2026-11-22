// Add from URL with `publicOnly` (what a plugin's translate.web asks for): the whole job refuses private and local addresses, and
// the app's own calls (no option) connect as before. Local throw-away servers only: any hit on them by a public-only job is a failure.
import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { hooks } from "../../src/additems/files";
import { createItem, getItemDetail, openDb } from "../../src/db";
import { handleTranslateApi } from "../../src/translate/api";
import { setNetResolver } from "../../src/translate/netguard";
import { shutdownTranslatePool } from "../../src/translate/pool";
import { beginRun, endRun, installHttp } from "../../src/translate/runtime/http";
import { saveFileAttachments, translateLimits } from "../../src/translate/service";
import { tempDir } from "../fixture";

const origAfterImport = hooks.afterImport;
let db: Database;
let server: Bun.Server<unknown>;
let other: Bun.Server<unknown>;
let base: string;
let hits: { path: string; auth: string | null }[] = [];
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

const ARTICLES: Record<string, string> = { a1: "Liver outcomes after transplantation", a2: "Kidney graft survival in older recipients" };
const tocPage = `<!doctype html><html><head><title>Volume 12 Issue 3</title></head><body><div class="table-of-content">
${Object.entries(ARTICLES).map(([id, t]) => `<div class="articleEntry"><div class="art_title">${t}</div><div><a href="/doi/abs/10.1234/${id}">Abstract</a></div></div>`).join("\n")}
</div></body></html>`;
const articlePage = (id: string) => `<!doctype html><html><head><title>${ARTICLES[id]}</title></head><body>
<div class="pill__item"></div><input name="downloadFileName" value="${id}-citation"><h1>${ARTICLES[id]}</h1></body></html>`;
const ris = (id: string) => `TY  - JOUR\nTI  - ${ARTICLES[id]}\nAU  - Smith, Jane\nPY  - 2022\nJO  - Journal of Tests\nDO  - 10.1234/${id}\nER  - \n`;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const u = new URL(req.url);
			hits.push({ path: u.pathname, auth: req.headers.get("authorization") });
			const html = (b: string) => new Response(b, { headers: { "content-type": "text/html; charset=utf-8" } });
			if (u.pathname === "/toc/jtest/12/3") return html(tocPage);
			const doi = /^\/doi\/abs\/10\.1234\/(a\d)$/.exec(u.pathname);
			if (doi) return html(articlePage(doi[1]!));
			if (u.pathname === "/action/downloadCitation") {
				const id = /10\.1234\/(a\d)/.exec(new URLSearchParams(await req.text()).get("doi") ?? "")?.[1] ?? "a1";
				return new Response(ris(id), { headers: { "content-type": "application/x-research-info-systems" } });
			}
			if (u.pathname === "/pdf/1.pdf") return new Response(PDF, { headers: { "content-type": "application/pdf" } });
			if (u.pathname === "/plain") return html("<html><head><title>Just a page</title></head><body>hi</body></html>");
			if (u.pathname === "/hop") return new Response(null, { status: 302, headers: { Location: u.searchParams.get("to")! } });
			return new Response("not found", { status: 404 });
		},
	});
	other = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			hits.push({ path: "other" + new URL(req.url).pathname, auth: req.headers.get("authorization") });
			return new Response("other");
		},
	});
	base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
	server.stop(true);
	other.stop(true);
	shutdownTranslatePool();
	hooks.afterImport = origAfterImport;
});
// the first job of a file boots the translator worker and loads the translators: slow on a busy machine
setDefaultTimeout(120_000);

beforeEach(() => {
	hits = [];
	db = openDb(join(tempDir(), "lib.sqlite"));
	hooks.afterImport = () => {};
	translateLimits.timeoutMs = 60_000;
});
afterEach(() => {
	setNetResolver();
	db.close();
});

async function api(path: string, body: unknown): Promise<{ status: number; json: any }> {
	const res = await handleTranslateApi(new Request(`http://127.0.0.1:23120${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), db);
	return { status: res!.status, json: await res!.json() };
}
const savedItems = () => (db.query("SELECT key FROM items WHERE parent_key IS NULL AND item_type NOT IN ('note','attachment') AND deleted = 0").all() as { key: string }[]).map((r) => getItemDetail(db, r.key)!.data as any);

describe("POST /api/translate/web with publicOnly", () => {
	test("a private page is refused with zero hits; the same call without the option (the app's own) still works", async () => {
		for (const url of [`${base}/plain`, `http://localhost:${server.port}/plain`, `http://[::ffff:7f00:1]:${server.port}/plain`]) {
			const r = await api("/api/translate/web", { url, attachments: false, publicOnly: true });
			expect([url, r.status]).toEqual([url, 502]);
			expect(String(r.json.error)).toMatch(/private|local/);
		}
		expect(hits).toEqual([]);
		expect(savedItems()).toHaveLength(0);
		const app = await api("/api/translate/web", { url: `${base}/plain`, attachments: false });
		expect(app.status).toBe(200);
		expect(hits.map((h) => h.path)).toEqual(["/plain"]);
	});

	test("a redirect to a private address is refused at the hop (the first hop's host is not what decides)", async () => {
		// the public hop is simulated: the in-process runtime below covers it; here the page itself redirects from a private host, which is refused first
		const r = await api("/api/translate/web", { url: `${base}/hop?to=${encodeURIComponent(base + "/plain")}`, publicOnly: true });
		expect(r.status).toBe(502);
		expect(hits).toEqual([]);
	});

	test("the later web-select step is public-only too: a session made by the app, selected with publicOnly, makes no request to a private host", async () => {
		const first = await api("/api/translate/web", { url: `${base}/toc/jtest/12/3`, attachments: false });
		expect(first.status).toBe(200);
		const { session, items } = first.json.choices;
		hits = [];
		const keys = items.map((c: any) => c.key);
		const done = await api("/api/translate/web/select", { session, keys, publicOnly: true });
		// the translator's follow-up requests (article pages, citation download) go to the local server: none may arrive
		expect(hits).toEqual([]);
		expect(done.status === 200 ? done.json.items : []).toHaveLength(0);
		expect(savedItems()).toHaveLength(0);
	});

	test("without the option the same select saves the items", async () => {
		const first = await api("/api/translate/web", { url: `${base}/toc/jtest/12/3`, attachments: false });
		const { session, items } = first.json.choices;
		const done = await api("/api/translate/web/select", { session, keys: items.map((c: any) => c.key) });
		expect(done.status).toBe(200);
		expect(done.json.items).toHaveLength(2);
		expect(hits.some((h) => h.path === "/action/downloadCitation" || h.path.startsWith("/doi/abs/"))).toBe(true);
	});
});

describe("attachment downloads", () => {
	const kids = (parent: string) => (db.query("SELECT key FROM items WHERE parent_key = ?").all(parent) as { key: string }[]).length;
	const parent = () => createItem(db, { itemType: "journalArticle", title: "Parent" }).data.key as string;

	test("publicOnly: no request reaches a private host, redirects included; without it the file is attached", async () => {
		const p = parent();
		const raw = { url: `${base}/article/x`, attachments: [{ url: `${base}/pdf/1.pdf`, mimeType: "application/pdf", title: "Full text" }] };
		await saveFileAttachments(db, p, raw, [], true);
		await saveFileAttachments(db, p, { attachments: [{ url: `${base}/hop?to=${encodeURIComponent(base + "/pdf/1.pdf")}`, mimeType: "application/pdf", title: "Via redirect" }] }, [], true);
		expect(hits).toEqual([]);
		expect(kids(p)).toBe(0);
		await saveFileAttachments(db, p, raw, [], false);
		expect(hits.map((h) => h.path)).toEqual(["/pdf/1.pdf"]);
		expect(kids(p)).toBe(1);
	});
});

describe("the translator runtime's HTTP (every request and hop of a public-only run)", () => {
	const Z: any = { debug() {} };
	installHttp(Z);

	test("requests and redirect hops are resolved, checked and pinned; one that turns private is refused", async () => {
		const lookups: string[] = [];
		setNetResolver(async (h) => {
			lookups.push(h);
			return h === "start.test" ? ["93.184.216.34"] : ["10.9.9.9"];
		});
		const dialled: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: unknown) => {
			dialled.push(String(input));
			return String(input).includes("93.184.216.34") ? new Response(null, { status: 302, headers: { Location: "http://inner.test/secret" } }) : new Response("secret");
		}) as typeof fetch;
		try {
			beginRun({ publicOnly: true });
			await expect(Z.HTTP.request("GET", "http://start.test/", {})).rejects.toMatchObject({ code: "blocked" });
			expect(dialled).toEqual(["http://93.184.216.34/"]);
			expect(lookups).toEqual(["start.test", "inner.test"]);
			// a translator's own request to a literal local address is refused before any connection
			await expect(Z.HTTP.request("GET", `${base}/plain`, {})).rejects.toMatchObject({ code: "blocked" });
			expect(hits).toEqual([]);
		} finally {
			endRun();
			globalThis.fetch = realFetch;
		}
	});

	test("an app run (no option) still reaches a local server; Authorization set by hand does not follow a cross-origin redirect", async () => {
		beginRun({});
		try {
			const r = await Z.HTTP.request("GET", `${base}/hop?to=${encodeURIComponent(`http://127.0.0.1:${other.port}/x`)}`, { headers: { Authorization: "Bearer secret", Cookie: "a=b" }, responseType: "text" });
			expect(r.responseText).toBe("other");
			expect(hits.find((h) => h.path === "/hop")!.auth).toBe("Bearer secret");
			expect(hits.find((h) => h.path === "other/x")!.auth).toBeNull();
		} finally {
			endRun();
		}
	});
});
