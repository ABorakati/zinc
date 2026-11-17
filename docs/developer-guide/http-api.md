# HTTP API

The core serves a local HTTP API for the app's UI, the Word sidebar and add-in, the browser connector, and MCP clients. This page is an overview. It lists the route groups so you can find the code; it does not repeat every request and response shape.

The source of truth is `core/src/api.ts` (the router) and `core/src/api-types.ts` (the contract: routes, request bodies and response types). Each feature module documents its own routes in a comment at the top of its `api.ts`.

## The server

`core/src/server.ts` wraps the router in `Bun.serve`. In the app the server is started by `gpui-ui/src/core.ts`, on `127.0.0.1:23120` in the packaged app (see [Architecture](architecture.md) for the other ports). It can also run on its own:

```
bun core/src/server.ts --db <library copy> [--port 23120] [--host 127.0.0.1] [--mount /prefix/=<dir> ...]
```

For each request `fetch` tries, in order: the MCP endpoint (`handleMcp`), the origin guard for `/api` (`apiRequestRejected`), the API router (`handleApi`), and finally static files from the mounts (GET and HEAD only; any other method gets 405). The idle timeout is 255 seconds because a PDF kept online-only by OneDrive can take a while to arrive.

`handleApi(req, db)` returns `null` for paths outside `/api`, so it can also be called directly. The app does this in `ZN_CORE_DIRECT=1` mode, with no socket.

### Loopback guard and origin check

The server listens on loopback, but any web page in the user's browser can still send requests to it. `apiRequestRejected()` answers 403 with `{"error": "forbidden: <reason>"}` for:

- a `Host` header that is not `127.0.0.1`, `localhost` or `[::1]` (`bad host`: DNS rebinding);
- a request with a body method (anything other than GET, HEAD, OPTIONS) whose `Origin` differs from the request's own origin (`cross-origin request`);
- a request with a body whose `Content-Type` is not `application/json` (`content-type must be application/json`). A cross-origin JSON request needs a CORS preflight, which this server never grants.

Clients that are not browsers send no `Origin` and pass. The guard lives in `server.ts`, not in `handleApi`, so direct in-process calls and tests that call `handleApi` skip it. Over HTTP the content-type rule also rejects multipart bodies, so a client uploading a file to `POST /api/add/file` uses the JSON form (`dataBase64` or `path`), even though the handler accepts multipart too. Keep this in mind before adding a non-JSON route.

## Conventions

