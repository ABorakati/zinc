import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleApi } from "../../src/api";
import * as repo from "../../src/db";
import { getSyncService, startSync } from "../../src/sync/api";
import { MockZotero, API_KEY } from "./mock";
import { FakeReader, FakeWriter } from "../sync/fakes";
import { insertAttachment, insertItem } from "../fixture";
import { setSyncMode, syncMode } from "../../src/websync";
import { connect, makeRig, stopAll, type Rig } from "./rig";
import { zipOf } from "./zip";

afterEach(stopAll);

const rows = (r: Rig, sql: string, ...p: any[]) => r.db.query(sql).all(...p) as any[];
const outbox = (r: Rig) => rows(r, "SELECT type, key, op FROM sync_outbox ORDER BY seq").map((x) => `${x.type}:${x.key}:${x.op}`);
const versionOf = (r: Rig, type: string, key: string) => (r.db.query("SELECT version FROM websync_versions WHERE type = ? AND key = ?").get(type, key) as { version: number } | null)?.version;

const localItem = (key: string, title: string) => ({
	key,
	itemType: "journalArticle",
	title,
	dateAdded: "2026-01-01T00:00:00Z",
	dateModified: "2026-06-01T10:00:00Z",
	tags: [],
	collections: [],
	relations: {},
});

describe("sync mode", () => {
	test("defaults to zotero-local and can be switched", () => {
		const r = makeRig();
		expect(syncMode(r.db)).toBe("zotero-local");
		setSyncMode(r.db, "zotero-org");
		expect(syncMode(r.db)).toBe("zotero-org");
		setSyncMode(r.db, "off");
		expect(syncMode(r.db)).toBe("off");
		expect(() => setSyncMode(r.db, "bogus" as any)).toThrow();
	});
});

