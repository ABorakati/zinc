// Auto-export: keep a Better BibTeX/BibLaTeX/CSL file on disk in sync with a library or collection.
//
// The export list lives in bbt_autoexport. A scheduler polls bbt_state.changes (bumped by SQL triggers on every item /
// collection write, from any writer), waits for the quiet period of each export ("change": settings.autoExportDelay
// seconds after the last change, "idle": settings.autoExportIdle seconds), re-renders, and writes the file atomically
// (temp file in the same folder, then rename) only when the text actually changed.
import type { Database } from "bun:sqlite";
import { mkdirSync, renameSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { HttpError } from "../db";
import { gatherItems } from "../io/export";
import { exportBetterFormat, isBbtFormat } from "./export";
import { getSettings } from "./settings";
import type { AutoExport, AutoExportOptions, AutoExportScope, BbtExportFormat } from "./types";

interface Row {
	id: number;
	path: string;
	format: string;
	scope_type: string;
	scope_key: string | null;
	trigger: string;
	options: string;
	status: string;
	error: string | null;
	last_export: string | null;
	count: number | null;
	hash: string | null;
}

function toExport(db: Database, r: Row): AutoExport {
	let scopeName = "My Library";
	if (r.scope_type === "collection") {
		const c = db.query("SELECT name FROM collections WHERE key = ?").get(r.scope_key) as { name: string } | null;
		scopeName = c?.name ?? "(deleted collection)";
	}
	return {
		id: r.id,
		path: r.path,
		format: r.format as BbtExportFormat,
		scope: { type: r.scope_type as "library" | "collection", ...(r.scope_key ? { key: r.scope_key } : {}) },
		trigger: r.trigger === "idle" ? "idle" : "change",
		options: JSON.parse(r.options || "{}") as AutoExportOptions,
		status: r.status as AutoExport["status"],
		error: r.error,
		lastExport: r.last_export,
		count: r.count,
		scopeName,
	};
}

export function listAutoExports(db: Database): AutoExport[] {
	return (db.query("SELECT * FROM bbt_autoexport ORDER BY id").all() as Row[]).map((r) => toExport(db, r));
}

function getRow(db: Database, id: number): Row {
	const r = db.query("SELECT * FROM bbt_autoexport WHERE id = ?").get(id) as Row | null;
	if (!r) throw new HttpError(404, "auto-export not found");
	return r;
}

export function addAutoExport(
	db: Database,
	a: { path: string; format: string; scope: AutoExportScope; trigger?: "change" | "idle"; options?: AutoExportOptions },
): AutoExport {
	if (!isBbtFormat(a.format)) throw new HttpError(400, "format must be betterbibtex, betterbiblatex, bettercsljson or bettercslyaml");
	if (typeof a.path !== "string" || !a.path.trim()) throw new HttpError(400, "path is required");
	if (!isAbsolute(a.path)) throw new HttpError(400, "path must be an absolute file path");
	const scope = a.scope ?? { type: "library" };
	if (scope.type !== "library" && scope.type !== "collection") throw new HttpError(400, "scope.type must be library or collection");
	if (scope.type === "collection") {
		if (!scope.key || !db.query("SELECT 1 FROM collections WHERE key = ?").get(scope.key)) throw new HttpError(404, "collection not found");
	}
	const trigger = a.trigger === "idle" ? "idle" : "change";
	const id = Number(
		db
			.query("INSERT INTO bbt_autoexport(path, format, scope_type, scope_key, trigger, options, status) VALUES(?, ?, ?, ?, ?, ?, 'pending')")
			.run(resolve(a.path), a.format, scope.type, scope.type === "collection" ? scope.key! : null, trigger, JSON.stringify(a.options ?? {})).lastInsertRowid,
	);
	return runAutoExport(db, id);
}

export function removeAutoExport(db: Database, id: number): boolean {
	return db.query("DELETE FROM bbt_autoexport WHERE id = ?").run(id).changes > 0;
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/** Atomic write: temp file in the target folder, then rename over the destination. */
export function writeFileAtomic(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `.${Math.random().toString(36).slice(2)}.bbt-tmp`);
	try {
		writeFileSync(tmp, text);
		renameSync(tmp, path);
	} catch (e) {
		rmSync(tmp, { force: true });
		throw e;
	}
}

/** Render the export now and write the file when its text changed (or the file is gone). */
export function runAutoExport(db: Database, id: number): AutoExport {
	const r = getRow(db, id);
	db.query("UPDATE bbt_autoexport SET status = 'running' WHERE id = ?").run(id);
	try {
		const opts = JSON.parse(r.options || "{}") as AutoExportOptions;
		const scope = r.scope_type === "collection" ? { collectionKey: r.scope_key! } : {};
		const items = gatherItems(db, { format: "bibtex", includeNotes: !!opts.includeNotes, ...scope });
		const text = exportBetterFormat(db, r.format as BbtExportFormat, items, { ascii: opts.ascii, includeNotes: opts.includeNotes });
		const hash = Bun.hash(text).toString(36);
		if (hash !== r.hash || !existsSync(r.path) || readFileSync(r.path, "utf8") !== text) writeFileAtomic(r.path, text);
		db.query("UPDATE bbt_autoexport SET status = 'done', error = NULL, last_export = ?, count = ?, hash = ? WHERE id = ?").run(nowIso(), items.length, hash, id);
	} catch (e) {
		db.query("UPDATE bbt_autoexport SET status = 'error', error = ? WHERE id = ?").run(e instanceof Error ? e.message : String(e), id);
	}
	return toExport(db, getRow(db, id));
}

export interface SchedulerOptions {
	/** how often to look for changes (ms) */
	pollMs?: number;
	/** run every export once at start */
	runAtStart?: boolean;
}

/** Start the scheduler for this database. Returns stop(). */
export function startAutoExport(db: Database, o: SchedulerOptions = {}): { stop(): void; tick(now?: number): void } {
	let seen = readChanges(db);
	const due = new Map<number, number>(); // export id -> time it should run
	const schedule = (now: number) => {
		const st = getSettings(db);
		for (const r of db.query("SELECT id, trigger FROM bbt_autoexport").all() as { id: number; trigger: string }[]) {
			due.set(r.id, now + (r.trigger === "idle" ? st.autoExportIdle : st.autoExportDelay) * 1000);
			db.query("UPDATE bbt_autoexport SET status = 'pending' WHERE id = ? AND status <> 'error'").run(r.id);
		}
	};
	const tick = (now = Date.now()) => {
		const cur = readChanges(db);
		if (cur !== seen) {
			seen = cur;
			schedule(now);
		}
		for (const [id, at] of [...due]) {
			if (at > now) continue;
			due.delete(id);
			if (db.query("SELECT 1 FROM bbt_autoexport WHERE id = ?").get(id)) runAutoExport(db, id);
		}
	};
	if (o.runAtStart !== false) {
		for (const r of db.query("SELECT id FROM bbt_autoexport").all() as { id: number }[]) due.set(r.id, Date.now());
	}
	const timer = setInterval(() => {
		try {
			tick();
		} catch (e) {
			console.error("[bbt] auto-export:", e);
		}
	}, o.pollMs ?? 1000);
	(timer as { unref?: () => void }).unref?.();
	return { stop: () => clearInterval(timer), tick };
}

function readChanges(db: Database): number {
	return (db.query("SELECT value FROM bbt_state WHERE name = 'changes'").get() as { value: number } | null)?.value ?? 0;
}
