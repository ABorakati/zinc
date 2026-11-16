// Resolve an item's bibliography: OpenAlex -> Crossref -> Semantic Scholar -> parse the PDF text.
// Results are cached per item in reference_cache; the library match is recomputed on every request.
import type { Database } from "bun:sqlite";
import type { Reference, ReferenceList } from "../api-types";
import { HttpError, nowIso } from "../db";
import { extractFulltext } from "../extract";
import { buildLibraryIndex, itemDoi } from "./ids";
import { mailtoFor, mapLimit } from "./net";
import { parseBibliography } from "./parse";
import {
	type RefCore,
	compact,
	crossrefQuery,
	crossrefReferences,
	enrich,
	openAlexByDois,
	openAlexReferences,
	semanticScholarReferences,
} from "./sources";

export const CACHE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const MAX_PDF_REFS = 150;

export const hooks = {
	/** Text extraction for an attachment missing from the fulltext table (tests replace it). */
	extract: (db: Database, attachmentKey: string): Promise<unknown> => extractFulltext(db, attachmentKey),
};

const ready = new WeakSet<Database>();

export function ensureCache(db: Database): void {
	if (ready.has(db)) return;
	db.exec("CREATE TABLE IF NOT EXISTS reference_cache(item_key TEXT PRIMARY KEY, data TEXT, fetched_at TEXT)");
	ready.add(db);
}

interface Cached {
	source: string;
	fetchedAt: string;
	references: RefCore[];
}

function readCache(db: Database, key: string): Cached | null {
	const row = db.query("SELECT data, fetched_at FROM reference_cache WHERE item_key = ?").get(key) as {
		data: string;
		fetched_at: string;
	} | null;
	if (!row) return null;
	if (Date.now() - Date.parse(row.fetched_at) > CACHE_MAX_AGE_MS) return null;
	try {
		const v = JSON.parse(row.data) as { source: string; references: RefCore[] };
		return { source: v.source, fetchedAt: row.fetched_at, references: v.references };
	} catch {
		return null;
	}
}

function writeCache(db: Database, key: string, source: string, fetchedAt: string, references: RefCore[]): void {
	db.query(
		`INSERT INTO reference_cache(item_key, data, fetched_at) VALUES(?, ?, ?)
		 ON CONFLICT(item_key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
	).run(key, JSON.stringify({ source, references }), fetchedAt);
}

interface ItemRef {
	key: string; // the bibliographic (parent) item
	doi: string | null;
	pdfs: string[]; // attachment keys to try for text
}

function resolveItem(db: Database, key: string): ItemRef {
	const row = db.query("SELECT key, item_type, parent_key, data, deleted FROM items WHERE key = ?").get(key) as {
		key: string;
		item_type: string;
		parent_key: string | null;
		data: string;
		deleted: number;
	} | null;
	if (!row) throw new HttpError(404, "item not found");
	if (row.item_type === "attachment" && row.parent_key) return resolveItem(db, row.parent_key);
	if (row.item_type === "note" || row.item_type === "annotation") throw new HttpError(400, "item has no references");
	let data: Record<string, unknown> = {};
	try {
		data = JSON.parse(row.data);
	} catch {
		/* keep empty */
	}
	const pdfs = (
		db
			.query(
				`SELECT a.item_key FROM attachments a JOIN items i ON i.key = a.item_key
				 WHERE i.parent_key = ? AND i.deleted = 0 AND (a.content_type = 'application/pdf' OR lower(coalesce(a.path, '')) LIKE '%.pdf')
				 ORDER BY (a.path IS NULL), a.item_key`,
			)
			.all(key) as { item_key: string }[]
	).map((r) => r.item_key);
	if (row.item_type === "attachment") pdfs.push(row.key);
	return { key: row.key, doi: itemDoi(data), pdfs };
}

async function pdfText(db: Database, attachmentKey: string): Promise<string | null> {
	const get = () =>
		(db.query("SELECT content FROM fulltext WHERE attachment_key = ?").get(attachmentKey) as { content: string } | null)?.content ??
		null;
	let text = get();
	if (text == null) {
		try {
			await hooks.extract(db, attachmentKey);
		} catch {
			return null;
		}
		text = get();
	}
	return text;
}

async function fromPdf(db: Database, pdfs: string[], mailto: string | null): Promise<RefCore[] | null> {
	for (const att of pdfs) {
		const text = await pdfText(db, att);
		if (!text) continue;
		const entries = parseBibliography(text).slice(0, MAX_PDF_REFS);
		if (entries.length === 0) continue;
		const refs: RefCore[] = await mapLimit(entries, 4, async (e) => {
			const base: RefCore = compact({
				raw: e.raw,
				doi: e.doi,
				title: e.title,
				authors: e.authors,
				year: e.year,
				url: e.doi ? `https://doi.org/${e.doi}` : undefined,
			});
			if (e.doi) return base;
			try {
				const hit = await crossrefQuery(e.raw, mailto);
				if (hit) return compact({ ...base, ...hit, raw: e.raw });
			} catch {
				/* leave the parsed entry */
			}
			return base;
		});
		const doiMeta = await openAlexByDois(
			refs.map((r) => r.doi).filter((d): d is string => !!d),
			mailto,
		);
		enrich(refs, doiMeta);
		return refs;
	}
	return null;
}

async function fetchFresh(db: Database, item: ItemRef): Promise<{ source: string; references: RefCore[] } | null> {
	const mailto = mailtoFor(db);
	const attempt = async (fn: () => Promise<RefCore[] | null>): Promise<RefCore[] | null> => {
		try {
			const r = await fn();
			return r && r.length > 0 ? r : null;
		} catch {
			return null;
		}
	};
	if (item.doi) {
		const doi = item.doi;
		let refs = await attempt(() => openAlexReferences(doi, mailto));
		if (refs) return { source: "openalex", references: refs };
		refs = await attempt(async () => {
			const r = await crossrefReferences(doi, mailto);
			if (r)
				enrich(
					r,
					await openAlexByDois(
						r.map((x) => x.doi).filter((d): d is string => !!d),
						mailto,
					),
				);
			return r;
		});
		if (refs) return { source: "crossref", references: refs };
		refs = await attempt(() => semanticScholarReferences(doi));
		if (refs) return { source: "semanticscholar", references: refs };
	}
	const refs = await attempt(() => fromPdf(db, item.pdfs, mailto));
	return refs ? { source: "pdf", references: refs } : null;
}

export interface ResolveOptions {
	refresh?: boolean;
}

export async function getReferences(db: Database, itemKey: string, opts: ResolveOptions = {}): Promise<ReferenceList> {
	ensureCache(db);
	const item = resolveItem(db, itemKey);
	let cached = opts.refresh ? null : readCache(db, item.key);
	if (!cached) {
		const fresh = await fetchFresh(db, item);
		if (fresh) {
			const fetchedAt = nowIso();
			writeCache(db, item.key, fresh.source, fetchedAt, fresh.references);
			cached = { source: fresh.source, fetchedAt, references: fresh.references };
		} else {
			cached = { source: "none", fetchedAt: nowIso(), references: [] };
		}
	}
	const lib = buildLibraryIndex(db, item.key);
	const references: Reference[] = cached.references.map((r, i) => {
		const inLib = lib.match(r);
		return { ...r, index: i + 1, ...(inLib ? { inLibraryKey: inLib } : {}) };
	});
	return { itemKey: item.key, source: cached.source, fetchedAt: cached.fetchedAt, references };
}
