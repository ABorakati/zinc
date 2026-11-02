// Find the on-disk PDF of an attachment, read-only. The core API serves file BYTES (GET /api/attachments/:key/file), not a
// path, and the spike wants to open the file in place (zero copies), so the path comes from the library database opened
// read-only (bun:sqlite readonly never takes a write lock and is safe next to the running core). Nothing is modified or moved.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

const DB = process.env.ZN_DB_FILE ?? "C:/Users/abora/zotero-next/data/library.sqlite";

/** "key:ABCD1234" (attachment key) -> its PDF path; anything else is returned as given. */
export function resolvePdf(spec: string): string {
	if (!spec.startsWith("key:")) return spec;
	const key = spec.slice(4);
	const db = new Database(DB, { readonly: true });
	try {
		const row = db.query("SELECT path FROM attachments WHERE item_key = ?").get(key) as { path: string } | null;
		if (!row?.path) throw new Error(`no path for attachment ${key}`);
		if (row.path.startsWith("attachments:")) throw new Error(`attachment ${key} uses a relative path (${row.path}); pass a file path instead`);
		if (!existsSync(row.path)) throw new Error(`file missing: ${row.path}`);
		return row.path;
	} finally { db.close(); }
}
