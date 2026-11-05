// Translation use cases: Add from URL (web translators), Import (import translators) and Export (export translators).
// Page/Text -> translator JSON happens in the worker (runtime/jobs.ts); here the items are saved with the same
// converter the connector uses (connector/items.ts), so notes, tags, link attachments and collections behave like
// connector saves.
import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { addFile, addLink, guessContentType } from "../additems/files";
import { createCollection, getCollection, HttpError } from "../db";
import { saveTranslatedItem, convertTags } from "../connector/items";
import { normDoi } from "../io/common";
import { detectFormat, importText, type ImportFormat } from "../io/import";
import { gatherItems } from "../io/export";
import type { CachedResponse, RunLimits } from "./runtime/http";
import type { Choice, TranslatorRef, WebResult } from "./runtime/jobs";
import { runJob, TranslateError } from "./pool";
import { translatorsDirFor } from "./translators";

export interface SavedSummary {
	key: string;
	title: string;
	itemType: string;
}

const LIMITS: Partial<RunLimits> = {};
export const translateLimits = {
	/** Hard time limit of one translation run (ms). */
	timeoutMs: 60_000,
	/** HTTP requests one run may make. */
	maxRequests: 25,
	maxAttachmentBytes: 60 * 1024 * 1024,
};

function limits(): Partial<RunLimits> {
	return { ...LIMITS, maxRequests: translateLimits.maxRequests };
}

