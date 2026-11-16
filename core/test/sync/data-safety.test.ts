// Review findings GPT #5, #6, #15 (local Zotero sync) and Gemini #4 (annotation scoping).
import { describe, expect, test } from "bun:test";
import * as repo from "../../src/db";
import { applyChanges } from "../../src/sync/apply";
import { buildPush, completePush } from "../../src/sync/build";
import { BASELINE_CHANGED } from "../../src/sync/protocol";
import { makeRig, outbox } from "./fakes";

const rows = (db: ReturnType<typeof makeRig>["db"], sql: string, ...p: any[]) => db.query(sql).all(...p) as any[];
const state = (db: ReturnType<typeof makeRig>["db"], name: string) =>
	(db.query("SELECT value FROM sync_state WHERE name = ?").get(name) as { value: string } | null)?.value;

describe("push after a failed pull (GPT #5)", () => {
	test("a failed pull blocks the push; the queue is kept and goes out after a good pull", async () => {
		const r = makeRig();
		repo.createItem(r.db, { itemType: "journalArticle", title: "Queued" });
		r.reader.fail = "snapshot failed";
		await r.svc.setEnabled(true);
		expect(r.writer.batches).toHaveLength(0);
		expect(state(r.db, "pull_error")).toContain("snapshot failed");
		await r.svc.syncNow(); // still failing
		expect(r.writer.batches).toHaveLength(0);
		expect(outbox(r.db).length).toBeGreaterThan(0);
		r.reader.fail = null;
		await r.svc.syncNow();
		expect(r.writer.batches).toHaveLength(1);
	});

	test("writes carry Zotero's last-seen dateModified as the baseline, and a refused write records a conflict", async () => {
		const r = makeRig();
		r.reader.item("BASE0001", { itemType: "journalArticle", title: "Remote" }, "2026-06-01T10:00:00Z");
		await r.svc.pull();
		repo.patchItem(r.db, "BASE0001", { title: "Edited here" });
		const plan = buildPush(r.db, r.zoteroDir);
		const w = plan.writes.find((x) => x.key === "BASE0001" && x.op === "upsert")!;
		expect(w.baseline).toBe("2026-06-01T10:00:00Z");
		const done = completePush(
			r.db,
			plan,
			[{ key: "BASE0001", ok: false, error: `${BASELINE_CHANGED} (BASE0001); not overwritten` }],
			null,
		);
		expect(done.failed).toHaveLength(1);
		expect(outbox(r.db)).toContain("item:BASE0001:upsert"); // still queued
		expect(rows(r.db, "SELECT key, resolved FROM sync_conflicts")).toEqual([{ key: "BASE0001", resolved: "remote" }]);
	});
});

describe("remote parent deletion (GPT #6)", () => {
	test("a parent erased in Zotero is kept while a child has unsent changes", async () => {
		const r = makeRig();
		r.reader.item("PARENT01", { itemType: "journalArticle", title: "Parent" });
		await r.svc.pull();
		const child = repo.createItem(r.db, { itemType: "note", parentItem: "PARENT01", note: "<p>mine</p>" }).data.key;
		r.reader.deletes.push({ type: "item", key: "PARENT01" });
		await r.svc.pull();
		expect(
			rows(r.db, "SELECT key FROM items WHERE key IN ('PARENT01', ?) ORDER BY key", child)
				.map((x) => x.key)
				.sort(),
		).toEqual([child, "PARENT01"].sort());
		const c = rows(r.db, "SELECT type, key, resolved FROM sync_conflicts");
		expect(c).toEqual([{ type: "item", key: "PARENT01", resolved: "local" }]);
		expect(outbox(r.db)).toContain("item:PARENT01:upsert"); // queued again so a push re-creates it
	});

	test("without pending changes in the tree the deletion goes through", async () => {
		const r = makeRig();
		r.reader.item("PARENT02", { itemType: "journalArticle", title: "Parent" });
		r.reader.item("CHILD002", { itemType: "note", parentItem: "PARENT02", note: "<p>x</p>" });
		await r.svc.pull();
		r.reader.deletes.push({ type: "item", key: "PARENT02" });
		await r.svc.pull();
		expect(rows(r.db, "SELECT key FROM items")).toEqual([]);
	});

	test("an annotation with unsent changes keeps its attachment's parent", async () => {
		const r = makeRig();
		r.reader.item("PARENT03", { itemType: "journalArticle", title: "P" });
		r.reader.item("ATTACH03", {
			itemType: "attachment",
			parentItem: "PARENT03",
			linkMode: "imported_file",
			contentType: "application/pdf",
		});
		await r.svc.pull();
		repo.upsertAnnotations(r.db, "ATTACH03", [
			{
				id: "ANNOT003",
				type: "highlight",
				color: "#ffd400",
				sortIndex: "1",
				position: {},
				dateModified: "2026-02-01T00:00:00Z",
			} as any,
		]);
		r.reader.deletes.push({ type: "item", key: "PARENT03" });
		await r.svc.pull();
		expect(rows(r.db, "SELECT key FROM items WHERE key = 'PARENT03'")).toHaveLength(1);
		expect(rows(r.db, "SELECT key FROM annotations WHERE key = 'ANNOT003'")).toHaveLength(1);
	});
});

