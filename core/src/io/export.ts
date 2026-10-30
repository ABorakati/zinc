// Export: gather items (selection / collection / library) and serialise to a format.
import type { Database } from "bun:sqlite";
import type { ZoteroItemData } from "../api-types";
import { HttpError } from "../db";
import { exportBibtex, type ExportItem } from "./bibtex";
import { htmlToText } from "./common";
import { exportCsv } from "./csv";
import { exportCslJson } from "./csljson";
import { exportRis } from "./ris";

export type ExportFormat = "bibtex" | "biblatex" | "ris" | "csljson" | "csv";

export const EXPORT_FORMATS: Record<ExportFormat, { label: string; ext: string; contentType: string }> = {
	bibtex: { label: "BibTeX", ext: "bib", contentType: "application/x-bibtex; charset=utf-8" },
	biblatex: { label: "BibLaTeX", ext: "bib", contentType: "application/x-bibtex; charset=utf-8" },
	ris: { label: "RIS", ext: "ris", contentType: "application/x-research-info-systems; charset=utf-8" },
	csljson: { label: "CSL JSON", ext: "json", contentType: "application/json; charset=utf-8" },
	csv: { label: "CSV", ext: "csv", contentType: "text/csv; charset=utf-8" },
};

export interface ExportRequest {
	keys?: string[];
	collectionKey?: string;
	format: ExportFormat;
	includeNotes?: boolean;
}
export interface ExportResult {
	filename: string;
	contentType: string;
	text: string;
	count: number;
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
		db.query(`SELECT i.key FROM items i WHERE i.deleted = 0 AND i.parent_key IS NULL AND ${REGULAR} ORDER BY i.date_added, i.key`).all() as {
			key: string;
		}[]
	).map((r) => r.key);
}

export function gatherItems(db: Database, req: ExportRequest): (ExportItem & { files: string[]; links: string[]; autoTags: string[] })[] {
	const keys = selectKeys(db, req);
	const dataQ = db.query("SELECT data FROM items WHERE key = ?");
	const tagQ = db.query("SELECT tag, type FROM item_tags WHERE item_key = ? ORDER BY tag COLLATE NOCASE");
	const noteQ = db.query("SELECT data FROM items WHERE parent_key = ? AND item_type = 'note' AND deleted = 0 ORDER BY date_added, key");
	const attQ = db.query(
		`SELECT a.link_mode, a.path, a.url FROM attachments a JOIN items i ON i.key = a.item_key
		 WHERE i.parent_key = ? AND i.deleted = 0 ORDER BY i.date_added, i.key`,
	);
	return keys.map((key) => {
		const data = JSON.parse((dataQ.get(key) as { data: string }).data) as ZoteroItemData;
		const tags = tagQ.all(key) as { tag: string; type: number }[];
		const notes = req.includeNotes
			? (noteQ.all(key) as { data: string }[]).map((r) => htmlToText(String((JSON.parse(r.data) as ZoteroItemData).note ?? ""))).filter(Boolean)
			: [];
		const atts = attQ.all(key) as { link_mode: string; path: string | null; url: string | null }[];
		return {
			data,
			tags: tags.map((t) => t.tag),
			autoTags: tags.filter((t) => t.type === 1).map((t) => t.tag),
			notes,
			files: atts.filter((a) => a.path && a.link_mode !== "linked_url").map((a) => a.path!),
			links: atts.filter((a) => a.link_mode === "linked_url" && a.url).map((a) => a.url!),
		};
	});
}

const safeName = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Exported Items";

export function exportItems(db: Database, req: ExportRequest): ExportResult {
	const fmt = EXPORT_FORMATS[req.format];
	if (!fmt) throw new HttpError(400, `unknown format: ${String(req.format)} (use bibtex, biblatex, ris, csljson or csv)`);
	const items = gatherItems(db, req);
	let text: string;
	switch (req.format) {
		case "bibtex": text = exportBibtex(items, "bibtex"); break;
		case "biblatex": text = exportBibtex(items, "biblatex"); break;
		case "ris": text = exportRis(items); break;
		case "csljson": text = exportCslJson(items); break;
		case "csv": text = exportCsv(items); break;
	}
	let base = "Exported Items";
	if (req.collectionKey && !(req.keys && req.keys.length)) {
		const c = db.query("SELECT name FROM collections WHERE key = ?").get(req.collectionKey) as { name: string } | null;
		if (c) base = safeName(c.name);
	} else if (!(req.keys && req.keys.length)) base = "My Library";
	return { filename: `${base}.${fmt.ext}`, contentType: fmt.contentType, text, count: items.length };
}
