// Full-text extraction for attachments (PDF/HTML) into the fulltext table,
// followed by a search re-index of the parent item. PDFs are processed by Zotero's
// document-worker running in a Bun Worker pool (see pool.ts); failures throw ExtractError.
import type { Database } from "bun:sqlite";
import { extname } from "node:path";
import { resolveStoredPath } from "../files/paths";
import { indexItem, stripHtml } from "../search";
import { ExtractError, extractPdfText } from "./pool";

export { ExtractError, configureExtractPool, shutdownExtractPool } from "./pool";

export interface ExtractResult {
	attachmentKey: string;
	chars: number;
	pages?: number;
	skipped?: "no-file" | "unsupported" | "already-indexed";
}

const MAX_BYTES = 300 * 1024 * 1024;

type Kind = "pdf" | "html";

function kindOf(contentType: string | null, path: string): Kind | null {
	const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
	const ext = extname(path).toLowerCase();
	if (ct === "application/pdf" || (!ct && ext === ".pdf")) return "pdf";
	if (ct === "text/html" || ct === "application/xhtml+xml" || (!ct && [".html", ".htm", ".xhtml"].includes(ext))) return "html";
	return null;
}

export async function extractFulltext(db: Database, attachmentKey: string, opts: { force?: boolean } = {}): Promise<ExtractResult> {
	const row = db.query("SELECT content_type, path FROM attachments WHERE item_key = ?").get(attachmentKey) as {
		content_type: string | null;
		path: string | null;
	} | null;
	const filePath = resolveStoredPath(db, row?.path); // "attachments:<rel>" -> absolute
	if (!row || !filePath) return { attachmentKey, chars: 0, skipped: "no-file" };

	const kind = kindOf(row.content_type, filePath);
	if (!kind) return { attachmentKey, chars: 0, skipped: "unsupported" };

	if (!opts.force && db.query("SELECT 1 FROM fulltext WHERE attachment_key = ?").get(attachmentKey)) {
		return { attachmentKey, chars: 0, skipped: "already-indexed" };
	}

	const file = Bun.file(filePath);
	if (!(await file.exists())) return { attachmentKey, chars: 0, skipped: "no-file" };
	if (file.size > MAX_BYTES) throw new ExtractError("too-large", `${file.size} bytes`);

	let text: string;
	let pages: number | undefined;
	if (kind === "pdf") {
		const res = await extractPdfText(await file.arrayBuffer());
		text = res.text;
		pages = res.pages;
	} else {
		text = stripHtml(await file.text());
	}
	// NUL bytes break FTS tokenising and some SQLite tooling.
	text = text
		.replace(/\0/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.trim();

	db.query(
		`INSERT INTO fulltext(attachment_key, content, source, indexed_at) VALUES(?, ?, 'document-worker', ?)
		 ON CONFLICT(attachment_key) DO UPDATE SET content = excluded.content, source = excluded.source, indexed_at = excluded.indexed_at`,
	).run(attachmentKey, text, new Date().toISOString());
	indexItem(db, attachmentKey);

	return { attachmentKey, chars: text.length, ...(pages != null ? { pages } : {}) };
}
