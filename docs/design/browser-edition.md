# Design note: Zinc in the browser (the connector as a full app)

Status: 2026-11-12. Branch `claude/connector-library-05fc7d`. The user took every recommendation in "Decisions for the user" below; store distribution is still open (it does not change the build). Building has started. The interfaces fixed for the parallel work are in `gpui-ui/web/browser-db/CONTRACT.md`, which overrides this note where they differ:
- The transport is the native host's own frame protocol over `chrome.runtime.connect({name: "zinc-db"})`, not a `BroadcastChannel`.
- Attachment files live in a second SQLite database behind the `node:fs` shim, not in plain OPFS files with a `FileStore` refactor. The core's file code stays synchronous and unchanged. It builds on `web-connector-wasm.md` (phases 2 and 3: the library tab and PDFs through the native host).

## The decision

The Zinc Connector extension ships the whole WebAssembly app. Next to the desktop app, it becomes a second way to use Zinc:

- **With the desktop app** (today): the library tab and the saves go through the native host to the library file on disk.
- **Browser only** (new): the library lives inside the browser, in the extension's private storage (OPFS, the origin private file system: a sandboxed folder only this extension can read). It syncs with zotero.org. No desktop app and no native host are needed, so it works on any OS with Chrome or Edge.

The user chose browser storage over a library file on disk or zotero.org-only access.

## 1. One owner for the database

SQLite in OPFS needs a *sync access handle* to a file. Browsers give those only to dedicated Web Workers, and only one handle per file at a time. The library can be used from several places at once: library tabs, the save popup, and the background service worker (which handles saves). A service worker cannot start Web Workers.

So one place owns the database:

```
library tab(s) ─┐
save popup ─────┼── BroadcastChannel "zinc-db" ──> offscreen document ──> DB worker
service worker ─┘    (request id, Request as plain data,                   (SQLite on OPFS,
                      Response back; ArrayBuffers copied)                   core handleApi,
                                                                            connector routes,
                                                                            websync)
```

- **Offscreen document** (`chrome.offscreen.createDocument`, reason `WORKERS`): a hidden extension page that the service worker creates on demand. It stays open while the browser runs. It starts the DB worker and passes messages through.
- **DB worker**: `@sqlite.org/sqlite-wasm` (already a dependency, 3.54) with the `opfs-sahpool` VFS. This VFS needs no SharedArrayBuffer, so the extension needs no cross-origin-isolation headers. It runs the core's `handleApi`, the connector routes (`core/src/connector/handlers.ts`), and websync, all against that one connection.
- **Transport**: the library tab already sends every `/api` request through one function (`setDirect`, `gpui-ui/src/api.ts`). Today that function talks to the native host. In browser mode it posts the request on the `BroadcastChannel` and waits for the answer with the same id. `BroadcastChannel` copies `ArrayBuffer`s directly, so PDFs need no base64 chunks (unlike native messaging).
- **Outside changes**: the worker posts `{changed: dataVersion}` on the channel after every write. Tabs refresh as they do now (`shell/outsideChanges.ts`), without polling.

A bonus: SQL runs off the tab's main thread, so large queries no longer pause scrolling.

## 2. The library in OPFS

```
OPFS (extension origin)
  zinc/
    library.sqlite            (opfs-sahpool keeps it in its own pool files; it is exported and imported as one file)
    storage/<KEY>/<filename>  (attachment files, the same layout as on disk)
    settings.json             (save target, sync state that is not in the database)
```

- **Schema**: the same schema and migrations as the desktop (`core/schema.sql` + `core/src/migrations`). `openDb` creates and migrates an empty library, as it does on disk. Backups before a migration go to `zinc/backups/` (one at most, since space is limited).
- **Space**: add the `unlimitedStorage` permission. Without it, the browser may clear the storage when the disk is low. With it, the data stays until the extension is removed.
- **Uninstalling the extension deletes the library.** This is the main risk of browser storage. Two protections:
  1. zotero.org sync, which is the backup.
  2. **Export library** in Settings: downloads `library.sqlite` and the `storage` folder as one zip. The desktop app can open it.

  The first-run screen and Settings say this plainly.

### First run

The library tab opens a short welcome screen with three choices:

1. **Start with an empty library.**
2. **Sign in to zotero.org and download my library.** This stores the API key and runs a full websync pull. Files download in the background, PDFs first.
3. **Import a Zotero or Zinc data folder.** A folder picker (`showDirectoryPicker`, which works in extension pages) reads `zotero.sqlite` or `library.sqlite` and its `storage` folder. It uses the existing importer (`core/src/import`).

## 3. Attachment files in OPFS

Today the core reads and writes files with `node:fs`: `addFile`, `serveFile` (`GET /api/attachments/<key>/file`), `websync/files.ts` and connector attachments. In the browser, `node:fs` is an in-memory shim that loses everything on reload.

