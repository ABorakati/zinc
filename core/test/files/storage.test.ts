// Attachment storage location: patterns, targets and the safe move. Temp folders and temp databases only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database as Db } from "bun:sqlite";
import {
	expandPattern,
	isOnlineOnly,
	metaOfItem,
	planMove,
	runMove,
	setAttributeProbe,
	setStorage,
	storageTargetFor,
	storageView,
	validatePattern,
} from "../../src/files/storage";
import { setZoteroProfilesDir, baseDirInfo, setBaseDir } from "../../src/files/paths";
import { buildPush } from "../../src/sync/build";
import { buildFixture, call, insertAttachment, insertItem, type Fixture } from "../fixture";

let fx: Fixture;
let db: Db;
let own: string; // zotero-next's own storage
let dest: string; // custom storage folder

const row = (key: string) =>
	db.query("SELECT link_mode, path FROM attachments WHERE item_key = ?").get(key) as { link_mode: string; path: string };
const itemData = (key: string) =>
	JSON.parse((db.query("SELECT data FROM items WHERE key = ?").get(key) as { data: string }).data) as Record<string, any>;
const outboxKeys = () => (db.query("SELECT DISTINCT key FROM sync_outbox").all() as { key: string }[]).map((r) => r.key);

/** An imported attachment whose file sits in zotero-next's own storage. */
function ownFile(key: string, name: string, content = "pdf-bytes"): string {
	const dir = join(own, key);
	mkdirSync(dir, { recursive: true });
	const p = join(dir, name);
	writeFileSync(p, content);
	db.query("UPDATE attachments SET path = ? WHERE item_key = ?").run(p, key);
	return p;
}
function addLinked(key: string, parent: string, path: string, content = "linked-bytes"): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
	const name = path.split(/[\\/]/).pop()!;
	insertItem(
		db,
		{
			key,
			itemType: "attachment",
			linkMode: "linked_file",
			parentItem: parent,
			title: name,
			contentType: "application/pdf",
			path,
			filename: name,
		} as never,
		parent,
	);
	db.query("INSERT INTO attachments(item_key, link_mode, content_type, path) VALUES(?, 'linked_file', 'application/pdf', ?)").run(
		key,
		path,
	);
}

beforeEach(() => {
	fx = buildFixture();
	db = fx.db;
	own = join(fx.dir, "storage");
	dest = join(fx.dir, "Custom Storage");
	setZoteroProfilesDir(join(fx.dir, "no-zotero-profiles"));
	setAttributeProbe(() => 0);
	db.run("DELETE FROM sync_outbox");
});
afterEach(() => {
	setAttributeProbe();
	setZoteroProfilesDir(undefined);
	db.close(true);
});

describe("patterns", () => {
	test("validation", () => {
		expect(validatePattern("{%a}/{%y}")).toBeNull();
		expect(validatePattern("")).toBeNull();
		expect(validatePattern("{%z}")).toMatch(/unknown placeholder/);
		expect(validatePattern("C:\\abs")).toMatch(/relative/);
		expect(validatePattern("/abs")).toMatch(/relative/);
	});

	test("expansion uses first author, year, sanitises, never escapes", () => {
		const meta = {
			author: "Smith",
			year: "2020",
			title: 'A: "title"/with*bad?chars',
			publication: "J. Med",
			itemType: "journalArticle",
		};
		expect(expandPattern("{%a}/{%y}", meta)).toEqual(["Smith", "2020"]);
		expect(expandPattern("{%F}\\{%a} {%y}", meta)).toEqual(["S", "Smith 2020"]);
		expect(expandPattern("{%t}", meta)).toEqual(["A titlewithbadchars"]);
		expect(expandPattern("../{%a}/..", { ...meta })).toEqual(["Smith"]);
		expect(expandPattern("{%a}/{%y}", { author: "", year: "", title: "", publication: "", itemType: "" })).toEqual([
			"Unknown author",
			"undated",
		]);
		expect(expandPattern("{%a}", { ...meta, author: "con" })).toEqual(["_con"]);
	});

	test("metaOfItem reads the first author from the item", () => {
		expect(metaOfItem(db, "AAAAAAA1")).toMatchObject({ author: "Smith", year: "2020", itemType: "journalArticle" });
		expect(metaOfItem(db, null).author).toBe("");
	});
});

