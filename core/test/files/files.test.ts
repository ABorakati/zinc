// Linked-attachment base directory, Zotero discovery and the /api/files routes. Temp folders and temp databases only.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database as Db } from "bun:sqlite";
import { getAttachment } from "../../src/db";
import { configFileFor, configuredZoteroDataDir, readConfig } from "../../src/files/config";
import {
	applyConversion,
	baseDirInfo,
	planConversion,
	relativeUnder,
	resolveStoredPath,
	setBaseDir,
	setZoteroProfilesDir,
	storedFormForNewLink,
	toStoredPath,
} from "../../src/files/paths";
import { inspectDataDir, locateZotero } from "../../src/files/zotero-locate";
import { setFolderPicker, setRevealer } from "../../src/files/api";
import { applyChanges } from "../../src/sync/apply";
import { buildPush } from "../../src/sync/build";
import { listZoteroProfiles, parsePref, toRelativeAttachmentPath } from "../../src/zotero-db/env";
import { buildFixture, call, insertItem, type Fixture } from "../fixture";

let fx: Fixture;
let db: Db;
let base: string; // the base directory
let profiles: string; // fake %APPDATA%\Zotero\Zotero\Profiles

function writePrefs(profilesDir: string, name: string, lines: string[]): void {
	mkdirSync(join(profilesDir, name), { recursive: true });
	writeFileSync(join(profilesDir, name, "prefs.js"), lines.join("\n") + "\n");
}
const esc = (p: string) => p.replaceAll("\\", "\\\\"); // prefs.js writes backslashes doubled

function addLinked(key: string, path: string): void {
	const name = path.split(/[\\/]/).pop()!;
	insertItem(
		db,
		{
			key,
			itemType: "attachment",
			linkMode: "linked_file",
			parentItem: "AAAAAAA1",
			title: name,
			contentType: "application/pdf",
			path,
			filename: name,
		} as never,
		"AAAAAAA1",
	);
	db.query("INSERT INTO attachments(item_key, link_mode, content_type, path) VALUES(?, 'linked_file', 'application/pdf', ?)").run(
		key,
		path,
	);
}
const rawPath = (key: string) => (db.query("SELECT path FROM attachments WHERE item_key = ?").get(key) as { path: string }).path;

beforeEach(() => {
	fx = buildFixture();
	db = fx.db;
	base = join(fx.dir, "Library Base");
	mkdirSync(join(base, "Smith"), { recursive: true });
	profiles = join(fx.dir, "profiles");
	writePrefs(profiles, "abc.default", [
		`user_pref("extensions.zotero.baseAttachmentPath", "${esc(base)}");`,
		`user_pref("extensions.zotero.dataDir", "${esc(join(fx.dir, "ZoteroData"))}");`,
		`user_pref("extensions.zotero.useDataDir", true);`,
		`user_pref("extensions.zotero.saveRelativeAttachmentPath", true);`,
	]);
	setZoteroProfilesDir(profiles);
	db.run("DELETE FROM sync_outbox");
});
afterEach(() => {
	setZoteroProfilesDir(undefined);
	setFolderPicker(null);
	setRevealer();
	db.close(true);
});

describe("prefs.js", () => {
	test("parsePref reads strings with doubled backslashes, booleans and numbers", () => {
		const t = `user_pref("a.b", "C:\\\\Users\\\\x");\nuser_pref("c", true);\nuser_pref("d", 12);\nuser_pref("e", "q\\"uote");`;
		expect(parsePref(t, "a.b")).toBe("C:\\Users\\x");
		expect(parsePref(t, "c")).toBe(true);
		expect(parsePref(t, "d")).toBe(12);
		expect(parsePref(t, "e")).toBe('q"uote');
		expect(parsePref(t, "missing")).toBeNull();
	});

	test("listZoteroProfiles", () => {
		const [p] = listZoteroProfiles(profiles);
		expect(p.name).toBe("abc.default");
		expect(p.baseAttachmentPath).toBe(base);
		expect(p.useDataDir).toBe(true);
		expect(p.saveRelativeAttachmentPath).toBe(true);
	});
});