describe("pull", () => {
	test("first pull into a library whose keys already match records versions without conflicts", async () => {
		const r = makeRig();
		await connect(r);
		for (const k of ["ITEM0001", "ITEM0002"]) {
			insertItem(r.db, localItem(k, `Title ${k}`) as any);
			r.mock.put("item", k, { title: `Title ${k}` });
		}
		r.db.run("INSERT INTO collections(key, name) VALUES('COLL0001', 'Reading')");
		r.mock.put("collection", "COLL0001", { name: "Reading" });
		r.mock.put("item", "REMOTE01", { title: "Only remote" });
		insertItem(r.db, localItem("LOCAL001", "Only local") as any);
		expect(outbox(r).length).toBeGreaterThan(0); // local imports queued everything

		await r.svc.pull();

		expect((await r.svc.status()).lastError).toBeUndefined();
		for (const k of ["ITEM0001", "ITEM0002", "REMOTE01"]) expect(versionOf(r, "item", k)).toBe(r.mock.item(k)!.version);
		expect(versionOf(r, "collection", "COLL0001")).toBe(r.mock.objects.get("collection:COLL0001")!.version);
		expect(rows(r, "SELECT * FROM sync_conflicts")).toEqual([]);
		// matching objects left the outbox; the local-only item is still waiting to be pushed
		expect(outbox(r)).toEqual(["item:LOCAL001:upsert"]);
		expect((r.db.query("SELECT title FROM items WHERE key = 'REMOTE01'").get() as any).title).toBe("Only remote");
		expect((await r.svc.status()).libraryVersion).toBe(r.mock.version);
	});

	test("incremental pull fetches only what changed", async () => {
		const r = makeRig();
		await connect(r);
		r.mock.put("item", "ITEM0001", { title: "One" });
		r.mock.put("item", "ITEM0002", { title: "Two" });
		await r.svc.pull();
		r.mock.log.length = 0;
		r.mock.put("item", "ITEM0001", { title: "One edited", dateModified: "2026-06-02T00:00:00Z" });
		r.mock.put("item", "ITEM0003", { title: "Three" });
		await r.svc.pull();
		expect((r.db.query("SELECT title FROM items WHERE key = 'ITEM0001'").get() as any).title).toBe("One edited");
		expect(rows(r, "SELECT key FROM items ORDER BY key").map((x) => x.key)).toEqual(["ITEM0001", "ITEM0002", "ITEM0003"]);
		const fetches = r.mock.log.filter((l) => l.query.itemKey).map((l) => l.query.itemKey);
		expect(fetches).toEqual(["ITEM0001,ITEM0003"]);
		expect(r.mock.log.find((l) => l.query.format === "versions")!.query.since).toBe("3"); // the library version the first pull ended at
		expect(outbox(r)).toEqual([]); // pulling never queues a push
	});

	test("remote deletions remove items and collections here", async () => {
		const r = makeRig();
		await connect(r);
		r.mock.put("collection", "COLL0001", { name: "C" });
		r.mock.put("item", "ITEM0001", { title: "One", collections: ["COLL0001"] });
		r.mock.put("item", "ITEM0002", { title: "Two" });
		await r.svc.pull();
		r.mock.remove("item", "ITEM0002");
		r.mock.remove("collection", "COLL0001");
		await r.svc.pull();
		expect(rows(r, "SELECT key FROM items").map((x) => x.key)).toEqual(["ITEM0001"]);
		expect(rows(r, "SELECT key FROM collections")).toEqual([]);
		expect(versionOf(r, "item", "ITEM0002")).toBeUndefined();
		expect(versionOf(r, "collection", "COLL0001")).toBeUndefined();
		expect(outbox(r)).toEqual([]);
	});

	test("restarts from the old version when the library changes during a pull", async () => {
		const r = makeRig();
		await connect(r);
		r.mock.put("item", "ITEM0001", { title: "One" });
		let bumped = false;
		r.mock.onRequest = (_path, q) => {
			if (q.itemKey && !bumped) {
				bumped = true;
				r.mock.put("item", "LATE0001", { title: "Arrived mid-pull" });
			}
		};
		await r.svc.pull();
		expect((await r.svc.status()).lastError).toBeUndefined();
		expect(rows(r, "SELECT key FROM items ORDER BY key").map((x) => x.key)).toEqual(["ITEM0001", "LATE0001"]);
		expect((await r.svc.status()).libraryVersion).toBe(r.mock.version);
		expect(r.mock.log.filter((l) => l.query.format === "versions" && l.path.endsWith("/items")).length).toBe(2);
	});

	test("annotations and notes arrive with the Web API's field names mapped", async () => {
		const r = makeRig();
		await connect(r);
		r.mock.put("item", "PARENT01", { title: "P" });
		r.mock.put("item", "ATTACH01", { itemType: "attachment", parentItem: "PARENT01", linkMode: "imported_file", contentType: "application/pdf", filename: "a.pdf" });
		r.mock.put("item", "ANNOT001", {
			itemType: "annotation",
			parentItem: "ATTACH01",
			annotationType: "highlight",
			annotationText: "quoted",
			annotationColor: "#ffd400",
			annotationSortIndex: "00001|000000|00000",
			annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[1, 2, 3, 4]] }),
		});
		await r.svc.pull();
		const a = repo.getAnnotations(r.db, "ATTACH01");
		expect(a).toHaveLength(1);
		expect(a[0].text).toBe("quoted");
		expect((a[0] as any).position.pageIndex).toBe(0);
		expect(versionOf(r, "annotation", "ANNOT001")).toBeDefined();
	});
});

