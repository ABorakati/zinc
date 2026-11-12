// importBrowserLibrary (src/import-browser.ts): the zip of a browser library merged into a library that already has data.
// Every test builds its own libraries under a temp folder; nothing outside it is touched.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { addFile } from "../../core/src/additems/files";
import * as repo from "../../core/src/db";
import { search } from "../../core/src/search";
import { SCHEMA_HEAD } from "../../core/src/migrations";
import { ImportError, importBrowserLibrary } from "../src/import-browser";
import { HostClient } from "./client";

const ROOT = mkdtempSync(join(tmpdir(), "znh-import-browser-"));
const open: Database[] = [];
afterAll(() => {
	for (const d of open) { try { d.close(true); } catch { /* closed */ } }
	try { rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Windows may hold the WAL */ }
});

// ---- a stored (uncompressed) zip writer: lets the tests name entries as an attacker would (fflate would tidy them)
const crcTable = (() => {
	const t: number[] = [];
	for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t.push(c >>> 0); }
	return t;
})();
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function makeZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const name = Buffer.from(e.name);
		const h = Buffer.alloc(30);
		h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 8);
		h.writeUInt32LE(crc32(e.data), 14); h.writeUInt32LE(e.data.length, 18); h.writeUInt32LE(e.data.length, 22); h.writeUInt16LE(name.length, 26);
		parts.push(h, name, Buffer.from(e.data));
		const c = Buffer.alloc(46);
		c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
		c.writeUInt32LE(crc32(e.data), 16); c.writeUInt32LE(e.data.length, 20); c.writeUInt32LE(e.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
		central.push(c, name);
		offset += 30 + name.length + e.data.length;
	}
	const dir = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
	return new Uint8Array(Buffer.concat([...parts, dir, end]));
}

/** a serialized WAL-mode database, readable in memory (the host does the same to what it receives) */
const deser = (b: Uint8Array) => {
	const c = new Uint8Array(b);
	if (c[18] === 2) { c[18] = 1; c[19] = 1; }
	return Database.deserialize(c);
};
const utf8 = (s: string) => new TextEncoder().encode(s);
let n = 0;
const newLibrary = (): { db: Database; path: string } => {
	const dir = join(ROOT, `lib${++n}`);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "library.sqlite");
	const db = repo.openDb(path);
	open.push(db);
	return { db, path };
};

interface Browser {
	zip: Uint8Array;
	keys: { overlap: string; fresh: string; note: string; pdf: string; coll: string; sub: string; ann: string; shared: string };
}

