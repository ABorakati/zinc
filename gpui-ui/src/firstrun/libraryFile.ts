// Is this file a zotero-next library? Used by "Open an existing library…" (first run) and "Change…" (Settings > Files and folders).
// Opened read-only; nothing is written.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export type LibraryFileKind = "zotero-next" | "zotero" | "unknown" | "missing" | "unreadable";

export interface LibraryFileInfo {
	kind: LibraryFileKind;
	/** Top-level items, for a zotero-next library. */
	items?: number;
	/** What to tell the user when kind is not "zotero-next". */
	problem?: string;
}

export function inspectLibraryFile(path: string): LibraryFileInfo {
	if (!existsSync(path)) return { kind: "missing", problem: "That file does not exist." };
	let db: Database | undefined;
	try {
		db = new Database(path, { readonly: true });
		const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
		if (tables.has("items") && tables.has("attachments") && tables.has("collections")) {
			let items: number | undefined;
			try { items = (db.query("SELECT count(*) AS n FROM items WHERE parent_key IS NULL AND deleted = 0").get() as { n: number }).n; } catch { /* count is a nicety */ }
			return { kind: "zotero-next", items };
		}
		if (tables.has("itemTypes") && tables.has("libraries")) {
			return { kind: "zotero", problem: "That is Zotero's own database (zotero.sqlite). Use \"Import from Zotero\" to bring its items into a new zotero-next library." };
		}
		return { kind: "unknown", problem: "That file is not a zotero-next library." };
	} catch (e) {
		return { kind: "unreadable", problem: `That file could not be opened (${e instanceof Error ? e.message : String(e)}).` };
	} finally {
		try { db?.close(true); } catch { /* ignore */ }
	}
}