describe("push", () => {
	test("batches of 50, strictly sequential, each with If-Unmodified-Since-Version", async () => {
		const r = makeRig();
		await connect(r);
		await r.svc.pull();
		await r.svc.setOptions({ push: true });
		const coll = repo.createCollection(r.db, "Fresh");
		const keys: string[] = [];
		for (let i = 0; i < 120; i++) keys.push(repo.createItem(r.db, { itemType: "journalArticle", title: `Paper ${i}` }).data.key);
		r.mock.log.length = 0;
		r.mock.maxInFlight = 0;
		r.mock.delayMs = 5;
		await r.svc.push();
		expect((await r.svc.status()).lastError).toBeUndefined();

		const posts = r.mock.posts();
		expect(posts.map((p) => `${p.path.split("/").pop()}:${p.size}`)).toEqual(["collections:1", "items:50", "items:50", "items:20"]);
		expect(r.mock.maxInFlight).toBe(1);
		// each request carries the version the previous one produced
		expect(posts.map((p) => Number(p.ifUnmodified))).toEqual([1, 2, 3, 4]);
		expect(outbox(r)).toEqual([]);
		expect(versionOf(r, "collection", coll.key)).toBeDefined();
		for (const k of keys) expect(versionOf(r, "item", k)).toBe(r.mock.item(k)!.version);
		expect(r.mock.item(keys[0])!.data.title).toBe("Paper 0");
		expect((await r.svc.status()).lastPushAt).toBeTruthy();
	});

	test("a 412 pulls the other side's changes and retries", async () => {
		const r = makeRig();
		await connect(r);
		await r.svc.pull();
		await r.svc.setOptions({ push: true });
		r.mock.put("item", "THEIRS01", { title: "Written elsewhere" }); // library moves after our pull
		const k = repo.createItem(r.db, { itemType: "journalArticle", title: "Mine" }).data.key;
		r.mock.log.length = 0;
		await r.svc.push();
		expect((await r.svc.status()).lastError).toBeUndefined();
		expect(r.mock.posts().map((p) => p.status)).toEqual([412, 200]);
		expect(r.mock.item(k)!.data.title).toBe("Mine");
		expect((r.db.query("SELECT title FROM items WHERE key = 'THEIRS01'").get() as any).title).toBe("Written elsewhere");
		expect(outbox(r)).toEqual([]);
	});

	test("a per-object failure keeps that object queued and reports it", async () => {
		const r = makeRig();
		await connect(r);
		r.mock.put("item", "ITEM0001", { title: "Remote" });
		await r.svc.pull();
		await r.svc.setOptions({ push: true });
		repo.patchItem(r.db, "ITEM0001", { title: "Local edit" });
		r.mock.objects.get("item:ITEM0001")!.version = 99; // server's object moved on: our version is stale
		await r.svc.push();
		expect((await r.svc.status()).lastError).toContain("ITEM0001");
		expect(outbox(r)).toContain("item:ITEM0001:upsert");
	});

	test("trash travels as deleted:1 and local erasures become DELETE requests", async () => {
		const r = makeRig();
		await connect(r);
		r.mock.put("item", "ITEM0001", { title: "One" });
		r.mock.put("item", "ITEM0002", { title: "Two" });
		await r.svc.pull();
		await r.svc.setOptions({ push: true });
		repo.patchItem(r.db, "ITEM0001", { deleted: 1 });
		r.db.run("DELETE FROM items WHERE key = 'ITEM0002'");
		r.mock.log.length = 0;
		await r.svc.push();
		expect((await r.svc.status()).lastError).toBeUndefined();
		expect(r.mock.item("ITEM0001")!.data.deleted).toBe(1);
		expect(r.mock.item("ITEM0002")).toBeUndefined();
		const del = r.mock.log.find((l) => l.method === "DELETE")!;
		expect(del.query.itemKey).toBe("ITEM0002");
		expect(del.ifUnmodified).toBeTruthy();
		expect(versionOf(r, "item", "ITEM0002")).toBeUndefined();
		expect(outbox(r)).toEqual([]);
	});

	test("push is off by default and for read-only keys", async () => {
		const r = makeRig();
		await connect(r);
		await r.svc.pull();
		repo.createItem(r.db, { itemType: "journalArticle", title: "Waiting" });
		r.mock.log.length = 0;
		await r.svc.push();
		expect(r.mock.posts()).toEqual([]);
		expect(outbox(r).length).toBe(1);
		r.mock.canWrite = false;
		await r.svc.setKey(API_KEY);
		await r.svc.setOptions({ push: true });
		await r.svc.push();
		expect(r.mock.posts()).toEqual([]);
		expect((await r.svc.status()).lastError).toContain("read-only");
	});
});

