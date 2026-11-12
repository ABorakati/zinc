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

## Storage (OPFS, extension origin)

- Database: `@sqlite.org/sqlite-wasm`, VFS `opfs-sahpool` (pool directory `.zinc-sahpool`), database name `/zinc/library.sqlite`. The core sees `db.filename === "/opfs/zinc/library.sqlite"`, so `storageRoot()` is `/opfs/zinc/storage`.
- Files: everything the core writes under `/opfs/` goes through the `node:fs` shim into a second database in the same pool, `/zinc/files.sqlite`:
  - table `files(path TEXT PRIMARY KEY, data BLOB NOT NULL, mtime INTEGER NOT NULL)`
  - table `dirs(path TEXT PRIMARY KEY)`

  Paths are stored lower-cased, as the shim keys them. The core's file code stays synchronous and unchanged. Other paths stay in memory, as in the demo.
- Settings that are not in the library: `chrome.storage.local`, key `zincBrowserLibrary`, holds `{saveTarget: "app" | "browser", firstRunDone: boolean}`.
- The zotero.org API key: `chrome.storage.local` key `zincZoteroApiKey`. It is read only in the offscreen document or worker, never sent to a tab.

## Checks

The checks use Chrome for Testing (`~/.cache/puppeteer/chrome/win64-*`) with a fresh profile under the agent's own work folder, and these CDP ports:
- A: 9351
- D: 9352
- E: 9353

A native-host registration in a check uses the name `com.zotero_next.connector_host_e2e_<wp>`, under `HKCU\Software\Chromium` only, and is removed at the end. Never touch `Software\Google\Chrome`, the installed host, the user's browser or `data/library.sqlite`.
