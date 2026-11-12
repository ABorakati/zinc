# Testing

Everything runs under Bun's test runner. There is no Node and no separate test tool. Typecheck with `bun check`, not `tsc`.

The same commands run in CI (`.github/workflows/ci.yml`). Set up first as described in [Building](building.md): `bun install --frozen-lockfile` in `core`, `word/sidebar` and `gpui-ui`, `bun core/scripts/fetch-zotero-vendor.ts`, and the fulltext placeholder file.

## The checks

| Project | Command | Notes |
| --- | --- | --- |
| `core` | `cd core && bun check && bun test --timeout 30000` | Includes the quick fuzz suite |
| `gpui-ui` | `cd gpui-ui && bun check && bun test --timeout 30000` | Pure-logic tests only; the native-window scripts are not run |
| `word/sidebar` | `cd word/sidebar && bun check && bun test` | The Word end-to-end tests skip unless enabled |
| `word/addin` | `dotnet build word/addin/ZoteroNextWord.csproj -c Release -nologo -v q -o "$TEMP/addin-out"` | `-o` keeps the build out of `word/dist` |
| `connector-host` | `cd connector-host && bun run build && bun test` | Not in CI; the test needs the compiled exe |

The same commands work on Linux and macOS, apart from the `word/addin` and `connector-host` rows, which are Windows only. The `--timeout 30000` matters on a cold Windows machine: a few translator tests copy about 750 files and exceed Bun's 5 s default.

`core/package.json` still has a `typecheck` script that calls `bunx tsc --noEmit`; use `bun check` instead, as CI does.

## Where tests live

| Location | What |
| --- | --- |
| `core/test/**/*.test.ts` | Core unit and integration tests, one folder per area (`sync/`, `websync/`, `translate/`, `cite/`, `connector/`, `mcp/`, `zport/`, `update/`, ...) and top-level files such as `migrations.test.ts`, `api.test.ts` and `server.test.ts` |
| `core/test/fixture.ts` | Helpers that create a temporary library and insert items and attachments |
| `core/test/fuzz/` | Property-based tests (fast-check) |
| `gpui-ui/src/**/*.test.ts` | Pure-logic tests next to the code they test (`*.fuzz.test.ts` for fuzzed ones) |
| `word/sidebar/test/` | Sidebar, field-code and agent tests, and the Word end-to-end tests |
| `connector-host/test/` | Native-messaging host tests |

`core/bunfig.toml` preloads `core/test/tmp-preload.ts`. It points `os.tmpdir()` at one per-run folder under `%TEMP%` (`zn-test-run-<pid>-<time>`) and removes it afterwards, plus the folders of earlier runs whose process has ended, because several tests make large library copies. Tests only use temporary folders and databases, never your library, and never the network. The HTTP tests start their own server on a free port.

## Skip rules

Tests that depend on something a fresh clone does not have skip themselves.

| Missing piece | Tests that skip |
| --- | --- |
| `core/vendor/fulltext-wasm/fulltext.wasm` (empty or smaller than 1 KiB counts as missing) | `core/test/fulltext/*`, the Find Full Text engine tests |
| `vendor/document-worker/build/worker.js` | `core/test/extract` and "retrieve metadata for PDFs" in `core/test/additems` |
| `~/Zotero/zotero.sqlite` | The zotero-db writer tests |
| `~/Zotero/zotero.sqlite` plus `data/library.sqlite` | The real-copy sync test (`core/test/sync/integration.test.ts`); override with `ZN_TEST_ZOTERO_DIR` and `ZN_TEST_LIBRARY` |
| `process.env.CI` set | The 30k-item performance tests (`core/test/perf.test.ts`, `api-perf.test.ts`) |
| `ZN_WORD_E2E=1` not set | `word/sidebar/test/word-e2e.test.ts` (starts a private invisible Word) |

The first two rules are in `core/test/needs.ts`. To see what a CI machine sees, run with `USERPROFILE` pointed at an empty folder.

## Fuzzing

