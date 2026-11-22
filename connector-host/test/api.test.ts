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
	pdfKey = addFile(db, {
		mode: "imported_file",
		path: file,
		name: "Fixture.pdf",
		contentType: "application/pdf",
		parentKey: itemKey,
	} as never).data.key;
	db.close(true);
	h = new HostClient({ ZN_DB: dbPath });
});

afterAll(async () => {
	await h.close();
	try {
		rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch {
		/* Windows may hold the WAL a moment */
	}
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
		expect((await h.call("api", { http: "GET", path: "/api/no-such-route" })).status).toBe(403); // not listed: refused, not passed to the core
		expect((await h.call("api", { http: "GET", path: "/connector/ping" })).status).toBe(400);
	});
});

describe("api method: writes", () => {
	test("POST /api/ui/selection is allowed (inline body and an `up` frame body)", async () => {
		const a = await h.call("api", { http: "POST", path: "/api/ui/selection", json: { kind: "collection", key: collKey } });
		expect(a.status).toBe(200);
		expect(a.json.ok).toBe(true);
		await h.uploadBytes("sel1", new TextEncoder().encode(JSON.stringify({ kind: "library" })));
		const b = await h.call("api", {
			http: "POST",
			path: "/api/ui/selection",
			uploadUid: "sel1",
			headers: { "Content-Type": "application/json" },
		});
		expect(b.status).toBe(200);
		const sel = await h.call("api", { http: "GET", path: "/api/ui/selection" });
		expect(sel.json.selection).toEqual({ kind: "library" });
	});

	test("item, tag and collection edits go through and reach the sync outbox", async () => {
		const outbox = () => {
			const db = repo.openDb(dbPath);
			try {
				return (db.query("SELECT count(*) n FROM sync_outbox").get() as { n: number }).n;
			} finally {
				db.close(true);
			}
		};
		const before = outbox();
		const patch = await h.call("api", {
			http: "PATCH",
			path: `/api/items/${itemKey}`,
			json: { data: { title: "Edited in the browser" } },
		});
		expect(patch.status).toBe(200);
		expect((await h.call("api", { http: "GET", path: `/api/items/${itemKey}` })).json.data.title).toBe("Edited in the browser");
		expect((await h.call("api", { http: "POST", path: `/api/items/${itemKey}/tags`, json: { tags: ["from-browser"] } })).status).toBe(
			200,
		);
		const made = await h.call("api", { http: "POST", path: "/api/collections", json: { name: "Made in the browser" } });
		expect(made.status).toBe(201);
		expect((await h.call("api", { http: "DELETE", path: `/api/collections/${made.json.key}` })).status).toBe(200);
		expect(outbox()).toBeGreaterThan(before);
		// back as it was, for the other tests
		expect(
			(await h.call("api", { http: "PATCH", path: `/api/items/${itemKey}`, json: { data: { title: "Fixture article 0" } } })).status,
		).toBe(200);
		expect((await h.call("api", { http: "DELETE", path: `/api/items/${itemKey}/tags`, json: { tags: ["from-browser"] } })).status).toBe(
			200,
		);
	});

	test("routes that act on this computer are refused", async () => {
		expect((await h.call("api", { http: "POST", path: "/api/open-url", json: { url: "https://example.org" } })).status).toBe(403);
		expect((await h.call("api", { http: "POST", path: `/api/attachments/${pdfKey}/open-external` })).status).toBe(403);
		expect((await h.call("api", { http: "POST", path: `/api/attachments/${pdfKey}/reveal` })).status).toBe(403);
		expect((await h.call("api", { http: "PUT", path: "/api/files/storage", json: { mode: "custom" } })).status).toBe(403);
		expect((await h.call("api", { http: "POST", path: "/api/io/mendeley", json: {} })).status).toBe(403);
	});

	test("imports and exports that name a file or folder here are refused; text and uploaded bytes are not", async () => {
		const file = join(ROOT, "source.pdf");
		const linked = await h.call("api", {
			http: "POST",
			path: "/api/add/file",
			json: { name: "x.pdf", path: file, mode: "linked_file" },
		});
		expect(linked.status).toBe(403);
		expect(linked.json.error).toContain("`path`");
		expect((await h.call("api", { http: "POST", path: "/api/io/export", json: { format: "ris", dir: ROOT } })).status).toBe(403);
		expect((await h.call("api", { http: "POST", path: "/api/translate/import", json: { path: file } })).status).toBe(403);
		const ris = "TY  - JOUR\nTI  - Imported in the browser\nPY  - 2025\nER  - \n";
		const imp = await h.call("api", { http: "POST", path: "/api/io/import", json: { text: ris, format: "ris", collectionName: null } });
		expect(imp.status).toBe(200);
		expect(imp.json.created).toBe(1);
		const exp = await h.call("api", { http: "POST", path: "/api/io/export", json: { format: "ris", keys: [itemKey] } });
		expect(exp.status).toBe(200);
		expect(exp.json.text).toContain("Fixture article 0");
	});

	test("sync and integrations stay closed even for reads", async () => {
		expect((await h.call("api", { http: "GET", path: "/api/sync/status" })).status).toBe(403);
		expect((await h.call("api", { http: "GET", path: "/api/websync/status" })).status).toBe(403);
		expect((await h.call("api", { http: "GET", path: "/api/integrations" })).status).toBe(403);
	});
});

