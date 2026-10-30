// Import: detect the format, parse to items, create them (skipping DOI duplicates) in a collection.
import type { Database } from "bun:sqlite";
import { createCollection, createItem, getCollection, HttpError } from "../db";
import { parseBibtex } from "./bibtex";
import { normDoi, type ParsedItem } from "./common";
import { parseCslJson } from "./csljson";
import { parseEndnoteXml } from "./endnote";
import { parseNbib } from "./pubmed";
import { parseRis } from "./ris";

export type ImportFormat = "bibtex" | "ris" | "csljson" | "pubmed-nbib" | "endnote-xml";
export const IMPORT_FORMATS: ImportFormat[] = ["bibtex", "ris", "csljson", "pubmed-nbib", "endnote-xml"];

export interface ImportRequest {
	text: string;
	format?: ImportFormat | "auto";
	collectionName?: string | null;
	collectionKey?: string;
}
export interface ImportResult {
	created: number;
	skipped: number;
	errors: string[];
	collectionKey: string | null;
	format: ImportFormat;
}

export function detectFormat(text: string): ImportFormat | null {
	const t = text.replace(/^﻿/, "").trimStart();
	if (!t) return null;
	if (t.startsWith("<")) return /<records?\b|<xml\b|<ref-type\b/i.test(t.slice(0, 5000)) ? "endnote-xml" : null;
	if (t.startsWith("[") || t.startsWith("{")) {
		try {
			JSON.parse(t);
			return "csljson";
		} catch {
			/* maybe BibTeX with a leading brace comment; fall through */
		}
	}
	if (/^TY {1,2}- ?\S/m.test(t)) return "ris";
	if (/^PMID- ?\d+/m.test(t) || (/^TI {2}- /m.test(t) && /^(FAU|JT|DP|AU) {1,2}- /m.test(t))) return "pubmed-nbib";
	if (/(^|\n)\s*@[A-Za-z]+\s*[{(]/.test(t)) return "bibtex";
	return null;
}

function parse(text: string, format: ImportFormat): { items: ParsedItem[]; errors: string[] } {
	switch (format) {
		case "bibtex": return parseBibtex(text);
		case "ris": return parseRis(text);
		case "csljson": return parseCslJson(text);
		case "pubmed-nbib": return parseNbib(text);
		case "endnote-xml": return parseEndnoteXml(text);
	}
}

function existingDois(db: Database): Set<string> {
	const rows = db
		.query("SELECT json_extract(data, '$.DOI') AS doi FROM items WHERE deleted = 0 AND parent_key IS NULL AND json_extract(data, '$.DOI') <> ''")
		.all() as { doi: string | null }[];
	return new Set(rows.map((r) => normDoi(r.doi)).filter(Boolean));
}

export function importText(db: Database, req: ImportRequest): ImportResult {
	if (typeof req.text !== "string" || !req.text.trim()) throw new HttpError(400, "text is required");
	let format: ImportFormat;
	if (!req.format || req.format === "auto") {
		const d = detectFormat(req.text);
		if (!d) throw new HttpError(400, "could not recognise the format; expected BibTeX, RIS, CSL JSON, PubMed (.nbib) or EndNote XML");
		format = d;
	} else if (IMPORT_FORMATS.includes(req.format)) format = req.format;
	else throw new HttpError(400, `unknown format: ${String(req.format)}`);

	let collectionKey: string | null = null;
	if (req.collectionKey) {
		if (!getCollection(db, req.collectionKey)) throw new HttpError(404, "collection not found");
		collectionKey = req.collectionKey;
	}

	const { items, errors } = parse(req.text, format);
	const seen = existingDois(db);
	let created = 0;
	let skipped = 0;
	const wantNewCollection = !collectionKey && req.collectionName !== null;
	const collectionName = (req.collectionName ?? "").trim() || `Imported ${new Date().toISOString().slice(0, 10)}`;

	// one outer transaction: thousands of per-item commits are slow; a failing item rolls back only its own savepoint
	db.transaction(() => {
	for (const [i, it] of items.entries()) {
		const doi = normDoi(typeof it.data.DOI === "string" ? it.data.DOI : "");
		if (doi && seen.has(doi)) {
			skipped++;
			continue;
		}
		try {
			if (!collectionKey && wantNewCollection) collectionKey = createCollection(db, collectionName).key;
			const detail = createItem(db, { ...it.data, collections: collectionKey ? [collectionKey] : [] });
			for (const html of it.notes) createItem(db, { itemType: "note", note: html, parentItem: detail.data.key });
			if (doi) seen.add(doi);
			created++;
		} catch (e) {
			errors.push(`item ${i + 1}${it.data.title ? ` (${String(it.data.title).slice(0, 60)})` : ""}: ${e instanceof Error ? e.message : e}`);
		}
	}
	})();
	return { created, skipped, errors, collectionKey, format };
}