The fuzz suite (`core/test/fuzz/*.fuzz.test.ts`, plus `gpui-ui/src/**/*.fuzz.test.ts`) feeds random and mutated input to code that reads untrusted data: importers, zip handling, Word field codes, the Better BibTeX formula parser, sync apply, the HTTP API and the saved-search compiler. The full table is in `core/test/fuzz/README.md`. It runs inside `bun test` with about 150 cases per property and a random seed per run.

| Variable | Effect |
| --- | --- |
| `ZN_FUZZ_RUNS` | Cases per property (default about 150) |
| `ZN_FUZZ_SEED` | Fixed starting seed (default random) |
| `ZN_FUZZ_PATH` | With a seed, replays one shrunk counterexample |

```
cd core
bun test test/fuzz                       # normal
ZN_FUZZ_RUNS=5000 bun test test/fuzz     # long run
```

A failing property prints `[fuzz] FAILED <name>`, the shrunk counterexample and a `replay:` line:

```
ZN_FUZZ_SEED=123 ZN_FUZZ_PATH="4:2:1" bun test core/test/fuzz/<file> -t "<property name>"
```

Run that line (with the real file and property name) to reproduce exactly the failing case. After fixing the bug, add the shrunk input as a plain `test()` in the same file so it stays covered without the fuzzer. A case that runs longer than its time box (3 s by default) fails; that is how hangs and quadratic blow-ups are caught. The Rust crate `gpui-ui/native/pdf` is not fuzzed.

## Headless screenshot scripts

The GPUI app can be rendered without opening a window. GPUIX's test renderer (`createTestRoot()` from `@gpuix/solid/testing`) renders offscreen, and `renderer.captureScreenshot(path)` writes a PNG, about 1440 by 881 pixels whatever size you ask for. The scripts are `gpui-ui/scripts/shot-*.tsx`; run them from `gpui-ui/`:

```
bun scripts/shot-hello.tsx out.png        # smoke test
bun scripts/shot-app.tsx out.png          # the whole app
bun scripts/shot-settings.tsx             # Settings
bun scripts/shot-update.tsx [light]       # the auto-update UI against a fake feed
```

The shell scripts share `gpui-ui/scripts/shell-shot-lib.tsx` (boot the app in the test renderer, settle, click, capture) and `_shell-env.ts`. `ZN_SHOTS=<dir>` sets the output folder (without it the scripts fall back to a fixed default folder, so set it). Each run points `ZN_UI_STATE` at a throw-away file so your real preferences are not touched. Scripts that need data talk to a core at `ZN_URL` serving a copy of a library; some scripts (for example `shot-item-actions.tsx`) write to that library, so always use a `VACUUM INTO` copy. These scripts need a GPU and are not run in CI. They are the way to check a layout change; a screenshot is not a test.

Other scripts in `gpui-ui/scripts/`: `scroll-test.tsx` and `scroll-bench.ts` (scroll timing), `memory.ts` and `startup.ts` (memory and start-up of the real window), `aot-bench.ts` (start-up of source versus compiled builds). These open a visible window; do not click in it.

## Other test groups

### Word

`word/sidebar/test/` has fast tests (`agent.test.ts`, `app.test.ts`, `fields.test.ts`, `popup.test.ts`) that run by default. The end-to-end tests drive the real add-in in a private invisible Word and are off by default:

```
ZN_WORD_E2E=1 ZN_TEST_DB=<copy of a library> bun test test/word-e2e.test.ts
```

The harness refuses to start while any `WINWORD.EXE` is running. `mcp-e2e.test.ts` tests the add-in's MCP server in two parts: set `ZN_MCP_E2E=1` for the HTTP layer and library tools (no Word), add `ZN_WORD_E2E=1` for the full citation flow. Build into a scratch folder and set `ZN_WORD_DIST=<dir>` so the tests never use the installed add-in in `word/dist`; the header of the test file lists the steps.

### Connector host

