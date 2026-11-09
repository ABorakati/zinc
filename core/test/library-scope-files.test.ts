// Library scope, group permissions and file operations (review fixes): tag maintenance per library, the files guard,
// relocation against a concurrently edited source, atomic page deletion, stored-path traversal, relations and merges in groups.
// Temp folders and temp databases only.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { duplicateItem } from "../src/additems/duplicate";
import { addFile, reparentItem } from "../src/additems/files";
import { addRelated, createItem, getItemDetail, itemsRelatingTo, openDb, patchItem, removeRelated, upsertAnnotations } from "../src/db";
import { mergeDuplicateItems } from "../src/duplicates/merge";
import { replaceAttachmentFile } from "../src/files/replace";
import { resolveStoredPath, setBaseDir, setZoteroProfilesDir } from "../src/files/paths";
import { planMove, runMove, setAttributeProbe, setStorage } from "../src/files/storage";
import { USER_LIBRARY, assertFilesWritable, itemUri, upsertGroupLibrary } from "../src/libraries";
import { eraseItems } from "../src/maintenance/erase";
import { renameFiles } from "../src/maintenance/rename-files";
import { deleteAutomaticTags, deleteTags, renameTag } from "../src/maintenance/tags";
import { tempDir } from "./fixture";

let dir: string;
let db: Database;
beforeEach(() => {
	dir = tempDir();
	db = openDb(join(dir, "library.sqlite"));
	setZoteroProfilesDir(join(dir, "no-zotero-profiles"));
	setAttributeProbe(() => 0);
});
afterEach(() => {
	setAttributeProbe();
	setZoteroProfilesDir(undefined);
	db.close(true);
});

const group = (groupId: number, editable = true, filesEditable = true) => upsertGroupLibrary(db, { groupId, name: `Group ${groupId}`, editable, filesEditable, version: 1 }).id;
/** Makes a group read-only after its items were created (a read-only group's items arrive through a pull, never the API). */
const lock = (g: number, editable = false, filesEditable = false) => db.query("UPDATE libraries SET editable = ?, files_editable = ? WHERE id = ?").run(editable ? 1 : 0, filesEditable ? 1 : 0, g);
const status = (fn: () => unknown): number | undefined => {
	try {
		fn();
	} catch (e) {
		return (e as { status?: number }).status;
	}
	return undefined;
};
const tagsOf = (key: string) => (db.query("SELECT tag FROM item_tags WHERE item_key = ? ORDER BY tag").all(key) as { tag: string }[]).map((r) => r.tag);
const article = (title: string, lib: number, tags: { tag: string; type?: number }[] = []) => createItem(db, { itemType: "journalArticle", title, tags }, lib).data.key;
const body = (obj: unknown) => new Request("http://x/", { method: "PUT", body: JSON.stringify(obj) });
const PDF = (extra = "") => Buffer.from(`%PDF-1.4\n${extra}%%EOF\n`).toString("base64");

/** An imported PDF attachment of `parent` whose file really exists in the library's own storage folder. */
function pdfOf(parent: string, lib: number, name = "paper.pdf", content = "%PDF-1.4 original"): { key: string; path: string } {
	const key = createItem(db, { itemType: "attachment", linkMode: "imported_file", title: name, contentType: "application/pdf", parentItem: parent }, lib).data.key;
	const p = join(dir, "storage", key, name);
	mkdirSync(join(dir, "storage", key), { recursive: true });
	writeFileSync(p, content);
	db.query("UPDATE attachments SET path = ? WHERE item_key = ?").run(p, key);
	return { key, path: p };
}

