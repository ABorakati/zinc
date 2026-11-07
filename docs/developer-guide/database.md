# The SQLite library and migrations

All user data lives in one SQLite file, opened by `openDb(path)` in `core/src/db.ts`. This page covers where the file is, what is in it, how sync changes are recorded, and how to change the schema.

## Where the library is

`core/src/library-location.ts` is the single rule. The app, the connector host (read-only, it never adopts a legacy path) and the Word add-in (`word/addin/Settings.cs` mirrors it in C#) all use it. Nothing in the rule names a user. The order in `resolveLibrary()` is:

1. `ZN_DB`, then `ZN_LIBRARY` (environment).
2. The saved setting: `%APPDATA%\zotero-next-gpui\library.json`, `{"path": "<library.sqlite>"}`.
3. The legacy location `<home>\zotero-next\data\library.sqlite`, if it exists. It is adopted: written to the saved setting, so the library keeps opening from there.
4. The default `%APPDATA%\zotero-next\library.sqlite`, if it exists.
5. Nothing found: `path` is null and the app shows the first-run screen (`gpui-ui/src/firstrun/`). A new library goes to the default path, or `library-2.sqlite`, `library-3.sqlite` and so on beside it when the name is taken; an existing file is never overwritten.

`isRealLibrary(path)` is true for the saved, legacy and default paths. The in-process core refuses them unless `ZN_ALLOW_REAL_DB=1`, so a development run does not open your real library by accident. Use a copy:

```
bun -e 'import {Database} from "bun:sqlite"; new Database("src.sqlite",{readonly:true}).run("VACUUM INTO \"copy.sqlite\"")'
```

Files next to the database file:

| File or folder | Purpose |
| --- | --- |
| `storage/<KEY>/` | Imported attachment files (for example a PDF saved by Find Full Text) |
| `translators/` | A translators folder written by `update-translators.ts`; see [Translators](translators.md) |
| `library.backup-v<from>-to-v<to>-<time>.sqlite` | Pre-upgrade backups (below) |
| `library.backup-gpui-<date>.sqlite` | One backup made by the packaged app before it first writes to a library (skipped if one exists) |
| `connector-host-state.json` | Connector-host state: the last chosen collection and in-flight save sessions |

The app's own small state files (`library.json`, `ui-state.json`, `startup.json`, `prefetch-hint.json`) and logs live in `%APPDATA%\zotero-next-gpui\`, not beside the library.

## Connection settings

`openDb` runs the migrations (below), then sets `synchronous = NORMAL`, `busy_timeout = 5000`, `foreign_keys = ON`, `cache_size = -65536`, `temp_store = MEMORY` and `mmap_size = 268435456`. The journal mode is WAL (the migration runner sets it before it starts). WAL plus the busy timeout is what lets several programs share the file: the app, the MCP stdio server (`core/scripts/mcp-stdio.ts`), the connector host and the read-only Word add-in. Read-only connections, such as the prefetch worker's, never migrate and set `query_only`.

## Schema

`core/schema.sql` defines the base tables. Items are stored as Zotero Web API JSON in `items.data`; the other columns are copies for querying. Keys are Zotero's 8-character keys.

| Table | Content |
| --- | --- |
| `meta` | Name/value rows: `schema_version`, `zotero_import_at`, `venue_version` |
| `items` | One row per item (regular, attachment, note); `parent_key`, `title`, `creators_summary`, `year`, `publication`, `data`, dates, `version`, `deleted` (1 = trash) |
| `collections`, `collection_items` | Collection tree and membership |
| `item_tags` | Tags (`type` 0 manual, 1 automatic) |
| `attachments` | One row per attachment item: link mode, content type, path, URL |
| `annotations`, `view_state` | Reader annotations and per-attachment view state, in the reader's own JSON shape |
| `fulltext` | Extracted text per attachment |
| `search` | FTS5 index (porter, unicode61) over title, creators, abstract, publication, tags, notes and full text; rebuilt by `core/src/search.ts` |
| `quick_search` | FTS5 trigram index (migration 3) over title, creators, year and citation key of top-level items, for the toolbar search box. `rowid` = `items.rowid`. Triggers on `items` and `bbt_keys` keep it current; terms under 3 characters fall back to `LIKE`. `rebuildSearchIndex` rebuilds it |

Further schema files are applied by the baseline migration: `core/src/sync/schema.sql` (sync state and outbox), `core/src/websync/schema.sql` (zotero.org sync) and `core/src/bbt/schema.sql` (Better BibTeX). `core/src/searches/schema.sql` (saved searches) and the duplicates tables are applied lazily by their modules.

## The sync outbox and triggers

`core/src/sync/schema.sql` creates triggers (after insert, update and delete, as applicable) on `items`, `collections`, `collection_items`, `item_tags`, `attachments` and `annotations` that record every local change in `sync_outbox`. A row is `(seq, type, key, op, at)` with `type` one of item, collection, annotation and `op` one of upsert, trash, restore, delete. Rows are deduplicated per `(type, key, op)`: an upsert moves the entry to a fresh `seq`, so a change made while a push is in flight survives the push's "delete everything up to the snapshot" cleanup.

The triggers are skipped while `sync_flags` holds a `suppress` row. Sync sets it inside its own transaction while it applies remote changes, and any migration or bulk job that rewrites data the user did not change must do the same, or every row would be queued for upload. Other sync tables: `sync_state`, `sync_base` (last known modification time per key) and `sync_conflicts`.

Exactly one sync route runs per library; `sync_state` records which (`zotero-local`, `zotero-org` or `off`).

## Migrations

The code is `core/src/migrations/`: `index.ts` (the runner), `list.ts` (the ordered list), `types.ts`, `baseline.ts` (migration 1) and one file per later migration (`venues.ts` is migration 2, `quick-search.ts` is migration 3). `meta.schema_version` holds the id of the last migration applied. `SCHEMA_HEAD` is the id of the last migration in the list.

What `migrate(db, path)` does:

- Reads `schema_version` (0 means a new, empty file). If it is newer than `SCHEMA_HEAD`, it throws `LibraryTooNewError` and changes nothing; the app must be updated to open that library.
- If the library is already current, it returns without touching the file.
- Otherwise, for an existing library that has items, it first makes a backup with `VACUUM INTO library.backup-v<from>-to-v<to>-<time>.sqlite` next to the database and keeps the newest three such files. Other backups are never touched. If the backup cannot be made, nothing is upgraded.
- Then, in one `BEGIN IMMEDIATE` transaction with foreign keys switched off, it runs every pending migration in order, recording `schema_version` after each, then runs `PRAGMA integrity_check` and `PRAGMA foreign_key_check` (new violations count) and commits.
- Any throw or failed check rolls everything back and raises `MigrationError`, whose message names the failing migration and the backup. The file is unchanged.

Only `openDb` migrates. Another process may migrate while you wait for the write lock; the runner re-reads the version after taking it.

## How to add a migration

1. Create `core/src/migrations/<name>.ts` exporting a `Migration`: `{ id, name, up(db) }`. The `id` is the next number after the last entry in `MIGRATIONS` (1, 2, 3 with no gaps; the runner rejects a gap). `name` is a short kebab-case label used in error messages.
2. Append it to `MIGRATIONS` in `core/src/migrations/list.ts`.
3. In `up(db)` use plain `db.run`, `db.exec` and `db.query`. Do not `BEGIN`, `COMMIT` or call `db.transaction()`; the runner owns the transaction. To change a table's shape, create the new table, copy, drop the old one and rename it; foreign keys are off during the run and checked afterwards.
4. Do not change tables or indexes in the `*.sql` files to make the change. They are the version 1 baseline; express the change as a migration so existing libraries get it too.
5. If a rule that fills a derived column changes (for example `core/src/venue.ts`), add a migration that recomputes the column. `recomputeVenues` in `venues.ts` is the model.
6. Never edit, reorder or delete a migration that has been released.
7. Add a test (below).

A hypothetical migration that adds an index (the name and id are illustrative):

```ts
// core/src/migrations/attachmentUrlIndex.ts
import type { Database } from "bun:sqlite";
import type { Migration } from "./types";

export const attachmentUrlIndex: Migration = {
	id: 3,
	name: "attachment-url-index",
	up(db: Database) {
		db.run("CREATE INDEX IF NOT EXISTS attachments_url ON attachments(url)");
	},
};
```

```ts
// core/src/migrations/list.ts
import { baseline } from "./baseline";
import { venues2 } from "./venues";
import { attachmentUrlIndex } from "./attachmentUrlIndex";
import type { Migration } from "./types";

export const MIGRATIONS: readonly Migration[] = [baseline, venues2, attachmentUrlIndex];
```

A migration that rewrites data follows `venues.ts`: hold the `suppress` flag so the outbox stays empty, change the rows, then release it.

```ts
up(db: Database) {
	db.run("INSERT OR IGNORE INTO sync_flags(name) VALUES('suppress')");
	// ... UPDATE the derived column for every affected row ...
	db.run("DELETE FROM sync_flags WHERE name = 'suppress'");
},
```

Make the data step safe to run twice (for example by checking a `meta` row, as migration 2 does with `venue_version`), because a library from an older build may have run the change before versioning existed.

### Tests

`core/test/migrations.test.ts` covers the runner: the list is 1..n, a fresh library is created at the head with no backup, an old library is upgraded with a backup, only the last three backups are kept, a throwing migration or a new foreign-key violation rolls back, a newer library is refused untouched, and read-only connections never migrate. Add a case there whenever the migration rewrites data: build an old-format library (the file has a `makeV1Library()` helper that sets `schema_version` to 1), open it with `openDb`, and assert the rows. To test a runner behaviour with your own steps, call `migrate(db, path, { migrations: [...] })`; `MigrateOptions` also takes `now` (a clock for backup names) and `keepBackups`. Run it with `cd core && bun test test/migrations.test.ts`.

If your migration changes what the importer, sync or API read, also run the full core suite; many tests create libraries through `openDb`, so they exercise every migration.
