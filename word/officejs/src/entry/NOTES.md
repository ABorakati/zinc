# Packaging & Entry Notes (`src/entry`, `build.ts`, `serve.ts`, `manifest/`, `docs/`)

## What is done

- **Task-pane entry & router (`src/entry/router.ts`, `src/entry/main.ts`)**:
  - `createOfficeHost` builds a sidebar `Host` (`word/sidebar/src/host.ts`) backed by `createDocMethods(ctx)` (`../host`) and `createServiceMethods(ctx)` (`../services`).
  - Unknown method names (including `Object.prototype` keys like `toString` / `constructor`) reject with `Error("Unknown method: <method>")`.
  - Synchronous throws and async rejections (including plain objects such as cross-realm `OfficeExtension.Error` instances) are converted into `Error` rejections carrying the original `.message` (with `{ cause }` preserved).
  - `ctx.emit(event, data)` dispatches to `host.on(event, cb)` subscribers.
  - `startTaskPane` awaits `Office.onReady`, assigns `globalThis.__znHost = host`, applies `Office.context.officeTheme.bodyBackgroundColor` to `html[data-office]` (`light` | `darkgray` | `black`) when available, and dynamically imports `../../../sidebar/src/main` so the sidebar sees `globalThis.__znHost` on startup just like `word/sidebar/src/demo.ts`.
- **Bundler (`build.ts`)**:
  - Bundles `src/entry/main.ts` with `Bun.build` (`target: "browser"`, `format: "esm"`, `splitting: false`) into `word/officejs/dist/` (overridable via `ZN_OFFICEJS_DIST` for isolated test builds).
  - Generates `dist/taskpane.html` from `word/sidebar/index.html` with `<script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script>` in `<head>` ahead of `<script type="module" src="main.js"></script>`, so DOM IDs stay in lockstep with `word/sidebar` without editing `word/sidebar`.
  - Copies `word/sidebar/style.css` and `manifest/icon-{16,32,64,80}.png` into `dist/`.
  - `.gitignore` needed no changes: `dist/` is already ignored by both root `.gitignore` and `word/.gitignore`.
- **Manifest & icons (`manifest/manifest.xml`, `manifest/icon-{16,32,64,80}.png`, `src/entry/icons.ts`)**:
  - Add-in-only XML `TaskPaneApp` manifest targeting `Host Name="Document"`, `Permissions` `ReadWriteDocument`, `WordApi` `1.5` minimum, `SourceLocation` `https://localhost:44321/taskpane.html`, `SupportUrl` `https://aborakati.github.io/zinc/`, `AppDomains`, and `VersionOverridesV1_0` ribbon button with `<TaskpaneId>Office.AutoShowTaskpaneWithDocument</TaskpaneId>`.
  - Crisp 16/32/64/80 px RGBA PNG icons generated in pure TypeScript (`node:zlib`) matching `website/public/icon.svg`.
- **Local HTTPS dev server (`serve.ts`) & install guide (`docs/INSTALL.md`)**:
  - Serves `dist/` over HTTPS on both `127.0.0.1` and `::1`, default port `44321` (`PORT` overrides), with `Cache-Control: no-store` on every response and path-traversal guards.
  - Reads `~/.office-addin-dev-certs/localhost.crt` and `localhost.key`; if absent, exits cleanly with instructions (`bunx office-addin-dev-certs install` or `openssl`).
  - `docs/INSTALL.md` covers Windows Trust Center shared-folder catalogs (and notes that `HKCU\Software\Microsoft\Office\16.0\WEF\Developer` did not work on this machine), macOS `~/Library/Containers/com.microsoft.Word/Data/Documents/wef`, Word on the web manifest upload, dev certs, and `Office.AutoShowTaskpaneWithDocument`.
- **Tests (`test/entry/{router,manifest,build}.test.ts`)**:
  - Cover method routing, stand-ins, unknown-method rejection, sync/async error normalisation, `ctx.emit` -> `host.on` events, `Office.onReady` boot ordering, XML well-formedness + manifest schema order + PNG dimensions, temp-dir builds via `ZN_OFFICEJS_DIST`, loopback static serving (`Cache-Control: no-store`), and missing-cert handling.

## Stand-ins for COM-only bridge calls & proposed Office.js cursor popup

### Stand-ins in `createOfficeHost`

All stand-ins sit underneath `serviceMethods` and `docMethods` (`{ ...standIns, ...serviceMethods, ...docMethods }`), so a real implementation in `src/host` or `src/services` overrides them automatically:

| Method | Stand-in behaviour | Why |
|---|---|---|
| `popup.resize` | Resolves `{ ok: true }` | Resizes the COM add-in's borderless Win32 speech-bubble `Form` (`Popup.cs`); Office.js has no per-pixel borderless window. |
| `popup.close` | Resolves `{ ok: true }` | Hides the COM popup window. |
| `popup.edit` | Emits `"command"` `{ name: "editCitation" }` and resolves `{ ok: true }` | Matches `Connect.EditCitationFromPopup()` in the COM add-in: tells the sidebar (`main.ts`) to load the citation at the cursor into the edit tray. |
| `agent.ready`, `agent.result`, `agent.*` | Resolves `{ ok: true }` | Used by the COM add-in's hidden off-screen `AgentHost.cs` WebView2 for its local MCP server; an Office.js task pane does not host a hidden second WebView. |