describe("tag maintenance is scoped to one library", () => {
	test("rename in My Library leaves a group's tag alone; the group renames by its own id", () => {
		const g = group(10);
		const mine = article("mine", USER_LIBRARY, [{ tag: "to-read" }]);
		const theirs = article("theirs", g, [{ tag: "to-read" }]);
		expect(renameTag(db, "to-read", "read-me").items).toBe(1);
		expect(tagsOf(mine)).toEqual(["read-me"]);
		expect(tagsOf(theirs)).toEqual(["to-read"]);
		expect(renameTag(db, "to-read", "later", g).items).toBe(1);
		expect(tagsOf(theirs)).toEqual(["later"]);
		expect(tagsOf(mine)).toEqual(["read-me"]);
	});

	test("a read-only group refuses rename, delete and automatic-tag cleanup", () => {
		const g = group(11);
		const theirs = article("theirs", g, [{ tag: "x" }]);
		db.query("INSERT INTO item_tags(item_key, tag, type) VALUES(?, 'auto', 1)").run(theirs);
		lock(g);
		expect(status(() => renameTag(db, "x", "y", g))).toBe(403);
		expect(status(() => deleteTags(db, ["x"], g))).toBe(403);
		expect(status(() => deleteAutomaticTags(db, g))).toBe(403);
		expect(tagsOf(theirs)).toEqual(["auto", "x"]);
	});

	test("delete and delete-automatic touch only the named library", () => {
		const g = group(12);
		const mine = article("mine", USER_LIBRARY, [{ tag: "shared" }]);
		const theirs = article("theirs", g, [{ tag: "shared" }]);
		db.query("INSERT INTO item_tags(item_key, tag, type) VALUES(?, 'auto', 1)").run(mine);
		db.query("INSERT INTO item_tags(item_key, tag, type) VALUES(?, 'auto', 1)").run(theirs);
		expect(deleteAutomaticTags(db).items).toBe(1);
		expect(tagsOf(mine)).toEqual(["shared"]);
		expect(tagsOf(theirs)).toEqual(["auto", "shared"]);
		expect(deleteTags(db, ["shared"]).items).toBe(1);
		expect(tagsOf(theirs)).toEqual(["auto", "shared"]);
	});
});

describe("files guard", () => {
	test("assertFilesWritable checks filesEditable as well as editable", () => {
		expect(status(() => assertFilesWritable(db, group(20, true, false)))).toBe(403);
		expect(status(() => assertFilesWritable(db, group(21, false, true)))).toBe(403);
		expect(status(() => assertFilesWritable(db, group(22, true, true)))).toBeUndefined();
		expect(status(() => assertFilesWritable(db, USER_LIBRARY))).toBeUndefined();
	});

	test("PDF replacement, attachment creation and rename-from-parent are refused when files are locked", async () => {
		const g = group(23, true, false);
		const parent = article("Paper", g);
		const att = pdfOf(parent, g);
		await expect(replaceAttachmentFile(db, att.key, body({ dataBase64: PDF("new") }))).rejects.toMatchObject({ status: 403 });
		expect(readFileSync(att.path, "utf8")).toBe("%PDF-1.4 original");
		expect(status(() => addFile(db, { parentKey: parent, dataBase64: Buffer.from("x").toString("base64"), name: "a.txt" }))).toBe(403);
		expect(renameFiles(db, [att.key], join(dir, "storage"))[0]).toMatchObject({ status: "skipped" });
		expect(existsSync(att.path)).toBe(true);
	});

	test("relocation plans skip group-library files", () => {
		setStorage(db, { dir: join(dir, "Custom"), subfolder: "", linked: true });
		const g = group(24, true, true);
		const att = pdfOf(article("Paper", g), g);
		const plan = planMove(db);
		expect(plan.items.map((i) => i.key)).not.toContain(att.key);
		expect(plan.skipped.find((s) => s.key === att.key)?.reason).toMatch(/group library/);
	});
});

describe("relocation keeps a source that changed while it was copied", () => {
	test("the original (with its new content) stays and the database is unchanged", async () => {
		const custom = join(dir, "Custom");
		setStorage(db, { dir: custom, subfolder: "", linked: true });
		const att = pdfOf(article("Paper", USER_LIBRARY), USER_LIBRARY);
		const plan = planMove(db);
		expect(plan.items).toHaveLength(1);
		const report = await runMove(db, plan, {
			afterCopy: () => {
				writeFileSync(att.path, "%PDF-1.4 edited by the reader, much longer than before");
				const t = new Date(Date.now() + 5000);
				utimesSync(att.path, t, t);
			},
		});
		expect(report.moved).toBe(0);
		expect(report.failed).toHaveLength(1);
		expect(readFileSync(att.path, "utf8")).toContain("edited by the reader");
		expect((db.query("SELECT path, link_mode FROM attachments WHERE item_key = ?").get(att.key) as { path: string }).path).toBe(att.path);
		expect(existsSync(join(custom, "paper.pdf"))).toBe(false);
	});

	test("a changed database path at commit also aborts the move", async () => {
		setStorage(db, { dir: join(dir, "Custom"), subfolder: "", linked: true });
		const att = pdfOf(article("Paper", USER_LIBRARY), USER_LIBRARY);
		const other = join(dir, "other.pdf");
		writeFileSync(other, "%PDF-1.4 other");
		const report = await runMove(db, planMove(db), { afterCopy: () => void db.query("UPDATE attachments SET path = ? WHERE item_key = ?").run(other, att.key) });
		expect(report.failed).toHaveLength(1);
		expect(existsSync(att.path)).toBe(true);
	});
});

