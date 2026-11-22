// Import: detect the format, parse to items, create them (skipping DOI duplicates) in a collection.
import type { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addFile, addLink } from "../additems/files";
import { createCollection, createItem, getCollection, HttpError } from "../db";
import { relativeUnder } from "../files/paths";
import { parseBibtex } from "./bibtex";
import { normDoi, type ParsedItem } from "./common";
import { parseCslJson } from "./csljson";
import { parseEndnoteXml } from "./endnote";
import { parseMods } from "./mods";
import { parseNbib } from "./pubmed";
import { parseZoteroRdf } from "./rdf";
import { parseRis } from "./ris";

export type ImportFormat = "bibtex" | "ris" | "csljson" | "pubmed-nbib" | "endnote-xml" | "rdf" | "mods";
export const IMPORT_FORMATS: ImportFormat[] = ["bibtex", "ris", "csljson", "pubmed-nbib", "endnote-xml", "rdf", "mods"];

export interface ImportRequest {
	text: string;
	format?: ImportFormat | "auto";
	collectionName?: string | null;
	collectionKey?: string;
	autoTag?: boolean;
	/** Folder the text came from: relative attachment paths (Zotero RDF) resolve against it. */
	basePath?: string;
}
export interface ImportResult {
	created: number;
	skipped: number;
	errors: string[];
	collectionKey: string | null;
	format: ImportFormat;
	itemKeys?: string[];
	collections: number; // collections created (formats that carry a tree, e.g. RDF)
	attachments: number; // child attachments created
}

export function detectFormat(text: string): ImportFormat | null {
	const t = text.replace(/^﻿/, "").trimStart();
	if (!t) return null;
	if (t.startsWith("<")) {
		const head = t.slice(0, 5000);
		if (/<(?:\w+:)?mods(?:Collection)?[\s>]/.test(head) || /loc\.gov\/mods/.test(head)) return "mods";
		if (/<(?:\w+:)?RDF[\s>]/.test(head) || /rdf-syntax-ns#/.test(head)) return "rdf";
		return /<records?\b|<xml\b|<ref-type\b/i.test(head) ? "endnote-xml" : null;
	}
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
		case "bibtex":
			return parseBibtex(text);
		case "ris":
			return parseRis(text);
		case "csljson":
			return parseCslJson(text);
		case "pubmed-nbib":
			return parseNbib(text);
		case "endnote-xml":
			return parseEndnoteXml(text);
		case "rdf":
			return parseZoteroRdf(text);
		case "mods":
			return parseMods(text);
	}
}

function existingDois(db: Database): Set<string> {
	const rows = db
		.query(
			"SELECT json_extract(data, '$.DOI') AS doi FROM items WHERE deleted = 0 AND parent_key IS NULL AND json_extract(data, '$.DOI') <> ''",
		)
		.all() as { doi: string | null }[];
	return new Set(rows.map((r) => normDoi(r.doi)).filter(Boolean));
}

/** A path for an attachment the import mentions: absolute, relative to the import folder, or a file: URL. */
function attachmentPath(raw: string | undefined, basePath: string | undefined): string | null {
	const p = (raw ?? "").trim();
	if (!p) return null;
	if (p.startsWith("file:")) {
		try {
			return fileURLToPath(p);
		} catch {
			return null;
		}
	}
	if (isAbsolute(p)) return p;
	if (!basePath) return null;
	return resolve(basePath, p.replace(/^\.?[\\/]/, ""));
}

/**
 * Attachment paths come from the file being imported, which may be from anyone ("file = {C:/Users/me/.ssh/id_rsa}"). Only
 * files inside the folder the import file came from (basePath) are copied; absolute paths elsewhere, UNC / device paths and
 * links that resolve outside the folder are refused. Returns an error message, or null when the file is acceptable.
 */
function attachmentRefusal(file: string, basePath: string | undefined): string | null {
	if (/^[\\/]{2}/.test(file)) return "network and device paths are not imported";
	if (!basePath) return "give the import folder so attachments next to the file can be found";
	if (relativeUnder(file, basePath) === null) return "it is outside the folder the import file came from";
	try {
		if (existsSync(file) && relativeUnder(realpathSync(file), realpathSync(basePath)) === null)
			return "it links to a file outside the import folder";
	} catch {
		return "it could not be checked";
	}
	return null;
}

