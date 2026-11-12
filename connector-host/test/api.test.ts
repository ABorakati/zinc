// The `api` host method (src/api.ts): the extension's library page sends the app's /api/* requests through the compiled host,
// which answers them with the core's handleApi against a library file. Runs against a fresh temp library, never a real one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFile } from "../../core/src/additems/files";
import * as repo from "../../core/src/db";
import { apiRefusal } from "../src/api";
import { HostClient } from "./client";

const ROOT = mkdtempSync(join(tmpdir(), "znh-api-"));
const dbPath = join(ROOT, "library.sqlite");
let h: HostClient;
let itemKey = "";
let collKey = "";
let pdfKey = "";
const pdfBytes = new Uint8Array(1_700_000).map((_, i) => (i * 7 + 3) & 0xff); // three response chunks

beforeAll(() => {
	const db = repo.openDb(dbPath);
	collKey = repo.createCollection(db, "Transplant outcomes").key;
	for (let i = 0; i < 30; i++) {
		const key = repo.createItem(db, { itemType: "journalArticle", title: `Fixture article ${i}`, date: "2024" } as never).data.key;
		if (i < 5) repo.addItemsToCollection(db, collKey, [key]);
		if (i === 0) itemKey = key;
	}
	// a big field: the item's answer is larger than one 1 MB frame
	repo.patchItem(db, itemKey, { abstractNote: "liver ".repeat(250_000) } as never);
	const file = join(ROOT, "source.pdf");
	writeFileSync(file, pdfBytes);
	pdfKey = addFile(db, { mode: "imported_file", path: file, name: "Fixture.pdf", contentType: "application/pdf", parentKey: itemKey } as never).data.key;
	db.close(true);
	h = new HostClient({ ZN_DB: dbPath });
});

afterAll(async () => {
	await h.close();
	try { rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Windows may hold the WAL a moment */ }
});

describe("api method: reads", () => {
	test("lists the library's items and collections", async () => {
		const items = await h.call("api", { http: "GET", path: "/api/items?sort=title&dir=asc&limit=100" });
		expect(items.status).toBe(200);
		expect(items.json.total).toBe(30);
		const cols = await h.call("api", { http: "GET", path: "/api/collections" });
		expect(cols.status).toBe(200);
		expect(cols.json.find((c: { key: string }) => c.key === collKey)?.name).toBe("Transplant outcomes");
		const inColl = await h.call("api", { http: "GET", path: `/api/items?collection=${collKey}&sort=title&dir=asc` });
		expect(inColl.json.total).toBe(5);
	});

	test("an answer over 1 MB arrives whole, in frames under the limit", async () => {
		const r = await h.call("api", { http: "GET", path: `/api/items/${itemKey}` });
		expect(r.status).toBe(200);
		expect(r.bytes.length).toBeGreaterThan(1_000_000);
		expect(r.json.data.abstractNote.length).toBe(6 * 250_000);
		expect(h.maxFrame).toBeLessThan(1_000_000);
	});

	test("attachment bytes come back unchanged, with HEAD answering headers only", async () => {
		const r = await h.call("api", { http: "GET", path: `/api/attachments/${pdfKey}/file` });
		expect(r.status).toBe(200);
		expect(r.headers["content-type"]).toContain("pdf");
		expect(Buffer.compare(Buffer.from(r.bytes), Buffer.from(pdfBytes))).toBe(0);
		const head = await h.call("api", { http: "HEAD", path: `/api/attachments/${pdfKey}/file` });
		expect(head.status).toBe(200);
		expect(head.bytes.length).toBe(0);
	});

	test("an unknown route is 404, a path outside /api is 400", async () => {
		expect((await h.call("api", { http: "GET", path: "/api/no-such-route" })).status).toBe(404);
		expect((await h.call("api", { http: "GET", path: "/connector/ping" })).status).toBe(400);
	});
});

describe("api method: writes", () => {
	test("POST /api/ui/selection is allowed (inline body and an `up` frame body)", async () => {
		const a = await h.call("api", { http: "POST", path: "/api/ui/selection", json: { kind: "collection", key: collKey } });
		expect(a.status).toBe(200);
		expect(a.json.ok).toBe(true);
		await h.uploadBytes("sel1", new TextEncoder().encode(JSON.stringify({ kind: "library" })));
		const b = await h.call("api", { http: "POST", path: "/api/ui/selection", uploadUid: "sel1", headers: { "Content-Type": "application/json" } });
		expect(b.status).toBe(200);
		const sel = await h.call("api", { http: "GET", path: "/api/ui/selection" });
		expect(sel.json.selection).toEqual({ kind: "library" });
	});

	test("edits, deletes and openers are refused, and the library is unchanged", async () => {
		const patch = await h.call("api", { http: "PATCH", path: `/api/items/${itemKey}`, json: { data: { title: "changed" } } });
		expect(patch.status).toBe(403);
		expect((await h.call("api", { http: "DELETE", path: `/api/collections/${collKey}` })).status).toBe(403);
		expect((await h.call("api", { http: "POST", path: "/api/open-url", json: { url: "https://example.org" } })).status).toBe(403);
		expect((await h.call("api", { http: "POST", path: `/api/attachments/${pdfKey}/open-external` })).status).toBe(403);
		const after = await h.call("api", { http: "GET", path: `/api/items/${itemKey}` });
		expect(after.json.data.title).toBe("Fixture article 0");
	});

	test("sync and integrations stay closed even for reads", async () => {
		expect((await h.call("api", { http: "GET", path: "/api/sync/status" })).status).toBe(403);
		expect((await h.call("api", { http: "GET", path: "/api/websync/status" })).status).toBe(403);
		expect((await h.call("api", { http: "GET", path: "/api/integrations" })).status).toBe(403);
	});
});

describe("api method: changes made by another process", () => {
	test("`ext` from GET /api/ui/selection moves when another connection commits", async () => {
		const before = (await h.call("api", { http: "GET", path: "/api/ui/selection" })).json.ext;
		const again = (await h.call("api", { http: "GET", path: "/api/ui/selection" })).json.ext;
		expect(again).toBe(before);
		const db = repo.openDb(dbPath);
		repo.createItem(db, { itemType: "book", title: "Written by the desktop app" } as never);
		db.close(true);
		const after = (await h.call("api", { http: "GET", path: "/api/ui/selection" })).json.ext;
		expect(after).not.toBe(before);
		const items = await h.call("api", { http: "GET", path: "/api/items?sort=title&dir=asc&limit=100" });
		expect(items.json.total).toBe(31);
	});
});

describe("apiRefusal", () => {
	test("reads open, writes closed except the selection", () => {
		expect(apiRefusal("GET", "/api/items")).toBeNull();
		expect(apiRefusal("HEAD", "/api/attachments/ABCD1234/file")).toBeNull();
		expect(apiRefusal("POST", "/api/ui/selection")).toBeNull();
		expect(apiRefusal("POST", "/api/ui/reveal")).not.toBeNull();
		expect(apiRefusal("PUT", "/api/tag-colors")).not.toBeNull();
		expect(apiRefusal("GET", "/api/sync")).not.toBeNull();
		expect(apiRefusal("GET", "/apix")).not.toBeNull();
	});
});
