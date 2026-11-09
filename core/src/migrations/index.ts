// Versioned schema migrations for the library database. openDb(path) calls migrate(db, path); readers (readonly connections,
// the prefetch worker) never do. How to add a migration: list.ts.
//
// What migrate() does
//   - reads meta.schema_version (0 = a new, empty file). Newer than this build knows: throws LibraryTooNewError, changes nothing.
//   - already current: returns without touching the file.
//   - otherwise, for an existing non-empty library, first VACUUMs it INTO library.backup-v<from>-to-v<to>-<time>.sqlite next to the
//     database and keeps the last 3 of those (other files, e.g. library.backup-gpui-*, are never touched);
//   - then, in ONE transaction: runs each pending migration in order (recording meta.schema_version after each), runs
//     PRAGMA integrity_check and PRAGMA foreign_key_check, and commits. Any throw or failed check rolls everything back, so the
//     file is unchanged, and a MigrationError naming the backup is raised.
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { MIGRATIONS, SCHEMA_HEAD } from "./list";
import { LibraryTooNewError, MigrationError } from "./types";
import type { MigrateOptions, MigrateResult, Migration } from "./types";

export { MIGRATIONS, SCHEMA_HEAD };
export { LibraryTooNewError, MigrationError };
export type { MigrateOptions, MigrateResult, Migration };

const DEFAULT_KEEP = 3;

/**
 * Backups are named after the database file they come from: <stem>.backup-v<from>-to-v<to>-<time>.sqlite. The default
 * library.sqlite gives the long-standing library.backup-v... names. Rotation only looks at the same stem, so several library
 * files in one folder never delete each other's backups.
 */
function backupStem(path: string): string {
	const base = basename(path).replace(/\.(sqlite3?|db)$/i, "");
	const safe = base.replace(/[^A-Za-z0-9._ -]/g, "_").trim();
	return safe && safe !== "." && safe !== ".." ? safe : "library";
}

function backupRe(stem: string): RegExp {
	const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${esc}\\.backup-v(\\d+)-to-v(\\d+)-(\\d{8}-\\d{6}-\\d{3}(?:-\\d+)?)\\.sqlite$`);
}

/** meta.schema_version of an open library; 0 when there is none (a new file). */
export function readSchemaVersion(db: Database): number {
	if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()) return 0;
	const row = db.query("SELECT value FROM meta WHERE name = 'schema_version'").get() as { value: string } | null;
	if (!row) return 0;
	if (!/^\d+$/.test(row.value)) throw new MigrationError(`The library's schema_version (${JSON.stringify(row.value)}) is not a number.`, undefined);
	return Number(row.value);
}

function checkList(list: readonly Migration[]): void {
	if (list.length === 0) throw new Error("no migrations defined");
	list.forEach((m, i) => {
		if (m.id !== i + 1) throw new Error(`migration ids must be 1, 2, 3 ... in order: found ${m.id} ("${m.name}") at position ${i + 1}`);
	});
}

/** The migrations still to run for a library recorded at version `at`. */
function pendingFrom(list: readonly Migration[], at: number): Migration[] {
	const todo = list.filter((m) => m.id > at);
	if (todo.length === 0) return todo;
	const again = list.find((m) => m.id === at && m.reapply);
	return again ? [again, ...todo] : todo;
}

function hasData(db: Database): boolean {
	if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'items'").get()) return false;
	return !!db.query("SELECT 1 FROM items LIMIT 1").get();
}

