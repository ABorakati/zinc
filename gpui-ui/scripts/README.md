# gpui-ui scripts

Spike: zotero-next's library window drawn natively with GPUIX (Solid adapter for Zed's GPUI) instead of a web view.
Everything is Bun only (`bun`, no node/npm/npx). Run from `gpui-ui/`.

## Prerequisites

* A core API with a copy of the library, either
  * **external** (default): a core already running at `ZN_URL` (default `http://127.0.0.1:23160`, for example another
    instance of the app), or
  * **in-process**: set `ZN_DB=<copy of the library>` and the app runs the core itself (`src/core.ts`). `ZN_PORT` (default 23161, falls back to a free port) is its loopback port; `ZN_CORE_DIRECT=1` skips HTTP and
    calls the core's `handleApi` directly. **The core writes to its database: use a `VACUUM INTO` copy, never
    `data/library.sqlite`** (the app refuses that path unless `ZN_ALLOW_REAL_DB=1`; there is no default for `ZN_DB`).
    Make a copy with `bun -e 'import {Database} from "bun:sqlite"; new Database("src.sqlite",{readonly:true}).run("VACUUM INTO \"copy.sqlite\"")'`.
* `bun install` (adds `@gpuix/*`, `solid-js`, and the harness deps `pngjs` + `pixelmatch`).
## Run the app

```
bun src/main.tsx                              # opens the real GPUI window (external core)
ZN_URL=http://127.0.0.1:23160 bun src/main.tsx
ZN_DB=C:/path/to/library-COPY.sqlite bun src/main.tsx    # core in the same process
ZN_TRACE=1 bun src/main.tsx                   # prints startup milestones: "[zn-t] <name> <ms since process start>"
bun --hot src/main.tsx                        # hot reload (bun run dev)
bun check                                     # typecheck (do not use tsc via bunx)
```

## Build and package scripts

All run from `gpui-ui/`. Linux and macOS are covered too; see `docs/developer-guide/building.md`.

```
bun scripts/build.ts                # compile for this OS and CPU (bun-windows-x64, bun-linux-x64, bun-darwin-arm64); aot, exe icon, --hide-console: Windows only
bun scripts/package.ts [--zip]      # out/package/zotero-next-gpui/ (PDF library and PDFium per OS); --aot and signing: Windows only
bun scripts/installer.ts            # Windows: Inno Setup installer
bun scripts/appimage.ts             # Linux x64: out/appimage/Zinc-<version>-x86_64.AppImage (+ .sha256); runs package.ts first
bun scripts/dmg.ts                  # macOS: out/dmg/Zinc-<version>-<arch>.dmg (+ .sha256); runs package.ts first
bun scripts/smoke-native.ts [dir]   # smoke test of the real app window (macOS CI; also Linux and Windows)
```

## Which library the packaged app opens, and the first-run screen

No path in the code names a user. The rule is `core/src/library-location.ts` (also used by the browser
connector host; `word/addin/Settings.cs` mirrors it): `ZN_DB` / `ZN_LIBRARY`, else the library path saved in
`<config>\zotero-next-gpui\library.json` (`{"path": "..."}`; `<config>` is `%APPDATA%` on Windows, `~/Library/Application Support` on macOS, `$XDG_CONFIG_HOME` on Linux), else the legacy `<home>\zotero-next\data\library.sqlite` (when it exists it
is adopted into that file on the first start, so the library keeps opening from there), else `<data>\zotero-next\library.sqlite`
when that exists. Nothing found (or the saved file is gone): `startup.firstRun` is set and `main.tsx` shows `src/firstrun/` (Import from
Zotero with progress, Open an existing library, Start an empty library) before anything opens a database; the choice is saved and
start-up goes on. Settings > Files and folders > Library location > Change… saves another library file for the next start.

* `ZN_RESOLVE_LIBRARY=1` makes an unpackaged run choose its library like the packaged app. Check the first-run screen without touching
  your data: `APPDATA=<temp> USERPROFILE=<temp> LOCALAPPDATA=<temp> ZN_RESOLVE_LIBRARY=1 ZN_TRACE=1 bun src/main.tsx` (trace shows `firstrun-shown`).