describe("Backoff and Retry-After", () => {
	test("a Backoff header pauses the next requests", async () => {
		const r = makeRig();
		await connect(r);
		r.mock.put("item", "ITEM0001", { title: "One" });
		r.mock.backoffNext = 3;
		await r.svc.pull();
		expect(r.sleeps.some((ms) => ms >= 3000)).toBe(true);
		expect((r.db.query("SELECT title FROM items WHERE key = 'ITEM0001'").get() as any).title).toBe("One");
	});

	test("429 with Retry-After waits, then the request is retried", async () => {
		const r = makeRig();
		await connect(r);
		r.mock.put("item", "ITEM0001", { title: "One" });
		r.mock.throttle = 1;
		r.mock.retryAfter = 7;
		await r.svc.pull();
		expect(r.sleeps.some((ms) => ms >= 7000)).toBe(true);
		expect((await r.svc.status()).lastError).toBeUndefined();
		expect(rows(r, "SELECT key FROM items").length).toBe(1);
	});

	test("the pause is shared: every request waits, and never more than 4 run at once", async () => {
		const r = makeRig();
		await connect(r);
		for (let i = 0; i < 400; i++) r.mock.put("item", `K${String(i).padStart(7, "0")}`, { title: `t${i}` }); // 8 fetch batches
		r.mock.delayMs = 10;
		r.mock.backoffNext = 2;
		await r.svc.pull();
		expect(r.mock.maxInFlight).toBeLessThanOrEqual(4);
		expect(r.sleeps.length).toBeGreaterThan(0);
		expect(rows(r, "SELECT count(*) AS n FROM items")[0].n).toBe(400);
	});
});

