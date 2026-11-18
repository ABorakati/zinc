// Migration 5: the change log.
//
// A table fed by triggers on every table a plugin or UI can observe (items, collections, membership, tags, attachments, saved
// searches, annotations, full text). Unlike sync_outbox it is NOT de-duplicated and is NOT suppressed while sync applies remote
// changes (those rows get origin 'sync'), so a reader that remembers a `seq` sees every change after it, in order. Read it with
// GET /api/changes?since=<seq> (core/src/changes/api.ts). Purely additive: two new tables, new triggers, no existing row touched.
//
// origin: 'sync' while sync holds its 'suppress' flag; else the `origin` row of change_ctx (set for the length of one transaction by
// POST /api/batch: "plugin:<id>", "user", ...); else 'unknown'. A `silent` row of change_ctx marks log rows that observers must
// skip (library.apply with skip-notify). A `nolog` row of change_ctx stops logging (bulk derived-data rewrites).
import type { Database } from "bun:sqlite";
import searchSchemaSql from "../searches/schema.sql" with { type: "text" };
import type { Migration } from "./types";

const ORIGIN = `CASE WHEN EXISTS (SELECT 1 FROM sync_flags WHERE name = 'suppress') THEN 'sync' ELSE coalesce((SELECT value FROM change_ctx WHERE name = 'origin'), 'unknown') END`;
const SILENT = `CASE WHEN EXISTS (SELECT 1 FROM change_ctx WHERE name = 'silent') THEN 1 ELSE 0 END`;
const LOGGING = `WHEN NOT EXISTS (SELECT 1 FROM change_ctx WHERE name = 'nolog')`;

const itemLib = (row: "NEW" | "OLD") =>
	`CASE WHEN ${row}.parent_key IS NULL THEN ${row}.library_id ELSE coalesce((SELECT p.library_id FROM items p WHERE p.key = ${row}.parent_key), ${row}.library_id) END`;
const ofItem = (k: string) => `coalesce((SELECT i.library_id FROM items i WHERE i.key = ${k}), 1)`;

interface Trig {
	name: string;
	on: string;
	object: string;
	kind: string;
	key: string;
	lib: string;
	when?: string;
}