async function job<T>(op: "web" | "import" | "export", params: unknown): Promise<T> {
	try {
		return await runJob<T>(op, params, translateLimits.timeoutMs);
	} catch (e) {
		if (e instanceof TranslateError) throw new HttpError(e.code === "timeout" ? 504 : 502, e.message);
		throw e;
	}
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

function summary(key: string, raw: Record<string, unknown>): SavedSummary {
	const itemType = str(raw.itemType) || "document";
	const title = str(raw.title) || (itemType === "note" ? str(raw.note).replace(/<[^>]+>/g, " ").trim().slice(0, 80) : "") || str(raw.url) || "(untitled)";
	return { key, title, itemType };
}

// ------------------------------------------------------------------ web

interface Session {
	url: string;
	translatorID: string;
	label: string;
	cache: CachedResponse[];
	choices: Choice[];
	collectionKey: string | null;
	attachments: boolean;
	created: number;
}
const sessions = new Map<string, Session>();
const SESSION_TTL = 15 * 60_000;

function sweepSessions(): void {
	const now = Date.now();
	for (const [id, s] of sessions) if (now - s.created > SESSION_TTL) sessions.delete(id);
	while (sessions.size > 20) sessions.delete(sessions.keys().next().value!);
}

export type WebTranslateResponse =
	| { items: SavedSummary[]; translator: string | null; fallback?: "embedded" | "webpage" }
	| { choices: { session: string; url: string; items: Choice[] } };

export interface WebRequest {
	url: string;
	collectionKey?: string | null;
	/** Download PDFs the translator found (default true). */
	attachments?: boolean;
	translatorID?: string;
}

function checkCollection(db: Database, key: string | null | undefined): string | null {
	if (!key) return null;
	if (!getCollection(db, key)) throw new HttpError(404, "collection not found");
	return key;
}

function checkUrl(url: unknown): string {
	if (typeof url !== "string" || !url.trim()) throw new HttpError(400, "url is required");
	try {
		const u = new URL(url.trim());
		if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
		return u.href;
	} catch {
		throw new HttpError(400, "url must be an http(s) address");
	}
}

export async function translateWeb(db: Database, req: WebRequest): Promise<WebTranslateResponse> {
	const url = checkUrl(req.url);
	const collectionKey = checkCollection(db, req.collectionKey);
	const { dir } = translatorsDirFor(db);
	const r = await job<WebResult>("web", { url, translatorsDir: dir, limits: limits(), translatorID: req.translatorID });
	return finishWeb(db, r, collectionKey, req.attachments !== false);
}

export async function selectWeb(db: Database, body: { session: string; keys: string[]; collectionKey?: string | null; attachments?: boolean }): Promise<WebTranslateResponse> {
	sweepSessions();
	const s = sessions.get(body.session);
	if (!s) throw new HttpError(404, "session expired; run the address again");
	if (!Array.isArray(body.keys) || !body.keys.length) throw new HttpError(400, "keys must list at least one item");
	const offered = new Set(s.choices.map((c) => c.key));
	if (body.keys.some((k) => typeof k !== "string" || !offered.has(k))) throw new HttpError(409, "keys do not match the items offered");
	const collectionKey = body.collectionKey === undefined ? s.collectionKey : checkCollection(db, body.collectionKey);
	const { dir } = translatorsDirFor(db);
	const r = await job<WebResult>("web", { url: s.url, translatorsDir: dir, limits: limits(), cache: s.cache, translatorID: s.translatorID, selectedKeys: body.keys });
	sessions.delete(body.session);
	if (r.kind === "choices") throw new HttpError(502, "the translator offered the choices again instead of saving");
	return finishWeb(db, r, collectionKey, body.attachments ?? s.attachments);
}

async function finishWeb(db: Database, r: WebResult, collectionKey: string | null, attachments: boolean): Promise<WebTranslateResponse> {
	if (r.kind === "choices") {
		sweepSessions();
		const id = crypto.randomUUID().replace(/-/g, "").slice(0, 15);
		sessions.set(id, { url: r.url, translatorID: r.translator.id, label: r.translator.label, cache: r.cache, choices: r.choices, collectionKey, attachments, created: Date.now() });
		return { choices: { session: id, url: r.url, items: r.choices } };
	}
	const saved: SavedSummary[] = [];
	for (const raw of r.items) {
		const out = saveTranslatedItem(db, raw, collectionKey);
		saved.push(summary(out.key, raw));
		if (attachments) await saveFileAttachments(db, out.key, raw, r.cache);
	}
	return { items: saved, translator: r.translator?.label ?? null, fallback: r.fallback };
}

/** PDFs (and other non-snapshot files) a translator listed: downloaded best effort, never failing the item. */
async function saveFileAttachments(db: Database, parentKey: string, raw: Record<string, any>, _cache: CachedResponse[]): Promise<void> {
	for (const a of Array.isArray(raw.attachments) ? raw.attachments : []) {
		if (!a || typeof a !== "object" || a.snapshot === false || typeof a.url !== "string" || !/^https?:\/\//i.test(a.url)) continue;
		const mime = str(a.mimeType).toLowerCase();
		if (mime !== "application/pdf" && mime !== "application/epub+zip") continue;
		try {
			const res = await fetch(a.url, { signal: AbortSignal.timeout(45_000), headers: { Accept: "application/pdf,*/*", Referer: str(raw.url) || a.url } });
			if (!res.ok) continue;
			const declared = Number(res.headers.get("content-length") ?? 0);
			if (declared > translateLimits.maxAttachmentBytes) continue;
			const bytes = new Uint8Array(await res.arrayBuffer());
			if (bytes.length > translateLimits.maxAttachmentBytes) continue;
			if (mime === "application/pdf" && new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).indexOf("%PDF") < 0) continue;
			const dir = join(tmpdir(), `zn-translate-${crypto.randomUUID().slice(0, 8)}`);
			mkdirSync(dir, { recursive: true });
			const file = join(dir, (str(a.title).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim() || "document") + (mime === "application/pdf" ? ".pdf" : ".epub"));
			writeFileSync(file, bytes);
			try {
				addFile(db, { mode: "imported_file", path: file, parentKey, name: basename(file), contentType: mime });
			} finally {
				try {
					(await import("node:fs")).rmSync(dir, { recursive: true, force: true });
				} catch {
					/* temp cleanup is best effort */
				}
			}
		} catch {
			/* an attachment that cannot be fetched is skipped; the item is already saved */
		}
	}
}

// ------------------------------------------------------------------ import

export interface TranslateImportRequest {
	text?: string;
	path?: string;
	translatorID?: string;
	collectionKey?: string | null;
	collectionName?: string | null;
	basePath?: string;
}
export interface TranslateImportResult {
	created: number;
	skipped: number;
	errors: string[];
	collectionKey: string | null;
	format: string;
	translator: string;
	itemKeys: string[];
	collections: number;
	attachments: number;
}

const MAX_IMPORT_BYTES = 80 * 1024 * 1024;

function decodeFile(bytes: Uint8Array): string {
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
	return new TextDecoder("utf-8").decode(bytes);
}

export async function translateImport(db: Database, req: TranslateImportRequest): Promise<TranslateImportResult> {
	let text = req.text;
	let basePath = req.basePath;
	if (typeof text !== "string" || !text.trim()) {
		if (!req.path) throw new HttpError(400, "text or path is required");
		const p = resolve(req.path);
		let size: number;
		try {
			size = statSync(p).size;
		} catch {
			throw new HttpError(404, `file not found: ${p}`);
		}
		if (size > MAX_IMPORT_BYTES) throw new HttpError(413, "file is too large to import");
		text = decodeFile(readFileSync(p));
		basePath ??= dirname(p);
	}
	if (!text.trim()) throw new HttpError(400, "the file is empty");
	text = text.replace(/^﻿/, "");
	const collectionKey = checkCollection(db, req.collectionKey);

	// Native importers first for the formats zotero-next reads itself; translators for everything else
	// or when the native path finds nothing.
	if (!req.translatorID) {
		const native: ImportFormat | null = detectFormat(text);
		if (native) {
			try {
				const r = importText(db, { text, format: native, collectionName: req.collectionName, collectionKey: collectionKey ?? undefined, basePath });
				if (r.created + r.skipped > 0) return { ...r, itemKeys: r.itemKeys ?? [], format: native, translator: `native:${native}` };
			} catch {
				/* fall through to the translators */
			}
		}
	}

	const { dir } = translatorsDirFor(db);
	const done = await job<{ items: any[]; collections: any[]; translator: TranslatorRef }>("import", { text, translatorsDir: dir, translatorID: req.translatorID, limits: limits() });
	return saveImported(db, done, { collectionKey, collectionName: req.collectionName, basePath });
}

/** Saves import-translator output: items (DOI duplicates skipped), their notes/tags, file attachments, collections. */
export function saveImported(
	db: Database,
	done: { items: any[]; collections: any[]; translator: TranslatorRef },
	opts: { collectionKey: string | null; collectionName?: string | null; basePath?: string },
): TranslateImportResult {
	const errors: string[] = [];
	const itemKeys: string[] = [];
	let created = 0;
	let skipped = 0;
	let collectionsMade = 0;
	let attachments = 0;
	let collectionKey = opts.collectionKey;
	const wantNew = !collectionKey && opts.collectionName !== null;
	const name = (opts.collectionName ?? "").trim() || `Imported ${new Date().toISOString().slice(0, 10)}`;

	const seen = new Set(
		(db.query("SELECT json_extract(data, '$.DOI') AS doi FROM items WHERE deleted = 0 AND parent_key IS NULL AND json_extract(data, '$.DOI') <> ''").all() as { doi: string | null }[])
			.map((r) => normDoi(r.doi))
			.filter(Boolean),
	);

	// translator collections: item id -> collection key path, built once
	const byItemId = new Map<string, string[]>();
	const makeCollection = (c: any, parent: string | null): void => {
		const existing = db.query("SELECT key FROM collections WHERE name = ? AND parent_key IS ?").get(str(c.name), parent) as { key: string } | null;
		const key = existing?.key ?? (collectionsMade++, createCollection(db, str(c.name) || "Collection", parent).key);
		for (const child of Array.isArray(c.children) ? c.children : []) {
			if (child?.type === "collection") makeCollection(child, key);
			else if (child?.id !== undefined) byItemId.set(String(child.id), [...(byItemId.get(String(child.id)) ?? []), key]);
		}
	};
	db.transaction(() => {
		for (const c of done.collections) makeCollection(c, opts.collectionKey);
	})();

	for (const [i, raw] of done.items.entries()) {
		const doi = normDoi(str(raw.DOI));
		if (doi && seen.has(doi)) {
			skipped++;
			continue;
		}
		try {
			let keys = byItemId.get(String(raw.id)) ?? [];
			if (!keys.length) {
				if (!collectionKey && wantNew) collectionKey = createCollection(db, name).key;
				if (collectionKey) keys = [collectionKey];
			}
			const manualTags = convertTags(raw.tags, 0);
			const rest = { ...raw, tags: [] };
			const out = saveTranslatedItem(db, rest, keys[0] ?? null, manualTags);
			for (const extra of keys.slice(1)) {
				db.query("INSERT OR IGNORE INTO collection_items (collection_key, item_key) VALUES (?, ?)").run(extra, out.key);
			}
			created++;
			itemKeys.push(out.key);
			if (doi) seen.add(doi);
			for (const a of Array.isArray(raw.attachments) ? raw.attachments : []) {
				try {
					const url = str(a?.url).trim();
					const local = str(a?.path || a?.localPath).trim();
					if (url && /^https?:\/\//i.test(url) && a.snapshot === false) continue; // already linked by saveTranslatedItem
					if (url && /^https?:\/\//i.test(url)) {
						addLink(db, { parentKey: out.key, url, title: str(a.title) });
						attachments++;
					} else if (local && opts.basePath) {
						const file = resolve(opts.basePath, local.replace(/^file:\/*/i, ""));
						if (statSync(file).isFile()) {
							addFile(db, { mode: "imported_file", path: file, parentKey: out.key, name: str(a.title) || basename(file), contentType: str(a.mimeType) || guessContentType(file) });
							attachments++;
						}
					}
				} catch (e) {
					errors.push(`attachment of item ${i + 1}: ${e instanceof Error ? e.message : e}`);
				}
			}
		} catch (e) {
			errors.push(`item ${i + 1}${raw.title ? ` (${String(raw.title).slice(0, 60)})` : ""}: ${e instanceof Error ? e.message : e}`);
		}
	}
	return { created, skipped, errors, collectionKey, format: done.translator.label, translator: done.translator.label, itemKeys, collections: collectionsMade, attachments };
}

// ------------------------------------------------------------------ export

export interface TranslateExportRequest {
	translatorID: string;
	keys?: string[];
	collectionKey?: string;
	includeNotes?: boolean;
	dir?: string;
	displayOptions?: Record<string, boolean>;
}
export interface TranslateExportResult {
	filename: string;
	contentType: string;
	text: string;
	count: number;
	path?: string;
	files: number;
}

const CONTENT_TYPES: Record<string, string> = {
	xml: "text/xml", html: "text/html", htm: "text/html", json: "application/json", csv: "text/csv", rdf: "application/rdf+xml",
	bib: "application/x-bibtex", ris: "application/x-research-info-systems", txt: "text/plain", tei: "text/xml", enw: "text/plain",
};

const safeName = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Exported Items";

export async function translateExport(db: Database, req: TranslateExportRequest): Promise<TranslateExportResult> {
	if (!req.translatorID || typeof req.translatorID !== "string") throw new HttpError(400, "translatorID is required");
	const { dir: translatorsDir } = translatorsDirFor(db);
	const { listTranslators } = await import("./translators");
	const info = listTranslators(translatorsDir).find((t) => t.translatorID === req.translatorID);
	if (!info || !(info.translatorType & 2)) throw new HttpError(404, "export translator not found");
	const gathered = gatherItems(db, { keys: req.keys, collectionKey: req.collectionKey, format: "ris", includeNotes: !!req.includeNotes });
	const items = gathered.map((g) => {
		const data = g.data as unknown as Record<string, any>;
		const tags = Array.isArray(data.tags) && data.tags.length ? data.tags : g.tags.map((tag) => ({ tag, type: g.autoTags.includes(tag) ? 1 : 0 }));
		const notes = g.noteHtml.map((html) => ({ itemType: "note", note: html }));
		const attachments = [
			...g.links.map((url) => ({ itemType: "attachment", linkMode: "linked_url", url, title: url })),
			...g.files.map((p) => ({ itemType: "attachment", linkMode: "linked_file", title: basename(p), localPath: p, path: p })),
		];
		return { ...data, tags, notes, attachments };
	});
	const out = await job<{ text: string; translator: TranslatorRef }>("export", { translatorsDir, translatorID: req.translatorID, items, displayOptions: req.displayOptions, limits: limits() });
	const ext = (info.target || "txt").toLowerCase();
	let base = "Exported Items";
	if (req.collectionKey && !(req.keys && req.keys.length)) {
		const c = db.query("SELECT name FROM collections WHERE key = ?").get(req.collectionKey) as { name: string } | null;
		if (c) base = safeName(c.name);
	} else if (!(req.keys && req.keys.length)) base = "My Library";
	const filename = `${base}.${ext}`;
	const contentType = `${CONTENT_TYPES[ext] ?? "text/plain"}; charset=utf-8`;
	let path: string | undefined;
	if (req.dir) {
		const d = resolve(req.dir);
		mkdirSync(d, { recursive: true });
		path = join(d, filename);
		writeFileSync(path, out.text);
	}
	return { filename, contentType, text: out.text, count: items.length, path, files: 0 };
}
