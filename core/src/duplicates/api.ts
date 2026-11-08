// Routes under /api/duplicates:
//   GET  /api/duplicates                  -> {sets: {keys: string[], reason: "doi"|"isbn"|"title"}[], total}
//   GET  /api/duplicates/set?keys=a,b     -> {items: ItemDetail[], defaultMasterKey: string, differingFields: string[]}
//   POST /api/duplicates/merge            {masterKey?, otherKeys[], fieldChoices?: {field: sourceKey}} -> ItemDetail
//   POST /api/duplicates/not-duplicates   {keys: string[]} -> {ok: true}

import type { Database } from "bun:sqlite";
import { HttpError } from "../db";
import { detectDuplicates, ensureDuplicatesSchema } from "./detect";
import { resolveLibrary } from "../libraries";
import { getDuplicateSetDetails, markNotDuplicates, mergeDuplicateItems } from "./merge";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

async function readBody(req: Request): Promise<Record<string, any>> {
	let b: unknown;
	try {
		b = await req.json();
	} catch {
		throw new HttpError(400, "invalid JSON body");
	}
	if (!b || typeof b !== "object" || Array.isArray(b)) {
		throw new HttpError(400, "body must be an object");
	}
	return b as Record<string, any>;
}

export async function handleDuplicatesApi(req: Request, db: Database): Promise<Response | null> {
	const url = new URL(req.url);
	const { pathname } = url;
	if (pathname !== "/api/duplicates" && !pathname.startsWith("/api/duplicates/")) return null;

	try {
		let parts: string[];
		try {
			parts = pathname.split("/").filter(Boolean).slice(2).map(decodeURIComponent);
		} catch {
			throw new HttpError(400, "malformed URL");
		}

		ensureDuplicatesSchema(db);
		const m = req.method;

		if (parts.length === 0) {
			if (m === "GET") {
				const includeSummary = url.searchParams.get("summary") === "1";
				return json(detectDuplicates(db, { includeSummary, library: url.searchParams.has("library") ? resolveLibrary(db, url.searchParams.get("library")) : undefined }));
			}
			throw new HttpError(405, "method not allowed");
		}

		if (parts.length === 1) {
			const [sub] = parts;
			if (sub === "set") {
				if (m !== "GET") throw new HttpError(405, "method not allowed");
				const rawKeys = (url.searchParams.get("keys") ?? "")
					.split(",")
					.map((k) => k.trim())
					.filter(Boolean);
				return json(getDuplicateSetDetails(db, rawKeys));
			}
			if (sub === "merge") {
				if (m !== "POST") throw new HttpError(405, "method not allowed");
				const b = await readBody(req);
				return json(
					mergeDuplicateItems(db, {
						masterKey: b.masterKey,
						otherKeys: b.otherKeys,
						fieldChoices: b.fieldChoices,
					}),
				);
			}
			if (sub === "not-duplicates") {
				if (m !== "POST") throw new HttpError(405, "method not allowed");
				const b = await readBody(req);
				return json(markNotDuplicates(db, b.keys));
			}
		}

		return json({ error: "not found" }, 404);
	} catch (e) {
		if (e instanceof HttpError) return json({ error: e.message }, e.status);
		console.error(e);
		return json({ error: e instanceof Error ? e.message : "internal error" }, 500);
	}
}