describe("locateZotero / inspectDataDir", () => {
	function makeZoteroDb(dir: string): void {
		mkdirSync(join(dir, "storage"), { recursive: true });
		const z = new Database(join(dir, "zotero.sqlite"), { create: true });
		z.exec(`CREATE TABLE itemTypes(itemTypeID INTEGER PRIMARY KEY, typeName TEXT);
			CREATE TABLE items(itemID INTEGER PRIMARY KEY, itemTypeID INT, clientDateModified TEXT);
			CREATE TABLE deletedItems(itemID INTEGER PRIMARY KEY);
			CREATE TABLE itemAttachments(itemID INTEGER PRIMARY KEY);
			CREATE TABLE collections(collectionID INTEGER PRIMARY KEY);
			CREATE TABLE deletedCollections(collectionID INTEGER PRIMARY KEY);
			INSERT INTO itemTypes VALUES (1,'journalArticle'),(2,'attachment'),(3,'note');
			INSERT INTO items VALUES (1,1,'2026-01-02 03:04:05'),(2,1,'2026-02-03 04:05:06'),(3,1,'2025-01-01 00:00:00'),(4,2,'2026-03-01 00:00:00'),(5,3,'2026-01-01 00:00:00');
			INSERT INTO deletedItems VALUES (3);
			INSERT INTO itemAttachments VALUES (4);
			INSERT INTO collections VALUES (1),(2);`);
		z.close();
	}

	test("counts regular, non-trashed items read-only", () => {
		const dir = join(fx.dir, "ZoteroData");
		makeZoteroDb(dir);
		const info = inspectDataDir(dir);
		expect(info).toMatchObject({
			hasDatabase: true,
			readable: true,
			itemCount: 2,
			collectionCount: 2,
			attachmentCount: 1,
			hasStorageFolder: true,
		});
		expect(info.lastModified).toBe("2026-03-01T00:00:00Z");
		expect(info.sizeBytes).toBeGreaterThan(0);
	});

	test("an empty folder and a corrupt database are reported, not thrown", () => {
		expect(inspectDataDir(join(fx.dir, "nowhere")).hasDatabase).toBe(false);
		const dir = join(fx.dir, "bad");
		mkdirSync(dir);
		writeFileSync(join(dir, "zotero.sqlite"), "this is not a database");
		const info = inspectDataDir(dir);
		expect(info.hasDatabase).toBe(true);
		expect(info.readable).toBe(false);
		expect(info.error).toBeTruthy();
	});

	test("locate finds the profile's data folder, base path and running state", async () => {
		const dir = join(fx.dir, "ZoteroData");
		makeZoteroDb(dir);
		const home = join(fx.dir, "home");
		makeZoteroDb(join(home, "Zotero")); // the default location also has one
		const r = await locateZotero({ profilesDir: profiles, home, env: {}, isRunning: async () => true, exeCandidates: [] });
		expect(r.running).toBe(true);
		expect(r.baseAttachmentPath).toBe(base);
		expect(r.recommended).toBe(dir);
		expect(r.candidates.map((c) => c.source)).toEqual(["profile", "default"]);
		expect(r.candidates[0].profile).toBe("abc.default");
		expect(r.installedExe).toBeNull();
	});

	test("locate falls back to ~/Zotero without any profile", async () => {
		const home = join(fx.dir, "home2");
		makeZoteroDb(join(home, "Zotero"));
		const r = await locateZotero({
			profilesDir: join(fx.dir, "no-profiles"),
			home,
			env: {},
			isRunning: async () => false,
			exeCandidates: [],
		});
		expect(r.profiles).toEqual([]);
		expect(r.recommended).toBe(join(home, "Zotero"));
	});
});

