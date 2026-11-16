// ZotMoov features built into the attachment storage location: wildcards, automatic placement rules (types, rename, tag,
// copy), the move / copy / convert commands, attach-newest-file, delete-with-item. Temp folders and temp databases only.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database as Db } from "bun:sqlite";
import { addFile } from "../../src/additems/files";
import { storeWebAttachment } from "../../src/connector/attachments";
import { handleFilesApi } from "../../src/files/api";
import { attachNewest, findNewestFile, previewAttachNewest, runOrganize } from "../../src/files/organize";
import { baseDirInfo, setBaseDir, setZoteroProfilesDir, applyConversion } from "../../src/files/paths";
import { expandPattern, metaOfItem, monthDayOf, validatePattern, type PatternMeta } from "../../src/files/pattern";
import {
	applyZotMoovPreset,
	copyVerifiedSync,
	extAllowed,
	planRelocate,
	setAttributeProbe,
	setLockProbe,
	setStorage,
	storageTargetFor,
	storageView,
} from "../../src/files/storage";
import { eraseItems } from "../../src/maintenance/erase";
import { renameFiles } from "../../src/maintenance/rename-files";
import { savePdf } from "../../src/fulltext/save";
import { buildFixture, insertAttachment, insertItem, type Fixture } from "../fixture";

let fx: Fixture;
let db: Db;
let own: string;
let dest: string;
let downloads: string;

const row = (key: string) =>
	db.query("SELECT link_mode, path, url FROM attachments WHERE item_key = ?").get(key) as {
		link_mode: string;
		path: string;
		url: string | null;
	};
const data = (key: string) =>
	JSON.parse((db.query("SELECT data FROM items WHERE key = ?").get(key) as { data: string }).data) as Record<string, any>;
const tagsOf = (key: string) =>
	(db.query("SELECT tag FROM item_tags WHERE item_key = ? ORDER BY tag").all(key) as { tag: string }[]).map((r) => r.tag);
