import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { handleApi } from "../../src/api";
import * as repo from "../../src/db";
import { getLibrary, listLibraries, libraryByGroupId, USER_LIBRARY } from "../../src/libraries";
import { groupPermissions } from "../../src/websync/service";
import { USER_ID } from "./mock";
import { connect, makeRig, stopAll, type Rig } from "./rig";

afterEach(stopAll);

// Group libraries through a MOCKED zotero.org (mock.ts): nothing here contacts the network.

const rows = (r: Rig, sql: string, ...p: any[]) => r.db.query(sql).all(...p) as any[];
const groupLib = (r: Rig, groupId: number) => libraryByGroupId(r.db, groupId)!;
const titles = (r: Rig, library: number) =>
	repo.listItems(r.db, { library, limit: 1000, sort: "title", dir: "asc" }).items.map((i) => i.title);
const status = (fn: () => unknown): number | undefined => {
	try {
		fn();
	} catch (e) {
		return (e as { status?: number }).status;
	}
	return undefined;
};
const groupPosts = (r: Rig, groupId: number) => r.mock.log.filter((l) => l.method === "POST" && l.path.startsWith(`/groups/${groupId}/`));
const userPosts = (r: Rig) => r.mock.log.filter((l) => l.method === "POST" && l.path.startsWith(`/users/${USER_ID}/`));

describe("group permissions", () => {
	const rec = (over: Record<string, unknown> = {}) =>
		({ id: 5, owner: 1, admins: [2], members: [3], libraryEditing: "members", fileEditing: "members", ...over }) as any;
	const all = { all: { library: true, write: true } };
	test("owner and admins always edit; members edit only when the group lets members; others never", () => {
		expect(groupPermissions(rec(), 1, all, true).editable).toBe(true); // owner
		expect(groupPermissions(rec({ libraryEditing: "admins" }), 2, all, true).editable).toBe(true); // admin
		expect(groupPermissions(rec(), 3, all, true).editable).toBe(true); // member, members may edit
		expect(groupPermissions(rec({ libraryEditing: "admins" }), 3, all, true).editable).toBe(false); // member, admins only
		expect(groupPermissions(rec(), 99, all, true).editable).toBe(false); // not in the lists
	});
	test("the API key must allow writing, for all groups or for this one", () => {
		expect(groupPermissions(rec(), 1, { all: { write: false } }, true).editable).toBe(false);
		expect(groupPermissions(rec(), 1, { all: { write: false }, "5": { write: true } }, true).editable).toBe(true);
		expect(groupPermissions(rec(), 1, { all: { write: true }, "5": { write: false } }, true).editable).toBe(false);
		expect(groupPermissions(rec(), 1, undefined, true).editable).toBe(false);
	});
	test("files follow the group's file setting and the key's file access", () => {
		expect(groupPermissions(rec({ fileEditing: "none" }), 1, all, true).filesEditable).toBe(false);
		expect(groupPermissions(rec({ fileEditing: "admins" }), 3, all, true).filesEditable).toBe(false);
		expect(groupPermissions(rec({ fileEditing: "admins" }), 2, all, true).filesEditable).toBe(true);
		expect(groupPermissions(rec(), 3, all, false).filesEditable).toBe(false); // key without file access
	});
});

