# gpui-ui scripts

Spike: zotero-next's library window drawn natively with GPUIX (Solid adapter for Zed's GPUI) instead of a web view.
Everything is Bun only (`bun`, no node/npm/npx). Run from `gpui-ui/`.

## Prerequisites

* A core API with a copy of the library, either
  * **external** (default): a core already running at `ZN_URL` (default `http://127.0.0.1:23160`, also serves the web UI at
    `/app/`), or
  * **in-process**: set `ZN_DB=<copy of the library>` and the app runs the core itself (`src/core.ts`, same as the Electrobun
    app does). `ZN_PORT` (default 23161, falls back to a free port) is its loopback port; `ZN_CORE_DIRECT=1` skips HTTP and
    calls the core's `handleApi` directly. **The core writes to its database: use a `VACUUM INTO` copy, never
    `data/library.sqlite`** (the app refuses that path unless `ZN_ALLOW_REAL_DB=1`; there is no default for `ZN_DB`).
    Make a copy with `bun -e 'import {Database} from "bun:sqlite"; new Database("src.sqlite",{readonly:true}).run("VACUUM INTO \"copy.sqlite\"")'`.
* `bun install` (adds `@gpuix/*`, `solid-js`, and the harness deps `pngjs` + `pixelmatch`).
* `agent-browser` on PATH (headless Chrome; used by `compare.ts` only; it never touches your own browser).

## Run the app

```
bun src/main.tsx                              # opens the real GPUI window (external core)
ZN_URL=http://127.0.0.1:23160 bun src/main.tsx
ZN_DB=C:/path/to/library-COPY.sqlite bun src/main.tsx    # core in the same process
ZN_TRACE=1 bun src/main.tsx                   # prints startup milestones: "[zn-t] <name> <ms since process start>"
bun --hot src/main.tsx                        # hot reload (bun run dev)
bun check                                     # typecheck (do not use tsc via bunx)
```

## Headless screenshots (no window opens)

GPUIX's test renderer (`createTestRoot()` from `@gpuix/solid/testing`, `renderer.captureScreenshot(path)`) renders offscreen.
Whatever size you ask for, the PNG comes out about 1440x881.

```
bun scripts/shot-hello.tsx out.png            # the Hello smoke test
bun scripts/shot-app.tsx out.png              # the whole <App/>
bun scripts/shot-sidebar.tsx out.png          # Sidebar alone   (written by the sidebar owner)
bun scripts/shot-cards.tsx out.png            # CardList alone  (written by the cards owner)
bun scripts/shot-locate.tsx                   # Locate menu probe: right-click an item and the item pane's More menu
bun scripts/scroll-test.tsx                   # headless scroll/frame timing of the card list
```

## compare.ts: web UI vs GPUI UI

```
bun scripts/compare.ts                        # dark, default output dir
bun scripts/compare.ts --mode light
bun scripts/compare.ts --out C:/some/dir --wait 4000
bun scripts/compare.ts --gpui-png existing.png   # skip the GPUI capture, reuse a PNG
```

What it does:

1. Captures GPUI headlessly: runs `scripts/shot-app.tsx <gpui.png>` if that exists, otherwise calls `createTestRoot()` on
   `App` from `src/App.tsx` itself, otherwise stops with a message.
2. Reads the PNG size (about 1440x881) and uses it as the web viewport.
3. `agent-browser` (own session `zn-gpui-compare`, headless) sets that viewport + `prefers-color-scheme`, opens
   `http://127.0.0.1:23160/app/`, writes `localStorage["zn.theme"] = {"mode":"dark"}` (what `ui/index.html` / the appearance
   settings read), reloads, waits, screenshots, and closes the session.
4. `pixelmatch` (threshold 0.1, anti-aliasing ignored) diffs the two.

Outputs (default
`C:\Users\abora\AppData\Local\Temp\claude\C--Users-abora-Hecate\0719cea7-1eb3-4344-a1e4-a862c3bde6eb\scratchpad\gpui-shots\compare\`):
`web.png`, `gpui.png`, `side-by-side.png` (web | gpui | diff), `diff.png` (heatmap, magenta = differing pixel), `summary.json`,
and the `% different` printed on the last line.

Notes: the web UI groups the list by year and shows live data, so a flat GPUI list will always differ in the list region; the
number is a progress indicator, not a pass/fail. Lower is better; sub-pixel text anti-aliasing alone usually costs a few percent.

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

## Custom GPUIX native addon (cache regions)

The app runs a locally built `@gpuix/native` addon, not the npm 0.11.0 binary. It adds `cacheRegion` (a style key: `true`, or
`"content"` for a region sized by its children). Each region is drawn by its own cached GPUI view, so a frame where only the list
scrolled replays the sidebar, toolbar and item pane instead of rebuilding them (scroll draw p50 ~5.4 -> ~3.3 ms).

* Source: `C:\Users\abora\src\gpuix`, branch `zn-cache` (commit `f5d4383`, on top of the 0.11.0 release `2e31b47`); its `zed`
  submodule is on a local branch `zn-cache` (commit `17be001`). Neither is pushed.
* Build: in `packages/native`, `bun run build` (napi release build with `test-support`).
* Install: copy `packages/native/gpuix-native.win32-x64-msvc.node` over
  `node_modules/@gpuix/native-win32-x64-msvc/gpuix-native.win32-x64-msvc.node` (the npm original is kept beside it as `.orig`).
  `bun install` puts the npm binary back: copy the custom one again before `bun scripts/build.ts` / `package.ts`.
* Without the custom addon, `cacheRegion` is ignored and the app still works (whole-window redraws, as before).
* Scroll bench at 120 fps input: `bun scripts/scroll-bench.ts --db <copy> --view cards --profile slow,fast --step 8`
  (the default 16 ms step caps fps near 62). `NAPI_RS_NATIVE_LIBRARY_PATH=<file>.node` runs it with another addon (the name must
  end in `.node`).
