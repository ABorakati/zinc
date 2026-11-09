// Libraries: My Library (id 1) and the group libraries synced from zotero.org (migration 4). Every item and collection row
// carries a library_id; the functions here read the registry and guard writes to a read-only library.

import type { Database } from "bun:sqlite";
import { generateKey, HttpError } from "./db";

/** My Library. Exists in every library file; rows that predate groups belong to it. */
export const USER_LIBRARY = 1;

export interface Library {
	/** Local id (the `library` query parameter and the library_id column). */
	id: number;
	type: "user" | "group";
	/** The group's id on zotero.org; absent for My Library. */
	groupId?: number;
	name: string;
	/** False for a group where this user may not edit: the app disables editing and nothing is pushed. */
	editable: boolean;
	/** False when the group does not let this user change files. */
	filesEditable: boolean;
	removed: boolean;
}

interface LibraryRow {
	id: number;
	type: "user" | "group";
	group_id: number | null;
	name: string;
	editable: number;
	files_editable: number;
	removed: number;
}

const toLibrary = (r: LibraryRow): Library => ({
	id: r.id,
	type: r.type,
	...(r.group_id !== null ? { groupId: r.group_id } : {}),
	name: r.name,
	editable: !!r.editable,
	filesEditable: !!r.files_editable,
	removed: !!r.removed,
});

const COLS = "id, type, group_id, name, editable, files_editable, removed";

/** My Library first, then the groups by name. Libraries that left the account's group list (removed) are left out unless asked for. */
export function listLibraries(db: Database, opts: { includeRemoved?: boolean } = {}): Library[] {
	const rows = db
		.query(`SELECT ${COLS} FROM libraries ${opts.includeRemoved ? "" : "WHERE removed = 0"} ORDER BY (id = ${USER_LIBRARY}) DESC, name COLLATE NOCASE, id`)
		.all() as LibraryRow[];
	return rows.map(toLibrary);
}

export function getLibrary(db: Database, id: number): Library | null {
	const r = db.query(`SELECT ${COLS} FROM libraries WHERE id = ?`).get(id) as LibraryRow | null;
	return r ? toLibrary(r) : null;
}

export function libraryByGroupId(db: Database, groupId: number): Library | null {
	const r = db.query(`SELECT ${COLS} FROM libraries WHERE group_id = ?`).get(groupId) as LibraryRow | null;
	return r ? toLibrary(r) : null;
}

/** Reads a `library` request value (query string or body): absent means My Library. Throws 400/404 for anything else. */
export function resolveLibrary(db: Database, value: unknown): number {
	if (value === undefined || value === null || value === "") return USER_LIBRARY;
	const id = typeof value === "number" ? value : /^\d+$/.test(String(value)) ? Number(value) : NaN;
	if (!Number.isInteger(id) || id < 1) throw new HttpError(400, "library must be a library id");
	if (!getLibrary(db, id)) throw new HttpError(404, "library not found");
	return id;
}

export function libraryOfItem(db: Database, key: string): number | null {
	const r = db.query("SELECT library_id AS id FROM items WHERE key = ?").get(key) as { id: number } | null;
	return r ? r.id : null;
}

export function libraryOfCollection(db: Database, key: string): number | null {
	const r = db.query("SELECT library_id AS id FROM collections WHERE key = ?").get(key) as { id: number } | null;
	return r ? r.id : null;
}

/** Throws 403 when the library is read-only for this user. */
export function assertWritable(db: Database, libraryId: number): void {
	if (libraryId === USER_LIBRARY) return;
	const l = getLibrary(db, libraryId);
	if (!l) throw new HttpError(404, "library not found");
	if (!l.editable) throw new HttpError(403, `"${l.name}" is a read-only library`);
}

/** Throws 403 when this user may not change files in the library (a group can allow metadata edits but forbid file edits). */
export function assertFilesWritable(db: Database, libraryId: number): void {
	if (libraryId === USER_LIBRARY) return;
	assertWritable(db, libraryId);
	const l = getLibrary(db, libraryId)!;
	if (!l.filesEditable) throw new HttpError(403, `"${l.name}" does not allow file changes`);
}

