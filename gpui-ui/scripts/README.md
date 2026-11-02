# gpui-ui scripts

Spike: zotero-next's library window drawn natively with GPUIX (Solid adapter for Zed's GPUI) instead of a web view.
Everything is Bun only (`bun`, no node/npm/npx). Run from `gpui-ui/`.

## Prerequisites

* A core API with a copy of the library: `http://127.0.0.1:23160` (also serves the web UI at `/app/`). The GPUI app reads
  `ZN_URL` (default `http://127.0.0.1:23160`).
* `bun install` (adds `@gpuix/*`, `solid-js`, and the harness deps `pngjs` + `pixelmatch`).
* `agent-browser` on PATH (headless Chrome; used by `compare.ts` only; it never touches your own browser).

## Run the app

```
bun src/main.tsx                              # opens the real GPUI window
ZN_URL=http://127.0.0.1:23160 bun src/main.tsx
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

## memory.ts: memory + time-to-window of the real GPUI window

```
bun scripts/memory.ts                         # 3 runs, 15 s each
bun scripts/memory.ts --runs 1 --wait 6
bun scripts/memory.ts --entry src/main.tsx --url http://127.0.0.1:23160 --port 23160
```

Each run opens a visible window (do not click or type in it). A generated PowerShell script (`%TEMP%\zn-memory\measure.ps1`)
launches `bun <entry>` with `ZN_URL`, polls (about 40 ms) for a visible top-level window owned by the process tree, and at
`--wait` seconds records private bytes (`PrivateMemorySize64`) and working set of:

* the GPUI process tree (bun plus any children; `conhost` is ignored), and
* the core API process listening on `--port` (found with `Get-NetTCPConnection`, `netstat -ano` fallback), reported separately
  because in the spike the core is its own process; the "total" columns add the two.

Then it closes the window (`CloseMainWindow`, `taskkill /T /F` after 4 s) and prints a table with an average row. "window ms" is
from process start to the first visible window, so it includes Bun start-up and font registration.

Reference: the current Electrobun app measured, library only, about 580 MB private / 710 MB WS total (bun main including the
core about 230 MB plus six WebView2 processes about 350 MB).

The core's own memory is whatever that process has accumulated (it may serve other clients too), so compare the "GPUI" columns
for the UI cost and treat the core columns as a constant.
