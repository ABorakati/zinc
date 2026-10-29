// Zotero 7/10 -> zotero-next importer.
// Reads a snapshot of zotero.sqlite (never the live file), rebuilds Zotero Web API item JSON
// from the EAV tables and writes it into a fresh library database (core/schema.sql).
import { Database } from "bun:sqlite";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface ImportProgress {
	phase: string;
	done?: number;
	total?: number;
	message?: string;
}

export interface ImportOptions {
	zoteroDir: string; // Zotero data directory (contains zotero.sqlite and storage/)
	targetDbPath: string;
	schemaPath: string;
	replace?: boolean; // replace an existing target DB
	baseAttachmentPath?: string; // override; default read from the Zotero profile prefs.js
	profilesDir?: string; // override %APPDATA%\Zotero\Zotero\Profiles
	onProgress?: (p: ImportProgress) => void;
}

export interface ImportReport {
	snapshotMethod: "vacuum" | "copy";
	libraryID: number;
	baseAttachmentPath: string | null;
	counts: {
		items: number;
		itemsByType: Record<string, number>;
		trashed: number;
		collections: number;
		collection_items: number;
		item_tags: number;
		attachments: number;
		annotations: number;
		fulltext: number;
	};
	missingFiles: { imported: number; linked_file: number; total: number };
	attachmentsByLinkMode: Record<string, number>;
	skipped: Record<string, number>;
	groupLibraries: { libraryID: number; items: number }[];
	durationMs: number;
}

const LINK_MODES = ["imported_file", "imported_url", "linked_file", "linked_url"];
const ANNOTATION_TYPES: Record<number, string> = {
	1: "highlight",
	2: "note",
	3: "image",
	4: "ink",
	5: "underline",
	6: "text",
};
const PUBLICATION_FIELDS = [
	"publicationTitle",
	"bookTitle",
	"proceedingsTitle",
	"websiteTitle",
	"blogTitle",
	"forumTitle",
	"encyclopediaTitle",
	"dictionaryTitle",
	"programTitle",
	"university",
	"publisher",
];

// "2026-05-27 21:24:45" (UTC) -> "2026-05-27T21:24:45Z"
export function toIso(s: string | null | undefined): string {
	if (!s) return new Date(0).toISOString().replace(".000", "");
	return `${s.replace(" ", "T")}Z`;
}

// Zotero stores dates as "YYYY-MM-DD original text"; the API returns the original text.
export function dateForApi(v: string): string {
	const m = /^\d{4}-\d{2}-\d{2} ([\s\S]*)$/.exec(v);
	return m ? m[1] : v;
}

export function parseYear(raw: string | undefined): number | null {
	if (!raw) return null;
	const sortable = /^(\d{4})-\d{2}-\d{2}/.exec(raw);
	if (sortable && sortable[1] !== "0000") return Number(sortable[1]);
	const m = /(?<!\d)(\d{4})(?!\d)/.exec(dateForApi(raw));
	return m ? Number(m[1]) : null;
}

interface Creator {
	creatorType: string;
	firstName?: string;
	lastName?: string;
	name?: string;
}

export function creatorsSummary(creators: Creator[]): string {
	let pool = creators.filter((c) => c.creatorType === "author");
	if (pool.length === 0) pool = creators.slice(0, 1);
	const names = pool.map((c) => c.lastName ?? c.name ?? "").filter((n) => n);
	if (names.length === 0) return "";
	if (names.length === 1) return names[0];
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	return `${names[0]} et al.`;
}

function findBaseAttachmentPath(profilesDir: string): string | null {
	if (!existsSync(profilesDir)) return null;
	for (const d of readdirSync(profilesDir)) {
		const p = join(profilesDir, d, "prefs.js");
		if (!existsSync(p)) continue;
		const m = /user_pref\("extensions\.zotero\.baseAttachmentPath",\s*("(?:[^"\\]|\\.)*")\)/.exec(
			readFileSync(p, "utf8"),
		);
		if (m) {
			try {
				const v = JSON.parse(m[1]);
				if (typeof v === "string" && v) return v;
			} catch {
				// ignore malformed pref
			}
		}
	}
	return null;
}

