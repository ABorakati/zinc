// HTTP API (see api-types.ts for the contract). handleApi returns null for non-/api paths.

import type { Database } from "bun:sqlite";
import { open, stat, type FileHandle } from "node:fs/promises";
import type { ReaderAnnotation, ZoteroItemData } from "./api-types";
import * as repo from "./db";
import { HttpError } from "./db";
import { handleFulltextApi } from "./fulltext/api";
import { handleReferencesApi } from "./references/api";
import { doiInPath } from "./references/sources";
import { systemOpener as makeSystemOpener } from "./os-open";
import { handleCiteApi } from "./cite/api";
import { handleAddItemsApi } from "./additems/api";
import { duplicateItem } from "./additems/duplicate";
import { handleDuplicatesApi } from "./duplicates/api";
import { handleIoApi } from "./io/api";
import { opensAsProgram } from "./io/dangerous";
import { handleChangesApi } from "./changes/api";
import { handleSearchesApi } from "./searches/api";
import { handleMaintenanceApi } from "./maintenance/api";
import { handleFilesApi } from "./files/api";
import { replaceAttachmentFile } from "./files/replace";

// Feature route modules; each returns null for paths outside its prefix.
import { handleUiApi } from "./connector/ui";
import { handleIntegrationsApi } from "./integrations/api";
import { handleBbtApi } from "./bbt/api";
import { handleTranslateApi } from "./translate/api";
const FEATURE_HANDLERS = [
	handleChangesApi,
	handleCiteApi,
	handleAddItemsApi,
	handleDuplicatesApi,
	handleIoApi,
	handleSearchesApi,
	handleMaintenanceApi,
	handleFilesApi,
	handleUiApi,
	handleIntegrationsApi,
	handleTranslateApi,
	handleBbtApi,
];
import { getSchema } from "./schema-data";
import { handleSyncApi } from "./sync/api";
import { logError } from "./log";
import { handleWebSyncApi } from "./websync/api";
import { listLibraries, resolveLibrary, USER_LIBRARY } from "./libraries";
import { pendingCount } from "./sync/build";
import { indexItem, search } from "./search";
import { itemsByUri } from "./items-by-uri";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

/** The explicit "open anyway" flag of an open-external request: {"confirm": true} in the body, or ?confirm=1. */
async function openConfirmed(req: Request): Promise<boolean> {
	if (/^(1|true|yes)$/i.test(new URL(req.url).searchParams.get("confirm") ?? "")) return true;
	try {
		return (await req.json())?.confirm === true;
	} catch {
		return false;
	}
}

async function readBody<T = any>(req: Request): Promise<T> {
	try {
		return (await req.json()) as T;
	} catch {
		throw new HttpError(400, "invalid JSON body");
	}
}

function stringArray(v: unknown, name: string): string[] {
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
		throw new HttpError(400, `${name} must be an array of strings`);
	}
	return v as string[];
}

function intParam(v: string | null): number | undefined {
	if (v === null || v === "") return undefined;
	const n = Number(v);
	if (!Number.isFinite(n)) throw new HttpError(400, `invalid number: ${v}`);
	return n;
}

// ---------------------------------------------------------------- OS openers

export interface Opener {
	reveal(path: string): void; // show the file in Explorer
	openFile(path: string): void; // open with the default app
	openUrl(url: string): void; // open in the default browser
}

// The system's own opener for this platform, run as an argument array (no shell); see os-open.ts.
const systemOpener: Opener = makeSystemOpener();

let opener: Opener = systemOpener;

// Tests inject a stub so no apps are launched. Call with no argument to restore the default.
export function setOpener(o?: Opener): void {
	opener = o ?? systemOpener;
}

// Only http(s) URLs and doi: identifiers may reach the OS; returns the URL to open.
export function safeUrl(input: unknown): string {
	if (typeof input !== "string") throw new HttpError(400, "url is required");
	let s = input.trim();
	if (!s || s.length > 4096 || /[\u0000-\u001f\u007f\s]/.test(s)) throw new HttpError(400, "invalid url");
	if (/^doi:/i.test(s)) s = `https://doi.org/${doiInPath(s.replace(/^doi:\s*/i, ""))}`;
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		throw new HttpError(400, "invalid url");
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, "only http and https URLs can be opened");
	return u.href;
}

