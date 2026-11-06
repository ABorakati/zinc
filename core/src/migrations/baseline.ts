// Migration 1: the schema as it stood when versioning began. Idempotent (IF NOT EXISTS throughout), so it is a no-op for a
// library that already has everything, and it also fills in what an older build or the Zotero importer left out.
import type { Database } from "bun:sqlite";
import schema from "../../schema.sql" with { type: "text" };
import syncSchema from "../sync/schema.sql" with { type: "text" };
import websyncSchema from "../websync/schema.sql" with { type: "text" };
import bbtSchema from "../bbt/schema.sql" with { type: "text" };
import type { Migration } from "./types";

// schema.sql also sets PRAGMAs; journal_mode and foreign_keys cannot change inside the runner's transaction, and the runner sets both itself.
const withoutPragmas = (sql: string) => sql.replace(/^PRAGMA .*$/gm, "");

export const baseline: Migration = {
	id: 1,
	name: "baseline",
	reapply: true,
	up(db: Database) {
		db.exec(withoutPragmas(schema));
		db.exec(syncSchema);
		db.exec(websyncSchema);
		db.exec(bbtSchema);
		for (const [name, expr] of [
			["title", "title COLLATE NOCASE"],
			["creator", "creators_summary COLLATE NOCASE"],
			["year", "year"],
			["added", "date_added"],
		]) {
			db.exec(
				`CREATE INDEX IF NOT EXISTS items_top_${name} ON items(${expr}, key) WHERE parent_key IS NULL AND deleted = 0 AND item_type <> 'annotation'`,
			);
		}
	},
};
