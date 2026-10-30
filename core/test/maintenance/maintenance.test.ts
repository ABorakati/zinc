import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { buildFixture, call, type Fixture } from "../fixture";
import { getTagColors, setTagColors } from "../../src/db";
import { setStorageDir } from "../../src/maintenance/api";
import { baseNameFor, sanitizeFileName } from "../../src/maintenance/rename-files";

let fx: Fixture;
let db: Database;
let storage: string;

const outbox = () => db.query("SELECT type, key, op FROM sync_outbox ORDER BY seq").all() as { type: string; key: string; op: string }[];
const has = (type: string, key: string, op: string) => outbox().some((o) => o.type === type && o.key === key && o.op === op);
const dataTags = (key: string) =>
	((JSON.parse((db.query("SELECT data FROM items WHERE key = ?").get(key) as { data: string }).data).tags ?? []) as { tag: string; type?: number }[])
		.map((t) => t.tag)
		.sort();
const rowTags = (key: string) => (db.query("SELECT tag FROM item_tags WHERE item_key = ? ORDER BY tag").all(key) as { tag: string }[]).map((r) => r.tag);

/** Move ATT00002's PDF into zotero-next's own storage dir. */
function storeOwnFile(key: string, name: string): string {
	const dir = join(storage, key);
	mkdirSync(dir, { recursive: true });
	const p = join(dir, name);
	writeFileSync(p, "pdf");
	db.query("UPDATE attachments SET path = ? WHERE item_key = ?").run(p, key);
	return p;
}

beforeEach(() => {
	fx = buildFixture();
	db = fx.db;
	storage = join(fx.dir, "storage");
	setStorageDir(storage);
	db.run("DELETE FROM sync_outbox");
});
afterEach(() => {
	setStorageDir(undefined);
	db.close(true);
});

describe("erase", () => {
	test("cascades to children, records outbox deletes, updates search, removes only own-storage files", async () => {
		const own = storeOwnFile("ATT00002", "paper.pdf");
		writeFileSync(join(fx.dir, "outside.pdf"), "x");
		db.query("UPDATE attachments SET path = ? WHERE item_key = 'ATT00001'").run(join(fx.dir, "outside.pdf"));
		db.run("DELETE FROM sync_outbox");

		const res = await call(db, "POST", "/api/maintenance/erase", { keys: ["AAAAAAA1"] });
		expect(res.status).toBe(200);
		const r = (await res.json()) as { erased: number; topLevel: number; filesRemoved: number; filesKept: number };
		expect(r.erased).toBe(4); // item + note + 2 attachments
		expect(r.topLevel).toBe(1);
		expect(r.filesRemoved).toBe(1);
		expect(r.filesKept).toBe(1);

		expect(existsSync(own)).toBe(false);
		expect(existsSync(join(storage, "ATT00002"))).toBe(false); // empty dir removed
		expect(existsSync(join(fx.dir, "outside.pdf"))).toBe(true);
		expect(existsSync(fx.pdfPath)).toBe(true);

		for (const k of ["AAAAAAA1", "NOTE0001", "ATT00001", "ATT00002"]) {
			expect(db.query("SELECT 1 FROM items WHERE key = ?").get(k)).toBeNull();
			expect(has("item", k, "delete")).toBe(true);
			expect(outbox().some((o) => o.type === "item" && o.key === k && o.op !== "delete")).toBe(false);
		}
		expect(has("annotation", "ANNO0001", "delete")).toBe(true);
		expect(db.query("SELECT 1 FROM annotations").get()).toBeNull();
		expect(db.query("SELECT 1 FROM fulltext").get()).toBeNull();
		expect(db.query("SELECT 1 FROM collection_items").get()).toBeNull();
		expect(db.query("SELECT count(*) AS n FROM search WHERE search MATCH 'radiology'").get()).toEqual({ n: 0 });
		// untouched item survives
		expect(db.query("SELECT 1 FROM items WHERE key = 'BBBBBBB2'").get()).not.toBeNull();
	});

	test("erasing a child note re-indexes its parent and keeps the parent", async () => {
		expect(db.query("SELECT count(*) AS n FROM search WHERE search MATCH 'transformer'").get()).toEqual({ n: 1 });
		await call(db, "POST", "/api/maintenance/erase", { keys: ["NOTE0001"] });
		expect(db.query("SELECT 1 FROM items WHERE key = 'AAAAAAA1'").get()).not.toBeNull();
		expect(db.query("SELECT count(*) AS n FROM search WHERE search MATCH 'transformer'").get()).toEqual({ n: 0 });
		expect(has("item", "NOTE0001", "delete")).toBe(true);
	});

	test("reports missing keys and validates the body", async () => {
		const r = (await (await call(db, "POST", "/api/maintenance/erase", { keys: ["NOPE0000"] })).json()) as { erased: number; missing: string[] };
		expect(r.erased).toBe(0);
		expect(r.missing).toEqual(["NOPE0000"]);
		expect((await call(db, "POST", "/api/maintenance/erase", { keys: "x" })).status).toBe(400);
	});

	test("empty trash removes only trashed items; olderThanDays filters", async () => {
		const c = (await (await call(db, "GET", "/api/maintenance/trash")).json()) as { items: number; total: number };
		expect(c).toEqual({ items: 1, total: 1 });
		// trashed just now: not older than 30 days
		db.query("UPDATE items SET date_modified = ? WHERE key = 'CCCCCCC3'").run(new Date().toISOString().replace(/\.\d+Z$/, "Z"));
		const none = (await (await call(db, "POST", "/api/maintenance/empty-trash", { olderThanDays: 30 })).json()) as { erased: number };
		expect(none.erased).toBe(0);
		expect(db.query("SELECT 1 FROM items WHERE key = 'CCCCCCC3'").get()).not.toBeNull();

		const all = (await (await call(db, "POST", "/api/maintenance/empty-trash", {})).json()) as { erased: number };
		expect(all.erased).toBe(1);
		expect(db.query("SELECT 1 FROM items WHERE key = 'CCCCCCC3'").get()).toBeNull();
		expect(has("item", "CCCCCCC3", "delete")).toBe(true);
		expect(db.query("SELECT count(*) AS n FROM items WHERE deleted = 0").get()).not.toEqual({ n: 0 });
	});
});

