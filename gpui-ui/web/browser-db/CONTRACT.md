# Browser library: shared contract (docs/design/browser-edition.md)

Fixed before the parallel work starts. Change it only together with everyone who depends on it.

## Pieces and who owns which files

| WP | Piece | Owns (creates or edits) |
|---|---|---|
| A | EPUB and snapshots in the extension: Zotero's reader (`reader-host`) as an extension page in its own tab | `reader-host/src/*`, `gpui-ui/web/reader-tab/*`, the reader-copy step of `web/build.ts`, the "open EPUB/snapshot" hook in `web/extension.tsx`, `web/library-reader-check.ts` |
| B | websync runs in a browser worker | `core/src/websync/*` (and its tests), `gpui-ui/web/browser-db/keystore-chrome.ts` |
| C | Durable files: the `node:fs` shim keeps `/opfs/...` paths in a SQLite blob store | `gpui-ui/web/shims/fs.ts`, `gpui-ui/web/shims/fs-promises.ts`, `gpui-ui/web/browser-db/blobfs.ts` (+ tests) |
| D | The database owner: offscreen document, DB worker on OPFS, the port transport, browser mode of the library tab, first-run screen, headless persistence check | `gpui-ui/web/browser-db/*` except the files of B and C, `gpui-ui/web/extension.tsx` (except A's hook), the browser-db entries of `web/build.ts`, `gpui-ui/web/browser-library-check.ts` |
| E | Connector: save target, routing saves to the browser library, popup shows the target, manifest permissions | connector repo only (`src/browserExt/*`, `manifest-v3.json`, `scripts/build-win.ts`) |
| F | Shims: real MD5 in `node:crypto` `createHash`, `node:zlib` raw inflate/deflate through fflate | `gpui-ui/web/shims/small.ts` (crypto part), `gpui-ui/web/shims/zlib.ts`, the zlib line of `web/build.ts` |

`web/build.ts` is shared: each WP edits only its own block, and adds no unrelated reformatting.

## Transport: the native host's frames over an extension port

The browser library speaks the same protocol as the native host (`connector-host/src/dispatch.ts`, `gpui-ui/web/native-host.ts`), so the library tab and the connector only change how they connect:

- Native host: `chrome.runtime.connectNative("com.zotero_next.connector_host")`
- Browser library: `chrome.runtime.connect({ name: "zinc-db" })`, answered by the offscreen document

Frames are unchanged (JSON, base64 body chunks):
- `{t:"req", id, method, http, path?, query?, headers, body}`, then `{t:"up", ...}`
- back: `{t:"res", id, status, headers, n}`, then `n` × `{t:"rc", ...}`

Methods:
- `api`: the library tab's `/api/*`. Every route is allowed except `/api/integrations/*` and the local Zotero sync `/api/sync/*`. `/api/websync/*` is allowed: it is how the browser library syncs.
- `ping`
- The connector methods (`saveItems`, `saveSnapshot`, `saveAttachment`, `updateSession`, `getSelectedCollection`, …)
- `sessionItems`, `trashSession`, `cancelSession`

Not served (the connector uses its own remote source in browser mode): `getTranslators`, `getTranslatorCode`. Not served: `revealInApp` (there is no app). Unknown methods answer 404.

Pages and URLs inside the build (`gpui-ui/dist-extension`, copied by the connector to `library/`):
- `offscreen.html`, created by the extension's service worker: `chrome.offscreen.createDocument({url: "library/offscreen.html", reasons: ["WORKERS"], justification: "Zinc library database"})`
- `db-worker.js`, started by `offscreen.html`
- `library.html?mode=browser`: the library tab on the browser library. Without `mode`, it uses the native host as today.

The offscreen document posts `{t:"changed", dataVersion}` to every connected port after a write commits. The library tab refreshes on it, in place of polling.

## `{zincEnsureDb: true}`: getting the database owner started

Whoever needs the database (the library tab with `?mode=browser`, the connector's save code) first sends `chrome.runtime.sendMessage({zincEnsureDb: true})`. The extension's service worker answers it:
- if there is no offscreen document, it creates one: `chrome.offscreen.createDocument({url: "library/offscreen.html", reasons: ["WORKERS"], justification: "Zinc library database"})`. An "already exists" / "only a single offscreen document" error means it is there: not a failure. Concurrent messages share one `createDocument` call.
- it replies `{ok: true}` once the document exists (the database inside may still be opening: requests sent on the port wait for it), or `{ok: false, error}`.

Then connect `chrome.runtime.connect({name: "zinc-db"})`. If the port disconnects (the browser closed the offscreen document), send `{zincEnsureDb: true}` again and reconnect. The manifest needs the permissions `offscreen` and `unlimitedStorage`. A reference implementation is `test-background.js` (used by the check).

`library/offscreen.html` does not assume it is a top-level offscreen document. Chrome allows one offscreen document per extension, so in the real extension the connector's own offscreen page loads it as a hidden iframe (`<iframe src="library/offscreen.html">`); it listens with `chrome.runtime.onConnect` and starts its worker from there, and works the same either way. `browser-library-check.ts --iframe` runs the whole check that way (`test-background.js (with self.ZINC_TEST_OFFSCREEN set)`). In that case the service worker's `{zincEnsureDb}` handler creates the connector's offscreen document, which must contain the iframe.

Frames on the port, besides the native host's: the offscreen document sends `{t:"changed", dataVersion}` unprompted (no `id`). Uploads (`up` frames) belong to the port that sent them. A `hello` frame is answered with `{t:"hello", id, version, db, pid: 0, proto: 2}`.

## Storage (OPFS, extension origin)

- Database: `@sqlite.org/sqlite-wasm`, VFS `opfs-sahpool` (pool directory `.zinc-sahpool`), database name `/zinc/library.sqlite`. The core sees `db.filename === "/opfs/zinc/library.sqlite"`, so `storageRoot()` is `/opfs/zinc/storage`.
- Files: everything the core writes under `/opfs/` goes through the `node:fs` shim into a second database in the same pool, `/zinc/files.sqlite`:
  - table `files(path TEXT PRIMARY KEY, data BLOB NOT NULL, mtime INTEGER NOT NULL, name TEXT)`
  - table `dirs(path TEXT PRIMARY KEY, name TEXT)`

  `path` is the lower-cased lookup key (paths are matched case-insensitively); `name` is the same path in the case it was written with, and is what `readdir` returns. A database from before `name` existed gets the column added on open, with `path` as the name. The core's file code stays synchronous and unchanged. Other paths stay in memory, as in the demo.
- Settings that are not in the library: `chrome.storage.local`, key `zincBrowserLibrary`, holds `{saveTarget: "app" | "browser", firstRunDone: boolean}`.
- The zotero.org API key: `chrome.storage.local` key `zincZoteroApiKey`. It is read only in the offscreen document or worker, never sent to a tab.

## zotero.org sync (WP S)

`db-worker.ts` calls `startBrowserSync` (`sync.ts`) after `openDb`: `setDefaultKeyStore(chromeKeyStore(...))`, then the sync options `{ fileRedirect: "follow", apiBase }`. The service starts at once when the library's sync mode (`syncMode(db)`) is `zotero-org`; otherwise the options are only registered, so Settings > Sync > "zotero.org" (`POST /api/websync/mode`) starts it later. Settings > Sync talks to `/api/websync/*` through the normal `api` frames; nothing else is needed.

- **The key never leaves the worker side.** A worker has no `chrome`, and an offscreen document has only `chrome.runtime` (no `chrome.storage`; measured by the check). So the key store is `chromeKeyStore(area)` with a proxy area (`sync-storage.ts`): worker -> offscreen `{t:"storage", rid, op, name, value}`, answered `{t:"storage-res", rid, value|error}` (`offscreen.ts`). The offscreen page uses `chrome.storage.local` when it has it; otherwise it asks the extension's service worker: `chrome.runtime.sendMessage({zincStorage: {op: "get"|"set"|"remove", name, value}})`, answered `{ok: true, value}` or `{ok: false, error}`. **The connector's background must implement that handler.** Reference: `test-background.js`. It must accept the message only from the library's offscreen document (`sender.id === chrome.runtime.id` and `sender.url` = `.../library/offscreen.html`), only for the names `zincZoteroApiKey` and `zincTestZoteroApiBase`, and only write the key. The offscreen page refuses any other name and any write to the override.
- **Test-only API base.** The API base is `https://api.zotero.org`. `chrome.storage.local` key `zincTestZoteroApiBase` replaces it only when its value matches `^http://127\.0\.0\.1:\d+$` (nothing else, not even `localhost`); it is read once when the worker starts. Only an extension page can set it, and the product never does. `web/browser-sync-check.ts` uses it to reach a local mock.
- **Manifest.** `host_permissions` for the file hosts (`<all_urls>` or the storage hosts), `declarativeNetRequest` with `browser-db/dnr-rules.json` as a static ruleset (it removes `Zotero-API-Key` from every request except those to `api.zotero.org`), and `storage`.
- `node:path` in the browser build (`web/shims/path.ts`) follows POSIX rules for `/`-rooted paths (case-sensitive); drive-letter and UNC paths keep their Windows reading.

## Checks

The checks use Chrome for Testing (`~/.cache/puppeteer/chrome/win64-*`) with a fresh profile under the agent's own work folder, and these CDP ports:
- A: 9351
- D: 9352
- E: 9353
- S (`web/browser-sync-check.ts`): 9354

A native-host registration in a check uses the name `com.zotero_next.connector_host_e2e_<wp>`, under `HKCU\Software\Chromium` only, and is removed at the end. Never touch `Software\Google\Chrome`, the installed host, the user's browser or `data/library.sqlite`. Chrome for Testing reads `Software\Google\Chrome\NativeMessagingHosts` as well as the Chromium key, and the installed host is registered under the Google key. So every `web/*-check.ts` calls `assertSafeToStart` from `web/check-safety.ts` before it starts Chrome: a generated extension's manifest has `zinc_test: true` (the library pages then never fall back to the real host name), a connector build is loaded as a copy with an unregistered host name (`makeConnectorTestCopy`), and the run is refused if a host name it uses, or a script it loads, names a host registered under the Google key. A new check must do the same.