* `bun scripts/shot-firstrun.tsx [out-dir] [light|dark]` screenshots the screen against a mock (nothing read or written).

## Headless screenshots (no window opens)

GPUIX's test renderer (`createTestRoot()` from `@gpuix/solid/testing`, `renderer.captureScreenshot(path)`) renders offscreen.
Whatever size you ask for, the PNG comes out about 1440x881.

```
bun scripts/shot-hello.tsx out.png            # the Hello smoke test
bun scripts/shot-app.tsx out.png              # the whole <App/>
bun scripts/shot-sidebar.tsx out.png          # Sidebar alone   (written by the sidebar owner)
bun scripts/shot-cards.tsx out.png            # CardList alone  (written by the cards owner)
bun scripts/shot-locate.tsx                   # Locate menu probe: right-click an item and the item pane's More menu
bun scripts/shot-item-actions.tsx             # Duplicate Item + Create Parent Item: menu, dialog and result shots,
                                              #   and checks of both actions (runs against a library COPY: it duplicates an
                                              #   item and gives two standalone PDFs a parent)
bun scripts/scroll-test.tsx                   # headless scroll/frame timing of the card list
```

## memory.ts / startup.ts: memory + startup time of the real GPUI window

```
bun scripts/memory.ts                                         # external core at http://127.0.0.1:23160, 3 runs, 15 s each
bun scripts/memory.ts --runs 1 --wait 6
bun scripts/memory.ts --url http://127.0.0.1:23170 --port 23170        # external core elsewhere
bun scripts/memory.ts --db C:/path/to/library-COPY.sqlite             # in-process core (ZN_DB; port 23161)
ZN_CORE_DIRECT=1 bun scripts/memory.ts --db C:/path/to/library-COPY.sqlite   # in-process, no HTTP
bun scripts/startup.ts [same options]                         # 3 runs, 7 s each, prints only the time-to-window / first-items summary
```

Each run opens a visible window (do not click or type in it). A generated PowerShell script (`%TEMP%\zn-memory\measure.ps1`)
launches `bun <entry>` with `ZN_TRACE=1` and `ZN_URL` (or `ZN_DB`/`ZN_PORT` for the in-process core), polls (about 10 ms) for a
visible top-level window owned by the process tree, and at `--wait` seconds records private bytes (`PrivateMemorySize64`) and
working set of:

* the GPUI process tree (bun plus any children; `conhost` is ignored), and
* in external mode, the core API process listening on `--port` (found with `Get-NetTCPConnection`, `netstat -ano` fallback),
  reported separately; the "total" columns add the two. In in-process mode the core is inside the GPUI process, so there is
  no core column.

Then it closes the window (`CloseMainWindow`, `taskkill /T /F` after 4 s) and prints a table with an average row.

Columns: "window ms" is from process start (the PowerShell stopwatch, so it includes spawning Bun) to the first visible window; "colls
ms" and "items ms" come from the app's own `ZN_TRACE` marks (`src/trace.ts`, ms since the Bun process started): the collections
are in the store, and the app is mounted with its first page of items in the store (`first-items`; the next frame paints them).
The two clocks differ by the process launch (about 50-150 ms). Other milestones are in the per-run line: `main-start`,
`render-returned` (the splash is on its way), `fonts-registered`, `core-start`/`core-ready`, `store-ready`, `app-mounted`.

Startup notes (what the numbers are made of, so you know what is worth touching):

* Bun start-up with the Solid preload (babel + the solid preset) is about 210 ms before any app code runs; the first `.tsx` file
  pays babel's warm-up again (about 170 ms). `bun src/x.ts` with no JSX reaches `main-start` earlier.
* `render()` itself takes 400-500 ms (native renderer init), and the window then appears about 250-900 ms after it returns
  (GPU/window thread, not JS): an empty window is the floor, about 1.7 s on this machine under load.
* Importing the UI modules (all the `.tsx`, through babel) is about 400-700 ms; the core's modules about 400 ms (server + MCP),
  about 130 ms for just `db` + `api` (`ZN_CORE_DIRECT=1`).
* Registering a font costs 5-20 ms while the tree has no text, but about 250 ms per file once the app's text is on screen
  (everything is re-shaped), so `main.tsx` registers them right after the first `render()`.

