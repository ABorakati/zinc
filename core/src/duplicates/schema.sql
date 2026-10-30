-- Duplicate detection exclusions ("Not Duplicates" pairs).
-- Applied lazily by duplicates/detect.ts (ensureDuplicatesSchema), not by openDb.
-- Pairs are stored canonically with key_a < key_b.

CREATE TABLE IF NOT EXISTS duplicate_exclusions (
	key_a TEXT NOT NULL,
	key_b TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
	PRIMARY KEY (key_a, key_b)
);
