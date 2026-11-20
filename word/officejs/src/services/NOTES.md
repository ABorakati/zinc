# Office.js Services (`src/services`) — Notes

## What Is Done

Implemented `createServiceMethods` (`src/services/index.ts`) and all 14 non-document methods called by `word/sidebar` (`app.ts`, `main.ts`, `popup.ts`, `agent.ts`), matching the exact parameter and return shapes of `word/addin/Bridge.cs`, `Library.cs`, `Styles.cs`, `Settings.cs`, and `ZnClient.cs`:

- `src/services/index.ts` — `createServiceMethods(ctx, opts?)` wiring all 14 methods, including `host.info` (`{ light }`).
- `src/services/settings.ts` — `settings.get` and `settings.set` with the exact `PageKeys` whitelist (`style`, `locale`, `noteType`, `autoUpdate`, `dbPath`, `userId`), primitive type checks, `null`/`""` key deletion, protected `apiBase` (default `http://127.0.0.1:23120`), persisted via `Office.context.roamingSettings` (key `"zinc.settings"`) when available, else `localStorage`, else in-memory.
- `src/services/library.ts` — `lib.search`, `lib.items`, `lib.byUri`, `lib.uriBase`, and `host.info.library` over Zinc core's HTTP API.
- `src/services/styles.ts` — `style.search`, `style.xml`, `locale.xml` over `/api/cite/*`.
- `src/services/zn.ts` — `zn.status`, `zn.lookup`, `zn.reveal` over `/api/ui/*` and `/api/references/lookup`.
- `src/services/open-url.ts` — `app.openUrl` allowing `http://` and `https://` only, via `Office.context.ui.openBrowserWindow` with fallback to `window.open(..., "_blank", "noopener,noreferrer")`.
- `src/services/http.ts` — browser-safe `fetch` wrapper with timeouts (`AbortController`), structured error extraction, `ZincUnavailableError`, and bounded concurrency (`mapPool`).
- `test/services/fake-core.ts` & `test/services/services.test.ts` — `Bun.serve({ port: 0 })` fake core server shaped after `core/src/` routes, covering all 14 methods, helper functions, fallbacks, and Zinc-not-running errors.

---

## Endpoint Mapping

| Bridge Method | Core HTTP Route(s) Used | Core Status | Shape Transformation |
|---|---|---|---|
| `host.info` `{ light? }` | `GET /api/library?count=0\|1` (404 fallback: `GET /api/files/settings` + `GET /api/websync/status` + `GET /api/items?limit=1`), plus `GET /api/ui/selection` when `!light` | Needs `/api/library` (fallback works today) | Assembles `{ version: "0.1.0", library, uri, settings, zn }`; never throws when Zinc is down (`library.dbExists = false`, `library.error` set) |
| `settings.get` | None (`Office.context.roamingSettings` -> `localStorage`) | N/A | Stored settings dictionary `{}` |
| `settings.set` | None (`Office.context.roamingSettings` -> `localStorage`) | N/A | Enforces `PageKeys`, deletes keys set to `null`/`""`, returns updated settings |
| `lib.search` (empty) | `GET /api/libraries` + `GET /api/items?sort=dateAdded&dir=desc&limit=...&fields=DOI` (`&library=<id>` for group libs) | **Existing** | Filters out `attachment`/`note`/`annotation`, maps `ItemSummary` (`creatorsSummary`, `fields.DOI`) -> `LibRow` (`creators`, `doi`) |
| `lib.search` (`doi`) | `POST /api/searches/run` (`DOI is <doi>`, `fields: ["DOI"]`) | **Existing** | Maps `ItemSummary` -> `LibRow` |
| `lib.search` (`year` only) | `POST /api/searches/run` (`year is <year>`, `sort: "dateAdded", dir: "desc"`, `fields: ["DOI"]`) | **Existing** | Maps `ItemSummary` -> `LibRow` |
| `lib.search` (`match`, optional `year`) | `GET /api/libraries` + `GET /api/search?q=...&limit=...` + `GET /api/items/:key` | **Existing** | Converts sidebar FTS5 `match` to `q` for `parseQuery`, filters `matchedIn.includes("metadata")` and `year`, enriches `publication` (`venueOf`), `itemType`, `DOI` -> `LibRow` |
| `lib.items` | `GET /api/libraries` + `GET /api/items/:key` (+ `GET /api/items/index?key=...&library=...` only when group libraries exist) | **Existing** | Validates/deduplicates keys, follows `data.parentItem` to parent, resolves `trashed` and `groupId` -> `{ key, found, itemKey, trashed, itemType, data, groupId }` |
| `lib.byUri` | `POST /api/items/by-uri` `{ uris, userId? }` | **Added to core** | Returns `Record<string, string>` (`citedUri -> replacementKey`) |
| `lib.uriBase` | `settings.userId` -> `settings.detectedUserId` -> `GET /api/library?count=0` (404 fallback: `GET /api/websync/status`) | Needs `/api/library` for `library_key` & inferred `userId` | Caches detected `userId` in `detectedUserId`; falls back to `http://zotero.org/users/local/<libraryKey \| znlocal0>` |
| `style.search` | `GET /api/cite/styles?quick=1&limit=...` (empty `q`) or `GET /api/cite/styles?q=...&limit=...` | **Existing** | Maps `CiteStyleInfo[]` -> `{ id, title, format: s.format ?? null, dependent, installed }[]` |
| `style.xml` | `GET /api/cite/styles/:id` | **Added to core** | Validates `STYLE_ID_RE` first, returns `{ id, xml }` |
| `locale.xml` | `GET /api/cite/locales/:lang` | **Added to core** | Validates `LOCALE_RE` first, returns `{ lang, xml: string \| null }` |
| `zn.status` | `GET /api/ui/selection` (800 ms timeout) | **Existing** | Returns `{ up, api, launcher: "", launcherExists: false }` |
| `zn.lookup` | `GET /api/references/lookup?doi=...` | **Existing** | Returns `ReferenceDetail` JSON, or `null` when empty/404/down |
| `zn.reveal` | `POST /api/ui/reveal` `{ key, open: true }` | **Existing** | Returns `{ ok, started: false, error? }` (maps `"not found"` -> too-old message, never throws) |
| `app.openUrl` | None (`Office.context.ui.openBrowserWindow` -> `window.open`) | N/A | Validates `http(s)://`, returns `{ ok: true }` |

