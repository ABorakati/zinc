// Full-text extraction for attachments (PDF/EPUB/HTML) into the fulltext table,
// followed by a search re-index of the parent item.
// Stub until the extraction module lands.
import type { Database } from "bun:sqlite";

export interface ExtractResult {
	attachmentKey: string;
	chars: number;
	pages?: number;
	skipped?: "no-file" | "unsupported" | "already-indexed";
}

export async function extractFulltext(db: Database, attachmentKey: string, opts: { force?: boolean } = {}): Promise<ExtractResult> {
	void db;
	void opts;
	return { attachmentKey, chars: 0, skipped: "unsupported" };
}