/** Open an http(s)/doi URL in the user's browser (used by Find Full Text's "Open in browser"). */
export function openUrlExternally(url: string): void {
	opener.openUrl(safeUrl(url));
}

function attachmentFilePath(db: Database, key: string): string {
	const att = repo.getAttachment(db, key);
	if (!att) throw new HttpError(404, "attachment not found");
	if (!att.path || !repo.fileExists(att.path)) throw new HttpError(404, "file not found on disk");
	return att.path;
}

function methodNotAllowed(): never {
	throw new HttpError(405, "method not allowed");
}

export async function handleApi(req: Request, db: Database): Promise<Response | null> {
	const url = new URL(req.url);
	if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return null;
	try {
		if (url.pathname.startsWith("/api/fulltext/")) return await handleFulltextApi(req, db);
		if (url.pathname.startsWith("/api/references/")) return await handleReferencesApi(req, db);
		for (const handle of FEATURE_HANDLERS) {
			const res = await handle(req, db);
			if (res) return res;
		}
		if (url.pathname.startsWith("/api/sync/")) return await handleSyncApi(req, db);
		if (url.pathname.startsWith("/api/websync/")) return await handleWebSyncApi(req, db);
	} catch (e) {
		// what a feature handler did not expect and let escape: JSON, with the details in the log only. (Each handler's own catch,
		// and the routes below, go on saying what went wrong: "the file is open in another program" is for the user to read.)
		if (e instanceof HttpError) return json({ error: e.message }, e.status);
		logError("core", e, `${req.method} ${url.pathname}`);
		console.error(e);
		return json({ error: "internal error" }, 500);
	}
	try {
		let parts: string[];
		try {
			parts = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
		} catch {
			throw new HttpError(400, "malformed URL");
		}
		return (await route(req, url, db, parts)) ?? json({ error: "not found" }, 404);
	} catch (e) {
		if (e instanceof HttpError) return json({ error: e.message }, e.status);
		logError("core", e, `${req.method} ${url.pathname}`); // the local log (path only: no query string)
		console.error(e);
		return json({ error: e instanceof Error ? e.message : "internal error" }, 500);
	}
}

