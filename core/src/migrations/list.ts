// The library's schema history, oldest first. meta.schema_version holds the id of the last migration applied.
//
// How to add a migration
//   1. Create core/src/migrations/<name>.ts exporting a `Migration` ({ id, name, up(db) }) and append it to MIGRATIONS below with the
//      next id (no gaps: the runner rejects a list that is not 1, 2, 3 ...). Never edit, reorder or delete a released migration.
//   2. up(db) uses plain db.run / db.exec / db.query. Do not BEGIN, COMMIT or call db.transaction(): the runner wraps every pending
//      migration in ONE transaction (so a failure undoes all of them), with foreign keys switched off, then runs
//      PRAGMA integrity_check and PRAGMA foreign_key_check before committing. Table rebuild = create new, copy, drop old, rename.
//   3. Before it touches an existing library, the runner makes library.backup-v<from>-to-v<to>-<time>.sqlite next to the database
//      (the last 3 are kept). A library that is already newer than the last id here refuses to open (LibraryTooNewError).
//   4. The *.sql schema files are the v1 baseline plus the lazily applied extras (searches, duplicates). Do not change a table or
//      index there: express the change as a migration, so existing libraries get it too. When a derived column's rule changes (e.g.
//      venue.ts), add a migration that recomputes it (see recomputeVenues in venues.ts).
//   5. Add a case to core/test/migrations.test.ts if the migration rewrites data.
import { baseline } from "./baseline";
import { quickSearch3 } from "./quick-search";
import { libraries4 } from "./libraries";
import { venues2 } from "./venues";
import { changeLog5 } from "./change-log";
import type { Migration } from "./types";

export const MIGRATIONS: readonly Migration[] = [baseline, venues2, quickSearch3, libraries4, changeLog5];

/** The schema version this build writes and understands. */
export const SCHEMA_HEAD = MIGRATIONS[MIGRATIONS.length - 1].id;
