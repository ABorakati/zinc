// References routes (/api/references/*). Contract: core/src/api-types.ts.
//   GET  /api/references/:itemKey            -> ReferenceList (?refresh=1 bypasses the cache)
//   GET  /api/references/lookup?doi=|title=  -> ReferenceDetail
//   POST /api/references/add                 -> ItemDetail (201), 409 {error, key} when already in the library
import type { Database } from "bun:sqlite";
import { HttpError } from "../db";
import { AlreadyInLibrary, addReference, lookupReference } from "./add";
import { NetError } from "./net";
import { getReferences } from "./resolve";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

export async function handleReferencesApi(req: Request, db: Database): Promise<Response | null> {
	const url = new URL(req.url);
	if (!url.pathname.startsWith("/api/references/")) return null;
	try {
		let parts: string[];
		try {
			parts = url.pathname.split("/").filter(Boolean).slice(2).map(decodeURIComponent);
		} catch {
			throw new HttpError(400, "malformed URL");
		}
		if (parts.length === 1 && parts[0] === "lookup") {
			if (req.method !== "GET") throw new HttpError(405, "method not allowed");
			return json(await lookupReference(db, { doi: url.searchParams.get("doi"), title: url.searchParams.get("title") }));
		}
		if (parts.length === 1 && parts[0] === "add") {
			if (req.method !== "POST") throw new HttpError(405, "method not allowed");
			let body: any;
			try {
				body = await req.json();
			} catch {
				throw new HttpError(400, "invalid JSON body");
			}
			if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be an object");
			return json(await addReference(db, body), 201);
		}
		if (parts.length === 1 && parts[0]) {
			if (req.method !== "GET") throw new HttpError(405, "method not allowed");
			const refresh = ["1", "true"].includes(url.searchParams.get("refresh") ?? "");
			return json(await getReferences(db, parts[0], { refresh }));
		}
		return json({ error: "not found" }, 404);
	} catch (e) {
		if (e instanceof AlreadyInLibrary) return json({ error: e.message, key: e.key }, 409);
		if (e instanceof HttpError) return json({ error: e.message }, e.status);
		console.error(e);
		// a failed request to a reference service (NetError) says which; anything else is opaque, with the details in the log
		return json({ error: e instanceof NetError ? e.message : "internal error" }, 500);
	}
}