describe("discovering groups", () => {
	test("a pull lists the account's groups and creates a library for each", async () => {
		const r = makeRig();
		r.mock.addGroup(100, { name: "Lab", owner: USER_ID });
		r.mock.addGroup(200, { name: "Journal club", owner: 7, libraryEditing: "admins" });
		await connect(r);
		await r.svc.pull();
		const libs = listLibraries(r.db);
		expect(libs.map((l) => l.name)).toEqual(["My Library", "Journal club", "Lab"]);
		expect(groupLib(r, 100)).toMatchObject({ type: "group", groupId: 100, editable: true });
		expect(groupLib(r, 200)).toMatchObject({ editable: false }); // member, admins-only group
		expect((await r.svc.status()).groups.map((g) => [g.groupId, g.name, g.editable])).toEqual([
			[200, "Journal club", false],
			[100, "Lab", true],
		]);
	});

	test("a rename and new permissions arrive; a group the account left is hidden, its data kept", async () => {
		const r = makeRig();
		const g = r.mock.addGroup(100, { name: "Lab", owner: USER_ID });
		g.put("item", "GROUPIT1", { title: "Kept" });
		await connect(r);
		await r.svc.pull();
		const id = groupLib(r, 100).id;
		g.record.name = "Lab (renamed)";
		g.record.libraryEditing = "admins";
		g.record.owner = 7;
		g.recordVersion++;
		await r.svc.pull();
		expect(getLibrary(r.db, id)).toMatchObject({ name: "Lab (renamed)", editable: false });
		r.mock.leaveGroup(100);
		await r.svc.pull();
		expect(listLibraries(r.db).map((l) => l.name)).toEqual(["My Library"]);
		expect(rows(r, "SELECT title FROM items WHERE library_id = ?", id).map((x) => x.title)).toEqual(["Kept"]); // nothing deleted
		// and it comes back if the account rejoins
		r.mock.groups.set(100, g);
		await r.svc.pull();
		expect(listLibraries(r.db).map((l) => l.name)).toEqual(["My Library", "Lab (renamed)"]);
	});

	test("an unchanged group list costs one small request, not a full listing", async () => {
		const r = makeRig();
		r.mock.addGroup(100);
		await connect(r);
		await r.svc.pull();
		r.mock.log.length = 0;
		await r.svc.pull();
		const listings = r.mock.log.filter((l) => l.path === `/users/${USER_ID}/groups`);
		expect(listings.map((l) => l.query.format)).toEqual(["versions"]);
	});
});