/** assertFilesWritable for the library an item lives in (a missing item is left for the caller's own 404). */
export function assertItemFilesWritable(db: Database, itemKey: string): void {
	const lib = libraryOfItem(db, itemKey);
	if (lib !== null) assertFilesWritable(db, lib);
}

/** assertWritable for the library an item lives in (a missing item is left for the caller's own 404). */
export function assertItemWritable(db: Database, itemKey: string): void {
	const lib = libraryOfItem(db, itemKey);
	if (lib !== null) assertWritable(db, lib);
}

/**
 * The URI prefix Zotero uses for items of a library in relations and citations: groups/<groupId> for a group, users/<userId>
 * for My Library once an account is linked, else users/local/<library key>. Add "/items/<KEY>" for an item.
 */
export function libraryUriBase(db: Database, libraryId: number): string {
	if (libraryId !== USER_LIBRARY) {
		const g = getLibrary(db, libraryId)?.groupId;
		if (g !== undefined) return `http://zotero.org/groups/${g}`;
	}
	try {
		const uid = (db.query("SELECT value FROM sync_state WHERE name = 'web_user_id'").get() as { value: string } | null)?.value;
		if (uid && /^\d+$/.test(uid)) return `http://zotero.org/users/${uid}`;
	} catch {
		// no sync state table: not linked
	}
	return localUriBase(db);
}

function localUriBase(db: Database): string {
	let key = (db.query("SELECT value FROM meta WHERE name = 'library_key'").get() as { value: string } | null)?.value;
	if (!key) {
		key = generateKey();
		db.query("INSERT INTO meta(name, value) VALUES('library_key', ?)").run(key);
	}
	return `http://zotero.org/users/local/${key}`;
}

/** Every URI prefix an item of this library can be cited or related by (the canonical one first). */
export function libraryUriBases(db: Database, libraryId: number): string[] {
	const out = [libraryUriBase(db, libraryId)];
	if (libraryId === USER_LIBRARY) out.push(localUriBase(db));
	return [...new Set(out)];
}

export const itemUri = (db: Database, libraryId: number, key: string): string => `${libraryUriBase(db, libraryId)}/items/${key}`;

export interface GroupInfo {
	groupId: number;
	name: string;
	editable: boolean;
	filesEditable: boolean;
	version: number;
}

/** Adds a group library or updates its name and permissions. A group that had been removed comes back. Returns its local id. */
export function upsertGroupLibrary(db: Database, g: GroupInfo): Library {
	db.query(
		`INSERT INTO libraries(type, group_id, name, editable, files_editable, group_version, removed) VALUES('group', ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(group_id) DO UPDATE SET name = excluded.name, editable = excluded.editable, files_editable = excluded.files_editable,
		 group_version = excluded.group_version, removed = 0`,
	).run(g.groupId, g.name, g.editable ? 1 : 0, g.filesEditable ? 1 : 0, g.version);
	return libraryByGroupId(db, g.groupId)!;
}

/** Marks groups missing from the account's current list as removed: hidden and no longer synced, their data kept. */
export function markGroupsRemoved(db: Database, presentGroupIds: number[]): void {
	db.query("UPDATE libraries SET removed = 1 WHERE type = 'group' AND removed = 0 AND group_id NOT IN (SELECT value FROM json_each(?))").run(
		JSON.stringify(presentGroupIds),
	);
}

/** Last pulled and last written zotero.org library versions for a library. */
export function libraryVersions(db: Database, id: number): { pull: number; write: number } {
	const r = db.query("SELECT web_version AS pull, web_write_version AS write FROM libraries WHERE id = ?").get(id) as { pull: number; write: number } | null;
	return r ?? { pull: 0, write: 0 };
}

export function setLibraryVersions(db: Database, id: number, v: { pull?: number; write?: number }): void {
	if (v.pull !== undefined) db.query("UPDATE libraries SET web_version = ? WHERE id = ?").run(v.pull, id);
	if (v.write !== undefined) db.query("UPDATE libraries SET web_write_version = ? WHERE id = ?").run(v.write, id);
}