describe("tags", () => {
	test("rename keeps data JSON, index and colours in sync", async () => {
		setTagColors(db, [{ name: "ml", color: "#FF6666" }, { name: "other", color: "#00AA00" }]);
		const r = (await (await call(db, "POST", "/api/maintenance/tags/rename", { from: "ml", to: "machine learning" })).json()) as { items: number; merged: boolean };
		expect(r).toEqual({ items: 1, merged: false });
		expect(rowTags("AAAAAAA1")).toEqual(["imaging", "machine learning"]);
		expect(dataTags("AAAAAAA1")).toEqual(["imaging", "machine learning"]);
		expect(has("item", "AAAAAAA1", "upsert")).toBe(true);
		expect(getTagColors(db).map((c) => [c.name, c.color, c.position])).toEqual([
			["machine learning", "#FF6666", 0],
			["other", "#00AA00", 1],
		]);
		expect(db.query("SELECT count(*) AS n FROM search WHERE search MATCH 'tags:\"machine learning\"'").get()).toEqual({ n: 1 });
	});

	test("rename onto an existing tag merges, including items that already have both", async () => {
		setTagColors(db, [{ name: "ml", color: "#FF6666" }, { name: "imaging", color: "#0000FF" }]);
		const r = (await (await call(db, "POST", "/api/maintenance/tags/rename", { from: "ml", to: "imaging" })).json()) as { items: number; merged: boolean };
		expect(r.merged).toBe(true);
		expect(rowTags("AAAAAAA1")).toEqual(["imaging"]);
		expect(dataTags("AAAAAAA1")).toEqual(["imaging"]);
		expect(rowTags("BBBBBBB2")).toEqual(["imaging"]);
		// target's own colour wins, old colour dropped
		expect(getTagColors(db).map((c) => [c.name, c.color])).toEqual([["imaging", "#0000FF"]]);
	});

	test("rename validates input and allows a case-only change", async () => {
		expect((await call(db, "POST", "/api/maintenance/tags/rename", { from: "ml", to: "  " })).status).toBe(400);
		await call(db, "POST", "/api/maintenance/tags/rename", { from: "ml", to: "ML" });
		expect(rowTags("AAAAAAA1")).toEqual(["ML", "imaging"]);
	});

	test("delete removes rows, data JSON and colour", async () => {
		setTagColors(db, [{ name: "imaging", color: "#0000FF" }]);
		const r = (await (await call(db, "POST", "/api/maintenance/tags/delete", { tags: ["imaging"] })).json()) as { tags: number; items: number };
		expect(r).toEqual({ tags: 1, items: 2 });
		expect(rowTags("AAAAAAA1")).toEqual(["ml"]);
		expect(dataTags("AAAAAAA1")).toEqual(["ml"]);
		expect(dataTags("BBBBBBB2")).toEqual([]);
		expect(getTagColors(db)).toEqual([]);
		expect(has("item", "BBBBBBB2", "upsert")).toBe(true);
	});

	test("delete-automatic only removes automatic rows", async () => {
		db.query("INSERT INTO item_tags(item_key, tag, type) VALUES('BBBBBBB2', 'auto1', 1), ('BBBBBBB2', 'ml', 1), ('DDDDDDD4', 'auto1', 1)").run();
		const list = (await (await call(db, "GET", "/api/maintenance/tags/automatic")).json()) as { tag: string; count: number }[];
		expect(list.map((t) => t.tag)).toEqual(["auto1", "ml"]);
		const r = (await (await call(db, "POST", "/api/maintenance/tags/delete-automatic", {})).json()) as { tags: number; items: number };
		expect(r).toEqual({ tags: 2, items: 2 });
		expect(rowTags("BBBBBBB2")).toEqual(["imaging"]);
		expect(rowTags("DDDDDDD4")).toEqual([]);
		expect(rowTags("AAAAAAA1")).toEqual(["imaging", "ml"]); // manual "ml" untouched
		expect(dataTags("AAAAAAA1")).toEqual(["imaging", "ml"]);
	});
});