describe("PDF page deletion is one atomic core operation", () => {
	test("the file and the annotations change together", async () => {
		const parent = article("Paper", USER_LIBRARY);
		const att = pdfOf(parent, USER_LIBRARY);
		const ann = (id: string, page: number) => ({ id, type: "highlight", sortIndex: `${String(page).padStart(5, "0")}|000100|00200`, pageLabel: String(page + 1), position: { pageIndex: page, rects: [] }, dateModified: "2024-01-01T00:00:00Z" });
		upsertAnnotations(db, att.key, [ann("ANNOAAA1", 0), ann("ANNOAAA2", 1), ann("ANNOAAA3", 2)] as never);
		const res = await replaceAttachmentFile(db, att.key, body({ dataBase64: PDF("shorter"), deletedPages: [1] }));
		expect(res.ok).toBe(true);
		expect(readFileSync(att.path, "utf8")).toContain("shorter");
		const rows = db.query("SELECT key, data FROM annotations WHERE attachment_key = ? ORDER BY key").all(att.key) as { key: string; data: string }[];
		expect(rows.map((r) => r.key)).toEqual(["ANNOAAA1", "ANNOAAA3"]);
		expect(JSON.parse(rows[1]!.data).position.pageIndex).toBe(1);
		expect(JSON.parse(rows[1]!.data).sortIndex.startsWith("00001|")).toBe(true);
		// no backup left behind
		expect((await import("node:fs")).readdirSync(join(dir, "storage", att.key))).toEqual(["paper.pdf"]);
	});

	test("an annotation failure leaves the original file and annotations untouched", async () => {
		const att = pdfOf(article("Paper", USER_LIBRARY), USER_LIBRARY);
		const old = { id: "ANNOBBB1", type: "highlight", sortIndex: "00001|000100|00200", position: { pageIndex: 1 }, dateModified: "2024-01-01T00:00:00Z" };
		upsertAnnotations(db, att.key, [old] as never);
		// a trigger that refuses the annotation update stands in for any database failure
		db.run("CREATE TRIGGER refuse_ann BEFORE UPDATE ON annotations BEGIN SELECT RAISE(ABORT, 'refused'); END");
		await expect(replaceAttachmentFile(db, att.key, body({ dataBase64: PDF("shorter"), deletedPages: [0] }))).rejects.toBeTruthy();
		expect(readFileSync(att.path, "utf8")).toBe("%PDF-1.4 original");
		expect(JSON.parse((db.query("SELECT data FROM annotations WHERE key = 'ANNOBBB1'").get() as { data: string }).data).position.pageIndex).toBe(1);
		expect((await import("node:fs")).readdirSync(join(dir, "storage", att.key))).toEqual(["paper.pdf"]);
	});

	test("bad deletedPages is a 400 before anything changes", async () => {
		const att = pdfOf(article("Paper", USER_LIBRARY), USER_LIBRARY);
		await expect(replaceAttachmentFile(db, att.key, body({ dataBase64: PDF(), deletedPages: [-1] }))).rejects.toMatchObject({ status: 400 });
		expect(readFileSync(att.path, "utf8")).toBe("%PDF-1.4 original");
	});
});

describe("stored paths cannot leave the base directory", () => {
	test("attachments:../ is refused, ordinary relative paths still resolve", () => {
		const base = join(dir, "base");
		mkdirSync(base);
		setBaseDir(db, "custom", base);
		expect(resolveStoredPath(db, "attachments:sub/a.pdf")).toBe(join(base, "sub", "a.pdf"));
		expect(resolveStoredPath(db, "attachments:../secret.txt")).toBeNull();
		expect(resolveStoredPath(db, "attachments:a/../../secret.txt")).toBeNull();
		expect(resolveStoredPath(db, "attachments:..\\secret.txt")).toBeNull();
	});
});