---

## Endpoints Core Lacked (added on this branch: core/src/cite/api.ts, core/src/items-by-uri.ts; cross-origin access in core/src/taskpane-cors.ts)

### 1. `GET /api/cite/styles/:id` (`core/src/cite/api.ts`)
`StyleStore.styleXml(id, mode)` already exists in `core/src/cite/engine.ts`, and `DELETE /api/cite/styles/:id` already sits at `parts[0] === "styles" && parts.length === 2` in `core/src/cite/api.ts` (line 286), after `/api/cite/styles/install` and `/api/cite/styles/preview`.

- **Request**: `GET /api/cite/styles/:id`
- **Response `200`**: `{ "id": "<id>", "xml": "<raw .csl XML>" }` (fetched via `svc.store.styleXml(id, "preview")` so previewing or formatting in Word caches in `style-cache/styles/` when not installed, or reads `<dir>/styles/<id>.csl` when installed).
- **Errors**: `400 { "error": "invalid style id: ..." }`, `404 { "error": "style \"...\" not found on zotero.org" }`, `502 { "error": "..." }` (already thrown as `HttpError` by `svc.store.styleXml`).

### 2. `GET /api/cite/locales/:lang` (`core/src/cite/api.ts`)
`StyleStore.locale(lang)` already exists in `core/src/cite/engine.ts` (returns `string | null`, returning `null` on invalid locale tag or GitHub 404).

- **Request**: `GET /api/cite/locales/:lang`
- **Response `200`**: `{ "lang": "<lang>", "xml": "<locales-xx-XX.xml>" | null }`
- **Errors**: `405` on non-`GET`, `502` on upstream non-404 network error.

### 3. `POST /api/items/by-uri` (`core/src/api.ts`)
Resolves cited Zotero item URIs whose keys were merged away via `relations["dc:replaces"]` (port of `Library.ByUri` in `word/addin/Library.cs`).

- **Request**: `POST /api/items/by-uri` with JSON body `{ "uris": string[], "userId"?: string }` (at most 50 URIs inspected).
- **Logic**:
  1. Read `libraryKey` from `SELECT value FROM meta WHERE name = 'library_key'`.
  2. Determine `uid = body.userId || web_user_id (from sync_state) || detectUserId(db)`.
  3. For each `u` in `uris.slice(0, 50)`, expand identity aliases (`http://zotero.org/<scope>/items/<key>`, plus `http://zotero.org/users/local/<libraryKey>/items/<key>` and `http://zotero.org/users/<uid>/items/<key>` when `<scope>` starts with `users/`).
  4. Query `SELECT key FROM items WHERE deleted = 0 AND parent_key IS NULL AND data LIKE ? LIMIT 1` with `%"dc:replaces":%<alias>"%` (the trailing `"` prevents prefix collisions on longer keys).
- **Response `200`**: `{ "<citedUri>": "<replacementItemKey>", ... }` (`{}` when none match).

### 4. `GET /api/library?count=0|1` (`core/src/api.ts`)
Exposes `meta.library_key`, inferred `userId` (from `sync_state.web_user_id`, else voting over `zotero.org/users/(\d+)/` in `items.data` relations as `Library.DetectUserId` does when synced from local Zotero without a web API key), `dbPath` (`dbFileOf(db)`), and — when `count=1` — the exact top-level regular item count across libraries (`parent_key IS NULL AND item_type NOT IN ('attachment','note','annotation') AND deleted = 0`).

