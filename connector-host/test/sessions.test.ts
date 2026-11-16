// The save popup's host methods (src/sessions.ts) through the compiled host: list what a save created, move it to the Trash
// ("Remove"), and cancel a save. Runs against a fresh temp library.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as repo from "../../core/src/db";
import { HostClient } from "./client";

const ROOT = mkdtempSync(join(tmpdir(), "znh-sessions-"));
const dbPath = join(ROOT, "library.sqlite");
let h: HostClient;
let older = "";

const article = (id: string) => ({
	id,
	itemType: "journalArticle",
	title: `Popup fixture ${id}`,
	creators: [{ firstName: "Ana", lastName: "Lopez", creatorType: "author" }],
	date: "2025",
	attachments: [
		{ id: `${id}-pdf`, title: "Full Text PDF", url: `https://example.org/${id}.pdf`, mimeType: "application/pdf", parentItem: id },
	],
});
const pdfBytes = new TextEncoder().encode("%PDF-1.4\n% fixture\n");
const row = (key: string) => {
	const db = repo.openDb(dbPath);
	try {
		return db.query("SELECT deleted FROM items WHERE key = ?").get(key) as { deleted: number } | null;
	} finally {
		db.close(true);
	}
};

beforeAll(() => {
	const db = repo.openDb(dbPath);
	older = repo.createItem(db, { itemType: "book", title: "Already in the library" } as never).data.key;
	db.close(true);
	h = new HostClient({ ZN_DB: dbPath });
});
afterAll(async () => {
	await h.close();
	try {
		rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch {
		/* Windows may hold the WAL */
	}
});

describe("sessionItems and trashSession", () => {
	test("lists the items a save created, with their attachments", async () => {
		expect((await h.call("saveItems", { json: { sessionID: "P1", items: [article("a1"), article("a2")] } })).status).toBe(201);
		const meta = JSON.stringify({
			id: "a1-pdf",
			url: "https://example.org/a1.pdf",
			contentType: "application/pdf",
			parentItemID: "a1",
			title: "Full Text PDF",
		});
		expect(
			(
				await h.call("saveAttachment", {
					bytes: pdfBytes,
					headers: { "Content-Type": "application/pdf", "X-Metadata": meta },
					query: "sessionID=P1",
				})
			).status,
		).toBe(201);
		const r = await h.call("sessionItems", { json: { sessionID: "P1" } });
		expect(r.status).toBe(200);
		expect(r.json.items.map((i: { title: string }) => i.title).sort()).toEqual(["Popup fixture a1", "Popup fixture a2"]);
		const a1 = r.json.items.find((i: { title: string }) => i.title === "Popup fixture a1");
		expect(a1.attachments).toEqual([expect.objectContaining({ title: "Full Text PDF", contentType: "application/pdf" })]);
		expect(r.json.cancelled).toBe(false);
	});

	test("Remove moves only that session's items to the Trash (soft delete), and nothing else", async () => {
		const keys = (await h.call("sessionItems", { json: { sessionID: "P1" } })).json.items.map((i: { key: string }) => i.key);
		const r = await h.call("trashSession", { json: { sessionID: "P1" } });
		expect(r.status).toBe(200);
		expect(r.json.trashed.sort()).toEqual([...keys].sort());
		for (const k of keys) expect(row(k)?.deleted).toBe(1); // still there, in the Trash
		expect(row(older)?.deleted).toBe(0);
		expect((await h.call("sessionItems", { json: { sessionID: "P1" } })).json.items).toEqual([]);
		// the library page / app see them in the Trash
		const trash = await h.call("api", { http: "GET", path: "/api/items?trash=1&sort=title&dir=asc" });
		expect(trash.json.items.map((i: { key: string }) => i.key).sort()).toEqual([...keys].sort());
	});

	test("unknown sessions are 404, a missing id is 400", async () => {
		expect((await h.call("trashSession", { json: { sessionID: "NOPE" } })).status).toBe(404);
		expect((await h.call("sessionItems", { json: { sessionID: "NOPE" } })).status).toBe(404);
		expect((await h.call("trashSession", { json: {} })).status).toBe(400);
	});
});

describe("cancelSession", () => {
	test("trashes what was saved so far and refuses the save's later calls", async () => {
		expect((await h.call("saveItems", { json: { sessionID: "C1", items: [article("c1")] } })).status).toBe(201);
		const key = (await h.call("sessionItems", { json: { sessionID: "C1" } })).json.items[0].key;
		const c = await h.call("cancelSession", { json: { sessionID: "C1" } });
		expect(c.status).toBe(200);
		expect(c.json).toMatchObject({ cancelled: true, trashed: [key] });
		expect(row(key)?.deleted).toBe(1);
		const meta = JSON.stringify({
			id: "c1-pdf",
			url: "https://example.org/c1.pdf",
			contentType: "application/pdf",
			parentItemID: "c1",
			title: "Full Text PDF",
		});
		const att = await h.call("saveAttachment", {
			bytes: pdfBytes,
			headers: { "Content-Type": "application/pdf", "X-Metadata": meta },
			query: "sessionID=C1",
		});
		expect(att.status).toBe(409);
		expect(att.json.error).toBe("SESSION_CANCELLED");
		expect((await h.call("updateSession", { json: { sessionID: "C1", target: "L1" } })).status).toBe(409);
	});

	test("a save cancelled before it reached the host is refused outright", async () => {
		expect((await h.call("cancelSession", { json: { sessionID: "C2" } })).json.cancelled).toBe(true);
		const r = await h.call("saveItems", { json: { sessionID: "C2", items: [article("c2")] } });
		expect(r.status).toBe(409);
		const db = repo.openDb(dbPath);
		try {
			expect(db.query("SELECT count(*) n FROM items WHERE title = 'Popup fixture c2'").get()).toEqual({ n: 0 });
		} finally {
			db.close(true);
		}
	});

	test("the library page cannot call these through api (they are host methods, not /api routes)", async () => {
		expect((await h.call("api", { http: "POST", path: "/api/items/trash", json: { keys: [older] } })).status).not.toBe(200);
		expect(row(older)?.deleted).toBe(0);
	});
});