### Proposed Office.js equivalent for the COM cursor popup

In the Windows COM add-in (`Popup.cs`), entering a citation opens a non-activating (`WS_EX_NOACTIVATE`) speech-bubble WebView2 anchored to the citation's screen rectangle (`Window.GetPoint`). Office.js exposes neither physical screen coordinates of a `Word.Range` nor non-activating floating windows, so we should combine two patterns:

1. **In-pane "Cited here" card (already built into `word/sidebar/src/main.ts`)**:
   Whenever the task pane is open and `src/host` emits `ctx.emit("cursor", cursorInfo)` on `Office.EventType.DocumentSelectionChanged`, the sidebar's `renderCited()` automatically displays the cited items' metadata, library status, abstracts, DOI / Open-in-Zinc links, and Edit / Split / Delete buttons at the top of the pane — without stealing focus from the document canvas.
2. **On-demand citation inspector via `Office.context.ui.displayDialogAsync`**:
   For users working with the task pane closed (or wanting a larger reference/abstract reader), bundle `word/sidebar/popup.html` + `popup.css` + a thin dialog entry (`src/entry/popup-dialog.ts`) into `dist/popup.html` and add a ribbon button ("Inspect Citation"):
   - Open the dialog with `Office.context.ui.displayDialogAsync("https://localhost:44321/popup.html", { width: 34, height: 42, displayInIframe: true }, cb)`.
   - Because Office dialog pages run in an isolated browsing context without direct `Word.run` access, the parent runtime reads `doc.cursor` + `app.describeForPopup(code)` and sends `{ event: "popup.show", data }` via `dialog.messageChild(...)` (`DialogApi 1.2`), while `popup-dialog.ts` routes `host.call(...)` (`popup.close`, `popup.edit`, `doc.delete`, `zn.reveal`, `app.openUrl`) back to the parent via `Office.context.ui.messageParent(...)` (`DialogMessageReceived`).
   - Do **not** call `displayDialogAsync` automatically on every `DocumentSelectionChanged`: unlike Win32 `WS_EX_NOACTIVATE`, Office dialogs steal keyboard focus from the document and block typing.

## Untested in real Word

- Sideloading `manifest/manifest.xml` in desktop Word for Windows (Trust Center shared-folder catalog), Word for Mac (`wef` folder), and Word on the web, and verifying ribbon icon rendering at 16/32/80 px across DPI scales.
- Live `Office.onReady` startup against Microsoft's hosted `office.js` inside Word's WebView2 / WKWebView / iframe, `Office.context.officeTheme` values across all four Office themes, and `Office.AutoShowTaskpaneWithDocument` reopen behaviour on saved `.docx` files.
- Full task-pane citation workflows against real Word documents once `src/host`, `src/format`, and `src/services` replace their placeholder stubs.

## Needs from other parts

- **`src/host` (`createDocMethods`)**:
  - `word/sidebar/src/app.ts` calls `doc.begin` and `doc.end` around every write (`insertCitation`, `updateCitation`, `splitCitation`, `mergeAdjacent`, `unlinkCitations`, `convertCitations`, `deleteCitation`, `insertBibliography`, `setStyle`, `setNoteType`, `refreshAll`, `saveBibliography`) and calls `doc.signature` for popup label caching. Even though Office.js cannot group multiple `context.sync()` calls into a single named Word undo record, `src/host` must still provide `doc.begin` and `doc.end` (at minimum returning `{ ok: true }` and bumping the write counter for `doc.signature`) so `app.ts` does not fail with `Unknown method: doc.begin`.
  - Subscribe to `Office.EventType.DocumentSelectionChanged` (debounced) and emit `ctx.emit("cursor", ...)` so the sidebar's "Cited here" card and document header stay live.
- **`src/services` (`createServiceMethods`)**:
  - Implement `app.openUrl` using `Office.context.ui.openBrowserWindow(url)` (`OpenBrowserWindowApi 1.1`) with fallback to `window.open(url, "_blank", "noopener")`.
  - Local Zinc daemon HTTP endpoints called from `https://localhost:44321` (or from `https://*.officeapps.live.com` in Word on the web) must send CORS headers (`Access-Control-Allow-Origin`) and, for Chromium-based Word on the web hitting `127.0.0.1`, `Access-Control-Allow-Private-Network: true` on `OPTIONS` preflights.
- **`word/sidebar` (`word/sidebar/src/main.ts`)**:
  - `main.ts` uses `window.confirm(...)` in four places (`askAboutEdits`, `startEdit`, `splitCited`, `unlinkAll`). Word on the web runs add-ins inside a sandboxed iframe without `allow-modals`, where `window.confirm()` is blocked and silently returns `false`. Replacing those four `window.confirm` calls with an inline confirmation banner/dialog inside `#app` will make hand-edit prompts and "Unlink citations…" work in Word on the web as well as desktop Word.
