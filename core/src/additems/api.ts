// Routes under /api/add/. Returns null for other paths.
//   POST /api/add/identifier         {text, collectionKey?}  -> {added: ItemDetail[], failed: {id, error}[], existing: {id, key}[]}
//   POST /api/add/file               JSON {name, contentType?, dataBase64 | path, mode?, parentKey?, collectionKey?} (201: ItemDetail)
//                                    or multipart (file, mode, parentKey, collectionKey, path) -> ItemDetail
//   POST /api/add/link               {url, title?, parentKey?, collectionKey?} -> ItemDetail (201)
//   POST /api/add/retrieve-metadata  {attachmentKeys[]} -> {results: RetrieveResult[], items: ItemDetail[]}
//   POST /api/add/create-parent      {itemKey, text? | itemType?} -> {parent: ItemDetail, item: ItemDetail}
//                                    (an identifier makes the parent from the add-by-identifier data, itemType an empty one) ->
//                                    the attachment or note becomes its child.
// Notes are plain POST /api/items with itemType "note" (+ parentItem for a child note).
import type { Database } from "bun:sqlite";
import { resolveLibrary } from "../libraries";
import { HttpError } from "../db";
import { addByIdentifier } from "./add";
import { addFile, addLink } from "./files";
import { retrieveMetadata } from "./retrieve";
import { createParent } from "./parent";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

async function readJson(req: Request): Promise<Record<string, any>> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		throw new HttpError(400, "invalid JSON body");
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be an object");
	return body as Record<string, any>;
}

export async function handleAddItemsApi(req: Request, db: Database): Promise<Response | null> {
	const { pathname } = new URL(req.url);
	if (!pathname.startsWith("/api/add/")) return null;
	try {
		const route = pathname.slice("/api/add/".length).replace(/\/+$/, "");
		if (!["identifier", "file", "link", "retrieve-metadata", "create-parent"].includes(route)) return json({ error: "not found" }, 404);
		if (req.method !== "POST") throw new HttpError(405, "method not allowed");

		if (route === "identifier") {
			const b = await readJson(req);
			return json(await addByIdentifier(db, b.text, b.collectionKey, b.autoTag !== false, b.library !== undefined ? resolveLibrary(db, b.library) : undefined));
		}
		if (route === "create-parent") return json(await createParent(db, await readJson(req)), 201);
		if (route === "link") {
			const b = await readJson(req);
			return json(addLink(db, { ...b, libraryId: b.library !== undefined ? resolveLibrary(db, b.library) : undefined }), 201);
		}
		if (route === "retrieve-metadata") {
			const b = await readJson(req);
			return json(await retrieveMetadata(db, b.attachmentKeys, { rename: b.rename !== false, autoTag: b.autoTag !== false }));
		}

		// route === "file"
		const type = (req.headers.get("content-type") ?? "").toLowerCase();
		if (type.startsWith("multipart/form-data")) {
			const form = await req.formData();
			const f = form.get("file");
			const str = (k: string) => (typeof form.get(k) === "string" && form.get(k) ? (form.get(k) as string) : undefined);
			const opts = { mode: str("mode") as any, parentKey: str("parentKey"), collectionKey: str("collectionKey"), path: str("path"), libraryId: str("library") ? resolveLibrary(db, str("library")) : undefined };
			if (f && typeof f !== "string") {
				return json(addFile(db, { ...opts, name: (f as File).name, contentType: (f as File).type }, new Uint8Array(await (f as File).arrayBuffer())), 201);
			}
			return json(addFile(db, opts), 201);
		}
		const fb = await readJson(req);
		return json(addFile(db, { ...fb, libraryId: fb.library !== undefined ? resolveLibrary(db, fb.library) : undefined }), 201);
	} catch (e) {
		if (e instanceof HttpError) return json({ error: e.message }, e.status);
		console.error(e);
		return json({ error: e instanceof Error ? e.message : "internal error" }, 500);
	}
}
