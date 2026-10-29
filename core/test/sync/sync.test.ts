import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as repo from "../../src/db";
import { handleApi } from "../../src/api";
import { search } from "../../src/search";
import { startSync, stopSync } from "../../src/sync/api";
import { buildPush, pendingCount } from "../../src/sync/build";
import { FakeWriter, makeRig, outbox } from "./fakes";

const j = (db: ReturnType<typeof makeRig>["db"], sql: string, ...p: any[]) => db.query(sql).all(...p) as any[];

function newArticle(db: ReturnType<typeof makeRig>["db"], title: string, extra: object = {}) {
	return repo.createItem(db, { itemType: "journalArticle", title, ...extra }).data.key;
}

describe("triggers", () => {
	test("local writes fill the outbox, coalesced per (type,key,op)", () => {
		const { db } = makeRig();
		const k = newArticle(db, "First");
		repo.addTags(db, k, ["a", "b"]);
		repo.patchItem(db, k, { title: "First v2" });
		const c = repo.createCollection(db, "Coll");
		repo.addItemsToCollection(db, c.key, [k]);
		const box = outbox(db);
		expect(box.filter((x) => x === `item:${k}:upsert`).length).toBe(1);
		expect(box).toContain(`collection:${c.key}:upsert`);
		expect(pendingCount(db)).toBe(2);
	});

	test("trash, restore and delete are recorded", () => {
		const { db } = makeRig();
		const k = newArticle(db, "T");
		db.run("DELETE FROM sync_outbox");
		repo.patchItem(db, k, { deleted: 1 });
		expect(outbox(db)).toContain(`item:${k}:trash`);
		repo.patchItem(db, k, { deleted: 0 });
		expect(outbox(db)).toContain(`item:${k}:restore`);
		db.run("DELETE FROM items WHERE key = ?", [k]);
		expect(outbox(db)).toContain(`item:${k}:delete`);
	});

	test("annotations and attachments are recorded", () => {
		const { db } = makeRig();
		const p = newArticle(db, "P");
		const a = repo.createItem(db, { itemType: "attachment", parentItem: p, linkMode: "imported_file", contentType: "application/pdf" }).data.key;
		db.run("DELETE FROM sync_outbox");
		repo.upsertAnnotations(db, a, [{ id: "ANNOT001", type: "highlight", color: "#ffd400", sortIndex: "1", position: {}, dateModified: "2026-02-01T00:00:00Z" } as any]);
		expect(outbox(db)).toEqual(["annotation:ANNOT001:upsert"]);
		db.run("UPDATE attachments SET path = '/x' WHERE item_key = ?", [a]);
		expect(outbox(db)).toContain(`item:${a}:upsert`);
	});

	test("statements with their own ON CONFLICT clause still queue and move the entry", () => {
		const { db } = makeRig();
		const p = newArticle(db, "P");
		const a = repo.createItem(db, { itemType: "attachment", parentItem: p, linkMode: "imported_file" }).data.key;
		const ann = { id: "ANNOT003", type: "note", color: "#fff", sortIndex: "1", position: {}, comment: "one", dateModified: "2026-02-01T00:00:00Z" } as any;
		repo.upsertAnnotations(db, a, [ann]);
		const seq = () => (db.query("SELECT seq FROM sync_outbox WHERE key = 'ANNOT003'").get() as { seq: number }).seq;
		const first = seq();
		repo.upsertAnnotations(db, a, [{ ...ann, comment: "two" }]); // INSERT .. ON CONFLICT DO UPDATE
		expect(seq()).toBeGreaterThan(first);
		db.run("INSERT OR IGNORE INTO item_tags(item_key, tag, type) VALUES(?, 'x', 0)", [p]);
		db.run("INSERT OR IGNORE INTO item_tags(item_key, tag, type) VALUES(?, 'x', 0)", [p]);
		expect(outbox(db).filter((x) => x === `item:${p}:upsert`)).toHaveLength(1);
	});

	test("the suppress flag silences the triggers", () => {
		const { db } = makeRig();
		db.run("INSERT INTO sync_flags(name) VALUES('suppress')");
		newArticle(db, "quiet");
		db.run("DELETE FROM sync_flags");
		expect(outbox(db)).toEqual([]);
	});
});

