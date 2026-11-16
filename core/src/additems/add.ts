// "Add item by identifier": DOI / PMID / PMCID / arXiv ID / ISBN -> metadata -> new library item (skipping duplicates).
import type { Database } from "bun:sqlite";
import { assertWritable, libraryOfCollection } from "../libraries";
import type { ItemDetail } from "../api-types";
import { HttpError, createItem } from "../db";
import { itemDoi } from "../references/ids";
import { mapLimit } from "../references/net";
import { indexItem } from "../search";
import { findArxivId, normalizeIsbn, parseIdentifiers, type ParsedId } from "./identifiers";
import { fetchArxiv, fetchDoi, fetchIsbn, fetchPmc, fetchPubmed, type ItemData } from "./sources";

export interface AddByIdentifierResult {
	added: ItemDetail[];
	failed: { id: string; error: string }[];
	/** identifiers whose item is already in the library (nothing was created) */
	existing: { id: string; key: string }[];
}

export interface Known {
	doi: Map<string, string>;
	pmid: Map<string, string>;
	pmcid: Map<string, string>;
	isbn: Map<string, string>;
	arxiv: Map<string, string>;
}

function setIfNew(m: Map<string, string>, k: string | null | undefined, key: string): void {
	if (k && !m.has(k)) m.set(k, key);
}

/** Identifiers of an item (as stored in Zotero fields / Extra), lower-cased and normalised. */
export function identifiersOf(data: Record<string, unknown>): {
	doi?: string;
	pmid?: string;
	pmcid?: string;
	isbns: string[];
	arxiv?: string;
} {
	const extra = typeof data.extra === "string" ? data.extra : "";
	const url = typeof data.url === "string" ? data.url : "";
	const doi = itemDoi(data) ?? undefined;
	const pmid = extra.match(/^\s*PMID:\s*(\d+)/im)?.[1] ?? url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i)?.[1];
	const pmcid = extra.match(/^\s*PMCID:\s*(PMC\d+)/im)?.[1]?.toUpperCase() ?? url.match(/\b(PMC\d+)\b/i)?.[1]?.toUpperCase();
	const isbns = (typeof data.ISBN === "string" ? data.ISBN.split(/[\s,;]+/) : [])
		.map((s) => normalizeIsbn(s))
		.filter((s): s is string => !!s);
	const archive = typeof data.archiveID === "string" ? data.archiveID : "";
	let arxiv = findArxivId(archive) ?? findArxivId(extra) ?? findArxivId(url) ?? undefined;
	if (!arxiv && doi) arxiv = doi.match(/^10\.48550\/arxiv\.(.+)$/i)?.[1];
	return { doi, pmid, pmcid, isbns, arxiv };
}

/** The identifiers already in one library (My Library by default): the same paper in two libraries is not a duplicate. */
export function loadKnown(db: Database, libraryId = 1): Known {
	const k: Known = { doi: new Map(), pmid: new Map(), pmcid: new Map(), isbn: new Map(), arxiv: new Map() };
	const rows = db
		.query(
			`SELECT key, data FROM items
			 WHERE parent_key IS NULL AND deleted = 0 AND library_id = ? AND item_type NOT IN ('attachment','note','annotation')`,
		)
		.all(libraryId) as { key: string; data: string }[];
	for (const r of rows) {
		let d: Record<string, unknown>;
		try {
			d = JSON.parse(r.data);
		} catch {
			continue;
		}
		register(k, r.key, d);
	}
	return k;
}

function register(k: Known, key: string, d: Record<string, unknown>): void {
	const ids = identifiersOf(d);
	setIfNew(k.doi, ids.doi, key);
	setIfNew(k.pmid, ids.pmid, key);
	setIfNew(k.pmcid, ids.pmcid, key);
	for (const i of ids.isbns) setIfNew(k.isbn, i, key);
	setIfNew(k.arxiv, ids.arxiv, key);
}