describe("files", () => {
	function attachments(r: Rig) {
		insertItem(r.db, localItem("PARENT01", "Parent") as any);
		insertAttachment(r.db, "ATT00001", "PARENT01", "application/pdf", null); // missing, on the server
		insertAttachment(r.db, "ATT00002", "PARENT01", "application/pdf", join(r.dir, "storage", "ATT00002", "gone.pdf")); // missing, not on the server
		const present = join(r.dir, "storage", "ATT00003", "here.pdf");
		mkdirSync(join(r.dir, "storage", "ATT00003"), { recursive: true });
		writeFileSync(present, "local");
		insertAttachment(r.db, "ATT00003", "PARENT01", "application/pdf", present); // present locally
		insertAttachment(r.db, "ATT00004", "PARENT01", "application/pdf", null); // missing, server errors
		r.mock.files.set("ATT00001", new TextEncoder().encode("pdf bytes one"));
		r.mock.fileStatus.set("ATT00004", 500);
		r.db.run("DELETE FROM sync_outbox");
	}

	test("files: off never touches a file endpoint during a sync", async () => {
		const r = makeRig();
		await connect(r);
		r.mock.put("item", "PARENT01", { title: "P" });
		r.mock.put("item", "ATT00001", { itemType: "attachment", parentItem: "PARENT01", linkMode: "imported_file", contentType: "application/pdf", filename: "one.pdf" });
		r.mock.files.set("ATT00001", new TextEncoder().encode("bytes"));
		await r.svc.setOptions({ push: true, files: "off" });
		repo.createItem(r.db, { itemType: "journalArticle", title: "x" });
		await r.svc.syncNow();
		await r.svc.fileJobDone;
		expect(r.mock.log.some((l) => /\/file$/.test(l.path) || l.path.startsWith("/blob/") || l.path.startsWith("/upload/"))).toBe(false);
		expect((await r.svc.status()).fileJob).toBeUndefined();
		expect(existsSync(join(r.dir, "storage"))).toBe(false);
	});

	test("check counts what is missing here and what zotero.org holds, even with files off", async () => {
		const r = makeRig();
		await connect(r);
		attachments(r);
		expect((await r.svc.status()).files).toBe("off");
		const c = await r.svc.checkFiles();
		expect(c).toMatchObject({ imported: 4, missingLocally: 3, onServer: 1, notOnServer: 1, unknown: 1 });
		expect(c.sample.map((s) => [s.key, s.onServer]).sort()).toEqual([
			["ATT00001", true],
			["ATT00002", false],
			["ATT00004", null],
		]);
		// the check never follows the redirect or downloads anything
		expect(r.mock.log.some((l) => l.path.startsWith("/blob/"))).toBe(false);
		expect(existsSync(join(r.dir, "storage", "ATT00001"))).toBe(false);
	});

	test("download-missing writes files into zotero-next's storage without queuing a push", async () => {
		const r = makeRig();
		await connect(r);
		attachments(r);
		// a checksum that does not match is rejected, not stored
		insertAttachment(r.db, "ATT00005", "PARENT01", "application/pdf", null);
		r.db.run("UPDATE items SET data = json_set(data, '$.md5', 'ffffffffffffffffffffffffffffffff') WHERE key = 'ATT00005'");
		r.mock.files.set("ATT00005", new TextEncoder().encode("other"));
		r.db.run("DELETE FROM sync_outbox");

		const st = await r.svc.downloadMissing();
		expect(st.fileJob?.running).toBe(true);
		await r.svc.fileJobDone;
		const job = (await r.svc.status()).fileJob!;
		expect(job).toMatchObject({ running: false, total: 4, done: 1, failed: 3 });
		expect(job.bytes).toBe("pdf bytes one".length);
		const file = join(r.dir, "storage", "ATT00001", "att ATT00001");
		expect(readFileSync(file, "utf8")).toBe("pdf bytes one");
		expect((r.db.query("SELECT path FROM attachments WHERE item_key = 'ATT00001'").get() as any).path).toBe(file);
		expect(existsSync(join(r.dir, "storage", "ATT00005"))).toBe(false);
		expect(outbox(r)).toEqual([]); // updating the stored path is not a user change
		// a second run has less to do
		await r.svc.downloadMissing();
		await r.svc.fileJobDone;
		expect((await r.svc.status()).fileJob).toMatchObject({ total: 3, done: 0, failed: 3 });
	});

	test("web snapshots (zipped on zotero.org) are checked, downloaded and unzipped", async () => {
		const r = makeRig();
		await connect(r);
		r.mock.put("item", "PARENT01", { title: "P" });
		const snap = (key: string, filename: string) =>
			r.mock.put("item", key, { itemType: "attachment", parentItem: "PARENT01", linkMode: "imported_url", contentType: "text/html", url: "https://example.org/", filename });
		snap("SNAP0001", "index.html");
		snap("SNAP0002", "café.html");
		snap("SNAP0003", "index.html");
		snap("SNAP0004", "index.html"); // no file on the server
		const enc = new TextEncoder();
		r.mock.files.set(
			"SNAP0001",
			zipOf([
				{ name: "index.html", data: "<html>one</html>", deflate: true },
				{ name: "images/a.png", data: enc.encode("png") },
				{ name: "../evil.txt", data: "escape" },
				{ name: ".zotero-ft-cache", data: "cache" },
			]),
		);
		r.mock.files.set("SNAP0002", zipOf([{ name: "caf%C3%A9.html", data: "<html>two</html>" }])); // percent-encoded entry name
		r.mock.files.set("SNAP0003", zipOf([{ name: "other.html", data: "no main file" }]));
		await r.svc.pull();
		for (const k of ["SNAP0001", "SNAP0002", "SNAP0003", "SNAP0004"]) expect((r.db.query("SELECT path FROM attachments WHERE item_key = ?").get(k) as any).path).toBeNull();

		const c = await r.svc.checkFiles();
		expect(c).toMatchObject({ imported: 4, missingLocally: 4, onServer: 3, notOnServer: 1, snapshots: { imported: 4, missingLocally: 4, onServer: 3 } });

		await r.svc.downloadMissing();
		await r.svc.fileJobDone;
		expect((await r.svc.status()).fileJob).toMatchObject({ total: 4, done: 2, failed: 2, running: false });
		const s1 = join(r.dir, "storage", "SNAP0001");
		expect(readFileSync(join(s1, "index.html"), "utf8")).toBe("<html>one</html>");
		expect(readFileSync(join(s1, "images", "a.png"), "utf8")).toBe("png");
		expect(existsSync(join(r.dir, "storage", "evil.txt"))).toBe(false);
		expect(existsSync(join(r.dir, "evil.txt"))).toBe(false);
		expect(existsSync(join(s1, ".zotero-ft-cache"))).toBe(false);
		expect((r.db.query("SELECT path FROM attachments WHERE item_key = 'SNAP0001'").get() as any).path).toBe(join(s1, "index.html"));
		expect(readFileSync(join(r.dir, "storage", "SNAP0002", "café.html"), "utf8")).toBe("<html>two</html>");
		expect((r.db.query("SELECT path FROM attachments WHERE item_key = 'SNAP0002'").get() as any).path).toBe(join(r.dir, "storage", "SNAP0002", "café.html"));
		expect((r.db.query("SELECT path FROM attachments WHERE item_key = 'SNAP0003'").get() as any).path).toBeNull(); // archive without its main file
		expect(outbox(r)).toEqual([]);
		// once downloaded they no longer count as missing
		expect((await r.svc.checkFiles()).snapshots).toMatchObject({ imported: 4, missingLocally: 2 });
	});

	test("files: download fetches missing files during a sync", async () => {
		const r = makeRig();
		await connect(r);
		r.mock.put("item", "PARENT01", { title: "P" });
		r.mock.put("item", "ATT00001", { itemType: "attachment", parentItem: "PARENT01", linkMode: "imported_file", contentType: "text/plain", filename: "one.txt" });
		r.mock.files.set("ATT00001", new TextEncoder().encode("hello"));
		await r.svc.setOptions({ files: "download" });
		await r.svc.syncNow();
		await r.svc.fileJobDone;
		expect(readFileSync(join(r.dir, "storage", "ATT00001", "one.txt"), "utf8")).toBe("hello");
		expect(outbox(r)).toEqual([]);
	});

	test("files: sync uploads a local file the server lacks, once", async () => {
		const r = makeRig();
		await connect(r);
		r.mock.put("item", "PARENT01", { title: "P" });
		r.mock.put("item", "ATT00001", { itemType: "attachment", parentItem: "PARENT01", linkMode: "imported_file", contentType: "text/plain", filename: "one.txt" });
		mkdirSync(join(r.dir, "storage", "ATT00001"), { recursive: true });
		writeFileSync(join(r.dir, "storage", "ATT00001", "one.txt"), "local bytes");
		await r.svc.setOptions({ files: "sync" });
		await r.svc.syncNow();
		await r.svc.fileJobDone;
		expect(new TextDecoder().decode(r.mock.files.get("ATT00001"))).toBe("local bytes");
		const uploads = r.mock.log.filter((l) => l.method === "POST" && l.path.endsWith("/file")).length;
		expect(uploads).toBe(2); // authorize + register
		await r.svc.syncNow(); // the item now carries the checksum: nothing more to upload
		expect(r.mock.log.filter((l) => l.method === "POST" && l.path.endsWith("/file")).length).toBe(uploads);
		expect((JSON.parse((r.db.query("SELECT data FROM items WHERE key = 'ATT00001'").get() as any).data) as any).md5).toBeTruthy();
	});
});