describe("pull", () => {
	test("applies items, notes, attachments, annotations, collections and tags", async () => {
		const r = makeRig();
		mkdirSync(join(r.zoteroDir, "storage", "ATT00001"));
		writeFileSync(join(r.zoteroDir, "storage", "ATT00001", "paper.pdf"), "pdf");
		r.reader.collection("COLL0001", "Parent");
		r.reader.collection("COLL0002", "Child", "COLL0001");
		r.reader.item("ITEM0001", {
			itemType: "journalArticle",
			title: "Remote paper",
			date: "2021-03-04",
			creators: [{ creatorType: "author", firstName: "Ann", lastName: "Smith" }],
			tags: [{ tag: "red" }, { tag: "auto", type: 1 }],
			collections: ["COLL0002"],
			publicationTitle: "J Test",
		});
		r.reader.item("NOTE0001", { itemType: "note", parentItem: "ITEM0001", note: "<p>remote note</p>" });
		r.reader.item("ATT00001", { itemType: "attachment", parentItem: "ITEM0001", linkMode: "imported_file", contentType: "application/pdf", filename: "paper.pdf", title: "paper.pdf" });
		r.reader.annotation("ANN00001", "ATT00001", { text: "highlighted", comment: "c" });
		await r.svc.pull();

		const item = repo.getItemDetail(r.db, "ITEM0001")!;
		expect(item.data.title).toBe("Remote paper");
		expect(item.tags.map((t) => t.tag).sort()).toEqual(["auto", "red"]);
		expect(item.collections).toEqual(["COLL0002"]);
		expect(item.children.map((c) => c.itemType).sort()).toEqual(["attachment", "note"]);
		expect(repo.listCollections(r.db).find((c) => c.key === "COLL0002")?.parentKey).toBe("COLL0001");
		const att = repo.getAttachment(r.db, "ATT00001")!;
		expect(att.path).toBe(join(r.zoteroDir, "storage", "ATT00001", "paper.pdf"));
		expect(att.content_type).toBe("application/pdf");
		expect(repo.getAnnotations(r.db, "ATT00001").map((a) => a.id)).toEqual(["ANN00001"]);
		expect(repo.listItems(r.db, {}).items[0].year).toBe(2021);
		// search index covers the pulled item and its note
		expect(search(r.db, "remote").hits.map((h) => h.key)).toEqual(["ITEM0001"]);
		// pulling never queues anything to push
		expect(outbox(r.db)).toEqual([]);
		expect(r.db.query("SELECT date_modified FROM sync_base WHERE type='item' AND key='ITEM0001'").get()).toEqual({ date_modified: "2026-06-01T10:00:00Z" });
		expect((await r.svc.status()).lastPullAt).toBeTruthy();
		expect(r.reader.since).toEqual([null]);
		await r.svc.pull();
		expect(r.reader.since).toEqual([null, "at-1"]);
	});

	test("updates, trash and deletes from Zotero", async () => {
		const r = makeRig();
		r.reader.collection("COLL0001", "C");
		r.reader.item("ITEM0001", { itemType: "journalArticle", title: "One", collections: ["COLL0001"] });
		r.reader.item("ITEM0002", { itemType: "journalArticle", title: "Two" });
		await r.svc.pull();
		r.reader.item("ITEM0001", { itemType: "journalArticle", title: "One edited", deleted: 1, collections: [] }, "2026-06-02T00:00:00Z");
		r.reader.deletes.push({ type: "item", key: "ITEM0002" });
		await r.svc.pull();
		const row = r.db.query("SELECT title, deleted FROM items WHERE key = 'ITEM0001'").get() as any;
		expect(row).toEqual({ title: "One edited", deleted: 1 });
		expect(j(r.db, "SELECT * FROM collection_items")).toEqual([]);
		expect(r.db.query("SELECT 1 FROM items WHERE key = 'ITEM0002'").get()).toBeNull();
		expect(search(r.db, "two").total).toBe(0);
		r.reader.deletes.push({ type: "collection", key: "COLL0001" });
		await r.svc.pull();
		expect(repo.listCollections(r.db)).toEqual([]);
		expect(outbox(r.db)).toEqual([]);
	});

	test("a failing reader is reported, not thrown", async () => {
		const r = makeRig();
		r.reader.fail = "snapshot failed";
		await r.svc.pull();
		const s = await r.svc.status();
		expect(s.zotero).toBe("error");
		expect(s.lastError).toBe("snapshot failed");
		r.reader.fail = null;
		await r.svc.pull();
		expect((await r.svc.status()).lastError).toBeUndefined();
	});
});

