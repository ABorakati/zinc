// ZoteroWriter: writes zotero-next changes straight into a CLOSED Zotero library (zotero.sqlite +
// storage/), mimicking what Zotero's own Item/Collection/Annotation save() and erase() do (learned
// from Zotero 10's chrome/content/zotero/xpcom/data/*.js, see the per-op notes below).
//
// Per local save Zotero does, and so do we:
//   items row:    dateModified = now (or the caller's value if it changed), clientDateModified = now,
//                 synced = 0, version UNTOUCHED, clientVersion = ++libraries.clientVersion
//   itemData:     REPLACE INTO itemData via itemDataValues (deduped, valueNormalized); blanks deleted
//   creators:     deduped by (firstName, lastName, fieldMode); itemCreators diffed per orderIndex
//   tags:         tags deduped by name; itemTags (type 0 manual / 1 automatic); orphans purged
//   collections:  collectionItems with orderIndex = MAX+1 (top-level items only)
//   notes:        itemNotes(note wrapped in <div class="zotero-note znv1">, title = first line)
//   attachments:  itemAttachments(linkMode int, contentType, charsetID, path 'storage:<name>' |
//                 'attachments:<rel>' | absolute, syncState 0 = to upload), file copied to storage/<KEY>/
//   annotations:  an items row of type annotation + itemAnnotations (type int, position JSON text...)
//   trash:        deletedItems / deletedCollections (+ synced = 0, dateModified/clientDateModified = now)
//   erase:        rows deleted (children first), syncDeleteLog (3 = item, 1 = collection), storage dir
//                 removed after commit, related-item relations to the item removed from other items
// Safety: never writes while zotero.exe runs or the DB is locked; VACUUM INTO backup first; one
// transaction with foreign_keys = ON; integrity_check + foreign_key_check before COMMIT; any
// unexpected error rolls everything back (and removes copied files) and is rethrown.
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	BASELINE_CHANGED,
	type ZoteroJson,
	ZoteroLockedError,
	type ZoteroWrite,
	type ZoteroWriteResult,
	type ZoteroWriter,
} from "../sync/protocol";
import {
	findBaseAttachmentPath,
	findZoteroDataDir,
	fromRelativeAttachmentPath,
	isBusyError,
	isZoteroProcessRunning,
	probeWritable,
	toRelativeAttachmentPath,
	type ZoteroDbOptions,
} from "./env";
import { type LoadedItem, type Lookups, loadItems, loadLookups, userLibraryID } from "./load";
import {
	ANNOTATION_TYPE_IDS,
	type Creator,
	cleanNote,
	DEFAULT_ANNOTATION_COLOR,
	dateForApi,
	dateToMultipart,
	isoToSql,
	LINK_MODES,
	normalizeForSearchStorage,
	noteToTitle,
	type Row,
	sqlNow,
	validFileName,
	wrapNote,
} from "./mapping";

/** Extra information the sync layer can use to avoid echoing its own writes back. */
export interface ZoteroDbWriteResult extends ZoteroWriteResult {
	/** false if the write was a no-op (Zotero already had exactly this data). */
	changed?: boolean;
	/** Zotero's dateModified (ISO) for the object after the write. */
	dateModified?: string;
}

/** A write that cannot be applied (bad input, missing parent...). Reported per write, not fatal. */
export class ZoteroWriteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ZoteroWriteError";
	}
}

const SYNC_OBJECT_COLLECTION = 1;
const SYNC_OBJECT_ITEM = 3;
const READER_CONTENT_TYPES = new Set(["application/pdf", "application/epub+zip", "text/html"]);
const NON_FIELD_KEYS = new Set([
	"key",
	"version",
	"itemType",
	"parentItem",
	"collections",
	"tags",
	"creators",
	"relations",
	"dateAdded",
	"dateModified",
	"deleted",
	"inPublications",
	"note",
	"md5",
	"mtime",
	"linkMode",
	"contentType",
	"charset",
	"filename",
	"path",
	"extra",
	"lastRead",
]);