describe("HTTP API and mode exclusivity", () => {
	const call = (r: Rig, method: string, path: string, body?: unknown) =>
		handleApi(
			new Request(`http://127.0.0.1/api/websync/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
			r.db,
		).then(async (res) => ({ status: res!.status, body: (await res!.json()) as any }));

	test("key validation, status and secrecy", async () => {
		const r = makeRig();
		let s = await call(r, "GET", "status");
		expect(s.status).toBe(200);
		expect(s.body).toMatchObject({ mode: "zotero-local", account: { keySet: false }, push: false, files: "off", pending: 0, conflicts: 0, busy: false });

		const bad = await call(r, "POST", "key", { apiKey: "wrong" });
		expect(bad.status).toBe(400);
		expect(bad.body.error).toContain("rejected");
		expect(r.keys.value).toBeNull();

		s = await call(r, "POST", "key", { apiKey: API_KEY });
		expect(s.status).toBe(200);
		expect(s.body.account).toEqual({ keySet: true, userId: 42, username: "tester", canWrite: true, filesAccess: true });
		expect(r.keys.value).toBe(API_KEY);
		// the key is in the key store only: not in any response, and not in the database
		expect(JSON.stringify(s.body)).not.toContain(API_KEY);
		expect(JSON.stringify(rows(r, "SELECT name, value FROM sync_state"))).not.toContain(API_KEY);

		s = await call(r, "DELETE", "key");
		expect(s.body.account).toEqual({ keySet: false });
		expect(r.keys.value).toBeNull();
	});

	test("options, now, files/check and download-missing", async () => {
		const r = makeRig();
		await call(r, "POST", "key", { apiKey: API_KEY });
		expect((await call(r, "POST", "options", { files: "bogus" })).status).toBe(400);
		const o = await call(r, "POST", "options", { push: true, files: "download" });
		expect(o.body).toMatchObject({ push: true, files: "download" });
		r.mock.put("item", "ITEM0001", { title: "One" });
		const n = await call(r, "POST", "now");
		expect(n.body.libraryVersion).toBe(r.mock.version);
		expect(n.body.lastPullAt).toBeTruthy();
		expect((await call(r, "POST", "files/check")).body).toMatchObject({ imported: 0, missingLocally: 0 });
		const d = await call(r, "POST", "files/download-missing");
		expect(d.status).toBe(200);
		expect((await call(r, "GET", "nope")).status).toBe(404);
		expect((await call(r, "GET", "now")).status).toBe(405);
	});

	test("routes need a key", async () => {
		const r = makeRig();
		for (const p of ["now", "files/check", "files/download-missing"]) expect((await call(r, "POST", p)).status).toBe(400);
		expect((await call(r, "POST", "mode", { mode: "zotero-org" })).status).toBe(400);
		expect(syncMode(r.db)).toBe("zotero-local");
	});

	test("switching to zotero-org stops the local SyncService and starts the web one", async () => {
		const r = makeRig();
		await call(r, "POST", "key", { apiKey: API_KEY });
		const zoteroDir = join(r.dir, "Zotero");
		mkdirSync(join(zoteroDir, "storage"), { recursive: true });
		startSync(r.db, { dataDir: zoteroDir, reader: new FakeReader(), writer: new FakeWriter(zoteroDir), isZoteroRunning: async () => false, pollMs: 0, watch: false });
		expect(getSyncService(r.db)).toBeDefined();

		const s = await call(r, "POST", "mode", { mode: "zotero-org" });
		expect(s.status).toBe(200);
		expect(s.body.mode).toBe("zotero-org");
		expect(getSyncService(r.db)).toBeUndefined();
		expect(syncMode(r.db)).toBe("zotero-org");

		const back = await call(r, "POST", "mode", { mode: "zotero-local" });
		expect(back.body.mode).toBe("zotero-local");
		expect((await call(r, "POST", "mode", { mode: "nonsense" })).status).toBe(400);
		const off = await call(r, "POST", "mode", { mode: "off" });
		expect(off.body.mode).toBe("off");
	});

	test("the web service syncs on its timer once started in zotero-org mode", async () => {
		const r = makeRig();
		await call(r, "POST", "key", { apiKey: API_KEY });
		r.mock.put("item", "ITEM0001", { title: "One" });
		const { startWebSync, stopWebSync } = await import("../../src/websync");
		const svc = startWebSync(r.db, { ...r.opts, initialSync: true });
		for (let i = 0; i < 100 && !(await svc.status()).lastPullAt; i++) await Bun.sleep(20);
		expect((r.db.query("SELECT title FROM items WHERE key = 'ITEM0001'").get() as any).title).toBe("One");
		await stopWebSync(r.db);
		expect(svc.running).toBe(false);
	});
});

describe("mock", () => {
	test("never serves a request without the API key", async () => {
		const m = new MockZotero();
		const res = await fetch(`${m.url}/users/42/items`);
		expect(res.status).toBe(403);
		m.stop();
	});
});