/** A browser library as export-zip.ts writes it, plus the app library (`app`) that already holds one of its items and one collection. */
function fixture(): Browser & { app: Database; appPath: string; pdfBytes: Uint8Array } {
	const b = newLibrary();
	const coll = repo.createCollection(b.db, "Reading list");
	const sub = repo.createCollection(b.db, "Methods", coll.key);
	const shared = repo.createCollection(b.db, "Shared name");
	const overlap = repo.createItem(b.db, { itemType: "book", title: "In the browser (overlap)" } as never);
	const fresh = repo.createItem(b.db, { itemType: "journalArticle", title: "Only in the browser: quokka genomics", collections: [coll.key] } as never);
	repo.addTags(b.db, fresh.data.key, ["marsupial", "to-read"]);
	b.db.query("INSERT OR IGNORE INTO collection_items(collection_key, item_key) VALUES (?, ?)").run(sub.key, fresh.data.key);
	b.db.query("INSERT OR IGNORE INTO collection_items(collection_key, item_key) VALUES (?, ?)").run(shared.key, fresh.data.key);
	const note = repo.createItem(b.db, { itemType: "note", note: "<p>my note on the quokka</p>", parentItem: fresh.data.key } as never);
	const pdfBytes = utf8("%PDF-1.4\n% the browser's pdf\n");
	const att = addFile(b.db, { name: "quokka.pdf", parentKey: fresh.data.key, contentType: "application/pdf", forceStorage: true }, pdfBytes);
	const ann = "ANNOT001";
	b.db.query("INSERT INTO annotations(key, attachment_key, data, date_modified) VALUES (?, ?, ?, ?)").run(ann, att.data.key, JSON.stringify({ id: ann, type: "highlight", text: "quokka" }), "2026-01-01T00:00:00Z");
	b.db.query("INSERT INTO fulltext(attachment_key, content, source, indexed_at) VALUES (?, ?, 'document-worker', ?)").run(att.data.key, "quokka fulltext words", "2026-01-01T00:00:00Z");

	// the app library: it already has "overlap" (under the same key, with its own title) and the collection "shared"
	const a = newLibrary();
	const ov = b.db.query("SELECT * FROM items WHERE key = ?").get(overlap.data.key) as Record<string, unknown>;
	const cols = Object.keys(ov);
	a.db.query(`INSERT INTO items (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...(cols.map((c) => (c === "title" ? "In the app (overlap)" : ov[c])) as never[]));
	a.db.query("INSERT INTO collections(key, name) VALUES (?, ?)").run(shared.key, "Shared name (app)");

	// the export: attachment paths in the relative form, files under storage/<KEY>/<name>
	b.db.query("UPDATE attachments SET path = 'attachments:storage/' || ? || '/quokka.pdf' WHERE item_key = ?").run(att.data.key, att.data.key);
	const zip = makeZip([
		{ name: "library.sqlite", data: new Uint8Array(b.db.serialize()) },
		{ name: `storage/${att.data.key}/quokka.pdf`, data: pdfBytes },
		{ name: `storage/${att.data.key}/extra/asset.txt`, data: utf8("a snapshot asset") },
		{ name: "README.txt", data: utf8("exported") },
	]);
	return { zip, app: a.db, appPath: a.path, pdfBytes, keys: { overlap: overlap.data.key, fresh: fresh.data.key, note: note.data.key, pdf: att.data.key, coll: coll.key, sub: sub.key, ann, shared: shared.key } };
}

const one = (d: Database, sql: string, ...p: unknown[]) => d.query(sql).get(...(p as never[])) as Record<string, unknown> | null;
const count = (d: Database, sql: string, ...p: unknown[]) => Number((one(d, sql, ...p) as { n: number }).n);

describe("merge into a library that has data", () => {
	const f = fixture();
	const r = importBrowserLibrary(f.app, f.zip);

	test("new items, notes and attachments arrive; an item whose key the app has is skipped and left as it is", () => {
		expect(r.skippedItems).toBe(1);
		expect(r.topLevelItems).toBe(1);
		expect(r.items).toBe(3); // the article, its note, its attachment
		expect(r.notes).toBe(1);
		expect(r.attachments).toBe(1);
		expect(one(f.app, "SELECT title FROM items WHERE key = ?", f.keys.overlap)!.title).toBe("In the app (overlap)");
		expect(one(f.app, "SELECT title FROM items WHERE key = ?", f.keys.fresh)!.title).toBe("Only in the browser: quokka genomics");
		expect(one(f.app, "SELECT parent_key FROM items WHERE key = ?", f.keys.note)!.parent_key).toBe(f.keys.fresh);
		expect(count(f.app, "SELECT count(*) AS n FROM items WHERE key = ?", f.keys.overlap)).toBe(1);
	});

	test("collections: new ones (with their parent) are added; one the app has stays as the app has it", () => {
		expect(r.collections).toBe(2); // Reading list, Methods
		expect(r.skippedCollections).toBe(1);
		expect(one(f.app, "SELECT parent_key FROM collections WHERE key = ?", f.keys.sub)!.parent_key).toBe(f.keys.coll);
		expect(one(f.app, "SELECT name FROM collections WHERE key = ?", f.keys.shared)!.name).toBe("Shared name (app)");
		// membership of the new item, in new and in existing collections
		const inColls = (f.app.query("SELECT collection_key AS k FROM collection_items WHERE item_key = ?").all(f.keys.fresh) as { k: string }[]).map((x) => x.k).sort();
		expect(inColls).toEqual([f.keys.coll, f.keys.sub, f.keys.shared].sort());
		// the skipped item's membership is not copied
		expect(count(f.app, "SELECT count(*) AS n FROM collection_items WHERE item_key = ?", f.keys.overlap)).toBe(0);
	});

	test("tags, annotations and full text", () => {
		expect(r.tags).toBe(2);
		expect((f.app.query("SELECT tag FROM item_tags WHERE item_key = ? ORDER BY tag").all(f.keys.fresh) as { tag: string }[]).map((t) => t.tag)).toEqual(["marsupial", "to-read"]);
		expect(r.annotations).toBe(1);
		expect(one(f.app, "SELECT attachment_key AS k FROM annotations WHERE key = ?", f.keys.ann)!.k).toBe(f.keys.pdf);
		expect(one(f.app, "SELECT content FROM fulltext WHERE attachment_key = ?", f.keys.pdf)!.content).toBe("quokka fulltext words");
	});

	test("files land under the app library's storage folder, and the attachment row points there", () => {
		const storage = join(dirname((f.app as unknown as { filename: string }).filename), "storage");
		const path = one(f.app, "SELECT path FROM attachments WHERE item_key = ?", f.keys.pdf)!.path as string;
		expect(path.replaceAll("\\", "/")).toBe(`${storage.replaceAll("\\", "/")}/${f.keys.pdf}/quokka.pdf`);
		expect(Buffer.from(readFileSync(path)).equals(Buffer.from(f.pdfBytes))).toBe(true);
		expect(readFileSync(join(storage, f.keys.pdf, "extra", "asset.txt"), "utf8")).toBe("a snapshot asset");
		expect(r.files).toBe(2);
		expect(r.fileBytes).toBe(f.pdfBytes.length + "a snapshot asset".length);
		expect(r.missingFiles).toBe(0);
	});

	test("the sync outbox records the new items, collections and annotations (and not the skipped item)", () => {
		const outbox = (type: string) => (f.app.query("SELECT key, op FROM sync_outbox WHERE type = ?").all(type) as { key: string; op: string }[]);
		const items = outbox("item").filter((o) => o.op === "upsert").map((o) => o.key);
		expect(items).toEqual(expect.arrayContaining([f.keys.fresh, f.keys.note, f.keys.pdf]));
		expect(outbox("collection").map((o) => o.key)).toEqual(expect.arrayContaining([f.keys.coll, f.keys.sub]));
		expect(outbox("annotation").map((o) => o.key)).toContain(f.keys.ann);
		// the app already had it (as its own row, inserted without the outbox): nothing was queued for the merge
		expect(outbox("item").some((o) => o.key === f.keys.overlap && o.op === "upsert")).toBe(true); // from the fixture's own insert ...
		const before = count(f.app, "SELECT count(*) AS n FROM sync_outbox");
		importBrowserLibrary(f.app, f.zip);
		expect(count(f.app, "SELECT count(*) AS n FROM sync_outbox")).toBe(before); // ... and a second merge queues nothing
	});

	test("the new item is found by search, with its full text", () => {
		expect(search(f.app, "quokka").hits.map((i) => i.key)).toContain(f.keys.fresh);
		expect(search(f.app, "fulltext words").hits.map((i) => i.key)).toContain(f.keys.fresh);
	});

	test("merging the same zip again adds nothing", () => {
		const again = importBrowserLibrary(f.app, f.zip);
		expect(again.items).toBe(0);
		expect(again.collections).toBe(0);
		expect(again.files).toBe(0);
		expect(again.skippedItems).toBe(2);
	});
});

describe("an empty app library", () => {
	test("everything arrives", () => {
		const f = fixture();
		const empty = newLibrary();
		const r = importBrowserLibrary(empty.db, f.zip);
		expect(r.topLevelItems).toBe(2);
		expect(r.skippedItems).toBe(0);
		expect(r.collections).toBe(3);
	});
});

describe("the zip is untrusted", () => {
	const lib = () => {
		const f = fixture();
		return { f, db: newLibrary().db };
	};
	const libraryBytes = (f: Browser) => readZipEntry(f.zip, "library.sqlite");
	function readZipEntry(zip: Uint8Array, name: string): Uint8Array {
		const { readZip } = require("../../core/src/websync/zip") as typeof import("../../core/src/websync/zip");
		return readZip(zip).find((e) => e.name === name)!.data;
	}
	const snapshot = (dir: string) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map((x) => String(x).replaceAll("\\", "/")).sort() : []);

	test("entry names that climb out of storage are not written anywhere", () => {
		const { f, db } = lib();
		const dbFile = (db as unknown as { filename: string }).filename;
		const folder = dirname(dbFile);
		const outside = join(ROOT, "escape.txt");
		const zip = makeZip([
			{ name: "library.sqlite", data: libraryBytes(f) },
			{ name: `storage/${f.keys.pdf}/quokka.pdf`, data: f.pdfBytes },
			{ name: `storage/${f.keys.pdf}/../../../../escape.txt`, data: utf8("escaped") },
			{ name: `storage/../escape.txt`, data: utf8("escaped") },
			{ name: `/escape.txt`, data: utf8("escaped") },
			{ name: `storage\\${f.keys.pdf}\\..\\..\\escape.txt`, data: utf8("escaped") },
			{ name: `storage/${f.keys.pdf}/C:/escape.txt`, data: utf8("escaped") },
			{ name: `storage/${f.keys.pdf}/nul`, data: utf8("device") },
			{ name: `storage/..%2f..%2fescape/x.txt`, data: utf8("escaped") },
			{ name: `storage/${"A".repeat(40)}/x.txt`, data: utf8("long key") },
		]);
		const r = importBrowserLibrary(db, zip);
		expect(r.files).toBe(1); // only the real file
		expect(existsSync(outside)).toBe(false);
		expect(existsSync(join(folder, "escape.txt"))).toBe(false);
		expect(existsSync(join(ROOT, "lib1", "escape.txt"))).toBe(false);
		expect(snapshot(join(folder, "storage"))).toEqual([f.keys.pdf, `${f.keys.pdf}/quokka.pdf`].sort());
	});

	test("attachment paths in the zip's library.sqlite are never used as file paths", () => {
		const f = fixture();
		const target = join(ROOT, "should-not-be-read.txt");
		writeFileSync(target, "private");
		const evil = deser(libraryBytes(f));
		evil.query("UPDATE attachments SET path = ?").run(target);
		const zip = makeZip([{ name: "library.sqlite", data: new Uint8Array(evil.serialize()) }, { name: `storage/${f.keys.pdf}/quokka.pdf`, data: f.pdfBytes }]);
		const db = newLibrary().db;
		const r = importBrowserLibrary(db, zip);
		// the row's path named another file: it is not a file of the library, so the attachment has none (and nothing was read from it)
		expect(r.missingFiles).toBe(1);
		expect(one(db, "SELECT path FROM attachments WHERE item_key = ?", f.keys.pdf)!.path).toBeNull();
	});

	test("not a zip, no library.sqlite, not a library, a newer library: refused, and nothing is written", () => {
		const f = fixture();
		const db = newLibrary().db;
		const folder = dirname((db as unknown as { filename: string }).filename);
		const refuses = (bytes: Uint8Array, status: number, text: RegExp) => {
			try { importBrowserLibrary(db, bytes); throw new Error("did not refuse"); }
			catch (e) { expect(e).toBeInstanceOf(ImportError); expect((e as ImportError).status).toBe(status); expect((e as ImportError).message).toMatch(text); }
		};
		refuses(utf8("this is not a zip"), 400, /zip/i);
		refuses(new Uint8Array(0), 400, /zip/i);
		refuses(makeZip([{ name: "other.txt", data: utf8("x") }]), 400, /library\.sqlite/);
		refuses(makeZip([{ name: "library.sqlite", data: utf8("not a database at all") }]), 400, /not a Zinc library/);
		const newer = deser(libraryBytes(f));
		newer.query("UPDATE meta SET value = ? WHERE name = 'schema_version'").run(String(SCHEMA_HEAD + 5));
		refuses(makeZip([{ name: "library.sqlite", data: new Uint8Array(newer.serialize()) }]), 409, /newer Zinc/);
		expect(count(db, "SELECT count(*) AS n FROM items")).toBe(0);
		expect(existsSync(join(folder, "storage"))).toBe(false);
	});

	test("a zip that lies about a size is refused by the reader", () => {
		const f = fixture();
		const db = newLibrary().db;
		const zip = makeZip([{ name: "library.sqlite", data: libraryBytes(f) }]);
		const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		// the central directory's uncompressed size claims 2 GB for a stored entry
		let p = -1;
		for (let i = zip.length - 22; i >= 0; i--) if (v.getUint32(i, true) === 0x06054b50) { p = v.getUint32(i + 16, true); break; }
		v.setUint32(p + 24, 0x7fffffff, true);
		expect(() => importBrowserLibrary(db, zip)).toThrow(ImportError);
	});

	test("a failed merge removes the folders it made", () => {
		const f = fixture();
		const db = newLibrary().db;
		const folder = join(dirname((db as unknown as { filename: string }).filename), "storage");
		db.exec("CREATE TRIGGER fail_on_tag BEFORE INSERT ON item_tags BEGIN SELECT RAISE(ABORT, 'no tags today'); END");
		expect(() => importBrowserLibrary(db, f.zip)).toThrow(/no tags today/);
		expect(existsSync(join(folder, f.keys.pdf))).toBe(false);
		expect(count(db, "SELECT count(*) AS n FROM items")).toBe(0);
	});
});

describe("through the host program (the importBrowserLibrary method)", () => {
	test("a zip sent as an upload is merged into the host's library", async () => {
		const f = fixture();
		const hostDb = newLibrary();
		hostDb.db.close(true);
		const h = new HostClient({ ZN_DB: hostDb.path });
		try {
			const r = await h.call("importBrowserLibrary", { bytes: f.zip });
			expect(r.status).toBe(200);
			expect(r.json.topLevelItems).toBe(2);
			expect(r.json.files).toBe(2);
			const bad = await h.call("importBrowserLibrary", { bytes: utf8("nope") });
			expect(bad.status).toBe(400);
			expect(bad.json.error).toMatch(/zip/i);
			const noBody = await h.call("importBrowserLibrary", { json: {} });
			expect(noBody.status).toBe(400);
		} finally {
			await h.close();
		}
		const check = repo.openDb(hostDb.path);
		try {
			expect(count(check, "SELECT count(*) AS n FROM items WHERE key = ?", f.keys.fresh)).toBe(1);
			expect(existsSync(join(dirname(hostDb.path), "storage", f.keys.pdf, "quokka.pdf"))).toBe(true);
		} finally {
			check.close(true);
		}
	}, 60_000);
});
