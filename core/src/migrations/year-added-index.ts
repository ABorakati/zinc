// Migration 6: composite partial index for the default list sort (year, dateAdded).
//
// The library lists default to sorting by year then dateAdded (both in the same direction). With only single-column partial indexes
// (`items_top_year`, `items_top_added`), SQLite falls back to `USE TEMP B-TREE FOR ORDER BY` over every top-level item on every page
// request. This index lets SQLite walk rows in `(year, date_added, key)` order directly in both ASC and DESC directions.
import type { Database } from "bun:sqlite";
import type { Migration } from "./types";

export const yearAddedIndex6: Migration = {
	id: 6,
	name: "year-added-index",
	up(db: Database) {
		db.run(
			"CREATE INDEX IF NOT EXISTS items_top_year_added ON items(year, date_added, key) WHERE parent_key IS NULL AND deleted = 0 AND item_type <> 'annotation' AND library_id = 1",
		);
	},
};