describe("conflicts", () => {
	async function setup() {
		const r = makeRig();
		r.reader.item("ITEM0001", { itemType: "journalArticle", title: "Base" }, "2026-06-01T10:00:00Z");
		await r.svc.pull();
		return r;
	}

	test("Zotero's edit is newer: Zotero wins, local version kept in sync_conflicts", async () => {
		const r = await setup();
		repo.patchItem(r.db, "ITEM0001", { title: "Local edit" });
		r.db.run("UPDATE items SET date_modified = '2026-06-02T00:00:00Z' WHERE key = 'ITEM0001'");
		r.db.run("UPDATE sync_outbox SET at = at"); // keep entries
		r.reader.item("ITEM0001", { itemType: "journalArticle", title: "Zotero edit" }, "2026-06-03T00:00:00Z");
		await r.svc.pull();
		expect((r.db.query("SELECT title FROM items WHERE key='ITEM0001'").get() as any).title).toBe("Zotero edit");
		expect(outbox(r.db)).toEqual([]);
		const c = r.svc.conflicts();
		expect(c).toHaveLength(1);
		expect(c[0].resolved).toBe("remote");
		expect((c[0].local as any).title).toBe("Local edit");
		expect((c[0].remote as any).title).toBe("Zotero edit");
		expect((await r.svc.status()).conflicts).toBe(1);
	});

	test("the local edit is newer: local wins, stays queued, Zotero's version kept", async () => {
		const r = await setup();
		repo.patchItem(r.db, "ITEM0001", { title: "Local edit" });
		r.db.run("UPDATE items SET date_modified = '2026-06-05T00:00:00Z' WHERE key = 'ITEM0001'");
		r.reader.item("ITEM0001", { itemType: "journalArticle", title: "Zotero edit" }, "2026-06-03T00:00:00Z");
		await r.svc.pull();
		expect((r.db.query("SELECT title FROM items WHERE key='ITEM0001'").get() as any).title).toBe("Local edit");
		expect(outbox(r.db)).toContain("item:ITEM0001:upsert");
		const c = r.svc.conflicts();
		expect(c[0].resolved).toBe("local");
		expect((c[0].remote as any).title).toBe("Zotero edit");
		// a second identical pull must not duplicate the conflict
		r.reader.item("ITEM0001", { itemType: "journalArticle", title: "Zotero edit" }, "2026-06-03T00:00:00Z");
		await r.svc.pull();
		expect(r.svc.conflicts()).toHaveLength(1);
	});

	test("local change without a Zotero change is just applied later by push, no conflict", async () => {
		const r = await setup();
		repo.patchItem(r.db, "ITEM0001", { title: "Only local" });
		r.reader.item("ITEM0001", { itemType: "journalArticle", title: "Base" }, "2026-06-01T10:00:00Z");
		await r.svc.pull();
		expect(r.svc.conflicts()).toHaveLength(0);
		expect((r.db.query("SELECT title FROM items WHERE key='ITEM0001'").get() as any).title).toBe("Only local");
	});

	test("erased in Zotero but edited here: local edit wins", async () => {
		const r = await setup();
		repo.patchItem(r.db, "ITEM0001", { title: "Keep me" });
		r.reader.deletes.push({ type: "item", key: "ITEM0001" });
		await r.svc.pull();
		expect(r.db.query("SELECT 1 FROM items WHERE key='ITEM0001'").get()).not.toBeNull();
		expect(r.svc.conflicts()[0].resolved).toBe("local");
	});
});

