import { expect, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../../src/db";
import { tempDir } from "../fixture";

// Insert 1,000 items (each with 2 tags and a collection link) with and without the sync triggers.
function run(withTriggers: boolean): number {
	const db = openDb(join(tempDir(), "lib.sqlite"));
	if (!withTriggers) {
		const names = (db.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync_%'").all() as { name: string }[]).map((r) => r.name);
		for (const n of names) db.run(`DROP TRIGGER ${n}`);
	}
	db.run("INSERT INTO collections(key, name) VALUES('COLL0001', 'c')");
	const ins = db.prepare(
		"INSERT INTO items(key, item_type, title, data, date_added, date_modified) VALUES(?, 'journalArticle', ?, '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
	);
	const tag = db.prepare("INSERT INTO item_tags(item_key, tag, type) VALUES(?, ?, 0)");
	const ci = db.prepare("INSERT INTO collection_items(collection_key, item_key) VALUES('COLL0001', ?)");
	const t0 = performance.now();
	db.transaction(() => {
		for (let i = 0; i < 1000; i++) {
			const k = `K${String(i).padStart(7, "0")}`;
			ins.run(k, `t${i}`);
			tag.run(k, "a");
			tag.run(k, "b");
			ci.run(k);
		}
	})();
	const ms = performance.now() - t0;
	if (withTriggers) expect((db.query("SELECT count(*) AS n FROM sync_outbox").get() as { n: number }).n).toBe(1001);
	db.close(true);
	return ms;
}

test("trigger overhead for 1,000 item inserts", () => {
	run(true);
	run(false); // warm-up
	const on = Math.min(run(true), run(true), run(true));
	const off = Math.min(run(false), run(false), run(false));
	console.log(`insert 1,000 items (+2 tags +1 collection link each): triggers on ${on.toFixed(1)} ms, off ${off.toFixed(1)} ms`);
	expect(on).toBeLessThan(off * 5 + 50);
});
