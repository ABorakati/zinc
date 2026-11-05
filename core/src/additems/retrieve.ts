// "Retrieve Metadata for PDF": find a DOI / arXiv ID in the first pages (else search Crossref by the likely title),
// create the parent item and move the PDF under it. If the work is already in the library the PDF goes under that item.
import type { Database } from "bun:sqlite";
import type { ItemDetail } from "../api-types";
import { HttpError, getItemDetail } from "../db";
import { extractFulltext } from "../extract";
import { normalizeDoi } from "../references/ids";
import { mailtoFor } from "../references/net";
import { crossrefQuery } from "../references/sources";
import { renameFiles } from "../maintenance/rename-files";
import { addOne, loadKnown } from "./add";
import { reparentItem, storageRoot } from "./files";
import { findArxivId, type ParsedId } from "./identifiers";

export interface RetrieveResult {
	attachmentKey: string;
	status: "retrieved" | "existing" | "failed";
	itemKey?: string;
	/** how the work was identified */
	via?: "doi" | "arxiv" | "title";
	/** the stored file was renamed from the parent's metadata (Zotero's "Rename attachment files using parent metadata") */
	renamed?: boolean;
	error?: string;
}

export interface RetrieveOptions {
	/** Rename the stored file from the parent's metadata afterwards; default true, like Zotero's autoRenameFiles pref. */
	rename?: boolean;
}

export interface RetrieveResponse {
	results: RetrieveResult[];
	items: ItemDetail[];
}

const HEAD_CHARS = 20_000;

export function doiCandidates(text: string): string[] {
	const out: string[] = [];
	const re = /10\.\d{4,9}\/[^\s"<>]+/g;
	const labelled: string[] = [];
	for (let m = re.exec(text); m; m = re.exec(text)) {
		const doi = normalizeDoi(m[0]);
		if (!doi || out.includes(doi) || labelled.includes(doi)) continue;
		const before = text.slice(Math.max(0, m.index - 20), m.index).toLowerCase();
		(/doi/.test(before) ? labelled : out).push(doi);
	}
	return [...labelled, ...out].slice(0, 4);
}

/** First lines that look like a title, joined for a Crossref bibliographic query. */
export function titleGuess(text: string): string {
	const lines = text
		.slice(0, 3000)
		.split(/\r?\n/)
		.map((l) => l.replace(/\s+/g, " ").trim())
		.filter((l) => l.length >= 15 && !/https?:\/\/|www\.|©|^\W*\d+\W*$|^(abstract|keywords?|introduction)\b/i.test(l));
	return lines.slice(0, 3).join(" ").slice(0, 300);
}

async function resolve(db: Database, text: string): Promise<{ id: ParsedId; via: "doi" | "arxiv" | "title" }[]> {
	const out: { id: ParsedId; via: "doi" | "arxiv" | "title" }[] = [];
	for (const doi of doiCandidates(text)) out.push({ id: { kind: "doi", id: doi, raw: doi }, via: "doi" });
	const arx = findArxivId(text);
	if (arx) out.push({ id: { kind: "arxiv", id: arx, raw: arx }, via: "arxiv" });
	return out;
}

export async function retrieveOne(db: Database, attachmentKey: string, known = loadKnown(db), opts: RetrieveOptions = {}): Promise<{ result: RetrieveResult; item?: ItemDetail }> {
	const fail = (error: string): { result: RetrieveResult } => ({ result: { attachmentKey, status: "failed", error } });
	const row = db.query("SELECT i.parent_key, i.deleted, a.content_type, a.path FROM items i JOIN attachments a ON a.item_key = i.key WHERE i.key = ?").get(attachmentKey) as
		| { parent_key: string | null; deleted: number; content_type: string | null; path: string | null }
		| null;
	if (!row) return fail("attachment not found");
	if (row.parent_key) return fail("the attachment already has a parent item");
	if (!/pdf/i.test(row.content_type ?? "") && !/\.pdf$/i.test(row.path ?? "")) return fail("not a PDF");
	if (!row.path) return fail("the attachment has no file");

	try {
		await extractFulltext(db, attachmentKey);
	} catch (e) {
		return fail(`could not read the PDF text: ${e instanceof Error ? e.message : e}`);
	}
	const text = ((db.query("SELECT content FROM fulltext WHERE attachment_key = ?").get(attachmentKey) as { content: string } | null)?.content ?? "").slice(0, HEAD_CHARS);
	if (!text.trim()) return fail("the PDF has no text layer (scanned?)");

	const colls = (db.query("SELECT collection_key FROM collection_items WHERE item_key = ?").all(attachmentKey) as { collection_key: string }[]).map((r) => r.collection_key);
	const candidates = await resolve(db, text);
	const guess = titleGuess(text);
	let lastError = "no DOI, arXiv ID or matching title found in the PDF";

	const tryId = async (p: ParsedId, via: "doi" | "arxiv" | "title") => {
		const r = await addOne(db, p, known, colls[0]);
		const parent = r.added?.data.key ?? r.existing!;
		reparentItem(db, attachmentKey, parent);
		if (r.added) {
			for (const c of colls.slice(1)) db.query("INSERT OR IGNORE INTO collection_items(collection_key, item_key) VALUES(?, ?)").run(c, parent);
		}
		let renamed = false;
		if (opts.rename !== false) {
			try {
				renamed = renameFiles(db, [attachmentKey], storageRoot(db))[0]?.status === "renamed";
			} catch (e) {
				console.error("rename after retrieve failed:", e instanceof Error ? e.message : e);
			}
		}
		return {
			result: { attachmentKey, status: r.added ? ("retrieved" as const) : ("existing" as const), itemKey: parent, via, ...(renamed ? { renamed } : {}) },
			item: getItemDetail(db, parent) ?? undefined,
		};
	};

	for (const c of candidates) {
		try {
			return await tryId(c.id, c.via);
		} catch (e) {
			if (e instanceof HttpError) return fail(e.message);
			lastError = e instanceof Error ? e.message : String(e);
		}
	}
	if (guess) {
		try {
			const hit = await crossrefQuery(guess, mailtoFor(db));
			if (hit?.doi) return await tryId({ kind: "doi", id: hit.doi, raw: hit.doi }, "title");
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
		}
	}
	return fail(lastError);
}

export async function retrieveMetadata(db: Database, attachmentKeys: unknown, opts: RetrieveOptions = {}): Promise<RetrieveResponse> {
	if (!Array.isArray(attachmentKeys) || attachmentKeys.length === 0 || attachmentKeys.some((k) => typeof k !== "string")) {
		throw new HttpError(400, "attachmentKeys must be a non-empty array of strings");
	}
	const known = loadKnown(db);
	const results: RetrieveResult[] = [];
	const items: ItemDetail[] = [];
	for (const key of attachmentKeys as string[]) {
		const { result, item } = await retrieveOne(db, key, known, opts);
		results.push(result);
		if (item && !items.some((i) => i.data.key === item.data.key)) items.push(item);
	}
	return { results, items };
}
