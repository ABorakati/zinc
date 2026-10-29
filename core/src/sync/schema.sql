-- zotero-next <-> Zotero sync state (contract: core/src/sync/protocol.ts). Applied by openDb after schema.sql.
-- The triggers record every local change in sync_outbox so a later push can write it into Zotero.
-- Rows are deduplicated per (type, key, op): the upsert moves the entry to a fresh seq (not INSERT OR REPLACE:
-- an ON CONFLICT clause on the statement that fires the trigger overrides it), so a
-- change made while a push is in flight survives the push's "delete seq <= snapshot" cleanup.
-- While sync applies Zotero's changes it holds a 'suppress' row in sync_flags (inside its own
-- transaction), which makes every trigger a no-op.

CREATE TABLE IF NOT EXISTS sync_outbox (
	seq INTEGER PRIMARY KEY,
	type TEXT NOT NULL,                 -- item | collection | annotation
	key TEXT NOT NULL,
	op TEXT NOT NULL,                   -- upsert | trash | restore | delete
	at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	UNIQUE (type, key, op)
);
CREATE INDEX IF NOT EXISTS sync_outbox_key ON sync_outbox(type, key);

CREATE TABLE IF NOT EXISTS sync_flags (name TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS sync_state (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_base (
	type TEXT NOT NULL,
	key TEXT NOT NULL,
	date_modified TEXT NOT NULL,
	PRIMARY KEY (type, key)
);
CREATE TABLE IF NOT EXISTS sync_conflicts (
	id INTEGER PRIMARY KEY,
	type TEXT NOT NULL,
	key TEXT NOT NULL,
	local TEXT,                         -- JSON of the local version (NULL: did not exist)
	remote TEXT,                        -- JSON of Zotero's version (NULL: erased in Zotero)
	resolved TEXT NOT NULL,             -- which side won: 'local' | 'remote'
	at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- items
CREATE TRIGGER IF NOT EXISTS sync_items_ai AFTER INSERT ON items
WHEN NOT EXISTS (SELECT 1 FROM sync_flags WHERE name = 'suppress')
BEGIN
	INSERT INTO sync_outbox(type, key, op) VALUES('item', NEW.key, 'upsert')
	ON CONFLICT(type, key, op) DO UPDATE SET seq = (SELECT max(seq) + 1 FROM sync_outbox), at = excluded.at;
END;
CREATE TRIGGER IF NOT EXISTS sync_items_au AFTER UPDATE ON items
WHEN NOT EXISTS (SELECT 1 FROM sync_flags WHERE name = 'suppress')
BEGIN
	INSERT INTO sync_outbox(type, key, op) VALUES('item', NEW.key,
		CASE WHEN NEW.deleted = 1 AND OLD.deleted = 0 THEN 'trash'
		     WHEN NEW.deleted = 0 AND OLD.deleted = 1 THEN 'restore'
		     ELSE 'upsert' END)
	ON CONFLICT(type, key, op) DO UPDATE SET seq = (SELECT max(seq) + 1 FROM sync_outbox), at = excluded.at;
END;
CREATE TRIGGER IF NOT EXISTS sync_items_ad AFTER DELETE ON items
WHEN NOT EXISTS (SELECT 1 FROM sync_flags WHERE name = 'suppress')
BEGIN
	INSERT INTO sync_outbox(type, key, op) VALUES('item', OLD.key, 'delete')
	ON CONFLICT(type, key, op) DO UPDATE SET seq = (SELECT max(seq) + 1 FROM sync_outbox), at = excluded.at;
END;

-- collections
CREATE TRIGGER IF NOT EXISTS sync_collections_ai AFTER INSERT ON collections
WHEN NOT EXISTS (SELECT 1 FROM sync_flags WHERE name = 'suppress')
BEGIN
	INSERT INTO sync_outbox(type, key, op) VALUES('collection', NEW.key, 'upsert')
	ON CONFLICT(type, key, op) DO UPDATE SET seq = (SELECT max(seq) + 1 FROM sync_outbox), at = excluded.at;
END;
CREATE TRIGGER IF NOT EXISTS sync_collections_au AFTER UPDATE ON collections
WHEN NOT EXISTS (SELECT 1 FROM sync_flags WHERE name = 'suppress')
BEGIN
	INSERT INTO sync_outbox(type, key, op) VALUES('collection', NEW.key, 'upsert')
	ON CONFLICT(type, key, op) DO UPDATE SET seq = (SELECT max(seq) + 1 FROM sync_outbox), at = excluded.at;
END;
CREATE TRIGGER IF NOT EXISTS sync_collections_ad AFTER DELETE ON collections
WHEN NOT EXISTS (SELECT 1 FROM sync_flags WHERE name = 'suppress')
BEGIN
	INSERT INTO sync_outbox(type, key, op) VALUES('collection', OLD.key, 'delete')
	ON CONFLICT(type, key, op) DO UPDATE SET seq = (SELECT max(seq) + 1 FROM sync_outbox), at = excluded.at;
END;

-- collection membership and tags live in the item's JSON in Zotero: they dirty the item
CREATE TRIGGER IF NOT EXISTS sync_collection_items_ai AFTER INSERT ON collection_items
WHEN NOT EXISTS (SELECT 1 FROM sync_flags WHERE name = 'suppress')
BEGIN
	INSERT INTO sync_outbox(type, key, op) VALUES('item', NEW.item_key, 'upsert')
	ON CONFLICT(type, key, op) DO UPDATE SET seq = (SELECT max(seq) + 1 FROM sync_outbox), at = excluded.at;
END;
CREATE TRIGGER IF NOT EXISTS sync_collection_items_ad AFTER DELETE ON collection_items
WHEN NOT EXISTS (SELECT 1 FROM sync_flags WHERE name = 'suppress')
BEGIN
	INSERT INTO sync_outbox(type, key, op) VALUES('item', OLD.item_key, 'upsert')
	ON CONFLICT(type, key, op) DO UPDATE SET seq = (SELECT max(seq) + 1 FROM sync_outbox), at = excluded.at;
END;

CREATE TRIGGER IF NOT EXISTS sync_item_tags_ai AFTER INSERT ON item_tags
WHEN NOT EXISTS (SELECT 1 FROM sync_flags WHERE name = 'suppress')
BEGIN
	INSERT INTO sync_outbox(type, key, op) VALUES('item', NEW.item_key, 'upsert')
	ON CONFLICT(type, key, op) DO UPDATE SET seq = (SELECT max(seq) + 1 FROM sync_outbox), at = excluded.at;
END;
CREATE TRIGGER IF NOT EXISTS sync_item_tags_au AFTER UPDATE ON item_tags
WHEN NOT EXISTS (SELECT 1 FROM sync_flags WHERE name = 'suppress')
BEGIN
	INSERT INTO sync_outbox(type, key, op) VALUES('item', NEW.item_key, 'upsert')
	ON CONFLICT(type, key, op) DO UPDATE SET seq = (SELECT max(seq) + 1 FROM sync_outbox), at = excluded.at;
END;
CREATE TRIGGER IF NOT EXISTS sync_item_tags_ad AFTER DELETE ON item_tags
WHEN NOT EXISTS (SELECT 1 FROM sync_flags WHERE name = 'suppress')
BEGIN
	INSERT INTO sync_outbox(type, key, op) VALUES('item', OLD.item_key, 'upsert')
	ON CONFLICT(type, key, op) DO UPDATE SET seq = (SELECT max(seq) + 1 FROM sync_outbox), at = excluded.at;
END;

-- attachments: the row is part of the attachment item (link mode, content type, file path)
CREATE TRIGGER IF NOT EXISTS sync_attachments_ai AFTER INSERT ON attachments
WHEN NOT EXISTS (SELECT 1 FROM sync_flags WHERE name = 'suppress')
BEGIN
	INSERT INTO sync_outbox(type, key, op) VALUES('item', NEW.item_key, 'upsert')
	ON CONFLICT(type, key, op) DO UPDATE SET seq = (SELECT max(seq) + 1 FROM sync_outbox), at = excluded.at;
END;
CREATE TRIGGER IF NOT EXISTS sync_attachments_au AFTER UPDATE ON attachments
WHEN NOT EXISTS (SELECT 1 FROM sync_flags WHERE name = 'suppress')
BEGIN
	INSERT INTO sync_outbox(type, key, op) VALUES('item', NEW.item_key, 'upsert')
	ON CONFLICT(type, key, op) DO UPDATE SET seq = (SELECT max(seq) + 1 FROM sync_outbox), at = excluded.at;
END;
CREATE TRIGGER IF NOT EXISTS sync_attachments_ad AFTER DELETE ON attachments
WHEN NOT EXISTS (SELECT 1 FROM sync_flags WHERE name = 'suppress')
BEGIN
	INSERT INTO sync_outbox(type, key, op) VALUES('item', OLD.item_key, 'upsert')
	ON CONFLICT(type, key, op) DO UPDATE SET seq = (SELECT max(seq) + 1 FROM sync_outbox), at = excluded.at;
END;

-- annotations
CREATE TRIGGER IF NOT EXISTS sync_annotations_ai AFTER INSERT ON annotations
WHEN NOT EXISTS (SELECT 1 FROM sync_flags WHERE name = 'suppress')
BEGIN
	INSERT INTO sync_outbox(type, key, op) VALUES('annotation', NEW.key, 'upsert')
	ON CONFLICT(type, key, op) DO UPDATE SET seq = (SELECT max(seq) + 1 FROM sync_outbox), at = excluded.at;
END;
CREATE TRIGGER IF NOT EXISTS sync_annotations_au AFTER UPDATE ON annotations
WHEN NOT EXISTS (SELECT 1 FROM sync_flags WHERE name = 'suppress')
BEGIN
	INSERT INTO sync_outbox(type, key, op) VALUES('annotation', NEW.key, 'upsert')
	ON CONFLICT(type, key, op) DO UPDATE SET seq = (SELECT max(seq) + 1 FROM sync_outbox), at = excluded.at;
END;
CREATE TRIGGER IF NOT EXISTS sync_annotations_ad AFTER DELETE ON annotations
WHEN NOT EXISTS (SELECT 1 FROM sync_flags WHERE name = 'suppress')
BEGIN
	INSERT INTO sync_outbox(type, key, op) VALUES('annotation', OLD.key, 'delete')
	ON CONFLICT(type, key, op) DO UPDATE SET seq = (SELECT max(seq) + 1 FROM sync_outbox), at = excluded.at;
END;