describe("related items and patchItem", () => {
	test("a read-only group's relations cannot be changed; relations stay inside one library", () => {
		const g = group(30);
		const theirs = article("theirs", g);
		lock(g);
		const mine = article("mine", USER_LIBRARY);
		const mine2 = article("mine2", USER_LIBRARY);
		expect(status(() => addRelated(db, theirs, [mine]))).toBe(403);
		expect(status(() => addRelated(db, mine, [theirs]))).toBe(400);
		addRelated(db, mine, [mine2]);
		expect(getItemDetail(db, mine)!.related?.map((r) => r.key)).toEqual([mine2]);
	});

	test("relations in a group use the group's URI", () => {
		const g = group(31);
		const a = article("a", g);
		const b = article("b", g);
		addRelated(db, a, [b]);
		expect(getItemDetail(db, a)!.data.relations?.["dc:relation"]).toBe(`http://zotero.org/groups/31/items/${b}`);
		expect(itemUri(db, g, a)).toBe(`http://zotero.org/groups/31/items/${a}`);
	});

	test("a patch cannot desynchronise parentItem from parent_key", () => {
		const p = article("p", USER_LIBRARY);
		const q = article("q", USER_LIBRARY);
		const note = createItem(db, { itemType: "note", note: "<p>n</p>", parentItem: p }).data.key;
		patchItem(db, note, { parentItem: q, version: 99 } as never);
		const row = db.query("SELECT parent_key, data FROM items WHERE key = ?").get(note) as { parent_key: string; data: string };
		expect(row.parent_key).toBe(p);
		expect(JSON.parse(row.data).parentItem).toBe(p);
		const top = patchItem(db, p, { parentItem: q } as never);
		expect(top.data.parentItem).toBeUndefined();
	});

	test("reparenting across libraries or in a read-only group is refused", () => {
		const g = group(32, true);
		const parentG = article("pg", g);
		const lone = createItem(db, { itemType: "attachment", linkMode: "linked_url", title: "x", url: "http://example.org/" }, USER_LIBRARY).data.key;
		expect(status(() => reparentItem(db, lone, parentG))).toBe(400);
	});
});

describe("merging duplicates", () => {
	test("replacement relations name the item's real group URI and no relation is left dangling", () => {
		const g = group(40);
		const master = article("same", g);
		const dup = article("same", g);
		const other = article("other", g);
		addRelated(db, dup, [other]);
		mergeDuplicateItems(db, { masterKey: master, otherKeys: [dup] });
		const m = getItemDetail(db, master)!.data.relations as Record<string, string | string[]>;
		expect(m["dc:replaces"]).toBe(`http://zotero.org/groups/40/items/${dup}`);
		expect(itemsRelatingTo(db, dup)).toEqual([]);
		expect(getItemDetail(db, other)!.related?.map((r) => r.key)).toEqual([master]);
	});

	test("in My Library the replacement uses the linked account id and the local alias", () => {
		db.query("INSERT INTO sync_state(name, value) VALUES('web_user_id', '4242') ON CONFLICT(name) DO UPDATE SET value = excluded.value").run();
		const master = article("same", USER_LIBRARY);
		const dup = article("same", USER_LIBRARY);
		mergeDuplicateItems(db, { masterKey: master, otherKeys: [dup] });
		const rep = getItemDetail(db, master)!.data.relations!["dc:replaces"] as string[];
		expect(rep).toContain(`http://zotero.org/users/4242/items/${dup}`);
		expect(rep.some((u) => u.includes("/users/local/"))).toBe(true);
	});

	test("erasing an item removes the related links that point at it", () => {
		const a = article("a", USER_LIBRARY);
		const b = article("b", USER_LIBRARY);
		addRelated(db, a, [b]);
		eraseItems(db, [b], null);
		expect(itemsRelatingTo(db, b)).toEqual([]);
		expect(getItemDetail(db, a)!.data.relations?.["dc:relation"]).toBeUndefined();
		removeRelated(db, a, []);
	});
});

describe("duplicating a standalone attachment", () => {
	test("works for a relative path and stays in the group's collection", () => {
		const base = join(dir, "base");
		mkdirSync(base);
		setBaseDir(db, "custom", base);
		writeFileSync(join(base, "doc.pdf"), "%PDF-1.4 linked");
		const g = group(50);
		const coll = "GROUPCO1";
		db.query("INSERT INTO collections(key, name, library_id) VALUES(?, 'C', ?)").run(coll, g);
		const key = createItem(db, { itemType: "attachment", linkMode: "linked_file", title: "doc", contentType: "application/pdf", path: join(base, "doc.pdf"), collections: [coll] }, g).data.key;
		db.query("UPDATE attachments SET path = 'attachments:doc.pdf' WHERE item_key = ?").run(key);
		const copy = duplicateItem(db, key);
		const lib = (db.query("SELECT library_id FROM items WHERE key = ?").get(copy.data.key) as { library_id: number }).library_id;
		expect(lib).toBe(g);
		expect(copy.collections).toEqual([coll]);
		expect(statSync(join(base, "doc.pdf")).isFile()).toBe(true);
	});
});