The plan is a file layer in the DB worker that keeps the core's sync calls:

- **Reads**: `readFileSync`/`stat` on `storage/...` open a sync access handle, read, and close it. Sync access handles are available only in the worker, which is where this code runs.
- **Writes**: `writeFileSync`, `renameSync`, `mkdirSync` and `rmSync` map to OPFS calls in the same way.
- **The catch**: opening a handle (`createSyncAccessHandle`) is async, but the core's calls are sync. Two ways out:
  1. Change the few core functions that touch attachment files to async (`addFile`, `serveFile`, websync `downloadOne`/`uploadOne`, connector `storeWebAttachment`). `serveFile` already uses `fs/promises`.
  2. Keep a pool of handles open, as `opfs-sahpool` does for the database.

  **Recommendation**: option 1, behind a small `FileStore` interface (read, write, rename, remove, size) with a Node version and an OPFS version. It touches about six functions and keeps the desktop unchanged.
- **Paths**: `attachments.path` stays absolute, under a fixed virtual root (`/opfs/zinc/storage/<KEY>/<file>`). `storageRoot()` derives it from `db.filename` as it does today.
- **Linked files** (`linked_file`, files outside the library) cannot be reached from the browser. They show as "file not available in the browser". Zotero's own sync does not upload them either.

## 4. zotero.org sync from the browser

`core/src/websync` already uses `fetch`, and `fetch` can be swapped (`client.ts`). The gaps are:

| Gap | Where | Fix |
|---|---|---|
| API key storage uses `Bun.secrets` | `websync/keystore.ts` | A `KeyStore` backed by `chrome.storage.local` (the class can already be swapped: `opts.keyStore`). This is not encrypted at rest, but only this extension can read it. The key is never sent to tabs: only the worker reads it. |
| File download uses `redirect: "manual"` and reads `Location` | `websync/files.ts:179` | In a browser, a manual redirect gives an opaque response with no headers. Use `redirect: "follow"`, then remove the `Zotero-API-Key` header for every host except `api.zotero.org` with a `declarativeNetRequest` rule. Otherwise the key would go to the file host. |
| MD5 for file checks | `websync/files.ts` (`node:crypto`) | The browser shim's `createHash` is FNV, not MD5 (`web/shims/small.ts`). Web Crypto has no MD5. Add a small MD5 (about 2 kB) to the shim. |
| Snapshot zips use `inflateRawSync` | `websync/zip.ts` | `fflate` (already a dev dependency) in the browser shim. |
| `dataDir` from `process.cwd()` | `websync/service.ts:124` | Pass the OPFS root. |

**Permissions** (`manifest.json`):
- `host_permissions`: `https://api.zotero.org/*`, plus the file hosts. Downloads redirect to S3 and uploads go to the URL the API returns. The connector already asks for `http://*/*` and `https://*/*`, which cover both.
- `declarativeNetRequest`: for the header rule above.
- `offscreen` and `unlimitedStorage`.

**Signing in**: version 1 asks the user to paste an API key made at zotero.org/settings/keys, with a link and the exact rights to tick (library read/write, notes, files). "Log in with zotero.org" needs OAuth 1.0a, which means registering an app with Zotero. In an extension its client secret is public. This is a later step (decision 1 below).

**When sync runs**: when the library tab opens, every 5 minutes while the offscreen document is alive, and after a save (debounced by 30 s). Files are fetched on demand when a PDF is opened, or all at once if the user chooses that in Settings.

## 5. Saving from the connector

Today the background sends every save (`saveItems`, `saveSnapshot`, attachment uploads, `updateSession`) to the native host, which runs the core's connector routes on the library file.

In browser mode the same calls go to the DB worker, which runs the same `connectorRoutes`:

- `SessionManager` is a plain in-memory map (`core/src/connector/session.ts`). It lives in the worker, so the popup's Remove and Cancel work as they do now (`trashSession`, `cancelSession`, moved from the host into a shared module).
- PDFs: the worker downloads them with `fetch`, using the extension's host permissions. Unlike a page, this fetch may not carry the site's cookies. So keep the connector's own download path for PDFs behind a login (the page context downloads, then uploads the bytes, as Zotero's `saveAttachment` does).
- The connector's `browserGuard` and header checks are skipped: the call never leaves the extension.
- Full-text indexing of saved PDFs: the core extracts text with Zotero's document worker (`core/src/extract`), which the browser build leaves out. The DB worker uses PDFium's page text instead (`gpui-ui/web/pdf-engine.ts`, `pageText`), through a small adapter.

## 6. Living next to the desktop app

On a machine with the desktop app and the native host, there are two libraries: the file on disk and the one in the browser.

- **Which library a save goes to**: a setting with two values, **Zinc app** and **This browser**. The first run picks it:
  - if the native host answers `ping`: **Zinc app** (as today)
  - otherwise: **This browser**

  It never switches by itself. If the app is chosen but the host stops answering, the popup says so and offers **Save to this browser instead** for this save. The popup always shows the target ("Saving to: Zinc app" / "Saving to: This browser").
