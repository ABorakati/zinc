# Design note: the Zinc app inside the browser connector

Status: feasibility study, 2026-11-12. Branch `claude/web-connector-wasm-ab739d`.

Question: can the Zinc Connector (the browser extension) embed the WebAssembly build of the app, so people can open their library and PDFs in the browser, and get an "Open in Zinc" action that shows a saved reference in the desktop app?

Short answer: yes. The WebAssembly app runs unchanged as a Manifest V3 extension page (tested, see 2). The best data source is the connector's existing native-messaging host, which already runs the core against the library file (see 1). "Open in Zinc" works today through that host and the app's `/api/ui/reveal` route, once the app acts on reveal requests. This branch adds that part (see 4).

## What exists today

| Piece | Where | What it does |
|---|---|---|
| Zinc Connector | `C:\Users\abora\zotero-next-connector` (separate repo, fork of Zotero Connectors, Chrome MV3) | Saves pages. Every connector call goes over Chrome native messaging (`src/browserExt/nativeHost.js`), not HTTP. |
| Native host | `connector-host/` | `zotero-next-host.exe`, started by Chrome on demand. Runs the core's connector handlers against `library.sqlite` (WAL, safe next to the running app). Frames: 4-byte length + JSON; host-to-browser messages are cut into chunks under 1 MB. |
| Browser build of the app | `gpui-ui/web/` (`build.ts`, `main.tsx`, `sqlite.ts`, `pdf.ts`), CI job "Browser build" (`.github/workflows/web.yml`) | The real UI (GPUI compiled to WebAssembly, GPUIX `browser.mjs`) on the real core (`core/src/api.ts` `handleApi`), SQLite WebAssembly, PDFium WebAssembly. A demo library loaded into memory. |
| UI-to-core seam | `gpui-ui/src/api.ts` `setDirect()` | The UI sends every API call as a `Request` to one function. The desktop app points it at the in-process core or loopback HTTP. The web build points it at `handleApi(req, db)` in the tab (`gpui-ui/web/main.tsx`). |
| Reveal route | `core/src/connector/ui.ts` | `POST /api/ui/reveal {key}` stores "show this item"; `GET /api/ui/selection` returns it with a sequence number. Used by the Word add-in (`word/addin/ZnClient.cs` `Reveal`, which also starts the app and raises its window). |

## 1. Where the data comes from

| Option | How | For | Against |
|---|---|---|---|
| **A. Native host (recommended)** | The extension page sets `setDirect` to a function that sends the `Request` over native messaging. The host runs `handleApi(req, db)` on the library file and sends the `Response` back in chunks. | Works when the app is closed. No port, no CORS (cross-origin rules), no origin check. The same core code as the desktop, so writes, sync outbox and full text behave the same. Linked files and stored files are both readable, because the host has disk access. The host only answers the pinned extension id (`allowed_origins`). | The host exe gets the whole API (larger binary). Every PDF passes through base64 chunks of under 1 MB (about 1.33× the bytes; not measured yet). The host install is Windows-only today (`connector-host/install.ps1`); macOS and Linux need a manifest file in Chrome's `NativeMessagingHosts` folder and a host build for that OS (`bun build --compile` can target both). |
| B. Running app's loopback API | The extension page fetches `http://127.0.0.1:23120/api/...` with `host_permissions`. | No new process. The page sees exactly what the open app sees. | Works only while the app runs. POSTs are refused: `apiRequestRejected()` in `core/src/server.ts` answers 403 to a body request whose `Origin` (here `chrome-extension://…`) is not the server's own. Allowing the pinned extension origin is a small change, but it widens the API's attack surface. The port can move: `gpui-ui/src/packaged.ts` takes another port when 23120 is busy. |
| C. Zotero Web API (`api.zotero.org`) | Run `core/src/websync` in the page against an in-browser SQLite stored in OPFS (origin private file system: browser-managed disk storage). | Needs no desktop app, so it works on any computer. The Web API allows CORS. | A product of its own, not a connector feature. The Zotero API key would live in extension storage. A full library download on first use. Only files synced to Zotero storage or WebDAV; linked files are missing. `websync` uses Node-only modules that the browser build stubs today. |
| D. Offline copy | Load `library.sqlite` bytes into the page, as the demo does. | Simple, works offline. | The real library is 397 MB: too big to hold in memory and slow to start. A snapshot goes stale and cannot be written back safely. It would need SQLite's OPFS storage (the `opfs-sahpool` storage needs no cross-origin isolation). Useful at most as a read-only travel copy. |

