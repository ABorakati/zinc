-- zotero.org web sync state (contract: core/src/websync/CONTRACT.md). Applied by openDb after sync/schema.sql.
-- The last version the server reported for each object we have seen; a pull skips objects whose remote
-- version is not newer, and a push sends it as the object's `version` for the per-object concurrency check.
CREATE TABLE IF NOT EXISTS websync_versions (
	type TEXT NOT NULL,                 -- item | collection | annotation (same names as sync_outbox)
	key TEXT NOT NULL,
	version INTEGER NOT NULL,
	PRIMARY KEY (type, key)
);
