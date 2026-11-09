// Review findings GPT #7, #14, #15 and Gemini #4 for zotero.org sync (all against the mocked server in mock.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { libraryByGroupId } from "../../src/libraries";
import { insertAttachment, insertItem } from "../fixture";
import { API_KEY } from "./mock";
import { connect, makeRig, stopAll, type Rig } from "./rig";

afterEach(stopAll);

const rows = (r: Rig, sql: string, ...p: any[]) => r.db.query(sql).all(...p) as any[];
const state = (r: Rig, name: string) => (r.db.query("SELECT value FROM sync_state WHERE name = ?").get(name) as { value: string } | null)?.value;
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
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

describe("account binding (GPT #7)", () => {
	test("a key of another account is refused until the link is reset; the reset clears account-bound state only", async () => {
		const r = makeRig();
		await connect(r);
		r.mock.put("item", "ITEM0001", { title: "Remote" });
		await r.svc.pull();
		expect(rows(r, "SELECT key FROM websync_versions")).toHaveLength(1);
		expect(state(r, "web_library_version")).toBeTruthy();
		expect(state(r, "web_bound_user_id")).toBe("42");

		// the library was linked to another user: this key (user 42) must be refused
		r.db.run("UPDATE sync_state SET value = '7' WHERE name = 'web_bound_user_id'");
		r.db.run("UPDATE sync_state SET value = '7' WHERE name = 'web_user_id'");
		await expect(r.svc.setKey(API_KEY)).rejects.toMatchObject({ status: 409 });
		expect(state(r, "web_user_id")).toBe("7"); // nothing was changed by the refusal

		// clearing the key does not unbind the account either
		await r.svc.clearKey();
		await expect(r.svc.setKey(API_KEY)).rejects.toMatchObject({ status: 409 });

		const before = rows(r, "SELECT key FROM items").length;
		await r.svc.resetAccount();
		expect(rows(r, "SELECT key FROM websync_versions")).toEqual([]);
		expect(state(r, "web_library_version")).toBeUndefined();
		expect(state(r, "web_bound_user_id")).toBeUndefined();
		expect(rows(r, "SELECT key FROM items")).toHaveLength(before); // no library data was deleted
		await r.svc.setKey(API_KEY);
		expect(state(r, "web_bound_user_id")).toBe("42");
	});

	test("the same account can set its key again", async () => {
		const r = makeRig();
		await connect(r);
		await connect(r);
		expect(state(r, "web_user_id")).toBe("42");
	});
});

describe("pull retries objects that failed (GPT #15)", () => {
	test("an orphan child is not recorded as seen, and is fetched again once its parent arrives", async () => {
		const r = makeRig();
		await connect(r);
		r.mock.put("item", "ORPHAN01", { itemType: "note", parentItem: "LATER001", note: "<p>x</p>" });
		await r.svc.pull();
		expect(rows(r, "SELECT key FROM items")).toEqual([]);
		expect(rows(r, "SELECT key FROM websync_versions")).toEqual([]);
		expect(JSON.parse(state(r, "web_retry")!)).toEqual([{ type: "item", key: "ORPHAN01" }]);
		const watermark = state(r, "web_library_version");
		expect(Number(watermark)).toBeGreaterThan(0); // the watermark moved on, the retry list holds the object

		r.mock.put("item", "LATER001", { title: "Parent" });
		await r.svc.pull();
		expect(rows(r, "SELECT key FROM items ORDER BY key").map((x) => x.key)).toEqual(["LATER001", "ORPHAN01"]);
		expect(state(r, "web_retry")).toBeUndefined();
		expect(rows(r, "SELECT key FROM websync_versions ORDER BY key").map((x) => x.key)).toEqual(["LATER001", "ORPHAN01"]);
	});
});

describe("keys shared between libraries (Gemini #4)", () => {
	test("a group's object with a key My Library owns records no version and removes nothing of ours", async () => {
		const r = makeRig();
		const g = r.mock.addGroup(100, { name: "Lab", owner: 42 });
		await connect(r);
		insertItem(r.db, localItem("SAMEKEY1", "Mine") as any);
		r.mock.put("item", "SAMEKEY1", { title: "Mine" });
		await r.svc.pull();
		const mine = rows(r, "SELECT version FROM websync_versions WHERE key = 'SAMEKEY1'")[0].version;

		// the group holds an object with the same key (an item copied between libraries) at a higher version
		g.put("item", "SAMEKEY1", { title: "Group copy" });
		g.put("item", "SAMEKEY1", { title: "Group copy v2" });
		await r.svc.pull();
		const lib = libraryByGroupId(r.db, 100)!;
		expect(rows(r, "SELECT title, library_id FROM items WHERE key = 'SAMEKEY1'")).toEqual([{ title: "Mine", library_id: 1 }]);
		expect(rows(r, "SELECT version FROM websync_versions WHERE key = 'SAMEKEY1'")[0].version).toBe(mine);
		expect(lib.id).toBeGreaterThan(1);

		// the group erases it: My Library's object and its version stay
		g.remove("item", "SAMEKEY1");
		await r.svc.pull();
		expect(rows(r, "SELECT title FROM items WHERE key = 'SAMEKEY1'")).toEqual([{ title: "Mine" }]);
		expect(rows(r, "SELECT version FROM websync_versions WHERE key = 'SAMEKEY1'")).toHaveLength(1);
	});
});

