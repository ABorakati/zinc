// Review finding GPT #13: backups are named after their database, rotated per database, and never replace an existing file.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { migrate } from "../src/migrations";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "zn-migbk-"));
});
afterEach(() => {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// a file still open on Windows: the temp sweep removes it
	}
});

function makeV1(file: string): string {
	const p = join(dir, file);
	const db = openDb(p);
	db.run(
		"INSERT INTO items(key, item_type, title, creators_summary, publication, data, date_added, date_modified, deleted) VALUES('ITEM0001', 'journalArticle', 'T', '', '', '{}', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 0)",
	);
	db.run("UPDATE meta SET value = '1' WHERE name = 'schema_version'");
	db.close();
	return p;
}

describe("migration backups", () => {
	test("libraries in one folder rotate separately, and the name says which library a backup is of", () => {
		const a = makeV1("alpha.sqlite");
		const b = makeV1("beta.sqlite");
		for (const stem of ["alpha", "beta"]) {
			for (const d of ["01", "02", "03"])
				writeFileSync(join(dir, `${stem}.backup-v1-to-v2-202001${d}-000000-000.sqlite`), `old ${stem}`);
		}
		openDb(a).close();
		openDb(b).close();
		const files = readdirSync(dir);
		for (const stem of ["alpha", "beta"]) {
			const mine = files.filter((f) => f.startsWith(`${stem}.backup-v`)).sort();
			expect(mine).toHaveLength(3); // 3 kept: the two newest old ones and the new one
			expect(mine[0]).toBe(`${stem}.backup-v1-to-v2-20200102-000000-000.sqlite`);
			expect(mine[2]).toMatch(/^[a-z]+\.backup-v1-to-v\d+-2\d{7}-\d{6}-\d{3}\.sqlite$/);
			expect(readFileSync(join(dir, mine[1]), "utf8")).toBe(`old ${stem}`); // the other library's upgrade did not touch it
		}
		expect(files.filter((f) => f.startsWith("library.backup-"))).toEqual([]);
	});

	test("an existing backup is never deleted or overwritten: a clashing name gets a suffix", () => {
		const p = makeV1("library.sqlite");
		const when = new Date(Date.UTC(2031, 0, 2, 3, 4, 5, 6));
		const clash = join(dir, "library.backup-v1-to-v2-20310102-030405-006.sqlite");
		// the same name the upgrade would pick for v1 -> head
		const db = new Database(p);
		const res = migrate(db, p, { now: () => when });
		db.close();
		expect(res.backup).toBeDefined();
		const head = res.to;
		const planned = join(dir, `library.backup-v1-to-v${head}-20310102-030405-006.sqlite`);
		expect(existsSync(planned)).toBe(true);

		// second run: downgrade the marker again, same clock; the earlier backup must survive untouched
		const sizeBefore = readFileSync(planned).length;
		const again = new Database(p);
		again.run("UPDATE meta SET value = '1' WHERE name = 'schema_version'");
		const r2 = migrate(again, p, { now: () => when });
		again.close();
		expect(r2.backup).not.toBe(planned);
		expect(r2.backup).toMatch(/-006-2\.sqlite$/);
		expect(readFileSync(planned).length).toBe(sizeBefore);
		void clash;
	});
});
