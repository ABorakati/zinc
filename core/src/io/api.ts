// Routes under /api/io/. Returns null for other paths.
//   GET  /api/io/mendeley    -> { databases: MendeleyDatabase[], available: boolean }
//        Mendeley Desktop libraries found under %LOCALAPPDATA%\Mendeley Ltd\Mendeley Desktop.
//   POST /api/io/mendeley    {path?, collectionName?, collectionKey?, linkFiles?}
//        -> MendeleyImportResult. Without `path` the newest discovered database is used.
//        The file is copied before reading and never modified; the online Mendeley (OAuth) is not supported.
//   POST /api/io/export  {keys?, collectionKey?, format: "bibtex"|"biblatex"|"ris"|"csljson"|"csv"|"rdf"|"mods",
//                        includeNotes?, dir?}
//                        -> {filename, contentType, text, count, path?, files}
//                        (no keys and no collectionKey = whole library; `dir` writes the file, and for RDF the
//                        attachment files in files/<n>/, and returns `path`)
//   POST /api/io/import  {text, format?: "auto"|"bibtex"|"ris"|"csljson"|"pubmed-nbib"|"endnote-xml"|"rdf"|"mods",
//                         collectionName?: string|null, collectionKey?: string, basePath?: string}
//                        -> {created, skipped, errors: string[], collectionKey, format, collections, attachments}
//        Items go into collectionKey, else a new collection named collectionName ("Imported <date>" if omitted;
//        null = no collection). Items whose DOI is already in the library are skipped.
//        Formats that carry a collection tree (Zotero RDF) create their own collections instead of one collection.
//        basePath is the folder the file came from: relative attachment paths (RDF) resolve against it.
import type { Database } from "bun:sqlite";
import { HttpError } from "../db";
import { discoverMendeleyDatabases, importMendeley } from "../import/mendeley";
import { exportItems, type ExportFormat } from "./export";
import { importText, type ImportFormat } from "./import";

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

const optString = (v: unknown, name: string): string | undefined => {
	if (v === undefined || v === null || v === "") return undefined;
	if (typeof v !== "string") throw new HttpError(400, `${name} must be a string`);
	return v;
};

export async function handleIoApi(req: Request, db: Database): Promise<Response | null> {
	const { pathname } = new URL(req.url);
	if (!pathname.startsWith("/api/io/")) return null;
	try {
		const route = pathname.slice("/api/io/".length).replace(/\/+$/, "");
		if (route !== "export" && route !== "import" && route !== "mendeley") return json({ error: "not found" }, 404);
		if (route === "mendeley" && req.method === "GET") {
			const databases = discoverMendeleyDatabases();
			return json({ databases, available: databases.length > 0 });
		}
		if (req.method !== "POST") throw new HttpError(405, "method not allowed");
		const b = await readJson(req);
		if (route === "export") {
			let keys: string[] | undefined;
			if (b.keys !== undefined) {
				if (!Array.isArray(b.keys) || b.keys.some((k: unknown) => typeof k !== "string")) throw new HttpError(400, "keys must be an array of strings");
				keys = b.keys;
			}
			return json(
				exportItems(db, {
					keys,
					collectionKey: optString(b.collectionKey, "collectionKey"),
					format: b.format as ExportFormat,
					includeNotes: !!b.includeNotes,
					dir: optString(b.dir, "dir"),
				}),
			);
		}
		if (route === "mendeley") {
			const supplied = optString(b.path, "path");
			const path = supplied ?? discoverMendeleyDatabases()[0]?.path;
			if (!path) throw new HttpError(404, "no Mendeley Desktop library found on this computer");
			const name = b.collectionName === null ? null : optString(b.collectionName, "collectionName");
			return json(
				importMendeley(db, {
					path,
					collectionName: name,
					collectionKey: optString(b.collectionKey, "collectionKey"),
					linkFiles: !!b.linkFiles,
				}),
			);
		}
		if (typeof b.text !== "string") throw new HttpError(400, "text must be a string");
		const name = b.collectionName === null ? null : optString(b.collectionName, "collectionName");
		return json(
			importText(db, {
				text: b.text,
				format: optString(b.format, "format") as ImportFormat | "auto" | undefined,
				collectionName: name,
				collectionKey: optString(b.collectionKey, "collectionKey"),
				autoTag: b.autoTag !== false,
				basePath: optString(b.basePath, "basePath"),
			}),
		);
	} catch (e) {
		if (e instanceof HttpError) return json({ error: e.message }, e.status);
		console.error(e);
		return json({ error: e instanceof Error ? e.message : "internal error" }, 500);
	}
}