describe("push", () => {
	async function rig() {
		const r = makeRig();
		await r.svc.setEnabled(true);
		r.writer.batches.length = 0;
		return r;
	}

	test("writing starts disabled", async () => {
		const r = makeRig();
		newArticle(r.db, "x");
		expect((await r.svc.status()).enabled).toBe(false);
		await r.svc.syncNow();
		expect(r.writer.batches).toEqual([]);
		expect(pendingCount(r.db)).toBe(1);
	});

	test("builds ordered writes from current state and clears the outbox", async () => {
		const r = await rig();
		const coll = repo.createCollection(r.db, "Top");
		const sub = repo.createCollection(r.db, "Sub", coll.key);
		const k = newArticle(r.db, "Pushed", { tags: [{ tag: "t1" }], collections: [sub.key] });
		const note = repo.createItem(r.db, { itemType: "note", parentItem: k, note: "<p>n</p>" }).data.key;
		repo.patchItem(r.db, k, { title: "Pushed v2" });
		r.db.run("DELETE FROM sync_outbox WHERE key = 'GONE0001'");
		const status = await r.svc.syncNow();
		expect(r.writer.batches).toHaveLength(1);
		const w = r.writer.batches[0];
		const order = w.map((x) => `${x.type}:${x.op}:${x.key}`);
		expect(order.indexOf(`collection:upsert:${coll.key}`)).toBeLessThan(order.indexOf(`collection:upsert:${sub.key}`));
		expect(order.indexOf(`collection:upsert:${sub.key}`)).toBeLessThan(order.indexOf(`item:upsert:${k}`));
		expect(order.indexOf(`item:upsert:${k}`)).toBeLessThan(order.indexOf(`item:upsert:${note}`));
		const item = w.find((x) => x.key === k)!;
		expect((item.data as any).title).toBe("Pushed v2");
		expect((item.data as any).tags).toEqual([{ tag: "t1" }]);
		expect((item.data as any).collections).toEqual([sub.key]);
		expect((w.find((x) => x.key === note)!.data as any).parentItem).toBe(k);
		expect(w.filter((x) => x.key === k)).toHaveLength(1); // coalesced
		expect(outbox(r.db)).toEqual([]);
		expect(status.pending).toBe(0);
		expect(status.lastPushAt).toBeTruthy();
		expect(status.lastBackup).toContain("b.sqlite");
		expect(r.db.query("SELECT 1 FROM sync_base WHERE type='item' AND key=?").get(k)).not.toBeNull();
	});

	test("trash, restore and erase", async () => {
		const r = await rig();
		const a = newArticle(r.db, "A");
		const b = newArticle(r.db, "B");
		const never = newArticle(r.db, "Never pushed");
		await r.svc.syncNow();
		r.writer.batches.length = 0;
		repo.patchItem(r.db, a, { deleted: 1 });
		r.db.run("DELETE FROM items WHERE key = ?", [b]);
		await r.svc.syncNow();
		let ops = r.writer.batches[0].map((x) => `${x.op}:${x.key}`);
		expect(ops).toContain(`trash:${a}`);
		expect(ops).toContain(`erase:${b}`);
		repo.patchItem(r.db, a, { deleted: 0 });
		r.db.run("DELETE FROM items WHERE key = ?", [never]);
		r.writer.batches.length = 0;
		await r.svc.syncNow();
		ops = r.writer.batches[0].map((x) => `${x.op}:${x.key}`);
		expect(ops).toContain(`restore:${a}`);
		// created and erased locally before it ever reached Zotero: nothing to erase there
		const k2 = newArticle(r.db, "Ephemeral");
		r.db.run("DELETE FROM items WHERE key = ?", [k2]);
		r.writer.batches.length = 0;
		await r.svc.syncNow();
		expect(r.writer.batches.flat().some((x) => x.key === k2)).toBe(false);
		expect(outbox(r.db)).toEqual([]);
	});

	test("Zotero running: nothing is written and entries stay queued; push happens when it closes", async () => {
		const r = await rig();
		r.running.value = true;
		newArticle(r.db, "waits");
		await r.svc.syncNow();
		expect(r.writer.batches).toEqual([]);
		expect((await r.svc.status()).pending).toBe(1);
		r.running.value = false;
		await r.svc.syncNow();
		expect(r.writer.batches).toHaveLength(1);
		expect(pendingCount(r.db)).toBe(0);
	});

	test("canWrite false keeps the outbox", async () => {
		const r = await rig();
		r.writer.canWriteValue = false;
		newArticle(r.db, "q");
		await r.svc.syncNow();
		expect(r.writer.batches).toEqual([]);
		expect(pendingCount(r.db)).toBe(1);
	});

	test("ZoteroLockedError keeps entries and is not an error", async () => {
		const r = await rig();
		r.writer.mode = "locked";
		newArticle(r.db, "locked");
		const s = await r.svc.syncNow();
		expect(s.pending).toBe(1);
		expect(s.lastError).toBeUndefined();
		r.writer.mode = "ok";
		expect((await r.svc.syncNow()).pending).toBe(0);
	});

	test("other errors pause sync with last_error; Sync now retries", async () => {
		const r = await rig();
		r.writer.mode = "throw";
		newArticle(r.db, "boom");
		await r.svc.push();
		let s = await r.svc.status();
		expect(s.lastError).toBe("disk full");
		expect(s.pending).toBe(1);
		r.writer.mode = "ok";
		await r.svc.push(); // paused: no retry
		expect((await r.svc.status()).pending).toBe(1);
		s = await r.svc.syncNow(); // manual retry clears the pause
		expect(s.pending).toBe(0);
		expect(s.lastError).toBeUndefined();
	});

	test("per-object failures stay queued, the rest is committed", async () => {
		const r = await rig();
		const a = newArticle(r.db, "ok");
		const b = newArticle(r.db, "bad");
		r.writer.mode = "partial";
		r.writer.failKey = b;
		const s = await r.svc.syncNow();
		expect(outbox(r.db)).toEqual([`item:${b}:upsert`]);
		expect(s.lastError).toContain("constraint failed");
		expect(a).not.toBe(b);
	});

	test("edits made while a push is in flight are not lost", async () => {
		const r = await rig();
		const k = newArticle(r.db, "orig");
		const apply = r.writer.apply.bind(r.writer);
		r.writer.apply = async (w) => {
			repo.patchItem(r.db, k, { title: "edited during push" });
			return apply(w);
		};
		await r.svc.syncNow();
		expect(outbox(r.db)).toContain(`item:${k}:upsert`);
		r.writer.apply = apply;
		await r.svc.syncNow();
		const item = r.writer.batches.at(-1)!.find((x) => x.key === k)!;
		expect((item.data as any).title).toBe("edited during push");
		expect(pendingCount(r.db)).toBe(0);
	});

	test("new attachment files are handed to the writer and the path is updated", async () => {
		const r = await rig();
		const parent = newArticle(r.db, "Has pdf");
		const att = repo.createItem(r.db, { itemType: "attachment", parentItem: parent, linkMode: "imported_file", contentType: "application/pdf", title: "p.pdf" }).data.key;
		const own = join(r.dir, "storage", att);
		mkdirSync(own, { recursive: true });
		const mine = join(own, "p.pdf");
		writeFileSync(mine, "%PDF-1.4 mine");
		r.db.run("UPDATE attachments SET path = ? WHERE item_key = ?", [mine, att]);
		await r.svc.syncNow();
		const w = r.writer.batches[0].find((x) => x.key === att)!;
		expect(w.file).toEqual({ path: mine, filename: "p.pdf", contentType: "application/pdf" });
		const zpath = join(r.zoteroDir, "storage", att, "p.pdf");
		expect(repo.getAttachment(r.db, att)!.path).toBe(zpath);
		expect(readFileSync(zpath, "utf8")).toBe("%PDF-1.4 mine");
		expect(existsSync(mine)).toBe(false); // zotero-next's own copy is removed after success
		expect(existsSync(own)).toBe(false);
		expect(outbox(r.db)).toEqual([]); // the path update itself is not queued
		// the attachment now lives in Zotero storage: later pushes carry no file
		repo.patchItem(r.db, att, { title: "renamed.pdf" });
		r.writer.batches.length = 0;
		await r.svc.syncNow();
		expect(r.writer.batches[0].find((x) => x.key === att)!.file).toBeUndefined();
	});

	test("a failed push keeps zotero-next's own copy of the file", async () => {
		const r = await rig();
		const parent = newArticle(r.db, "P");
		const att = repo.createItem(r.db, { itemType: "attachment", parentItem: parent, linkMode: "imported_file", contentType: "application/pdf" }).data.key;
		const mine = join(r.dir, "storage", att, "x.pdf");
		mkdirSync(join(r.dir, "storage", att), { recursive: true });
		writeFileSync(mine, "x");
		r.db.run("UPDATE attachments SET path = ? WHERE item_key = ?", [mine, att]);
		r.writer.mode = "throw";
		await r.svc.push();
		expect(existsSync(mine)).toBe(true);
		expect(repo.getAttachment(r.db, att)!.path).toBe(mine);
	});

	test("annotations are pushed with their attachment as parentItem", async () => {
		const r = await rig();
		r.reader.item("ITEM0001", { itemType: "journalArticle", title: "x" });
		r.reader.item("ATT00001", { itemType: "attachment", parentItem: "ITEM0001", linkMode: "imported_file", contentType: "application/pdf" });
		await r.svc.pull();
		repo.upsertAnnotations(r.db, "ATT00001", [{ id: "ANNOT002", type: "highlight", color: "#ffd400", sortIndex: "1", position: {}, text: "t", dateModified: "2026-07-01T00:00:00Z" } as any]);
		await r.svc.syncNow();
		const w = r.writer.batches[0].find((x) => x.type === "annotation")!;
		expect(w.key).toBe("ANNOT002");
		expect((w.data as any).parentItem).toBe("ATT00001");
		expect((w.data as any).text).toBe("t");
	});

	test("buildPush without outbox entries yields nothing", () => {
		const { db, zoteroDir } = makeRig();
		expect(buildPush(db, zoteroDir).writes).toEqual([]);
	});
});

