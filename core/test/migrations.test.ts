import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { LibraryTooNewError, MIGRATIONS, MigrationError, SCHEMA_HEAD, migrate, readSchemaVersion } from "../src/migrations";
import type { Migration } from "../src/migrations";
import schemaSql from "../schema.sql" with { type: "text" };

let dir: string;
let path: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "zn-mig-"));
	path = join(dir, "library.sqlite");
});
afterEach(() => {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// a file still open on Windows: the test run's temp sweep removes it
	}
});

const backups = () =>
	readdirSync(dir)
		.filter((f) => /^library\.backup-v/.test(f))
		.sort();
const version = (db: Database) => (db.query("SELECT value FROM meta WHERE name = 'schema_version'").get() as { value: string }).value;
const itemRows = (db: Database) => db.query("SELECT key, item_type, title, publication, data FROM items ORDER BY key").all();
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** A library as an older build left it: current schema, some items, schema_version = 1. */
function makeV1Library(): void {
	const db = openDb(path);
	for (let i = 0; i < 5; i++) {
		const data = {
			key: `ITEM000${i}`,
			itemType: "journalArticle",
			title: `Paper ${i}`,
			publicationTitle: "Nature",
			tags: [],
			collections: [],
		};
		db.run(
			"INSERT INTO items(key, item_type, title, creators_summary, publication, data, date_added, date_modified, deleted) VALUES(?, 'journalArticle', ?, '', 'Nature', ?, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 0)",
			[data.key, data.title, JSON.stringify(data)],
		);
	}
	db.run("UPDATE meta SET value = '1' WHERE name = 'schema_version'");
	db.close();
}

describe("migration list", () => {
	test("ids run 1..n and SCHEMA_HEAD is the last", () => {
		expect(MIGRATIONS.map((m) => m.id)).toEqual(MIGRATIONS.map((_, i) => i + 1));
		expect(SCHEMA_HEAD).toBe(MIGRATIONS.length);
	});
	test("a list with a gap is rejected", () => {
		const db = new Database(":memory:");
		const noop = (id: number): Migration => ({ id, name: `m${id}`, up() {} });
		expect(() => migrate(db, ":memory:", { migrations: [noop(1), noop(3)] })).toThrow(/1, 2, 3/);
		db.close();
	});
});

describe("fresh library", () => {
	test("is created at the current version, with the whole schema and no backup", () => {
		const db = openDb(path);
		expect(version(db)).toBe(String(SCHEMA_HEAD));
		const names = new Set((db.query("SELECT name FROM sqlite_master").all() as { name: string }[]).map((r) => r.name));
		for (const n of [
			"items",
			"sync_outbox",
			"websync_versions",
			"bbt_keys",
			"items_top_title",
			"items_top_added",
			"sync_items_ai",
			"bbt_dirty_ai",
			"search",
		]) {
			expect(names.has(n)).toBe(true);
		}
		expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
		expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
		expect(backups()).toEqual([]);
		db.close();
	});
});