Reference: the Electrobun app measured, library only, about 580 MB private / 710 MB WS total (bun main including the core about
230 MB plus six WebView2 processes about 350 MB).

In external mode the core's own memory is whatever that process has accumulated (it may serve other clients too), so compare
the "GPUI" columns for the UI cost and treat the core columns as a constant. Numbers on a busy machine vary a lot (run
`startup.ts` a few times and look at the median, not one run).

## bench-vs-zotero.ts: Zinc against the installed Zotero 10

`bun scripts/bench-vs-zotero.ts` launches the installed Zotero 10 and the installed Zinc on copies of the same library
and reports time to window, time to "library ready" (the local data API answers), memory of the whole process tree, warm
quick-search latency and install size. Options (paths, ports, runs, queries) are listed at the top of the script. It is
Windows-only, uses `bun:ffi` (CreateProcess with a minimised window, EnumWindows, GetProcessMemoryInfo) and never drives the
mouse or keyboard.

Isolation: Zotero runs from a new, scratch profile whose `user.js` points the data dir at a copy and turns sync, updates and
background renaming off (ports 23131 for Zotero; 23191 and 23192 for Zinc). Zinc gets a `VACUUM INTO` copy and a
scratch APPDATA/LOCALAPPDATA. The real data dir, the real profile, and anything on 23119/23120 are never touched, and the script
refuses to start while any `zotero.exe` is running. The copies are deleted at the end (`--keep` keeps them).

Zotero 10 gotcha: its local API answers 500 and then stops answering if it is called before start-up has finished, so the
script sends the first request only once the main window is titled "... - Zotero".

## Custom GPUIX native addon (cache regions)

On Windows the app runs a locally built `@gpuix/native` addon, not the npm 0.11.0 binary (Linux and macOS use the npm binary). It adds `cacheRegion` (a style key: `true`, or
`"content"` for a region sized by its children). Each region is drawn by its own cached GPUI view, so a frame where only the list
scrolled replays the sidebar, toolbar and item pane instead of rebuilding them (scroll draw p50 ~5.4 -> ~3.3 ms).

* Source: private repo https://github.com/ABorakati/gpuix, branch `richtext-editor` (local checkout `C:\Users\abora\src\gpuix`;
  `zn-cache` plus the `<richtext>` note editor and right-to-left text, on top of the 0.11.0 release `2e31b47`). Its `zed`
  submodule's commits are kept as patch files `patches/zed/0001` to `0010` on base `f77e5cf` of https://github.com/remorses/zed;
  `patches/zed/README.md` says how to re-apply them (applied: local branch `zn-rtl` of the submodule). 0005 to 0010 are
  right-to-left text: without them Arabic and Hebrew are drawn backwards on Windows.
* Dependencies: the fork's `bun install --frozen-lockfile --ignore-scripts` before the first build (it brings `napi`).
* The JS side: `patches/@gpuix%2Fnative@0.11.0.patch` and `patches/@gpuix%2Fsolid@0.11.0.patch` add what the fork's JS adds (`richtext`, `dir`,
  the editor's events) to the npm packages. The native note editor is offered only when the addon has the static
  `GpuixRenderer.supportsElementType` and it answers true for `richtext` (`src/notes/native/prefs.ts`): the npm addon accepts the
  element and draws nothing.
* Build: in `packages/native`, `bun run build` (napi release build with `test-support`).
* Install: copy `packages/native/gpuix-native.win32-x64-msvc.node` over
  `node_modules/@gpuix/native-win32-x64-msvc/gpuix-native.win32-x64-msvc.node` (the npm original is kept beside it as `.orig`).
  `bun install` puts the npm binary back: copy the custom one again before `bun scripts/build.ts` / `package.ts`.
* Without the custom addon, `cacheRegion` is ignored and the app still works (whole-window redraws, as before).
* Scroll bench at 120 fps input: `bun scripts/scroll-bench.ts --db <copy> --view cards --profile slow,fast --step 8`
  (the default 16 ms step caps fps near 62). `NAPI_RS_NATIVE_LIBRARY_PATH=<file>.node` runs it with another addon (the name must
  end in `.node`).