`connector-host/test/host.test.ts` replays a browser-extension save over native-messaging frames through the compiled host against a temporary library. Build first with `bun run build`. `ZNH_SOURCE_DB` makes it work on a copy of a given library; `ZNH_TEST_DIR` sets the working folder.

### Web sync and update end to end

- `core/test/websync/` tests zotero.org sync against a mock server (`mock.ts`, `rig.ts`), with no network.
- `core/test/update/e2e.test.ts` runs the real updater against a local `Bun.serve` feed with a signed manifest and a stub `.cmd` installer. `ZN_E2E_OUT=<dir>` keeps the evidence files; otherwise a temp folder is used. Run it with `cd core && bun test test/update`.

## Continuous integration

`ci.yml` runs on every push and pull request, and on manual dispatch. A newer push to the same ref cancels the run in progress. Bun is pinned to 1.4.4.

| Job | Runner | Steps |
| --- | --- | --- |
| `core` | `windows-latest` and `ubuntu-latest` (matrix, no fail-fast), 20 min timeout | install `core` and `word/sidebar`; fetch the vendored Zotero code (cached on the hash of `fetch-zotero-vendor.ts`); create the empty fulltext placeholder; `bun check`; `bun test --timeout 30000` |
| `windows-rest` ("gpui-ui, word") | `windows-latest`, 20 min timeout | install `gpui-ui`, `core`, `word/sidebar`; `gpui-ui` `bun check` and `bun test --timeout 30000`; `word/sidebar` `bun check` and `bun test`; build the add-in with `dotnet build ... -o "$RUNNER_TEMP/addin-out"` |

`ci.yml` never builds the Rust library, the executable, the installer or the connector host, and it never runs the screenshot scripts. The `core` job runs on Linux as well as Windows, so path and platform code in `core` must work on both (`core/src/platform-dirs.ts` takes the platform and environment as arguments so tests can resolve Linux and macOS paths from Windows).

`macos.yml` runs on `macos-15` (Apple Silicon), by hand and on pushes to `main` that touch code that differs per OS (`gpui-ui/native/`, `gpui-ui/src/webview/`, `gpui-ui/src/shell/`, the PDF binding, the two print modules, `platform-dirs.ts`, `library-location.ts`, `gpui-ui/package.json` and its lock file). It runs `bun check` and `bun test --timeout 30000` in `core` and `gpui-ui`, builds `native/pdf` as a dylib, fetches PDFium, and runs `gpui-ui/scripts/smoke-native.ts`. It keeps the screenshots as the artifact `macos-smoke`.

`desktop-packages.yml` builds the AppImage and the disk image; see [Releasing](releasing.md#linux-and-macos-packages).

### Native smoke test

`bun gpui-ui/scripts/smoke-native.ts [outDir]` starts the real app window on the machine it runs on (macOS in CI; it also works on Linux and Windows) against a throw-away library with its own `APPDATA`. It opens a demo PDF in a reader tab and saves `library.png`, `reader.png` and `summary.json`. On Linux and macOS it also shows a test page in the web view, clips it, and prints pages 2 and 3 of the PDF to a file without a dialog (the file must have two pages). It exits 1 if the list did not load, the PDF library could not be used, the reader tab did not open, the web view did not come up or the print is wrong. It opens a visible window; do not click in it.

`fuzz-nightly.yml` runs at 03:17 UTC every day and on manual dispatch (inputs: cases per property, default 5000, and an optional fixed seed). It runs on `ubuntu-latest` with a 120 minute timeout, installs `core` and `word/sidebar`, fetches the vendored code, creates the placeholder, and runs `bun test --timeout 3600000 test/fuzz` in `core/` with `ZN_FUZZ_RUNS` and `ZN_FUZZ_SEED` set. Whether or not it fails, it extracts the `[fuzz] FAILED` and `replay:` lines into `failure-seeds.txt` and uploads the log and that file as the artifact `fuzz-failures-<run id>` for 30 days. To reproduce a nightly failure, take the replay line from the artifact.
