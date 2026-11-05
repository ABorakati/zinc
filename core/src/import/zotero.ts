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
import { dirname, join, resolve } from "node:path";
import {
	ANNOTATION_TYPES,
	type AttachmentInput,
	buildItemData,
	type Creator,
	creatorsSummary,
	dateForApi,
	LINK_MODES,
	parseYear,
	toIso,
} from "../zotero-db/mapping";
import { venueOf } from "../venue";
import {
	buildFileIndex,
	defaultSearchRoots,
	type FileIndex,
	resolveAttachmentFile,
	zoteroRawPathFilename,
} from "./resolve-files";

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
	// Extra places to look for files missing from their canonical location (by filename / title).
	// Default: base attachment path, <zoteroDir>/storage, ~/OneDrive/Documents, ~/Documents, ~/Downloads.
	// `false` disables the fallback search.
	searchRoots?: string[] | false;
	fuzzyMatch?: boolean; // allow title-based matching (default true)
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
	recoveredFiles?: Record<string, number>; // attachments found outside their canonical location, by match kind
	attachmentsByLinkMode: Record<string, number>;
	skipped: Record<string, number>;
	groupLibraries: { libraryID: number; items: number }[];
	durationMs: number;
}

// Row -> Web API JSON mapping and date/summary helpers live in ../zotero-db/mapping (shared with the
// live reader/writer); re-exported here for existing callers.
export { creatorsSummary, dateForApi, parseYear, toIso };

// Zotero's coloured tags: syncedSettings row 'tagColors' = JSON [{name, color}], position = index.
// Accepts an open (snapshot) zotero.sqlite; returns [] if absent or malformed.
export function readZoteroTagColors(src: Database, libraryID?: number): { name: string; color: string; position: number }[] {
	let lib = libraryID;
	try {
		if (lib === undefined) {
			const l = src.query("SELECT libraryID FROM libraries WHERE type = 'user' ORDER BY libraryID LIMIT 1").get() as Row | null;
			lib = l?.libraryID ?? 1;
		}
		const libId: number = lib ?? 1;
		const row = src.query("SELECT value FROM syncedSettings WHERE setting = 'tagColors' AND libraryID = ?").get(libId) as Row | null;
		if (!row?.value) return [];
		const parsed = JSON.parse(String(row.value));
		if (!Array.isArray(parsed)) return [];
		const out: { name: string; color: string; position: number }[] = [];
		const seen = new Set<string>();
		for (const e of parsed) {
			if (!e || typeof e.name !== "string" || typeof e.color !== "string" || !e.name || seen.has(e.name)) continue;
			seen.add(e.name);
			out.push({ name: e.name, color: e.color, position: out.length });
		}
		return out;
	} catch {
		return []; // no syncedSettings table or bad JSON
	}
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

		// My Publications
		const pubs = new Set<number>();
		for (const r of src.query("SELECT itemID FROM publicationsItems").iterate() as Iterable<Row>) pubs.add(r.itemID);

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

		// Fallback search roots (built lazily, only if some attachment misses its canonical location).
		let fileIndex: FileIndex | null = null;
		const getIndex = (): FileIndex => {
			if (!fileIndex) {
				progress({ phase: "files", message: "indexing fallback file locations" });
				// searchRoots: false disables the fallback search (empty index).
				const roots =
					opts.searchRoots === false ? [] : (opts.searchRoots ?? defaultSearchRoots({ zoteroDir, baseAttachmentPath: baseAttach }));
				fileIndex = buildFileIndex(roots);
			}
			return fileIndex;
		};
		const recovered: Record<string, number> = {};
		const resolveAttachment = (
			key: string,
			linkMode: string,
			rawPath: string | null,
			parent?: { title?: string; author?: string },
			md5?: string | null,
		) => {
			if (linkMode === "linked_url" || !rawPath) return { path: null as string | null, filename: undefined as string | undefined, missing: false };
			const filename = zoteroRawPathFilename(rawPath);
			const m = resolveAttachmentFile(
				{ key, rawPath, filename, md5, parentTitle: parent?.title, parentAuthor: parent?.author },
				{
					storageDir,
					baseAttach,
					index: opts.searchRoots === false ? undefined : getIndex,
					fuzzy: opts.fuzzyMatch,
				},
			);
			if (m) {
				if (m.how !== "canonical") recovered[m.how] = (recovered[m.how] ?? 0) + 1;
				return { path: m.path, filename, missing: false };
			}
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

			let attRow: { linkMode: string; contentType: string | null; path: string | null; url: string | null } | null = null;
			let attInput: AttachmentInput | undefined;
			if (a) {
				const linkMode = LINK_MODES[a.linkMode] ?? "imported_file";
				const pf = parentID !== null ? fields.get(parentID) : undefined;
				const r = resolveAttachment(
					it.key,
					linkMode,
					a.path,
					{ title: pf?.title, author: parentID !== null ? creatorsSummary(creators.get(parentID) ?? []) : undefined },
					a.storageHash,
				);
				attInput = {
					linkMode: a.linkMode,
					contentType: a.contentType,
					charset: a.charsetID ? (charsets.get(a.charsetID) ?? "") : "",
					rawPath: a.path,
					storageHash: a.storageHash,
					storageModTime: a.storageModTime,
					filename: r.filename,
				};
				if (r.missing) {
					missing.total++;
					if (linkMode === "linked_file") missing.linked_file++;
					else missing.imported++;
				}
				attRow = { linkMode, contentType: a.contentType ?? null, path: r.path, url: f.url ?? null };
				attachmentsByLinkMode[linkMode] = (attachmentsByLinkMode[linkMode] ?? 0) + 1;
			}
			const data = buildItemData({
				key: it.key,
				version: it.version,
				type: it.type,
				parentKey,
				fields: f,
				creators: cl,
				tags: tl,
				collections: itemCollections.get(it.itemID) ?? [],
				relations: relations.get(it.itemID) ?? {},
				dateAdded: it.dateAdded,
				dateModified: it.dateModified,
				noteText: n?.note ?? "",
				inPublications: pubs.has(it.itemID),
				attachment: attInput,
			});

			const title =
				it.type === "note"
					? (n?.title ?? "")
					: ((f.title ?? "") as string);
			const publication = venueOf(f, it.type); // same rule as every other writer (core/src/venue.ts)
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

		const tagColors = readZoteroTagColors(src, libraryID);
		if (tagColors.length > 0) {
			out.prepare("INSERT OR REPLACE INTO meta (name, value) VALUES ('tagColors', ?)").run(JSON.stringify(tagColors));
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
			recoveredFiles: recovered,
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
