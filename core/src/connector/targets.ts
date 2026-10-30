// Save targets as the Connector sees them: tree-view IDs "L1" (the library) and "C<collectionKey>".
// zotero-next has one library, so the library is always "L1" ("My Library").
import type { Database } from "bun:sqlite";
import type { Collection } from "../api-types";
import { getCollection, listCollections, listTags } from "../db";
import { getSelection, recentTargetIds } from "./state";

export const LIBRARY_ID = 1;
export const LIBRARY_TARGET = "L1";
export const LIBRARY_NAME = "My Library";

/** The collection the UI currently has selected, or null (library / unfiled / trash / saved search / gone). */
export function selectedCollection(db: Database): Collection | null {
	const s = getSelection();
	return s.kind === "collection" && s.key ? getCollection(db, s.key) : null;
}

export type ResolvedTarget = { ok: true; collectionKey: string | null } | { ok: false; error: "COLLECTION_NOT_FOUND" | "INVALID_TARGET" };

/** Parse a target ID ("L1", "C<key>") sent by the extension. */
export function resolveTarget(db: Database, id: unknown): ResolvedTarget {
	if (typeof id !== "string" || id.length < 2) return { ok: false, error: "INVALID_TARGET" };
	if (id[0] === "L") return id === LIBRARY_TARGET ? { ok: true, collectionKey: null } : { ok: false, error: "INVALID_TARGET" };
	if (id[0] === "C") return getCollection(db, id.slice(1)) ? { ok: true, collectionKey: id.slice(1) } : { ok: false, error: "COLLECTION_NOT_FOUND" };
	return { ok: false, error: "INVALID_TARGET" };
}

export const targetIdFor = (collectionKey: string | null): string => (collectionKey ? `C${collectionKey}` : LIBRARY_TARGET);

/** The body of /connector/getSelectedCollection: the selected target plus the library/collection tree and tags. */
export function selectedCollectionResponse(db: Database) {
	const sel = selectedCollection(db);
	const all = listCollections(db); // sorted by name
	const children = new Map<string | null, Collection[]>();
	for (const c of all) {
		const p = c.parentKey && all.some((x) => x.key === c.parentKey) ? c.parentKey : null;
		(children.get(p) ?? children.set(p, []).get(p)!).push(c);
	}
	const recent = recentTargetIds();
	const targets: { id: string; name: string; filesEditable: boolean; level: number; recent?: boolean }[] = [
		{ id: LIBRARY_TARGET, name: LIBRARY_NAME, filesEditable: true, level: 0, ...(recent.has(LIBRARY_TARGET) ? { recent: true } : {}) },
	];
	const walk = (parent: string | null, level: number, seen: Set<string>) => {
		for (const c of children.get(parent) ?? []) {
			if (seen.has(c.key)) continue; // cycle guard
			seen.add(c.key);
			const id = `C${c.key}`;
			targets.push({ id, name: c.name, filesEditable: true, level, ...(recent.has(id) ? { recent: true } : {}) });
			walk(c.key, level + 1, seen);
		}
	};
	walk(null, 1, new Set());
	return {
		libraryID: LIBRARY_ID,
		libraryName: LIBRARY_NAME,
		libraryEditable: true,
		filesEditable: true,
		editable: true,
		id: sel ? `C${sel.key}` : null,
		name: sel ? sel.name : LIBRARY_NAME,
		targets,
		tags: { [LIBRARY_TARGET]: listTags(db).map((t) => ({ tag: t.tag })) },
	};
}