describe("base directory and stored paths", () => {
	test("modes: follows Zotero's pref, custom, none", () => {
		expect(baseDirInfo(db)).toMatchObject({ mode: "zotero", effective: base, zotero: base });
		const other = join(fx.dir, "Other");
		setBaseDir(db, "custom", other);
		expect(baseDirInfo(db)).toMatchObject({ mode: "custom", effective: other });
		setBaseDir(db, "none");
		expect(baseDirInfo(db)).toMatchObject({ mode: "none", effective: null });
		setBaseDir(db, "zotero");
		expect(baseDirInfo(db).mode).toBe("zotero");
		expect(JSON.parse(readFileSync(configFileFor(join(fx.dir, "lib.sqlite")), "utf8")).baseDir).toBeUndefined();
	});

	test("relativeUnder is case-insensitive on Windows, slash-agnostic and does not match siblings", () => {
		expect(relativeUnder(join(base, "Smith", "a.pdf"), base)).toBe("Smith/a.pdf");
		expect(relativeUnder(`${base}-other/a.pdf`, base)).toBeNull();
		expect(relativeUnder(base, base)).toBeNull();
		if (process.platform === "win32") expect(relativeUnder(join(base, "x.pdf").toUpperCase(), base.toLowerCase())).toBe("X.PDF");
	});

	test("resolveStoredPath and toStoredPath round-trip", () => {
		const abs = join(base, "Smith", "a.pdf");
		const stored = toStoredPath(db, abs);
		expect(stored).toBe("attachments:Smith/a.pdf");
		expect(resolveStoredPath(db, stored)).toBe(join(base, "Smith/a.pdf"));
		expect(resolveStoredPath(db, "C:\\elsewhere\\b.pdf")).toBe("C:\\elsewhere\\b.pdf");
		expect(toStoredPath(db, "C:\\elsewhere\\b.pdf")).toBe("C:\\elsewhere\\b.pdf");
		expect(resolveStoredPath(db, null)).toBeNull();
		setBaseDir(db, "none");
		expect(resolveStoredPath(db, stored)).toBeNull();
	});

	test("preview counts, apply converts both ways without queueing sync work", () => {
		writeFileSync(join(base, "Smith", "a.pdf"), "x");
		addLinked("LNK00001", join(base, "Smith", "a.pdf"));
		addLinked("LNK00002", join(fx.dir, "outside.pdf"));
		db.run("DELETE FROM sync_outbox");

		const pre = planConversion(db, "relative");
		expect(pre.count).toBe(1);
		expect(pre.outside).toBe(1);
		expect(pre.sample[0]).toMatchObject({ key: "LNK00001", to: "attachments:Smith/a.pdf" });
		expect(rawPath("LNK00001")).toBe(join(base, "Smith", "a.pdf")); // a preview changes nothing

		expect(applyConversion(db, "relative").converted).toBe(1);
		expect(rawPath("LNK00001")).toBe("attachments:Smith/a.pdf");
		expect(rawPath("LNK00002")).toBe(join(fx.dir, "outside.pdf"));
		expect(db.query("SELECT count(*) AS n FROM sync_outbox").get()).toEqual({ n: 0 });
		expect(readConfig(db).storeRelative).toBe(true);

		// every reader sees the absolute path
		expect(getAttachment(db, "LNK00001")!.path).toBe(join(base, "Smith/a.pdf"));

		expect(applyConversion(db, "absolute").converted).toBe(1);
		expect(rawPath("LNK00001")).toBe(join(base, "Smith/a.pdf"));
		expect(readConfig(db).storeRelative).toBe(false);
		expect(applyConversion(db, "absolute").converted).toBe(0);
	});

	test("converting back to absolute refuses when no base directory is set", () => {
		addLinked("LNK00003", join(base, "Smith", "b.pdf"));
		applyConversion(db, "relative");
		setBaseDir(db, "none");
		expect(() => applyConversion(db, "absolute")).toThrow(/base directory/);
		expect(rawPath("LNK00003")).toBe("attachments:Smith/b.pdf"); // nothing lost
	});

	test("survives a move: pointing the base directory at the new place makes the files resolve again", () => {
		writeFileSync(join(base, "Smith", "c.pdf"), "pdf");
		addLinked("LNK00004", join(base, "Smith", "c.pdf"));
		applyConversion(db, "relative");
		const moved = join(fx.dir, "Moved Library");
		mkdirSync(join(moved, "Smith"), { recursive: true });
		writeFileSync(join(moved, "Smith", "c.pdf"), "pdf");
		setBaseDir(db, "custom", moved);
		expect(getAttachment(db, "LNK00004")!.path).toBe(join(moved, "Smith/c.pdf"));
	});

	test("an attachment file is served through the resolver", async () => {
		writeFileSync(join(base, "Smith", "d.pdf"), "hello-pdf");
		addLinked("LNK00005", join(base, "Smith", "d.pdf"));
		applyConversion(db, "relative");
		const res = await call(db, "GET", "/api/attachments/LNK00005/file");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("hello-pdf");
		const detail = (await (await call(db, "GET", "/api/items/AAAAAAA1")).json()) as { children: { key: string; hasFile: boolean }[] };
		expect(detail.children.find((c) => c.key === "LNK00005")!.hasFile).toBe(true);
	});
});

