// Migration 2 (and the helper for later venue-rule changes): recompute items.publication from the venue rule in core/src/venue.ts.
import type { Database } from "bun:sqlite";
import { venueOf } from "../venue";
import type { Migration } from "./types";

/**
 * Recomputes items.publication (a derived copy of the card's venue line, so no item data changes) for every regular item.
 * The sync 'suppress' flag is held meanwhile, so nothing is queued for Zotero or zotero.org. Runs inside the runner's
 * transaction. When venueOf changes, add a migration that calls this.
 */
export function recomputeVenues(db: Database): void {
	db.run("INSERT OR IGNORE INTO sync_flags(name) VALUES('suppress')");
	const upd = db.query("UPDATE items SET publication = ? WHERE key = ?");
	for (const r of db
		.query("SELECT key, item_type, publication, data FROM items WHERE item_type NOT IN ('note', 'attachment', 'annotation')")
		.all() as { key: string; item_type: string; publication: string | null; data: string }[]) {
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(r.data);
		} catch {
			continue;
		}
		const v = venueOf(data, r.item_type);
		if (v !== r.publication) upd.run(v, r.key);
	}
	db.run("DELETE FROM sync_flags WHERE name = 'suppress'");
}

/** Before versioned migrations this was a one-off guarded by meta venue_version; a library that already ran rule 2 skips the work. */
export const venues2: Migration = {
	id: 2,
	name: "recompute-venues",
	up(db: Database) {
		const cur = db.query("SELECT value FROM meta WHERE name = 'venue_version'").get() as { value: string } | null;
		if (cur?.value !== "2") recomputeVenues(db);
		db.run("INSERT INTO meta(name, value) VALUES('venue_version', '2') ON CONFLICT(name) DO UPDATE SET value = excluded.value");
	},
};
