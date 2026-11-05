-- Better BibTeX (native) state. Applied by openDb after websync/schema.sql (see core/src/bbt/keys.ts).
-- Generated citation keys are LOCAL (like BBT's): only pinned keys (items.data citationKey / Extra) sync.
-- The triggers feed two things without any JS in the write path (so every writer is covered: the API, web sync,
-- the local Zotero sync, importers): bbt_dirty (items whose key must be re-checked, drained lazily by keys.ts)
-- and bbt_state.changes (a counter the auto-export scheduler polls).

CREATE TABLE IF NOT EXISTS bbt_keys (
	item_key TEXT PRIMARY KEY REFERENCES items(key) ON DELETE CASCADE,
	key TEXT NOT NULL,
	pinned INTEGER NOT NULL DEFAULT 0,
	formula TEXT NOT NULL DEFAULT '',     -- formula version (hash of formula + key options) a generated key came from
	data_hash TEXT NOT NULL DEFAULT '',   -- hash of the fields that matter, to skip needless regeneration
	updated TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS bbt_keys_key ON bbt_keys(key COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS bbt_dirty (item_key TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS bbt_state (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO bbt_state(name, value) VALUES('changes', 0);
CREATE TABLE IF NOT EXISTS bbt_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS bbt_autoexport (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	path TEXT NOT NULL,
	format TEXT NOT NULL,
	scope_type TEXT NOT NULL,             -- library | collection
	scope_key TEXT,
	trigger TEXT NOT NULL DEFAULT 'change',
	options TEXT NOT NULL DEFAULT '{}',
	status TEXT NOT NULL DEFAULT 'idle',
	error TEXT,
	last_export TEXT,
	count INTEGER,
	hash TEXT
);

-- (ON CONFLICT DO NOTHING, not OR IGNORE: an OR REPLACE / ON CONFLICT clause on the statement that fires a trigger overrides OR IGNORE)
DROP TRIGGER IF EXISTS bbt_dirty_ai;
DROP TRIGGER IF EXISTS bbt_dirty_au;
CREATE TRIGGER IF NOT EXISTS bbt_dirty_ai AFTER INSERT ON items
WHEN NEW.parent_key IS NULL AND NEW.item_type NOT IN ('note', 'attachment', 'annotation')
BEGIN INSERT INTO bbt_dirty(item_key) VALUES(NEW.key) ON CONFLICT(item_key) DO NOTHING; END;
CREATE TRIGGER IF NOT EXISTS bbt_dirty_au AFTER UPDATE OF data, item_type, deleted ON items
WHEN NEW.parent_key IS NULL AND NEW.item_type NOT IN ('note', 'attachment', 'annotation')
BEGIN INSERT INTO bbt_dirty(item_key) VALUES(NEW.key) ON CONFLICT(item_key) DO NOTHING; END;

CREATE TRIGGER IF NOT EXISTS bbt_chg_items_ai AFTER INSERT ON items BEGIN UPDATE bbt_state SET value = value + 1 WHERE name = 'changes'; END;
CREATE TRIGGER IF NOT EXISTS bbt_chg_items_au AFTER UPDATE OF data, deleted, parent_key ON items BEGIN UPDATE bbt_state SET value = value + 1 WHERE name = 'changes'; END;
CREATE TRIGGER IF NOT EXISTS bbt_chg_items_ad AFTER DELETE ON items BEGIN UPDATE bbt_state SET value = value + 1 WHERE name = 'changes'; END;
CREATE TRIGGER IF NOT EXISTS bbt_chg_ci_ai AFTER INSERT ON collection_items BEGIN UPDATE bbt_state SET value = value + 1 WHERE name = 'changes'; END;
CREATE TRIGGER IF NOT EXISTS bbt_chg_ci_ad AFTER DELETE ON collection_items BEGIN UPDATE bbt_state SET value = value + 1 WHERE name = 'changes'; END;
CREATE TRIGGER IF NOT EXISTS bbt_chg_col_au AFTER UPDATE ON collections BEGIN UPDATE bbt_state SET value = value + 1 WHERE name = 'changes'; END;
