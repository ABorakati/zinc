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
| 3. PDFs | Attachment bytes through the host. Render in Web Workers. Save annotations through the same API. Decide whether to ship the document worker (+14 MB zipped). | 1 week |
| 4. macOS and Linux | Host builds and manifests, `zinc://` registration, install steps. | 3–5 days |
| 5. Optional: Zinc on the web | Option C: the Zotero Web API in the page, OPFS storage, API-key handling. A separate product decision. | 3–6 weeks |

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
| Headless check | `gpui-ui/web/extension-check.ts` | Builds a fixture library (`web/demo-library.ts`) and compiles the host. Registers it as `com.zotero_next.connector_host_e2e` under the Chrome for Testing and Chromium keys only (never `Software\Google\Chrome`), and opens the page with `?host=` that name. It first confirms which library the host serves. Then it checks the list, a collection, an item's details and an outside write, takes screenshots, and removes the registration, the profile and the host. |

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