function findExisting(k: Known, d: Record<string, unknown>): string | undefined {
	const ids = identifiersOf(d);
	return (
		(ids.doi && k.doi.get(ids.doi)) ||
		(ids.pmid && k.pmid.get(ids.pmid)) ||
		(ids.pmcid && k.pmcid.get(ids.pmcid)) ||
		ids.isbns.map((i) => k.isbn.get(i)).find(Boolean) ||
		(ids.arxiv && k.arxiv.get(ids.arxiv)) ||
		undefined
	);
}

function knownFor(k: Known, p: ParsedId): string | undefined {
	switch (p.kind) {
		case "doi":
			return k.doi.get(p.id);
		case "pmid":
			return k.pmid.get(p.id);
		case "pmcid":
			return k.pmcid.get(p.id);
		case "isbn":
			return k.isbn.get(p.id);
		case "arxiv":
			return k.arxiv.get(p.id);
	}
}

export async function fetchByIdentifier(db: Database, p: ParsedId): Promise<ItemData | null> {
	switch (p.kind) {
		case "doi":
			return fetchDoi(p.id, db);
		case "pmid":
			return fetchPubmed(p.id, db);
		case "pmcid":
			return fetchPmc(p.id);
		case "arxiv":
			return fetchArxiv(p.id);
		case "isbn":
			return fetchIsbn(p.id);
	}
}

const KIND_LABEL = { doi: "DOI", pmid: "PMID", pmcid: "PMCID", arxiv: "arXiv ID", isbn: "ISBN" } as const;

/** Resolve a single identifier to a new item, or to the existing item that already has it. */
export async function addOne(
	db: Database,
	p: ParsedId,
	known: Known,
	collectionKey?: string,
	autoTag = true,
	libraryId?: number,
): Promise<{ added?: ItemDetail; existing?: string }> {
	const have = knownFor(known, p);
	if (have) return { existing: have };
	const data = await fetchByIdentifier(db, p);
	if (!data) throw new Error(`no record found for this ${KIND_LABEL[p.kind]}`);
	const dup = findExisting(known, data as Record<string, unknown>);
	if (dup) return { existing: dup };
	if (collectionKey) data.collections = [collectionKey];
	if (!autoTag && data.tags) delete data.tags;
	const detail = createItem(db, data, libraryId);
	indexItem(db, detail.data.key);
	register(known, detail.data.key, detail.data as Record<string, unknown>);
	return { added: detail };
}

export async function addByIdentifier(
	db: Database,
	text: unknown,
	collectionKey?: string,
	autoTag = true,
	libraryId?: number,
): Promise<AddByIdentifierResult> {
	if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "text is required");
	if (collectionKey !== undefined && collectionKey !== null && typeof collectionKey !== "string")
		throw new HttpError(400, "collectionKey must be a string");
	const { ids, unknown } = parseIdentifiers(text);
	const result: AddByIdentifierResult = {
		added: [],
		failed: unknown.map((id) => ({ id, error: "not a recognised identifier (DOI, PMID, PMCID, arXiv ID or ISBN)" })),
		existing: [],
	};
	if (ids.length === 0 && unknown.length === 0) throw new HttpError(400, "no identifiers found");
	// the library: the one named, else the collection's, else My Library
	const lib = libraryId ?? (collectionKey ? (libraryOfCollection(db, collectionKey) ?? 1) : 1);
	assertWritable(db, lib);
	const known = loadKnown(db, lib);
	const outcomes = await mapLimit(ids, 3, async (p) => {
		try {
			return { p, ...(await addOne(db, p, known, collectionKey || undefined, autoTag, lib)) };
		} catch (e) {
			return { p, error: e instanceof Error ? e.message : String(e) };
		}
	});
	for (const o of outcomes) {
		if ("error" in o && o.error) result.failed.push({ id: o.p.raw, error: o.error });
		else if ("added" in o && o.added) result.added.push(o.added);
		else if ("existing" in o && o.existing) result.existing.push({ id: o.p.raw, key: o.existing });
	}
	return result;
}
