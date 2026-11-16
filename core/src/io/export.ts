// Export: gather items (selection / collection / library) and serialise to a format.
import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ZoteroItemData } from "../api-types";
import { HttpError } from "../db";
import { resolveStoredPath } from "../files/paths";
import { BBT_FORMATS, exportBetterFormat, type BbtExportFormat } from "../bbt/export";
import { exportBibtex, type ExportItem } from "./bibtex";
import { htmlToText } from "./common";
import { exportCsv } from "./csv";
import { exportCslJson } from "./csljson";
import { exportMods } from "./mods";
import { exportZoteroRdf, type RdfAttachment, type RdfCollection } from "./rdf";
import { exportRis } from "./ris";

export type ExportFormat = "bibtex" | "biblatex" | "ris" | "csljson" | "csv" | "rdf" | "mods" | BbtExportFormat;

export const EXPORT_FORMATS: Record<ExportFormat, { label: string; ext: string; contentType: string }> = {
	bibtex: { label: "BibTeX", ext: "bib", contentType: "application/x-bibtex; charset=utf-8" },
	biblatex: { label: "BibLaTeX", ext: "bib", contentType: "application/x-bibtex; charset=utf-8" },
	ris: { label: "RIS", ext: "ris", contentType: "application/x-research-info-systems; charset=utf-8" },
	csljson: { label: "CSL JSON", ext: "json", contentType: "application/json; charset=utf-8" },
	csv: { label: "CSV", ext: "csv", contentType: "text/csv; charset=utf-8" },
	rdf: { label: "Zotero RDF", ext: "rdf", contentType: "application/rdf+xml; charset=utf-8" },
	mods: { label: "MODS", ext: "xml", contentType: "application/mods+xml; charset=utf-8" },
	...BBT_FORMATS, // Better BibTeX / BibLaTeX / CSL JSON / CSL YAML (core/src/bbt)
};

export interface ExportRequest {
	keys?: string[];
	collectionKey?: string;
	format: ExportFormat;
	includeNotes?: boolean;
	/** For "the whole library" (no keys, no collection): which library, by local id. Default: My Library. */
	library?: number;
	/** Folder to write the file (and, for RDF, the attachment files) into. Without it only the text is returned. */
	dir?: string;
}
export interface ExportResult {
	filename: string;
	contentType: string;
	text: string;
	count: number;
	/** Set when `dir` was given: the written file. */
	path?: string;
	/** Attachment files copied next to the export (Zotero RDF). */
	files?: number;
}

const REGULAR = "i.item_type NOT IN ('note', 'attachment', 'annotation')";

function collectionKeys(db: Database, root: string): string[] {
	return (
		db
			.query(
				`WITH RECURSIVE c(key) AS (SELECT key FROM collections WHERE key = ?1
				   UNION SELECT k.key FROM collections k JOIN c ON k.parent_key = c.key)
				 SELECT key FROM c`,
			)
			.all(root) as { key: string }[]
	).map((r) => r.key);
}

function selectKeys(db: Database, req: ExportRequest): string[] {
	if (req.keys && req.keys.length) {
		const out: string[] = [];
		const q = db.query(`SELECT key, parent_key, item_type FROM items i WHERE key = ? AND ${REGULAR}`);
		for (const k of new Set(req.keys)) {
			const r = q.get(k) as { key: string; parent_key: string | null } | null;
			if (r && !r.parent_key) out.push(r.key);
		}
		return out;
	}
	if (req.collectionKey) {
		const keys = collectionKeys(db, req.collectionKey);
		if (!keys.length) throw new HttpError(404, "collection not found");
		return (
			db
				.query(
					`SELECT DISTINCT i.key, i.date_added FROM collection_items ci JOIN items i ON i.key = ci.item_key
					 WHERE ci.collection_key IN (SELECT value FROM json_each(?)) AND i.deleted = 0 AND i.parent_key IS NULL AND ${REGULAR}
					 ORDER BY i.date_added, i.key`,
				)
				.all(JSON.stringify(keys)) as { key: string }[]
		).map((r) => r.key);
	}
	return (
		db
			.query(
				`SELECT i.key FROM items i WHERE i.deleted = 0 AND i.parent_key IS NULL AND i.library_id = ? AND ${REGULAR} ORDER BY i.date_added, i.key`,
			)
			.all(req.library ?? 1) as {
			key: string;
		}[]
	).map((r) => r.key);
}

export interface GatheredItem extends ExportItem {
	files: string[];
	links: string[];
	autoTags: string[];
	noteHtml: string[];
}