function str(v: unknown): string | null {
	if (v === undefined || v === null) return null;
	return String(v);
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Refuse to overwrite an object that Zotero modified after the baseline the write was built from. */
function checkBaseline(w: ZoteroWrite, curDateModified: string | undefined): void {
	if (!w.baseline || !curDateModified) return;
	const base = isoToSql(w.baseline);
	if (base && curDateModified > base) throw new ZoteroWriteError(`${BASELINE_CHANGED} (${w.key}); not overwritten`);
}

function rank(w: ZoteroWrite): number {
	if (w.op === "erase") return 6;
	if (w.op === "trash" || w.op === "restore") return 5;
	if (w.type === "collection") return 0;
	if (w.type === "annotation") return 4;
	const d = w.data ?? {};
	return typeof d.parentItem === "string" && d.parentItem ? 3 : 1;
}

interface FileUndo {
	dir: string;
	createdDir: boolean;
	file: string;
	hadFile: boolean;
}

class Session {
	readonly now = sqlNow();
	private fileUndo: FileUndo[] = [];
	readonly afterCommit: (() => void)[] = [];
	/** Attachment files copied next to their target as <name>.zn-stage; renamed into place only after COMMIT. */
	staged: { stage: string; dest: string }[] = [];
	private userURIBase: string | null = null;

	constructor(
		private db: Database,
		readonly lk: Lookups,
		private lib: number,
		private dataDir: string,
		private baseAttach: string | null,
		private ft: boolean,
	) {}

	// ---- plumbing --------------------------------------------------------------------------
	private get(sql: string, ...p: unknown[]): Row | null {
		return this.db.query(sql).get(...(p as never[])) as Row | null;
	}
	private all(sql: string, ...p: unknown[]): Row[] {
		return this.db.query(sql).all(...(p as never[])) as Row[];
	}
	private run(sql: string, ...p: unknown[]) {
		return this.db.query(sql).run(...(p as never[]));
	}

	stageMark(): number {
		return this.staged.length;
	}

	/** Forget the after-commit actions (an erased attachment's folder) queued by a write that was rolled back. */
	dropAfterCommit(mark: number): void {
		this.afterCommit.length = mark;
	}

	/** Forget (and delete) files staged by a write that was rolled back. */
	dropStaged(mark: number): void {
		for (const s of this.staged.splice(mark)) rmSync(s.stage, { force: true });
	}

	/** After COMMIT: put the staged files in place. An existing file is replaced atomically, never half-written. */
	commitStaged(): void {
		for (const s of this.staged) {
			try {
				renameSync(s.stage, s.dest);
			} catch {
				try {
					copyFileSync(s.stage, s.dest);
					rmSync(s.stage, { force: true });
				} catch {
					// the staged copy stays beside the target (<name>.zn-stage) rather than being lost
				}
			}
		}
		this.staged = [];
	}

	rollbackFiles(): void {
		for (const s of this.staged) rmSync(s.stage, { force: true });
		this.staged = [];
		for (const u of this.fileUndo.reverse()) {
			try {
				if (u.createdDir) rmSync(u.dir, { recursive: true, force: true });
				else if (!u.hadFile) rmSync(u.file, { force: true });
			} catch {
				// best effort
			}
		}
		this.fileUndo = [];
	}

	private bumpLibrary(): number {
		const r = this.get("UPDATE libraries SET clientVersion = clientVersion + 1 WHERE libraryID = ? RETURNING clientVersion", this.lib);
		return (r?.clientVersion as number) ?? 0;
	}
	private bump(table: "items" | "collections", idCol: string, id: number): void {
		const v = this.bumpLibrary();
		this.run(`UPDATE ${table} SET clientVersion = ? WHERE ${idCol} = ?`, v, id);
	}

	private findItem(key: string): Row | null {
		return this.get("SELECT itemID, itemTypeID FROM items WHERE libraryID = ? AND key = ?", this.lib, key);
	}
	private findCollection(key: string): Row | null {
		return this.get(
			"SELECT collectionID, collectionName, parentCollectionID FROM collections WHERE libraryID = ? AND key = ?",
			this.lib,
			key,
		);
	}

	private ftRun(sql: string, ...p: unknown[]): void {
		if (!this.ft) return;
		try {
			this.run(sql, ...p);
		} catch {
			// the full-text index DB is best effort (Zotero re-indexes stale notes itself)
		}
	}

	// ---- shared helpers --------------------------------------------------------------------
	private valueId(value: string): number {
		const r = this.get("SELECT valueID FROM itemDataValues WHERE value = ?", value);
		if (r) return r.valueID as number;
		return Number(
			this.run("INSERT INTO itemDataValues (value, valueNormalized) VALUES (?, ?)", value, normalizeForSearchStorage(value))
				.lastInsertRowid,
		);
	}

	private tagId(name: string): number {
		const r = this.get("SELECT tagID FROM tags WHERE name = ?", name);
		if (r) return r.tagID as number;
		return Number(
			this.run("INSERT INTO tags (name, nameNormalized) VALUES (?, ?)", name, normalizeForSearchStorage(name)).lastInsertRowid,
		);
	}

	private creatorId(c: { firstName: string; lastName: string; fieldMode: number }): number {
		const r = this.get(
			"SELECT creatorID FROM creators WHERE firstName = ? AND lastName = ? AND fieldMode = ?",
			c.firstName,
			c.lastName,
			c.fieldMode,
		);
		if (r) return r.creatorID as number;
		return Number(
			this.run(
				"INSERT INTO creators (firstName, lastName, fieldMode, firstNameNormalized, lastNameNormalized) VALUES (?, ?, ?, ?, ?)",
				c.firstName,
				c.lastName,
				c.fieldMode,
				normalizeForSearchStorage(c.firstName),
				normalizeForSearchStorage(c.lastName),
			).lastInsertRowid,
		);
	}

	private predicateId(predicate: string): number {
		const r = this.get("SELECT predicateID FROM relationPredicates WHERE predicate = ?", predicate);
		if (r) return r.predicateID as number;
		return Number(this.run("INSERT INTO relationPredicates (predicate) VALUES (?)", predicate).lastInsertRowid);
	}

	private purgeTag(tagID: number): void {
		this.run("DELETE FROM tags WHERE tagID = ? AND NOT EXISTS (SELECT 1 FROM itemTags WHERE tagID = ?)", tagID, tagID);
	}
	private purgeCreator(creatorID: number): void {
		this.run(
			"DELETE FROM creators WHERE creatorID = ? AND NOT EXISTS (SELECT 1 FROM itemCreators WHERE creatorID = ?)",
			creatorID,
			creatorID,
		);
	}

	private itemUri(key: string): string {
		if (!this.userURIBase) {
			const uid = this.get("SELECT value FROM settings WHERE setting = 'account' AND key = 'userID'");
			const local = this.get("SELECT value FROM settings WHERE setting = 'account' AND key = 'localUserKey'");
			this.userURIBase = uid?.value ? `http://zotero.org/users/${uid.value}` : `http://zotero.org/users/local/${local?.value ?? ""}`;
		}
		return `${this.userURIBase}/items/${key}`;
	}

	// ---- tags (items and annotations) ------------------------------------------------------
	private normTags(raw: unknown): { tag: string; type: number }[] {
		if (!Array.isArray(raw)) return [];
		const m = new Map<string, number>();
		for (const t of raw) {
			const name = typeof t === "string" ? t : (t?.tag ?? t?.name);
			if (typeof name !== "string") continue;
			const tag = name.trim();
			if (!tag) continue;
			m.set(tag, typeof t === "object" && t?.type ? Number(t.type) : 0);
		}
		return [...m].map(([tag, type]) => ({ tag, type }));
	}

	private writeTags(itemID: number, now: { tag: string; type: number }[], old: { tag: string; type: number }[]): boolean {
		const oldKeys = new Set(old.map((t) => JSON.stringify([t.tag, t.type])));
		const newKeys = new Set(now.map((t) => JSON.stringify([t.tag, t.type])));
		const toAdd = now.filter((t) => !oldKeys.has(JSON.stringify([t.tag, t.type])));
		const toRemove = old.filter((t) => !newKeys.has(JSON.stringify([t.tag, t.type])));
		for (const t of toAdd) {
			this.run("INSERT OR REPLACE INTO itemTags (itemID, tagID, type) VALUES (?, ?, ?)", itemID, this.tagId(t.tag), t.type);
		}
		for (const t of toRemove) {
			const tg = this.get("SELECT tagID FROM tags WHERE name = ?", t.tag);
			if (!tg) continue;
			this.run("DELETE FROM itemTags WHERE itemID = ? AND tagID = ? AND type = ?", itemID, tg.tagID, t.type);
			this.purgeTag(tg.tagID as number);
		}
		return toAdd.length > 0 || toRemove.length > 0;
	}

	// ---- field / creator normalisation -----------------------------------------------------
	private normFields(data: ZoteroJson, typeName: string): Map<string, string> {
		const out = new Map<string, string>();
		if (typeName === "note") return out;
		const typeId = this.lk.typeId.get(typeName);
		if (typeId === undefined) throw new ZoteroWriteError(`unknown itemType '${typeName}'`);
		const valid = this.lk.validFields.get(typeId) ?? new Set<number>();
		const extraLines: string[] = [];
		const directFields = new Set<string>();
		for (const [k, v] of Object.entries(data)) {
			if (NON_FIELD_KEYS.has(k) || v === null || v === undefined || typeof v === "object") continue;
			const value = String(v).trim();
			if (!value) continue;
			const fid = this.lk.fieldId.get(k);
			if (fid === undefined) {
				extraLines.push(`${k}: ${value}`);
				continue;
			}
			let target = fid;
			const isDirect = valid.has(fid);
			if (!isDirect) {
				let mapped = this.lk.baseMapped.get(`${typeId}:${fid}`);
				if (mapped === undefined) {
					const base = this.lk.baseOfField.get(fid);
					if (base !== undefined) mapped = valid.has(base) ? base : this.lk.baseMapped.get(`${typeId}:${base}`);
				}
				if (mapped === undefined) {
					extraLines.push(`${k}: ${value}`);
					continue;
				}
				target = mapped;
			}
			const name = this.lk.fieldName.get(target) as string;
			if (!isDirect && directFields.has(name)) continue;
			if (isDirect) directFields.add(name);
			out.set(name, name === "accessDate" ? (isoToSql(value) ?? value) : value);
		}
		let extra = typeof data.extra === "string" ? data.extra.trim() : "";
		if (extraLines.length) extra = extra ? `${extra}\n${extraLines.join("\n")}` : extraLines.join("\n");
		if (extra) out.set("extra", extra);
		return out;
	}

	private normCreators(data: ZoteroJson, typeName: string): Creator[] {
		if (typeName === "note" || typeName === "attachment" || typeName === "annotation") return [];
		const typeId = this.lk.typeId.get(typeName) as number;
		const valid = this.lk.validCreatorTypes.get(typeId);
		const primary = this.lk.primaryCreatorType.get(typeId) ?? 1;
		const out: Creator[] = [];
		if (!Array.isArray(data.creators)) return out;
		for (const c of data.creators as Record<string, unknown>[]) {
			let ctId = this.lk.creatorTypeId.get(String(c.creatorType ?? ""));
			if (ctId === undefined || (valid && !valid.has(ctId))) ctId = primary;
			const creatorType = this.lk.creatorTypeName.get(ctId) ?? "author";
			if (typeof c.name === "string" && c.name.trim()) {
				out.push({ creatorType, name: c.name.trim() });
			} else {
				const firstName = String(c.firstName ?? "").trim();
				const lastName = String(c.lastName ?? "").trim();
				if (!firstName && !lastName) continue;
				out.push({ creatorType, firstName, lastName });
			}
		}
		return out;
	}

	private writeCreators(itemID: number, now: Creator[], old: Creator[]): boolean {
		if (sameJson(now, old)) return false;
		const oldIds = this.all("SELECT creatorID FROM itemCreators WHERE itemID = ?", itemID).map((r) => r.creatorID as number);
		for (let i = 0; i < now.length; i++) {
			if (old[i] && sameJson(old[i], now[i])) continue;
			const c = now[i];
			const row =
				c.name !== undefined
					? { firstName: "", lastName: c.name, fieldMode: 1 }
					: { firstName: c.firstName ?? "", lastName: c.lastName ?? "", fieldMode: 0 };
			this.run(
				"INSERT OR REPLACE INTO itemCreators (itemID, creatorID, creatorTypeID, orderIndex) VALUES (?, ?, ?, ?)",
				itemID,
				this.creatorId(row),
				this.lk.creatorTypeId.get(c.creatorType) ?? 1,
				i,
			);
		}
		this.run("DELETE FROM itemCreators WHERE itemID = ? AND orderIndex >= ?", itemID, now.length);
		for (const id of new Set(oldIds)) this.purgeCreator(id);
		return true;
	}

	// ---- items -----------------------------------------------------------------------------
	upsertItem(w: ZoteroWrite): { changed: boolean; path?: string; dateModified: string } {
		const data = w.data;
		if (!data) throw new ZoteroWriteError("upsert without data");
		const existingRow = this.findItem(w.key);
		const cur: LoadedItem | undefined = existingRow
			? loadItems(this.db, this.lk, [existingRow.itemID])?.get(existingRow.itemID)
			: undefined;
		if (cur?.annotation || cur?.typeName === "annotation") throw new ZoteroWriteError(`${w.key} is an annotation, not an item`);
		const typeName = String(data.itemType ?? cur?.typeName ?? "");
		if (!typeName) throw new ZoteroWriteError("itemType missing");
		if (typeName === "annotation") throw new ZoteroWriteError("annotations must use type 'annotation'");
		const typeId = this.lk.typeId.get(typeName);
		if (typeId === undefined) throw new ZoteroWriteError(`unknown itemType '${typeName}'`);
		const isNote = typeName === "note";
		const isAtt = typeName === "attachment";
		const isChild = isNote || isAtt;
		const curIsNote = cur?.typeName === "note";
		const curIsAtt = cur?.typeName === "attachment";
		if (cur && cur.typeName !== typeName && (isNote || isAtt || curIsNote || curIsAtt))
			throw new ZoteroWriteError(`changing itemType (${cur.typeName} -> ${typeName}) is not supported`);

		// parent
		let parentID: number | null = null;
		const parentKey = typeof data.parentItem === "string" && data.parentItem ? data.parentItem : null;
		if (parentKey) {
			if (!isChild) throw new ZoteroWriteError("regular items cannot have a parent");
			if (parentKey === w.key) throw new ZoteroWriteError("item cannot be its own parent");
			const p = this.findItem(parentKey);
			if (!p) throw new ZoteroWriteError(`parent item ${parentKey} not found`);
			parentID = p.itemID as number;
		}

		// incoming normalised state
		const fieldsIn = this.normFields(data, typeName);
		const creatorsIn = this.normCreators(data, typeName);
		const tagsIn = this.normTags(data.tags);
		const relIn: [string, string][] = [];
		if (data.relations && typeof data.relations === "object") {
			for (const [pred, obj] of Object.entries(data.relations as Record<string, string | string[]>)) {
				for (const o of Array.isArray(obj) ? obj : [obj]) if (typeof o === "string" && o) relIn.push([pred, o]);
			}
		}
		relIn.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
		let collectionIDsIn: number[] = [];
		if (!isChild || !parentID) {
			const ks = Array.isArray(data.collections)
				? (data.collections as unknown[]).filter((k): k is string => typeof k === "string")
				: [];
			for (const k of new Set(ks)) {
				const c = this.findCollection(k);
				if (c) collectionIDsIn.push(c.collectionID as number); // unknown collections are skipped
			}
		}
		collectionIDsIn = [...new Set(collectionIDsIn)].sort((a, b) => a - b);
		let noteIn: string | null = null;
		if (isNote || (isAtt && typeof data.note === "string")) noteIn = wrapNote(cleanNote(String(data.note ?? "")));
		if (isAtt && noteIn === wrapNote("")) noteIn = null;

		// attachment state
		let att: { linkMode: number; contentType: string | null; charsetID: number | null; path: string | null } | null = null;
		let fileInfo: { filename: string } | null = null;
		if (isAtt) {
			const lmName = data.linkMode !== undefined ? String(data.linkMode) : cur ? LINK_MODES[cur.attRow?.linkMode] : "imported_file";
			const linkMode = LINK_MODES.indexOf(lmName);
			if (linkMode < 0) throw new ZoteroWriteError(`unknown linkMode '${lmName}'`);
			const contentType = data.contentType !== undefined ? str(data.contentType) || null : (cur?.attRow?.contentType ?? null);
			const charset = data.charset !== undefined ? String(data.charset).toLowerCase() : null;
			const charsetID = charset
				? (this.lk.charsetId.get(charset) ?? null)
				: data.charset === undefined
					? (cur?.attRow?.charsetID ?? null)
					: null;
			let path: string | null = cur?.attRow?.path ?? null;
			if (linkMode === 3) path = null;
			else if (linkMode === 2) {
				const p = str(data.path);
				if (p) path = toRelativeAttachmentPath(p, this.baseAttach);
				else if (!path) throw new ZoteroWriteError("linked_file attachment needs a path");
			} else {
				// imported file: path is storage:<filename>; a new file or filename defines it
				const fn = w.file
					? validFileName(w.file.filename)
					: typeof data.filename === "string" && data.filename
						? validFileName(data.filename)
						: null;
				if (fn) path = `storage:${fn}`;
				else if (!path) path = null;
			}
			att = { linkMode, contentType, charsetID, path };
			if (w.file && linkMode <= 1) fileInfo = { filename: validFileName(w.file.filename) };
		}

		// ---- diff against current ----
		const now = this.now;
		const incomingDM = isoToSql(str(data.dateModified));
		let changedAny = false;
		const flags = {
			itemType: false,
			fields: false,
			creators: false,
			tags: false,
			collections: false,
			relations: false,
			note: false,
			attachment: false,
			parent: false,
			file: !!fileInfo,
		};
		if (!cur) {
			changedAny = true;
		} else {
			flags.itemType = cur.typeName !== typeName;
			const curFields = cur.input?.fields ?? {};
			const keys = new Set([...Object.keys(curFields), ...fieldsIn.keys()]);
			for (const k of keys) {
				const a = curFields[k];
				const b = fieldsIn.get(k);
				if (k === "date" && a !== undefined && b !== undefined ? dateForApi(a) === b : a === b) continue;
				flags.fields = true;
				break;
			}
			flags.creators = !sameJson(creatorsIn, cur.input?.creators ?? []);
			const tk = (l: { tag: string; type: number }[]) => l.map((t) => `${t.type}:${t.tag}`).sort();
			flags.tags = !sameJson(tk(tagsIn), tk(cur.input?.tags ?? []));
			if (!isChild || !cur.parentID) {
				const curColl = this.all("SELECT collectionID FROM collectionItems WHERE itemID = ?", cur.itemID)
					.map((r) => r.collectionID as number)
					.sort((a, b) => a - b);
				flags.collections = !sameJson(curColl, collectionIDsIn);
			}
			const curRel: [string, string][] = [];
			for (const [p, o] of Object.entries(cur.input?.relations ?? {}))
				for (const x of Array.isArray(o) ? o : [o]) curRel.push([p, x]);
			curRel.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
			flags.relations = !sameJson(relIn, curRel);
			if (noteIn !== null) flags.note = (cur.input?.noteText ?? "") !== noteIn;
			if (isChild) flags.parent = (cur.parentID ?? null) !== parentID;
			if (att) {
				const r = cur.attRow ?? {};
				flags.attachment =
					r.linkMode !== att.linkMode ||
					(r.contentType ?? null) !== att.contentType ||
					(r.charsetID ?? null) !== att.charsetID ||
					(r.path ?? null) !== att.path ||
					flags.parent;
			}
			changedAny = Object.values(flags).some(Boolean);
		}
		const wantDeleted = data.deleted === undefined ? null : !!data.deleted && data.deleted !== "0";
		const delChange = cur && wantDeleted !== null && wantDeleted !== cur.deleted;
		// My Publications: Zotero keeps a publicationsItems row per item in it; the Web API JSON has inPublications: true then
		// and omits the key otherwise, so an upsert without it means "not in My Publications".
		const wantPub = data.inPublications === true;
		const pubChange = cur ? wantPub !== !!cur.input?.inPublications : wantPub;

		const filePath = this.attachmentPathFor(w.key, att, cur?.attRow);
		if (cur && !changedAny && !delChange && !pubChange) {
			return { changed: false, path: filePath ?? undefined, dateModified: cur.dateModified };
		}

		// ---- write ----
		checkBaseline(w, cur?.dateModified);
		let itemID: number;
		let dm: string;
		const removedCreatorIds: number[] = [];
		if (!cur) {
			dm = incomingDM ?? now;
			const added = isoToSql(str(data.dateAdded)) ?? now;
			itemID = Number(
				this.run(
					"INSERT INTO items (itemTypeID, dateAdded, dateModified, clientDateModified, libraryID, key, version, synced) VALUES (?, ?, ?, ?, ?, ?, 0, 0)",
					typeId,
					added,
					dm,
					now,
					this.lib,
					w.key,
				).lastInsertRowid,
			);
		} else {
			itemID = cur.itemID;
			dm = incomingDM && incomingDM !== cur.dateModified ? incomingDM : now;
			// When itemType changes, remove fields and creator types invalid on the new type before updating itemTypeID so triggers/lookups stay consistent.
			if (flags.itemType) {
				for (const r of this.all("SELECT fieldID FROM itemData WHERE itemID = ?", itemID)) {
					const name = this.lk.fieldName.get(r.fieldID as number);
					if (!name || !fieldsIn.has(name)) this.run("DELETE FROM itemData WHERE itemID = ? AND fieldID = ?", itemID, r.fieldID);
				}
				const validCreators = this.lk.validCreatorTypes.get(typeId);
				if (validCreators) {
					for (const r of this.all("SELECT creatorID, creatorTypeID, orderIndex FROM itemCreators WHERE itemID = ?", itemID)) {
						if (!validCreators.has(r.creatorTypeID as number)) {
							this.run("DELETE FROM itemCreators WHERE itemID = ? AND orderIndex = ?", itemID, r.orderIndex);
							removedCreatorIds.push(r.creatorID as number);
						}
					}
				}
				this.run(
					"UPDATE items SET itemTypeID = ?, dateModified = ?, clientDateModified = ?, synced = 0 WHERE itemID = ?",
					typeId,
					dm,
					now,
					itemID,
				);
			} else {
				this.run("UPDATE items SET dateModified = ?, clientDateModified = ?, synced = 0 WHERE itemID = ?", dm, now, itemID);
			}
		}

		// itemData
		if (!cur || flags.fields || flags.itemType) {
			const curFields = cur?.input?.fields ?? {};
			for (const [k, v] of fieldsIn) {
				const stored = k === "date" ? dateToMultipart(v) : v;
				if (curFields[k] === stored || (k === "date" && curFields[k] !== undefined && dateForApi(curFields[k]) === v)) continue;
				this.run("REPLACE INTO itemData VALUES (?, ?, ?)", itemID, this.lk.fieldId.get(k), this.valueId(stored));
			}
			if (!flags.itemType) {
				for (const k of Object.keys(curFields)) {
					if (!fieldsIn.has(k)) this.run("DELETE FROM itemData WHERE itemID = ? AND fieldID = ?", itemID, this.lk.fieldId.get(k));
				}
			}
		}
		if (!cur || flags.creators || removedCreatorIds.length > 0) {
			this.writeCreators(itemID, creatorsIn, cur?.input?.creators ?? []);
			for (const id of new Set(removedCreatorIds)) this.purgeCreator(id);
		}

		// parent / note / attachment (parent must be set before collections: triggers)
		if (isChild && !cur) {
			// row created below with its parent; nothing to do here
		}
		if (cur && collectionsNeedRemoval(flags, cur, isChild, parentID)) {
			this.run("DELETE FROM collectionItems WHERE itemID = ?", itemID);
		}
		if (isNote && (!cur || flags.note || flags.parent)) {
			const text = noteIn ?? wrapNote("");
			const title = noteToTitle(cleanNote(String(data.note ?? "")));
			if (cur) this.run("UPDATE itemNotes SET parentItemID = ?, note = ?, title = ? WHERE itemID = ?", parentID, text, title, itemID);
			else this.run("INSERT INTO itemNotes (itemID, parentItemID, note, title) VALUES (?, ?, ?, ?)", itemID, parentID, text, title);
			this.ftRun("REPLACE INTO ftindex.fulltextNoteIndexState (itemID, version) VALUES (?, 0)", itemID);
		}
		if (isAtt && att) {
			if (fileInfo && w.file) this.copyFile(w.key, w.file.path, fileInfo.filename);
			const exists = cur?.attRow;
			if (!exists) {
				this.run(
					"INSERT INTO itemAttachments (itemID, parentItemID, linkMode, contentType, charsetID, path, syncState, storageModTime, storageHash, lastProcessedModificationTime, lastRead) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL)",
					itemID,
					parentID,
					att.linkMode,
					att.contentType,
					att.charsetID,
					att.path,
				);
			} else if (flags.attachment || fileInfo) {
				this.run(
					`UPDATE itemAttachments SET parentItemID = ?, linkMode = ?, contentType = ?, charsetID = ?, path = ?${fileInfo ? ", syncState = 0" : ""} WHERE itemID = ?`,
					parentID,
					att.linkMode,
					att.contentType,
					att.charsetID,
					att.path,
					itemID,
				);
			}
			if (noteIn !== null && (!cur || flags.note)) {
				const title = noteToTitle(cleanNote(String(data.note ?? "")));
				if (this.get("SELECT 1 x FROM itemNotes WHERE itemID = ?", itemID)) {
					this.run("UPDATE itemNotes SET note = ?, title = ? WHERE itemID = ?", noteIn, title, itemID);
				} else {
					this.run("INSERT INTO itemNotes (itemID, parentItemID, note, title) VALUES (?, NULL, ?, ?)", itemID, noteIn, title);
				}
				this.ftRun("REPLACE INTO ftindex.fulltextNoteIndexState (itemID, version) VALUES (?, 0)", itemID);
			}
		}

		// collections (after parent rows exist)
		if ((!isChild || !parentID) && (!cur || flags.collections)) {
			const oldC = cur
				? this.all("SELECT collectionID FROM collectionItems WHERE itemID = ?", itemID).map((r) => r.collectionID as number)
				: [];
			const oldSet = new Set(oldC);
			const newSet = new Set(collectionIDsIn);
			for (const c of oldC)
				if (!newSet.has(c)) this.run("DELETE FROM collectionItems WHERE collectionID = ? AND itemID = ?", c, itemID);
			for (const c of collectionIDsIn) {
				if (oldSet.has(c)) continue;
				const o = this.get("SELECT IFNULL(MAX(orderIndex) + 1, 0) AS o FROM collectionItems WHERE collectionID = ?", c);
				this.run("INSERT OR IGNORE INTO collectionItems (collectionID, itemID, orderIndex) VALUES (?, ?, ?)", c, itemID, o?.o ?? 0);
			}
		}
		if (!cur || flags.tags) this.writeTags(itemID, tagsIn, cur?.input?.tags ?? []);
		if (!cur || flags.relations) {
			this.run("DELETE FROM itemRelations WHERE itemID = ?", itemID);
			for (const [p, o] of relIn)
				this.run(
					"INSERT OR IGNORE INTO itemRelations (itemID, predicateID, object) VALUES (?, ?, ?)",
					itemID,
					this.predicateId(p),
					o,
				);
		}
		if (wantDeleted !== null && (!cur ? wantDeleted : wantDeleted !== cur.deleted)) this.setDeleted(itemID, wantDeleted);
		if (pubChange) this.setInPublications(itemID, wantPub);

		this.bump("items", "itemID", itemID);
		return { changed: true, path: filePath ?? undefined, dateModified: dm };
	}

	private attachmentPathFor(key: string, att: { linkMode: number; path: string | null } | null, row?: Row): string | null {
		const lm = att?.linkMode ?? row?.linkMode;
		const path = att?.path ?? row?.path ?? null;
		if (lm === undefined || lm === 3 || !path) return null;
		if (lm === 2) return fromRelativeAttachmentPath(path, this.baseAttach);
		return path.startsWith("storage:") ? join(this.dataDir, "storage", key, path.slice("storage:".length)) : null;
	}

	private copyFile(key: string, src: string, filename: string): void {
		if (!existsSync(src)) throw new ZoteroWriteError(`attachment file not found: ${src}`);
		const dir = join(this.dataDir, "storage", key);
		const dest = join(dir, filename);
		const stage = `${dest}.zn-stage`;
		this.fileUndo.push({ dir, createdDir: !existsSync(dir), file: stage, hadFile: false });
		mkdirSync(dir, { recursive: true });
		copyFileSync(src, stage); // the existing file (if any) is untouched until the transaction has committed
		this.staged.push({ stage, dest });
	}

	private setDeleted(itemID: number, deleted: boolean): void {
		if (deleted) this.run("INSERT OR IGNORE INTO deletedItems (itemID, dateDeleted) VALUES (?, ?)", itemID, this.now);
		else this.run("DELETE FROM deletedItems WHERE itemID = ?", itemID);
	}

	private hasPubsTable: boolean | undefined;
	private setInPublications(itemID: number, on: boolean): void {
		// every Zotero 5+ schema has the table; a stripped-down test library may not — then there is nothing to keep in step
		this.hasPubsTable ??= !!this.get("SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = 'publicationsItems'");
		if (!this.hasPubsTable) return;
		if (on) this.run("INSERT OR IGNORE INTO publicationsItems (itemID) VALUES (?)", itemID);
		else this.run("DELETE FROM publicationsItems WHERE itemID = ?", itemID);
	}

	trashItem(key: string, restore: boolean): { changed: boolean; dateModified: string } {
		const r = this.findItem(key);
		if (!r) throw new ZoteroWriteError(`item ${key} not found`);
		const trashed = !!this.get("SELECT 1 x FROM deletedItems WHERE itemID = ?", r.itemID);
		if (trashed === !restore) {
			const it = this.get("SELECT dateModified FROM items WHERE itemID = ?", r.itemID);
			return { changed: false, dateModified: it?.dateModified };
		}
		this.setDeleted(r.itemID as number, !restore);
		this.run("UPDATE items SET dateModified = ?, clientDateModified = ?, synced = 0 WHERE itemID = ?", this.now, this.now, r.itemID);
		this.bump("items", "itemID", r.itemID as number);
		return { changed: true, dateModified: this.now };
	}

	eraseItem(key: string): { changed: boolean } {
		const r = this.findItem(key);
		if (!r) return { changed: false }; // already gone
		this.eraseItemById(r.itemID as number, key);
		this.bumpLibrary();
		return { changed: true };
	}

	private eraseItemById(itemID: number, key: string): void {
		const typeName = this.lk.typeName.get(this.get("SELECT itemTypeID FROM items WHERE itemID = ?", itemID)?.itemTypeID);
		// children first (notes/attachments of a regular item, annotations of an attachment)
		const kids = this.all(
			`SELECT itemID FROM itemNotes WHERE parentItemID = ?1 UNION SELECT itemID FROM itemAttachments WHERE parentItemID = ?1
			 UNION SELECT itemID FROM itemAnnotations WHERE parentItemID = ?1`,
			itemID,
		);
		for (const k of kids) {
			const kr = this.get("SELECT key FROM items WHERE itemID = ?", k.itemID);
			if (kr) this.eraseItemById(k.itemID as number, kr.key);
		}
		const att = this.get("SELECT linkMode FROM itemAttachments WHERE itemID = ?", itemID);
		if (att && (att.linkMode === 0 || att.linkMode === 1)) {
			const dir = join(this.dataDir, "storage", key);
			this.afterCommit.push(() => rmSync(dir, { recursive: true, force: true }));
		}
		// related-item relations pointing at this item
		const dcRelation = this.get("SELECT predicateID FROM relationPredicates WHERE predicate = 'dc:relation'");
		if (dcRelation) {
			const uri = this.itemUri(key);
			for (const rel of this.all(
				"SELECT itemID FROM itemRelations WHERE predicateID = ? AND object = ?",
				dcRelation.predicateID,
				uri,
			)) {
				this.run(
					"DELETE FROM itemRelations WHERE itemID = ? AND predicateID = ? AND object = ?",
					rel.itemID,
					dcRelation.predicateID,
					uri,
				);
				this.run("UPDATE items SET synced = 0, clientDateModified = ? WHERE itemID = ?", this.now, rel.itemID);
				this.bump("items", "itemID", rel.itemID as number);
			}
		}
		const tagIDs = this.all("SELECT tagID FROM itemTags WHERE itemID = ?", itemID).map((t) => t.tagID as number);
		const creatorIDs = this.all("SELECT creatorID FROM itemCreators WHERE itemID = ?", itemID).map((c) => c.creatorID as number);
		// full-text index cleanup (notes + attachments); best effort
		if (typeName === "note" || typeName === "attachment") {
			this.ftRun("DELETE FROM ftindex.fulltextNotes WHERE rowid = ?", itemID);
			this.ftRun("DELETE FROM ftindex.fulltextNotesCJK WHERE rowid = ?", itemID);
			this.ftRun("DELETE FROM ftindex.noteText WHERE itemID = ?", itemID);
			this.ftRun("DELETE FROM ftindex.fulltextNoteIndexState WHERE itemID = ?", itemID);
		}
		if (typeName === "attachment") {
			this.ftRun("DELETE FROM ftindex.fulltextContent WHERE rowid = ?", itemID);
			this.ftRun("DELETE FROM ftindex.fulltextContentCJK WHERE rowid = ?", itemID);
			this.ftRun("DELETE FROM ftindex.fulltextIndexState WHERE itemID = ?", itemID);
		}
		this.run(
			"REPLACE INTO syncDeleteLog (syncObjectTypeID, libraryID, key, dateDeleted) VALUES (?, ?, ?, ?)",
			SYNC_OBJECT_ITEM,
			this.lib,
			key,
			this.now,
		);
		this.run("DELETE FROM items WHERE itemID = ?", itemID);
		for (const t of tagIDs) this.purgeTag(t);
		for (const c of new Set(creatorIDs)) this.purgeCreator(c);
	}

	// ---- annotations -----------------------------------------------------------------------
	upsertAnnotation(w: ZoteroWrite): { changed: boolean; dateModified: string } {
		const data = w.data;
		if (!data) throw new ZoteroWriteError("upsert without data");
		const existingRow = this.findItem(w.key);
		const cur = existingRow ? loadItems(this.db, this.lk, [existingRow.itemID]).get(existingRow.itemID) : undefined;
		if (cur && !cur.annotation) throw new ZoteroWriteError(`${w.key} is not an annotation`);
		const parentKey = typeof data.parentItem === "string" && data.parentItem ? data.parentItem : (cur?.annotation?.parentKey ?? null);
		if (!parentKey) throw new ZoteroWriteError("annotation needs parentItem (attachment key)");
		const parent = this.get(
			"SELECT i.itemID, a.linkMode, a.contentType FROM items i JOIN itemAttachments a ON a.itemID = i.itemID WHERE i.libraryID = ? AND i.key = ?",
			this.lib,
			parentKey,
		);
		if (!parent) throw new ZoteroWriteError(`annotation parent ${parentKey} is not an attachment`);
		if (parent.linkMode === 3 || !READER_CONTENT_TYPES.has(String(parent.contentType))) {
			throw new ZoteroWriteError("annotation parent must be a PDF, EPUB or HTML snapshot file attachment");
		}
		const typeName = String(data.type ?? "");
		const typeInt = ANNOTATION_TYPE_IDS[typeName];
		if (!typeInt) throw new ZoteroWriteError(`invalid annotation type '${typeName}'`);
		let position: string;
		try {
			position = typeof data.position === "string" ? JSON.stringify(JSON.parse(data.position)) : JSON.stringify(data.position);
		} catch {
			throw new ZoteroWriteError("annotation position is not valid JSON");
		}
		if (position === undefined || position.length > 65000) throw new ZoteroWriteError("annotation position missing or too large");
		const sortIndex = str(data.sortIndex);
		if (!sortIndex) throw new ZoteroWriteError("annotation sortIndex missing");
		const incoming = {
			type: typeInt,
			authorName: str(data.authorName) || null,
			text: str(data.text) || null,
			comment: str(data.comment) || null,
			color: str(data.color) || DEFAULT_ANNOTATION_COLOR,
			pageLabel: str(data.pageLabel) || null,
			sortIndex,
			position,
		};
		const tagsIn = this.normTags(data.tags);
		const incomingDM = isoToSql(str(data.dateModified));
		if (cur?.annotation) {
			const a = cur.annotation;
			const same =
				a.parentID === parent.itemID &&
				a.type === incoming.type &&
				(a.authorName || null) === incoming.authorName &&
				(a.text || null) === incoming.text &&
				(a.comment || null) === incoming.comment &&
				(a.color || DEFAULT_ANNOTATION_COLOR) === incoming.color &&
				(a.pageLabel || null) === incoming.pageLabel &&
				a.sortIndex === incoming.sortIndex &&
				sameJson(JSON.parse(a.position), JSON.parse(incoming.position)) &&
				sameJson(a.tags.map((t) => `${t.type}:${t.tag}`).sort(), tagsIn.map((t) => `${t.type}:${t.tag}`).sort()) &&
				(data.deleted === undefined || !!data.deleted === cur.deleted);
			if (same) return { changed: false, dateModified: cur.dateModified };
		}
		checkBaseline(w, cur?.dateModified);
		let itemID: number;
		let dm: string;
		if (!cur) {
			dm = incomingDM ?? this.now;
			itemID = Number(
				this.run(
					"INSERT INTO items (itemTypeID, dateAdded, dateModified, clientDateModified, libraryID, key, version, synced) VALUES (?, ?, ?, ?, ?, ?, 0, 0)",
					this.lk.typeId.get("annotation"),
					isoToSql(str(data.dateAdded)) ?? this.now,
					dm,
					this.now,
					this.lib,
					w.key,
				).lastInsertRowid,
			);
		} else {
			itemID = cur.itemID;
			dm = incomingDM && incomingDM !== cur.dateModified ? incomingDM : this.now;
			this.run("UPDATE items SET dateModified = ?, clientDateModified = ?, synced = 0 WHERE itemID = ?", dm, this.now, itemID);
		}
		this.run(
			"REPLACE INTO itemAnnotations (itemID, parentItemID, type, authorName, text, textNormalized, comment, commentNormalized, color, pageLabel, sortIndex, position, isExternal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
			itemID,
			parent.itemID,
			incoming.type,
			incoming.authorName,
			incoming.text,
			normalizeForSearchStorage(incoming.text),
			incoming.comment,
			normalizeForSearchStorage(incoming.comment),
			incoming.color,
			incoming.pageLabel,
			incoming.sortIndex,
			incoming.position,
		);
		this.writeTags(itemID, tagsIn, cur?.annotation?.tags ?? []);
		if (data.deleted !== undefined) this.setDeleted(itemID, !!data.deleted);
		this.bump("items", "itemID", itemID);
		return { changed: true, dateModified: dm };
	}

	// ---- collections -----------------------------------------------------------------------
	private descendants(collectionID: number): number[] {
		const out: number[] = [];
		const stack = [collectionID];
		while (stack.length) {
			const id = stack.pop() as number;
			for (const r of this.all("SELECT collectionID FROM collections WHERE parentCollectionID = ?", id)) {
				out.push(r.collectionID as number);
				stack.push(r.collectionID as number);
			}
		}
		return out;
	}

	upsertCollection(w: ZoteroWrite): { changed: boolean; dateModified: string } {
		const data = w.data;
		if (!data) throw new ZoteroWriteError("upsert without data");
		const cur = this.findCollection(w.key);
		const name = str(data.name ?? cur?.collectionName)?.trim();
		if (!name) throw new ZoteroWriteError("collection name missing");
		let parentID: number | null = null;
		const pk = data.parentCollection;
		if (typeof pk === "string" && pk) {
			const p = this.findCollection(pk);
			if (!p) throw new ZoteroWriteError(`parent collection ${pk} not found`);
			parentID = p.collectionID as number;
			if (cur && (parentID === cur.collectionID || this.descendants(cur.collectionID as number).includes(parentID))) {
				throw new ZoteroWriteError("collection cannot be moved into itself or a descendant");
			}
		}
		const wantDeleted = data.deleted === undefined ? null : !!data.deleted;
		let changed = false;
		let id: number;
		if (!cur) {
			id = Number(
				this.run(
					"INSERT INTO collections (collectionName, parentCollectionID, clientDateModified, libraryID, key, version, synced) VALUES (?, ?, ?, ?, ?, 0, 0)",
					name,
					parentID,
					this.now,
					this.lib,
					w.key,
				).lastInsertRowid,
			);
			changed = true;
		} else {
			id = cur.collectionID as number;
			if (cur.collectionName !== name || (cur.parentCollectionID ?? null) !== parentID) {
				this.run(
					"UPDATE collections SET collectionName = ?, parentCollectionID = ?, clientDateModified = ?, synced = 0 WHERE collectionID = ?",
					name,
					parentID,
					this.now,
					id,
				);
				changed = true;
			}
		}
		if (wantDeleted !== null) {
			const trashed = !!this.get("SELECT 1 x FROM deletedCollections WHERE collectionID = ?", id);
			if (wantDeleted !== trashed) {
				this.setCollectionDeleted(id, wantDeleted);
				changed = true;
			}
		}
		if (changed) this.bump("collections", "collectionID", id);
		const row = this.get("SELECT clientDateModified FROM collections WHERE collectionID = ?", id);
		return { changed, dateModified: row?.clientDateModified ?? this.now };
	}

	private setCollectionDeleted(id: number, deleted: boolean): void {
		if (deleted) {
			for (const c of [id, ...this.descendants(id)]) {
				this.run("INSERT OR IGNORE INTO deletedCollections (collectionID, dateDeleted) VALUES (?, ?)", c, this.now);
				this.run("UPDATE collections SET synced = 0, clientDateModified = ? WHERE collectionID = ?", this.now, c);
			}
		} else {
			this.run("DELETE FROM deletedCollections WHERE collectionID = ?", id);
			this.run("UPDATE collections SET synced = 0, clientDateModified = ? WHERE collectionID = ?", this.now, id);
		}
	}

	trashCollection(key: string, restore: boolean): { changed: boolean; dateModified: string } {
		const c = this.findCollection(key);
		if (!c) throw new ZoteroWriteError(`collection ${key} not found`);
		const id = c.collectionID as number;
		const trashed = !!this.get("SELECT 1 x FROM deletedCollections WHERE collectionID = ?", id);
		if (trashed === !restore) return { changed: false, dateModified: this.now };
		this.setCollectionDeleted(id, !restore);
		this.bump("collections", "collectionID", id);
		return { changed: true, dateModified: this.now };
	}

	eraseCollection(key: string): { changed: boolean } {
		const c = this.findCollection(key);
		if (!c) return { changed: false };
		const id = c.collectionID as number;
		const all = [...this.descendants(id).reverse(), id]; // deepest first
		for (const cid of all) {
			const ck = this.get("SELECT key FROM collections WHERE collectionID = ?", cid)?.key;
			this.run("DELETE FROM collectionItems WHERE collectionID = ?", cid);
			this.run("UPDATE collections SET parentCollectionID = NULL WHERE parentCollectionID = ?", cid);
			this.run("DELETE FROM collections WHERE collectionID = ?", cid);
			if (ck)
				this.run(
					"REPLACE INTO syncDeleteLog (syncObjectTypeID, libraryID, key, dateDeleted) VALUES (?, ?, ?, ?)",
					SYNC_OBJECT_COLLECTION,
					this.lib,
					ck,
					this.now,
				);
		}
		this.bumpLibrary();
		return { changed: true };
	}
}

function collectionsNeedRemoval(flags: { parent: boolean }, cur: LoadedItem, isChild: boolean, parentID: number | null): boolean {
	// A standalone note/attachment that becomes a child leaves its collections (Zotero's trigger does
	// the same; doing it explicitly keeps the later collectionItems rewrite consistent).
	return isChild && flags.parent && !cur.parentID && parentID !== null;
}

export class ZoteroDbWriter implements ZoteroWriter {
	readonly dataDir: string;
	readonly dbPath: string;
	private baseAttach: string | null;

	constructor(private opts: ZoteroDbOptions = {}) {
		this.dataDir = opts.dataDir ?? findZoteroDataDir(opts.profilesDir);
		this.dbPath = join(this.dataDir, "zotero.sqlite");
		this.baseAttach = opts.baseAttachmentPath !== undefined ? opts.baseAttachmentPath : findBaseAttachmentPath(opts.profilesDir);
	}

	private async running(): Promise<boolean> {
		return (this.opts.isRunning ?? isZoteroProcessRunning)();
	}

	async canWrite(): Promise<boolean> {
		if (!existsSync(this.dbPath)) return false;
		if (await this.running()) return false;
		return probeWritable(this.dbPath);
	}

	private backup(db: Database): string {
		const dir = join(this.dataDir, "zotero-next-backups");
		mkdirSync(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const path = join(dir, `zotero-${stamp}.sqlite`);
		db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
		const keep = this.opts.keepBackups ?? 5;
		const old = readdirSync(dir)
			.filter((f) => /^zotero-.*\.sqlite$/.test(f))
			.sort()
			.reverse()
			.slice(keep);
		for (const f of old) rmSync(join(dir, f), { force: true });
		return path;
	}

	async apply(writes: ZoteroWrite[]): Promise<{ backupPath: string; results: ZoteroDbWriteResult[] }> {
		if (writes.length === 0) return { backupPath: "", results: [] };
		if (await this.running()) throw new ZoteroLockedError();
		if (!existsSync(this.dbPath)) throw new Error(`zotero.sqlite not found in ${this.dataDir}`);

		let db: Database | null = null;
		let inTx = false;
		let session: Session | null = null;
		try {
			try {
				db = new Database(this.dbPath, { readwrite: true });
				db.exec("PRAGMA busy_timeout = 500");
				db.exec("PRAGMA foreign_keys = ON");
				db.query("SELECT 1 FROM libraries LIMIT 1").get();
			} catch (e) {
				if (isBusyError(e)) throw new ZoteroLockedError();
				throw e;
			}
			let backupPath: string;
			try {
				backupPath = this.backup(db);
			} catch (e) {
				if (isBusyError(e)) throw new ZoteroLockedError();
				throw e;
			}
			const ftPath = join(this.dataDir, "fulltext.sqlite");
			let ft = false;
			if (existsSync(ftPath)) {
				try {
					db.exec(`ATTACH DATABASE '${ftPath.replaceAll("'", "''")}' AS ftindex`);
					ft = true;
				} catch {
					ft = false;
				}
			}
			try {
				db.exec("BEGIN IMMEDIATE");
				inTx = true;
			} catch (e) {
				if (isBusyError(e)) throw new ZoteroLockedError();
				throw e;
			}
			if (await this.running()) throw new ZoteroLockedError();

			const lk = loadLookups(db);
			const lib = userLibraryID(db, this.opts.libraryID);
			session = new Session(db, lk, lib, this.dataDir, this.baseAttach, ft);
			const results: ZoteroDbWriteResult[] = new Array(writes.length);
			const order = writes.map((w, i) => i).sort((a, b) => rank(writes[a]) - rank(writes[b]) || a - b);
			for (const i of order) {
				const w = writes[i];
				db.exec("SAVEPOINT w");
				const mark = session.stageMark();
				const commitMark = session.afterCommit.length;
				try {
					const r = this.applyOne(session, w);
					db.exec("RELEASE w");
					results[i] = { key: w.key, ok: true, ...r };
				} catch (e) {
					if (!(e instanceof ZoteroWriteError)) throw e;
					db.exec("ROLLBACK TO w");
					session.dropStaged(mark);
					session.dropAfterCommit(commitMark);
					db.exec("RELEASE w");
					results[i] = { key: w.key, ok: false, error: e.message };
				}
			}

			// integrity gate before COMMIT
			const ic = db.query("PRAGMA main.integrity_check").all() as Row[];
			if (ic.length !== 1 || Object.values(ic[0])[0] !== "ok") {
				throw new Error(`integrity_check failed: ${JSON.stringify(ic).slice(0, 500)}`);
			}
			const fk = db.query("PRAGMA foreign_key_check").all();
			if (fk.length) throw new Error(`foreign_key_check failed: ${JSON.stringify(fk).slice(0, 500)}`);

			db.exec("COMMIT");
			inTx = false;
			session.commitStaged();
			for (const f of session.afterCommit) {
				try {
					f();
				} catch {
					// removing an erased attachment's storage folder is best effort
				}
			}
			try {
				db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} catch {
				// non-fatal
			}
			return { backupPath, results };
		} catch (e) {
			if (db && inTx) {
				try {
					db.exec("ROLLBACK");
				} catch {
					// ignore
				}
			}
			session?.rollbackFiles();
			if (e instanceof ZoteroLockedError) throw e;
			if (isBusyError(e)) throw new ZoteroLockedError();
			throw e;
		} finally {
			try {
				db?.close(true);
			} catch {
				// ignore
			}
		}
	}

	private applyOne(s: Session, w: ZoteroWrite): Partial<ZoteroDbWriteResult> {
		if (!w.key) throw new ZoteroWriteError("write without key");
		if (w.op === "erase") {
			const r = w.type === "collection" ? s.eraseCollection(w.key) : s.eraseItem(w.key);
			return { changed: r.changed };
		}
		if (w.op === "trash" || w.op === "restore") {
			const r = w.type === "collection" ? s.trashCollection(w.key, w.op === "restore") : s.trashItem(w.key, w.op === "restore");
			return { changed: r.changed, dateModified: toIsoOrUndef(r.dateModified) };
		}
		if (w.type === "collection") {
			const r = s.upsertCollection(w);
			return { changed: r.changed, dateModified: toIsoOrUndef(r.dateModified) };
		}
		if (w.type === "annotation") {
			const r = s.upsertAnnotation(w);
			return { changed: r.changed, dateModified: toIsoOrUndef(r.dateModified) };
		}
		const r = s.upsertItem(w);
		return { changed: r.changed, path: r.path, dateModified: toIsoOrUndef(r.dateModified) };
	}
}

function toIsoOrUndef(sql: string | undefined): string | undefined {
	return sql ? `${sql.replace(" ", "T")}Z` : undefined;
}