- Request and response bodies are JSON (`Content-Type: application/json; charset=utf-8`) unless a route says otherwise (file bytes, event streams).
- Errors are `{"error": "<message>"}` with an HTTP status: 400 bad input, 404 not found, 405 wrong method, 409 conflict, 500 unexpected (also written to the local log).
- Item and collection identifiers are Zotero's 8-character keys.
- Lists are paged with `limit` and `offset` query parameters. `GET /api/items` returns an `ItemList` with a `total`; `GET /api/search?q=&limit=&offset=` returns FTS5 results over metadata and full text. Style search (`GET /api/cite/styles`) pages the same way and sends the total in an `X-Total` header.
- `GET /api/items` accepts `collection`, `tag`, `q`, `sort`, `dir`, `then`, `search`, `qmode`, `unfiled=1`, `publications=1`, `trash=1`, `fields=a,b` (extra Zotero data fields on each summary) and `include=creators,tags`.
- `GET /api/items/index?key=K&...` answers `{"index": n}`: where item K sits in the listing `GET /api/items` returns for the same query parameters (`sort`, `dir`, `then`, `collection`, `tag`, `q`, `qmode`, `search`, `unfiled`, `publications`, `trash`, `library`), counted from 0, or `-1` when the listing does not contain it. A missing or malformed `key`, or a bad `sort` or `dir`, is a 400; any method but GET is a 405. `listItems` and `itemIndex` in `core/src/db.ts` build their `ORDER BY` from one function (`listOrder`), so the two cannot disagree. The app uses it to scroll to an item (see [Architecture](architecture.md#open-in-zinc-showing-an-item-from-outside-the-app)).
- Attachment files are served with `Range` support: `GET /api/attachments/:key/file`.

## Route groups

| Prefix | Module | What |
| --- | --- | --- |
| `/api/items`, `/api/collections`, `/api/tags`, `/api/tag-colors`, `/api/schema`, `/api/search`, `/api/open-url` | `core/src/api.ts` | Item CRUD (create, get, patch, `groups`, `index`, `duplicate`, `tags`, `related`), collections and their items, the tag list and tag colours, the Zotero item schema, full-text search, opening an http(s) or doi URL in the browser |
| `/api/attachments/:key/...` | `core/src/api.ts` | `file` (GET, PUT to replace), `reveal`, `open-external`, `annotations`, `view-state` |
| `/api/add/...` | `core/src/additems/api.ts` | `identifier`, `file`, `link`, `retrieve-metadata`, `create-parent` (all POST) |
| `/api/cite/...` | `core/src/cite/api.ts` | `styles` (list, install, preview, delete), `format`, `settings` |
| `/api/bbt/...` | `core/src/bbt/api.ts` | Better BibTeX: `settings`, `formula`, `keys`, `pin`, `unpin`, `refresh`, `cite`, `autoexports` and more |
| `/api/duplicates` | `core/src/duplicates/api.ts` | List duplicate sets, `set`, `merge`, `not-duplicates` |
| `/api/io/...` | `core/src/io/api.ts` | `export`, `import`, `mendeley` |
| `/api/translate/...` | `core/src/translate/api.ts` | `status`, `import-formats`, `export-formats`, `web`, `web/select`, `import`, `export`; see [Translators](translators.md) |
| `/api/searches` | `core/src/searches/api.ts` | Saved searches (CRUD) and `run` |
| `/api/maintenance/...` | `core/src/maintenance/api.ts` | Trash (`empty-trash`, `erase`), tag rename and delete, `rename-files` |
| `/api/files/...` | `core/src/files/api.ts` | Files and folders settings, ZotMoov-style storage and organise commands, base directory, "find my Zotero", `pick-folder`, `reveal` |
| `/api/fulltext/...` | `core/src/fulltext/api.ts` | Find Full Text: `find`, `jobs/:id` (+ `/events` stream, `/cancel`), `sign-in`, `institutions`, `settings` |
| `/api/references/...` | `core/src/references/api.ts` | `:itemKey` (reference list), `lookup`, `add` |
| `/api/sync/...` | `core/src/sync/api.ts` | Local Zotero sync: `status`, `now`, `enable`, `conflicts` |
| `/api/websync/...` | `core/src/websync/api.ts` | zotero.org sync: `status`, `key`, `mode`, `options`, `now`, `files/check`, `files/download-missing`; contract in `core/src/websync/CONTRACT.md` |
| `/api/ui/...` | `core/src/connector/ui.ts` | The UI's current selection and "reveal this item" requests (`selection`, `reveal`), used by the connector and the Word sidebar; see [The `/api/ui` routes](#the-apiui-routes) |
| `/api/integrations` | `core/src/integrations/api.ts` | Install or remove the Word add-in and the Chrome connector registration from Settings |

There is no HTTP route for auto-update. The update logic (`core/src/update/`) is called directly by the app (`gpui-ui/src/update/`); see [Releasing](releasing.md).

Routing order in `handleApi`: `/api/fulltext/` and `/api/references/` first, then the feature handlers (cite, add, duplicates, io, searches, maintenance, files, ui, integrations, translate, bbt), then `/api/sync/` and `/api/websync/`, then the core routes in `route()`. A handler that does not recognise its path returns `null` and the next one is tried; if none answers, the response is `404 {"error": "not found"}`.

## The `/api/ui` routes

`core/src/connector/ui.ts` is a small bridge between the running app, the browser connector and the Word add-in. Its state is in memory (`core/src/connector/state.ts`) and is lost when the core stops.

| Route | What |
| --- | --- |
| `GET /api/ui/selection` | `{selection, rev, ext, reveal}`: the view the UI last posted, a revision counter the UI polls, `ext` (SQLite's `data_version`, which moves when another process commits to the database), and the pending reveal request or `null` |
| `POST /api/ui/selection` | `{kind, key?}` with `kind` one of `library`, `unfiled`, `trash`, `collection`, `search` (`key` is required for the last two). The UI posts its current view so the connector saves into the selected collection. 400 for a malformed value |
| `POST /api/ui/reveal` | `{key, open?}` asks the app to show an item. Answers `{ok, rev, seq, opened}` |

For `reveal`, `key` is a top-level item or a child (a child resolves to its parent). The answer is 404 when the item does not exist or is in the trash, 400 for a missing or malformed `key`, and 405 for any method but POST.

With `open: true` the core also picks a file to open, and `opened` in the answer is that attachment's key (`null` when `open` was not set or nothing was picked). If `key` is itself an attachment, only that attachment is considered. Otherwise the core takes the item's first PDF, then EPUB, then HTML snapshot. Only stored or linked files count, and an attachment of another type is never picked (`readableAttachment` in `ui.ts`).

Each request gets a new `seq`, and `GET /api/ui/selection` returns the latest as `reveal: {key, title, seq, at, open?}`. `open` is `{key, title}` of the picked attachment and is present only when one was picked. The app acts when `seq` changes; see [Architecture](architecture.md#open-in-zinc-showing-an-item-from-outside-the-app).

## MCP: `/mcp`

`core/src/mcp/http.ts` serves a stateless Streamable HTTP MCP endpoint at `POST /mcp` on the same server (GET answers 405). It requires a loopback `Host` and rejects a browser `Origin` that is not exactly the server's own origin. The tools are defined in `core/src/mcp/server.ts`. A stdio transport that opens the SQLite file directly, and so works with the app closed, is `core/scripts/mcp-stdio.ts --db <path>`. For the user-facing setup and tool list see [MCP](../user-guide/mcp.md).

The Word add-in has a separate MCP server on port 23125; it is not part of the core.

## The Zotero port: 23119

`core/src/zport/index.ts` runs a second server on `127.0.0.1:23119`, where the Zotero Connector extension and word-processor plugins expect Zotero. Zinc answers only while the port is free (Zotero itself not running). Route files register their routes with `registerZRoute(method, path, handler)` from `core/src/zport/routes.ts`. Every response gets Zotero's CORS headers and `X-Zotero-Version: 7.0.0`; an unknown path answers `404 No endpoint found`.

| Path | Module | What |
| --- | --- | --- |
| `/connector/ping`, `getSelectedCollection`, `saveItems`, `saveSnapshot`, `saveSingleFile`, `saveAttachment`, `saveStandaloneAttachment`, `getRecognizedItem`, `hasAttachmentResolvers`, `saveAttachmentFromResolver`, `updateSession`, `delaySync`, `import`, `installStyle`, `getClientHostnames`, `proxies` | `core/src/connector/handlers.ts` (registered by `zport/connector.ts`) | The browser connector protocol, after Zotero's `server_connector.js`. The connector API version is 3 |
| `/connector/document/execCommand`, `/connector/document/respond`, `/zotero-next/integration/dialogs` | `core/src/zport/integration.ts` | Word-processor integration |
| `/better-bibtex/cayw`, `/better-bibtex/json-rpc`, `/better-bibtex/export/item`, `/better-bibtex/export` | `core/src/bbt/http.ts` | Better BibTeX endpoints (cite-as-you-write, JSON-RPC, pull exports). They refuse browser requests (any http or https `Origin`, or a non-loopback `Host`) |

The browser-connector host (`connector-host/`) runs the same `connectorRoutes` handlers in-process against the database, with no port involved; see [Architecture](architecture.md).

## Adding a route

1. Put the route in the module that owns the feature, or create `core/src/<feature>/api.ts` exporting `handleXApi(req, db)` that returns `null` for paths it does not own, and add it to `FEATURE_HANDLERS` in `core/src/api.ts`.
2. Throw `HttpError(status, message)` for client errors; the router turns it into `{error}`.
3. Document the route in the comment at the top of the module and, for core routes, in `core/src/api-types.ts`.
4. Add a test in `core/test/`. `core/test/fuzz/http.fuzz.test.ts` already checks that the API never answers 5xx for malformed requests.
5. If the UI calls it, add a typed client in `gpui-ui/src/` (the features keep theirs next to the feature, for example `gpui-ui/src/features/translate/client.ts`).