export function importText(db: Database, req: ImportRequest): ImportResult {
	if (typeof req.text !== "string" || !req.text.trim()) throw new HttpError(400, "text is required");
	let format: ImportFormat;
	if (!req.format || req.format === "auto") {
		const d = detectFormat(req.text);
		if (!d)
			throw new HttpError(
				400,
				"could not recognise the format; expected BibTeX, RIS, CSL JSON, PubMed (.nbib), EndNote XML, Zotero RDF or MODS",
			);
		format = d;
	} else if (IMPORT_FORMATS.includes(req.format)) format = req.format;
	else throw new HttpError(400, `unknown format: ${String(req.format)}`);

	let collectionKey: string | null = null;
	if (req.collectionKey) {
		if (!getCollection(db, req.collectionKey)) throw new HttpError(404, "collection not found");
		collectionKey = req.collectionKey;
	}
	const rootCollection = collectionKey;
	// the collection reported back: the chosen one, else the first the import created or filed items into
	let reportedKey: string | null = collectionKey;

	const { items, errors } = parse(req.text, format);
	if (req.autoTag === false) {
		for (const it of items) delete it.data.tags;
	}
	const seen = existingDois(db);
	const itemKeys: string[] = [];
	let created = 0;
	let skipped = 0;
	let collections = 0;
	let attachments = 0;
	const wantNewCollection = !collectionKey && req.collectionName !== null;
	const collectionName = (req.collectionName ?? "").trim() || `Imported ${new Date().toISOString().slice(0, 10)}`;

	// collection paths ("Parent/Child") from the file, created once and reused
	const pathKeys = new Map<string, string>();
	const collectionFor = (segments: string[]): string | null => {
		let parent = rootCollection;
		for (const raw of segments) {
			const name = raw.trim();
			if (!name) continue;
			const cacheKey = `${parent ?? ""}\u0000${name}`;
			const known = pathKeys.get(cacheKey);
			if (known) {
				parent = known;
				continue;
			}
			const existing = db.query("SELECT key FROM collections WHERE name = ? AND parent_key IS ?").get(name, parent) as {
				key: string;
			} | null;
			if (existing) parent = existing.key;
			else {
				parent = createCollection(db, name, parent).key;
				collections++;
			}
			pathKeys.set(cacheKey, parent!);
		}
		return parent; // the deepest collection of the path
	};

	const addAttachments = (it: ParsedItem, parentKey: string) => {
		for (const att of it.attachments ?? []) {
			try {
				const url = (att.url ?? "").trim();
				if (url && /^[a-z][a-z0-9+.-]*:/i.test(url) && !/^file:/i.test(url)) {
					addLink(db, { parentKey, url, title: att.title });
					attachments++;
					continue;
				}
				const file = attachmentPath(att.path ?? url, req.basePath);
				if (!file) {
					errors.push(`attachment ${att.path ?? url} skipped: give the import folder so relative paths can be found`);
					continue;
				}
				const refusal = attachmentRefusal(file, req.basePath);
				if (refusal) {
					errors.push(`attachment ${att.path ?? url} skipped: ${refusal}`);
					continue;
				}
				if (!existsSync(file)) {
					errors.push(`attachment not found: ${file}`);
					continue;
				}
				addFile(db, { mode: "imported_file", path: file, parentKey, name: att.title, contentType: att.contentType });
				attachments++;
			} catch (e) {
				errors.push(`attachment ${att.title ?? att.path ?? att.url}: ${e instanceof Error ? e.message : e}`);
			}
		}
	};

	// one outer transaction: thousands of per-item commits are slow; a failing item rolls back only its own savepoint
	db.transaction(() => {
		for (const [i, it] of items.entries()) {
			const doi = normDoi(typeof it.data.DOI === "string" ? it.data.DOI : "");
			if (doi && seen.has(doi)) {
				skipped++;
				continue;
			}
			try {
				let keys: string[] = [];
				if (it.collections?.length) {
					for (const path of it.collections) {
						const key = collectionFor(path);
						if (!key) continue;
						keys.push(key);
						reportedKey ??= key;
					}
				}
				if (!keys.length && !collectionKey && wantNewCollection) {
					collectionKey = createCollection(db, collectionName).key;
					reportedKey ??= collectionKey;
					keys = [collectionKey];
				} else if (!keys.length && collectionKey) keys = [collectionKey];
				const detail = createItem(db, { ...it.data, collections: [...new Set(keys)] });
				const parentKey = detail.data.key;
				for (const html of it.notes) createItem(db, { itemType: "note", note: html, parentItem: parentKey });
				if (it.attachments?.length) addAttachments(it, parentKey);
				if (doi) seen.add(doi);
				created++;
				itemKeys.push(parentKey);
			} catch (e) {
				errors.push(
					`item ${i + 1}${it.data.title ? ` (${String(it.data.title).slice(0, 60)})` : ""}: ${e instanceof Error ? e.message : e}`,
				);
			}
		}
	})();
	return { created, skipped, errors, collectionKey: reportedKey, format, collections, attachments, itemKeys };
}