describe("storage target (the hook for new files)", () => {
	test("default: zotero-next's own <KEY>/ layout, imported", () => {
		const t = storageTargetFor(db, { key: "NEWKEY01", name: "x.pdf", parentKey: "AAAAAAA1" });
		expect(t).toMatchObject({ mode: "imported_file", custom: false, dir: join(own, "NEWKEY01"), path: join(own, "NEWKEY01", "x.pdf") });
	});

	test("custom folder with pattern, linked by default, unique names", () => {
		setStorage(db, { dir: dest, subfolder: "{%a}/{%y}" });
		const t = storageTargetFor(db, { key: "NEWKEY01", name: "paper.pdf", parentKey: "AAAAAAA1" });
		expect(t).toMatchObject({
			mode: "linked_file",
			custom: true,
			dir: join(dest, "Smith", "2020"),
			path: join(dest, "Smith", "2020", "paper.pdf"),
		});
		mkdirSync(t.dir, { recursive: true });
		writeFileSync(t.path, "x");
		expect(storageTargetFor(db, { key: "NEWKEY02", name: "paper.pdf", parentKey: "AAAAAAA1" }).path).toBe(
			join(dest, "Smith", "2020", "paper (2).pdf"),
		);
		setStorage(db, { linked: false });
		expect(storageTargetFor(db, { key: "NEWKEY03", name: "q.pdf", parentKey: "AAAAAAA1" }).mode).toBe("imported_file");
		setStorage(db, { dir: null });
		expect(storageView(db).dir).toBeNull();
	});

	test("rejects bad patterns", () => {
		expect(() => setStorage(db, { subfolder: "{%q}" })).toThrow();
		expect(() => setStorage(db, { dir: fx.pdfPath })).toThrow(/file/);
	});
});

describe("online-only detection", () => {
	test("recall and offline attribute bits", () => {
		setAttributeProbe((p) => (p.includes("cloud") ? 0x400000 : p.includes("offline") ? 0x1000 : p.includes("open") ? 0x40000 : 0x20));
		expect(isOnlineOnly("a/cloud.pdf")).toBe(true);
		expect(isOnlineOnly("a/offline.pdf")).toBe(true);
		expect(isOnlineOnly("a/open.pdf")).toBe(true);
		expect(isOnlineOnly("a/local.pdf")).toBe(false);
	});
	test("the real probe does not flag an ordinary temp file", () => {
		setAttributeProbe();
		expect(isOnlineOnly(fx.pdfPath)).toBe(false);
	});
});