const TRIGGERS: Trig[] = [
	{ name: "chg_items_ai", on: "AFTER INSERT ON items", object: "item", kind: "'add'", key: "NEW.key", lib: itemLib("NEW") },
	{
		name: "chg_items_au",
		on: "AFTER UPDATE ON items",
		object: "item",
		kind: "CASE WHEN NEW.deleted = 1 AND OLD.deleted = 0 THEN 'trash' WHEN NEW.deleted = 0 AND OLD.deleted = 1 THEN 'restore' ELSE 'modify' END",
		key: "NEW.key",
		lib: itemLib("NEW"),
	},
	{ name: "chg_items_ad", on: "AFTER DELETE ON items", object: "item", kind: "'delete'", key: "OLD.key", lib: itemLib("OLD") },
	{ name: "chg_coll_ai", on: "AFTER INSERT ON collections", object: "collection", kind: "'add'", key: "NEW.key", lib: "NEW.library_id" },
	{ name: "chg_coll_au", on: "AFTER UPDATE ON collections", object: "collection", kind: "'modify'", key: "NEW.key", lib: "NEW.library_id" },
	{ name: "chg_coll_ad", on: "AFTER DELETE ON collections", object: "collection", kind: "'delete'", key: "OLD.key", lib: "OLD.library_id" },
	{
		name: "chg_collitems_ai",
		on: "AFTER INSERT ON collection_items",
		object: "collection-item",
		kind: "'add'",
		key: "NEW.collection_key || '-' || NEW.item_key",
		lib: ofItem("NEW.item_key"),
	},
	{
		name: "chg_collitems_ad",
		on: "AFTER DELETE ON collection_items",
		object: "collection-item",
		kind: "'remove'",
		key: "OLD.collection_key || '-' || OLD.item_key",
		lib: ofItem("OLD.item_key"),
	},
	{
		name: "chg_tags_ai",
		on: "AFTER INSERT ON item_tags",
		object: "item-tag",
		kind: "'add'",
		key: "NEW.item_key || '-' || NEW.tag",
		lib: ofItem("NEW.item_key"),
	},
	{
		name: "chg_tags_au",
		on: "AFTER UPDATE ON item_tags",
		object: "item-tag",
		kind: "'modify'",
		key: "NEW.item_key || '-' || NEW.tag",
		lib: ofItem("NEW.item_key"),
	},
	{
		name: "chg_tags_ad",
		on: "AFTER DELETE ON item_tags",
		object: "item-tag",
		kind: "'remove'",
		key: "OLD.item_key || '-' || OLD.tag",
		lib: ofItem("OLD.item_key"),
	},
	{ name: "chg_att_ai", on: "AFTER INSERT ON attachments", object: "file", kind: "'add'", key: "NEW.item_key", lib: ofItem("NEW.item_key") },
	{ name: "chg_att_au", on: "AFTER UPDATE ON attachments", object: "file", kind: "'modify'", key: "NEW.item_key", lib: ofItem("NEW.item_key") },
	{ name: "chg_att_ad", on: "AFTER DELETE ON attachments", object: "file", kind: "'delete'", key: "OLD.item_key", lib: ofItem("OLD.item_key") },
	{ name: "chg_search_ai", on: "AFTER INSERT ON saved_searches", object: "search", kind: "'add'", key: "NEW.key", lib: "1" },
	{ name: "chg_search_au", on: "AFTER UPDATE ON saved_searches", object: "search", kind: "'modify'", key: "NEW.key", lib: "1" },
	{ name: "chg_search_ad", on: "AFTER DELETE ON saved_searches", object: "search", kind: "'delete'", key: "OLD.key", lib: "1" },
	{
		name: "chg_ann_ai",
		on: "AFTER INSERT ON annotations",
		object: "annotation",
		kind: "'add'",
		key: "NEW.key",
		lib: ofItem("NEW.attachment_key"),
	},
	{
		name: "chg_ann_au",
		on: "AFTER UPDATE ON annotations",
		object: "annotation",
		kind: "'modify'",
		key: "NEW.key",
		lib: ofItem("NEW.attachment_key"),
	},
	{
		name: "chg_ann_ad",
		on: "AFTER DELETE ON annotations",
		object: "annotation",
		kind: "'delete'",
		key: "OLD.key",
		lib: ofItem("OLD.attachment_key"),
	},
	// full-text index changes: Zotero's "index" event, ids are attachment keys
	{ name: "chg_ft_ai", on: "AFTER INSERT ON fulltext", object: "item", kind: "'index'", key: "NEW.attachment_key", lib: ofItem("NEW.attachment_key") },
	{ name: "chg_ft_au", on: "AFTER UPDATE ON fulltext", object: "item", kind: "'index'", key: "NEW.attachment_key", lib: ofItem("NEW.attachment_key") },
];

function triggerSql(t: Trig): string {
	return `CREATE TRIGGER IF NOT EXISTS ${t.name} ${t.on}
${LOGGING}
BEGIN
	INSERT INTO change_log(object, kind, key, library_id, origin, silent) VALUES('${t.object}', ${t.kind}, ${t.key}, ${t.lib}, ${ORIGIN}, ${SILENT});
END`;
}

export const changeLog5: Migration = {
	id: 5,
	name: "change-log",
	up(db: Database) {
		db.exec(`CREATE TABLE IF NOT EXISTS change_log (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
			object TEXT NOT NULL,      -- item | collection | collection-item | item-tag | file | search | annotation
			kind TEXT NOT NULL,        -- add | modify | delete | remove | trash | restore | index
			key TEXT NOT NULL,         -- collection-item: "<collection>-<item>", item-tag: "<item>-<tag>"
			library_id INTEGER,
			origin TEXT NOT NULL DEFAULT 'unknown',
			silent INTEGER NOT NULL DEFAULT 0
		)`);
		db.exec("CREATE TABLE IF NOT EXISTS change_ctx (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
		// saved_searches is otherwise created on first use (searches/store.ts); its triggers need it now. Same DDL, IF NOT EXISTS.
		db.exec(searchSchemaSql);
		for (const t of TRIGGERS) db.exec(triggerSql(t));
	},
};
