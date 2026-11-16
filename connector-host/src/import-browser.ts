// "Move your browser library into Zinc": the host method importBrowserLibrary (docs/design/browser-edition.md, section 6).
//
// The extension exports its browser library with Export library (gpui-ui/web/browser-db/export-zip.ts): one zip with library.sqlite and
// storage/<KEY>/<file>. This merges that zip into the app's library, which already has data (import-run.ts, the browser's own importer,
// only fills an empty library). What is merged: items (with notes and attachments), collections and their membership, tags, annotations,
// full text and the attachment files. A key the app already has is skipped, whatever it holds there (the same key is the same object when
// both libraries were synced with one zotero.org account).
//
// The zip comes from the browser, so it is untrusted:
// - entry names go through readZip (core/src/websync/zip.ts: zip-slip, device names, size and ratio limits), and a file is written only
//   to a path that entryTarget() proves is inside the library's storage folder;
// - library.sqlite is opened in memory, read only, and only the columns this library has are read from it;
// - nothing from the zip becomes a file path: an attachment's path is rebuilt from the library's storage folder, its key and the file name.
//
// The merge is one transaction. Files are written first; when the transaction fails, the folders this call made are removed again. The
// sync triggers are NOT suppressed: the new items go into sync_outbox, so the next sync sends them to zotero.org.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storageRoot } from "../../core/src/additems/files";
import { bumpRev } from "../../core/src/connector/state";
import { SCHEMA_HEAD } from "../../core/src/migrations";
import { indexItem } from "../../core/src/search";
import { entryTarget, readZip, ZipError, type ZipFile } from "../../core/src/websync/zip";

/** An error the caller answers with `status` (the zip or library is not acceptable: 400, 409, 413). */
export class ImportError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = "ImportError";
	}
}

export interface BrowserImportResult {
	/** Items added that sit at the top of the library (the ones the user counts). */
	topLevelItems: number;
	/** Every item row added: top-level items, their notes and attachments. */
	items: number;
	notes: number;
	attachments: number;
	annotations: number;
	collections: number;
	/** tag assignments added (one per item and tag) */
	tags: number;
	/** attachment files written, and their bytes */
	files: number;
	fileBytes: number;
	/** top-level items the app already had (same key): left as they are */
	skippedItems: number;
	skippedCollections: number;
	/** attachments the zip had no file for (the row stays, without a path) */
	missingFiles: number;
	warnings: string[];
	ms: number;
}

/** Item and collection keys are Zotero's 8 characters; a longer or odd key is refused rather than used as a folder name. */
const KEY = /^[A-Za-z0-9]{1,32}$/;
const LIMITS = { maxEntry: 1024 * 1024 * 1024, maxTotal: 3.5 * 1024 * 1024 * 1024, maxEntries: 200_000 };

