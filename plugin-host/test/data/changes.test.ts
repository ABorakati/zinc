// The core change log (migration 5), GET /api/changes and POST /api/batch, against a throwaway core.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startCore, wait, type TestCore } from "./core-fixture";

let core: TestCore;
beforeAll(async () => {
	core = await startCore();
});
afterAll(() => core.stop());

const get = async (path: string) => (await fetch(core.url + path)).json() as Promise<any>;
const post = (path: string, body: unknown) => fetch(core.url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const head = async () => (await get("/api/changes/head")).head as number;

describe("change log", () => {
	test("the migration is applied and every write path is logged", async () => {
		expect((core.db.query("SELECT value FROM meta WHERE name = 'schema_version'").get() as any).value).toBe("5");
		const h0 = await head();
		// item create, patch, tag, collection membership, trash, restore through the ordinary routes
		const created = await (await post("/api/items", { data: { itemType: "book", title: "Log me", tags: [{ tag: "t1" }] } })).json();
		const key = created.data.key;
		await fetch(`${core.url}/api/items/${key}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: { title: "Logged" } }) });
		await post(`/api/items/${key}/tags`, { tags: ["t2"] });
		const coll = await (await post("/api/collections", { name: "C" })).json();
		await post(`/api/collections/${coll.key}/items`, { keys: [key] });
		await fetch(`${core.url}/api/items/${key}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: { deleted: 1 } }) });
		await fetch(`${core.url}/api/items/${key}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: { deleted: 0 } }) });
		const s = await (await post("/api/searches", { name: "S", conditions: [{ field: "title", operator: "contains", value: "x" }], options: {} })).json();
		await post(`/api/attachments/ATT00002/annotations`.replace("/annotations", "/annotations"), {}).catch(() => {});
		const page = await get(`/api/changes?since=${h0}`);
		expect(page.reset).toBe(false);
		const kinds = page.changes.map((c: any) => `${c.object}:${c.kind}`);
		expect(kinds).toContain("item:add");
		expect(kinds).toContain("item:modify");
		expect(kinds).toContain("item-tag:add");
		expect(kinds).toContain("collection:add");
		expect(kinds).toContain("collection-item:add");
		expect(kinds).toContain("item:trash");
		expect(kinds).toContain("item:restore");
		expect(kinds).toContain("search:add");
		expect(page.changes.find((c: any) => c.object === "collection-item").key).toBe(`${coll.key}-${key}`);
		expect(page.changes.find((c: any) => c.object === "item-tag").key).toBe(`${key}-t1`);
		expect(page.changes.every((c: any) => c.origin === "unknown" && c.silent === false && c.library === 1 || c.object === "search")).toBe(true);
		// seq is strictly increasing and the cursor is the head
		const seqs = page.changes.map((c: any) => c.seq);
		expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
		expect(page.cursor).toBe(page.head);
		// erase and delete are logged too
		const h1 = await head();
		await fetch(`${core.url}/api/collections/${coll.key}`, { method: "DELETE" });
		await fetch(`${core.url}/api/searches/${s.key}`, { method: "DELETE" });
		const after = (await get(`/api/changes?since=${h1}`)).changes.map((c: any) => `${c.object}:${c.kind}`);
		expect(after).toContain("collection:delete");
		expect(after).toContain("collection-item:remove");
		expect(after).toContain("search:delete");
	});

	test("paging, library filter, reset", async () => {
		const h = await head();
		for (let i = 0; i < 5; i++) await post("/api/items", { data: { itemType: "book", title: `P${i}` } });
		const a = await get(`/api/changes?since=${h}&limit=2`);
		expect(a.changes).toHaveLength(2);
		expect(a.cursor).toBe(a.changes[1].seq);
		const b = await get(`/api/changes?since=${a.cursor}&limit=50`);
		expect(b.changes.length).toBe(3);
		expect((await get(`/api/changes?since=${h}&library=1`)).changes.length).toBe(5);
		const ahead = await get(`/api/changes?since=${(await head()) + 1000}`);
		expect(ahead.reset).toBe(true);
	});

	test("long poll answers when a change arrives, and times out empty", async () => {
		const h = await head();
		const t0 = Date.now();
		const empty = await get(`/api/changes?since=${h}&wait=300`);
		expect(empty.changes).toHaveLength(0);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
		const pending = get(`/api/changes?since=${h}&wait=5000`);
		await wait(150);
		await post("/api/items", { data: { itemType: "book", title: "wake" } });
		const woke = await pending;
		expect(woke.changes.length).toBeGreaterThan(0);
		expect(Date.now() - t0).toBeLessThan(4000);
	});

	test("the event stream sends changes", async () => {
		const res = await fetch(`${core.url}/api/changes/stream`);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const reader = res.body!.getReader();
		const dec = new TextDecoder();
		let buf = "";
		await post("/api/items", { data: { itemType: "book", title: "streamed" } });
		const t0 = Date.now();
		while (!buf.includes("event: changes") && Date.now() - t0 < 4000) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += dec.decode(value);
		}
		await reader.cancel();
		expect(buf).toContain("event: changes");
		const data = JSON.parse(buf.split("data: ")[1].split("\n")[0]);
		expect(data.changes.some((c: any) => c.object === "item" && c.kind === "add")).toBe(true);
	});
});

describe("POST /api/batch", () => {
	test("creates linked objects with caller keys in one transaction, tagged with the origin", async () => {
		const h = await head();
		const r = await post("/api/batch", {
			origin: "plugin:batch@zinc.test",
			changes: [
				{ tag: "create-collection", val: { key: "COLLKEY2", name: "Batch collection" } },
				{ tag: "create-item", val: { key: "ITEMKEY2", data: { itemType: "journalArticle", title: "Batched", creators: [{ creatorType: "author", firstName: "A", lastName: "B" }] } } },
				{ tag: "create-item", val: { key: "NOTEKEY2", data: { itemType: "note", note: "<p>child</p>", parentItem: "ITEMKEY2" } } },
				{ tag: "add-to-collection", val: { collection: "COLLKEY2", items: ["ITEMKEY2"] } },
				{ tag: "add-tags", val: { items: ["ITEMKEY2"], tags: [{ name: "auto", kind: "automatic" }, { name: "man", kind: "manual" }] } },
				{ tag: "add-related", val: { a: "ITEMKEY2", b: "AAAAAAA1" } },
				{ tag: "update-item", val: { key: "ITEMKEY2", patch: { title: "Batched 2" } } },
			],
		});
		expect(r.status).toBe(200);
		const body = await r.json();
		expect(body.created).toEqual(["COLLKEY2", "ITEMKEY2", "NOTEKEY2"]);
		const d = await get("/api/items/ITEMKEY2");
		expect(d.data.title).toBe("Batched 2");
		expect(d.data.collections).toEqual(["COLLKEY2"]);
		expect(d.tags.find((t: any) => t.tag === "auto").type).toBe(1);
		expect(d.children.map((c: any) => c.key)).toEqual(["NOTEKEY2"]);
		const log = (await get(`/api/changes?since=${h}`)).changes;
		expect(log.length).toBeGreaterThan(5);
		expect(log.every((c: any) => c.origin === "plugin:batch@zinc.test")).toBe(true);
		// the context row is gone afterwards: the next ordinary write is "unknown" again
		const h2 = await head();
		await post("/api/items", { data: { itemType: "book", title: "after" } });
		expect((await get(`/api/changes?since=${h2}`)).changes[0].origin).toBe("unknown");
		expect(core.db.query("SELECT count(*) AS n FROM change_ctx").get()).toEqual({ n: 0 });
	});

	test("a failing change rolls back everything and names its index", async () => {
		const h = await head();
		const before = (core.db.query("SELECT count(*) AS n FROM items").get() as any).n;
		const r = await post("/api/batch", {
			changes: [
				{ tag: "create-item", val: { data: { itemType: "book", title: "never" } } },
				{ tag: "create-item", val: { data: { itemType: "book", title: "never 2" } } },
				{ tag: "update-item", val: { key: "NOSUCHK2", patch: { title: "x" } } },
			],
		});
		expect(r.status).toBe(404);
		const body = await r.json();
		expect(body.index).toBe(2);
		expect((core.db.query("SELECT count(*) AS n FROM items").get() as any).n).toBe(before);
		expect(await head()).toBe(h); // not even the log rows survive
		expect(core.db.query("SELECT count(*) AS n FROM change_ctx").get()).toEqual({ n: 0 });
	});

	test("expectedModified conflicts, erase needs the trash, unknown changes are refused", async () => {
		const stale = await post("/api/batch", { changes: [{ tag: "update-item", val: { key: "AAAAAAA1", patch: { title: "x" }, expectedModified: "1999-01-01T00:00:00Z" } }] });
		expect(stale.status).toBe(409);
		const notTrashed = await post("/api/batch", { changes: [{ tag: "erase-items", val: ["BBBBBBB2"] }] });
		expect(notTrashed.status).toBe(409);
		expect((await post("/api/batch", { changes: [{ tag: "explode", val: 1 }] })).status).toBe(400);
		const dup = await post("/api/batch", { changes: [{ tag: "create-item", val: { key: "AAAAAAA1", data: { itemType: "book" } } }] });
		expect(dup.status).toBe(409);
	});

	test("trash, restore, publications, saved searches, collection erase with items", async () => {
		const r = await post("/api/batch", {
			changes: [
				{ tag: "create-collection", val: { key: "COLLKEY3", name: "Doomed" } },
				{ tag: "create-item", val: { key: "ITEMKEY3", data: { itemType: "book", title: "Doomed item", collections: ["COLLKEY3"] } } },
				{ tag: "add-to-publications", val: ["ITEMKEY3"] },
				{ tag: "create-saved-search", val: { key: "SRCHKEY3", name: "Mine", conditions: [{ field: "title", operator: "contains", value: "Doomed" }], options: {} } },
				{ tag: "erase-collection", val: { key: "COLLKEY3", trashItems: true } },
			],
		});
		expect(r.status).toBe(200);
		expect((await get("/api/items/ITEMKEY3")).data.deleted).toBe(1);
		expect((await get("/api/items/ITEMKEY3")).data.inPublications).toBe(true);
		expect((await get("/api/searches/SRCHKEY3")).name).toBe("Mine");
		const un = await post("/api/batch", { changes: [{ tag: "restore-items", val: ["ITEMKEY3"] }, { tag: "erase-saved-search", val: "SRCHKEY3" }] });
		expect(un.status).toBe(200);
		expect((await get("/api/items/ITEMKEY3")).data.deleted).toBeUndefined();
		const again = await post("/api/batch", { changes: [{ tag: "trash-items", val: ["ITEMKEY3"] }, { tag: "erase-items", val: ["ITEMKEY3"] }] });
		expect(again.status).toBe(200);
		expect((await fetch(`${core.url}/api/items/ITEMKEY3`)).status).toBe(404);
	});

	test("skipNotify marks log rows silent", async () => {
		const h = await head();
		await post("/api/batch", { skipNotify: true, origin: "plugin:q@zinc.test", changes: [{ tag: "create-item", val: { data: { itemType: "book", title: "quiet" } } }] });
		const rows = (await get(`/api/changes?since=${h}`)).changes;
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((c: any) => c.silent === true)).toBe(true);
	});

	test("the CSRF guard still applies (JSON only)", async () => {
		const r = await fetch(`${core.url}/api/batch`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
		expect(r.status).toBe(403);
	});
});

describe("migration of an existing library", () => {
	test("a v4 library gains the change log and keeps its rows", async () => {
		const { Database } = await import("bun:sqlite");
		const { migrate, MIGRATIONS } = await import("../../../core/src/migrations");
		const { join } = await import("node:path");
		const f = join(core.dir, "v4.sqlite");
		const raw = new Database(f);
		migrate(raw, f, { migrations: MIGRATIONS.filter((m) => m.id < 5) });
		raw.run("INSERT INTO items(key, item_type, title, data, date_added, date_modified) VALUES('OLDKEY01', 'book', 'Old', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
		raw.close();
		const up = new Database(f);
		const res = migrate(up, f);
		expect(res.from).toBe(4);
		expect(res.to).toBe(5);
		expect(res.backup).toBeTruthy();
		expect((up.query("SELECT count(*) AS n FROM items").get() as any).n).toBe(1);
		expect((up.query("SELECT count(*) AS n FROM change_log").get() as any).n).toBe(0); // history is not invented
		up.run("UPDATE items SET title = 'New' WHERE key = 'OLDKEY01'");
		expect(up.query("SELECT object, kind, key FROM change_log").all()).toEqual([{ object: "item", kind: "modify", key: "OLDKEY01" }]);
		up.close();
	});
});
