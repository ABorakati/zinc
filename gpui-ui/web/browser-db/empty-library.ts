// Empties the browser library after it was moved into the Zinc app (POST /api/browser/empty {confirm: true}, routed by import-run.ts).
//
// Only the connector calls it, and only after the app's host answered 200 to importBrowserLibrary (connector-host/src/import-browser.ts).
// What goes: every item, collection, tag, note, annotation and full-text row, the attachment files, and the search index. What does not
// go to zotero.org: the delete is not an edit to send. The sync triggers are held off (the same `suppress` flag a pull uses), the outbox
// is cleared, and zotero.org sync of this browser is switched off and its API key removed. The app's library is the one library of this
// computer now; if the browser kept syncing, an account's whole library would flow back into it.
import type { Database as CoreDb } from "bun:sqlite";
import { rmSync } from "node:fs";

const STORAGE_ROOT = "/opfs/zinc/storage";

export interface EmptyResult {
	items: number;
	collections: number;
	files: boolean;
	signedOut: boolean;
}

const hasTable = (d: CoreDb, t: string): boolean => !!d.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

export async function emptyBrowserLibrary(db: CoreDb): Promise<EmptyResult> {
	const one = (sql: string) => (db.query(sql).get() as { n: number }).n;
	const before = { items: one("SELECT count(*) AS n FROM items"), collections: one("SELECT count(*) AS n FROM collections") };

	// zotero.org sync first: stop it, so it cannot pull while the rows are going
	let signedOut = false;
	try {
		const { getWebSync, stopWebSyncService } = await import("../../../core/src/websync/api");
		const { setSyncMode } = await import("../../../core/src/websync/state");
		await stopWebSyncService(db).catch(() => {});
		setSyncMode(db, "off");
		await getWebSync(db).clearKey();
		signedOut = true;
	} catch (e) {
		console.error("[browser-db] could not sign out of zotero.org while emptying:", e instanceof Error ? e.message : e);
	}

	db.transaction(() => {
		db.exec("PRAGMA defer_foreign_keys = ON");
		const flagged = hasTable(db, "sync_flags");
		if (flagged) db.exec("INSERT OR IGNORE INTO sync_flags(name) VALUES('suppress')");
		try {
			// children first, then the rows they point at (foreign keys cascade, but the lists below are explicit about what goes)
			for (const t of [
				"annotations",
				"fulltext",
				"view_state",
				"item_tags",
				"collection_items",
				"attachments",
				"duplicate_exclusions",
				"saved_searches",
				"bbt_keys",
				"websync_versions",
				"sync_outbox",
				"sync_base",
				"sync_conflicts",
			]) {
				if (hasTable(db, t)) db.run(`DELETE FROM "${t}"`);
			}
			db.run("DELETE FROM items WHERE parent_key IS NOT NULL");
			db.run("DELETE FROM items");
			db.run("DELETE FROM collections WHERE parent_key IS NOT NULL");
			db.run("DELETE FROM collections");
			if (hasTable(db, "search")) db.run("DELETE FROM search");
			if (hasTable(db, "quick_search")) db.run("DELETE FROM quick_search");
		} finally {
			if (flagged) db.exec("DELETE FROM sync_flags WHERE name = 'suppress'");
		}
	})();
	// the triggers that keep quick_search up to date have run for the deletes above; rebuild it from nothing to be sure it is empty
	try {
		const { rebuildSearchIndex } = await import("../../../core/src/search");
		rebuildSearchIndex(db);
	} catch {
		/* the index is rebuilt by the next import or save */
	}

	let files = false;
	try {
		rmSync(STORAGE_ROOT);
		files = true;
	} catch {
		/* no files */
	}
	return { ...before, files, signedOut };
}