describe("pulling a group", () => {
	test("items, collections, tags, notes and annotations land in the group's library, not in My Library", async () => {
		const r = makeRig();
		const g = r.mock.addGroup(100, { owner: USER_ID });
		r.mock.put("item", "MINE0001", { title: "Mine" });
		g.put("collection", "GCOLL001", { name: "Papers" });
		g.put("item", "GITEM001", { title: "Shared paper", collections: ["GCOLL001"], tags: [{ tag: "shared" }] });
		g.put("item", "GNOTE001", { itemType: "note", note: "<p>hi</p>", parentItem: "GITEM001" });
		g.put("item", "GATT0001", {
			itemType: "attachment",
			linkMode: "imported_file",
			contentType: "application/pdf",
			filename: "p.pdf",
			parentItem: "GITEM001",
		});
		g.put("item", "GANN0001", {
			itemType: "annotation",
			annotationType: "highlight",
			annotationText: "x",
			annotationSortIndex: "00000|000000|00000",
			annotationPosition: JSON.stringify({ pageIndex: 0, rects: [[0, 0, 1, 1]] }),
			parentItem: "GATT0001",
		});
		await connect(r);
		await r.svc.pull();
		const lib = groupLib(r, 100).id;
		expect(titles(r, USER_LIBRARY)).toEqual(["Mine"]);
		expect(titles(r, lib)).toEqual(["Shared paper"]);
		expect(repo.listCollections(r.db, lib).map((c) => c.name)).toEqual(["Papers"]);
		expect(repo.listCollections(r.db).map((c) => c.name)).toEqual([]);
		expect(repo.listTags(r.db, lib)).toEqual([{ tag: "shared", count: 1 }]);
		expect(
			rows(r, "SELECT key, library_id FROM items WHERE key IN ('GNOTE001', 'GATT0001') ORDER BY key").map((x) => x.library_id),
		).toEqual([lib, lib]);
		expect(rows(r, "SELECT key FROM annotations").map((x) => x.key)).toEqual(["GANN0001"]);
		expect(repo.listItems(r.db, { collection: "GCOLL001" }).items.map((i) => i.title)).toEqual(["Shared paper"]);
		expect(rows(r, "SELECT count(*) AS n FROM sync_outbox").at(0).n).toBe(0); // pulling never queues a push
	});

	test("each library keeps its own library version and fetches only what changed in it", async () => {
		const r = makeRig();
		const g = r.mock.addGroup(100, { owner: USER_ID });
		r.mock.put("item", "MINE0001", { title: "Mine" });
		g.put("item", "GITEM001", { title: "One" });
		g.put("item", "GITEM002", { title: "Two" });
		await connect(r);
		await r.svc.pull();
		const st = await r.svc.status();
		expect(st.libraryVersion).toBe(r.mock.version);
		expect(st.groups[0].libraryVersion).toBe(g.version);
		r.mock.log.length = 0;
		g.put("item", "GITEM001", { title: "One edited", dateModified: "2026-06-02T00:00:00Z" });
		await r.svc.pull();
		const group = r.mock.log.filter((l) => l.path === "/groups/100/items" && l.query.format === "versions");
		expect(group).toHaveLength(1);
		expect(group[0].query.since).toBe("3");
		expect(r.mock.log.find((l) => l.path === "/groups/100/items" && l.query.itemKey)!.query.itemKey).toBe("GITEM001");
		expect(titles(r, groupLib(r, 100).id)).toEqual(["One edited", "Two"]);
	});

	test("remote deletions in a group remove only that group's objects", async () => {
		const r = makeRig();
		const g = r.mock.addGroup(100, { owner: USER_ID });
		r.mock.put("item", "MINE0001", { title: "Mine" });
		g.put("item", "GITEM001", { title: "Doomed" });
		g.put("collection", "GCOLL001", { name: "Doomed collection" });
		await connect(r);
		await r.svc.pull();
		g.remove("item", "GITEM001");
		g.remove("collection", "GCOLL001");
		await r.svc.pull();
		expect(titles(r, groupLib(r, 100).id)).toEqual([]);
		expect(repo.listCollections(r.db, groupLib(r, 100).id)).toEqual([]);
		expect(titles(r, USER_LIBRARY)).toEqual(["Mine"]);
	});

	test("a failing group does not stop My Library or the other groups, and shows its error", async () => {
		const r = makeRig();
		const good = r.mock.addGroup(100, { name: "Good" });
		const bad = r.mock.addGroup(200, { name: "Bad" });
		r.mock.put("item", "MINE0001", { title: "Mine" });
		good.put("item", "GITEM001", { title: "Fine" });
		bad.put("item", "BITEM001", { title: "Never arrives" });
		bad.failWith = 500;
		await connect(r);
		await r.svc.pull();
		expect(titles(r, USER_LIBRARY)).toEqual(["Mine"]);
		expect(titles(r, groupLib(r, 100).id)).toEqual(["Fine"]);
		expect(titles(r, groupLib(r, 200).id)).toEqual([]);
		const st = await r.svc.status();
		expect(st.groups.find((g) => g.groupId === 200)!.lastError).toBeTruthy();
		expect(st.groups.find((g) => g.groupId === 100)!.lastError).toBeUndefined();
		expect(st.lastError).toBeUndefined(); // My Library's own status is not blamed for it
		// once the group works again its error clears and its items arrive
		bad.failWith = null;
		await r.svc.pull();
		expect(titles(r, groupLib(r, 200).id)).toEqual(["Never arrives"]);
		expect((await r.svc.status()).groups.find((g) => g.groupId === 200)!.lastError).toBeUndefined();
	});

	test("a key already used by another library is skipped, never merged into it", async () => {
		const r = makeRig();
		const g = r.mock.addGroup(100, { owner: USER_ID });
		r.mock.put("item", "SAMEKEY1", { title: "My own item" });
		g.put("item", "SAMEKEY1", { title: "A different item in the group" });
		g.put("item", "GITEM001", { title: "Fine" });
		await connect(r);
		await r.svc.pull();
		expect(rows(r, "SELECT title, library_id FROM items WHERE key = 'SAMEKEY1'")).toEqual([
			{ title: "My own item", library_id: USER_LIBRARY },
		]);
		expect(titles(r, groupLib(r, 100).id)).toEqual(["Fine"]);
	});
});

