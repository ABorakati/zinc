// Import into the browser library, and export from it (runs in db-worker.ts, called by dispatch.ts for /api/browser/*).
//
// The tab reads the folder the user picked (web/browser-db/welcome-import.ts) and sends every file here with
//   PUT /api/browser/import/file?path=<zotero|zinc>/<relative path>      (the body is the file; large bodies travel as `up` frames)
// The files land under /opfs/zinc/import/ (the durable file store: they survive the tab closing mid-import and are not in memory).
//   POST /api/browser/import/run {kind}        runs the import, answers the summary; deletes the temporary copy
//   GET  /api/browser/import/status            progress while it runs (the importer yields to the event loop between phases)
//   DELETE /api/browser/import                 throws the temporary copy away (a cancelled import)
//   GET  /api/browser/state                    {items, collections}: is the library empty (the welcome screen's condition)
//   GET  /api/browser/export                   the library as one zip (export-zip.ts)
//
// Zotero data folder: the core's importer (core/src/import/zotero.ts) runs unchanged. The web SQLite shim (web/sqlite.ts) lets it read
// zotero.sqlite from the file store and build its output database in memory, which is then kept as a file (the shim's close hook);
// its rows are copied into the open library and the attachment files move into /opfs/zinc/storage/<KEY>/ (the layout the core uses).
// Zinc library folder: the rows of library.sqlite are copied the same way. Nothing is merged into a library that already has data.
import type { Database as CoreDb } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Database, dropDatabaseImages, setDatabaseHooks } from "../sqlite";
import { exportLibraryZip } from "./export-zip";

export const IMPORT_ROOT = "/opfs/zinc/import";
/** Where the core keeps imported files: next to the library, <library folder>/storage/<KEY>/<name>. */
export const STORAGE_ROOT = "/opfs/zinc/storage";

export interface ImportState {
	running: boolean;
	/** the importer's phases (snapshot, read, write, items, annotations, fulltext) and this module's (copy, files, finish) */
	phase: string;
	done?: number;
	total?: number;
	message?: string;
	error?: string;
	result?: ImportResult;
}
export interface ImportResult {
	kind: "zotero" | "zinc";
	items: number;
	topLevelItems: number;
	collections: number;
	attachments: number;
	annotations: number;
	/** attachment folders (<KEY>/) moved into the library's storage */
	fileFolders: number;
	/** imported attachments whose file was not in the folder (or is a linked file: those stay where they were) */
	missingFiles: number;
	linkedFiles: number;
	warnings: string[];
	ms: number;
}

let state: ImportState = { running: false, phase: "idle" };
export const importState = (): ImportState => state;

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fail = (status: number, error: string): never => { throw Object.assign(new Error(error), { status }); };
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A path the tab sent: <kind>/<segments>, nothing that climbs out of the import folder. */
function safeRel(p: string | null): string {
	if (!p) return fail(400, "path is required");
	const parts = p.split("/");
	if (parts.length < 2 || (parts[0] !== "zotero" && parts[0] !== "zinc") || parts.some((s) => !s || s === "." || s === ".." || s.includes("\\") || s.includes("\0"))) return fail(400, "malformed path");
	return parts.join("/");
}

export async function browserApi(req: Request, url: URL, db: CoreDb): Promise<Response> {
	const route = url.pathname.slice("/api/browser".length).replace(/\/+$/, "");
	try {
		if (route === "/state" && req.method === "GET") {
			const n = db.query("SELECT (SELECT count(*) FROM items) AS items, (SELECT count(*) FROM collections) AS collections").get() as { items: number; collections: number };
			// leftover: is a temporary import copy still there (the headless check)
			return json({ ...n, leftover: existsSync(IMPORT_ROOT) });
		}
		if (route === "/import/file" && req.method === "PUT") {
			const rel = safeRel(url.searchParams.get("path"));
			const bytes = new Uint8Array(await req.arrayBuffer());
			writeFileSync(`${IMPORT_ROOT}/${rel}`, bytes);
			return json({ ok: true, size: bytes.length });
		}
		if (route === "/import/status" && req.method === "GET") return json(state);
		if (route === "/import" && req.method === "DELETE") {
			if (state.running) fail(409, "an import is running");
			rmSync(IMPORT_ROOT);
			state = { running: false, phase: "idle" };
			return json({ ok: true });
		}
		if (route === "/import/run" && req.method === "POST") {
			const body = (await req.json().catch(() => ({}))) as { kind?: string };
			if (body.kind !== "zotero" && body.kind !== "zinc") return fail(400, 'kind must be "zotero" or "zinc"');
			if (state.running) return fail(409, "an import is already running");
			return json(await runImport(db, body.kind));
		}
		if (route === "/export" && req.method === "GET") {
			const z = exportLibraryZip(db);
			return new Response(z.bytes as BlobPart, { status: 200, headers: { "Content-Type": "application/zip", "X-Zinc-Export": JSON.stringify(z.summary) } });
		}
		return json({ error: "not found" }, 404);
	} catch (e) {
		const status = (e as { status?: number }).status ?? 500;
		if (status >= 500) console.error("[browser-db] /api/browser failed:", e);
		return json({ error: e instanceof Error ? e.message : String(e) }, status);
	}
}

