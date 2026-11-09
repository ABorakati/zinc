// Routes under /api/maintenance/: trash erasing, tag maintenance, attachment file renaming.
// GET  /trash?olderThanDays=       -> {items, total}   (counts for the confirmation dialog)
// POST /empty-trash {olderThanDays?}
// POST /erase {keys[]}
// POST /erase/preview {keys[]}     -> {items, total}
// GET  /tags/automatic?library=    -> [{tag, count}]
// POST /tags/rename {from, to, library?}     (merges when `to` exists)
// POST /tags/delete {tags[], library?}
// POST /tags/delete-automatic {library?}
// Tag routes act on one library (the `library` id, default My Library) and answer 403 for a read-only one.
// POST /rename-files {attachmentKeys[]}
import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { HttpError } from "../db";
import { eraseItems, trashCounts, trashedKeys, withDescendants } from "./erase";
import { resolveLibrary } from "../libraries";

/** The library a maintenance request is about: the one named, else My Library. */
const libOf = (db: Database, v: unknown): number => resolveLibrary(db, v);
import { renameFiles } from "./rename-files";
import { automaticTags, deleteAutomaticTags, deleteTags, renameTag } from "./tags";

let storageOverride: string | null | undefined;

/** Tests: set zotero-next's attachment storage dir (undefined restores <db dir>/storage). */
export function setStorageDir(dir: string | null | undefined): void {
	storageOverride = dir;
}

function ownStorage(db: Database): string | null {
	if (storageOverride !== undefined) return storageOverride;
	const file = (db as unknown as { filename?: string }).filename;
	return file ? join(dirname(file), "storage") : null;
}

async function body(req: Request): Promise<Record<string, unknown>> {
	try {
		const b = await req.json();
		return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
	} catch {
		throw new HttpError(400, "invalid JSON body");
	}
}

function strings(v: unknown, name: string): string[] {
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new HttpError(400, `${name} must be an array of strings`);
	return v as string[];
}

function days(v: unknown): number | undefined {
	if (v === undefined || v === null || v === "") return undefined;
	const n = Number(v);
	if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "olderThanDays must be a non-negative number");
	return n;
}

export async function handleMaintenanceApi(req: Request, db: Database): Promise<Response | null> {
	const { pathname } = new URL(req.url);
	if (!pathname.startsWith("/api/maintenance/")) return null;
	// Feature handlers run outside handleApi's try/catch.
	try {
		return await dispatch(req, db);
	} catch (e) {
		if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
		console.error(e);
		return Response.json({ error: e instanceof Error ? e.message : "internal error" }, { status: 500 });
	}
}

async function dispatch(req: Request, db: Database): Promise<Response> {
	const url = new URL(req.url);
	const route = url.pathname.slice("/api/maintenance/".length).replace(/\/$/, "");
	const m = req.method;

	if (m === "GET" && route === "trash") return Response.json(trashCounts(db, days(url.searchParams.get("olderThanDays")), libOf(db, url.searchParams.get("library"))));
	if (m === "GET" && route === "tags/automatic") return Response.json(automaticTags(db, libOf(db, url.searchParams.get("library"))));
	if (m === "POST" && route === "empty-trash") {
		const b = await body(req);
		return Response.json(eraseItems(db, trashedKeys(db, days(b.olderThanDays), libOf(db, b.library)), ownStorage(db)));
	}
	if (m === "POST" && route === "erase") {
		const keys = strings((await body(req)).keys, "keys");
		return Response.json(eraseItems(db, keys, ownStorage(db)));
	}
	if (m === "POST" && route === "erase/preview") {
		const keys = strings((await body(req)).keys, "keys");
		return Response.json({ items: keys.length, total: withDescendants(db, keys).length });
	}
	if (m === "POST" && route === "tags/rename") {
		const b = await body(req);
		return Response.json(renameTag(db, b.from, b.to, libOf(db, b.library)));
	}
	if (m === "POST" && route === "tags/delete") {
		const b = await body(req);
		return Response.json(deleteTags(db, b.tags, libOf(db, b.library)));
	}
	if (m === "POST" && route === "tags/delete-automatic") return Response.json(deleteAutomaticTags(db, libOf(db, (await body(req)).library)));
	if (m === "POST" && route === "rename-files") {
		const keys = strings((await body(req)).attachmentKeys, "attachmentKeys");
		return Response.json({ results: renameFiles(db, keys, ownStorage(db)) });
	}
	return Response.json({ error: "not found" }, { status: 404 });
}