type Row = Record<string, unknown>;
const cols = (d: Database, t: string): string[] => (d.query(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name);
const hasTable = (d: Database, t: string): boolean => !!d.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? "";

/** Insert `row` into `table`, only the columns the target has; `set` overrides values. */
function insert(dst: Database, have: Map<string, string[]>, table: string, row: Row, set: Row = {}): boolean {
	const dstCols = have.get(table);
	if (!dstCols) return false;
	const names = dstCols.filter((c) => c in set || c in row);
	const stmt = dst.prepare(
		`INSERT OR IGNORE INTO "${table}" (${names.map((c) => `"${c}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
	);
	try {
		return stmt.run(...names.map((c) => (c in set ? set[c] : row[c]) as never)).changes > 0;
	} finally {
		stmt.finalize();
	}
}

/** The files of the zip, by attachment key: storage/<KEY>/<path inside> -> {KEY -> [{rel, data}]}. */
function storageEntries(files: ZipFile[]): { byKey: Map<string, { rel: string; data: Uint8Array }[]>; ignored: number } {
	const byKey = new Map<string, { rel: string; data: Uint8Array }[]>();
	let ignored = 0;
	for (const f of files) {
		const m = /^storage\/([^/]+)\/(.+)$/.exec(f.name);
		if (!m || !KEY.test(m[1]!)) {
			if (f.name !== "library.sqlite" && f.name !== "README.txt") ignored++;
			continue;
		}
		const list = byKey.get(m[1]!.toUpperCase()) ?? [];
		list.push({ rel: m[2]!, data: f.data });
		byKey.set(m[1]!.toUpperCase(), list);
	}
	return { byKey, ignored };
}

export function importBrowserLibrary(db: Database, zipBytes: Uint8Array): BrowserImportResult {
	const started = Date.now();
	let files: ZipFile[];
	try {
		files = readZip(zipBytes, LIMITS);
	} catch (e) {
		throw new ImportError(e instanceof ZipError ? `That is not a usable Zinc export: ${e.message}` : "That is not a zip file.");
	}
	const lib = files.find((f) => f.name === "library.sqlite");
	if (!lib) throw new ImportError("That zip has no library.sqlite: it is not a Zinc library export.");
	let src: Database;
	try {
		// A serialized WAL-mode database (header bytes 18 and 19 = 2) cannot be opened in memory without its -wal file. All its pages are
		// in the image, so it is read as a rollback-journal database.
		if (lib.data.length > 100 && lib.data[18] === 2 && lib.data[19] === 2) {
			lib.data[18] = 1;
			lib.data[19] = 1;
		}
		src = Database.deserialize(lib.data, true);
		if (!hasTable(src, "items") || !hasTable(src, "meta")) throw new Error("no items table");
	} catch {
		throw new ImportError("library.sqlite in that zip is not a Zinc library.");
	}
	try {
		const v = Number((src.query("SELECT value FROM meta WHERE name = 'schema_version'").get() as { value: string } | null)?.value ?? 0);
		if (v > SCHEMA_HEAD)
			throw new ImportError(
				`That library was made by a newer Zinc (schema ${v}); this one understands up to ${SCHEMA_HEAD}. Update Zinc and try again.`,
				409,
			);
		return merge(db, src, files, started);
	} finally {
		src.close();
	}
}

function merge(dst: Database, src: Database, files: ZipFile[], started: number): BrowserImportResult {
	const warnings: string[] = [];
	const have = new Map<string, string[]>();
	for (const t of ["items", "collections", "collection_items", "item_tags", "attachments", "annotations", "fulltext", "view_state"]) {
		if (hasTable(dst, t) && hasTable(src, t)) have.set(t, cols(dst, t));
	}
	if (!have.has("items")) throw new ImportError("This library has no items table.", 500);
	const dstHasLib = have.get("items")!.includes("library_id");
	const inMyLibrary = (r: Row) => r.library_id === undefined || r.library_id === null || r.library_id === 1;

	const exists = dst.query("SELECT library_id AS lib FROM items WHERE key = ?");
	const existsNoLib = dst.query("SELECT 1 AS lib FROM items WHERE key = ?");
	const itemInDst = (k: string) => (dstHasLib ? exists : existsNoLib).get(k) as { lib: number } | null;
	const collInDst = dst.query("SELECT 1 AS x FROM collections WHERE key = ?");
	const annInDst = dst.query("SELECT 1 AS x FROM annotations WHERE key = ?");

	// ---- plan: which items are new, parents before children
	const srcItems = (src.query("SELECT * FROM items ORDER BY parent_key IS NOT NULL, key").all() as Row[]).filter(inMyLibrary);
	const fresh = new Map<string, Row & { lib: number }>();
	let skippedItems = 0;
	let orphans = 0;
	for (const r of srcItems) {
		const key = String(r.key);
		if (!KEY.test(key)) {
			warnings.push(`Skipped an item with an unusable key.`);
			continue;
		}
		if (itemInDst(key)) {
			if (r.parent_key == null) skippedItems++;
			continue;
		}
		let lib = 1;
		if (r.parent_key != null) {
			const p = String(r.parent_key);
			const inDst = itemInDst(p);
			if (inDst) lib = Number(inDst.lib) || 1;
			else if (!fresh.has(p)) {
				orphans++;
				continue;
			} // its parent is in neither library
		}
		fresh.set(key, { ...r, lib });
	}
	if (orphans)
		warnings.push(
			`${orphans} note${orphans === 1 ? "" : "s"} or attachment${orphans === 1 ? "" : "s"} without a parent item ${orphans === 1 ? "was" : "were"} not moved.`,
		);

	// ---- collections: parents first; a parent that is in neither library leaves the collection at the top
	const srcColls = hasTable(src, "collections") ? (src.query("SELECT * FROM collections").all() as Row[]).filter(inMyLibrary) : [];
	const newColls: Row[] = [];
	let skippedCollections = 0;
	{
		const pending = new Map<string, Row>();
		for (const c of srcColls) {
			const k = String(c.key);
			if (!KEY.test(k)) continue;
			if (collInDst.get(k)) skippedCollections++;
			else pending.set(k, c);
		}
		const placed = new Set<string>();
		const ready = (c: Row) =>
			c.parent_key == null ||
			placed.has(String(c.parent_key)) ||
			!!collInDst.get(String(c.parent_key)) ||
			!pending.has(String(c.parent_key));
		while (pending.size) {
			let progressed = false;
			for (const [k, c] of [...pending]) {
				if (!ready(c)) continue;
				newColls.push(c);
				placed.add(k);
				pending.delete(k);
				progressed = true;
			}
			if (!progressed) {
				for (const [, c] of pending) newColls.push({ ...c, parent_key: null });
				break;
			} // a cycle: flatten it
		}
	}
	const collKeys = new Set([...newColls.map((c) => String(c.key))]);

	// ---- files: those of the attachments that are new
	const { byKey, ignored } = storageEntries(files);
	if (ignored)
		warnings.push(
			`${ignored} file${ignored === 1 ? "" : "s"} in the zip ${ignored === 1 ? "is" : "are"} not attachment files and ${ignored === 1 ? "was" : "were"} ignored.`,
		);
	const root = storageRoot(dst);
	const made: string[] = []; // folders this call created
	let fileCount = 0;
	let fileBytes = 0;
	let missingFiles = 0;
	const attachmentRows = hasTable(src, "attachments")
		? (src.query("SELECT * FROM attachments").all() as Row[]).filter((a) => fresh.has(String(a.item_key)))
		: [];
	const attachmentPath = new Map<string, string | null>();
	try {
		for (const a of attachmentRows) {
			const key = String(a.item_key);
			const mode = String(a.link_mode ?? "");
			if (mode !== "imported_file" && mode !== "imported_url") {
				attachmentPath.set(key, null);
				continue;
			}
			const entries = byKey.get(key.toUpperCase());
			const name = baseName(String(a.path ?? ""));
			const main = entries?.find((e) => e.rel === name) ?? entries?.find((e) => e.rel.toLowerCase() === name.toLowerCase());
			if (!entries || !name || !main) {
				missingFiles++;
				attachmentPath.set(key, null);
				continue;
			}
			const folder = join(root, key);
			const existed = existsSync(folder);
			for (const e of entries) {
				const target = entryTarget(root, `${key}/${e.rel}`);
				if (!target) {
					warnings.push(`A file with an unsafe name in ${key} was not moved.`);
					continue;
				}
				mkdirSync(join(target, ".."), { recursive: true });
				writeFileSync(target, e.data);
				fileCount++;
				fileBytes += e.data.length;
			}
			if (!existed) made.push(folder);
			const target = entryTarget(root, `${key}/${main.rel}`);
			attachmentPath.set(key, target);
		}

		// ---- the merge itself
		const counts = { topLevel: 0, notes: 0, attachments: 0, annotations: 0, tags: 0, collections: 0 };
		const run = dst.transaction(() => {
			for (const c of newColls) {
				if (
					insert(dst, have, "collections", c, {
						version: 0,
						...(have.get("collections")!.includes("library_id") ? { library_id: 1 } : {}),
					})
				)
					counts.collections++;
			}
			for (const r of fresh.values()) {
				insert(dst, have, "items", r, { version: 0, ...(dstHasLib ? { library_id: r.lib } : {}) });
				if (r.parent_key == null) counts.topLevel++;
				if (r.item_type === "note") counts.notes++;
			}
			if (have.has("collection_items")) {
				for (const m of src.query("SELECT * FROM collection_items").all() as Row[]) {
					const ik = String(m.item_key);
					const ck = String(m.collection_key);
					if (!fresh.has(ik) || !(collKeys.has(ck) || collInDst.get(ck))) continue;
					insert(dst, have, "collection_items", m);
				}
			}
			if (have.has("item_tags")) {
				for (const t of src.query("SELECT * FROM item_tags").all() as Row[]) {
					if (fresh.has(String(t.item_key)) && insert(dst, have, "item_tags", t)) counts.tags++;
				}
			}
			for (const a of attachmentRows) {
				const key = String(a.item_key);
				if (insert(dst, have, "attachments", a, { path: attachmentPath.get(key) ?? null })) counts.attachments++;
			}
			if (have.has("annotations")) {
				for (const a of src.query("SELECT * FROM annotations").all() as Row[]) {
					if (!fresh.has(String(a.attachment_key)) || annInDst.get(String(a.key))) continue;
					if (insert(dst, have, "annotations", a)) counts.annotations++;
				}
			}
			for (const t of ["fulltext", "view_state"]) {
				if (!have.has(t)) continue;
				for (const f of src.query(`SELECT * FROM ${t}`).all() as Row[]) {
					if (fresh.has(String(f.attachment_key))) insert(dst, have, t, f);
				}
			}
		});
		run();
		made.length = 0; // committed: the folders stay

		// the search index (fts: not kept by triggers); a child re-indexes its parent
		dst.transaction(() => {
			for (const k of fresh.keys()) indexItem(dst, k);
		})();
		bumpRev();
		return {
			topLevelItems: counts.topLevel,
			items: fresh.size,
			notes: counts.notes,
			attachments: counts.attachments,
			annotations: counts.annotations,
			collections: counts.collections,
			tags: counts.tags,
			files: fileCount,
			fileBytes,
			skippedItems,
			skippedCollections,
			missingFiles,
			warnings,
			ms: Date.now() - started,
		};
	} catch (e) {
		for (const dir of made) rmSync(dir, { recursive: true, force: true });
		throw e;
	}
}