describe("pushing to a group", () => {
	test("edits go to /groups/<id> with that library's version, and My Library's queue is not involved", async () => {
		const r = makeRig();
		const g = r.mock.addGroup(100, { owner: USER_ID });
		g.put("item", "GITEM001", { title: "Original" });
		await connect(r);
		await r.svc.setOptions({ push: true });
		await r.svc.pull();
		const gv = g.version;
		repo.patchItem(r.db, "GITEM001", { title: "Edited by me" });
		r.mock.log.length = 0;
		await r.svc.syncNow();
		const posts = groupPosts(r, 100);
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({ path: "/groups/100/items", ifUnmodified: String(gv), size: 1 });
		expect(userPosts(r)).toHaveLength(0);
		expect(g.item("GITEM001")!.data.title).toBe("Edited by me");
		expect(rows(r, "SELECT count(*) AS n FROM sync_outbox").at(0).n).toBe(0);
		expect((await r.svc.status()).groups[0].pending).toBe(0);
	});

	test("new items and collections created in a group are pushed there", async () => {
		const r = makeRig();
		const g = r.mock.addGroup(100, { owner: USER_ID });
		await connect(r);
		await r.svc.setOptions({ push: true });
		await r.svc.pull();
		const lib = groupLib(r, 100).id;
		const c = repo.createCollection(r.db, "New collection", null, lib);
		const it = repo.createItem(r.db, { itemType: "journalArticle", title: "Created here", collections: [c.key] });
		await r.svc.syncNow();
		expect(g.objects.has(`collection:${c.key}`)).toBe(true);
		expect(g.item(it.data.key)!.data.title).toBe("Created here");
		expect(g.item(it.data.key)!.data.collections).toEqual([c.key]);
		expect(userPosts(r)).toHaveLength(0);
		// and it sticks: a second sync neither re-sends nor loses it
		r.mock.log.length = 0;
		await r.svc.syncNow();
		expect(groupPosts(r, 100)).toHaveLength(0);
		expect(titles(r, lib)).toEqual(["Created here"]);
	});

	test("trash and erase in a group travel as deleted:1 and DELETE /groups/<id>/items", async () => {
		const r = makeRig();
		const g = r.mock.addGroup(100, { owner: USER_ID });
		g.put("item", "GITEM001", { title: "Trash me" });
		g.put("item", "GITEM002", { title: "Erase me" });
		await connect(r);
		await r.svc.setOptions({ push: true });
		await r.svc.pull();
		repo.patchItem(r.db, "GITEM001", { deleted: 1 });
		r.db.run("DELETE FROM items WHERE key = 'GITEM002'");
		r.mock.log.length = 0;
		await r.svc.syncNow();
		expect(g.item("GITEM001")!.data.deleted).toBe(1);
		expect(g.item("GITEM002")).toBeUndefined();
		const del = r.mock.log.find((l) => l.method === "DELETE")!;
		expect(del.path).toBe("/groups/100/items");
		expect(del.query.itemKey).toBe("GITEM002");
	});

	test("a read-only group never pushes: edits are refused, and even a queued change is left alone", async () => {
		const r = makeRig();
		const g = r.mock.addGroup(100, { owner: 7, libraryEditing: "admins" });
		g.put("item", "GITEM001", { title: "Read only" });
		await connect(r);
		await r.svc.setOptions({ push: true });
		await r.svc.pull();
		expect(groupLib(r, 100).editable).toBe(false);
		expect(status(() => repo.patchItem(r.db, "GITEM001", { title: "nope" }))).toBe(403);
		expect(status(() => repo.createItem(r.db, { itemType: "journalArticle", title: "nope" }, groupLib(r, 100).id))).toBe(403);
		// something else (a script, an importer) wrote straight to the table and queued a change
		r.db.run("UPDATE items SET title = 'sneaked in' WHERE key = 'GITEM001'");
		expect(rows(r, "SELECT library_id AS lib FROM sync_outbox").map((x) => x.lib)).toEqual([groupLib(r, 100).id]);
		r.mock.log.length = 0;
		await r.svc.syncNow();
		expect(groupPosts(r, 100)).toHaveLength(0);
		expect(g.item("GITEM001")!.data.title).toBe("Read only");
	});

	test("a key that may not write never pushes to a group, even one the user could edit", async () => {
		const r = makeRig();
		r.mock.groupAccess = { all: { library: true, write: false } };
		const g = r.mock.addGroup(100, { owner: USER_ID });
		g.put("item", "GITEM001", { title: "Original" });
		await connect(r);
		await r.svc.setOptions({ push: true });
		await r.svc.pull();
		expect(groupLib(r, 100).editable).toBe(false);
		expect(status(() => repo.patchItem(r.db, "GITEM001", { title: "nope" }))).toBe(403);
	});

	test("a 412 in a group pulls that group and retries", async () => {
		const r = makeRig();
		const g = r.mock.addGroup(100, { owner: USER_ID });
		g.put("item", "GITEM001", { title: "Original" });
		g.put("item", "GITEM002", { title: "Other" });
		await connect(r);
		await r.svc.setOptions({ push: true });
		await r.svc.pull();
		repo.patchItem(r.db, "GITEM001", { title: "Mine" });
		g.put("item", "GITEM002", { title: "Someone else edited", dateModified: "2026-06-03T00:00:00Z" }); // the group moves on
		r.mock.log.length = 0;
		await r.svc.syncNow();
		expect(g.item("GITEM001")!.data.title).toBe("Mine");
		expect(titles(r, groupLib(r, 100).id)).toEqual(["Mine", "Someone else edited"]);
		expect(rows(r, "SELECT count(*) AS n FROM sync_outbox").at(0).n).toBe(0);
	});

	test("My Library and a group push in the same sync, each to its own place", async () => {
		const r = makeRig();
		const g = r.mock.addGroup(100, { owner: USER_ID });
		r.mock.put("item", "MINE0001", { title: "Mine" });
		g.put("item", "GITEM001", { title: "Theirs" });
		await connect(r);
		await r.svc.setOptions({ push: true });
		await r.svc.pull();
		repo.patchItem(r.db, "MINE0001", { title: "Mine edited" });
		repo.patchItem(r.db, "GITEM001", { title: "Theirs edited" });
		r.mock.log.length = 0;
		await r.svc.syncNow();
		expect(r.mock.item("MINE0001")!.data.title).toBe("Mine edited");
		expect(g.item("GITEM001")!.data.title).toBe("Theirs edited");
		expect(userPosts(r).map((p) => p.size)).toEqual([1]);
		expect(groupPosts(r, 100).map((p) => p.size)).toEqual([1]);
	});
});

