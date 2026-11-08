// Migration 4: group libraries alongside My Library.
//
// Zotero scopes every object to a library (libraryID per row). Here too: `libraries` lists them (id 1 is My Library, always),
// and items, collections and the sync outbox carry `library_id` (default 1, so every existing row stays in My Library and every
// writer that does not know about libraries keeps working). Purely additive: new table, new columns with a default, new indexes,
// triggers re-created with the same behaviour plus the library. Nothing is rewritten or dropped except the 17 sync triggers and
// the four My Library sort indexes, which are dropped and created again (same columns, now restricted to library 1) inside the
// same transaction. No row is changed.
//
// Keys stay unique across the whole file (items.key and collections.key remain primary keys): every table that points at an
// item does so by key. Zotero keys are 8 random characters, so two libraries colliding is rare but possible; a pull that meets
// a key already used by another library skips that object and says so (core/src/sync/apply.ts).
import type { Database } from "bun:sqlite";
import type { Migration } from "./types";

/** The library an `items` row belongs to, as the sync triggers see it: a child item always follows its parent. */
const itemLib = (row: "NEW" | "OLD") =>
	`CASE WHEN ${row}.parent_key IS NULL THEN ${row}.library_id ELSE coalesce((SELECT p.library_id FROM items p WHERE p.key = ${row}.parent_key), ${row}.library_id) END`;
/** The library of the item a child row (tag, collection membership, attachment) names. */
const ofItem = (keyExpr: string) => `coalesce((SELECT i.library_id FROM items i WHERE i.key = ${keyExpr}), 1)`;

interface Trig {
	name: string;
	/** "AFTER INSERT ON items" ... */
	on: string;
	type: "item" | "collection" | "annotation";
	key: string;
	op: string;
	lib: string;
}

const NOT_SUPPRESSED = "WHEN NOT EXISTS (SELECT 1 FROM sync_flags WHERE name = 'suppress')";

const TRIGGERS: Trig[] = [
	{ name: "sync_items_ai", on: "AFTER INSERT ON items", type: "item", key: "NEW.key", op: "'upsert'", lib: itemLib("NEW") },
	{
		name: "sync_items_au",
		on: "AFTER UPDATE ON items",
		type: "item",
		key: "NEW.key",
		op: "CASE WHEN NEW.deleted = 1 AND OLD.deleted = 0 THEN 'trash' WHEN NEW.deleted = 0 AND OLD.deleted = 1 THEN 'restore' ELSE 'upsert' END",
		lib: itemLib("NEW"),
	},
	{ name: "sync_items_ad", on: "AFTER DELETE ON items", type: "item", key: "OLD.key", op: "'delete'", lib: itemLib("OLD") },
	{ name: "sync_collections_ai", on: "AFTER INSERT ON collections", type: "collection", key: "NEW.key", op: "'upsert'", lib: "NEW.library_id" },
	{ name: "sync_collections_au", on: "AFTER UPDATE ON collections", type: "collection", key: "NEW.key", op: "'upsert'", lib: "NEW.library_id" },
	{ name: "sync_collections_ad", on: "AFTER DELETE ON collections", type: "collection", key: "OLD.key", op: "'delete'", lib: "OLD.library_id" },
	{ name: "sync_collection_items_ai", on: "AFTER INSERT ON collection_items", type: "item", key: "NEW.item_key", op: "'upsert'", lib: ofItem("NEW.item_key") },
	{ name: "sync_collection_items_ad", on: "AFTER DELETE ON collection_items", type: "item", key: "OLD.item_key", op: "'upsert'", lib: ofItem("OLD.item_key") },
	{ name: "sync_item_tags_ai", on: "AFTER INSERT ON item_tags", type: "item", key: "NEW.item_key", op: "'upsert'", lib: ofItem("NEW.item_key") },
	{ name: "sync_item_tags_au", on: "AFTER UPDATE ON item_tags", type: "item", key: "NEW.item_key", op: "'upsert'", lib: ofItem("NEW.item_key") },
	{ name: "sync_item_tags_ad", on: "AFTER DELETE ON item_tags", type: "item", key: "OLD.item_key", op: "'upsert'", lib: ofItem("OLD.item_key") },
	{ name: "sync_attachments_ai", on: "AFTER INSERT ON attachments", type: "item", key: "NEW.item_key", op: "'upsert'", lib: ofItem("NEW.item_key") },
	{ name: "sync_attachments_au", on: "AFTER UPDATE ON attachments", type: "item", key: "NEW.item_key", op: "'upsert'", lib: ofItem("NEW.item_key") },
	{ name: "sync_attachments_ad", on: "AFTER DELETE ON attachments", type: "item", key: "OLD.item_key", op: "'upsert'", lib: ofItem("OLD.item_key") },
	{ name: "sync_annotations_ai", on: "AFTER INSERT ON annotations", type: "annotation", key: "NEW.key", op: "'upsert'", lib: ofItem("NEW.attachment_key") },
	{ name: "sync_annotations_au", on: "AFTER UPDATE ON annotations", type: "annotation", key: "NEW.key", op: "'upsert'", lib: ofItem("NEW.attachment_key") },
	{ name: "sync_annotations_ad", on: "AFTER DELETE ON annotations", type: "annotation", key: "OLD.key", op: "'delete'", lib: ofItem("OLD.attachment_key") },
];

