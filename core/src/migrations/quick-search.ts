// Migration 3: a trigram index for the toolbar's default search (title, creators, year, citation key).
//
// That search used `LIKE '%term%'` on four columns, which scans every item. FTS5's trigram tokenizer answers the same
// substring question from an index. The index is derived data, so it is kept in step by triggers (like the BBT triggers):
// every writer is covered (the API, web sync, the local Zotero sync, importers, the connector host) without JS in the write path.
//
// quick_search.rowid = items.rowid (the same rule as the `search` table), `b` = "title creators year citation-key".
// Only top-level items are indexed: the list never shows children. Terms under 3 characters cannot use a trigram index;
// db.ts falls back to LIKE for those.
import type { Database } from "bun:sqlite";
import type { Migration } from "./types";

// The searchable text of the items row aliased `i`.
const BLOB = `coalesce(i.title, '') || ' ' || coalesce(i.creators_summary, '') || ' ' || coalesce(CAST(i.year AS TEXT), '') || ' ' || coalesce((SELECT k.key FROM bbt_keys k WHERE k.item_key = i.key), '')`;

// Re-index the one items row `rowidExpr` names: drop its entry, add a fresh one if it is top level.
const refreshItem = (rowidExpr: string) => `
	DELETE FROM quick_search WHERE rowid = ${rowidExpr};
	INSERT INTO quick_search(rowid, b) SELECT i.rowid, ${BLOB} FROM items i WHERE i.rowid = ${rowidExpr} AND i.parent_key IS NULL;`;
const itemOfKey = (keyExpr: string) => `(SELECT rowid FROM items WHERE key = ${keyExpr})`;

const TRIGGERS: Record<string, string> = {
	quick_search_items_ai: `AFTER INSERT ON items BEGIN ${refreshItem("new.rowid")} END`,
	quick_search_items_au: `AFTER UPDATE OF title, creators_summary, year, parent_key ON items BEGIN ${refreshItem("new.rowid")} END`,
	quick_search_items_ad: `AFTER DELETE ON items BEGIN DELETE FROM quick_search WHERE rowid = old.rowid; END`,
	quick_search_bbt_ai: `AFTER INSERT ON bbt_keys BEGIN ${refreshItem(itemOfKey("new.item_key"))} END`,
	quick_search_bbt_au: `AFTER UPDATE OF item_key, key ON bbt_keys BEGIN ${refreshItem(itemOfKey("new.item_key"))} ${refreshItem(itemOfKey("old.item_key"))} END`,
	quick_search_bbt_ad: `AFTER DELETE ON bbt_keys BEGIN ${refreshItem(itemOfKey("old.item_key"))} END`,
};

/** Rebuilds the whole index from items and bbt_keys. Needs the table (migration 3). Safe to run any time; the triggers keep it current. */
export function rebuildQuickIndex(db: Database): void {
	db.run("DELETE FROM quick_search");
	db.run(`INSERT INTO quick_search(rowid, b) SELECT i.rowid, ${BLOB} FROM items i WHERE i.parent_key IS NULL`);
}

export const quickSearch3: Migration = {
	id: 3,
	name: "quick-search-trigram",
	up(db: Database) {
		for (const name of Object.keys(TRIGGERS)) db.run(`DROP TRIGGER IF EXISTS ${name}`);
		db.run("DROP TABLE IF EXISTS quick_search");
		db.run("CREATE VIRTUAL TABLE quick_search USING fts5(b, tokenize = 'trigram')");
		rebuildQuickIndex(db);
		for (const [name, def] of Object.entries(TRIGGERS)) db.exec(`CREATE TRIGGER ${name} ${def}`);
	},
};
