// HTTP API (see api-types.ts for the contract). handleApi returns null for non-/api paths.

import type { Database } from "bun:sqlite";
import type { ReaderAnnotation, ZoteroItemData } from "./api-types";
import * as repo from "./db";
import { HttpError } from "./db";
import { handleFulltextApi } from "./fulltext/api";
import { handleReferencesApi } from "./references/api";
import { handleCiteApi } from "./cite/api";
import { handleAddItemsApi } from "./additems/api";
import { handleDuplicatesApi } from "./duplicates/api";
import { handleIoApi } from "./io/api";
import { handleSearchesApi } from "./searches/api";
import { handleMaintenanceApi } from "./maintenance/api";

// Feature route modules; each returns null for paths outside its prefix.
const FEATURE_HANDLERS = [handleCiteApi, handleAddItemsApi, handleDuplicatesApi, handleIoApi, handleSearchesApi, handleMaintenanceApi];
import { getSchema } from "./schema-data";
import { handleSyncApi } from "./sync/api";
import { indexItem, search } from "./search";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
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

// Arguments go straight to CreateProcess as an argv array; no shell parses them.
function launch(cmd: string[]): void {
	const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	p.unref();
}

const systemOpener: Opener = {
	reveal: (path) => launch(["explorer.exe", "/select,", path]),
	openFile: (path) => launch(["explorer.exe", path]),
	openUrl: (url) => launch(["rundll32.exe", "url.dll,FileProtocolHandler", url]),
};

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
	if (/^doi:/i.test(s)) s = `https://doi.org/${encodeURI(s.replace(/^doi:\s*/i, ""))}`;
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
	if (url.pathname.startsWith("/api/fulltext/")) return handleFulltextApi(req, db);
	if (url.pathname.startsWith("/api/references/")) return handleReferencesApi(req, db);
	for (const handle of FEATURE_HANDLERS) {
		const res = await handle(req, db);
		if (res) return res;
	}
	if (url.pathname.startsWith("/api/sync/")) return handleSyncApi(req, db);
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
		console.error(e);
		return json({ error: e instanceof Error ? e.message : "internal error" }, 500);
	}
}

async function route(req: Request, url: URL, db: Database, parts: string[]): Promise<Response | null> {
	const m = req.method;
	const [a, b, c] = parts;
	const n = parts.length;

	if (a === "collections") {
		if (n === 1) {
			if (m === "GET") return json(repo.listCollections(db));
			if (m === "POST") {
				const body = await readBody(req);
				return json(repo.createCollection(db, body?.name, body?.parentKey), 201);
			}
			return methodNotAllowed();
		}
		if (n === 2) {
			if (m === "PATCH") {
				const body = await readBody(req);
				const patch: { name?: string; parentKey?: string | null } = {};
				if (body && "name" in body) patch.name = body.name;
				if (body && "parentKey" in body) patch.parentKey = body.parentKey;
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
		if (n === 1) {
			if (m === "POST") {
				const body = await readBody<{ data?: Partial<ZoteroItemData> }>(req);
				if (!body || typeof body.data !== "object" || body.data === null) throw new HttpError(400, "data is required");
				const detail = repo.createItem(db, body.data);
				indexItem(db, detail.data.key);
				return json(detail, 201);
			}
			if (m !== "GET") return methodNotAllowed();
			const p = url.searchParams;
			return json(
				repo.listItems(db, {
					collection: p.get("collection") || undefined,
					tag: p.get("tag") || undefined,
					q: p.get("q") || undefined,
					sort: p.get("sort") || undefined,
					dir: p.get("dir") || undefined,
					limit: intParam(p.get("limit")),
					offset: intParam(p.get("offset")),
					search: p.get("search") || undefined,
						qmode: p.get("qmode") || undefined,
						unfiled: p.get("unfiled") === "1",
					trash: p.get("trash") === "1",
					fields: p.get("fields")?.split(",").map((f) => f.trim()).filter(Boolean),
					include: p.get("include")?.split(",").map((f) => f.trim()).filter(Boolean),
				}),
			);
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
		return json(repo.listTags(db));
	}

	if (a === "tag-colors" && n === 1) {
		if (m === "GET") return json(repo.getTagColors(db));
		if (m === "PUT") return json(repo.setTagColors(db, await readBody<unknown>(req)));
		return methodNotAllowed();
	}

	if (a === "attachments" && n === 3) {
		if (c === "file") {
			if (m !== "GET" && m !== "HEAD") return methodNotAllowed();
			return serveFile(req, db, b);
		}
		if (c === "reveal" || c === "open-external") {
			if (m !== "POST") return methodNotAllowed();
			const path = attachmentFilePath(db, b);
			if (c === "reveal") opener.reveal(path);
			else opener.openFile(path);
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
		return json(search(db, p.get("q") ?? "", { limit: intParam(p.get("limit")), offset: intParam(p.get("offset")) }));
	}

	return null;
}

// ---------------------------------------------------------------- file streaming

function serveFile(req: Request, db: Database, key: string): Response {
	const att = repo.getAttachment(db, key);
	if (!att) throw new HttpError(404, "attachment not found");
	if (!att.path || !repo.fileExists(att.path)) throw new HttpError(404, "file not found on disk");
	const file = Bun.file(att.path);
	const size = file.size;
	const headers: Record<string, string> = {
		"Content-Type": att.content_type || file.type || "application/octet-stream",
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
		return new Response(req.method === "HEAD" ? null : file.slice(start, end + 1), {
			status: 206,
			headers: {
				...headers,
				"Content-Range": `bytes ${start}-${end}/${size}`,
				"Content-Length": String(end - start + 1),
			},
		});
	}
	return new Response(req.method === "HEAD" ? null : file, {
		status: 200,
		headers: { ...headers, "Content-Length": String(size) },
	});
}