describe("api method: annotations (the reader's writes)", () => {
	const outbox = () => {
		const db = repo.openDb(dbPath);
		try {
			return (db.query("SELECT count(*) n FROM sync_outbox").get() as { n: number }).n;
		} finally {
			db.close(true);
		}
	};
	const ann = (id: string, comment = "") => ({
		id,
		type: "highlight",
		color: "#ffd400",
		sortIndex: "00000|000100|00072",
		position: { pageIndex: 0, rects: [[72, 700, 300, 718]] },
		text: "Fixture article",
		comment,
		pageLabel: "1",
		dateModified: new Date().toISOString(),
	});
	const path = () => `/api/attachments/${pdfKey}/annotations`;

	test("create, edit and delete round trip through handleApi, recorded in the sync outbox", async () => {
		const before = outbox();
		const put = await h.call("api", { http: "PUT", path: path(), json: [ann("ANNOTA01")] });
		expect(put.status).toBe(200);
		let got = await h.call("api", { http: "GET", path: path() });
		expect(got.json.map((a: { id: string; text: string }) => [a.id, a.text])).toEqual([["ANNOTA01", "Fixture article"]]);
		const afterCreate = outbox();
		expect(afterCreate).toBeGreaterThan(before);

		expect((await h.call("api", { http: "PUT", path: path(), json: [ann("ANNOTA01", "edited")] })).status).toBe(200);
		got = await h.call("api", { http: "GET", path: path() });
		expect(got.json[0].comment).toBe("edited");

		const del = await h.call("api", { http: "DELETE", path: path(), json: { ids: ["ANNOTA01"] } });
		expect(del.status).toBe(200);
		expect((await h.call("api", { http: "GET", path: path() })).json).toEqual([]);
		expect(outbox()).toBeGreaterThan(afterCreate);
	});

	test("a wrong verb or a path with .. does not write", async () => {
		expect((await h.call("api", { http: "POST", path: path(), json: [ann("ANNOTA02")] })).status).toBe(405);
		expect((await h.call("api", { http: "PUT", path: `/api/attachments/../items/${itemKey}/annotations`, json: [] })).status).not.toBe(
			200,
		);
		expect((await h.call("api", { http: "GET", path: path() })).json).toEqual([]);
	});
});

describe("api method: changes made by another process", () => {
	test("`ext` from GET /api/ui/selection moves when another connection commits", async () => {
		const total = async () =>
			(await h.call("api", { http: "GET", path: "/api/items?sort=title&dir=asc&limit=100" })).json.total as number;
		const count = await total();
		const before = (await h.call("api", { http: "GET", path: "/api/ui/selection" })).json.ext;
		const again = (await h.call("api", { http: "GET", path: "/api/ui/selection" })).json.ext;
		expect(again).toBe(before);
		const db = repo.openDb(dbPath);
		repo.createItem(db, { itemType: "book", title: "Written by the desktop app" } as never);
		db.close(true);
		const after = (await h.call("api", { http: "GET", path: "/api/ui/selection" })).json.ext;
		expect(after).not.toBe(before);
		expect(await total()).toBe(count + 1);
	});
});

describe("apiRefusal", () => {
	test("library reads and edits open; account routes and routes that act on this computer closed", () => {
		expect(apiRefusal("GET", "/api/items")).toBeNull();
		expect(apiRefusal("HEAD", "/api/attachments/ABCD1234/file")).toBeNull();
		expect(apiRefusal("POST", "/api/ui/selection")).toBeNull();
		expect(apiRefusal("PATCH", "/api/items/ABCD1234")).toBeNull();
		expect(apiRefusal("PUT", "/api/tag-colors")).toBeNull();
		expect(apiRefusal("PUT", "/api/attachments/ABCD1234/annotations")).toBeNull();
		expect(apiRefusal("PUT", "/api/attachments/ABCD1234/file")).toBeNull();
		expect(apiRefusal("POST", "/api/maintenance/empty-trash")).toBeNull();
		expect(apiRefusal("POST", "/api/ui/reveal")).not.toBeNull();
		expect(apiRefusal("POST", "/api/open-url")).not.toBeNull();
		expect(apiRefusal("POST", "/api/attachments/ABCD1234/open-external")).not.toBeNull();
		expect(apiRefusal("POST", "/api/files/pick-folder")).not.toBeNull();
		expect(apiRefusal("GET", "/api/files/settings")).not.toBeNull(); // discloses local paths
		expect(apiRefusal("POST", "/api/io/mendeley")).not.toBeNull();
		expect(apiRefusal("GET", "/api/sync")).not.toBeNull();
		expect(apiRefusal("POST", "/api/websync/start")).not.toBeNull();
		expect(apiRefusal("GET", "/api/integrations")).not.toBeNull();
		expect(apiRefusal("PUT", "/api/attachments/../items")).not.toBeNull();
		expect(apiRefusal("GET", "/apix")).not.toBeNull();
	});
});
