import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectLibraryFile } from "./libraryFile";
import { canImport, describeZotero, progressFraction, progressText, type ZoteroFound } from "./logic";

const zotero = (over: Partial<ZoteroFound> = {}): ZoteroFound => ({
	dir: "D:/Zotero", hasDatabase: true, readable: true, itemCount: 12419, collectionCount: 310, attachmentCount: 9882, ...over,
});

describe("progress", () => {
	test("text per phase, and the item count with separators", () => {
		expect(progressText(null)).toBe("Starting…");
		expect(progressText({ phase: "snapshot" })).toContain("Copying your Zotero database");
		expect(progressText({ phase: "items", done: 1500, total: 12419 })).toBe("Importing items: 1,500 of 12,419");
		expect(progressText({ phase: "other", message: "hello" })).toBe("hello");
	});
	test("the bar only moves forward through the phases and ends the item phase at 90%", () => {
		const f = (phase: string, done?: number, total?: number) => progressFraction({ phase, done, total });
		const seq = [f("snapshot"), f("read"), f("write"), f("items", 0, 1000), f("items", 500, 1000), f("items", 1000, 1000), f("annotations"), f("fulltext")];
		expect(seq).toEqual([...seq].sort((a, b) => a - b));
		expect(f("items", 1000, 1000)).toBeCloseTo(0.9, 5);
		expect(progressFraction(null)).toBe(0);
		expect(f("items", 5000, 1000)).toBeLessThanOrEqual(0.9 + 1e-9); // never past the end
	});
});

describe("describing Zotero", () => {
	test("a readable library", () => {
		expect(describeZotero(zotero())).toBe("12,419 items, 310 collections and 9,882 attachments");
		expect(describeZotero(zotero({ itemCount: 1, collectionCount: 0, attachmentCount: 0 }))).toBe("1 item");
	});
	test("not found / no database / unreadable", () => {
		expect(describeZotero(null)).toContain("not found");
		expect(describeZotero(zotero({ hasDatabase: false }))).toContain("no Zotero library");
		expect(describeZotero(zotero({ readable: false, error: "locked" }))).toBe("locked");
	});
	test("only a readable library with a database can be imported", () => {
		expect(canImport(zotero())).toBe(true);
		expect(canImport(zotero({ readable: false }))).toBe(false);
		expect(canImport(zotero({ hasDatabase: false }))).toBe(false);
		expect(canImport(null)).toBe(false);
	});
});

describe("inspectLibraryFile", () => {
	const dir = mkdtempSync(join(tmpdir(), "zn-libfile-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const make = (name: string, sql: string) => {
		const p = join(dir, name);
		const db = new Database(p, { create: true });
		db.exec(sql);
		db.close();
		return p;
	};

	test("a zotero-next library", () => {
		const p = make("zn.sqlite", `CREATE TABLE items (key TEXT, parent_key TEXT, deleted INTEGER); CREATE TABLE attachments (item_key TEXT); CREATE TABLE collections (key TEXT);
			INSERT INTO items VALUES ('A', NULL, 0), ('B', 'A', 0), ('C', NULL, 1), ('D', NULL, 0);`);
		expect(inspectLibraryFile(p)).toEqual({ kind: "zotero-next", items: 2 });
	});
	test("Zotero's own database is recognised and refused with a pointer to the importer", () => {
		const p = make("zotero.sqlite", "CREATE TABLE itemTypes (itemTypeID INTEGER); CREATE TABLE libraries (libraryID INTEGER);");
		const r = inspectLibraryFile(p);
		expect(r.kind).toBe("zotero");
		expect(r.problem).toContain("Import from Zotero");
	});
	test("other databases, missing files and non-databases", () => {
		expect(inspectLibraryFile(make("other.sqlite", "CREATE TABLE t (x)")).kind).toBe("unknown");
		expect(inspectLibraryFile(join(dir, "nope.sqlite")).kind).toBe("missing");
		const junk = join(dir, "junk.sqlite");
		writeFileSync(junk, "this is not a database at all, just text".repeat(10));
		expect(inspectLibraryFile(junk).kind).toBe("unreadable");
		mkdirSync(join(dir, "folder.sqlite"));
		expect(["unreadable", "unknown"]).toContain(inspectLibraryFile(join(dir, "folder.sqlite")).kind);
	});
});
