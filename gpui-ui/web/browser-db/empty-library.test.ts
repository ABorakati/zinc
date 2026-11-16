// emptyBrowserLibrary: the library is empty afterwards, nothing is queued for zotero.org, and the library keeps working.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as repo from "../../../core/src/db";
import { indexItem, search } from "../../../core/src/search";
import { emptyBrowserLibrary } from "./empty-library";

const dir = mkdtempSync(join(tmpdir(), "zn-empty-"));
afterAll(() => {
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch {
		/* WAL */
	}
});

test("empties every table, queues no delete for zotero.org, and signs out of sync", async () => {
	const db = repo.openDb(join(dir, "library.sqlite"));
	const c = repo.createCollection(db, "Reading");
	const sub = repo.createCollection(db, "Sub", c.key);
	const it = repo.createItem(db, { itemType: "book", title: "Quokkas", collections: [c.key] } as never);
	repo.addTags(db, it.data.key, ["a"]);
	repo.createItem(db, { itemType: "note", note: "<p>n</p>", parentItem: it.data.key } as never);
	db.query(
		"INSERT INTO sync_state(name, value) VALUES('mode', 'zotero-org') ON CONFLICT(name) DO UPDATE SET value = excluded.value",
	).run();
	db.query("INSERT INTO websync_versions(type, key, version) VALUES ('item', ?, 5)").run(it.data.key);
	indexItem(db, it.data.key);
	expect(search(db, "quokkas").hits.length).toBe(1);

	const r = await emptyBrowserLibrary(db);
	expect(r.items).toBe(2);
	expect(r.collections).toBe(2);
	const n = (t: string) => (db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
	for (const t of [
		"items",
		"collections",
		"collection_items",
		"item_tags",
		"attachments",
		"annotations",
		"fulltext",
		"sync_outbox",
		"websync_versions",
		"search",
	])
		expect(n(t)).toBe(0);
	expect((db.query("SELECT value FROM sync_state WHERE name = 'mode'").get() as { value: string }).value).toBe("off");
	expect(search(db, "quokkas").hits.length).toBe(0);
	void sub;

	// the library works as before: a new item is recorded for sync (the suppress flag is gone)
	const again = repo.createItem(db, { itemType: "book", title: "After the move" } as never);
	expect((db.query("SELECT count(*) AS n FROM sync_outbox WHERE key = ?").get(again.data.key) as { n: number }).n).toBe(1);
	expect(n("sync_flags")).toBe(0);
	db.close(true);
});