async function route(req: Request, url: URL, db: Database, parts: string[]): Promise<Response | null> {
	const m = req.method;
	const [a, b, c] = parts;
	const n = parts.length;
	// ?library=<id> (a local library id, see GET /api/libraries); absent = the collection's library, else My Library
	const libParam = (p: URLSearchParams): number | undefined => (p.has("library") ? resolveLibrary(db, p.get("library")) : undefined);

	if (a === "libraries" && n === 1) {
		if (m !== "GET") return methodNotAllowed();
		return json({ libraries: listLibraries(db).map((l) => ({ ...l, pending: pendingCount(db, l.id) })) });
	}

	if (a === "collections") {
		if (n === 1) {
			if (m === "GET") return json(repo.listCollections(db, libParam(url.searchParams) ?? USER_LIBRARY));
			if (m === "POST") {
				const body = await readBody(req);
				if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be an object");
				return json(
					repo.createCollection(
						db,
						body.name,
						body.parentKey,
						body.library !== undefined ? resolveLibrary(db, body.library) : undefined,
					),
					201,
				);
			}
			return methodNotAllowed();
		}
		if (n === 2) {
			if (m === "PATCH") {
				const body = await readBody(req);
				const patch: { name?: string; parentKey?: string | null } = {};
				if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be an object");
				if ("name" in body) patch.name = body.name;
				if ("parentKey" in body) patch.parentKey = body.parentKey;
				return json(repo.updateCollection(db, b, patch));
			}
			if (m === "DELETE") {
				repo.deleteCollection(db, b);
				return json({ ok: true });
			}
			return methodNotAllowed();
		}
		if (n === 3 && c === "items") {
			if (m !== "POST" && m !== "DELETE") return methodNotAllowed();
			const keys = stringArray((await readBody(req))?.keys, "keys");
			if (m === "POST") repo.addItemsToCollection(db, b, keys);
			else repo.removeItemsFromCollection(db, b, keys);
			return json({ ok: true });
		}
		return null;
	}

	if (a === "items") {
		if (n === 2 && b === "by-uri") {
			// cited URIs whose key is not in the library -> the item that replaced it (see items-by-uri.ts)
			if (m !== "POST") return methodNotAllowed();
			const body = await readBody<{ uris?: unknown; userId?: unknown }>(req);
			return json(itemsByUri(db, body?.uris, body?.userId));
		}
		if (n === 1) {
			if (m === "POST") {
				const body = await readBody<{ data?: Partial<ZoteroItemData>; library?: unknown }>(req);
				if (!body || typeof body.data !== "object" || body.data === null) throw new HttpError(400, "data is required");
				const detail = repo.createItem(db, body.data, body.library !== undefined ? resolveLibrary(db, body.library) : undefined);
				indexItem(db, detail.data.key);
				return json(detail, 201);
			}
			if (m !== "GET") return methodNotAllowed();
			const p = url.searchParams;
			return json(
				repo.listItems(db, {
					library: libParam(p),
					collection: p.get("collection") || undefined,
					tag: p.get("tag") || undefined,
					q: p.get("q") || undefined,
					sort: p.get("sort") || undefined,
					dir: p.get("dir") || undefined,
					then: p.get("then") || undefined,
					limit: intParam(p.get("limit")),
					offset: intParam(p.get("offset")),
					search: p.get("search") || undefined,
					qmode: p.get("qmode") || undefined,
					unfiled: p.get("unfiled") === "1",
					publications: p.get("publications") === "1",
					trash: p.get("trash") === "1",
					fields: p
						.get("fields")
						?.split(",")
						.map((f) => f.trim())
						.filter(Boolean),
					include: p
						.get("include")
						?.split(",")
						.map((f) => f.trim())
						.filter(Boolean),
				}),
			);
		}
		if (n === 2 && b === "groups") {
			if (m !== "GET") return methodNotAllowed();
			const p = url.searchParams;
			return json(
				repo.listItemGroups(db, p.get("by") ?? "", p.get("dir") || undefined, {
					library: libParam(p),
					collection: p.get("collection") || undefined,
					tag: p.get("tag") || undefined,
					q: p.get("q") || undefined,
					search: p.get("search") || undefined,
					qmode: p.get("qmode") || undefined,
					unfiled: p.get("unfiled") === "1",
					publications: p.get("publications") === "1",
					trash: p.get("trash") === "1",
				}),
			);
		}
		// GET /items/index?key=K&<the list's query>: K's position in that listing, -1 when it is not in it
		if (n === 2 && b === "index") {
			if (m !== "GET") return methodNotAllowed();
			const p = url.searchParams;
			const key = p.get("key");
			if (!key || !/^[A-Za-z0-9]{1,32}$/.test(key)) throw new HttpError(400, "key is required");
			return json({
				index: repo.itemIndex(db, key, {
					library: libParam(p),
					collection: p.get("collection") || undefined,
					tag: p.get("tag") || undefined,
					q: p.get("q") || undefined,
					sort: p.get("sort") || undefined,
					dir: p.get("dir") || undefined,
					then: p.get("then") || undefined,
					search: p.get("search") || undefined,
					qmode: p.get("qmode") || undefined,
					unfiled: p.get("unfiled") === "1",
					publications: p.get("publications") === "1",
					trash: p.get("trash") === "1",
				}),
			});
		}
		if (n === 2) {
			if (m === "GET") {
				const d = repo.getItemDetail(db, b);
				if (!d) throw new HttpError(404, "item not found");
				return json(d);
			}
			if (m === "PATCH") {
				const body = await readBody<{ data?: Partial<ZoteroItemData> }>(req);
				if (!body || typeof body.data !== "object" || body.data === null) throw new HttpError(400, "data is required");
				const detail = repo.patchItem(db, b, body.data);
				indexItem(db, b);
				return json(detail);
			}
			return methodNotAllowed();
		}
		if (n === 3 && c === "duplicate") {
			if (m !== "POST") return methodNotAllowed();
			return json(duplicateItem(db, b), 201);
		}
		if (n === 3 && c === "tags") {
			if (m !== "POST" && m !== "DELETE") return methodNotAllowed();
			const tags = stringArray((await readBody(req))?.tags, "tags");
			if (m === "POST") repo.addTags(db, b, tags);
			else repo.removeTags(db, b, tags);
			indexItem(db, b);
			return json({ ok: true });
		}
		if (n === 3 && c === "related") {
			if (m !== "POST" && m !== "DELETE") return methodNotAllowed();
			const keys = stringArray((await readBody(req))?.keys, "keys");
			return json(m === "POST" ? repo.addRelated(db, b, keys) : repo.removeRelated(db, b, keys));
		}
		return null;
	}

	if (a === "schema" && n === 1) {
		if (m !== "GET") return methodNotAllowed();
		return json(getSchema());
	}

	if (a === "open-url" && n === 1) {
		if (m !== "POST") return methodNotAllowed();
		opener.openUrl(safeUrl((await readBody(req))?.url));
		return json({ ok: true });
	}

	if (a === "tags" && n === 1) {
		if (m !== "GET") return methodNotAllowed();
		return json(repo.listTags(db, libParam(url.searchParams) ?? USER_LIBRARY));
	}

	if (a === "tag-colors" && n === 1) {
		if (m === "GET") return json(repo.getTagColors(db));
		if (m === "PUT") return json(repo.setTagColors(db, await readBody<unknown>(req)));
		return methodNotAllowed();
	}

	if (a === "attachments" && n === 3) {
		if (c === "file") {
			if (m === "PUT") return json(await replaceAttachmentFile(db, b, req)); // the reader's Rotate / Delete Pages (files/replace.ts)
			if (m !== "GET" && m !== "HEAD") return methodNotAllowed();
			return serveFile(req, db, b);
		}
		if (c === "reveal" || c === "open-external") {
			if (m !== "POST") return methodNotAllowed();
			const path = attachmentFilePath(db, b);
			if (c === "reveal") opener.reveal(path);
			else {
				// Explorer would run an executable / script. Only an explicit confirm (body {"confirm": true} or ?confirm=1) opens one.
				if (opensAsProgram(path) && !(await openConfirmed(req))) {
					throw new HttpError(
						409,
						"this file type can run code; it was not opened. Reveal it in the folder instead, or confirm to open it anyway",
					);
				}
				opener.openFile(path);
			}
			return json({ ok: true });
		}
		if (c === "annotations") {
			if (m === "GET") return json(repo.getAnnotations(db, b));
			if (m === "PUT") {
				repo.upsertAnnotations(db, b, await readBody<ReaderAnnotation[]>(req));
				return json({ ok: true });
			}
			if (m === "DELETE") {
				repo.deleteAnnotations(db, b, stringArray((await readBody(req))?.ids, "ids"));
				return json({ ok: true });
			}
			return methodNotAllowed();
		}
		if (c === "view-state") {
			if (m === "GET") return json(repo.getViewState(db, b));
			if (m === "PUT") {
				const body = await readBody(req);
				if (typeof body !== "object" || body === null) throw new HttpError(400, "body must be an object");
				repo.putViewState(db, b, body);
				return json({ ok: true });
			}
			return methodNotAllowed();
		}
		return null;
	}

	if (a === "search" && n === 1) {
		if (m !== "GET") return methodNotAllowed();
		const p = url.searchParams;
		return json(
			search(db, p.get("q") ?? "", { limit: intParam(p.get("limit")), offset: intParam(p.get("offset")), library: libParam(p) }),
		);
	}

	return null;
}