describe("existing v1 library", () => {
	test("is upgraded to the current version, items untouched, backup made", () => {
		makeV1Library();
		const before = new Database(path);
		const rows = itemRows(before);
		before.close();

		const db = openDb(path);
		expect(version(db)).toBe(String(SCHEMA_HEAD));
		expect(itemRows(db)).toEqual(rows);
		expect((db.query("SELECT count(*) n FROM sync_outbox WHERE key LIKE 'ITEM%'").get() as { n: number }).n).toBeGreaterThanOrEqual(0);
		db.close();

		const files = backups();
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(new RegExp(`^library\\.backup-v1-to-v${SCHEMA_HEAD}-\\d{8}-\\d{6}-\\d{3}\\.sqlite$`));
		const b = new Database(join(dir, files[0]), { readonly: true });
		expect(version(b)).toBe("1"); // the backup is the pre-upgrade state
		expect(itemRows(b)).toEqual(rows);
		expect((b.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
		b.close();
	});

	test("a v1 library made by the Zotero importer (schema.sql only) gets the rest of the baseline", () => {
		const raw = new Database(path);
		raw.exec(schemaSql);
		raw.run("INSERT INTO meta(name, value) VALUES('schema_version', '1')");
		raw.close();
		const db = openDb(path);
		expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'sync_outbox'").get()).not.toBeNull();
		expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'bbt_keys'").get()).not.toBeNull();
		expect(version(db)).toBe(String(SCHEMA_HEAD));
		db.close();
	});

	test("venue migration recomputes publication once, and skips when venue_version is already current", () => {
		makeV1Library();
		const raw = new Database(path);
		raw.run("UPDATE items SET publication = 'stale'");
		raw.close(); // venue_version = 2 is still set: migration 2 must not recompute
		let db = openDb(path);
		expect((db.query("SELECT DISTINCT publication p FROM items").all() as { p: string }[]).map((r) => r.p)).toEqual(["stale"]);
		db.run("UPDATE meta SET value = '1' WHERE name = 'schema_version'");
		db.run("DELETE FROM meta WHERE name = 'venue_version'");
		db.close();
		db = openDb(path);
		expect((db.query("SELECT DISTINCT publication p FROM items").all() as { p: string }[]).map((r) => r.p)).toEqual(["Nature"]);
		db.close();
	});
});

describe("backups", () => {
	test("the last 3 library.backup-v* are kept; other backups are never touched", () => {
		makeV1Library();
		for (const f of [
			"library.backup-v1-to-v2-20200101-000000-000.sqlite",
			"library.backup-v1-to-v2-20200102-000000-000.sqlite",
			"library.backup-v1-to-v2-20200103-000000-000.sqlite",
			"library.backup-v1-to-v2-20200104-000000-000.sqlite",
			"library.backup-gpui-20241103-1200.sqlite",
			"library.backup-websync-20250101.sqlite",
			"library.sqlite.bak",
		]) {
			writeFileSync(join(dir, f), "x");
		}
		openDb(path).close();
		expect(backups().filter((f) => /^library\.backup-v\d/.test(f))).toEqual([
			"library.backup-v1-to-v2-20200103-000000-000.sqlite",
			"library.backup-v1-to-v2-20200104-000000-000.sqlite",
			expect.stringMatching(new RegExp(`^library\\.backup-v1-to-v${SCHEMA_HEAD}-2\\d{7}-\\d{6}-\\d{3}\\.sqlite$`)),
		]);
		for (const f of ["library.backup-gpui-20241103-1200.sqlite", "library.backup-websync-20250101.sqlite", "library.sqlite.bak"]) {
			expect(existsSync(join(dir, f))).toBe(true);
		}
	});
});

describe("failures", () => {
	function atHead(): void {
		openDb(path).close();
	}
	const create = (id: number, name: string, up: Migration["up"]): Migration => ({ id, name, up });

	test("a throwing migration rolls back everything, keeps the backup and names it", () => {
		makeV1Library();
		atHead();
		const db = new Database(path);
		db.run("PRAGMA foreign_keys = ON");
		db.run("UPDATE items SET title = 'edited' WHERE key = 'ITEM0000'");
		const before = itemRows(db);
		const list = [
			...MIGRATIONS,
			create(SCHEMA_HEAD + 1, "adds-a-table", (d) => d.exec("CREATE TABLE half_done(x); INSERT INTO half_done VALUES(1)")),
			create(SCHEMA_HEAD + 2, "explodes", () => {
				throw new Error("boom");
			}),
		];
		let err: unknown;
		try {
			migrate(db, path, { migrations: list });
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(MigrationError);
		const me = err as MigrationError;
		expect(me.migration).toEqual({ id: SCHEMA_HEAD + 2, name: "explodes" });
		expect(me.message).toContain("boom");
		expect(me.backup).toBeDefined();
		expect(me.message).toContain(me.backup!);
		expect(existsSync(me.backup!)).toBe(true);
		// rolled back: version, the earlier migration's table and data are as before
		expect(version(db)).toBe(String(SCHEMA_HEAD));
		expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'half_done'").get()).toBeNull();
		expect(itemRows(db)).toEqual(before);
		expect((db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
		db.close();
		// the library opens normally afterwards
		const again = openDb(path);
		expect(version(again)).toBe(String(SCHEMA_HEAD));
		again.close();
	});

	test("a foreign key violation introduced by a migration rolls back", () => {
		atHead();
		const db = new Database(path);
		const bad = create(SCHEMA_HEAD + 1, "orphans", (d) => d.run("INSERT INTO item_tags(item_key, tag) VALUES('NOSUCHKEY', 't')"));
		db.run("PRAGMA foreign_keys = ON");
		expect(() => migrate(db, path, { migrations: [...MIGRATIONS, bad] })).toThrow(/foreign_key_check/);
		expect(version(db)).toBe(String(SCHEMA_HEAD));
		expect(db.query("SELECT 1 FROM item_tags").get()).toBeNull();
		db.close();
	});

	test("a failing first-ever run (empty file) says no backup was needed", () => {
		const db = new Database(path);
		const list = [
			MIGRATIONS[0],
			create(2, "boom", () => {
				throw new Error("nope");
			}),
		];
		try {
			migrate(db, path, { migrations: list });
			throw new Error("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(MigrationError);
			expect((e as MigrationError).backup).toBeUndefined();
			expect((e as Error).message).toContain("no backup was needed");
		}
		expect(readSchemaVersion(db)).toBe(0);
		expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'items'").get()).toBeNull();
		db.close();
	});
});

describe("newer library", () => {
	test("refuses to open, changes nothing, makes no backup", () => {
		makeV1Library();
		const raw = new Database(path);
		raw.run("UPDATE meta SET value = ? WHERE name = 'schema_version'", [String(SCHEMA_HEAD + 5)]);
		raw.close();
		const hash = sha(path);
		let err: unknown;
		try {
			openDb(path);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(LibraryTooNewError);
		expect((err as Error).message).toMatch(/opened by a newer version/);
		expect(backups()).toEqual([]);
		expect(sha(path)).toBe(hash);
		const check = new Database(path, { readonly: true });
		expect(version(check)).toBe(String(SCHEMA_HEAD + 5)); // not downgraded
		check.close();
	});
});

describe("reopen", () => {
	test("opening a current library again runs nothing and makes no backup", () => {
		makeV1Library();
		openDb(path).close();
		const n = backups().length;
		let ran = 0;
		const spy: Migration[] = MIGRATIONS.map((m) => ({
			...m,
			up: () => {
				ran++;
			},
		}));
		for (let i = 0; i < 3; i++) openDb(path).close();
		const db = new Database(path);
		expect(migrate(db, path, { migrations: spy })).toMatchObject({ applied: [] });
		db.close();
		expect(ran).toBe(0);
		expect(backups()).toHaveLength(n);
	});
});

describe("readers", () => {
	test("a read-only connection never migrates", () => {
		makeV1Library();
		const hash = sha(path);
		const ro = new Database(path, { readonly: true });
		expect((ro.query("SELECT count(*) n FROM items").get() as { n: number }).n).toBe(5);
		expect(version(ro)).toBe("1");
		ro.close();
		expect(version(new Database(path, { readonly: true }))).toBe("1");
		expect(backups()).toEqual([]);
		expect(sha(path)).toBe(hash);
	});

	test("the prefetch worker opens the library read-only and does not call openDb or migrate", () => {
		const src = readFileSync(join(import.meta.dir, "..", "..", "gpui-ui", "src", "prefetch-worker.ts"), "utf8");
		expect(src).toContain("readonly: true");
		expect(src).not.toMatch(/openDb\(|\bmigrate\(|import[^\n]*migrations/);
	});
});
