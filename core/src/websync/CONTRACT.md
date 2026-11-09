# zotero.org web sync — contract

Two-way sync between a zotero-next library and the user's zotero.org library through the Zotero Web API v3
(https://www.zotero.org/support/dev/web_api/v3/syncing, /write_requests, /file_upload). Written in TypeScript on Bun
(network-bound: no Rust). User library and group libraries (each synced through `/groups/<id>/...`; read-only groups never push).

## Sync source (one route per library)

Setting `sync.mode` in `sync_state` (name `mode`): `"zotero-local"` (default, today's behaviour: core/src/sync against
~/Zotero/zotero.sqlite), `"zotero-org"` (this module), or `"off"`. Exactly one runs: switching to `zotero-org` stops the
local SyncService and vice versa. Reason: desktop Zotero already syncs to zotero.org; running both routes would echo
every change back and forth.

## Credentials

API key is typed by the user in Settings. Validate with `GET /keys/current` (gives userID, username, access). Store it
with `Bun.secrets` (service `"zotero-next"`, name `"zotero-api-key"`) — never in SQLite, logs, or API responses.
Base URL `https://api.zotero.org`, overridable with env `ZN_ZOTERO_API` (tests point it at a local mock server).
Headers: `Zotero-API-Key`, `Zotero-API-Version: 3`.

## Versions

Per object, store the last seen server version (`websync_versions(type, key, version)`); library version in
`sync_state` `web_library_version`. Pull = `GET /users/<id>/{collections,items,searches}?since=<v>&format=versions`,
then fetch changed objects by `?itemKey=k1,…` (50 per request), plus `GET /users/<id>/deleted?since=<v>`.
Fetch up to 4 requests concurrently; honour `Backoff` and `Retry-After` (429/503) by pausing all requests.
If `Last-Modified-Version` changes mid-pull, restart the pull from the old version.

Apply pulled objects with the suppress flag on (same mechanism as core/src/sync/apply.ts — reuse it where possible) so
the outbox triggers do not re-record them.

First pull on a library that came from the local Zotero (same keys): an object whose local data already equals the
remote data just records its version. Differences: if the local object has no outbox entry, remote wins; if it has
one, newer dateModified wins and the loser goes to `sync_conflicts` (same table and UI as local sync).

## Push (opt-in, starts disabled, like local sync)

From `sync_outbox` (reuse core/src/sync/build.ts to coalesce). POST up to 50 objects per request with
`If-Unmodified-Since-Version: <library version>`; writes are strictly sequential. Per-object results
(`successful`/`unchanged`/`failed`) update `websync_versions`; 412 → pull, then retry once. Deletions:
`DELETE /users/<id>/items?itemKey=…` (50 per request) with the same header. Trash = `deleted: 1` in item JSON.

## Files (attachments)

Setting `files` in `sync_state`: `"off"` (default: attachment ITEMS sync as metadata, their files are never
uploaded or downloaded), `"download"` (download files of imported attachments that are missing locally; 4–8 parallel),
`"sync"` (download + upload with the md5/mtime authorization flow). Downloaded files go to zotero-next's own storage
(`<db dir>/storage/<KEY>/<filename>`), the same place core/src/files uses for imported attachments.
Separately, `files/check` reports which imported attachments have no local file and whether zotero.org holds one
(`GET /users/<id>/items/<key>/file` → 302 = present on server; use HEAD or don't follow the redirect body).
This check must work with `files: "off"` — it exists so the user can download online-only files before purging
zotero.org storage.

## HTTP API (core server, next to /api/sync/*)

    GET    /api/websync/status   -> WebSyncStatus
    POST   /api/websync/key      {apiKey}      -> WebSyncStatus   (400 with message if the key is rejected)
    DELETE /api/websync/key                     -> WebSyncStatus
    POST   /api/websync/mode     {mode}         -> WebSyncStatus
    POST   /api/websync/options  {push?: boolean, files?: "off"|"download"|"sync"} -> WebSyncStatus
    POST   /api/websync/now                     -> WebSyncStatus
    POST   /api/websync/files/check             -> FilesCheck
    POST   /api/websync/files/download-missing  -> WebSyncStatus  (starts a job; progress in status.files)

    interface WebSyncStatus {
      mode: "zotero-local" | "zotero-org" | "off";
      account: { keySet: boolean; userId?: number; username?: string; canWrite?: boolean; filesAccess?: boolean };
      push: boolean; files: "off" | "download" | "sync";
      libraryVersion?: number; pending: number; conflicts: number;
      lastPullAt?: string; lastPushAt?: string; lastError?: string;
      busy: boolean; backoffUntil?: string;
      fileJob?: { done: number; total: number; failed: number; bytes: number; running: boolean };
    }
    interface FilesCheck {
      imported: number; missingLocally: number;
      onServer: number; notOnServer: number; unknown: number;   // of the missing ones
      sample: { key: string; title: string; onServer: boolean | null }[];
    }

Entry point for the app: `startWebSync(db, opts?)` / `stopWebSync(db)` exported from `core/src/websync/index.ts`,
plus `syncMode(db)` so the app's services start either the local SyncService or this one.