describe("sync keeps Zotero's path forms", () => {
	test("pushing a relative-stored linked file hands Zotero the absolute path, which its writer relativises against Zotero's base", () => {
		const abs = join(base, "Smith", "e.pdf");
		addLinked("LNK00006", abs);
		applyConversion(db, "relative");
		db.query("UPDATE items SET title = 'edited' WHERE key = 'LNK00006'").run(); // queue it
		const plan = buildPush(db, join(fx.dir, "ZoteroData"));
		const w = plan.writes.find((x) => x.key === "LNK00006")!;
		const path = (w.data as { path: string }).path;
		expect(path).toBe(abs);
		// what ZoteroDbWriter stores in itemAttachments.path with Zotero's base directory
		expect(toRelativeAttachmentPath(path, base)).toBe("attachments:Smith/e.pdf");
		// ...and without a base directory in Zotero it stays absolute
		expect(toRelativeAttachmentPath(path, null)).toBe(abs);
	});

	test("incoming linked files are stored relative only after the user converted", () => {
		const abs = join(base, "Smith", "f.pdf");
		const changes = (key: string) => ({
			upserts: [
				{
					type: "item" as const,
					key,
					dateModified: "2026-01-01T00:00:00Z",
					data: {
						key,
						itemType: "attachment",
						linkMode: "linked_file",
						parentItem: "AAAAAAA1",
						title: "f",
						contentType: "application/pdf",
						path: abs,
						version: 5,
						dateAdded: "2026-01-01T00:00:00Z",
						dateModified: "2026-01-01T00:00:00Z",
						tags: [],
					},
				},
			],
			deletes: [],
		});
		applyChanges(db, changes("INC00001"), fx.dir);
		expect(rawPath("INC00001")).toBe(abs);
		expect(storedFormForNewLink(db, abs)).toBe(abs);
		applyConversion(db, "relative");
		applyChanges(db, changes("INC00002"), fx.dir);
		expect(rawPath("INC00002")).toBe("attachments:Smith/f.pdf");
		// the item JSON (what sync_base/outbox compare) still carries the absolute path
		const data = JSON.parse((db.query("SELECT data FROM items WHERE key = 'INC00002'").get() as { data: string }).data);
		expect(data.path).toBe(abs);
	});

	test("configuredZoteroDataDir: env wins, then the saved folder", () => {
		const dbFile = join(fx.dir, "lib.sqlite");
		expect(configuredZoteroDataDir(dbFile, {})).toBeUndefined();
		writeFileSync(configFileFor(dbFile), JSON.stringify({ zoteroDataDir: "D:\\Zotero2" }));
		expect(configuredZoteroDataDir(dbFile, {})).toBe("D:\\Zotero2");
		expect(configuredZoteroDataDir(dbFile, { ZN_ZOTERO_DIR: "E:\\x" })).toBe("E:\\x");
	});
});

