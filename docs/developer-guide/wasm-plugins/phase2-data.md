# Phase 2, data agent: library, change log, notifier, net, fs, clipboard, shell

Status 2026-11-18. Handlers: [`plugin-host/src/imports/`](../../../plugin-host/src/imports/) (files named below). Core change log and batch: [`core/src/changes/`](../../../core/src/changes/), [`core/src/migrations/change-log.ts`](../../../core/src/migrations/change-log.ts). Tests: [`plugin-host/test/data/`](../../../plugin-host/test/data/).

Design sources: [library.md](library.md), [lifecycle.md](lifecycle.md), [phase2-core.md](phase2-core.md) ("For the stage 2 agents"), `plugin-api/wit/library.wit` and `lifecycle.wit`.

## What was built

### Core: change log, event stream, atomic batch

The README decision "Zinc's core gets a change log and event stream in this phase" is done. Additive and migration-safe: migration 5 (`change-log`) adds two tables and 22 triggers; it changes no existing row, and a library at schema 4 upgrades through the normal backup-then-migrate path (tested). An older build refuses a v5 library (`LibraryTooNewError`), as for any migration.

| What | Where |
|---|---|
| `change_log(seq, at, object, kind, key, library_id, origin, silent)` and `change_ctx(name, value)`, triggers on `items`, `collections`, `collection_items`, `item_tags`, `attachments`, `saved_searches`, `annotations`, `fulltext` | `core/src/migrations/change-log.ts`, registered in `migrations/list.ts` |
| Reading it: `GET /api/changes?since=N&limit=&library=&wait=ms` (long poll, at most 30 s), `GET /api/changes/head`, `GET /api/changes/stream` (server-sent events) | `core/src/changes/api.ts`, `log.ts`; the router calls `handleChangesApi` first (one line in `api.ts`) |
| `POST /api/batch`: the whole WIT `change` variant in one SQLite transaction, all or nothing, failure names the index | `core/src/changes/batch.ts` |

Every write path is covered because the triggers are on the tables, not on the code that writes them: the HTTP routes, import, sync (rows get origin `sync`), the connector host, the MCP server, the Word add-in. Unlike `sync_outbox` the log is not de-duplicated and not suppressed during sync. Details:

- Objects and kinds: `item` add / modify / trash / restore / delete / index (full text), `collection` add / modify / delete, `collection-item` add / remove (`"<collection>-<item>"`), `item-tag` add / modify / remove (`"<item>-<tag>"`), `file` add / modify / delete (the attachments row), `search` add / modify / delete, `annotation` add / modify / delete (the notifier delivers these as `item` + `other`, because `object-type` has no annotation).
- `origin`: `sync` while sync holds its `suppress` flag; else the `origin` row of `change_ctx`, which `POST /api/batch` sets for the length of its transaction (`plugin:<id>`); else `unknown`. A rollback leaves no context row and no log row. `silent` is set by `skipNotify`.
- `since` semantics: a cursor is the last `seq` seen. The page carries `head`, `cursor` (pass it next time), and `reset: true` when the cursor is ahead of the log (a different library file) or older than what is kept. The log keeps about 100,000 rows (pruned when it passes 200,000).
- Batch change shapes are the WIT variant in jco's JSON form (`{tag, val}`, camelCase records); the full list is at the top of `batch.ts`. Caller keys (`new-keys`) are honoured for items, collections and saved searches (small optional `key` parameter added to `createItem`, `createCollection`, `createSavedSearch`). `erase-items` needs the item to be in the trash already. An erase removes imported attachment files from disk before the transaction ends, so a later failing change cannot bring them back: put `erase-items` last (documented in `batch.ts`).
- Edits to existing core files (all small): `db.ts` (optional `key`), `searches/store.ts` (optional `key`), `maintenance/api.ts` (`ownStorage` exported), `api.ts` (one import and one array entry), `migrations/list.ts`, and `core/test/libraries.test.ts` (it used `SCHEMA_HEAD - 1` to mean "before migration 4"; it now says 3).

### Plugin host handlers (`plugin-host/src/imports/`)

All are `defineHandler` modules. File names follow `discoverHandlers` (`*.host.ts` or `*.zinc.ts`; the brief said `library.ts` and so on, which would not be found).

