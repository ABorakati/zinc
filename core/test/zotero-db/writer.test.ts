// Round-trip tests for the Zotero DB writer/reader. They run on a temp COPY of the user's real
// library (skipped if it does not exist). Tests are sequential and share one working copy.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ZoteroLockedError, type ZoteroWrite } from "../../src/sync/protocol";
import { ZoteroDbReader, ZoteroDbWriter } from "../../src/zotero-db";
import { genKey, HAVE_REAL_DB, makeDataDir, noRunning, openRO, removeDir, stable, writeTempFile } from "./helpers";

const d = HAVE_REAL_DB ? describe : describe.skip;
// Each apply() backs up (VACUUM INTO) and integrity-checks a ~180 MB library: allow time.
setDefaultTimeout(300_000);

d("zotero-db writer + reader", () => {
	let dataDir: string;
	let writer: ZoteroDbWriter;
	let reader: ZoteroDbReader;
	let since: string;
	const collA = genKey();
	const collB = genKey();
	const article = genKey();
	const note = genKey();
	const att = genKey();
	const ann = genKey();

	const items: Record<string, unknown>[] = [];

	async function apply(...w: ZoteroWrite[]) {
		return writer.apply(w);
	}
	async function readAll() {
		const ch = await reader.changesSince(since);
		return new Map(ch.upserts.map((u) => [`${u.type}:${u.key}`, u]));
	}
	function q<T = Record<string, unknown>>(sql: string, ...p: unknown[]): T[] {
		const db = openRO(dataDir);
		try {
			return db.query(sql).all(...(p as never[])) as T[];
		} finally {
			db.close(true);
		}
	}

	beforeAll(() => {
		dataDir = makeDataDir();
		writer = new ZoteroDbWriter({ dataDir, isRunning: noRunning, keepBackups: 2, baseAttachmentPath: null });
		reader = new ZoteroDbReader({ dataDir, isRunning: noRunning, baseAttachmentPath: null });
		since = new Date(Date.now() - 5000).toISOString().replace(/\.\d+Z$/, "Z");
	});
	afterAll(() => removeDir(dataDir));

	test("canWrite is true on a closed copy and creates a backup + results on apply", async () => {
		expect(await writer.canWrite()).toBe(true);
		const { backupPath, results } = await apply({
			type: "collection",
			op: "upsert",
			key: collA,
			data: { name: "ZN Parent", parentCollection: false },
		});
		expect(results).toEqual([expect.objectContaining({ key: collA, ok: true, changed: true })]);
		expect(existsSync(backupPath)).toBe(true);
		expect(backupPath).toContain("zotero-next-backups");
		const row = q("SELECT synced, version, clientVersion, collectionName FROM collections WHERE key = ?", collA)[0];
		expect(row).toMatchObject({ synced: 0, version: 0, collectionName: "ZN Parent" });
		expect(row.clientVersion as number).toBeGreaterThan(23360);
	});

	test("collection create/rename/reparent round-trips through the reader", async () => {
		await apply({
			type: "collection",
			op: "upsert",
			key: collB,
			data: { name: "ZN Child", parentCollection: collA },
		});
		let all = await readAll();
		expect(all.get(`collection:${collB}`)?.data).toMatchObject({ key: collB, name: "ZN Child", parentCollection: collA });
		// rename + move to top level
		await apply({ type: "collection", op: "upsert", key: collB, data: { name: "ZN Child 2", parentCollection: false } });
		all = await readAll();
		expect(all.get(`collection:${collB}`)?.data).toMatchObject({ name: "ZN Child 2", parentCollection: false });
		// cycle is rejected softly
		const r = await apply({ type: "collection", op: "upsert", key: collA, data: { name: "ZN Parent", parentCollection: collB } });
		expect(r.results[0].ok).toBe(true); // collB is no longer a child of collA: allowed
		const r2 = await apply({ type: "collection", op: "upsert", key: collB, data: { name: "x", parentCollection: collA } });
		expect(r2.results[0].ok).toBe(false);
		expect(r2.results[0].error).toContain("descendant");
		// restore a sane tree
		await apply(
			{ type: "collection", op: "upsert", key: collA, data: { name: "ZN Parent", parentCollection: false } },
			{ type: "collection", op: "upsert", key: collB, data: { name: "ZN Child", parentCollection: collA } },
		);
	});

	test("item with creators, tags, collections, extra round-trips", async () => {
		const data = {
			itemType: "journalArticle",
			title: "ZN test article",
			date: "2024-04-16",
			publicationTitle: "Journal of Tests",
			DOI: "10.1234/zn.1",
			abstractNote: "An <i>abstract</i> with ünïcode",
			extra: "PMID: 1\nanother line",
			creators: [
				{ creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
				{ creatorType: "author", firstName: "Grace", lastName: "Hopper" },
				{ creatorType: "editor", name: "Test Editorial Group" },
			],
			tags: [{ tag: "zn-alpha" }, { tag: "zn-auto", type: 1 }],
			collections: [collA, collB],
			relations: {},
		};
		const { results } = await apply({ type: "item", op: "upsert", key: article, data });
		expect(results[0]).toMatchObject({ ok: true, changed: true });
		const all = await readAll();
		const got = all.get(`item:${article}`);
		expect(got).toBeTruthy();
		expect(stable(got?.data as Record<string, unknown>)).toEqual({ key: article, ...data, collections: [collA, collB].sort() });
		items.push(data);

		// Zotero-exact storage details
		const it = q<Record<string, any>>("SELECT * FROM items WHERE key = ?", article)[0];
		expect(it).toMatchObject({ synced: 0, version: 0, libraryID: 1 });
		expect(it.dateAdded).toBe(it.clientDateModified);
		const date = q("SELECT v.value FROM itemData d JOIN itemDataValues v USING(valueID) WHERE d.itemID = ? AND d.fieldID = (SELECT fieldID FROM fieldsCombined WHERE fieldName='date')", it.itemID)[0];
		expect(date.value).toBe("2024-04-16 2024-04-16");
		expect(q("SELECT firstNameNormalized FROM creators WHERE lastName = 'Lovelace'")[0]).toBeTruthy();
		const ci = q("SELECT orderIndex, collectionID FROM collectionItems WHERE itemID = ?", it.itemID);
		expect(ci.length).toBe(2);
		const tt = q("SELECT t.name, it.type FROM itemTags it JOIN tags t USING(tagID) WHERE it.itemID = ? ORDER BY t.name", it.itemID);
		expect(tt).toEqual([{ name: "zn-alpha", type: 0 }, { name: "zn-auto", type: 1 }]);
	});

	test("re-applying identical data is a no-op", async () => {
		const before = q("SELECT clientVersion FROM libraries WHERE libraryID = 1")[0].clientVersion;
		const { results } = await apply({ type: "item", op: "upsert", key: article, data: { ...items[0], dateModified: undefined } as never });
		expect(results[0]).toMatchObject({ ok: true, changed: false });
		expect(q("SELECT clientVersion FROM libraries WHERE libraryID = 1")[0].clientVersion).toBe(before);
	});

	test("editing fields/creators/tags/collections removes what is no longer present", async () => {
		const data = {
			itemType: "journalArticle",
			title: "ZN test article (edited)",
			date: "April 2024",
			publicationTitle: "Journal of Tests",
			creators: [{ creatorType: "author", firstName: "Grace", lastName: "Hopper" }],
			tags: [{ tag: "zn-alpha" }, { tag: "zn-beta" }],
			collections: [collB],
			relations: {},
		};
		const { results } = await apply({ type: "item", op: "upsert", key: article, data });
		expect(results[0]).toMatchObject({ ok: true, changed: true });
		const got = (await readAll()).get(`item:${article}`)?.data as Record<string, unknown>;
		expect(stable(got)).toEqual({ key: article, ...data });
		const it = q<Record<string, any>>("SELECT itemID FROM items WHERE key = ?", article)[0];
		// removed fields are gone from itemData
		const fields = q("SELECT f.fieldName FROM itemData d JOIN fieldsCombined f USING(fieldID) WHERE d.itemID = ?", it.itemID).map((r) => r.fieldName);
		expect(fields.sort()).toEqual(["date", "publicationTitle", "title"]);
		expect(q("SELECT v.value FROM itemData d JOIN itemDataValues v USING(valueID) WHERE d.itemID = ? AND d.fieldID = 6", it.itemID)[0].value).toBe("2024-04-00 April 2024");
		// orphan tag zn-auto purged, orphan creator Lovelace purged
		expect(q("SELECT 1 FROM tags WHERE name = 'zn-auto'")).toEqual([]);
		expect(q("SELECT 1 FROM creators WHERE lastName = 'Lovelace'")).toEqual([]);
		expect(q("SELECT collectionID FROM collectionItems WHERE itemID = ?", it.itemID).length).toBe(1);
	});

	test("editing an existing real Zotero item keeps version and flags it unsynced", async () => {
		const real = q<Record<string, any>>(
			"SELECT i.itemID, i.key, i.version, i.synced FROM items i WHERE i.itemTypeID = 22 AND i.synced = 1 ORDER BY i.itemID DESC LIMIT 1",
		)[0];
		const before = (await reader.changesSince(null, {})).upserts.find((u) => u.key === real.key);
		expect(before).toBeTruthy();
		const data = { ...(before?.data as Record<string, unknown>), title: "ZN edited real title" };
		const { results } = await apply({ type: "item", op: "upsert", key: real.key, data });
		expect(results[0]).toMatchObject({ ok: true, changed: true });
		const row = q<Record<string, any>>("SELECT version, synced, clientDateModified FROM items WHERE key = ?", real.key)[0];
		expect(row.version).toBe(real.version);
		expect(row.synced).toBe(0);
		const back = (await readAll()).get(`item:${real.key}`)?.data as Record<string, unknown>;
		expect(back.title).toBe("ZN edited real title");
		// everything else unchanged
		expect(stable({ ...back, title: "" })).toEqual(stable({ ...(before?.data as Record<string, unknown>), title: "" }));
	});

	test("note child, imported attachment (file copy) and annotation", async () => {
		const pdf = writeTempFile("zn test.pdf", "%PDF-1.4\n%%EOF\n");
		const noteData = { itemType: "note", parentItem: article, note: "<p>Hello &amp; welcome note</p>", tags: [{ tag: "zn-note" }], relations: {} };
		const attData = {
			itemType: "attachment",
			parentItem: article,
			linkMode: "imported_file",
			title: "zn test.pdf",
			contentType: "application/pdf",
			tags: [],
			relations: {},
		};
		const annData = {
			parentItem: att,
			type: "highlight",
			color: "#ff6666",
			sortIndex: "00000|000010|00020",
			position: { pageIndex: 0, rects: [[1, 2, 3, 4.5]] },
			text: "highlighted text",
			comment: "a comment",
			pageLabel: "7",
			tags: [{ name: "zn-ann" }],
		};
		const { results } = await apply(
			{ type: "annotation", op: "upsert", key: ann, data: annData },
			{ type: "item", op: "upsert", key: att, data: attData, file: { path: pdf, filename: "zn test.pdf", contentType: "application/pdf" } },
			{ type: "item", op: "upsert", key: note, data: noteData },
		);
		expect(results.map((r) => r.ok)).toEqual([true, true, true]);
		const storedPath = join(dataDir, "storage", att, "zn test.pdf");
		expect(results[1].path).toBe(storedPath);
		expect(readFileSync(storedPath, "utf8")).toContain("%PDF");

		const n = q<Record<string, any>>("SELECT n.note, n.title, n.parentItemID FROM itemNotes n JOIN items i USING(itemID) WHERE i.key = ?", note)[0];
		expect(n.note).toBe('<div class="zotero-note znv1"><p>Hello &amp; welcome note</p></div>');
		expect(n.title).toBe("Hello & welcome note");
		const a = q<Record<string, any>>("SELECT a.* FROM itemAttachments a JOIN items i USING(itemID) WHERE i.key = ?", att)[0];
		expect(a).toMatchObject({ linkMode: 0, contentType: "application/pdf", path: "storage:zn test.pdf", syncState: 0, storageHash: null });
		const an = q<Record<string, any>>("SELECT a.* FROM itemAnnotations a JOIN items i USING(itemID) WHERE i.key = ?", ann)[0];
		expect(an).toMatchObject({ type: 1, color: "#ff6666", pageLabel: "7", isExternal: 0, text: "highlighted text" });
		expect(an.position).toBe('{"pageIndex":0,"rects":[[1,2,3,4.5]]}');

		const all = await readAll();
		const rn = all.get(`item:${note}`)?.data as Record<string, any>;
		expect(rn).toMatchObject({ itemType: "note", parentItem: article, tags: [{ tag: "zn-note" }] });
		expect(rn.note).toContain("Hello &amp; welcome note");
		const ra = all.get(`item:${att}`)?.data as Record<string, any>;
		expect(ra).toMatchObject({ itemType: "attachment", linkMode: "imported_file", contentType: "application/pdf", filename: "zn test.pdf", path: storedPath, parentItem: article });
		const rann = all.get(`annotation:${ann}`)?.data as Record<string, any>;
		expect(rann).toMatchObject({ id: ann, type: "highlight", color: "#ff6666", text: "highlighted text", comment: "a comment", pageLabel: "7", tags: [{ name: "zn-ann" }], parentItem: att });
		expect(rann.position).toEqual(annData.position);

		// edit annotation + note
		await apply(
			{ type: "annotation", op: "upsert", key: ann, data: { ...annData, color: "#2ea8e5", comment: "edited", tags: [] } },
			{ type: "item", op: "upsert", key: note, data: { ...noteData, note: "<p>Second line</p>" } },
		);
		const all2 = await readAll();
		expect(all2.get(`annotation:${ann}`)?.data).toMatchObject({ color: "#2ea8e5", comment: "edited", tags: [] });
		expect((all2.get(`item:${note}`)?.data as Record<string, any>).note).toContain("Second line");
		expect(q("SELECT title FROM itemNotes WHERE itemID = (SELECT itemID FROM items WHERE key = ?)", note)[0].title).toBe("Second line");
	});

	test("annotation on a non-PDF parent is rejected softly", async () => {
		const { results } = await apply({
			type: "annotation",
			op: "upsert",
			key: genKey(),
			data: { parentItem: article, type: "note", sortIndex: "00000|000000|00000", position: { pageIndex: 0 } },
		});
		expect(results[0].ok).toBe(false);
	});

	test("linked_file attachment keeps its path, linked_url has none", async () => {
		const lf = genKey();
		const lu = genKey();
		const { results } = await apply(
			{ type: "item", op: "upsert", key: lf, data: { itemType: "attachment", parentItem: article, linkMode: "linked_file", title: "Linked", contentType: "application/pdf", path: "C:\\somewhere\\x.pdf", tags: [] } },
			{ type: "item", op: "upsert", key: lu, data: { itemType: "attachment", parentItem: article, linkMode: "linked_url", title: "Web", url: "https://example.org/", contentType: "text/html", tags: [] } },
		);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(q("SELECT path, linkMode FROM itemAttachments WHERE itemID = (SELECT itemID FROM items WHERE key = ?)", lf)[0]).toEqual({ path: "C:\\somewhere\\x.pdf", linkMode: 2 });
		expect(q("SELECT path, linkMode FROM itemAttachments WHERE itemID = (SELECT itemID FROM items WHERE key = ?)", lu)[0]).toEqual({ path: null, linkMode: 3 });
		const all = await readAll();
		expect(all.get(`item:${lf}`)?.data).toMatchObject({ linkMode: "linked_file", path: "C:\\somewhere\\x.pdf" });
		expect(all.get(`item:${lu}`)?.data).toMatchObject({ linkMode: "linked_url", url: "https://example.org/" });
		expect((all.get(`item:${lu}`)?.data as Record<string, unknown>).path).toBeUndefined();
		await apply({ type: "item", op: "erase", key: lf }, { type: "item", op: "erase", key: lu });
	});

	test("trash and restore (items and collections)", async () => {
		await apply({ type: "item", op: "trash", key: article }, { type: "collection", op: "trash", key: collA });
		expect(q("SELECT 1 FROM deletedItems WHERE itemID = (SELECT itemID FROM items WHERE key = ?)", article).length).toBe(1);
		const trashedMine = () =>
			q("SELECT c.key FROM deletedCollections d JOIN collections c USING(collectionID) WHERE c.key IN (?, ?)", collA, collB).length;
		expect(trashedMine()).toBe(2); // parent + child
		const all = await readAll();
		expect((all.get(`item:${article}`)?.data as Record<string, unknown>).deleted).toBe(1);
		expect((all.get(`collection:${collA}`)?.data as Record<string, unknown>).deleted).toBe(1);
		const r = await apply({ type: "item", op: "trash", key: article });
		expect(r.results[0]).toMatchObject({ ok: true, changed: false });

		await apply({ type: "item", op: "restore", key: article }, { type: "collection", op: "restore", key: collA });
		expect(q("SELECT 1 FROM deletedItems WHERE itemID = (SELECT itemID FROM items WHERE key = ?)", article).length).toBe(0);
		expect(trashedMine()).toBe(1); // child stays trashed
		await apply({ type: "collection", op: "restore", key: collB });
		expect(trashedMine()).toBe(0);
		expect((await readAll()).get(`item:${article}`)?.data).not.toHaveProperty("deleted");
	});

	test("My Publications: inPublications writes and clears the publicationsItems row", async () => {
		const pubRow = () => q("SELECT 1 FROM publicationsItems WHERE itemID = (SELECT itemID FROM items WHERE key = ?)", article).length;
		const cur = (await readAll()).get(`item:${article}`)!.data as Record<string, unknown>;
		expect(pubRow()).toBe(0);
		const on = await apply({ type: "item", op: "upsert", key: article, data: { ...cur, inPublications: true } });
		expect(on.results[0]).toMatchObject({ ok: true, changed: true });
		expect(pubRow()).toBe(1);
		expect((await readAll()).get(`item:${article}`)?.data).toMatchObject({ inPublications: true });
		const { inPublications: _drop, ...off } = { ...cur, inPublications: true };
		await apply({ type: "item", op: "upsert", key: article, data: off });
		expect(pubRow()).toBe(0);
		expect((await readAll()).get(`item:${article}`)?.data).not.toHaveProperty("inPublications");
	});

	test("erase removes children, logs syncDeleteLog and the storage folder, reader reports deletes", async () => {
		expect(existsSync(join(dataDir, "storage", att))).toBe(true);
		const known = { item: [article, note, att], annotation: [ann], collection: [collA, collB] };
		await apply({ type: "item", op: "erase", key: article }, { type: "collection", op: "erase", key: collA });
		for (const k of [article, note, att, ann]) expect(q("SELECT 1 FROM items WHERE key = ?", k)).toEqual([]);
		expect(q("SELECT 1 FROM itemAnnotations WHERE parentItemID NOT IN (SELECT itemID FROM items)")).toEqual([]);
		expect(q("SELECT key FROM collections WHERE key IN (?, ?)", collA, collB)).toEqual([]);
		const log = q<{ syncObjectTypeID: number; key: string }>("SELECT syncObjectTypeID, key FROM syncDeleteLog").map((r) => `${r.syncObjectTypeID}:${r.key}`);
		for (const k of [article, note, att, ann]) expect(log).toContain(`3:${k}`);
		for (const k of [collA, collB]) expect(log).toContain(`1:${k}`);
		expect(existsSync(join(dataDir, "storage", att))).toBe(false);

		const ch = await reader.changesSince(since, { knownKeys: known });
		const del = ch.deletes.map((x) => `${x.type}:${x.key}`).sort();
		for (const e of [`item:${article}`, `item:${note}`, `item:${att}`, `annotation:${ann}`, `collection:${collA}`, `collection:${collB}`]) {
			expect(del).toContain(e);
		}
		// without knownKeys the syncDeleteLog still reports them (annotation keys appear as items)
		const ch2 = await reader.changesSince(since);
		for (const k of [article, note, att, ann, collA, collB]) expect(ch2.deletes.map((x) => x.key)).toContain(k);
		// erasing something already gone is a no-op
		expect((await apply({ type: "item", op: "erase", key: article })).results[0]).toMatchObject({ ok: true, changed: false });
	});

	test("backups are pruned to keepBackups and the DB passes integrity checks", () => {
		const files = readdirSync(join(dataDir, "zotero-next-backups"));
		expect(files.length).toBeLessThanOrEqual(2);
		const db = openRO(dataDir);
		expect((db.query("PRAGMA quick_check").all() as Record<string, string>[])[0].quick_check).toBe("ok");
		expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
		db.close(true);
	});

	test("a lock held by another connection makes canWrite false and apply throw ZoteroLockedError", async () => {
		const other = new Database(join(dataDir, "zotero.sqlite"), { readwrite: true });
		other.exec("BEGIN EXCLUSIVE");
		try {
			expect(await writer.canWrite()).toBe(false);
			await expect(apply({ type: "collection", op: "upsert", key: genKey(), data: { name: "nope" } })).rejects.toBeInstanceOf(ZoteroLockedError);
		} finally {
			other.exec("ROLLBACK");
			other.close(true);
		}
		expect(await writer.canWrite()).toBe(true);
	});

	test("a running Zotero process blocks writes", async () => {
		const w = new ZoteroDbWriter({ dataDir, isRunning: async () => true });
		expect(await w.canWrite()).toBe(false);
		await expect(w.apply([{ type: "collection", op: "upsert", key: genKey(), data: { name: "nope" } }])).rejects.toBeInstanceOf(ZoteroLockedError);
	});

	test("an unexpected database error rolls the whole batch back", async () => {
		const k1 = genKey();
		const k2 = genKey();
		const db = new Database(join(dataDir, "zotero.sqlite"), { readwrite: true });
		db.exec("CREATE TRIGGER zn_boom BEFORE INSERT ON tags WHEN NEW.name = 'zn-boom' BEGIN SELECT RAISE(ABORT, 'boom'); END");
		db.close(true);
		const countBefore = q("SELECT COUNT(*) c FROM items")[0].c;
		await expect(
			apply(
				{ type: "item", op: "upsert", key: k1, data: { itemType: "book", title: "rolled back", tags: [], collections: [] } },
				{ type: "item", op: "upsert", key: k2, data: { itemType: "book", title: "boom", tags: [{ tag: "zn-boom" }] } },
			),
		).rejects.toThrow();
		expect(q("SELECT COUNT(*) c FROM items")[0].c).toBe(countBefore);
		const db2 = new Database(join(dataDir, "zotero.sqlite"), { readwrite: true });
		db2.exec("DROP TRIGGER zn_boom");
		db2.close(true);
	});

	test("reader falls back to a snapshot copy while Zotero holds the DB locked", async () => {
		const k = genKey();
		await apply({ type: "collection", op: "upsert", key: k, data: { name: "visible in snapshot" } });
		const other = new Database(join(dataDir, "zotero.sqlite"), { readwrite: true });
		other.exec("BEGIN EXCLUSIVE");
		try {
			const snapRunning = new ZoteroDbReader({ dataDir, isRunning: async () => true });
			const ch = await snapRunning.changesSince(since);
			expect(ch.upserts.some((u) => u.key === k)).toBe(true);
			const snapBusy = new ZoteroDbReader({ dataDir, isRunning: noRunning }); // BUSY on open -> copy
			const ch2 = await snapBusy.changesSince(since);
			expect(ch2.upserts.some((u) => u.key === k)).toBe(true);
		} finally {
			other.exec("ROLLBACK");
			other.close(true);
		}
	});
});
