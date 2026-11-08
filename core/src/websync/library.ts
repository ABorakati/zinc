// Which zotero.org library a pull, push or file job works on: the user's own (/users/<id>) or a group (/groups/<id>).
// Versions are per library. My Library keeps its versions in sync_state (where they always were); a group keeps them in its
// row of the `libraries` table.

import type { Database } from "bun:sqlite";
import { libraryVersions, setLibraryVersions, USER_LIBRARY } from "../libraries";
import { getState, setState } from "./state";

export interface LibraryRef {
	/** Local library id (libraries.id; 1 = My Library). */
	id: number;
	/** URL prefix on zotero.org: "/users/<userId>" or "/groups/<groupId>". */
	prefix: string;
}

export const userRef = (userId: number): LibraryRef => ({ id: USER_LIBRARY, prefix: `/users/${userId}` });
export const groupRef = (libraryId: number, groupId: number): LibraryRef => ({ id: libraryId, prefix: `/groups/${groupId}` });

export interface WebVersions {
	/** Library version of the last completed pull. */
	pull: number;
	/** Library version to send as If-Unmodified-Since-Version with the next write (after our own writes it runs ahead of `pull`). */
	write: number;
}

export function webVersions(db: Database, libraryId: number): WebVersions {
	if (libraryId !== USER_LIBRARY) {
		const v = libraryVersions(db, libraryId);
		return { pull: v.pull, write: v.write || v.pull };
	}
	const pull = Number(getState(db, "web_library_version")) || 0;
	const w = getState(db, "web_write_version");
	return { pull, write: w === undefined ? pull : Number(w) || 0 };
}

export function setWebVersions(db: Database, libraryId: number, v: Partial<WebVersions>): void {
	if (libraryId !== USER_LIBRARY) return setLibraryVersions(db, libraryId, v);
	if (v.pull !== undefined) setState(db, "web_library_version", String(v.pull));
	if (v.write !== undefined) setState(db, "web_write_version", String(v.write));
}