describe("/api/files", () => {
	const json = async (r: Response) => (await r.json()) as any;

	test("settings view", async () => {
		const v = await json(await call(db, "GET", "/api/files/settings"));
		expect(v.library.dbPath).toBe(join(fx.dir, "lib.sqlite"));
		expect(v.baseDir).toMatchObject({ mode: "zotero", effective: base, stored: { absolute: 0, relative: 0 } });
		expect(v.zotero.source).toBe("zotero"); // nothing chosen in Settings: whatever Zotero's own prefs/default say
		expect(v.zotero.configured).toBeNull();
	});

	test("zotero locate + validate + choose a folder", async () => {
		const dir = join(fx.dir, "Chosen");
		mkdirSync(dir);
		const z = new Database(join(dir, "zotero.sqlite"), { create: true });
		z.exec("CREATE TABLE t(x)");
		z.close();
		const bad = await call(db, "PUT", "/api/files/zotero", { dir: join(fx.dir, "nothing-here") });
		expect(bad.status).toBe(400);
		const ok = await json(await call(db, "PUT", "/api/files/zotero", { dir }));
		expect(ok.zotero).toMatchObject({ dataDir: dir, source: "settings", configured: dir });
		const val = await json(await call(db, "POST", "/api/files/zotero/validate", { dir }));
		expect(val.hasDatabase).toBe(true);
		const located = await json(await call(db, "GET", "/api/files/zotero"));
		expect(located.candidates[0]).toMatchObject({ source: "configured", dir });
		const cleared = await json(await call(db, "PUT", "/api/files/zotero", { dir: null }));
		expect(cleared.zotero.configured).toBeNull();
	});

	test("base directory: set, refuse clearing while relative paths exist, convert preview then confirm", async () => {
		addLinked("LNK00007", join(base, "Smith", "g.pdf"));
		const notDir = await call(db, "PUT", "/api/files/base-dir", { mode: "custom", path: join(fx.dir, "nope") });
		expect(notDir.status).toBe(400);
		const prev = await json(await call(db, "POST", "/api/files/base-dir/convert", { direction: "relative" }));
		expect(prev).toMatchObject({ count: 1, outside: 0 });
		expect(rawPath("LNK00007")).toBe(join(base, "Smith", "g.pdf"));
		const done = await json(await call(db, "POST", "/api/files/base-dir/convert", { direction: "relative", confirm: true }));
		expect(done.converted).toBe(1);
		expect(done.baseDir.stored.relative).toBe(1);
		const refuse = await call(db, "PUT", "/api/files/base-dir", { mode: "none" });
		expect(refuse.status).toBe(409);
		expect(baseDirInfo(db).mode).toBe("zotero"); // unchanged
		await json(await call(db, "POST", "/api/files/base-dir/convert", { direction: "absolute", confirm: true }));
		const none = await call(db, "PUT", "/api/files/base-dir", { mode: "none" });
		expect(none.status).toBe(200);
	});

	test("pick-folder and reveal use the injected hooks", async () => {
		expect((await call(db, "POST", "/api/files/pick-folder", {})).status).toBe(501);
		setFolderPicker(async () => "C:\\picked");
		expect(await json(await call(db, "POST", "/api/files/pick-folder", {}))).toEqual({ path: "C:\\picked" });
		const seen: string[] = [];
		setRevealer((p) => void seen.push(p));
		expect((await call(db, "POST", "/api/files/reveal", { what: "library" })).status).toBe(200);
		expect(seen).toEqual([join(fx.dir, "lib.sqlite")]);
		expect((await call(db, "POST", "/api/files/reveal", { what: "../etc" })).status).toBe(400);
	});
});