describe("move existing attachments", () => {
	beforeEach(() => {
		setStorage(db, { dir: dest, subfolder: "{%a}/{%y}", linked: true });
	});

	test("dry run lists, counts, skips and changes nothing", () => {
		const f = ownFile("ATT00002", "paper.pdf", "0123456789");
		addLinked("LNK00001", "BBBBBBB2", join(fx.dir, "elsewhere", "book.pdf"));
		const plan = planMove(db);
		expect(plan.count).toBe(2);
		expect(plan.totalBytes).toBe(10 + "linked-bytes".length);
		expect(plan.sample.find((s) => s.key === "ATT00002")).toEqual({
			key: "ATT00002",
			from: f,
			to: join(dest, "Smith", "2020", "paper.pdf"),
		});
		expect(plan.sample.find((s) => s.key === "LNK00001")!.to).toBe(join(dest, "Brown", "2018", "book.pdf"));
		const reasons = plan.skipped.map((s) => `${s.key}:${s.reason}`);
		expect(reasons.some((r) => r.startsWith("ATT00001:file is missing") || r.includes("missing"))).toBe(true);
		expect(existsSync(f)).toBe(true);
		expect(existsSync(dest)).toBe(false);
		expect(row("ATT00002").path).toBe(f);
	});

	test("moves an imported file: copy, verify, update rows, delete original; becomes linked", async () => {
		const f = ownFile("ATT00002", "paper.pdf");
		const report = await runMove(db);
		const to = join(dest, "Smith", "2020", "paper.pdf");
		expect(report.moved).toBe(1);
		expect(report.failed).toEqual([]);
		expect(readFileSync(to, "utf8")).toBe("pdf-bytes");
		expect(existsSync(f)).toBe(false);
		expect(existsSync(join(own, "ATT00002"))).toBe(false); // emptied key folder removed
		expect(row("ATT00002")).toEqual({ link_mode: "linked_file", path: to });
		expect(itemData("ATT00002")).toMatchObject({ linkMode: "linked_file", path: to, filename: "paper.pdf" });
		expect(readdirSync(join(dest, "Smith", "2020")).some((n) => n.endsWith(".zn-part"))).toBe(false);
		expect(outboxKeys()).toContain("ATT00002"); // sync will write the new path into Zotero
	});

	test("with 'linked' off an imported file stays imported in the custom folder", async () => {
		setStorage(db, { linked: false });
		ownFile("ATT00002", "paper.pdf");
		await runMove(db);
		expect(row("ATT00002")).toEqual({ link_mode: "imported_file", path: join(dest, "Smith", "2020", "paper.pdf") });
	});

	test("moves a linked file, and a second run finds nothing to do", async () => {
		const from = join(fx.dir, "elsewhere", "book.pdf");
		addLinked("LNK00001", "BBBBBBB2", from);
		expect((await runMove(db)).moved).toBe(1);
		const to = join(dest, "Brown", "2018", "book.pdf");
		expect(row("LNK00001")).toEqual({ link_mode: "linked_file", path: to });
		expect(existsSync(from)).toBe(false);
		const again = planMove(db);
		expect(again.count).toBe(0);
		expect(again.skipped.some((s) => s.key === "LNK00001" && /already/.test(s.reason))).toBe(true);
	});

	test("a path stored relative to the base directory is moved and stored in the form of the base directory", async () => {
		const base = join(fx.dir, "Base");
		setBaseDir(db, "custom", base);
		addLinked("LNK00002", "BBBBBBB2", join(base, "x", "rel.pdf"));
		db.query("UPDATE attachments SET path = 'attachments:x/rel.pdf' WHERE item_key = 'LNK00002'").run();
		expect(planMove(db).sample.find((s) => s.key === "LNK00002")!.from).toBe(join(base, "x/rel.pdf"));
		await runMove(db);
		expect(row("LNK00002").path).toBe(join(dest, "Brown", "2018", "rel.pdf")); // outside the base: absolute
		expect(baseDirInfo(db).effective).toBe(base);
	});

	test("destination inside the base directory is stored relative once relative storing is on", async () => {
		const base = join(fx.dir, "Base2");
		setBaseDir(db, "custom", base);
		setStorage(db, { dir: join(base, "Moved") });
		const { applyConversion } = await import("../../src/files/paths");
		applyConversion(db, "relative"); // turns storeRelative on
		addLinked("LNK00003", "BBBBBBB2", join(fx.dir, "elsewhere", "z.pdf"));
		await runMove(db);
		expect(row("LNK00003").path).toBe("attachments:Moved/Brown/2018/z.pdf");
		expect(itemData("LNK00003").path).toBe(join(base, "Moved", "Brown", "2018", "z.pdf")); // sync gets the absolute path
		const plan = buildPush(db, join(fx.dir, "ZoteroData"));
		expect((plan.writes.find((w) => w.key === "LNK00003")!.data as { path: string }).path).toBe(
			join(base, "Moved", "Brown", "2018", "z.pdf"),
		);
	});

	test("skips Zotero-owned files, missing files and items without a parent", async () => {
		// imported file outside zotero-next's own storage = Zotero's storage
		const zs = join(fx.dir, "ZoteroData", "storage", "ATT00002");
		mkdirSync(zs, { recursive: true });
		writeFileSync(join(zs, "paper.pdf"), "z");
		db.query("UPDATE attachments SET path = ? WHERE item_key = 'ATT00002'").run(join(zs, "paper.pdf"));
		insertAttachment(db, "ATT00009", "BBBBBBB2", "application/pdf", null);
		const plan = planMove(db);
		expect(plan.count).toBe(0);
		expect(plan.skipped.find((s) => s.key === "ATT00002")!.reason).toMatch(/Zotero/);
		const report = await runMove(db, plan);
		expect(report.moved).toBe(0);
		expect(readFileSync(join(zs, "paper.pdf"), "utf8")).toBe("z");
	});

	test("online-only OneDrive placeholders are skipped and reported, not downloaded", async () => {
		const cloud = join(fx.dir, "OneDrive", "cloud.pdf");
		const local = join(fx.dir, "OneDrive", "local.pdf");
		addLinked("LNK00004", "BBBBBBB2", cloud);
		addLinked("LNK00005", "BBBBBBB2", local);
		setAttributeProbe((p) => (p.endsWith("cloud.pdf") ? 0x400000 : 0));
		const plan = planMove(db);
		expect(plan.onlineOnly).toBe(1);
		expect(plan.skipped.find((s) => s.key === "LNK00004")).toMatchObject({ onlineOnly: true });
		const report = await runMove(db, plan);
		expect(report.moved).toBe(1);
		expect(report.onlineOnly).toBe(1);
		expect(existsSync(cloud)).toBe(true);
		expect(row("LNK00004").path).toBe(cloud);
		// it became online-only between the preview and the run: still skipped
		setAttributeProbe(() => 0);
		const plan2 = planMove(db);
		expect(plan2.count).toBe(1);
		setAttributeProbe((p) => (p.endsWith("cloud.pdf") ? 0x40000 : 0));
		expect((await runMove(db, plan2)).onlineOnly).toBeGreaterThanOrEqual(1);
		expect(existsSync(cloud)).toBe(true);
	});

	test("a database failure rolls everything back: original and rows untouched, no stray copy", async () => {
		const f = ownFile("ATT00002", "paper.pdf");
		const before = JSON.stringify(row("ATT00002"));
		const dataBefore = JSON.stringify(itemData("ATT00002"));
		db.run("DELETE FROM sync_outbox"); // setup above queued the item
		const report = await runMove(db, planMove(db), {
			beforeCommit: () => {
				throw new Error("disk on fire");
			},
		});
		expect(report.moved).toBe(0);
		expect(report.failed[0]).toMatchObject({ key: "ATT00002", error: "disk on fire" });
		expect(existsSync(f)).toBe(true);
		expect(JSON.stringify(row("ATT00002"))).toBe(before);
		expect(JSON.stringify(itemData("ATT00002"))).toBe(dataBefore);
		expect(existsSync(join(dest, "Smith", "2020", "paper.pdf"))).toBe(false);
		expect(outboxKeys()).not.toContain("ATT00002");
	});

	test("a failure after the copy keeps the original; the next run completes the move", async () => {
		const f = ownFile("ATT00002", "paper.pdf");
		const to = join(dest, "Smith", "2020", "paper.pdf");
		const r1 = await runMove(db, planMove(db), {
			afterCopy: () => {
				throw new Error("interrupted");
			},
		});
		expect(r1.failed).toHaveLength(1);
		expect(existsSync(f)).toBe(true);
		// simulate a crash that left the finished copy behind (no cleanup ran)
		mkdirSync(join(dest, "Smith", "2020"), { recursive: true });
		writeFileSync(to, "pdf-bytes");
		const plan = planMove(db);
		expect(plan.sample[0].to).toBe(to); // an identical file at the destination is reused, not renamed
		const r2 = await runMove(db, plan);
		expect(r2.moved).toBe(1);
		expect(row("ATT00002").path).toBe(to);
		expect(existsSync(f)).toBe(false);
		expect(readdirSync(join(dest, "Smith", "2020"))).toEqual(["paper.pdf"]);
	});

	test("a different file already at the destination gets a numbered name", async () => {
		ownFile("ATT00002", "paper.pdf", "mine");
		mkdirSync(join(dest, "Smith", "2020"), { recursive: true });
		writeFileSync(join(dest, "Smith", "2020", "paper.pdf"), "someone else's");
		const report = await runMove(db);
		expect(report.moved).toBe(1);
		expect(readFileSync(join(dest, "Smith", "2020", "paper.pdf"), "utf8")).toBe("someone else's");
		expect(row("ATT00002").path).toBe(join(dest, "Smith", "2020", "paper (2).pdf"));
		expect(readFileSync(row("ATT00002").path, "utf8")).toBe("mine");
	});

	test("two files with the same name for the same folder do not collide", async () => {
		ownFile("ATT00002", "p.pdf", "one");
		insertAttachment(db, "ATT00004", "AAAAAAA1", "application/pdf", null);
		ownFile("ATT00004", "p.pdf", "two");
		const report = await runMove(db);
		expect(report.moved).toBe(2);
		expect(readdirSync(join(dest, "Smith", "2020")).sort()).toEqual(["p (2).pdf", "p.pdf"]);
	});
});