const names = (dir: string) => readdirSync(dir).sort();

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
function touch(path: string, content: string, ageSeconds: number): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
	const t = new Date(Date.now() - ageSeconds * 1000);
	utimesSync(path, t, t);
}
async function api(method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
	const res = await handleFilesApi(
		new Request(`http://127.0.0.1:23120/api/files/${route}`, {
			method,
			headers: { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		db,
	);
	return { status: res!.status, json: await res!.json() };
}

beforeEach(() => {
	fx = buildFixture();
	db = fx.db;
	own = join(fx.dir, "storage");
	dest = join(fx.dir, "Zotero Library");
	downloads = join(fx.dir, "Downloads");
	setZoteroProfilesDir(join(fx.dir, "no-zotero-profiles"));
	setAttributeProbe(() => 0);
	setLockProbe(() => false);
	db.run("DELETE FROM sync_outbox");
});
afterEach(() => {
	setAttributeProbe();
	setLockProbe();
	setZoteroProfilesDir(undefined);
	db.close(true);
});

describe("wildcards", () => {
	const meta: PatternMeta = {
		author: "Smith",
		year: "2020",
		title: "Deep learning",
		publication: "J Med AI",
		itemType: "journalArticle",
		citekey: "smith2020",
		authorInitials: "AS",
		editor: "Lee",
		editorLastF: "LeeK",
		editorInitials: "KL",
		publisher: "Acme",
		journalAbbrev: "JMAI",
		volume: "7",
		issue: "2",
		pages: "10-20",
		month: "05",
		day: "01",
		addedYear: "2024",
		addedMonth: "03",
		addedDay: "09",
		collectionPath: ["Radiology", "Sub/Folder"],
	};
	test("single wildcards", () => {
		expect(expandPattern("{%a}/{%y}/{%A}/{%b}/{%I}", meta)).toEqual(["Smith", "2020", "S", "smith2020", "AS"]);
		expect(expandPattern("{%d}/{%D}/{%L}/{%l}", meta)).toEqual(["Lee", "L", "LeeK", "KL"]);
		expect(expandPattern("{%p}/{%s}/{%v}/{%e}/{%f}", meta)).toEqual(["Acme", "JMAI", "7", "2", "10-20"]);
		expect(expandPattern("{%Y}-{%M}-{%R}", meta)).toEqual(["2024-03-09"]);
		expect(expandPattern("{%y}{-%m}{-%r}", meta)).toEqual(["2020-05-01"]);
	});
	test("collection path becomes nested folders, names cleaned", () => {
		expect(expandPattern("{%c}", meta)).toEqual(["Radiology", "SubFolder"]);
		expect(expandPattern("{%c}/{%a}", meta)).toEqual(["Radiology", "SubFolder", "Smith"]);
		expect(expandPattern("{%c}", { ...meta, collectionPath: [] })).toEqual([]); // not filed anywhere: the storage folder itself
	});
	test("groups: dropped when empty, first non-empty of alternatives, bare wildcards", () => {
		const bare = { ...meta, month: "", day: "", citekey: "" };
		expect(expandPattern("{%y}{-%m}", bare)).toEqual(["2020"]);
		expect(expandPattern("{%b | %I}", bare)).toEqual(["AS"]);
		expect(expandPattern("{%b | %I}", meta)).toEqual(["smith2020"]);
		expect(expandPattern("{%v}", { ...meta, volume: "" })).toEqual([]);
		expect(expandPattern("%a - %y/%t", meta)).toEqual(["Smith - 2020", "Deep learning"]);
		expect(expandPattern("{%v | %U}", { ...meta, volume: "" }, { undefinedStr: "none" })).toEqual(["none"]);
		expect(expandPattern("{vol. %v}", meta)).toEqual(["vol. 7"]);
	});
	test("legacy empties keep their stand-in text; diacritics can be stripped; the folder cannot escape", () => {
		expect(expandPattern("{%a}/{%y}", { ...meta, author: "", year: "" })).toEqual(["Unknown author", "undated"]);
		expect(expandPattern("{%a}", { ...meta, author: "Müller-Łukasiewicz" }, { stripDiacritics: true })).toEqual(["Muller-Łukasiewicz"]);
		expect(expandPattern("../{%a}/../..", meta)).toEqual(["Smith"]);
	});
	test("validation", () => {
		expect(validatePattern("{%c}/{%b | %I}/{%Y}{-%M}")).toBeNull();
		expect(validatePattern("{%y")).toMatch(/unfinished/);
		expect(validatePattern("{%z}")).toMatch(/unknown placeholder/);
		expect(validatePattern("%q")).toMatch(/unknown placeholder/);
	});
	test("dates", () => {
		expect(monthDayOf("2020-05-01")).toEqual({ month: "05", day: "01" });
		expect(monthDayOf("May 2020")).toEqual({ month: "05", day: "" });
		expect(monthDayOf("3 March 2022")).toEqual({ month: "03", day: "03" });
		expect(monthDayOf("Dec 25, 2019")).toEqual({ month: "12", day: "25" });
		expect(monthDayOf("2018")).toEqual({ month: "", day: "" });
	});
	test("metaOfItem reads fields, date parts, date added and the collection path", () => {
		db.query("INSERT INTO collection_items VALUES('COLLAAA2', 'AAAAAAA1')").run();
		db.query(
			"UPDATE items SET data = json_set(data, '$.volume', '12', '$.publisher', 'Acme', '$.extra', 'Citation Key: smith2020x') WHERE key = 'AAAAAAA1'",
		).run();
		const m = metaOfItem(db, "AAAAAAA1", { collectionKey: "COLLAAA2" });
		expect(m).toMatchObject({
			author: "Smith",
			authorInitials: "AS",
			volume: "12",
			publisher: "Acme",
			citekey: "smith2020x",
			month: "05",
			day: "01",
			addedYear: "2024",
			addedMonth: "03",
		});
		expect(m.collectionPath).toEqual(["Radiology", "Sub"]); // the collection the user looks at
		expect(metaOfItem(db, "AAAAAAA1", { collectionKey: "NOPE" }).collectionPath).toEqual(["Radiology"]); // else the first one
	});
});

describe("settings", () => {
	test("defaults and the ZotMoov preset", () => {
		const v = storageView(db);
		expect(v).toMatchObject({
			dir: null,
			auto: true,
			behavior: "move",
			allowedExt: [],
			rename: false,
			renameTitle: true,
			addTag: false,
			tag: "zotmoov",
			deleteFiles: false,
			pruneEmptyDirs: true,
			attachDir: null,
		});
		const p = applyZotMoovPreset(db, dest);
		expect(p).toMatchObject({
			dir: dest,
			subfolder: "",
			linked: true,
			auto: true,
			behavior: "move",
			allowedExt: ["pdf", "epub", "docx", "djvu"],
			rename: true,
			renameTitle: true,
			addTag: true,
			deleteFiles: false,
		});
	});
	test("validation and normalisation", () => {
		expect(setStorage(db, { allowedExt: [".PDF", "*.Epub", "pdf", " "] }).allowedExt).toEqual(["pdf", "epub"]);
		expect(() => setStorage(db, { allowedExt: ["a/b"] })).toThrow(/extension/);
		expect(() => setStorage(db, { behavior: "swap" as never })).toThrow();
		expect(() => setStorage(db, { tag: "  " })).toThrow();
		expect(() => setStorage(db, { attachDir: fx.pdfPath })).toThrow(/file/);
		expect(setStorage(db, { attachDir: downloads }).attachDir).toBe(downloads);
		expect(setStorage(db, { attachDir: null }).attachDir).toBeNull();
		expect(extAllowed("A.PDF", ["pdf"])).toBe(true);
		expect(extAllowed("a.txt", ["pdf"])).toBe(false);
		expect(extAllowed("a.txt", [])).toBe(true);
	});
	test("the OneDrive folder is suggested, not touched", () => {
		const saved = process.env.OneDrive;
		process.env.OneDrive = join(fx.dir, "OneDrive");
		try {
			expect(storageView(db).suggestions).toContain(join(fx.dir, "OneDrive", "Zotero Library"));
			expect(existsSync(join(fx.dir, "OneDrive"))).toBe(false);
		} finally {
			if (saved === undefined) delete process.env.OneDrive;
			else process.env.OneDrive = saved;
		}
	});
	test("routes: configure, preset, validation", async () => {
		const r = await api("PUT", "storage", {
			dir: dest,
			behavior: "copy",
			allowedExt: ["pdf"],
			rename: true,
			addTag: true,
			tag: "moved",
			attachDir: downloads,
		});
		expect(r.status).toBe(200);
		expect(r.json.storage).toMatchObject({
			dir: dest,
			behavior: "copy",
			allowedExt: ["pdf"],
			rename: true,
			addTag: true,
			tag: "moved",
			attachDir: downloads,
		});
		expect((await api("PUT", "storage", { allowedExt: ["x y"] })).status).toBe(400);
		const p = await api("POST", "storage/preset", { dir: dest });
		expect(p.json.storage).toMatchObject({ behavior: "move", tag: "zotmoov", allowedExt: ["pdf", "epub", "docx", "djvu"] });
		expect((await api("POST", "storage/preset", {})).status).toBe(400);
	});
});

describe("automatic placement of new files", () => {
	test("automatic off: new files stay in zotero-next's storage", () => {
		setStorage(db, { dir: dest, auto: false });
		const t = storageTargetFor(db, { key: "NEWKEY01", name: "a.pdf", parentKey: "AAAAAAA1" });
		expect(t).toMatchObject({ custom: false, dir: join(own, "NEWKEY01") });
		expect(storageTargetFor(db, { key: "NEWKEY01", name: "a.pdf", parentKey: "AAAAAAA1", force: true }).custom).toBe(true);
	});

	test("only allowed file types are placed; others stay in zotero-next's storage", () => {
		applyZotMoovPreset(db, dest);
		const pdf = addFile(db, { name: "a.pdf", dataBase64: "AA==", parentKey: "AAAAAAA1" });
		const txt = addFile(db, { name: "n.txt", dataBase64: "AA==", parentKey: "AAAAAAA1" });
		expect(pdf.data.linkMode).toBe("linked_file");
		expect(txt.data.linkMode).toBe("imported_file");
		expect(row(txt.data.key).path).toBe(join(own, txt.data.key, "n.txt"));
	});

	test("rename from the parent, title follows the file name, tag, subfolders from the pattern with the collection path", () => {
		applyZotMoovPreset(db, dest);
		setStorage(db, { subfolder: "{%c}/{%y}" });
		const d = addFile(db, { name: "download (3).pdf", dataBase64: "AA==", parentKey: "AAAAAAA1", collectionKey: "COLLAAA1" });
		const file = join(dest, "Radiology", "2020", "Smith and Jones - 2020 - Deep learning for radiology.pdf");
		expect(row(d.data.key)).toMatchObject({ link_mode: "linked_file", path: file });
		expect(existsSync(file)).toBe(true);
		expect(d.data.title).toBe("Smith and Jones - 2020 - Deep learning for radiology.pdf");
		expect(d.data.filename).toBe("Smith and Jones - 2020 - Deep learning for radiology.pdf");
		expect(tagsOf(d.data.key)).toEqual(["zotmoov"]);
		expect(data(d.data.key).tags).toEqual([{ tag: "zotmoov" }]);
		expect(existsSync(join(own, d.data.key))).toBe(false);
		// a second file for the same item never overwrites the first
		const d2 = addFile(db, { name: "x.pdf", dataBase64: "Ag==", parentKey: "AAAAAAA1" });
		expect(row(d2.data.key).path).toBe(join(dest, "Radiology", "2020", "Smith and Jones - 2020 - Deep learning for radiology (2).pdf"));
		expect(readFileSync(file).length).toBe(1);
	});

	test("rename and tag stay off unless chosen", () => {
		setStorage(db, { dir: dest });
		const d = addFile(db, { name: "orig.pdf", dataBase64: "AA==", parentKey: "AAAAAAA1" });
		expect(d.data.title).toBe("orig.pdf");
		expect(tagsOf(d.data.key)).toEqual([]);
		expect(row(d.data.key).path).toBe(join(dest, "orig.pdf"));
	});

	test("copy behaviour: the attachment stays in zotero-next's storage, a copy is placed in the folder", () => {
		setStorage(db, { dir: dest, behavior: "copy", rename: true, addTag: true });
		const d = addFile(db, { name: "orig.pdf", dataBase64: "AA==", parentKey: "AAAAAAA1" });
		expect(d.data.linkMode).toBe("imported_file");
		expect(row(d.data.key).path).toBe(join(own, d.data.key, "orig.pdf"));
		expect(names(dest)).toEqual(["Smith and Jones - 2020 - Deep learning for radiology.pdf"]);
		expect(tagsOf(d.data.key)).toEqual([]);
	});

	test("a file path source is copied with a verified copy; the user's file is untouched", () => {
		setStorage(db, { dir: dest });
		const src = join(downloads, "mine.pdf");
		touch(src, "my bytes", 5);
		const d = addFile(db, { mode: "imported_file", path: src, parentKey: "AAAAAAA1" });
		expect(readFileSync(row(d.data.key).path, "utf8")).toBe("my bytes");
		expect(existsSync(src)).toBe(true);
		expect(statSync(row(d.data.key).path).mtimeMs).toBeCloseTo(statSync(src).mtimeMs, -2); // modification time kept
	});

	test("with a base directory and relative storing on, the new link is stored the way Zotero stores it", () => {
		setBaseDir(db, "custom", fx.dir);
		applyConversion(db, "relative"); // storeRelative on
		setStorage(db, { dir: dest });
		const d = addFile(db, { name: "a.pdf", dataBase64: "AA==", parentKey: "AAAAAAA1" });
		expect(row(d.data.key).path).toBe("attachments:Zotero Library/a.pdf");
		expect(d.data.path).toBe(join(dest, "a.pdf")); // sync gets the absolute path
		expect(baseDirInfo(db).effective).toBe(fx.dir);
	});

	test("web saves (connector) keep a renamed linked file linked and keep the source URL", () => {
		applyZotMoovPreset(db, dest);
		const key = storeWebAttachment(db, {
			parentKey: "AAAAAAA1",
			bytes: new Uint8Array([1, 2, 3]),
			url: "https://example.org/p.pdf",
			title: "Full Text PDF",
			contentType: "application/pdf",
			filename: "p.pdf",
		});
		expect(row(key)).toMatchObject({
			link_mode: "linked_file",
			url: "https://example.org/p.pdf",
			path: join(dest, "Smith and Jones - 2020 - Deep learning for radiology.pdf"),
		});
		expect(data(key)).toMatchObject({
			linkMode: "linked_file",
			url: "https://example.org/p.pdf",
			title: "Smith and Jones - 2020 - Deep learning for radiology.pdf",
		});
		expect(tagsOf(key)).toEqual(["zotmoov"]);
	});

	test("Find Full Text saves into the storage folder too", () => {
		applyZotMoovPreset(db, dest);
		const staged = join(fx.dir, "staged.pdf");
		writeFileSync(staged, "%PDF-1.4 body");
		const key = "BBBBBBB2";
		const bodies = { get: () => ({ kind: "pdf", path: staged }), release: () => {} } as never;
		const r = savePdf(
			{ db, dataDir: fx.dir, bodies, keyOfItem: () => key, ezproxySuffix: "" },
			{
				item: 1,
				body: { handle: "h" } as never,
				trim_prefix: 0,
				version: "published",
				url_to_store: "https://example.org/a.pdf",
				route: "x",
				source: "y",
			},
		);
		const att = row(r.attachment_key);
		expect(att.link_mode).toBe("linked_file");
		expect(att.path.startsWith(dest)).toBe(true);
		expect(readFileSync(att.path, "utf8")).toBe("%PDF-1.4 body");
		expect(existsSync(staged)).toBe(false);
		expect(tagsOf(r.attachment_key)).toEqual(["zotmoov"]);
		expect(data(r.attachment_key)).toMatchObject({ linkMode: "linked_file", url: "https://example.org/a.pdf" });
	});

	test("Find Full Text without a storage folder keeps Zotero's layout (imported_url)", () => {
		const staged = join(fx.dir, "staged2.pdf");
		writeFileSync(staged, "%PDF-1.4 body");
		const bodies = { get: () => ({ kind: "pdf", path: staged }), release: () => {} } as never;
		const r = savePdf(
			{ db, dataDir: fx.dir, bodies, keyOfItem: () => "BBBBBBB2", ezproxySuffix: "" },
			{
				item: 1,
				body: { handle: "h" } as never,
				trim_prefix: 0,
				version: "published",
				url_to_store: "https://example.org/b.pdf",
				route: "x",
				source: "y",
			},
		);
		expect(row(r.attachment_key)).toMatchObject({
			link_mode: "imported_url",
			path: join(fx.dir, "storage", r.attachment_key, r.filename),
		});
	});
});

describe("the move, copy and convert commands", () => {
	beforeEach(() => {
		applyZotMoovPreset(db, dest);
		setStorage(db, { rename: false, addTag: false });
	});

	test("move to the storage folder: only the selected item's attachments; tag and title follow the settings", async () => {
		setStorage(db, { rename: true, addTag: true });
		ownFile("ATT00002", "orig.pdf", "aaa");
		insertAttachment(db, "ATT00005", "BBBBBBB2", "application/pdf", null);
		ownFile("ATT00005", "other.pdf", "bbb");
		const report = await runOrganize(db, { action: "move", keys: ["AAAAAAA1"] }); // the item stands for its attachments
		const file = join(dest, "Smith and Jones - 2020 - Deep learning for radiology.pdf");
		expect(report.moved).toBe(1);
		expect(row("ATT00002")).toEqual({ link_mode: "linked_file", path: file, url: null });
		expect(data("ATT00002")).toMatchObject({
			title: "Smith and Jones - 2020 - Deep learning for radiology.pdf",
			filename: "Smith and Jones - 2020 - Deep learning for radiology.pdf",
			path: file,
		});
		expect(tagsOf("ATT00002")).toEqual(["zotmoov"]);
		expect(row("ATT00005").path).toBe(join(own, "ATT00005", "other.pdf")); // not selected: untouched
		expect(existsSync(join(own, "ATT00002"))).toBe(false);
	});

	test("the item keeps its key, collections, annotations, full text and notes (nothing is cloned)", async () => {
		ownFile("ATT00002", "orig.pdf", "aaa");
		await runOrganize(db, { action: "move", keys: ["ATT00002"] });
		expect(db.query("SELECT count(*) AS n FROM annotations WHERE attachment_key = 'ATT00002'").get()).toEqual({ n: 1 });
		expect(db.query("SELECT count(*) AS n FROM fulltext WHERE attachment_key = 'ATT00002'").get()).toEqual({ n: 1 });
		expect(db.query("SELECT count(*) AS n FROM items WHERE key = 'NOTE0001' AND parent_key = 'AAAAAAA1'").get()).toEqual({ n: 1 });
		expect(data("ATT00002").parentItem).toBe("AAAAAAA1");
	});

	test("allowed types, shared files, files another program holds open and files already in place are skipped", async () => {
		ownFile("ATT00002", "a.pdf", "aaa");
		insertAttachment(db, "ATT00006", "AAAAAAA1", "text/plain", null);
		ownFile("ATT00006", "n.txt", "txt");
		insertAttachment(db, "ATT00007", "AAAAAAA1", "application/pdf", null);
		ownFile("ATT00007", "locked.pdf", "lll");
		addLinked("LNK00010", "BBBBBBB2", join(fx.dir, "elsewhere", "shared.pdf"));
		addLinked("LNK00011", "BBBBBBB2", join(fx.dir, "elsewhere", "shared.pdf"));
		addLinked("LNK00012", "BBBBBBB2", join(dest, "inplace.pdf"));
		setLockProbe((p) => p.endsWith("locked.pdf"));
		const plan = planRelocate(db, { keys: ["ATT00002", "ATT00006", "ATT00007", "LNK00010", "LNK00011", "LNK00012"] });
		const why = Object.fromEntries(plan.skipped.map((s) => [s.key, s.reason]));
		expect(why.ATT00006).toMatch(/allowed list/);
		expect(why.LNK00010).toMatch(/another attachment/);
		expect(why.LNK00011).toMatch(/another attachment/);
		expect(why.LNK00012).toMatch(/already/);
		expect(plan.items.map((i) => i.key).sort()).toEqual(["ATT00002", "ATT00007"]);
		const report = await runOrganize(db, { action: "move", keys: ["ATT00002", "ATT00007"] });
		expect(report.moved).toBe(1);
		expect(report.locked).toBe(1);
		expect(report.skipped.find((s) => s.key === "ATT00007")).toMatchObject({ locked: true });
		expect(existsSync(join(own, "ATT00007", "locked.pdf"))).toBe(true);
		expect(row("ATT00007").link_mode).toBe("imported_file");
	});

	test("never overwrites a different file; identical content is reused", async () => {
		ownFile("ATT00002", "p.pdf", "mine");
		mkdirSync(dest, { recursive: true });
		writeFileSync(join(dest, "p.pdf"), "someone else's");
		await runOrganize(db, { action: "move", keys: ["ATT00002"] });
		expect(readFileSync(join(dest, "p.pdf"), "utf8")).toBe("someone else's");
		expect(readFileSync(row("ATT00002").path, "utf8")).toBe("mine");
		expect(row("ATT00002").path).toBe(join(dest, "p (2).pdf"));
	});

	test("an imported web PDF (imported_url) becomes a linked file and keeps its URL; a web page snapshot is left alone", async () => {
		insertAttachment(db, "ATT00008", "BBBBBBB2", "application/pdf", null);
		ownFile("ATT00008", "web.pdf", "web");
		db.query("UPDATE attachments SET link_mode = 'imported_url', url = 'https://example.org/x' WHERE item_key = 'ATT00008'").run();
		insertAttachment(db, "ATT00009", "BBBBBBB2", "text/html", null);
		ownFile("ATT00009", "page.html", "<html>");
		db.query("UPDATE attachments SET link_mode = 'imported_url' WHERE item_key = 'ATT00009'").run();
		setStorage(db, { allowedExt: [] });
		const report = await runOrganize(db, { action: "move", keys: ["ATT00008", "ATT00009"] });
		expect(report.moved).toBe(1);
		expect(row("ATT00008")).toMatchObject({ link_mode: "linked_file", url: "https://example.org/x" });
		expect(report.skipped.find((s) => s.key === "ATT00009")!.reason).toMatch(/snapshot/);
		expect(row("ATT00009").link_mode).toBe("imported_url");
	});

	test("copy to the storage folder or to another folder: files are copied, the attachments are not changed", async () => {
		const f = ownFile("ATT00002", "orig.pdf", "aaa");
		const before = JSON.stringify([row("ATT00002"), data("ATT00002")]);
		setStorage(db, { subfolder: "{%a}" });
		const r1 = await runOrganize(db, { action: "copy", keys: ["AAAAAAA1"] });
		expect(r1).toMatchObject({ copied: 1, moved: 0 });
		expect(readFileSync(join(dest, "Smith", "orig.pdf"), "utf8")).toBe("aaa");
		const other = join(fx.dir, "Share");
		const r2 = await runOrganize(db, { action: "copy", keys: ["AAAAAAA1"], dir: other });
		expect(r2.copied).toBe(1);
		expect(readFileSync(join(other, "orig.pdf"), "utf8")).toBe("aaa"); // a custom folder has no subfolders
		const r3 = await runOrganize(db, { action: "copy", keys: ["AAAAAAA1"], dir: other }); // again: the identical copy is reused
		expect(r3.copied).toBe(1);
		expect(names(other)).toEqual(["orig.pdf"]);
		expect(existsSync(f)).toBe(true);
		expect(JSON.stringify([row("ATT00002"), data("ATT00002")])).toBe(before);
	});

	test("move to another folder (custom directory command)", async () => {
		ownFile("ATT00002", "orig.pdf", "aaa");
		const other = join(fx.dir, "Elsewhere");
		await runOrganize(db, { action: "move", keys: ["ATT00002"], dir: other });
		expect(row("ATT00002")).toMatchObject({ link_mode: "linked_file", path: join(other, "orig.pdf") });
	});

	test("convert linked to stored: copied into zotero-next's storage, verified, original removed, empty folders pruned, tag removed", async () => {
		setStorage(db, { addTag: true, subfolder: "{%a}/{%y}" });
		addLinked("LNK00020", "BBBBBBB2", join(dest, "Brown", "2018", "book.pdf"), "book bytes");
		(await import("../../src/db")).addTags(db, "LNK00020", ["zotmoov", "keep"]);
		const report = await runOrganize(db, { action: "to-stored", keys: ["BBBBBBB2"] });
		expect(report.moved).toBe(1);
		const to = join(own, "LNK00020", "book.pdf");
		expect(row("LNK00020")).toEqual({ link_mode: "imported_file", path: to, url: null });
		expect(readFileSync(to, "utf8")).toBe("book bytes");
		expect(data("LNK00020")).toMatchObject({ linkMode: "imported_file", filename: "book.pdf" });
		expect(data("LNK00020").path).toBeUndefined();
		expect(tagsOf("LNK00020")).toEqual(["keep"]);
		expect(existsSync(join(dest, "Brown"))).toBe(false); // emptied folders removed
		expect(existsSync(dest)).toBe(true); // the storage folder itself stays
	});

	test("convert skips stored files and leaves the original when the database step fails", async () => {
		ownFile("ATT00002", "a.pdf", "aaa");
		addLinked("LNK00021", "BBBBBBB2", join(dest, "x.pdf"));
		const plan = planRelocate(db, { keys: ["ATT00002", "LNK00021"], toOwn: true });
		expect(plan.skipped.find((s) => s.key === "ATT00002")!.reason).toMatch(/already a stored file/);
		const { runMove } = await import("../../src/files/storage");
		const report = await runMove(db, plan, {
			beforeCommit: () => {
				throw new Error("disk on fire");
			},
		});
		expect(report.failed).toHaveLength(1);
		expect(readFileSync(join(dest, "x.pdf"), "utf8")).toBe("linked-bytes");
		expect(existsSync(join(own, "LNK00021"))).toBe(false);
		expect(row("LNK00021").link_mode).toBe("linked_file");
	});

	test("the route: preview, run, validation", async () => {
		ownFile("ATT00002", "orig.pdf", "aaa");
		const p = await api("POST", "organize", { action: "move", keys: ["AAAAAAA1"], preview: true });
		expect(p.json).toMatchObject({ count: 1, totalBytes: 3 });
		expect(existsSync(join(own, "ATT00002", "orig.pdf"))).toBe(true);
		const r = await api("POST", "organize", { action: "move", keys: ["AAAAAAA1"] });
		expect(r.json).toMatchObject({ moved: 1, failed: [] });
		expect((await api("POST", "organize", { action: "shred", keys: ["AAAAAAA1"] })).status).toBe(400);
		expect((await api("POST", "organize", { action: "move", keys: [] })).status).toBe(400);
		expect((await api("POST", "organize", { action: "move", keys: ["DDDDDDD4x"] })).status).toBe(400); // nothing attached
		setStorage(db, { dir: null });
		expect((await api("POST", "organize", { action: "move", keys: ["AAAAAAA1"] })).status).toBe(400); // no storage folder
		expect((await api("POST", "organize", { action: "to-stored", keys: ["LNK00000"] })).status).toBe(400);
	});

	test("rename in place: a linked file inside the storage folder is renamed from its parent, one outside is not", () => {
		addLinked("LNK00030", "BBBBBBB2", join(dest, "scan0001.pdf"));
		addLinked("LNK00031", "BBBBBBB2", join(fx.dir, "elsewhere", "scan0002.pdf"));
		const r = renameFiles(db, ["LNK00030", "LNK00031"], own);
		expect(r[0]).toMatchObject({ status: "renamed", path: join(dest, "Brown - 2018 - Surgical anatomy.pdf") });
		expect(r[1].status).toBe("skipped");
		expect(row("LNK00030").path).toBe(join(dest, "Brown - 2018 - Surgical anatomy.pdf"));
		expect(data("LNK00030").path).toBe(join(dest, "Brown - 2018 - Surgical anatomy.pdf"));
		expect(existsSync(join(fx.dir, "elsewhere", "scan0002.pdf"))).toBe(true);
	});
});

describe("attach the newest file of a folder", () => {
	beforeEach(() => {
		applyZotMoovPreset(db, dest);
		setStorage(db, { attachDir: downloads });
	});

	test("picks the newest file of an allowed type, never a download in progress, a lock file or a folder", () => {
		touch(join(downloads, "old.pdf"), "old", 300);
		touch(join(downloads, "new.pdf"), "new", 10);
		touch(join(downloads, "newest.pdf.crdownload"), "partial", 1);
		touch(join(downloads, "~$lock.docx"), "lock", 1);
		touch(join(downloads, "picture.png"), "png", 1); // not an allowed type
		mkdirSync(join(downloads, "sub.pdf"));
		touch(join(downloads, "Thumbs.db"), "x", 1);
		expect(findNewestFile(downloads, ["pdf", "epub", "docx", "djvu"])!.path).toBe(join(downloads, "new.pdf"));
		expect(findNewestFile(downloads, [])!.path).toBe(join(downloads, "picture.png"));
		mkdirSync(join(fx.dir, "Empty"));
		expect(findNewestFile(join(fx.dir, "Empty"), [])).toBeNull();
	});

	test("preview, then attach: stored in the storage folder under the parent's name, the download leaves the folder", () => {
		touch(join(downloads, "paper (1).pdf"), "downloaded", 5);
		const pv = previewAttachNewest(db, "AAAAAAA1");
		expect(pv).toMatchObject({
			source: join(downloads, "paper (1).pdf"),
			size: 10,
			proposedName: "Smith and Jones - 2020 - Deep learning for radiology.pdf",
		});
		expect(existsSync(join(downloads, "paper (1).pdf"))).toBe(true); // a preview changes nothing
		const r = attachNewest(db, { parentKey: "AAAAAAA1" });
		const file = join(dest, "Smith and Jones - 2020 - Deep learning for radiology.pdf");
		expect(r.sourceRemoved).toBe(true);
		expect(existsSync(join(downloads, "paper (1).pdf"))).toBe(false);
		expect(readFileSync(file, "utf8")).toBe("downloaded");
		expect(row(r.attachment.data.key)).toMatchObject({ link_mode: "linked_file", path: file });
		expect(r.attachment.data.parentItem).toBe("AAAAAAA1");
		expect(data(r.attachment.data.key).title).toBe("Smith and Jones - 2020 - Deep learning for radiology.pdf");
		expect(tagsOf(r.attachment.data.key)).toEqual(["zotmoov"]);
	});

	test("a name typed by the user wins; automatic placement off still uses the storage folder", () => {
		setStorage(db, { auto: false });
		touch(join(downloads, "x.pdf"), "xx", 5);
		const r = attachNewest(db, { parentKey: "BBBBBBB2", name: "My chosen name.pdf" });
		expect(row(r.attachment.data.key).path).toBe(join(dest, "My chosen name.pdf"));
		expect(data(r.attachment.data.key).title).toBe("My chosen name.pdf");
	});

	test("nothing is removed when the file is open elsewhere; errors for a missing folder, no file, a non-regular parent", async () => {
		touch(join(downloads, "x.pdf"), "xx", 5);
		setLockProbe(() => true);
		expect(() => attachNewest(db, { parentKey: "AAAAAAA1" })).toThrow(/open in another program/);
		expect(existsSync(join(downloads, "x.pdf"))).toBe(true);
		expect(db.query("SELECT count(*) AS n FROM items WHERE parent_key = 'AAAAAAA1' AND item_type = 'attachment'").get()).toEqual({
			n: 2,
		});
		setLockProbe(() => false);
		expect(() => attachNewest(db, { parentKey: "ATT00002" })).toThrow(/regular top-level/);
		expect(() => attachNewest(db, { parentKey: "NOPE0000" })).toThrow(/not found/);
		setStorage(db, { attachDir: join(fx.dir, "Empty Folder") });
		expect(() => previewAttachNewest(db, "AAAAAAA1")).toThrow(/not a folder/);
		mkdirSync(join(fx.dir, "Empty Folder"));
		expect(() => previewAttachNewest(db, "AAAAAAA1")).toThrow(/no file to attach/);
		setStorage(db, { attachDir: null });
		expect(() => previewAttachNewest(db, "AAAAAAA1")).toThrow(/choose the folder/);
	});

	test("the route", async () => {
		touch(join(downloads, "route.pdf"), "r", 5);
		const pv = await api("POST", "attach-newest", { parentKey: "AAAAAAA1", preview: true });
		expect(pv.json.proposedName).toBe("Smith and Jones - 2020 - Deep learning for radiology.pdf");
		const r = await api("POST", "attach-newest", { parentKey: "AAAAAAA1" });
		expect(r.status).toBe(200);
		expect(r.json.sourceRemoved).toBe(true);
		expect((await api("POST", "attach-newest", { parentKey: "AAAAAAA1" })).status).toBe(404); // nothing left to attach
		expect((await api("POST", "attach-newest", {})).status).toBe(400);
	});
});

describe("deleting linked files with their items", () => {
	test("off by default: the file stays", () => {
		setStorage(db, { dir: dest });
		addLinked("LNK00040", "BBBBBBB2", join(dest, "Brown", "x.pdf"));
		const r = eraseItems(db, ["LNK00040"], own);
		expect(r.linkedFilesRemoved).toBeUndefined();
		expect(existsSync(join(dest, "Brown", "x.pdf"))).toBe(true);
	});

	test("on: the file goes, folders that became empty go, other files and folders stay", () => {
		setStorage(db, { dir: dest, deleteFiles: true });
		addLinked("LNK00041", "BBBBBBB2", join(dest, "Brown", "2018", "x.pdf"));
		addLinked("LNK00042", "BBBBBBB2", join(dest, "Keep", "y.pdf"));
		writeFileSync(join(dest, "Keep", "z.pdf"), "other");
		const outside = join(fx.dir, "elsewhere", "o.pdf");
		addLinked("LNK00043", "BBBBBBB2", outside);
		writeFileSync(join(dest, "Brown", "Thumbs.db"), "junk");
		const r = eraseItems(db, ["LNK00041", "LNK00042", "LNK00043"], own);
		expect(r.linkedFilesRemoved).toBe(2);
		expect(existsSync(join(dest, "Brown"))).toBe(false); // only a Thumbs.db left: folder removed
		expect(names(join(dest, "Keep"))).toEqual(["z.pdf"]);
		expect(existsSync(outside)).toBe(true); // outside the storage folder: never touched
		expect(existsSync(dest)).toBe(true);
	});

	test("a file another attachment still points at is kept; moving to the trash deletes nothing", () => {
		setStorage(db, { dir: dest, deleteFiles: true });
		addLinked("LNK00044", "BBBBBBB2", join(dest, "s.pdf"));
		addLinked("LNK00046", "BBBBBBB2", join(dest, "s.pdf"));
		const r = eraseItems(db, ["LNK00044"], own);
		expect(r.linkedFilesRemoved).toBe(0);
		expect(existsSync(join(dest, "s.pdf"))).toBe(true);
	});
});

describe("verified copy", () => {
	test("copyVerifiedSync copies bytes and times, and refuses to leave a bad copy", () => {
		const src = join(fx.dir, "v.bin");
		touch(src, "verify me", 100);
		const to = join(fx.dir, "v-copy.bin");
		copyVerifiedSync(src, to);
		expect(readFileSync(to, "utf8")).toBe("verify me");
		expect(Math.abs(statSync(to).mtimeMs - statSync(src).mtimeMs)).toBeLessThan(5);
	});
});