describe("changed attachment files (GPT #14)", () => {
	const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

	async function setup(r: Rig, local: string, remote: string, mode: "download" | "sync") {
		await connect(r);
		r.mock.put("item", "PARENT01", { title: "P" });
		r.mock.put("item", "ATT00001", { itemType: "attachment", parentItem: "PARENT01", linkMode: "imported_file", contentType: "text/plain", filename: "one.txt", md5: md5(remote) });
		r.mock.files.set("ATT00001", new TextEncoder().encode(remote));
		const dir = join(r.dir, "storage", "ATT00001");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "one.txt"), local);
		await r.svc.setOptions({ files: mode });
		await r.svc.pull();
		return join(dir, "one.txt");
	}

	test("a server replacement reaches an unchanged local copy", async () => {
		const r = makeRig();
		const file = await setup(r, "v1", "v1", "download");
		await r.svc.syncNow();
		await r.svc.fileJobDone;
		expect(readFileSync(file, "utf8")).toBe("v1"); // baseline recorded: both sides equal
		// someone replaces the file on zotero.org
		r.mock.put("item", "ATT00001", { itemType: "attachment", parentItem: "PARENT01", linkMode: "imported_file", contentType: "text/plain", filename: "one.txt", md5: md5("v2") });
		r.mock.files.set("ATT00001", new TextEncoder().encode("v2"));
		await r.svc.syncNow();
		await r.svc.fileJobDone;
		expect(readFileSync(file, "utf8")).toBe("v2");
		expect(rows(r, "SELECT * FROM sync_conflicts")).toEqual([]);
	});

	test("a local edit is uploaded when the server's file is unchanged", async () => {
		const r = makeRig();
		const file = await setup(r, "v1", "v1", "sync");
		await r.svc.syncNow();
		await r.svc.fileJobDone;
		writeFileSync(file, "v1 rotated");
		await r.svc.syncNow();
		await r.svc.fileJobDone;
		expect(text(r.mock.files.get("ATT00001"))).toBe("v1 rotated");
		expect(readFileSync(file, "utf8")).toBe("v1 rotated");
		await r.svc.syncNow(); // our own upload is not mistaken for a remote replacement
		await r.svc.fileJobDone;
		expect(readFileSync(file, "utf8")).toBe("v1 rotated");
	});

	test("both sides changed: the local file is kept, the server's lands beside it, a conflict is recorded", async () => {
		const r = makeRig();
		const file = await setup(r, "v1", "v1", "sync");
		await r.svc.syncNow();
		await r.svc.fileJobDone;
		writeFileSync(file, "local edit");
		r.mock.put("item", "ATT00001", { itemType: "attachment", parentItem: "PARENT01", linkMode: "imported_file", contentType: "text/plain", filename: "one.txt", md5: md5("server edit") });
		r.mock.files.set("ATT00001", new TextEncoder().encode("server edit"));
		await r.svc.syncNow();
		await r.svc.fileJobDone;
		expect(readFileSync(file, "utf8")).toBe("local edit");
		expect(text(r.mock.files.get("ATT00001"))).toBe("server edit");
		const copies = readdirSync(join(r.dir, "storage", "ATT00001")).filter((f) => f.includes(".conflict-"));
		expect(copies).toHaveLength(1);
		expect(readFileSync(join(r.dir, "storage", "ATT00001", copies[0]), "utf8")).toBe("server edit");
		expect(rows(r, "SELECT key, resolved FROM sync_conflicts")).toEqual([{ key: "ATT00001", resolved: "local" }]);
		await r.svc.syncNow(); // no second copy, no second conflict
		await r.svc.fileJobDone;
		expect(rows(r, "SELECT key FROM sync_conflicts")).toHaveLength(1);
	});

	test("a file that differs with no recorded baseline is reported, never overwritten", async () => {
		const r = makeRig();
		const file = await setup(r, "mine", "theirs", "download");
		await r.svc.syncNow();
		await r.svc.fileJobDone;
		expect(readFileSync(file, "utf8")).toBe("mine");
		expect(rows(r, "SELECT key FROM sync_conflicts")).toHaveLength(1);
		expect(existsSync(file)).toBe(true);
	});
});

// keep insertAttachment imported for fixtures shared with the other websync tests
void insertAttachment;
