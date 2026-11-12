// POST /api/ui/reveal (used by the Word sidebar's "Open in zotero-next") and the extended GET /api/ui/selection.
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getRev, resetConnectorState } from "../../src/connector/state";
import { handleUiApi } from "../../src/connector/ui";
import { buildFixture, type Fixture } from "../fixture";

let fx: Fixture;
let db: Database;
beforeEach(() => {
	fx = buildFixture();
	db = fx.db;
	resetConnectorState();
});
afterEach(() => db.close());

const ui = (path: string, method = "GET", body?: unknown) =>
	handleUiApi(
		new Request(`http://127.0.0.1:23120${path}`, {
			method,
			headers: { "Content-Type": "application/json" },
			body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
		}),
		db,
	) as Promise<Response>;

describe("/api/ui/reveal", () => {
	test("selection starts without a reveal", async () => {
		const j = (await (await ui("/api/ui/selection")).json()) as { reveal: unknown };
		expect(j.reveal).toBeNull();
	});

	test("reveal of an existing item is published with a rising seq and bumps rev", async () => {
		const key = (db.query("SELECT key FROM items WHERE parent_key IS NULL AND item_type NOT IN ('note','attachment') AND deleted = 0 LIMIT 1").get() as { key: string }).key;
		const rev0 = getRev();
		const r1 = await ui("/api/ui/reveal", "POST", { key });
		expect(r1.status).toBe(200);
		const b1 = (await r1.json()) as { ok: boolean; seq: number; rev: number };
		expect(b1.ok).toBe(true);
		expect(b1.rev).toBeGreaterThan(rev0);
		const sel = (await (await ui("/api/ui/selection")).json()) as { reveal: { key: string; title: string; seq: number; at: number } };
		expect(sel.reveal.key).toBe(key);
		expect(sel.reveal.seq).toBe(b1.seq);
		expect(Date.now() - sel.reveal.at).toBeLessThan(5000);
		const b2 = (await (await ui("/api/ui/reveal", "POST", { key })).json()) as { seq: number };
		expect(b2.seq).toBe(b1.seq + 1);
	});

	test("a child resolves to its parent", async () => {
		const child = db.query("SELECT key, parent_key FROM items WHERE parent_key IS NOT NULL AND deleted = 0 LIMIT 1").get() as { key: string; parent_key: string } | null;
		if (!child) return; // fixture without children
		await ui("/api/ui/reveal", "POST", { key: child.key });
		const sel = (await (await ui("/api/ui/selection")).json()) as { reveal: { key: string } };
		expect(sel.reveal.key).toBe(child.parent_key);
	});

	test("unknown or trashed items are 404, bad input is 400, wrong method 405", async () => {
		expect((await ui("/api/ui/reveal", "POST", { key: "ZZZZZZZZ" })).status).toBe(404);
		const trashed = db.query("SELECT key FROM items WHERE deleted = 1 AND parent_key IS NULL LIMIT 1").get() as { key: string } | null;
		if (trashed) expect((await ui("/api/ui/reveal", "POST", { key: trashed.key })).status).toBe(404);
		expect((await ui("/api/ui/reveal", "POST", { key: "../x" })).status).toBe(400);
		expect((await ui("/api/ui/reveal", "POST", {})).status).toBe(400);
		expect((await ui("/api/ui/reveal", "POST", "not json")).status).toBe(400);
		expect((await ui("/api/ui/reveal", "GET")).status).toBe(405);
		expect((await ui("/api/ui/reveal", "POST", { key: "ZZZZZZZZ" })).headers.get("content-type")).toContain("json");
	});

	test("open: true picks the item's PDF (or the attachment asked for); without a readable file it only selects", async () => {
		const { createItem } = await import("../../src/db");
		const parent = createItem(db, { itemType: "journalArticle", title: "Reveal with open" } as never).data.key;
		const html = createItem(db, { itemType: "attachment", parentItem: parent, title: "Snapshot", linkMode: "imported_url", contentType: "text/html" } as never).data.key;
		const pdf = createItem(db, { itemType: "attachment", parentItem: parent, title: "Full Text PDF", linkMode: "imported_file", contentType: "application/pdf" } as never).data.key;
		const bare = createItem(db, { itemType: "book", title: "No files" } as never).data.key;
		type Sel = { reveal: { key: string; open?: { key: string; title: string } } };
		const sel = async () => ((await (await ui("/api/ui/selection")).json()) as Sel).reveal;

		const a = (await (await ui("/api/ui/reveal", "POST", { key: parent, open: true })).json()) as { opened: string | null };
		expect(a.opened).toBe(pdf);
		expect(await sel()).toMatchObject({ key: parent, open: { key: pdf, title: "Full Text PDF" } });

		await ui("/api/ui/reveal", "POST", { key: html, open: true });
		expect(await sel()).toMatchObject({ key: parent, open: { key: html } });

		const c = (await (await ui("/api/ui/reveal", "POST", { key: bare, open: true })).json()) as { opened: string | null };
		expect(c.opened).toBeNull();
		expect((await sel()).open).toBeUndefined();

		await ui("/api/ui/reveal", "POST", { key: parent });
		expect((await sel()).open).toBeUndefined();
	});

	test("selection POST still works", async () => {
		expect((await ui("/api/ui/selection", "POST", { kind: "trash" })).status).toBe(200);
		expect((await ui("/api/ui/selection", "POST", { kind: "bogus" })).status).toBe(400);
	});
});
