// Routes under /api/translate/. Returns null for other paths.
//   GET  /api/translate/status           -> {dir, source: "env"|"data"|"vendored", counts: {web, import, export, search, total}}
//   GET  /api/translate/import-formats   -> [{id, label, extension}]   (?all=1 also lists the formats zotero-next reads itself)
//   GET  /api/translate/export-formats   -> [{id, label, extension}]   (?all=1 also lists the natively exported formats)
//   POST /api/translate/web     {url, collectionKey?, attachments?, translatorID?, publicOnly?}
//        publicOnly (set by plugins): the whole job, redirects, translator requests and downloads included, refuses private and local addresses
//        -> {items: [{key, title, itemType}], translator, fallback?}   the page was translated and saved, or
//           {choices: {session, url, items: [{key, title, checked?}]}}  a multi-item page: pick, then /web/select
//   POST /api/translate/web/select {session, keys, collectionKey?, publicOnly?}  -> {items, translator}   (a public-only session stays public-only)
//   POST /api/translate/import  {text | path, translatorID?, collectionKey?, collectionName?, basePath?}
//        -> {created, skipped, errors, collectionKey, format, translator, itemKeys, collections, attachments}
//        Formats zotero-next reads itself (RIS, BibTeX, ...) go through the native importer; the rest through
//        Zotero's import translators (detectImport), or the one named by translatorID.
//   POST /api/translate/export  {translatorID, keys?, collectionKey?, includeNotes?, dir?, displayOptions?}
//        -> {filename, contentType, text, count, path?}
import type { Database } from "bun:sqlite";
import { HttpError } from "../db";
import { selectWeb, translateExport, translateImport, translateWeb } from "./service";
import { countTranslators, exportFormats, importFormats, listTranslators, translatorsDirFor } from "./translators";

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

function optString(v: unknown, name: string): string | undefined {
	if (v === undefined || v === null || v === "") return undefined;
	if (typeof v !== "string") throw new HttpError(400, `${name} must be a string`);
	return v;
}

export async function handleTranslateApi(req: Request, db: Database): Promise<Response | null> {
	const url = new URL(req.url);
	if (!url.pathname.startsWith("/api/translate/")) return null;
	try {
		const route = url.pathname.slice("/api/translate/".length).replace(/\/+$/, "");
		const get = req.method === "GET";
		if (get && route === "status") {
			const { dir, source } = translatorsDirFor(db);
			return json({ dir, source, counts: countTranslators(listTranslators(dir)) });
		}
		if (get && (route === "import-formats" || route === "export-formats")) {
			const list = listTranslators(translatorsDirFor(db).dir);
			const all = url.searchParams.get("all") === "1";
			return json((route === "import-formats" ? importFormats : exportFormats)(list, all));
		}
		if (!["web", "web/select", "import", "export"].includes(route)) return json({ error: "not found" }, 404);
		if (req.method !== "POST") throw new HttpError(405, "method not allowed");
		const b = await readJson(req);
		const collectionKey = b.collectionKey === null ? null : optString(b.collectionKey, "collectionKey");
		if (route === "web") {
			return json(
				await translateWeb(db, {
					url: b.url,
					collectionKey,
					attachments: b.attachments !== false,
					translatorID: optString(b.translatorID, "translatorID"),
					publicOnly: b.publicOnly === true,
				}),
			);
		}
		if (route === "web/select") {
			if (typeof b.session !== "string") throw new HttpError(400, "session must be a string");
			return json(await selectWeb(db, { session: b.session, keys: b.keys, collectionKey, attachments: b.attachments, publicOnly: b.publicOnly === true }));
		}
		if (route === "import") {
			const name = b.collectionName === null ? null : optString(b.collectionName, "collectionName");
			return json(
				await translateImport(db, {
					text: optString(b.text, "text"),
					path: optString(b.path, "path"),
					translatorID: optString(b.translatorID, "translatorID"),
					collectionKey,
					collectionName: name,
					basePath: optString(b.basePath, "basePath"),
				}),
			);
		}
		let keys: string[] | undefined;
		if (b.keys !== undefined) {
			if (!Array.isArray(b.keys) || b.keys.some((k: unknown) => typeof k !== "string"))
				throw new HttpError(400, "keys must be an array of strings");
			keys = b.keys;
		}
		return json(
			await translateExport(db, {
				translatorID: b.translatorID,
				keys,
				collectionKey: collectionKey ?? undefined,
				includeNotes: !!b.includeNotes,
				dir: optString(b.dir, "dir"),
				displayOptions: b.displayOptions && typeof b.displayOptions === "object" ? b.displayOptions : undefined,
			}),
		);
	} catch (e) {
		if (e instanceof HttpError) return json({ error: e.message }, e.status);
		console.error(e);
		return json({ error: e instanceof Error ? e.message : "internal error" }, 500);
	}
}