Recommendation: A for the connector. Keep B as a fallback when the host is not installed. C is a separate "Zinc on the web" project.

One fix is needed for any of these. `gpui-ui/src/shell/net.ts` `call()` always fetches `BASE_URL` (default `http://127.0.0.1:23160`) instead of going through `setDirect`. In the probe below the web build tried `http://127.0.0.1:23160/api/sync/status` every 5 s (`gpui-ui/src/sync/state.ts`). In an extension with loopback permissions this would reach whatever listens there. Route `call()` through `apiRequest`.

## 2. Does the WebAssembly app load in an MV3 extension page?

Tested. The built demo (`website/public/app-demo/`, built 2026-11-08) was copied unchanged into a throwaway extension with this manifest policy:

```json
"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }
```

It was loaded into Chrome for Testing 151, headless, through CDP (the Chrome DevTools Protocol). Results:

- The page ran from `chrome-extension://<id>/index.html?open=demo`. GPUI's canvas appeared 0.6 s after reload. The library loaded, and the demo PDF opened in the reader (title "Demo review", page 1 of 3 drawn, thumbnails drawn).
- Graphics: GPUI chose WebGPU (`gpui_wgpu … selected=BrowserWebGpu`).
- No CSP (content security policy) violations were logged. JS heap: 56 MB.
- Same behaviour as the http:// copy, apart from the loopback poll in 1.

Points to handle in an extension build:

