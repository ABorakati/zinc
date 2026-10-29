-- zotero-next library database (contract shared by core/db, the importer and the API).
-- Items are stored as Zotero Web API JSON (the `data` object of an item) so sync with
-- zotero.org and export stay simple. Columns beside `data` are copies for querying.
-- Keys are Zotero's 8-character item/collection keys.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
	name TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
-- meta rows: schema_version = '1'; zotero_import_at = ISO time of last import

CREATE TABLE IF NOT EXISTS items (
	key TEXT PRIMARY KEY,
	item_type TEXT NOT NULL,            -- Zotero itemType, e.g. journalArticle, attachment, note, annotation excluded
	parent_key TEXT REFERENCES items(key) ON DELETE CASCADE, -- set for attachments and child notes
	title TEXT,                         -- title (or note title / attachment title)
	creators_summary TEXT,              -- "Smith", "Smith and Jones", "Smith et al."
	year INTEGER,                       -- parsed from date, NULL if none
	publication TEXT,                   -- publicationTitle / bookTitle / websiteTitle etc.
	data TEXT NOT NULL,                 -- Zotero Web API item JSON (data object), includes tags, collections, creators
	date_added TEXT NOT NULL,           -- ISO 8601 UTC
	date_modified TEXT NOT NULL,        -- ISO 8601 UTC
	version INTEGER NOT NULL DEFAULT 0, -- zotero.org version, 0 if never synced
	deleted INTEGER NOT NULL DEFAULT 0  -- 1 = in trash
);
CREATE INDEX IF NOT EXISTS items_parent ON items(parent_key);
CREATE INDEX IF NOT EXISTS items_type ON items(item_type);
CREATE INDEX IF NOT EXISTS items_added ON items(date_added);

CREATE TABLE IF NOT EXISTS collections (
	key TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	parent_key TEXT REFERENCES collections(key) ON DELETE CASCADE,
	version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS collection_items (
	collection_key TEXT NOT NULL REFERENCES collections(key) ON DELETE CASCADE,
	item_key TEXT NOT NULL REFERENCES items(key) ON DELETE CASCADE,
	PRIMARY KEY (collection_key, item_key)
);
CREATE INDEX IF NOT EXISTS collection_items_item ON collection_items(item_key);

CREATE TABLE IF NOT EXISTS item_tags (
	item_key TEXT NOT NULL REFERENCES items(key) ON DELETE CASCADE,
	tag TEXT NOT NULL,
	type INTEGER NOT NULL DEFAULT 0,    -- 0 manual, 1 automatic (Zotero's convention)
	PRIMARY KEY (item_key, tag)
);
CREATE INDEX IF NOT EXISTS item_tags_tag ON item_tags(tag);

-- One row per attachment item (items.item_type = 'attachment').
CREATE TABLE IF NOT EXISTS attachments (
	item_key TEXT PRIMARY KEY REFERENCES items(key) ON DELETE CASCADE,
	link_mode TEXT NOT NULL,            -- imported_file | imported_url | linked_file | linked_url
	content_type TEXT,                  -- e.g. application/pdf
	path TEXT,                          -- absolute local file path, NULL for linked_url or missing file
	url TEXT                            -- source URL if any
);

-- Reader annotations, stored in the Zotero reader's own JSON shape
-- ({id, type, color, sortIndex, position, text, comment, tags, pageLabel, dateModified, authorName}).
CREATE TABLE IF NOT EXISTS annotations (
	key TEXT PRIMARY KEY,               -- annotation id from the reader (8-char key)
	attachment_key TEXT NOT NULL REFERENCES items(key) ON DELETE CASCADE,
	data TEXT NOT NULL,
	date_modified TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS annotations_attachment ON annotations(attachment_key);

-- Reader view state per attachment (page, scroll, zoom, Reading Mode, ...), reader's JSON.
CREATE TABLE IF NOT EXISTS view_state (
	attachment_key TEXT PRIMARY KEY REFERENCES items(key) ON DELETE CASCADE,
	data TEXT NOT NULL
);

-- Extracted full text per attachment.
CREATE TABLE IF NOT EXISTS fulltext (
	attachment_key TEXT PRIMARY KEY REFERENCES items(key) ON DELETE CASCADE,
	content TEXT NOT NULL,
	source TEXT NOT NULL,               -- 'zotero-cache' | 'document-worker'
	indexed_at TEXT NOT NULL
);

-- Search index: one row per top-level (non-attachment, non-note) item.
-- `fulltext` holds the concatenated full text of the item's attachments.
-- rowid = items.rowid of the top-level item. Rebuilt by core/src/search.ts.
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
	title, creators, abstract, publication, tags, notes, fulltext,
	tokenize = 'porter unicode61 remove_diacritics 2'
);
