-- Saved searches + the few indexes that advanced search leans on.
-- Applied lazily by searches/store.ts (ensureSearchSchema), not by openDb.

CREATE TABLE IF NOT EXISTS saved_searches (
	key TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	conditions TEXT NOT NULL,           -- JSON: [{field, operator, value}]
	options TEXT NOT NULL,              -- JSON: {match, includeParentsAndChildren, searchSubcollections, topLevelOnly, includeTrash}
	date_modified TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS items_modified ON items(date_modified);
CREATE INDEX IF NOT EXISTS items_children ON items(parent_key, item_type) WHERE parent_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS attachments_content_type ON attachments(content_type);