function stamp(d: Date): string {
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(), 3)}`;
}

/** Keeps the newest `keep` library.backup-v*-to-v*-*.sqlite files in `dir`; deletes only files of exactly that shape. */
function rotateBackups(dir: string, keep: number, stem: string): void {
	const re = backupRe(stem);
	const found = readdirSync(dir)
		.map((f) => ({ f, m: re.exec(f) }))
		.filter((x): x is { f: string; m: RegExpExecArray } => !!x.m)
		.sort((a, b) => (a.m[3] < b.m[3] ? 1 : a.m[3] > b.m[3] ? -1 : 0));
	for (const old of found.slice(Math.max(keep, 1))) {
		try {
			rmSync(join(dir, old.f), { force: true });
		} catch {
			// best effort: a locked old backup is retried at the next upgrade
		}
	}
}

function backup(db: Database, path: string, from: number, to: number, now: Date, keep: number): string {
	const dir = dirname(path);
	const stem = backupStem(path);
	// never reuse (and so never delete) the name of a backup that already exists
	let out = join(dir, `${stem}.backup-v${from}-to-v${to}-${stamp(now)}.sqlite`);
	for (let n = 2; existsSync(out); n++) out = join(dir, `${stem}.backup-v${from}-to-v${to}-${stamp(now)}-${n}.sqlite`);
	try {
		db.run("VACUUM INTO ?", [out]);
	} catch (e) {
		try {
			rmSync(out, { force: true }); // only a partial file this call may have created: the name was free above
		} catch {
			// nothing to clean up
		}
		throw new MigrationError(
			`The library was not upgraded: the backup before the upgrade (v${from} to v${to}) could not be made at ${out} (${(e as Error).message}). The library has not been changed.`,
			undefined,
			undefined,
			{ cause: e },
		);
	}
	rotateBackups(dir, keep, stem);
	return out;
}

function integrityProblem(db: Database): string | null {
	const rows = db.query("PRAGMA integrity_check").all() as { integrity_check: string }[];
	if (rows.length === 1 && rows[0].integrity_check === "ok") return null;
	return `integrity_check: ${rows.slice(0, 5).map((r) => r.integrity_check).join("; ")}`;
}

const fkViolations = (db: Database): number => db.query("PRAGMA foreign_key_check").all().length;

/**
 * Brings the library to SCHEMA_HEAD. `path` is the database file (for the backup; a ":memory:" library is never backed up).
 * Throws LibraryTooNewError or MigrationError; in both cases the file is unchanged (apart from a backup that was made).
 */
export function migrate(db: Database, path: string, opts: MigrateOptions = {}): MigrateResult {
	const list = opts.migrations ?? MIGRATIONS;
	checkList(list);
	const head = list[list.length - 1].id;
	db.exec("PRAGMA busy_timeout = 5000");

	const from = readSchemaVersion(db);
	if (from > head) throw new LibraryTooNewError(from, head);
	if (from === head) return { from, to: head, applied: [] };

	let backupPath: string | undefined;
	if ((from > 0 || hasData(db)) && path && path !== ":memory:" && existsSync(path)) {
		backupPath = backup(db, path, from, head, (opts.now ?? (() => new Date()))(), opts.keepBackups ?? DEFAULT_KEEP);
	}

	// journal_mode and foreign_keys cannot change inside a transaction. Foreign keys stay off while migrations run (table rebuilds),
	// and are checked before the commit.
	db.exec("PRAGMA journal_mode = WAL");
	const fkWas = (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
	db.exec("PRAGMA foreign_keys = OFF");

	let current: Migration | undefined;
	const applied: number[] = [];
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			// another process may have migrated (or upgraded past us) while we waited for the write lock
			const at = readSchemaVersion(db);
			if (at > head) throw new LibraryTooNewError(at, head);
			const todo = pendingFrom(list, at);
			if (todo.length === 0) {
				db.exec("COMMIT");
				return { from, to: at, applied, backup: backupPath };
			}
			const fkBefore = fkViolations(db);
			for (const m of todo) {
				current = m;
				m.up(db);
				db.run("INSERT INTO meta(name, value) VALUES('schema_version', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", [
					String(m.id),
				]);
				applied.push(m.id);
			}
			current = undefined;
			const bad = integrityProblem(db);
			if (bad) throw new Error(bad);
			const fkAfter = fkViolations(db);
			if (fkAfter > fkBefore) throw new Error(`foreign_key_check: ${fkAfter - fkBefore} new violation(s)`);
			db.exec("COMMIT");
		} catch (e) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// no transaction left to roll back
			}
			throw e;
		}
	} catch (e) {
		if (e instanceof LibraryTooNewError) throw e;
		const where = current ? `migration ${current.id} "${current.name}"` : "the checks after the migrations";
		const kept = backupPath ? `A backup from before the upgrade is at ${backupPath}.` : "The library was empty, so no backup was needed.";
		throw new MigrationError(
			`The library could not be upgraded to version ${head}: ${where} failed (${(e as Error).message}). Everything was rolled back, so the library is unchanged. ${kept}`,
			backupPath,
			current ? { id: current.id, name: current.name } : undefined,
			{ cause: e },
		);
	} finally {
		db.exec(`PRAGMA foreign_keys = ${fkWas ? "ON" : "OFF"}`);
	}
	return { from, to: head, applied, backup: backupPath };
}