// ---- the copy of a library's rows into the open one

/** The tables that carry the user's data (the same list for both sources). Everything else is this machine's state (sync, view positions, search indexes). */
const DATA_TABLES = ["collections", "items", "collection_items", "item_tags", "attachments", "annotations", "fulltext", "saved_searches", "duplicate_exclusions", "bbt_keys"];
/** meta rows that are the library's own (the rest is schema bookkeeping and this machine's state). */
const META_KEEP = ["tagColors", "zotero_import_at"];

const tableCols = (d: { query(s: string): { all(): unknown[] } }, t: string): string[] => (d.query(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name);
const hasTable = (d: { query(s: string): { get(...a: unknown[]): unknown } }, t: string): boolean => !!d.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

/** Copy the rows of `src` into `dst` (one transaction, sync triggers off): the columns both have, so a library from an older or newer schema still goes in. */
function copyRows(src: CoreDb, dst: CoreDb): Record<string, number> {
	const copied: Record<string, number> = {};
	const run = dst.transaction(() => {
		dst.exec("PRAGMA defer_foreign_keys = ON");
		// the changes below are not edits to send to zotero.org (the same flag the pull uses)
		const flagged = hasTable(dst, "sync_flags");
		if (flagged) dst.exec("INSERT OR IGNORE INTO sync_flags(name) VALUES('suppress')");
		try {
			for (const t of DATA_TABLES) {
				if (!hasTable(src, t) || !hasTable(dst, t)) continue;
				const have = new Set(tableCols(dst, t));
				const cols = tableCols(src, t).filter((c) => have.has(c));
				if (!cols.length) continue;
				const list = cols.map((c) => `"${c}"`).join(", ");
				const ins = dst.prepare(`INSERT OR IGNORE INTO "${t}" (${list}) VALUES (${cols.map(() => "?").join(", ")})`);
				let n = 0;
				for (const row of src.query(`SELECT ${list} FROM "${t}"`).iterate() as Iterable<Record<string, unknown>>) {
					ins.run(...cols.map((c) => row[c] as never));
					n++;
				}
				ins.finalize();
				copied[t] = n;
			}
			// group libraries (the rows of `libraries` other than My Library): so a group's items have somewhere to belong
			if (hasTable(src, "libraries") && hasTable(dst, "libraries")) {
				const have = new Set(tableCols(dst, "libraries"));
				const cols = tableCols(src, "libraries").filter((c) => have.has(c) && !/version$/.test(c));
				const list = cols.map((c) => `"${c}"`).join(", ");
				const ins = dst.prepare(`INSERT OR IGNORE INTO libraries (${list}) VALUES (${cols.map(() => "?").join(", ")})`);
				for (const row of src.query(`SELECT ${list} FROM libraries WHERE id <> 1`).iterate() as Iterable<Record<string, unknown>>) ins.run(...cols.map((c) => row[c] as never));
				ins.finalize();
			}
			if (hasTable(src, "meta")) {
				for (const name of META_KEEP) {
					const m = src.query("SELECT value FROM meta WHERE name = ?").get(name) as { value: string } | null;
					if (m) dst.query("INSERT INTO meta(name, value) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(name, m.value);
				}
			}
		} finally {
			if (flagged) dst.exec("DELETE FROM sync_flags WHERE name = 'suppress'");
		}
	});
	run();
	return copied;
}

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? "";

/**
 * Imported files: an attachment row that keeps a file (imported_file / imported_url) is pointed at <STORAGE_ROOT>/<KEY>/<name>, and the
 * folder <KEY>/ moves there (it may hold more than the one file: a snapshot's assets, the full-text cache). A row whose file was not in the
 * folder keeps its old path: the item shows no file, as in the app.
 */
function relocateFiles(dst: CoreDb, from: string, keys: string[]): { moved: number; missing: number; linked: number } {
	let moved = 0;
	let missing = 0;
	let linked = 0;
	const set: { key: string; path: string }[] = [];
	const rows = dst.query("SELECT item_key AS key, link_mode AS mode, path FROM attachments WHERE item_key = ?");
	for (const key of keys) {
		const r = rows.get(key) as { key: string; mode: string; path: string | null } | null;
		if (!r) continue;
		if (r.mode === "linked_file") { linked++; continue; }
		if (r.mode !== "imported_file" && r.mode !== "imported_url") continue;
		const name = r.path ? baseName(r.path) : "";
		if (!name || !existsSync(`${from}/storage/${key}/${name}`)) { missing++; continue; }
		set.push({ key, path: `${STORAGE_ROOT}/${key}/${name}` });
	}
	mkdirSync(STORAGE_ROOT);
	for (const s of set) {
		const target = `${STORAGE_ROOT}/${s.key}`;
		if (existsSync(target)) continue; // a folder the library already has for that key: left alone
		renameSync(`${from}/storage/${s.key}`, target);
		moved++;
	}
	const up = dst.query("UPDATE attachments SET path = ? WHERE item_key = ?");
	dst.transaction(() => {
		const flagged = hasTable(dst, "sync_flags");
		if (flagged) dst.exec("INSERT OR IGNORE INTO sync_flags(name) VALUES('suppress')");
		try { for (const s of set) up.run(s.path, s.key); } finally { if (flagged) dst.exec("DELETE FROM sync_flags WHERE name = 'suppress'"); }
	})();
	return { moved, missing, linked };
}

/** Zotero's own full-text caches (storage/<KEY>/.zotero-ft-cache), into `fulltext` as the importer does. Runs before the folders move, so `from` still holds them. */
async function readFulltextCaches(db: CoreDb, from: string, keys: string[]): Promise<number> {
	const have = db.query("SELECT 1 FROM fulltext WHERE attachment_key = ?");
	const ins = db.query("INSERT OR REPLACE INTO fulltext (attachment_key, content, source, indexed_at) VALUES (?, ?, 'zotero-cache', ?)");
	const now = new Date().toISOString();
	let n = 0;
	for (const key of keys) {
		const f = `${from}/storage/${key}/.zotero-ft-cache`;
		if (have.get(key) || !existsSync(f)) continue;
		let text = "";
		try { text = readFileSync(f, "utf8") as string; } catch { continue; }
		if (!text.trim()) continue;
		ins.run(key, text, now);
		n++;
	}
	return n;
}

// ---- running an import

async function runImport(db: CoreDb, kind: "zotero" | "zinc"): Promise<ImportResult> {
	const started = Date.now();
	const empty = db.query("SELECT (SELECT count(*) FROM items) + (SELECT count(*) FROM collections) AS n").get() as { n: number };
	if (empty.n > 0) fail(409, "The library already has items. Import is for an empty library.");
	const dir = `${IMPORT_ROOT}/${kind}`;
	const main = `${dir}/${kind === "zotero" ? "zotero.sqlite" : "library.sqlite"}`;
	if (!existsSync(main)) fail(400, `${kind === "zotero" ? "zotero.sqlite" : "library.sqlite"} was not sent`);
	state = { running: true, phase: "snapshot", message: "Reading the database" };
	const warnings: string[] = [];
	let src: CoreDb | null = null;
	try {
		// databases opened from the files this module wrote: the shim reads their bytes through the fs shim, and keeps a built one on close
		setDatabaseHooks({
			resolve: (p) => (p.startsWith(`${IMPORT_ROOT}/`) && existsSync(p) ? (readFileSync(p) as Uint8Array) : undefined),
			sink: (p, bytes) => writeFileSync(p, bytes),
		});
		await tick();
		let report: { counts?: { fulltext?: number }; skipped?: Record<string, number>; missingFiles?: { total: number } } | null = null;
		let from = dir;
		let srcPath = main;
		if (kind === "zotero") {
			const { importZotero } = await import("../../../core/src/import/zotero");
			srcPath = `${IMPORT_ROOT}/out/library.sqlite`;
			report = await importZotero({
				zoteroDir: dir,
				targetDbPath: srcPath,
				// nothing outside the folder the user picked is looked at: no base-attachment pref, no fallback search of the disk
				baseAttachmentPath: "",
				searchRoots: false,
				fuzzyMatch: false,
				replace: true,
				onProgress: (p) => { state = { ...state, running: true, phase: p.phase, done: p.done, total: p.total, message: p.message }; },
			});
		} else {
			// a library written by a newer Zinc than this build understands is refused (its schema may carry things this build would drop)
			const wal = `${main}-wal`;
			if (existsSync(wal) && statSync(wal).size > 0) warnings.push("library.sqlite-wal was not empty: changes Zinc had not yet written into library.sqlite are not in this import. Close Zinc and import again to include them.");
		}
		state = { ...state, running: true, phase: "copy", done: undefined, total: undefined, message: "Copying into the browser library" };
		await tick();
		src = new Database(srcPath) as unknown as CoreDb;
		if (!hasTable(src, "items") || !hasTable(src, "meta")) fail(400, "That file is not a Zinc library.");
		if (kind === "zinc") {
			const { SCHEMA_HEAD } = await import("../../../core/src/migrations");
			const v = Number((src.query("SELECT value FROM meta WHERE name = 'schema_version'").get() as { value: string } | null)?.value ?? 0);
			if (v > SCHEMA_HEAD) fail(400, `That library was made by a newer version of Zinc (schema ${v}); this one understands up to ${SCHEMA_HEAD}.`);
		}
		const copied = copyRows(src, db);
		const keys = (src.query("SELECT item_key AS key FROM attachments").all() as { key: string }[]).map((r) => r.key);
		src.close();
		src = null;
		await tick();
		state = { ...state, phase: "files", message: "Moving attachment files" };
		// The importer lists storage/ to find Zotero's full-text caches, and the file store lists folders in lower case ("att00001"), so it
		// never matches a KEY: the caches are read here instead (the same rule: a non-empty .zotero-ft-cache of an attachment).
		if (kind === "zotero") await readFulltextCaches(db, from, keys);
		const files = relocateFiles(db, from, keys);
		state = { ...state, phase: "finish", message: "Building the search index" };
		await tick();
		const { rebuildSearchIndex } = await import("../../../core/src/search");
		rebuildSearchIndex(db);
		if (report?.skipped && Object.keys(report.skipped).length) warnings.push(`Skipped: ${Object.entries(report.skipped).map(([k, v]) => `${v} ${k}`).join(", ")}`);
		if (files.linked) warnings.push(`${files.linked} linked file${files.linked === 1 ? "" : "s"} (files that stay in a folder on the computer) cannot be opened in a browser.`);
		const one = (sql: string) => (db.query(sql).get() as { n: number }).n;
		const result: ImportResult = {
			kind,
			items: one("SELECT count(*) AS n FROM items"),
			topLevelItems: one("SELECT count(*) AS n FROM items WHERE parent_key IS NULL"),
			collections: one("SELECT count(*) AS n FROM collections"),
			attachments: one("SELECT count(*) AS n FROM attachments"),
			annotations: copied.annotations ?? 0,
			fileFolders: files.moved,
			missingFiles: files.missing,
			linkedFiles: files.linked,
			warnings,
			ms: Date.now() - started,
		};
		state = { running: false, phase: "done", result };
		return result;
	} catch (e) {
		state = { running: false, phase: "failed", error: e instanceof Error ? e.message : String(e) };
		throw e;
	} finally {
		try { src?.close(); } catch { /* closed */ }
		setDatabaseHooks({ resolve: null, sink: null });
		dropDatabaseImages();
		// the temporary copy goes (an unfinished import leaves nothing behind)
		try { rmSync(IMPORT_ROOT); } catch { /* nothing there */ }
	}
}