// ---------------------------------------------------------------- file streaming

/**
 * The bytes start..end (inclusive) of a file as a stream read on libuv's thread pool. Bun.file() responses read
 * on the main thread, and a OneDrive "online-only" file downloads during that read, which froze every other
 * request until it finished; with pooled reads only this response waits.
 */
export function fileStream(path: string, start: number, end: number, first?: Uint8Array): ReadableStream<Uint8Array> {
	let pos = start;
	return new ReadableStream<Uint8Array>({
		start(ctrl) {
			if (first?.length) {
				ctrl.enqueue(first);
				pos += first.length;
			}
		},
		async pull(ctrl) {
			try {
				const chunk = await readChunk(path, pos, Math.min(1024 * 1024, end + 1 - pos));
				if (!chunk.length) {
					ctrl.close();
					return;
				}
				pos += chunk.length;
				ctrl.enqueue(chunk);
			} catch (e) {
				ctrl.error(e);
			}
		},
	});
}

/** Up to `want` bytes at `pos`, read on the thread pool. Opened per chunk, so an abandoned response leaks nothing. */
async function readChunk(path: string, pos: number, want: number): Promise<Uint8Array> {
	if (want <= 0) return new Uint8Array(0);
	let fh: FileHandle | null = null;
	try {
		fh = await open(path, "r");
		const buf = new Uint8Array(want);
		const { bytesRead } = await fh.read(buf, 0, want, pos);
		return bytesRead === want ? buf : buf.subarray(0, bytesRead);
	} finally {
		await fh?.close().catch(() => {});
	}
}

