# Phase 0 spike results (2026-10-29)

Goal: prove that Electrobun 2.x on Windows can host Zotero's own reader, with Reading Mode,
using Bun only (no Node.js, no older Electrobun).

## Verdict: works

| Check | Result |
|---|---|
| Electrobun 2.0.5 (Hutch 0.28.2) builds and runs on Windows 11 | ✅ `hutch electrobun build --env=dev`, `hutch electrobun run --env=dev` |
| Main process | Bun 1.4.4 (Hutch-pinned), WebView2 = Edge 156, no CEF |
| Zotero reader (`zotero/reader`, dev build) in a hidden window | ✅ renders pages, text layer (4,924 chars), outline (14 items), no JS errors |
| Reading Mode (`zotero/document-worker`, ONNX block segmentation) | ✅ 79,189 chars of reflowed text, ~3.3 s cold for a 14-page PDF |
| First page drawn, cold start | ~2.5 s (unminified 6.8 MB dev bundle) |
| `bun:sqlite` FTS5 | ✅ SQLite 3.53.4, porter stemming, 20k rows queried in 19 ms (`fts5.ts`) |
| Builds with Bun only | ✅ reader, pdf.js and document-worker all built with `bun install` / `bun --bun` |

## How to rerun

```bash
bash spikes/build-docworker.sh
bash spikes/build-reader-bun.sh
```

Then from PowerShell in `app/` (Windows `tar` must come before Git Bash's on PATH):

```powershell
$env:PATH = "C:\Windows\System32;$HOME\.hutch\bin;" + $env:PATH
hutch electrobun build --env=dev
$env:ZN_SPIKE_HIDDEN="1"; $env:ZN_SPIKE_AUTOQUIT="1"; hutch electrobun run --env=dev
```

The injected probe (`probe.js`) writes `spikes/electrobun-result.json` and the app quits itself.

## Problems found and fixes

1. **Hutch installer fails from Git Bash.** It picks up GNU `tar`, which reads `C:` as a remote host.
   Fix: run init/build from PowerShell with `C:\Windows\System32` first on PATH.
2. **Electrobun 2.x has no plain-npm SDK.** The npm package only bootstraps Hutch; the SDK lives in
   `app/.hutch/devkit`. Hutch is build tooling; the app runtime is still Bun.
3. **Bun bug: `domain.bind()` drops the return value.** gulp's `async-done` then never sees a task's
   promise/stream, so every pdf.js gulp task "did not complete". Fix: `shims/bun-domain-bind.cjs`,
   loaded with `bun --preload`. Worth reporting upstream to Bun.
4. **Never patch `node_modules` under Bun.** Files are hard-linked to Bun's global cache, so editing
   one edits the cache for every project. (Hit once; the cache entry was deleted and re-downloaded.)
5. **`reader.initializedPromise` never resolves.** Poll for rendered pages instead.
6. **Reader webpack reports one TypeScript error** (`epubjs/src/utils/path` has no declaration file),
   likely from how Bun links `file:` dependencies. Output JS is unaffected.
7. **`crossOriginIsolated` is false** despite COOP/COEP headers, so onnxruntime-web runs
   single-threaded. Reading Mode still works; threads could make it faster. Not yet investigated.

## Next (Phase 1)

- Real app shell in Solid; reader embedded per item instead of the demo PDF.
- Core service: SQLite with Zotero's schema (`zotero/zotero-schema`), import from Zotero, collections.
- Hook the reader's `onSaveAnnotations` / `onChangeViewState` to the database.
- Use the reader's `web` build (minified) instead of `dev`.