// Consistent read-only snapshot. Zotero holds an exclusive lock while running, so
// VACUUM INTO can fail with SQLITE_BUSY; then copy db + wal + shm together.
function snapshot(zoteroDir: string, workDir: string): { path: string; method: "vacuum" | "copy" } {
	const src = join(zoteroDir, "zotero.sqlite");
	if (!existsSync(src)) throw new Error(`zotero.sqlite not found in ${zoteroDir}`);
	const vac = join(workDir, "snapshot.sqlite");
	let ro: Database | null = null;
	try {
		ro = new Database(src, { readonly: true });
		ro.exec(`VACUUM INTO '${vac.replaceAll("'", "''")}'`);
		return { path: vac, method: "vacuum" };
	} catch {
		rmSync(vac, { force: true });
	} finally {
		ro?.close();
	}
	const dir = join(workDir, "copy");
	mkdirSync(dir, { recursive: true });
	for (const ext of ["", "-wal", "-shm"]) {
		const f = src + ext;
		if (existsSync(f)) copyFileSync(f, join(dir, `zotero.sqlite${ext}`));
	}
	return { path: join(dir, "zotero.sqlite"), method: "copy" };
}

type Row = Record<string, any>;

export async function importZotero(opts: ImportOptions): Promise<ImportReport> {
	const started = Date.now();
	const progress = (p: ImportProgress) => opts.onProgress?.(p);
	const zoteroDir = resolve(opts.zoteroDir);
	const target = resolve(opts.targetDbPath);
	const storageDir = join(zoteroDir, "storage");

	if (existsSync(target)) {
		if (!opts.replace) {
			throw new Error(`${target} already exists; pass replace: true to overwrite`);
		}
		for (const ext of ["", "-wal", "-shm"]) rmSync(target + ext, { force: true });
	}
	mkdirSync(dirname(target), { recursive: true });

	const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Roaming");
	const baseAttach =
		opts.baseAttachmentPath ??
		findBaseAttachmentPath(opts.profilesDir ?? join(appData, "Zotero", "Zotero", "Profiles"));

	const workDir = join(tmpdir(), `zotero-next-import-${process.pid}-${Date.now()}`);
	mkdirSync(workDir, { recursive: true });
	const skipped: Record<string, number> = {};
	const skip = (reason: string) => {
		skipped[reason] = (skipped[reason] ?? 0) + 1;
	};

	let src: Database | null = null;
	let out: Database | null = null;
	let failed = false;
	try {
		progress({ phase: "snapshot", message: "snapshotting zotero.sqlite" });
		const snap = snapshot(zoteroDir, workDir);
		src = new Database(snap.path);
		progress({ phase: "snapshot", message: `snapshot via ${snap.method}` });

		const lib = src.query("SELECT libraryID FROM libraries WHERE type = 'user' ORDER BY libraryID LIMIT 1").get() as Row | null;
		if (!lib) throw new Error("no user library in zotero.sqlite");
		const libraryID: number = lib.libraryID;
		const groupLibraries = (
			src.query("SELECT libraryID FROM libraries WHERE type = 'group'").all() as Row[]
		).map((g) => ({
			libraryID: g.libraryID as number,
			items: (src!.query("SELECT COUNT(*) c FROM items WHERE libraryID = ?").get(g.libraryID) as Row).c as number,
		}));

		// lookups
		const typeName = new Map<number, string>();
		for (const r of src.query("SELECT itemTypeID, typeName FROM itemTypesCombined").all() as Row[]) {
			typeName.set(r.itemTypeID, r.typeName);
		}
		const fieldName = new Map<number, string>();
		for (const r of src.query("SELECT fieldID, fieldName FROM fieldsCombined").all() as Row[]) {
			fieldName.set(r.fieldID, r.fieldName);
		}
		const creatorTypeName = new Map<number, string>();
		for (const r of src.query("SELECT creatorTypeID, creatorType FROM creatorTypes").all() as Row[]) {
			creatorTypeName.set(r.creatorTypeID, r.creatorType);
		}
		const charsets = new Map<number, string>();
		try {
			for (const r of src.query("SELECT charsetID, charset FROM charsets").all() as Row[]) {
				charsets.set(r.charsetID, r.charset);
			}
		} catch {
			// charsets table absent in very old schemas
		}

		// items
		progress({ phase: "read", message: "reading items" });
		const trashed = new Set(
			(src.query("SELECT itemID FROM deletedItems").all() as Row[]).map((r) => r.itemID as number),
		);
		interface SrcItem {
			itemID: number;
			type: string;
			key: string;
			dateAdded: string;
			dateModified: string;
			version: number;
		}
		const items = new Map<number, SrcItem>();
		const keyOf = new Map<number, string>();
		const annotationRows = new Map<number, SrcItem>();
		for (const r of src
			.query("SELECT itemID, itemTypeID, dateAdded, dateModified, key, version FROM items WHERE libraryID = ?")
			.all(libraryID) as Row[]) {
			const type = typeName.get(r.itemTypeID) ?? `type${r.itemTypeID}`;
			const it: SrcItem = {
				itemID: r.itemID,
				type,
				key: r.key,
				dateAdded: toIso(r.dateAdded),
				dateModified: toIso(r.dateModified),
				version: r.version,
			};
			if (type === "annotation") {
				annotationRows.set(r.itemID, it);
				continue;
			}
			if (type === "feed" || type === "feedItem") {
				skip("feed item");
				continue;
			}
			items.set(r.itemID, it);
			keyOf.set(r.itemID, r.key);
		}

		// itemData
		const fields = new Map<number, Record<string, string>>();
		for (const r of src
			.query("SELECT d.itemID, d.fieldID, v.value FROM itemData d JOIN itemDataValues v ON v.valueID = d.valueID")
			.iterate() as Iterable<Row>) {
			if (!items.has(r.itemID)) continue;
			const name = fieldName.get(r.fieldID);
			if (!name || r.value === null || r.value === "") continue;
			let f = fields.get(r.itemID);
			if (!f) fields.set(r.itemID, (f = {}));
			f[name] = String(r.value);
		}

		// creators
		const creators = new Map<number, Creator[]>();
		for (const r of src
			.query(
				`SELECT ic.itemID, ic.creatorTypeID, c.firstName, c.lastName, c.fieldMode
				 FROM itemCreators ic JOIN creators c ON c.creatorID = ic.creatorID
				 ORDER BY ic.itemID, ic.orderIndex`,
			)
			.iterate() as Iterable<Row>) {
			if (!items.has(r.itemID)) continue;
			const creatorType = creatorTypeName.get(r.creatorTypeID) ?? "author";
			const c: Creator =
				r.fieldMode === 1
					? { creatorType, name: r.lastName ?? "" }
					: { creatorType, firstName: r.firstName ?? "", lastName: r.lastName ?? "" };
			let l = creators.get(r.itemID);
			if (!l) creators.set(r.itemID, (l = []));
			l.push(c);
		}

		// tags (items and annotations)
		const tags = new Map<number, { tag: string; type: number }[]>();
		for (const r of src
			.query("SELECT it.itemID, t.name, it.type FROM itemTags it JOIN tags t ON t.tagID = it.tagID ORDER BY it.itemID, t.name")
			.iterate() as Iterable<Row>) {
			let l = tags.get(r.itemID);
			if (!l) tags.set(r.itemID, (l = []));
			l.push({ tag: r.name, type: r.type });
		}

		// collections
		const collRows = src
			.query("SELECT collectionID, collectionName, parentCollectionID, key, version FROM collections WHERE libraryID = ? ORDER BY collectionID")
			.all(libraryID) as Row[];
		const collKey = new Map<number, string>();
		for (const c of collRows) collKey.set(c.collectionID, c.key);
		const itemCollections = new Map<number, string[]>();
		const collectionItemPairs: [string, number][] = [];
		for (const r of src.query("SELECT collectionID, itemID FROM collectionItems").iterate() as Iterable<Row>) {
			const ck = collKey.get(r.collectionID);
			if (!ck || !items.has(r.itemID)) continue;
			collectionItemPairs.push([ck, r.itemID]);
			let l = itemCollections.get(r.itemID);
			if (!l) itemCollections.set(r.itemID, (l = []));
			l.push(ck);
		}

		// relations
		const relations = new Map<number, Record<string, string | string[]>>();
		for (const r of src
			.query("SELECT ir.itemID, rp.predicate, ir.object FROM itemRelations ir JOIN relationPredicates rp ON rp.predicateID = ir.predicateID ORDER BY ir.itemID, rp.predicate, ir.object")
			.iterate() as Iterable<Row>) {
			if (!items.has(r.itemID)) continue;
			let m = relations.get(r.itemID);
			if (!m) relations.set(r.itemID, (m = {}));
			const cur = m[r.predicate];
			if (cur === undefined) m[r.predicate] = r.object;
			else if (Array.isArray(cur)) cur.push(r.object);
			else m[r.predicate] = [cur, r.object];
		}

		// notes / attachments
		const notes = new Map<number, Row>();
		for (const r of src.query("SELECT itemID, parentItemID, note, title FROM itemNotes").iterate() as Iterable<Row>) {
			if (items.has(r.itemID)) notes.set(r.itemID, r);
		}
		const atts = new Map<number, Row>();
		for (const r of src
			.query("SELECT itemID, parentItemID, linkMode, contentType, charsetID, path, storageModTime, storageHash FROM itemAttachments")
			.iterate() as Iterable<Row>) {
			if (items.has(r.itemID)) atts.set(r.itemID, r);
		}

		// build target
		progress({ phase: "write", message: "creating target database" });
		out = new Database(target, { create: true });
		out.exec(readFileSync(opts.schemaPath, "utf8"));
		out.exec("PRAGMA synchronous = OFF");
		out.exec("BEGIN");
		out.exec("PRAGMA defer_foreign_keys = ON");

		const insItem = out.prepare(
			`INSERT INTO items (key, item_type, parent_key, title, creators_summary, year, publication, data, date_added, date_modified, version, deleted)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const insAtt = out.prepare(
			"INSERT INTO attachments (item_key, link_mode, content_type, path, url) VALUES (?, ?, ?, ?, ?)",
		);
		const insTag = out.prepare("INSERT OR IGNORE INTO item_tags (item_key, tag, type) VALUES (?, ?, ?)");
		const insColl = out.prepare("INSERT INTO collections (key, name, parent_key, version) VALUES (?, ?, ?, ?)");
		const insCollItem = out.prepare("INSERT OR IGNORE INTO collection_items (collection_key, item_key) VALUES (?, ?)");
		const insAnn = out.prepare("INSERT OR REPLACE INTO annotations (key, attachment_key, data, date_modified) VALUES (?, ?, ?, ?)");
		const insFt = out.prepare("INSERT OR REPLACE INTO fulltext (attachment_key, content, source, indexed_at) VALUES (?, ?, 'zotero-cache', ?)");

		// collections
		for (const c of collRows) {
			insColl.run(c.key, c.collectionName, c.parentCollectionID ? (collKey.get(c.parentCollectionID) ?? null) : null, c.version);
		}

		const counts: ImportReport["counts"] = {
			items: 0,
			itemsByType: {},
			trashed: 0,
			collections: collRows.length,
			collection_items: 0,
			item_tags: 0,
			attachments: 0,
			annotations: 0,
			fulltext: 0,
		};
		const missing = { imported: 0, linked_file: 0, total: 0 };
		const attachmentsByLinkMode: Record<string, number> = {};
		const importedKeys = new Set<string>();
		const attachmentKeys: string[] = [];
		const storageDirs = existsSync(storageDir) ? new Set(readdirSync(storageDir)) : new Set<string>();

		const resolveAttachment = (key: string, linkMode: string, rawPath: string | null) => {
			if (linkMode === "linked_url" || !rawPath) return { path: null as string | null, filename: undefined as string | undefined, missing: false };
			let abs: string | null = null;
			let filename: string | undefined;
			if (rawPath.startsWith("storage:")) {
				filename = rawPath.slice("storage:".length);
				abs = join(storageDir, key, filename);
			} else if (rawPath.startsWith("attachments:")) {
				const rel = rawPath.slice("attachments:".length);
				filename = basename(rel);
				abs = baseAttach ? join(baseAttach, rel) : null;
			} else {
				filename = basename(rawPath);
				abs = rawPath;
			}
			if (abs && existsSync(abs)) return { path: resolve(abs), filename, missing: false };
			return { path: null, filename, missing: true };
		};

		// children are written after parents is not required (deferred FK); keep one pass
		const total = items.size;
		let done = 0;
		for (const it of items.values()) {
			done++;
			if (done % 2000 === 0) progress({ phase: "items", done, total });
			const f = fields.get(it.itemID) ?? {};
			const n = notes.get(it.itemID);
			const a = atts.get(it.itemID);
			const parentID: number | null = n?.parentItemID ?? a?.parentItemID ?? null;
			let parentKey: string | null = null;
			if (parentID !== null) {
				parentKey = keyOf.get(parentID) ?? null;
				if (!parentKey) {
					skip("child of missing parent");
					continue;
				}
			}
			const cl = creators.get(it.itemID) ?? [];
			const tl = tags.get(it.itemID) ?? [];
			const data: Record<string, unknown> = {
				key: it.key,
				version: it.version,
				itemType: it.type,
			};
			if (parentKey) data.parentItem = parentKey;

			let attRow: { linkMode: string; contentType: string | null; path: string | null; url: string | null } | null = null;
			if (a) {
				const linkMode = LINK_MODES[a.linkMode] ?? "imported_file";
				data.linkMode = linkMode;
				if (f.title !== undefined) data.title = f.title;
				if (f.accessDate) data.accessDate = f.accessDate;
				if (f.url) data.url = f.url;
				if (f.note) data.note = f.note;
				data.contentType = a.contentType ?? "";
				data.charset = a.charsetID ? (charsets.get(a.charsetID) ?? "") : "";
				const r = resolveAttachment(it.key, linkMode, a.path);
				if (r.filename && linkMode !== "linked_url") data.filename = r.filename;
				if (a.storageHash) data.md5 = a.storageHash;
				if (a.storageModTime) data.mtime = a.storageModTime;
				if (linkMode === "linked_file" && a.path) data.path = a.path;
				if (r.missing) {
					missing.total++;
					if (linkMode === "linked_file") missing.linked_file++;
					else missing.imported++;
				}
				attRow = { linkMode, contentType: a.contentType ?? null, path: r.path, url: f.url ?? null };
				attachmentsByLinkMode[linkMode] = (attachmentsByLinkMode[linkMode] ?? 0) + 1;
			} else if (it.type === "note") {
				data.note = n?.note ?? "";
			} else {
				for (const [k, v] of Object.entries(f)) data[k] = k === "date" ? dateForApi(v) : v;
				if (cl.length) data.creators = cl;
				else data.creators = [];
			}
			if (it.type === "attachment" && a) {
				// attachment-specific fields already added; keep generic extras (e.g. extra)
				if (f.extra) data.extra = f.extra;
			}
			data.tags = tl.map((t) => (t.type ? { tag: t.tag, type: t.type } : { tag: t.tag }));
			if (!parentKey) data.collections = [...(itemCollections.get(it.itemID) ?? [])].sort();
			data.relations = relations.get(it.itemID) ?? {};
			data.dateAdded = it.dateAdded;
			data.dateModified = it.dateModified;

			const title =
				it.type === "note"
					? (n?.title ?? "")
					: ((f.title ?? "") as string);
			let publication: string | null = null;
			for (const pf of PUBLICATION_FIELDS) {
				if (f[pf]) {
					publication = f[pf];
					break;
				}
			}
			const deleted = trashed.has(it.itemID) ? 1 : 0;
			insItem.run(
				it.key,
				it.type,
				parentKey,
				title,
				creatorsSummary(cl),
				parseYear(fields.get(it.itemID)?.date),
				publication,
				JSON.stringify(data),
				it.dateAdded,
				it.dateModified,
				it.version,
				deleted,
			);
			importedKeys.add(it.key);
			counts.items++;
			counts.itemsByType[it.type] = (counts.itemsByType[it.type] ?? 0) + 1;
			if (deleted) counts.trashed++;
			for (const t of tl) {
				insTag.run(it.key, t.tag, t.type);
				counts.item_tags++;
			}
			if (attRow) {
				insAtt.run(it.key, attRow.linkMode, attRow.contentType, attRow.path, attRow.url);
				counts.attachments++;
				attachmentKeys.push(it.key);
			}
		}

		for (const [ck, itemID] of collectionItemPairs) {
			const ik = keyOf.get(itemID);
			if (ik && importedKeys.has(ik)) {
				insCollItem.run(ck, ik);
				counts.collection_items++;
			}
		}

		// annotations
		progress({ phase: "annotations" });
		for (const r of src
			.query("SELECT itemID, parentItemID, type, authorName, text, comment, color, pageLabel, sortIndex, position FROM itemAnnotations")
			.iterate() as Iterable<Row>) {
			const row = annotationRows.get(r.itemID);
			if (!row) continue;
			const parent = keyOf.get(r.parentItemID);
			if (!parent || !importedKeys.has(parent)) {
				skip("annotation without attachment");
				continue;
			}
			let position: unknown = {};
			try {
				position = JSON.parse(r.position);
			} catch {
				skip("annotation bad position");
				continue;
			}
			const ann: Record<string, unknown> = {
				id: row.key,
				type: ANNOTATION_TYPES[r.type] ?? `type${r.type}`,
				color: r.color ?? undefined,
				sortIndex: r.sortIndex,
				position,
				text: r.text ?? undefined,
				comment: r.comment ?? undefined,
				tags: (tags.get(r.itemID) ?? []).map((t) => ({ name: t.tag })),
				pageLabel: r.pageLabel ?? undefined,
				dateModified: row.dateModified,
				authorName: r.authorName ?? undefined,
			};
			insAnn.run(row.key, parent, JSON.stringify(ann), row.dateModified);
			counts.annotations++;
		}

		// fulltext caches
		progress({ phase: "fulltext", total: attachmentKeys.length });
		const nowIso = new Date().toISOString();
		for (const key of attachmentKeys) {
			if (!storageDirs.has(key)) continue;
			const f = join(storageDir, key, ".zotero-ft-cache");
			if (!existsSync(f)) continue;
			let text: string;
			try {
				text = readFileSync(f, "utf8");
			} catch {
				skip("fulltext unreadable");
				continue;
			}
			if (!text.trim()) {
				skip("fulltext empty");
				continue;
			}
			insFt.run(key, text, nowIso);
			counts.fulltext++;
		}

		out.prepare("INSERT OR REPLACE INTO meta (name, value) VALUES ('schema_version', '1')").run();
		out.prepare("INSERT OR REPLACE INTO meta (name, value) VALUES ('zotero_import_at', ?)").run(nowIso);
		out.exec("COMMIT");
		const fk = out.query("PRAGMA foreign_key_check").all();
		if (fk.length) skip(`foreign key violations (${fk.length})`);
		out.exec("PRAGMA wal_checkpoint(TRUNCATE)");

		return {
			snapshotMethod: snap.method,
			libraryID,
			baseAttachmentPath: baseAttach,
			counts,
			missingFiles: missing,
			attachmentsByLinkMode,
			skipped,
			groupLibraries,
			durationMs: Date.now() - started,
		};
	} catch (e) {
		failed = true;
		throw e;
	} finally {
		try {
			out?.close(true);
		} catch {
			// ignore
		}
		src?.close(true);
		if (failed) for (const ext of ["", "-wal", "-shm"]) rmSync(target + ext, { force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
}