describe("files in a group", () => {
	test("download fetches a group's files from /groups/<id>/items/<key>/file into storage", async () => {
		const r = makeRig();
		const g = r.mock.addGroup(100, { owner: USER_ID });
		g.put("item", "GITEM001", { title: "Paper" });
		g.put("item", "GATT0001", {
			itemType: "attachment",
			linkMode: "imported_file",
			contentType: "application/pdf",
			filename: "p.pdf",
			parentItem: "GITEM001",
		});
		g.files.set("GATT0001", new TextEncoder().encode("group pdf bytes"));
		await connect(r);
		await r.svc.setOptions({ files: "download" });
		await r.svc.syncNow();
		await r.svc.fileJobDone;
		const file = join(r.dir, "storage", "GATT0001", "p.pdf");
		expect(existsSync(file)).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("group pdf bytes");
		expect(r.mock.log.some((l) => l.path === "/groups/100/items/GATT0001/file")).toBe(true);
		expect(rows(r, "SELECT count(*) AS n FROM sync_outbox").at(0).n).toBe(0);
	});

	test("files/check can be asked about a group, and says which library it looked at", async () => {
		const r = makeRig();
		const g = r.mock.addGroup(100, { owner: USER_ID });
		g.put("item", "GITEM001", { title: "Paper" });
		g.put("item", "GATT0001", {
			itemType: "attachment",
			linkMode: "imported_file",
			contentType: "application/pdf",
			filename: "p.pdf",
			parentItem: "GITEM001",
		});
		g.files.set("GATT0001", new Uint8Array([1, 2, 3]));
		await connect(r);
		await r.svc.pull();
		const mine = await r.svc.checkFiles();
		expect(mine.imported).toBe(0);
		const theirs = await r.svc.checkFiles(groupLib(r, 100).id);
		expect(theirs).toMatchObject({ imported: 1, missingLocally: 1, onServer: 1 });
	});

	test("upload in a group needs the group to let this user change files", async () => {
		const r = makeRig();
		const g = r.mock.addGroup(100, { owner: 7, members: [USER_ID], libraryEditing: "members", fileEditing: "admins" });
		g.put("item", "GITEM001", { title: "Paper" });
		g.put("item", "GATT0001", {
			itemType: "attachment",
			linkMode: "imported_file",
			contentType: "application/pdf",
			filename: "p.pdf",
			parentItem: "GITEM001",
		});
		await connect(r);
		await r.svc.setOptions({ files: "sync", push: true });
		await r.svc.pull();
		const lib = groupLib(r, 100);
		expect(lib).toMatchObject({ editable: true, filesEditable: false });
		await Bun.write(join(r.dir, "storage", "GATT0001", "p.pdf"), "local bytes");
		r.db.run("UPDATE attachments SET path = ? WHERE item_key = 'GATT0001'", [join(r.dir, "storage", "GATT0001", "p.pdf")]);
		r.mock.log.length = 0;
		await r.svc.syncNow();
		await r.svc.fileJobDone;
		expect(r.mock.log.some((l) => l.method === "POST" && l.path === "/groups/100/items/GATT0001/file")).toBe(false);
	});
});