function triggerSql(t: Trig): string {
	return `CREATE TRIGGER ${t.name} ${t.on}
${NOT_SUPPRESSED}
BEGIN
	INSERT INTO sync_outbox(type, key, op, library_id) VALUES('${t.type}', ${t.key}, ${t.op}, ${t.lib})
	ON CONFLICT(type, key, op) DO UPDATE SET seq = (SELECT max(seq) + 1 FROM sync_outbox), at = excluded.at, library_id = excluded.library_id;
END`;
}

export const libraries4: Migration = {
	id: 4,
	name: "group-libraries",
	up(db: Database) {
		db.run(`CREATE TABLE IF NOT EXISTS libraries (
			id INTEGER PRIMARY KEY,                 -- 1 = My Library; a group gets the next free id here (not its zotero.org id)
			type TEXT NOT NULL CHECK (type IN ('user', 'group')),
			group_id INTEGER UNIQUE,                -- the group's id on zotero.org (NULL for My Library)
			name TEXT NOT NULL,
			editable INTEGER NOT NULL DEFAULT 1,    -- 0 = read-only for this user: nothing is pushed and the app refuses edits
			files_editable INTEGER NOT NULL DEFAULT 1,
			web_version INTEGER NOT NULL DEFAULT 0, -- zotero.org library version of the last completed pull
			web_write_version INTEGER NOT NULL DEFAULT 0,
			group_version INTEGER NOT NULL DEFAULT 0, -- version of the group's own record (name, permissions)
			removed INTEGER NOT NULL DEFAULT 0,     -- 1 = no longer in the account's group list: hidden, data kept
			sort INTEGER NOT NULL DEFAULT 0,
			added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
		)`);
		db.run("INSERT OR IGNORE INTO libraries(id, type, name) VALUES(1, 'user', 'My Library')");

		// Re-running (the runner may re-apply a half-recorded library): a column that is already there is left alone.
		const has = (table: string, col: string) => (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
		for (const t of ["items", "collections", "sync_outbox"]) {
			if (!has(t, "library_id")) db.run(`ALTER TABLE ${t} ADD COLUMN library_id INTEGER NOT NULL DEFAULT 1`);
		}
		// A group's rows are found through these; My Library does not need them (its own sort indexes follow).
		db.run("CREATE INDEX IF NOT EXISTS items_by_library ON items(library_id, deleted, parent_key)");
		db.run("CREATE INDEX IF NOT EXISTS collections_by_library ON collections(library_id)");
		db.run("CREATE INDEX IF NOT EXISTS sync_outbox_library ON sync_outbox(library_id, seq)");
		// My Library's sort indexes (baseline.ts) now say `library_id = 1`, so a listing of My Library still walks them in order
		// and a big group never slows it down. db.ts writes `i.library_id = 1` literally to match. Same columns, same order.
		for (const [name, expr] of [
			["title", "title COLLATE NOCASE"],
			["creator", "creators_summary COLLATE NOCASE"],
			["year", "year"],
			["added", "date_added"],
		]) {
			db.run(`DROP INDEX IF EXISTS items_top_${name}`);
			db.run(
				`CREATE INDEX items_top_${name} ON items(${expr}, key) WHERE parent_key IS NULL AND deleted = 0 AND item_type <> 'annotation' AND library_id = 1`,
			);
		}

		// A child item always lives in its parent's library, whoever inserted it.
		db.run("DROP TRIGGER IF EXISTS items_child_library");
		db.run(`CREATE TRIGGER items_child_library AFTER INSERT ON items
			WHEN NEW.parent_key IS NOT NULL AND NEW.library_id IS NOT coalesce((SELECT p.library_id FROM items p WHERE p.key = NEW.parent_key), NEW.library_id)
			BEGIN
				UPDATE items SET library_id = (SELECT p.library_id FROM items p WHERE p.key = NEW.parent_key) WHERE key = NEW.key;
			END`);

		// The outbox now says which library each change is in (and the triggers fill it).
		for (const t of TRIGGERS) db.run(`DROP TRIGGER IF EXISTS ${t.name}`);
		for (const t of TRIGGERS) db.exec(triggerSql(t));
	},
};