export function gatherItems(db: Database, req: ExportRequest): GatheredItem[] {
	const keys = selectKeys(db, req);
	const dataQ = db.query("SELECT data FROM items WHERE key = ?");
	const tagQ = db.query("SELECT tag, type FROM item_tags WHERE item_key = ? ORDER BY tag COLLATE NOCASE");
	const noteQ = db.query("SELECT data FROM items WHERE parent_key = ? AND item_type = 'note' AND deleted = 0 ORDER BY date_added, key");
	const attQ = db.query(
		`SELECT a.link_mode, a.path, a.url, i.title AS title, a.content_type FROM attachments a JOIN items i ON i.key = a.item_key
		 WHERE i.parent_key = ? AND i.deleted = 0 ORDER BY i.date_added, i.key`,
	);
	return keys.map((key) => {
		const data = JSON.parse((dataQ.get(key) as { data: string }).data) as ZoteroItemData;
		const tags = tagQ.all(key) as { tag: string; type: number }[];
		const noteRows = req.includeNotes ? (noteQ.all(key) as { data: string }[]) : [];
		const noteHtml = noteRows.map((r) => String((JSON.parse(r.data) as ZoteroItemData).note ?? "")).filter(Boolean);
		const atts = attQ.all(key) as {
			link_mode: string;
			path: string | null;
			url: string | null;
			title: string | null;
			content_type: string | null;
		}[];
		return {
			data,
			tags: tags.map((t) => t.tag),
			autoTags: tags.filter((t) => t.type === 1).map((t) => t.tag),
			notes: noteHtml.map(htmlToText).filter(Boolean),
			noteHtml,
			files: atts.filter((a) => a.path && a.link_mode !== "linked_url").map((a) => resolveStoredPath(db, a.path) ?? a.path!),
			links: atts.filter((a) => a.link_mode === "linked_url" && a.url).map((a) => a.url!),
		};
	});
}

const safeName = (s: string) =>
	s
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80) || "Exported Items";

export function exportItems(db: Database, req: ExportRequest): ExportResult {
	const fmt = EXPORT_FORMATS[req.format];
	if (!fmt) throw new HttpError(400, `unknown format: ${String(req.format)} (use bibtex, biblatex, ris, csljson, csv, rdf or mods)`);
	const items = gatherItems(db, req);
	let text: string;
	let files = 0;
	const dir = req.dir ? resolve(req.dir) : undefined;
	if (dir) mkdirSync(dir, { recursive: true });
	switch (req.format) {
		case "betterbibtex":
		case "betterbiblatex":
		case "bettercsljson":
		case "bettercslyaml":
			text = exportBetterFormat(db, req.format, items, { includeNotes: req.includeNotes });
			break;
		case "bibtex":
			text = exportBibtex(items, "bibtex");
			break;
		case "biblatex":
			text = exportBibtex(items, "biblatex");
			break;
		case "ris":
			text = exportRis(items);
			break;
		case "csljson":
			text = exportCslJson(items);
			break;
		case "csv":
			text = exportCsv(items);
			break;
		case "mods":
			text = exportMods(items);
			break;
		case "rdf": {
			// files/1/<name>, files/2/<name>… next to the .rdf, as Zotero's RDF export writes them
			const withAttachments = items.map((item, index) => {
				const attachments: RdfAttachment[] = item.links.map((url) => ({ url }));
				if (dir) {
					for (const file of item.files) {
						if (!existsSync(file) || !statSync(file).isFile()) continue;
						const folder = join(dir, "files", String(index + 1));
						mkdirSync(folder, { recursive: true });
						const name = basename(file);
						copyFileSync(file, join(folder, name));
						attachments.push({ title: name, path: `files/${index + 1}/${name}`, contentType: contentTypeFor(name) });
						files++;
					}
				}
				return { ...item, attachments };
			});
			// collections travel with a collection or whole-library export, not with a hand-picked selection
			const collections =
				req.keys && req.keys.length
					? []
					: exportCollections(
							db,
							req,
							items.map((i) => i.data.key),
						);
			text = exportZoteroRdf(withAttachments, collections);
			break;
		}
	}
	let base = "Exported Items";
	if (req.collectionKey && !(req.keys && req.keys.length)) {
		const c = db.query("SELECT name FROM collections WHERE key = ?").get(req.collectionKey) as { name: string } | null;
		if (c) base = safeName(c.name);
	} else if (!(req.keys && req.keys.length)) base = "My Library";
	const filename = `${base}.${fmt.ext}`;
	let path: string | undefined;
	if (dir) {
		path = join(dir, filename);
		writeFileSync(path, text);
	}
	return { filename, contentType: fmt.contentType, text, count: items.length, path, files };
}

const MIME: Record<string, string> = {
	".pdf": "application/pdf",
	".epub": "application/epub+zip",
	".html": "text/html",
	".htm": "text/html",
	".txt": "text/plain",
	".md": "text/markdown",
	".csv": "text/csv",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function contentTypeFor(name: string): string | undefined {
	const dot = name.lastIndexOf(".");
	return dot < 0 ? undefined : MIME[name.slice(dot).toLowerCase()];
}

/** The collection tree of the exported scope (RDF carries collections). */
function exportCollections(db: Database, req: ExportRequest, itemKeys: string[]): RdfCollection[] {
	const rows = db.query("SELECT key, name, parent_key FROM collections").all() as {
		key: string;
		name: string;
		parent_key: string | null;
	}[];
	const inScope =
		req.collectionKey && !(req.keys && req.keys.length)
			? new Set(collectionKeys(db, req.collectionKey))
			: new Set(rows.map((r) => r.key));
	const keys = new Set(itemKeys);
	const members = new Map<string, string[]>();
	for (const r of db.query("SELECT collection_key, item_key FROM collection_items").all() as {
		collection_key: string;
		item_key: string;
	}[]) {
		if (!keys.has(r.item_key)) continue;
		const list = members.get(r.collection_key) ?? [];
		list.push(r.item_key);
		members.set(r.collection_key, list);
	}
	const out: RdfCollection[] = [];
	for (const r of rows) {
		if (!inScope.has(r.key)) continue;
		out.push({
			key: r.key,
			name: r.name,
			parentKey: r.parent_key && inScope.has(r.parent_key) ? r.parent_key : null,
			itemKeys: members.get(r.key) ?? [],
		});
	}
	return out;
}