describe("the HTTP API", () => {
	const get = (r: Rig, path: string) => handleApi(new Request(`http://x${path}`), r.db);

	test("GET /api/libraries lists My Library and the groups with their permissions and queue sizes", async () => {
		const r = makeRig();
		r.mock.addGroup(100, { name: "Lab", owner: USER_ID });
		await connect(r);
		await r.svc.pull();
		const res = await get(r, "/api/libraries");
		const body = (await res!.json()) as { libraries: any[] };
		expect(body.libraries.map((l) => [l.name, l.type, l.editable, l.pending])).toEqual([
			["My Library", "user", true, 0],
			["Lab", "group", true, 0],
		]);
	});

	test("collections, items and tags take ?library=, and a bad id is refused", async () => {
		const r = makeRig();
		const g = r.mock.addGroup(100, { owner: USER_ID });
		g.put("collection", "GCOLL001", { name: "Papers" });
		g.put("item", "GITEM001", { title: "Shared paper", collections: ["GCOLL001"], tags: [{ tag: "shared" }] });
		await connect(r);
		await r.svc.pull();
		const lib = groupLib(r, 100).id;
		const json = async (path: string) => (await (await get(r, path))!.json()) as any;
		expect((await json("/api/collections")).map((c: any) => c.name)).toEqual([]);
		expect((await json(`/api/collections?library=${lib}`)).map((c: any) => c.name)).toEqual(["Papers"]);
		expect((await json("/api/items")).total).toBe(0);
		expect((await json(`/api/items?library=${lib}`)).items.map((i: any) => i.title)).toEqual(["Shared paper"]);
		expect((await json(`/api/tags?library=${lib}`)).map((t: any) => t.tag)).toEqual(["shared"]);
		expect((await get(r, "/api/items?library=abc"))!.status).toBe(400);
		expect((await get(r, "/api/items?library=999"))!.status).toBe(404);
	});

	test("creating into a read-only library answers 403", async () => {
		const r = makeRig();
		r.mock.addGroup(100, { owner: 7, libraryEditing: "admins" });
		await connect(r);
		await r.svc.pull();
		const lib = groupLib(r, 100).id;
		const post = (path: string, body: unknown) =>
			handleApi(
				new Request(`http://x${path}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
				r.db,
			);
		expect((await post("/api/items", { data: { itemType: "journalArticle", title: "x" }, library: lib }))!.status).toBe(403);
		expect((await post("/api/collections", { name: "x", library: lib }))!.status).toBe(403);
	});
});
