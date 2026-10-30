// Routes under /api/searches: saved search CRUD and ad-hoc runs. Returns null for other paths.
//   GET  /api/searches                list saved searches
//   POST /api/searches                {name, conditions, options} -> create
//   GET|PATCH|DELETE /api/searches/:key
//   POST /api/searches/run            {conditions, options, sort?, dir?, limit?, offset?, fields?, include?} -> ItemList
import type { Database } from "bun:sqlite";
import { HttpError, listItems } from "../db";
import { normalizeSearch } from "./compile";
import { createSavedSearch, deleteSavedSearch, ensureSearchSchema, getSavedSearch, listSavedSearches, updateSavedSearch } from "./store";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

async function readBody(req: Request): Promise<Record<string, any>> {
	let b: unknown;
	try {
		b = await req.json();
	} catch {
		throw new HttpError(400, "invalid JSON body");
	}
	if (!b || typeof b !== "object" || Array.isArray(b)) throw new HttpError(400, "body must be an object");
	return b as Record<string, any>;
}

const strList = (v: unknown): string[] | undefined =>
	Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;

export async function handleSearchesApi(req: Request, db: Database): Promise<Response | null> {
	const { pathname } = new URL(req.url);
	if (pathname !== "/api/searches" && !pathname.startsWith("/api/searches/")) return null;
	try {
		let parts: string[];
		try {
			parts = pathname.split("/").filter(Boolean).slice(2).map(decodeURIComponent);
		} catch {
			throw new HttpError(400, "malformed URL");
		}
		ensureSearchSchema(db);
		const m = req.method;
		if (parts.length === 0) {
			if (m === "GET") return json(listSavedSearches(db));
			if (m === "POST") return json(createSavedSearch(db, await readBody(req)), 201);
			throw new HttpError(405, "method not allowed");
		}
		if (parts.length !== 1) return json({ error: "not found" }, 404);
		const [key] = parts;
		if (key === "run") {
			if (m !== "POST") throw new HttpError(405, "method not allowed");
			const b = await readBody(req);
			const def = normalizeSearch(b);
			return json(
				listItems(db, {
					searchDef: def,
					sort: typeof b.sort === "string" ? b.sort : undefined,
					dir: typeof b.dir === "string" ? b.dir : undefined,
					limit: typeof b.limit === "number" ? b.limit : undefined,
					offset: typeof b.offset === "number" ? b.offset : undefined,
					fields: strList(b.fields),
					include: strList(b.include),
				}),
			);
		}
		if (m === "GET") {
			const s = getSavedSearch(db, key);
			if (!s) throw new HttpError(404, "saved search not found");
			return json(s);
		}
		if (m === "PATCH") return json(updateSavedSearch(db, key, await readBody(req)));
		if (m === "DELETE") {
			deleteSavedSearch(db, key);
			return json({ ok: true });
		}
		throw new HttpError(405, "method not allowed");
	} catch (e) {
		if (e instanceof HttpError) return json({ error: e.message }, e.status);
		console.error(e);
		return json({ error: e instanceof Error ? e.message : "internal error" }, 500);
	}
}