describe("objects that fail to apply (GPT #15)", () => {
	test("the checkpoint stays put and the object is read again once its parent exists", async () => {
		const r = makeRig();
		r.reader.item("ORPHAN01", { itemType: "note", parentItem: "LATER001", note: "<p>child first</p>" });
		await r.svc.pull();
		expect(state(r.db, "last_pull_at")).toBeUndefined();
		expect(state(r.db, "pull_incomplete")).toContain("ORPHAN01");
		expect(rows(r.db, "SELECT key FROM items")).toEqual([]);
		// the parent shows up in a later read; the orphan is read again because the checkpoint did not move
		r.reader.item("LATER001", { itemType: "journalArticle", title: "Parent" });
		r.reader.item("ORPHAN01", { itemType: "note", parentItem: "LATER001", note: "<p>child first</p>" });
		await r.svc.pull();
		expect(r.reader.since).toEqual([null, null]);
		expect(rows(r.db, "SELECT key FROM items ORDER BY key").map((x) => x.key)).toEqual(["LATER001", "ORPHAN01"]);
		expect(state(r.db, "last_pull_at")).toBe("at-2");
		expect(state(r.db, "pull_incomplete")).toBeUndefined();
	});

	test("applyChanges reports what is not stored, but not conflicts or other libraries' keys", () => {
		const r = makeRig();
		const rep = applyChanges(
			r.db,
			{
				upserts: [
					{
						type: "item",
						key: "NOPARENT",
						dateModified: "2026-06-01T10:00:00Z",
						data: { key: "NOPARENT", itemType: "note", parentItem: "GONE0001", note: "x" },
					},
					{
						type: "item",
						key: "FINE0001",
						dateModified: "2026-06-01T10:00:00Z",
						data: { key: "FINE0001", itemType: "journalArticle", title: "ok" },
					},
				],
				deletes: [],
			},
			r.zoteroDir,
		);
		expect(rep.failed).toEqual([{ type: "item", key: "NOPARENT" }]);
		expect(rep.applied).toBe(1);
	});
});

describe("annotations across libraries (Gemini #4)", () => {
	function twoLibraries() {
		const r = makeRig();
		r.db.run("INSERT INTO libraries(id, type, name, group_id) VALUES(2, 'group', 'G', 99)");
		return r;
	}

	test("a deletion in a group never removes an annotation of My Library", () => {
		const r = twoLibraries();
		r.reader.item("PARENT10", { itemType: "journalArticle", title: "P" });
		r.reader.item("ATTACH10", {
			itemType: "attachment",
			parentItem: "PARENT10",
			linkMode: "imported_file",
			contentType: "application/pdf",
		});
		r.reader.annotation("ANNOT010", "ATTACH10", {});
		applyChanges(r.db, { upserts: r.reader.upserts, deletes: [] }, r.zoteroDir, 1);
		expect(rows(r.db, "SELECT key FROM annotations")).toHaveLength(1);
		const rep = applyChanges(r.db, { upserts: [], deletes: [{ type: "annotation", key: "ANNOT010" }] }, r.zoteroDir, 2);
		expect(rep.deleted).toBe(0);
		expect(rows(r.db, "SELECT key FROM annotations")).toHaveLength(1);
	});

	test("an annotation whose attachment is in another library is not stored, and a clashing key is skipped", () => {
		const r = twoLibraries();
		r.reader.item("PARENT11", { itemType: "journalArticle", title: "P" });
		r.reader.item("ATTACH11", {
			itemType: "attachment",
			parentItem: "PARENT11",
			linkMode: "imported_file",
			contentType: "application/pdf",
		});
		r.reader.annotation("ANNOT011", "ATTACH11", { comment: "mine" });
		applyChanges(r.db, { upserts: r.reader.upserts, deletes: [] }, r.zoteroDir, 1);
		r.reader.upserts = [];
		r.reader.annotation("ANNOT011", "ATTACH11", { comment: "group" });
		const rep = applyChanges(r.db, { upserts: r.reader.upserts, deletes: [] }, r.zoteroDir, 2);
		expect(rep.applied).toBe(0);
		expect(JSON.parse(rows(r.db, "SELECT data FROM annotations WHERE key = 'ANNOT011'")[0].data).comment).toBe("mine");
	});
});