describe("rename files", () => {
	test("sanitises and truncates names", () => {
		expect(sanitizeFileName('A: B/C\\D*E?"F<G>H|I')).toBe("A BCDEFGHI");
		expect(sanitizeFileName("  ..trailing dots.. ")).toBe("trailing dots");
		expect(sanitizeFileName("CON")).toBe("_CON");
		expect(sanitizeFileName("tab\there\nnewline")).toBe("tab here newline");
		const long = baseNameFor({ creators_summary: "Smith et al.", year: 2020, title: "word ".repeat(60) })!;
		expect(long.startsWith("Smith et al. - 2020 - word")).toBe(true);
		expect(long.length).toBeLessThanOrEqual("Smith et al. - 2020 - ".length + 100);
		expect(baseNameFor({ creators_summary: null, year: null, title: null })).toBeNull();
		expect(baseNameFor({ creators_summary: "Lee", year: null, title: "Zebra: genetics?" })).toBe("Lee - Zebra genetics");
	});

	test("renames own-storage files from parent metadata; skips others with a reason", async () => {
		const own = storeOwnFile("ATT00002", "download.pdf");
		const res = await call(db, "POST", "/api/maintenance/rename-files", { attachmentKeys: ["ATT00002", "ATT00001", "ATT00003", "NOTE0001", "AAAAAAA1"] });
		const { results } = (await res.json()) as { results: { key: string; status: string; reason?: string; path?: string }[] };
		const by = Object.fromEntries(results.map((r) => [r.key, r]));
		const expected = join(storage, "ATT00002", "Smith and Jones - 2020 - Deep learning for radiology.pdf");
		expect(by.ATT00002.status).toBe("renamed");
		expect(by.ATT00002.path).toBe(expected);
		expect(existsSync(expected)).toBe(true);
		expect(existsSync(own)).toBe(false);
		expect(db.query("SELECT path FROM attachments WHERE item_key = 'ATT00002'").get()).toEqual({ path: expected });
		const data = JSON.parse((db.query("SELECT data FROM items WHERE key = 'ATT00002'").get() as { data: string }).data);
		expect(data.filename).toBe("Smith and Jones - 2020 - Deep learning for radiology.pdf");
		expect(has("item", "ATT00002", "upsert")).toBe(true);
		for (const k of ["ATT00001", "ATT00003", "NOTE0001", "AAAAAAA1"]) {
			expect(by[k].status).toBe("skipped");
			expect(by[k].reason).toBeTruthy();
		}
		// running again: already named
		const again = (await (await call(db, "POST", "/api/maintenance/rename-files", { attachmentKeys: ["ATT00002"] })).json()) as { results: { status: string }[] };
		expect(again.results[0].status).toBe("skipped");
	});

	test("never renames files outside zotero-next storage", async () => {
		const res = (await (await call(db, "POST", "/api/maintenance/rename-files", { attachmentKeys: ["ATT00002"] })).json()) as { results: { status: string; reason: string }[] };
		expect(res.results[0].status).toBe("skipped");
		expect(res.results[0].reason).toContain("own storage");
		expect(existsSync(fx.pdfPath)).toBe(true);
	});
});
