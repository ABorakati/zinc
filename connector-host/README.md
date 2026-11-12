# zotero-next host

Native-messaging host for the **Zinc Connector** browser extension (the fork in
`C:\Users\abora\zotero-next-connector`). It lets the extension save web pages, PDFs and references straight into the
zotero-next library **while neither zotero-next nor Zotero is running**.

Chrome starts `zotero-next-host.exe` when the extension connects (`chrome.runtime.connectNative`) and closes it with
the connection. The host maps each extension call onto the same Zotero-7 connector handlers the app serves on port
23119 (`core/src/connector/handlers.ts`), against the same database, so everything the app's own Connector port would
create is created: items, `storage/<KEY>/` files, collections, tags, notes, and the `sync_outbox` rows that the next
zotero-next sync pushes to Zotero.

## Install

```powershell
cd C:\Users\abora\zotero-next\connector-host
bun install              # once (type definitions only)
bun run build            # -> dist\zotero-next-host.exe
powershell -File .\install.ps1
```

`install.ps1` writes `%LOCALAPPDATA%\zotero-next-connector-host\com.zotero_next.connector_host.json` and the registry
value `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.zotero_next.connector_host` (and the same under `Microsoft\Edge`)
pointing at it (`allowed_origins` = the extension id `pakgagonakcalfbmckaolkpidcojacaf`). Nothing else is touched. Remove with
`uninstall.ps1`. Then load the extension: see `zotero-next-connector\ZOTERO-NEXT.md`.

Both scripts take optional `-ManifestDir <folder>` (where the manifest goes; with it `uninstall.ps1` removes only the manifest file),
`-HostName <name>` (registry key and manifest name; default `com.zotero_next.connector_host`) and, for `install.ps1`, `-HostExe <path>` and
`-ExtensionId`. The Windows installer (`gpui-ui/installer`, component "Browser connector") calls them with `-ManifestDir <app>\connector` and
the installed exe, and ships the built extension next to it; with the defaults nothing changes from the dev setup above. Do not run the dev
`install.ps1` and the installed component at once: they use the same registry keys, and the last one run wins.

Rebuild the exe after changing anything under `core/src/connector` or `core/src/db.ts` (the exe embeds core);
re-running `install.ps1` is not needed, the path stays the same. Close Chrome (or reload the extension) so the old
host process exits.

## Protocol

Frames: 4-byte little-endian length + UTF-8 JSON, both directions (`src/frames.ts`).

| Direction | Message |
|---|---|
| extension to host | `{t:"req", id, method, http, query, headers, body}`, `body`: `{kind:"text",text}`, `{kind:"b64",data}`, `{kind:"upload",uid}` or `{kind:"form",fields}` |
| extension to host | `{t:"up", uid, seq, last, data}`: upload chunk (base64, 4 MiB raw each); Chrome allows 64 MB per message |
| extension to host | `{t:"hello", id}` answered with `{t:"hello", id, version, db, pid}` |
| host to extension | `{t:"res", id, status, headers, n}` then `n` x `{t:"rc", id, seq, data}` (base64, under 1 MB per frame: Chrome's host-to-browser limit) |

`method` is the connector endpoint name (`saveItems`, `saveAttachment`, ...). One method is Zinc's own: `revealInApp` with
body `{"key": "<item key>"}` asks the running app to show that item (`POST /api/ui/reveal` on `ZN_PORT`, default 23120), starting
the app first when its API does not answer (`ZN_LAUNCHER`, else `%LOCALAPPDATA%\Programs\Zinc\zotero-next-gpui.exe`), and answers
`{ok, started, error?}` (`src/reveal.ts`; design: `docs/design/web-connector-wasm.md`). Unknown methods (`getTranslators`,
`getTranslatorCode`, `document/*`) answer 404, which makes the extension use Zotero's translator repository and show
no word-processor integration.

## Library, writes and state

* Database: `ZN_DB`, else `C:/Users/abora/zotero-next/data/library.sqlite` if it exists, else
  `%LOCALAPPDATA%\dev.zotero-next.app\stable\library.sqlite` (the folder of the old Electrobun app, kept so existing libraries still open). If none
  exists every call answers 500 "library not found".
* Opened with `openDb()` like the app: WAL, `busy_timeout = 5000`, the sync-outbox triggers. A save is short
  transactions, so it interleaves safely with the running app's writes (tested against `core/src/server.ts`).
* `connector-host-state.json` next to the database holds (a) `lastTarget`, the collection last chosen in the
  extension's progress window, and (b) in-flight save sessions (so a host restart between `saveItems` and
  `saveAttachment` loses nothing). Several hosts (browser profiles) share it safely (atomic rename, merge).
* Selected collection: if the app is running (`http://127.0.0.1:23120/api/ui/selection`, or `ZN_PORT`) its UI selection
  is used; otherwise `lastTarget`; otherwise My Library. `ZNH_APP_PORT=0` turns the app lookup off.
* Full-text: HTML is indexed in the host; PDFs through zotero-next's own worker pool, loaded from the checkout in
  `ZNH_REPO` (default `C:/Users/abora/zotero-next`: `core/src/extract/pdf-worker.ts`, `vendor/document-worker/build`).
  Without the checkout PDFs are stored but not indexed.

## Tests

```powershell
bun run build
bun test                         # fresh temp library
$env:ZNH_SOURCE_DB = "<a library file>"; bun test   # same, on a copy (VACUUM INTO) of that library
$env:ZNH_TEST_DIR = "<folder>"   # keep the temp libraries/storage there instead of deleting them
```

They spawn the compiled exe and replay a whole save as frames: ping, getSelectedCollection, saveItems (translator
output), saveAttachment (9 MB PDF in three chunks), updateSession, saveSingleFile, session survival across a host
restart, last-target persistence, a >1 MB response, PDF full-text, and 25 concurrent saves while a
`core/src/server.ts` process writes the same database (integrity and foreign-key checks afterwards). The extension
side is covered by `zotero-next-connector/test/native`.