- **Open library** opens the browser library tab in browser mode. In app mode it opens the native-host tab (phases 2 and 3). The tab's title bar shows which library it is.
- **Open in Zinc** (desktop) is offered only in app mode.
- **Both synced to the same zotero.org account**: the two libraries meet through zotero.org, so either target is safe. Without sync they stay separate. Settings offers **Copy browser library into the Zinc app** (a one-way import through the host's `api` method, items and files) for users who start in the browser and install the app later.

## 7. What happens to the browser-edition zip

Today the release workflow (`.github/workflows/web.yml`) publishes `Zinc-Web-<tag>.zip`. It is a progressive web app (installable web page) with a demo library in memory. Changes are lost when the tab closes.

The extension does everything the zip does, and keeps the data. Recommendation:

- Stop publishing the zip. The extension becomes the browser option on the download page.
- Keep the in-memory demo as an online "try it" page, if one is hosted (not built or published by this work).
- Share the build: `bun web/build.ts --target extension` stays the one browser build. The demo becomes `--target demo` from the same entry code.

The main session owns the download page and install docs (`website/src/pages/download.astro`, `docs/user-guide/install.md`). This work does not change them.

## 8. Size

The extension today, with the library page and without the document worker, is 35.6 MB unpacked and about 11 MB zipped. Browser mode adds the DB worker (sqlite-wasm and `opfs-sahpool`: already in the build), the offscreen page and MD5. That is under 0.5 MB. Both stores accept it. Store review of a 20 MB WebAssembly file is the open risk noted in `web-connector-wasm.md`.

## 9. Plan: steps, each with a headless check

The checks use Chrome for Testing with a fresh profile and a minimal extension, as in phases 2 and 3. They never touch the user's browser, the native host or `data/library.sqlite`. zotero.org is replaced by a local mock server that answers the Web API routes websync uses. The core's websync tests already mock it, and the check reuses those mocks. A real account is never used in a test.

| Step | Work | Headless check | Effort |
|---|---|---|---|
| B1. Library in OPFS | DB worker (`opfs-sahpool`), offscreen document, `BroadcastChannel` transport, `extension.tsx` browser mode, change notices, the first-run screen (empty library only) | Create a collection and an item in the tab, reload the tab, restart the browser on the same profile: both still there. A second tab sees the change within 1 s. | 4–5 days |
| B2. Files | `FileStore` in the core (Node and OPFS versions), adding a PDF (drag and drop, file picker), the reader on OPFS files, annotations | Add the 11 MB fixture PDF, open it, highlight, reload: the highlight and the file are still there. | 3–4 days |
| B3. Saves into the browser library | Save target setting, routing in the connector background, sessions in the worker, the popup showing the target | The popup check (`web/popup-check.ts`) in browser mode with no host registered: the item and its PDF land in OPFS. Remove and Cancel work. | 3–4 days |
| B4. zotero.org sync | `KeyStore` on `chrome.storage`, the redirect and header rule, MD5, fflate, sync settings UI, sync timing | Against the mock server: first sign-in downloads a fixture library with files. An edit in the tab is uploaded. A server change shows up in the tab. The key never appears in a tab or a request to the file host. | 5–7 days |
| B5. Import, export, coexistence | Folder import, Export library, "Copy into the Zinc app", uninstall warning, user guide | Import the fixture data folder; export and re-open the zip with the core; copy into a fixture host library. | 3–4 days |

Total: about 4 weeks.

Not planned: Firefox (no offscreen documents; it would need a different owner for the database), group libraries in browser mode (websync supports them, but the UI to pick groups comes later), WebDAV file sync (the core has none), Word or LibreOffice integration (needs a desktop program).

## Decisions for the user

1. **Sign-in**: paste an API key in version 1 (recommended; works now), or "Log in with zotero.org" through OAuth (needs an app registered with Zotero; later).
2. **Save target on a machine with both**: pick once at first run (the app if its host answers), shown in the popup, never switched silently (recommended). The other choice is to save to both. That would mean two copies of every item until sync merges them, so it is not recommended.
3. **The Zinc-Web zip**: stop publishing it, so the extension is the browser option (recommended).
4. **Uninstall risk**: is "sync plus Export library, with a warning at first run" enough (recommended)? The other way is a library file in a folder the user picks, through the File System Access API. The browser asks again for permission to that folder after a restart, and SQLite cannot use such a file the way it uses OPFS, so it would need a copy in OPFS anyway. Not recommended.
5. **Store distribution**: whether the extension will go to the Chrome Web Store and Edge Add-ons (review of the WebAssembly, the `unlimitedStorage` and `<all_urls>` reasons) or stay a private unpacked or self-hosted install. This changes nothing in the build. It affects the review text and the install docs.