- The inline `<script>` that registers the service worker (`gpui-ui/web/build.ts`, the `index.html` template) is blocked by MV3. Drop it, with `sw.js` and the web-app manifest: extension files are local already.
- The GPUI glue imports `eval` (`wasm-bindgen`'s `js_sys::eval`) and has a blob-URL worker helper (`__wbindgen_link`). Neither ran in the test. MV3 forbids both, so a code path that uses them will fail. Test the full UI (dialogs, clipboard, drag and drop) before release.
- MV3 forbids remote code. Every `.wasm` and worker file must be inside the package, including Zotero's document worker (layout analysis).
- Workers: the SQLite worker and the document worker are package files (`'self'`), so they are allowed.
- WebGPU: on by default in Chrome on Windows, macOS and ChromeOS. Untested where WebGPU is missing (some Linux setups). The GPUI log suggests it can pick another backend.

Size of the package (the demo build, measured):

| File | Raw | gzip |
|---|---|---|
| `gpuix-web_bg.wasm` (GPUI UI) | 20.1 MB | 6.7 MB |
| `pdfium.wasm` | 4.6 MB | 2.1 MB |
| `fulltext.wasm` | 1.2 MB | 0.45 MB |
| `sqlite3.wasm` | 0.9 MB | 0.4 MB |
| JavaScript chunks | 3.6 MB | |
| `icons.json` (Lucide icons) | 1.3 MB | |
| `docworker/` (layout analysis, optional) | 30 MB | |
| **Whole build as a zip** | **61 MB** | **25.1 MB** (10.7 MB without `docworker/`) |

The extension today is a few MB. With the app it grows to about 11 MB (or 25 MB with layout analysis). Both are well inside store limits. Ship it as a full-tab page (`library.html`, opened from the toolbar menu), not as the popup (the popup is limited to 800 × 600).

## 3. PDFs in the browser

`gpui-ui/web/pdf.ts` gives the reader the same `PdfDoc` interface as the native `zn_pdf` library, on PDFium compiled to WebAssembly (`@embedpdf/pdfium`). It loads on the first PDF opened. Measured in Bun on this machine at 144 dpi (`scale` 2), against `zn_pdf.dll`:

| PDF | Engine | First page | Next pages | Text layer |
|---|---|---|---|---|
| Demo article (3 pages) | native | 28 ms | 8 ms/page | 5 ms/page |
| | WebAssembly | 63 ms | 21 ms/page | 13 ms/page |
| 9.9 MB journal article (first 6 pages) | native | 33 ms | 157 ms/page | 51 ms/page |
| | WebAssembly | 57 ms | 329 ms/page | 212 ms/page |

PDFium start-up: 50–90 ms. So the WebAssembly build renders about 2× slower and builds text layers 2.5–4× slower. It also runs on one thread (the page's main thread, behind a timer), while the native library uses a pool of threads. Reading is fine; fast scrolling through a long, image-heavy PDF will show blank pages for longer. Moving rendering into a Web Worker, or several, is the main speed fix.

Not available in the browser: page editing and printing (`pdfOpsUnavailable`). Layout analysis needs the 30 MB document worker.

The bytes come from `GET /api/attachments/<key>/file`. With option A that goes through the host, so linked files work too. Plan for chunked transfer: a 10 MB PDF is about 14 host messages.

## 4. "Open in Zinc"

What happens today:

- `POST /api/ui/reveal` exists, and the Word add-in calls it. The GPUI app never read the request, so the call answered `ok` and nothing happened. **Fixed on this branch** (below).
- `ZN_OPEN_TABS` (`gpui-ui/src/main.tsx`) is a measurement aid: an environment variable read once at start-up. It cannot reach a running app. The same pattern could serve a future `--open <key>` argument.
- No `zinc://` scheme is registered anywhere.

The choices:

| Mechanism | For | Against |
|---|---|---|
| **Native messaging → host → `/api/ui/reveal` (recommended where the host is installed)** | No browser prompt. Starts the app when it is closed, waits for its API, then reports success or the error. Uses the channel the connector already depends on. | Needs the host. On Windows, check that Chrome's job object does not end an app the host started (the host starts it detached; `explorer.exe <exe>` is the fallback). Raising the window needs `SetForegroundWindow`, as the Word add-in does. |
| `zinc://` URL scheme | Works from any web page, note or app, without the extension. | Chrome asks "Open Zinc?" once per site (it remembers the choice). The page gets no result. The app must forward to a running copy: today a second launch starts a second window on another port (`packaged.ts`). |
| Extension `fetch` to the loopback API | No host. | Refused by the API's origin check (needs a server change). Only works while the app runs. Cannot start the app. |

Per OS:

- **Windows**: native messaging (prototype on this branch). Register `zinc://` as well, in the Inno Setup installer (`gpui-ui/installer`): `HKCU\Software\Classes\zinc` with `URL Protocol` and `shell\open\command = "<exe>" "%1"`. On start with a `zinc://` argument, the app posts `/api/ui/reveal` to an already running copy and exits.
- **macOS**: native messaging works the same (host manifest in `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`; start the app with `open -b <bundle id>`). For `zinc://`, add `CFBundleURLTypes` to `Info.plist` and handle the "open URL" Apple event. Check whether GPUIX passes GPUI's `on_open_urls` through.
- **Linux**: native host manifest in `~/.config/google-chrome/NativeMessagingHosts/`. `zinc://` through a `.desktop` file with `MimeType=x-scheme-handler/zinc;` and `xdg-mime default`.

Use Zotero's URL grammar under the new scheme, so `keyOfUri()` in `gpui-ui/src/webview/noteLinks.ts` parses it: `zinc://select/library/items/<KEY>` and `zinc://open-pdf/library/items/<KEY>?page=<n>`.

### Prototype on this branch

- `gpui-ui/src/shell/revealRequests.ts` (+ test): the app polls `GET /api/ui/selection` every 1.5 s. On a new reveal sequence number it switches to the library tab and selects the item. Started from `gpui-ui/src/main.tsx` after the first page is drawn. This also makes the Word add-in's "Open in Zinc" work in the GPUI app.
- `connector-host/src/reveal.ts` (+ `test/reveal.test.ts`, 9 tests): host method `revealInApp` with body `{key}`. If the app's API answers, it posts the reveal. If not, it starts the app (`ZN_LAUNCHER`, then `%LOCALAPPDATA%\Programs\Zinc\zotero-next-gpui.exe`), waits up to 40 s, then posts. It answers `{ok, started, error?}`.
- The extension side (in the connector repo, not changed here) is one call, for example from the save progress window or a context menu:

```js
const res = await Zotero.NativeHost.request({ method: "revealInApp", http: "POST", body: { kind: "text", text: JSON.stringify({ key }) } });
```

Not verified on this branch: the app in a real window acting on a reveal (only the unit tests and type checks ran), the window coming to the front, and an app start from a Chrome-launched host.

## 5. Plan

| Phase | Work | Effort |
|---|---|---|
| 0 (done here) | App acts on reveal requests; host method `revealInApp`. | done |
| 1. Open in Zinc | Extension: "Open in Zinc" after a save (check that the save session can return the new item's key) and on the toolbar menu. Host: raise the app window (`AllowSetForegroundWindow`). Installer: register `zinc://`. App: forward a `zinc://` argument to a running copy, then exit. | 2–3 days |
| 2. Library in the extension | A `--target extension` mode for `gpui-ui/web/build.ts`: no inline script, no service worker, a manifest with `wasm-unsafe-eval`, and an entry that sets `setDirect` to the native-messaging transport instead of loading a demo database. Host: a method that forwards `/api/*` to `handleApi` (allow-list, chunked responses, uploads through the existing `up` frames). Fix `shell/net.ts` `call()`. Notice database changes from the app (`PRAGMA data_version`, as `ui.ts` does). Start read-mostly, then enable editing. | 1.5–2 weeks |
| 3. PDFs (done, section 8) | Attachment bytes through the host. Render in Web Workers. Save annotations through the same API. Decide whether to ship the document worker (+14 MB zipped): not shipped. | 1 week |
| 4. macOS and Linux | Host builds and manifests, `zinc://` registration, install steps. | 3–5 days |
| 5. Zinc in the browser | Option C, now chosen: the extension as a full app with its own library in OPFS, synced with zotero.org. Design: `browser-edition.md`. | about 4 weeks |

Main risks: a GPUI code path that needs `eval` or blob workers (blocked by MV3); WebGPU missing on some machines; store review of a 20 MB WebAssembly file (check the store rules on compiled code before submitting); Chrome ending an app that the host started.

## 6. Phase 2 built: the library in the connector

Status: 2026-11-12. Branches: `claude/connector-library-05fc7d` (zotero-next) and `connector-library` (zotero-next-connector, worktree `C:\Users\abora\zotero-next-connector-library`). Not merged, not pushed.

What was built:

| Piece | Where | What it does |
|---|---|---|
| Host method `api` | `connector-host/src/api.ts`, wired in `dispatch.ts` | Sends a `/api/*` request to the core's `handleApi` on the library file. Answers use the existing `res`/`rc` chunks (frames under 1 MB). Bodies come inline or as `up` frames. Allow-list: GET and HEAD everywhere except `/api/sync/`, `/api/websync/` and `/api/integrations/`. The only write is `POST /api/ui/selection` (kept in host memory). Everything else answers 403. `handleApi` is loaded on the first `api` call, so `ping` and saves stay fast. Tests: `connector-host/test/api.test.ts` (9). |
| Page transport | `gpui-ui/web/native-host.ts` (+ test) | A `fetch`-like function over `chrome.runtime.connectNative`. The page opens its own port, so it gets its own host process and database connection. Reconnects after the host goes away. |
| Outside changes | `gpui-ui/src/shell/outsideChanges.ts` (+ test) | Polls `ext` (`PRAGMA data_version`) from `GET /api/ui/selection` every 2 s, while the tab is visible. When it moves, it calls `store.refresh()`. |
| Extension build | `gpui-ui/web/extension.tsx`, `bun web/build.ts --target extension` | Writes `gpui-ui/dist-extension/` (87 files, 30.5 MB): `library.html` with module scripts only. No inline script, service worker or web-app manifest. Every `.wasm` file is inside. The document worker is left out unless `--docworker` is given. |
| Connector | `scripts/build-win.ts` step 6, `src/browserExt/background.js`, `manifest-v3.json` | The build copies the page into `library/` (from `--library <dir>`, `ZINC_LIBRARY_DIST`, or `../zotero-next/gpui-ui/dist-extension`). The toolbar button's right-click menu gets "Open Zinc library", which opens the page or focuses an open one. The item is hidden when the build has no page. `extension_pages` CSP: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`. Package: 35.6 MB unpacked. |
| Headless check | `gpui-ui/web/extension-check.ts` | Builds a fixture library (`web/demo-library.ts`) and compiles the host. Registers it as `com.zotero_next.connector_host_e2e` under `HKCU\Software\Chromium` and never writes `Software\Google\Chrome`. Chrome for Testing reads both keys, and the installed host (`com.zotero_next.connector_host`, the user's real library) is registered under the Google one. So every headless check calls `web/check-safety.ts` before it starts Chrome: it loads a test copy of the connector (real host name replaced by an unregistered one) or an extension whose manifest has `zinc_test: true` (the library pages then never default to the real name), and it refuses to start if anything it loads could reach a name registered under the Google key. The check opens the page with `?host=` that name. It first confirms which library the host serves. Then it checks the list, a collection, an item's details and an outside write, takes screenshots, and removes the registration, the profile and the host. |

Result of the headless check (Chrome for Testing 151): 7/7 checks passed. The fixture's 19 items loaded, "Thesis" opened with 6 items, the item pane showed "Attention Is All You Need", and an item written by another process appeared within the 2 s poll. There were no CSP violations and no page errors. The only refused requests were the sync status poll (403).

Try it:

1. In `zotero-next/gpui-ui`: `bun web/build.ts --target extension`.
2. In the connector worktree: `bun scripts/build-win.ts --library <zotero-next>/gpui-ui/dist-extension`.
3. Rebuild and reinstall the host (`connector-host`: `bun run build`, then `install.ps1`). The installed host must have the `api` method.
4. Load `build/manifestv3` unpacked, then right-click the toolbar button and choose **Open Zinc library**.
5. Or headless, without touching the installed host: in `gpui-ui`, `bun web/extension-check.ts --ext <connector>/build/manifestv3`.

What is left:

- Editing. The UI still shows Add, edit fields and the drag targets, but those requests answer 403. Next: enable writes route by route in `connector-host/src/api.ts` (item fields, tags, collections, trash). Each needs the sync outbox check that the desktop core already does, and a read-only mode in the UI until then.
- The sync status poll (`/api/sync/status`) is refused every 5 s. Either let a sanitised status through, or skip the poll in the extension build.
- PDFs (phase 3). The reader's file fetch is wired through the host, but no PDF was opened in the test.
- Collection colours and icons (`collection-style.json`) live in the app's config folder, not the library, so the page shows the defaults. Serve them through an API route if they should match.
- The host binary now contains the whole API: 118.8 MB, against 118.1 MB for the October build. The Bun runtime is most of it, so "larger binary" in section 1 is only 0.7 MB.
- The real Chrome registration still points at the installed host, which has no `api` method until it is rebuilt and reinstalled.

## 7. The save popup (Zinc look, folder picker, Remove and Cancel)

Status: 2026-11-12, same branches as section 6. The toolbar button now opens a popup directly under it, in place of upstream's in-page progress window.

| Piece | Where | What it does |
|---|---|---|
| Popup page | connector `src/browserExt/popup/` (`popup.html`, `popup.css`, `popup.js`, Inter, Lucide icons) | 360 px wide. Inter at 13 px, the app's "Quiet Paper" colours (`gpui-ui/src/shell/schemes.ts`) and radii (6 / 8 px). Follows the system light or dark setting. Shows the save's status and items with attachment progress. Then: a collection picker, the actions Open item, Open in Zinc and Open library, and Cancel while saving or Remove after. |
| Controller | connector `src/browserExt/savePopup.js` (loaded after `background.js`) | Wraps `Zotero.Messaging.sendMessage`, which carries every `progressWindow.*` event from the page to the tab. It keeps each tab's save state and pushes it to the open popup over a port. While a popup owns the save, the in-page window gets nothing, so it stays hidden. Clicking the button (`default_popup`) opens the popup, and the popup starts the save at once, as the click did before. If a save is still running, or its result was not seen yet, the popup shows that save instead of saving again. Saves started another way (context menu, in-page button) call `action.openPopup()`. When the browser refuses, the in-page window shows as before. |
| Collection picker | `popup.js` | The current target at the top. A search field (name or parent path; arrow keys and Enter work). Up to 4 recent targets as one-click chips (`chrome.storage.local` `zincRecentTargets`). The collection tree with indentation. Choosing a collection moves the saved item through `updateSession`, the call the in-page window used. A choice made before the save reached the library is applied when it does. |
| Remove / Cancel | connector-host `src/sessions.ts`, methods `sessionItems`, `trashSession`, `cancelSession` | Remove moves the session's own top-level items to the Trash (`deleted = 1`, the app's soft delete, synced and restorable). It only touches items the session created, added after the session started. Cancel does the same, and the host then refuses the save's later calls (409 `SESSION_CANCELLED`): a PDF still downloading is never stored. If Cancel races a `saveItems` call, what that call creates is trashed when it returns. These are host methods, not `/api` routes, so the library page cannot call them. |
| Open item / Open in Zinc | core `connector/ui.ts` (`POST /api/ui/reveal {key, open}`), host `revealInApp {key, open}`, app `shell/revealRequests.ts` + `main.tsx` | Open in Zinc selects the item in the desktop app, starting the app if needed. Open item also opens the item's PDF, else its EPUB, else its snapshot, in the app's reader (the core picks it). Without a file it only selects. |
| Open library | connector `background.js` `openLibrary(key)`, `gpui-ui/web/extension.tsx` | Opens `library/library.html?select=<key>`, or sends `{zincLibrarySelect: key}` to an open one, which reloads its lists and selects the item. |
| Test hook | connector `nativeHost.js` `useHostForTests(name)` | Points the background at another host registration (`com.zotero_next.*` only). Used by the headless check. |

Headless check (`gpui-ui/web/popup-check.ts`, Chrome for Testing 151): 15/15 checks passed. It uses the same safety rules as section 6, and the background is pointed at the test host before anything is saved. A local server gives two fixture articles with `citation_*` metadata and a PDF sent slowly. The check confirms:
- the translator is found, and the popup shows the save while it runs while the in-page window stays hidden
- after the save, the item and its PDF are in the library
- searching the picker and pressing Enter moves the item to "Thesis", and the choice is remembered as recent
- Open in Zinc asks the host and shows its answer (the app lookup is off in the test)
- Open library opens the page, which selects the item
- Remove trashes the item
- a second save, cancelled during its PDF, ends with its item in the Trash and no PDF stored
- there were no exceptions in the popup or the background

Screenshots, light and dark, during and after a save: `<work>/shots/1-saving-light.png` … `7-cancelled-dark.png`. Also new: host tests `test/sessions.test.ts` (6) and a `revealInApp` open test; core `reveal.test.ts` (+1); app `revealRequests.test.ts` (+1).

Try it: build as in section 6. The host must be rebuilt and reinstalled: the popup's Remove, Cancel and the saved-item list need its new methods. Then click the toolbar button on an article page. Or headless: in `gpui-ui`, `bun web/popup-check.ts --ext <connector>/build/manifestv3`.

Not verified, or left:

- `action.openPopup()` for saves from the context menu cannot be seen in a headless browser. It needs a check in a real window. If the browser refuses, the in-page window is the fallback.
- Tags and a note on the saved item: the old in-page window had them, the popup does not yet. `updateSession` takes both, so it is UI work only.
- Saving several items from a "Select items" page: the progress rows and Remove work per session, but no multi-item page was tried.
- The popup's strings are English only (upstream's are translated).
- Open item needs the desktop app. The browser library page opens PDFs since phase 3 (section 8), but the popup's Open item still goes to the app.

## 8. Phase 3 built: PDFs in the library tab

Status: 2026-11-12, branch `claude/connector-library-05fc7d`. No connector changes were needed.

| Piece | Where | What it does |
|---|---|---|
| File bytes | `gpui-ui/web/extension.tsx` (`setFileFetcher`) | The reader fetches `GET /api/attachments/<key>/file` through the host's `api` method, like every other request. PDFium starts at the same time, so its start-up overlaps the transfer. Each fetch is timed (`znPdfStats.fetches`). |
| Render workers | `gpui-ui/web/pdf-engine.ts` (shared PDFium code), `pdf-worker.ts`, `pdf.ts` | Pages and text layers render in Web Workers. Each worker holds its own copy of the open document, and pixels come back as transferred buffers (moved, not copied). Two workers by default (one on machines with fewer than 4 cores); `?pdfworkers=N` sets 0 to 4, and 0 is the old main-thread renderer. A job queue per worker keeps the visible pages first; scrolling past a page cancels its job. If a worker cannot start, the reader falls back to the main thread and retries the jobs in flight. The worker is a package file (`pdf-worker.js`, built by `web/build.ts` next to `pdfium.wasm`), since MV3 pages cannot start workers from `blob:` URLs. It is a module worker because the PDFium loader reads `import.meta.url`: as a classic worker it failed to start, and the first headless run fell back to the main thread without failing. The check now fails if that happens. Test: `web/pdf-engine.test.ts`. |
| Annotations | `connector-host/src/api.ts` | The allow-list now lets `PUT` and `DELETE /api/attachments/<key>/annotations` through: the reader saves new and changed annotations with `PUT` and deletes with `DELETE`. They go through `handleApi`, so the database triggers record them in the sync outbox, as for the app. Every other write still answers 403, including `POST /items` ("Add Note from Annotations"). Tests in `connector-host/test/api.test.ts`: a round trip (create, read, edit, delete, outbox count grows) and the refused neighbours (`PUT` on the file, `POST` on annotations, `PATCH` on the item, a `..` path). |
| No document worker | `gpui-ui/web/structure-stub.ts` | See the decision below. |

### Measurements

Headless check `gpui-ui/web/library-pdf-check.ts` in Chrome for Testing 151 on this machine (software GPU, SwiftShader). Fixtures:
- **small:** the demo article, 124 kB, 3 pages
- **large:** a generated PDF, 10.8 MB, 12 pages, each with a 560 × 420 picture and 9,000 thin vector strokes, the content that makes real articles slow to render

The large PDF was scrolled with 36 mouse-wheel steps, 70 ms apart. The table gives two runs per mode, in both orders.

| | Main thread (`pdfworkers=0`) | 2 workers (default) |
|---|---|---|
| Small PDF: first page drawn | 132, 136 ms | 134, 449 ms (the second run came right after the highlight and screenshots) |
| Small PDF: bytes through the host | 11, 16 ms | 14, 18 ms |
| Large PDF: first page drawn | 845, 1275 ms | 1263, 3290 ms |
| Large PDF: bytes through the host | 687, 1011 ms | 980, 2857 ms |
| Scrolling: long tasks (main thread blocked > 50 ms) | 15, 18 (4.0 s, 4.4 s in total) | **0, 0** |
| Scrolling: longest frame gap | 450, 367 ms | **34, 33 ms** |
| Render time per page | 230, 235 ms | 299, 402 ms |
| Time from asking for a page to drawing it (average) | 344, 371 ms | 378, 584 ms |

What this shows:
- **The workers fix what they were for.** On the main thread, every page render freezes the interface, about 18 times in one scroll, for up to half a second. With workers, the interface never blocks.
- **Pages take longer to render in a worker:** 30–70% more per page here. The two workers share the CPU with the software GPU, and each has its own copy of the document. So on a heavy PDF a page appears a little later, but the page stays responsive while it waits. On a light fixture (no strokes, about 13 ms per page), the two modes were the same.
- **Opening a large PDF is dominated by the transfer through the host:** about 0.7–2.9 s for 10.8 MB, varying between runs in both modes. That is base64 frames under 1 MB over native messaging. PDFium's start and the first render add 100–300 ms.

Memory: each worker holds a copy of the open document, so a 10.8 MB PDF uses about 32 MB across the page and two workers.

### Annotations

The check also covers annotations:
- An annotation stored in the fixture library before the page opened is shown.
- A highlight made in the tab is saved: `PUT` answers 200, the row is in the fixture database (`repo.getAnnotations`), and the sync outbox grows by one.

The highlight is made through the reader's own annotation session (`session.act.create`, the call the toolbar's highlight uses after a text selection). It is not a mouse drag: the check gets the first line's words from the text layer and highlights them. The selection-to-highlight gesture itself was not driven headless.

Screenshots: `1-pdf-highlight-light.png`, `2-pdf-highlight-dark.png` (the new highlight with its popup, next to the stored green one) and `3-large-pdf-scrolled.png`.

### The document worker: not shipped

Zotero's document worker (layout analysis) would add 30 MB unpacked, about 14 MB zipped. The extension today is 35.6 MB unpacked and about 11 MB zipped, so it would more than double the download. Opening, reading, searching and annotating do not need it. `bun web/build.ts --target extension --docworker` still adds it for anyone who wants it.

What the user sees without it:
- The toolbar shows "Layout analysis unavailable".
- **Reading view** shows: "The reading view needs layout analysis, which this browser version of Zinc does not include. Open the PDF in the Zinc app to read it in the reading view."
- Figure and citation cards fall back to the page text (`academic/session.ts` builds its index from the text layer when the structure fails). Numbered references and captioned figures are found. Figures without a caption, and references not in a numbered list, are missed.
- Nothing fails: the check's page-error test passes.

### Snapshots and EPUB

They open in Zotero's reader (`reader-host`) in a new browser tab. The tab is the extension page `library/reader/index.html?attachment=<key>&host=<name>`. A small script, `zn-bridge.js`, loads first and sends the reader's `/api` requests to the native host, the same way the library tab does. Annotations save through the host. `web/build.ts` copies the reader into `dist-extension/reader/`. It adds 4.9 MB and leaves out the document worker and PDF.js, so there is no reading mode there, and PDFs still open in the GPUI reader. Snapshot dark mode uses the reader's static theme, because the page CSP forbids `eval`.

A snapshot's scripts do not run: the page CSP blocks inline scripts, and the reader adds its own CSP to the frame. No sandbox page is needed, and the connector manifest needs nothing new. The headless check is `bun web/library-reader-check.ts`.

### Try it

1. In `gpui-ui`: `bun web/build.ts --target extension`.
2. Rebuild and reinstall the host (it needs the new allow-list), then rebuild the connector as in section 6.
3. Or headless: in `gpui-ui`, `bun web/library-pdf-check.ts` (options `--modes 0,2`, `--keep`, `--host-exe`). It builds its own fixture library and host, and removes them afterwards.

Left:
- Item edits in the tab: still read-only (section 6).
- "Add Note from Annotations" answers 403 in the tab (it creates an item).
- Large PDFs: send file bytes in larger frames, or as a range stream that PDFium reads as needed (`FPDF_LoadCustomDocument`). Either would bring the first page forward on big files.
