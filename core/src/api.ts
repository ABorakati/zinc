// HTTP API (see api-types.ts for the contract). handleApi returns null for non-/api paths.

import type { Database } from "bun:sqlite";
import type { ReaderAnnotation, ZoteroItemData } from "./api-types";
import * as repo from "./db";
import { HttpError } from "./db";
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

function methodNotAllowed(): never {
	throw new HttpError(405, "method not allowed");
}

export async function handleApi(req: Request, db: Database): Promise<Response | null> {
	const url = new URL(req.url);
	if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return null;
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
					unfiled: p.get("unfiled") === "1",
					trash: p.get("trash") === "1",
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
		return null;
	}

	if (a === "tags" && n === 1) {
		if (m !== "GET") return methodNotAllowed();
		return json(repo.listTags(db));
	}

	if (a === "attachments" && n === 3) {
		if (c === "file") {
			if (m !== "GET" && m !== "HEAD") return methodNotAllowed();
			return serveFile(req, db, b);
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