- **Request**: `GET /api/library?count=0` or `GET /api/library?count=1`
- **Response `200`**:
  ```json
  {
    "dbPath": "C:\\Users\\...\\library.sqlite",
    "libraryKey": "ABCD1234",
    "userId": "5106252",
    "items": 420
  }
  ```
  (`items` omitted unless `count=1`; `dbPath`, `libraryKey`, and `userId` may be `null`).
- Note: `src/services/library.ts` already falls back on `404` to `GET /api/files/settings` + `GET /api/websync/status` (+ `GET /api/items?limit=1`), so basic startup works even before `/api/library` is added.

### Optional Core Niceties (Non-Blocking)
- **`POST /api/searches/run` (`core/src/searches/api.ts` line 53)**: Forward `library: b.library !== undefined ? resolveLibrary(db, b.library) : undefined` to `listItems(...)` if DOI/year shortcuts in `lib.search` should also scan group libraries.
- **Settings `dbPath` in Office.js**: Unlike the Windows COM add-in, an Office.js task pane cannot open arbitrary SQLite files on disk; Zinc core owns the open library database. `settings.set` still accepts `dbPath` so the shared sidebar UI (`word/sidebar/src/main.ts`) works unchanged.
- **Window activation on `zn.reveal`**: The COM add-in calls Win32 `SetForegroundWindow` after `POST /api/ui/reveal`; a browser task pane cannot raise desktop windows, so the GPUI desktop app should bring its own window to the front when `reveal.seq` advances.

---

## CORS, Origin Guard, and Private Network Access (`https://` Task Pane -> `http://127.0.0.1:23120`)

The Office.js task pane runs on an `https://` origin (e.g., the local HTTPS dev server or the deployed task-pane origin) and calls `http://127.0.0.1:23120/api/*`. Currently `core/src/server.ts` blocks this in four places; `core/src/server.ts` needs the following updates (mirroring `core/src/zport/routes.ts` and `core/src/zport/index.ts`):

1. **Origin allowlist (never `Access-Control-Allow-Origin: *`)**:
   - Define allowed task-pane origins (e.g., the production static task-pane origin, local HTTPS dev origin such as `https://localhost:<port>` / `https://127.0.0.1:<port>`, plus an env override like `ZINC_INTEGRATION_ORIGINS` as in `core/src/zport/routes.ts`).
   - Keep the existing `LOOPBACK_HOSTS` check on `Host` (`127.0.0.1`, `localhost`, `[::1]`) to prevent DNS rebinding.
2. **Allow allowed task-pane `Origin` in `apiRequestRejected` (`core/src/server.ts` line 116)**:
   - Currently line 116 rejects every cross-origin `POST` (`POST /api/ui/reveal`, `POST /api/searches/run`, `POST /api/items/by-uri`) with `403 { "error": "forbidden: cross-origin request" }` because `origin !== url.origin`.
   - Exempt origins matching the task-pane allowlist while keeping the `Content-Type: application/json` requirement.
3. **Handle `OPTIONS` preflight requests on `/api/*` before `handleApi`**:
   - Currently `OPTIONS /api/...` falls through to `handleApi` and returns `405` or `404` without CORS headers.
   - For an allowed `Origin` on `OPTIONS /api/*`, respond `204 No Content` with:
     - `Access-Control-Allow-Origin: <origin>`
     - `Vary: Origin, Access-Control-Request-Private-Network`
     - `Access-Control-Allow-Methods: GET, POST, OPTIONS`
     - `Access-Control-Allow-Headers: Content-Type`
     - `Access-Control-Max-Age: 600`
     - **Private Network Access (PNA)**: when the request includes `Access-Control-Request-Private-Network: true` (sent by Chromium / Edge WebView2 / Chrome when an `https://` page fetches `http://127.0.0.1`), include:
       `Access-Control-Allow-Private-Network: true`
4. **Attach CORS response headers on actual `GET` / `POST` `/api/*` responses**:
   - When `Origin` matches the task-pane allowlist, attach `Access-Control-Allow-Origin: <origin>` and `Vary: Origin` to every `/api/*` response (including error responses).
5. **Loopback Mixed Content notes**:
   - Under W3C Secure Contexts, `http://127.0.0.1` is a potentially trustworthy origin, so Edge WebView2 (Word on Windows), modern WKWebView / Safari 15+ (Word for Mac), and Chromium/Firefox (Word on the web) allow `fetch("http://127.0.0.1:23120/...")` from an `https://` frame without Mixed Content blocking once CORS + PNA headers are returned. Prefer `127.0.0.1` (already `DEFAULT_API_BASE`) over `localhost`, as WebKit historically exempted `127.0.0.1` more consistently than `localhost`.

---

## What Is Untested

- Running inside real Microsoft Word hosts (Word on Windows WebView2, Word for Mac WKWebView, Word on the web iframe) and exercising live `Office.context.roamingSettings` and `Office.context.ui.openBrowserWindow` implementations (tested against unit-test fakes of `Office` and `window`).
- End-to-end HTTP requests against a live `core/src/server.ts` process once the four missing routes and CORS / Private Network Access headers above are added to `core/`.