| File | `where` | Interfaces |
|---|---|---|
| `library.host.ts` | host | `library` |
| `attachments.host.ts` | host | `attachments` (+ resource `file-writer`) |
| `fulltext.host.ts`, `schema.host.ts`, `cite.host.ts`, `translate.host.ts`, `sync-control.host.ts`, `data-utils.host.ts` | host | the interface of the same name |
| `notifier.host.ts` | host | `notifier` (+ the handle `subscription-guard`, see below) |
| `net.host.ts` | host | `net` (+ resource `body-reader`); also exports `fetchForHandler` for other handlers |
| `fs.host.ts` | host | `fs` except the pick dialogs |
| `fs.zinc.ts` | zinc | `fs.pick-open`, `pick-save`, `pick-directory` |
| `clipboard.zinc.ts`, `shell.zinc.ts` | zinc | `clipboard`, `shell` |
| `data/` | | helpers: `core.ts` (HTTP to core, status to `error` mapping, `mcpText`), `library-map.ts` (query and summary mapping), `utils.ts` (dates, CSL, extra, identifiers), `nethosts.ts` (allowlist), `fs-roots.ts` (roots, grants, quota), `notifier-hub.ts`, `pick-hook.ts`, `os-hooks.ts`, `perm.ts` |

Permissions: every handler calls `requirePermission(ctx, id)`. `data/perm.ts` re-exports it from `src/permissions/` (the pkg agent's helper, which exists now).

**Where did clipboard and shell go?** Zinc process. The clipboard belongs to the window system (focus check for `clipboard.read`, first-read confirmation), and opening a URL or file is something the app should be able to replace (GPUI has its own). Both take a replaceable backend (`data/os-hooks.ts`: `setClipboardBackend`, `setShellBackend`). Defaults: text-only clipboard through the platform tool, opener by `rundll32` / `open` / `xdg-open` with an argv array (never a shell), and every confirmation denied.

**Opening URLs.** `shell.open-url` accepts `http`, `https`, `mailto` (permission `shell.open-url`), plus schemes the manifest lists under `permissions.shell.schemes` (the user confirms the first use of each, default denied). `file:`, `javascript:`, `data:`, `vbscript:` and a dozen more are refused always. A URL with a space, a control character, more than 4096 characters, or credentials is refused. `open-file` refuses programs and scripts by extension (`.exe .bat .cmd .ps1 .js .lnk .sh .app ...`) and reaches only the plugin's `data`, `temp` and granted files, never `bundled`.

**Notifier.** One `NotifierHub` per host process runs one long poll on `/api/changes` while any subscription exists. Per subscription: events merged per `(object, kind, library, origin)` with their ids, flushed after `max-delay-ms` (default 50, at most 1000); one batch in flight; queue of 256 batches; when it overflows the oldest are dropped and a `refresh` event per affected type is delivered first; `skip-own`, `types`, `kinds`, `priority` (subscriptions are fed in priority order); `silent` rows are never delivered; a log `reset` becomes `refresh` events. Origins: `plugin:<this plugin>` is `self`, another plugin `plugin(id)`, `sync`, `user` and `connector` pass through, writes with no context are `unknown`. `notifier.trigger` accepts only `other` events with `options.name` and delivers them to the subscriptions of this host process. Subscriptions end when the plugin is unloaded: `subscribe` makes an (unreturned) handle of the resource `subscription-guard` whose `drop` runs from `HandlerTable.dropPlugin`.

**net.** Allowlist from `permissions.net.hosts` (`scheme://host[:port]`, `*.` wildcards, https assumed, `*` means any public host); private and loopback hosts only by exact entry; every redirect hop is checked again; a name that resolves to a private address is refused unless listed. Caps: 30 s default timeout (never above 10 min), 64 MiB default response (at most 512 MiB), 16 requests per `send-many`, 20 redirects. The host owns `Host`, `Content-Length`, `Cookie` (unless a jar), `Proxy-*`, `Sec-*`; default `User-Agent: Zinc/0.1`. Per-plugin cookie jars. `retry` policy, `success-codes`, `cancel-key`, basic credentials. `download` streams to a `fs` destination (data, temp or a writable grant) through a `.part` file and renames it at the end. `send-streamed` returns a `body-reader` resource. Errors are `net-error` variants (the WitError payload is built directly).

**fs.** The four roots as lifecycle.md designs: `data` (`<dataRoot>/<plugin id>/`, 512 MiB quota), `bundled` (read only), `temp` (`<tempRoot>/<plugin id>/`), `granted(id)`. Paths: relative, `/`, no `..`, no drive letter, no empty or reserved names (`CON`, `NUL`, `COM1` ...), no `\ : * ? " < > |` or control characters, no trailing dot or space; a symbolic link or junction that leaves the root is refused. 256 MiB whole-file cap, `read-range` for more. Conflict modes `fail`, `overwrite`, `rename-unique` (`name 2.ext`), atomic writes through a temp file. Grants live in `<dataRoot>/.grants/<plugin>.json`, because the dialogs run in the Zinc process and the reads in the host process; both read and write the same file. A session grant is valid while its Zinc process is alive. A granted file has the path `""`; a granted folder is browsed with relative paths. A read grant refuses writes. A plugin never gets a path back (`file-grant` has `id`, `name`, `is-directory`, `size`).

**The pick dialogs** are `where: "zinc"` and call a hook the ui agent fills: `setFilePicker(fn)` from `data/pick-hook.ts`. `fn({pluginId, kind: "open" | "open-multiple" | "save" | "directory", options, suggestedName})` returns the chosen absolute paths (or `undefined` on cancel) and must refuse without a focused Zinc window. Default: `unavailable` (denied). Drops use `addGrant(pluginId, {path, isDirectory, mode: "read", size})` from `data/fs-roots.ts` and hand the returned record (`id`, `name`, `isDirectory`, `size`) to the plugin as `types.file-grant`.

**Reaching core.** Reads call HTTP routes. Where core has an MCP tool but no HTTP route (`get_fulltext`), `data/core.ts` `mcpText` calls `POST /mcp` (stateless JSON-RPC). `library.apply` calls `POST /api/batch` with `origin = plugin:<id>`.

## Run it

```bash
cd plugin-host
bun check                    # typecheck
bun test test/data           # this area: about 7 s (the e2e test builds a QuickJS plugin first)
bun test                     # everything
cd ../core && bun test       # core (the change log is exercised in plugin-host/test/data/changes.test.ts)
```

The tests start a throwaway core from core's own test fixture (`core/test/fixture.ts`: a temp library with a few items, an attachment, full text) with `startServer({port: 0})`. They never open `data/library.sqlite` or ports 23119 / 23120. `core/vendor` is a junction to the main checkout's `core/vendor` (git-ignored; the sparse worktree lacked it, so core's server and 160-odd core tests could not load): created once, nothing written through it.

## Tests and result

| File | Tests | What it proves |
|---|---|---|
| `test/data/changes.test.ts` | 11 | every write path is logged with the right object, kind, key and library; paging, reset, long poll, event stream; batch: linked creates with caller keys, origin tagging and context cleanup, rollback (no item, no log row), index of the failing change, `expectedModified` conflict, erase needs the trash, publications, saved searches, collection erase with items, silent rows, the CSRF guard; migration of a v4 library |
| `test/data/library.test.ts` | 22 | `library` (permissions, query scopes, tags, text, ad-hoc search, expand, get-items, summaries, children, collections, tags, facets, tag colours, `apply` atomic with permission split and `{index, error}`, trash / restore / erase / empty-trash), `attachments` (info, ranges, caps, import, `file-writer` resource, view state, import from URL through the allowlist), `fulltext`, `schema`, `cite`, `sync-control`, `data-utils` |
| `test/data/platform.test.ts` | 21 | `net` (allowlist, redirect hops, header ownership, success codes, size cap, timeout, cancel, retry, cookie jars, `body-reader`, download), `fs` (roots, traversal and reserved names, links, quota, grants, picker hook, drops), `shell` (URL and file validation, confirmations), `clipboard`, the notifier hub (merge, filters, priority, one in flight, overflow, reset, `trigger`) and the handler against a core |
| `test/data/e2e.test.ts` | 5 | a built QuickJS plugin, through the real plugin host process, subscribes, queries items, receives a notifier batch for a write made by someone else (origin `unknown`), writes with `library.apply` and receives its own batch (origin `self`), and gets `permission-denied` for `library.trash` |

Result: `bun test test/data` **59 pass, 0 fail** (about 7 s); `bun check` clean. Core: `bun test` in `core/` **1356 pass, 5 fail** in one full run under load (three 30,000-item timing tests and two translator tests that exceed their time limits when several agents share the machine); all five pass when run alone (`test/api-perf.test.ts`, `test/searches/perf.test.ts`, `test/translate`, `test/update`: 90 and 2 pass). Full `plugin-host` run: 124 tests, 1 fails: see "Needs from other areas".

## WIT rows now implemented

Implemented (some with a stated limit); "unavailable" rows return the WIT's `unavailable` error and are listed under "Stubbed or left".

- `library`: `list-libraries`, `new-keys`, `query-items`, `query-keys`, `count-items`, `facets` (no `collection`, `contentType`), `get-items`, `get-summaries`, `get-children`, `list-collections` (`version` is 0), `get-collection-items`, `list-tags`, `get-tag-colors`, `set-tag-colors` (the colour list is global in core, `library` is ignored), `rename-tag`, `delete-tags`, `delete-automatic-tags`, `list-search-conditions`, `list-saved-searches`, `get-saved-search`, `apply` (all 19 `change` cases), `find-duplicates`, `merge-items`, `mark-not-duplicates`, `empty-trash`.
- `attachments`: `get-info`, `best-attachment`, `best-attachments`, `read-file`, `read-file-all`, `import-bytes`, `file-writer` (constructor, `append`, `finish`, drop), `import-from-url`, `link-file`, `link-url`, `replace-file` (without a new name), `rename-by-template`, `reveal-file`, `open-file-external`, `storage-of` (one file at most), `get-view-state`, `set-view-state`, `find-available-files`, `get-find-job`, `cancel-find-job`.
- `fulltext`: `get-content`, `get-index-state` (`indexed`, `unindexed`, `unavailable`), `search`.
- `schema.get-schema`; `cite`: `list-styles`, `install-style`, `remove-style`, `format`, `quick-copy`, `get-quick-copy-settings`; `translate`: `list-translators` (import and export), `import-text`, `export-items`, `web`, `web-select`; `sync-control`: `get-state`, `sync-now`; `data-utils`: all 11 functions; `notifier`: `subscribe`, `unsubscribe`, `trigger` and the export call `notifier-handler.on-events`.
- `net`: `send`, `send-many`, `download`, `send-streamed`, `body-reader.read`, `body-reader.close`, `cancel`, `list-cookies`, `clear-cookie-jar`, `is-online` (always true).
- `fs`: `read`, `read-range`, `read-text`, `write`, `write-text`, `append`, `stat`, `list-dir`, `make-dir`, `remove`, `move`, `copy`, `list-grants`, `release-grant`, `pick-open`, `pick-save`, `pick-directory` (the last three through the hook).
- `clipboard`: `write`, `read`. `shell`: `open-url`, `open-file`, `reveal`.

## Stubbed or left

Where core lacks the feature the handler answers the WIT error (`unavailable`, or `limit-exceeded` and so on where that is the case) after the permission check.

| Call | What is missing |
|---|---|
| `library.find-by-relation` | no relation index in core (relations are JSON in `items.data`) |
| `attachments.rename-file`, `delete-file`, `relink-file` | no core route (core renames only by template; deleting a file but keeping the item; relinking) |
| `attachments.replace-file` with a `filename` | core replaces the bytes in place only |
| `attachments.get-info` | `path` (needs a route; `get_file_path` exists only as an MCP tool and returns text), `charset`, `last-read` are none |
| `attachments.storage-of` | counts the one stored file; core has no folder listing |
| `fulltext.set-content`, `reindex`, `get-queue-status` | no core routes; `fulltext.source` has no `plugin` value |
| `fulltext.get-content` | `source` is always `extracted`, `indexed-at` is the epoch (core does not return them over MCP) |
| `fulltext.search` | `matched-in` and snippets come from `/api/search`; the `library.read` permission is required as well |
| `cite.get-style-xml` | no route returns the XML of an installed style |
| `cite.format` | `note-citation` is built here from the item keys with local URIs; core has no note-citation output |
| `translate.lookup` | core's add-by-identifier saves the items; a resolve-only route is needed |
| `translate.list-translators` for `web`, `search` | no listing route; `import-text` into a group library |
| `translate.web` | the network permission is checked on the page URL only; core fetches |
| `net.download` `report-progress` | `net-events.on-download-progress` is never called (the host cannot call the export per chunk cheaply; no plugin needs it yet) |
| `sync-control.get-state` | `route` is `off` or `zotero-local`; `last-synced` is core's `lastSync` when present |
| `sync-control.sync-now` | runs in the background; the `sync` notifier events are not produced (the log has no sync rows) |
| Notifier | `extra` (per-id data such as `changed` fields) is empty; events for `tag`, `trash`, `relation`, `setting`, `group`, `feed`, `share` are not produced; `skip-notify` hides a batch from every subscriber, including the plugin's own origin |
| `apply` | `required` on a search condition is ignored; `groupStart` / `groupEnd` and operators outside core's eight are `invalid-argument` |
| Query | `any`-join ad-hoc search cannot be combined with tags, text or a collection scope in one query; a saved-search scope cannot be combined with an ad-hoc search; `text` with an ad-hoc search or several tags becomes an `anyField contains` condition |
| `clipboard` default backend | text only (no HTML or PNG) |
| `fs` | the `temp` root is emptied by `clearTempRoot()`, which the app must call at startup; nothing watches the quota between calls beyond a 1.5 s cache |

## WIT changes

None made. For review (unchanged):

1. `net.download-options.report-progress` has no matching host-side delivery: `net-events.on-download-progress` is an export the host would call during the transfer. Either drop the option or define who calls it.
2. `types.error` has no `unsupported` case (also in phase2-core.md): "core lacks this" is `unavailable` with a text, and a plugin cannot tell it from "offline".
3. `library.apply-options.skip-notify` says the batch still reaches other plugins' observers marked with the origin; the log has one `silent` flag, so it hides the batch from everyone.
4. `notifier.object-type` has no `annotation`, but the log records annotation changes; they are delivered as `item` / `other` with `options {"name": "annotation", "change": ...}`.

## Needs from other areas

- **plugin-host core (supervisor, registry)**: `HandlerContext` has no folder of the plugin package, so `fs` root `bundled` cannot find it. `fs-roots.ts` reads `ctx.pluginDir` if it exists, else `configureFs({bundledDirFor})`, else `<ZN_PLUGINS_DIR>/<id>`. Please add `pluginDir` to the context (it is `spec.dir` in `host-main.ts` and the supervisor).
- **plugin-host core, test**: `test/supervisor.test.ts` "WIT resources" now fails (the only failure in the full run). It registers stub `zinc:plugin/attachments` (`file-writer`) and `zinc:plugin/net` (`send-streamed`, `body-reader`) as `where: "zinc"` handlers; the real `where: "host"` handlers added here win the routing. Move the stubs into a host module (`hostHandlerModules`, whose entries override same-named functions) or point the test at other interfaces.
- **app wiring (gpui-ui / whoever owns `platform.ts`)**: `configureFs({dataRoot, tempRoot})` and `clearTempRoot()` at startup; `setFilePicker`, `setClipboardBackend` (`windowFocused`, `confirmRead`), `setShellBackend` (`confirmScheme`, and the GPUI opener if wanted); pass `coreUrl`.
- **ui and extend agents**: a dropped file becomes a grant with `addGrant(pluginId, {path, isDirectory, mode: "read", size})`; return its record as `types.file-grant`.
- **core features still missing** (the same list as library.md, minus the change log and the batch route, which exist now): relation index, collection trash, `lastRead`, charset and `source = plugin` for full text, a reindex route, a resolve-only lookup route, file routes (rename to a name, delete file, relink, path), a style XML route, note-citation output, group-library import, search compiler coverage (groups, `required`, number fields, `lastRead`, annotation conditions, `retracted`), sync events in the log.
- **mirror of the permission ids**: nothing new; every id used is in `manifest.schema.json` (`library.*`, `clipboard.*`, `shell.*`). `permissions.shell.schemes` is read from the manifest directly.