describe("HTTP API", () => {
	test("status / enable / now / conflicts routes", async () => {
		const r = makeRig();
		// registered through startSync (no timers: pollMs 0, watch false)
		const svc = startSync(r.db, { ...r.svc.opts });
		try {
			const get = (p: string, init?: RequestInit) => handleApi(new Request(`http://x/api/sync/${p}`, init), r.db).then((x) => x!);
			let res = await get("status");
			expect(res.status).toBe(200);
			let st = await res.json();
			expect(st).toMatchObject({ enabled: false, zotero: "closed", pending: 0, conflicts: 0, dataDir: r.zoteroDir });
			res = await get("enable", { method: "POST", body: JSON.stringify({ enabled: true }) });
			expect((await res.json()).enabled).toBe(true);
			expect((await get("enable", { method: "POST", body: "{}" })).status).toBe(400);
			newArticle(r.db, "via api");
			res = await get("now", { method: "POST" });
			st = await res.json();
			expect(st.pending).toBe(0);
			expect((r.writer.batches[0] ?? []).length).toBeGreaterThan(0);
			r.db.run("INSERT INTO sync_conflicts(type, key, local, remote, resolved) VALUES('item','K',?,?,'local')", [JSON.stringify({ title: "L" }), JSON.stringify({ title: "R" })]);
			const cs = await (await get("conflicts")).json();
			expect(cs.conflicts[0]).toMatchObject({ key: "K", title: "L", resolved: "local", local: { title: "L" }, remote: { title: "R" } });
			expect((await get(`conflicts?id=${cs.conflicts[0].id}`, { method: "DELETE" })).status).toBe(200);
			expect((await (await get("conflicts")).json()).conflicts).toEqual([]);
			expect((await get("bogus")).status).toBe(404);
		} finally {
			await svc.stop();
			await stopSync(r.db);
		}
	});

	test("status without a running service still answers", async () => {
		const r = makeRig();
		const res = (await handleApi(new Request("http://x/api/sync/status"), r.db))!;
		expect(res.status).toBe(200);
		expect((await res.json()).enabled).toBe(false);
	});
});