/**
 * Read the first chunk before answering: for an online-only cloud file this is where the download happens, and
 * a failure (OneDrive offline or timing out) becomes a clear 503 instead of a response that breaks midway.
 */
async function firstChunk(path: string, start: number, end: number): Promise<Uint8Array> {
	try {
		return await readChunk(path, start, Math.min(1024 * 1024, end + 1 - start));
	} catch (e) {
		throw new HttpError(
			503,
			`The file could not be read${/onedrive/i.test(path) ? " (OneDrive could not download it; check OneDrive is signed in and online, or mark the folder 'Always keep on this device')" : ""}: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

async function serveFile(req: Request, db: Database, key: string): Promise<Response> {
	const att = repo.getAttachment(db, key);
	if (!att) throw new HttpError(404, "attachment not found");
	if (!att.path) throw new HttpError(404, "file not found on disk");
	const st = await stat(att.path).catch(() => null); // metadata only: does not download a cloud file
	if (!st?.isFile()) throw new HttpError(404, "file not found on disk");
	const size = st.size;
	const headers: Record<string, string> = {
		"Content-Type": att.content_type || Bun.file(att.path).type || "application/octet-stream",
		"Accept-Ranges": "bytes",
		"Cache-Control": "no-cache",
	};
	const range = req.headers.get("range");
	const rm = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
	if (rm && (rm[1] !== "" || rm[2] !== "")) {
		let start: number;
		let end: number;
		if (rm[1] === "") {
			const suffix = Number(rm[2]);
			start = Math.max(size - suffix, 0);
			end = size - 1;
		} else {
			start = Number(rm[1]);
			end = rm[2] === "" ? size - 1 : Math.min(Number(rm[2]), size - 1);
		}
		if (size === 0 || start >= size || start > end) {
			return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
		}
		return new Response(req.method === "HEAD" ? null : fileStream(att.path, start, end, await firstChunk(att.path, start, end)), {
			status: 206,
			headers: {
				...headers,
				"Content-Range": `bytes ${start}-${end}/${size}`,
				"Content-Length": String(end - start + 1),
			},
		});
	}
	return new Response(
		req.method === "HEAD" || size === 0 ? null : fileStream(att.path, 0, size - 1, await firstChunk(att.path, 0, size - 1)),
		{
			status: 200,
			headers: { ...headers, "Content-Length": String(size) },
		},
	);
}