describe("/api/files storage", () => {
	const json = async (r: Response) => (await r.json()) as any;

	test("configure, preview, confirm", async () => {
		const bad = await call(db, "PUT", "/api/files/storage", { subfolder: "{%nope}" });
		expect(bad.status).toBe(400);
		const v = await json(await call(db, "PUT", "/api/files/storage", { dir: dest, subfolder: "{%a}", linked: true }));
		expect(v.storage).toMatchObject({ dir: dest, subfolder: "{%a}", linked: true });
		const f = ownFile("ATT00002", "paper.pdf");
		const prev = await json(await call(db, "POST", "/api/files/storage/move", {}));
		expect(prev).toMatchObject({ count: 1, onlineOnly: 0 });
		expect(prev.sample[0].to).toBe(join(dest, "Smith", "paper.pdf"));
		expect(existsSync(f)).toBe(true); // a preview moves nothing
		const done = await json(await call(db, "POST", "/api/files/storage/move", { confirm: true }));
		expect(done.moved).toBe(1);
		expect(existsSync(f)).toBe(false);
		const served = await call(db, "GET", "/api/attachments/ATT00002/file");
		expect(served.status).toBe(200);
		expect(await served.text()).toBe("pdf-bytes");
	});

	test("move without a storage folder is a 400", async () => {
		expect((await call(db, "POST", "/api/files/storage/move", {})).status).toBe(400);
	});
});
