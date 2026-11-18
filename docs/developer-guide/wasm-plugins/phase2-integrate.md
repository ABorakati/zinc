# Phase 2, integrate agent: one working system

Status 2026-11-18. Work done in `plugin-host/` and `gpui-ui/src/wasmplugins/`. See "Tests and results" for what ran and what did not (disk floor).

## What changed

### 1. One call queue per plugin (`plugin-host/src/supervisor.ts`)

Every call into a plugin (`call`, `start`, `stop`, `enable`, `ctx.callExport` from a handler in either process) goes through one queue per plugin; its time budget starts when it leaves the queue.

- Host-side handlers (`where: "host"`, for example the notifier) used to call the Worker directly. `ctx.callExport` there now sends a `call` message to Zinc (`protocol.ts`: `FromHost "call"`, `ToHost "call-reply"`), so it joins the same queue and budget.
- **Nested exception (dialogs).** Each zinc import call gets its own handler context with a `live` flag. While that handler has not returned, `ctx.callExport` on that context is *nested*: it skips the queue (the plugin's call is suspended in this very import, so waiting would deadlock) and runs one after another with other nested calls of the plugin. The ui area's dialog events use exactly this (`ui.zinc.ts` passes the handler's `ctx.callExport`). A nested call's budget pauses only for imports started after it (`Pending.baseline`), so a runaway dialog handler is still caught.
- A host-side handler cannot nest: calling a plugin that is waiting for you hangs. Documented in `HandlerContext.callExport`.
- Removed the private queues: `PluginManager.exclusive` (pkg) and the queue, `untilSettled` and first-ui-call budget in `gpui-ui/src/wasmplugins/reader/link.ts` (now a thin picker of the supervisor).
- New tests `plugin-host/test/queue.test.ts` (4): three overlapping calls run in order; budget starts at dequeue (150 ms budget, ~400 ms calls, none times out); a host handler's `callExport` is delivered; cold bonus values. The old re-entrancy test (nested) still passes.

### 2. Slow first calls of QuickJS guests: root cause and handling

Measured with the ui fixture (`world ui-fixture`), Bun 1.4.4, componentize-qjs 0.6:

| What | Result |
|---|---|
| jco output `transpiled/plugin.js` | **199 MB, 4.6 million lines** |
| `import plugin.js` | 2.8 s |
| core wasm compile + instantiate | 2.4 s (JSC compiles lazily; fast) |
| `lifecycle.startup` | 11 ms |
| first `ui-events.mount` (args rejected during lowering, so no guest code ran) | **18.6 s** |
| second call | 0 to 4 ms |

Root cause: not wasm tiering, not the componentize flags, and not the guest. jco **inlines the lift and lower code of every type into every function that uses it**. `ui-events.mount`, `update-context`, `on-event`, `resync` are each a 240,000-line JS function (`render-result` contains `style` about 56 times in `mount` alone: 936 `ColorToken` switches, 4,204 `option` checks); `render-range` 64,000 lines; the import trampolines for `ui.push` / dialog specs 1,000,000 lines each (`trampoline25`, `32`). JavaScriptCore generates bytecode for a function when it first runs, so the first call of each pays 15 to 22 s, once per process, and the first use of each big import pays too. The measurement call that threw at argument 1 still cost 18.6 s: the cost is compiling the function, not running it.

Things tried:

- `jco transpile minify: true`: file 199 MB to **39 MB**, import 2.8 s to 1.5 s, but first call 20.9 s (same). Kept: it cuts disk 5x per UI plugin (build and installer both). Transpile takes about 19 s with it.
- Warm-up at load (call each big export with bad arguments so lowering throws): works in principle (the instance survives, shown above) but costs about 20 s per export on the Worker at every start, 100 s or more per UI plugin, and cannot reach the import trampolines. Not done.

Fix applied: `SupervisorOptions.coldBudget` (default on). A plugin whose `transpiled/plugin.js` is at least 8 MB gets 3 s per MB (at most 300 s) added to the budget of every call, lifecycle call and `ctx.callExport` (`supervisor.coldBonusMs(id)`). The ui fixture (39 MB) gets +117 s; small plugins keep 5 s / 10 s. Trade-off: a runaway export in such a plugin is killed after about 2 minutes instead of 5 s; applies to every call because the first use of an import (not only of an export) can hit a cold compile.

**The real fix is a WIT or toolchain change, not done here** (WIT is the phase 1 contract): make the types that reach `render-result`, patches and dialog specs smaller. `style` (about 60 option fields, 18 colour fields) appears in `node-props`, five `style-states` fields, `named-style` and `row-style`. Passing the tree or `style` as a JSON string, or a jco release that emits per-type helper functions, would take the first call from 20 s to milliseconds and the install size from 40 MB to under 1 MB. Rust guests were not measured (their jco output has the same shape).

### 3. Failing supervisor test

`createPluginSupervisor({ discoverHostHandlers: false })` (and the `init.discover` flag, `host-main.ts`) skips `src/imports/*.host.ts`; `test/helpers.ts` `newSupervisor` sets it, so the core tests keep their stub handlers whatever other areas add. The sdk agent's `samples/support/host-entry.ts` source patch can be replaced by this option (not edited: `plugin-api/**` is not mine).

### 4. Context, tsconfig, exports

- `HandlerContext.pluginDir` (folder of the plugin package; both processes). `fs` root `bundled` uses it.
- `tsconfig.json` includes `test/pkg`. `test/data` is not type-checked: it imports core sources whose `.sql` and untyped imports fail under this tsconfig (21 errors, none in the tests' own logic).
- `src/index.ts` re-exports `./package/index` and the data hooks (`setFilePicker`, `setClipboardBackend`, `setShellBackend`, `configureFs`, `clearTempRoot`, `addGrant`).

### 5. App wiring (`gpui-ui/src/wasmplugins/index.ts`, new `wire.ts`)

`startWasmPlugins()` with plugins on: `createPluginRuntime` with every discovered zinc handler, `prompt: promptPermission`, app providers (version, features `extend.menubar`, windows, `prefs.get-app` over `shell/prefs`), `manager: { root }`; then `wireApp()`, `bindExtendUi`, `installReaderBridge`, `onPluginRegistrationsReset(clearUiOf)`, status and host-restart clearing as before, `manager.startAll()`, `windowLoaded(1)`.

`wire.ts`: file picker over `promptForPaths` (open, open-multiple, directory; save is refused, GPUIX has none), clipboard over `ui/clipboard` with a confirm dialog for the first read, shell scheme confirm, plugin prefs for settings panes over the package `PrefStore` in process (`setPrefsAdapter`; no core route), drops become read grants (`setDropGrantFactory` + `addGrant`), `bindReaderApp(store)`.

- The host process is a separate process: `fs` roots reach it through `ZN_PLUGIN_DATA_DIR` / `ZN_PLUGIN_TEMP_DIR` set before the supervisor spawns it (the temp folder is emptied by `manager.init()`, so `clearTempRoot` is not called).
- Removed `OPTIONAL_HANDLER_MODULES` (ui, reader and extend handlers are found as `*.zinc.ts`). `pluginsDir()` is the package root; installed plugins are under `installed/`.
- Test and dev entry: `startWasmPlugins({ dirs, handlers, force })` still loads built folders straight into a plain supervisor with declared grants (no package manager, no user plugins folder). `ZN_WASM_PLUGIN_DIRS` does the same in a running app.
- **Plugins off (default):** `platform.ts` is untouched; it still only imports `wasmplugins/flag` (reads one persisted setting). `RichNote.tsx` imports `wasmplugins/flag` and loads the note head module only when plugins are on. Nothing else in the start path changed.

### 6. Note editor

- `itempane/RichNote.tsx` draws `NoteEditorHead` between the header and the editor box (lazy, plugins on only).
- `webview/notes.ts`: `onNoteSaved(fn)`, `onNoteShown(fn)`, `openNote(key)` (selects the note in the library item pane). The reader area now uses them instead of polling `noteDebug`; `note-editor.open-note` works that way (returns no editor-info).
- **Untested** (no WebView2 headless): the head strip drawing, the two listeners firing, `open-note`. They type-check only.

## Tests and results

See the end of this file.

## Still open

- The first-call cost (above): the WIT/toolchain fix; until then 100+ s of CPU per UI plugin start-up and a 2-minute kill delay for those plugins.
- Quit does not call plugin `shutdown` (no async exit hook in the app); the host process exits when Zinc goes away.
- `canPrompt` (focused window and recent user action) is not supplied: permission prompts are always allowed.
- Packaged build: `discoverHandlers` and `BUN_BE_BUN=1` spawn unverified; the transpiler needs `plugin-api/wit`.
- Nested-call rule: any other zinc handler that calls `ctx.callExport` while running is nested too; only dialogs are meant to.
- `test/data` is outside `bun check`.

## Tests and results (appended at the end)

| Command | Result |
|---|---|
| `bun test` in `plugin-host/` | **129 pass, 0 fail** (27 s), including `supervisor.test.ts` "WIT resources" and the new `queue.test.ts` |
| `bun check` in `plugin-host/` | clean (86 files, with `test/pkg`) |
| `bun check` in `gpui-ui/` | clean (733 files), after all edits |
| `bun test src/wasmplugins/ui src/wasmplugins/reader` in `gpui-ui/` | 39 pass (these two folders' unit tests; no fixture build) |
| `bun test src/store.test.ts` | 7 pass |

**NOT RUN, because of the disk floor:** `bun test src/wasmplugins/extend`, `shot-wasm-ui.tsx`, `shot-wasm-extend.tsx`, `shot-wasm-reader.tsx`, and the gpui-ui tests that mount `RichNote`/the app. C: had 9215 to 9214 MiB free (floor 9216) for the whole second half of the session and did not recover in 10 minutes; each of those builds a QuickJS fixture (about 40 MB minified, 199 MB before). The `index.ts` rewrite, `wire.ts`, the `link.ts` change, the note editor changes and the reader's `noteevents.ts` change are therefore verified by type check only. Run them first when space is free: `bun scripts/shot-wasm-extend.tsx`, `shot-wasm-ui.tsx`, `shot-wasm-reader.tsx`, `ZN_UI_STATE=off bun test src/wasmplugins/extend`. Expected effect of the new budget: those scripts no longer need their own long budgets.
