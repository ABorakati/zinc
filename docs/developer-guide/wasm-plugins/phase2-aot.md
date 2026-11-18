# Phase 2: AOT for plugins (feasibility spike)

Status: works on Windows with the Bun canary; **experimental, off by default**. The default runner is unchanged (a Worker per plugin).

## Result in one table

Plugin: the QuickJS UI fixture (`gpui-ui/src/wasmplugins/ui/test/fixture-ui-js`, world `ui-fixture`, jco `minify: true`), Bun 1.4.4 (stable) for
the host, canary `1.4.5-canary.1+5f3f8fe48` for the AOT build, Windows x64. Times are wall clock from the supervisor (`sup.call`), cold = first
call in a fresh host process, one run each.

| Step | Worker (today) | AOT process | Bytecode cache (tried, then stopped) |
|---|---|---|---|
| `load` (import glue + compile and instantiate core wasm) | 5340 ms | **214 ms** | 326 ms |
| `lifecycle.startup` | 12 ms | 9 ms | 7 ms |
| first `ui-events.mount` | **36 122 ms** | **6 ms** | 25 ms |
| first `ui-events.update-context` | 22 751 ms | 4 ms | 22 ms |
| first `ui-events.on-event` | 19 850 ms | 4 ms | 22 ms |
| first `ui-events.resync` | 20 056 ms | 2 ms | 23 ms |
| first `ui-events.render-range` | 911 ms | 3 ms | 5 ms |
| second `mount` (warm) | 24 ms | 4 ms | 4 ms |
| steady `on-event`, mean of 300 calls | 2.64 ms | 2.98 ms | not measured |
| build time (after jco) | 0 | **114 to 127 s** | 66 to 85 s |
| size on disk | `plugin.js` 37.6 MB (+ 4.9 MB core wasm) | `aot/plugin.exe` **316 MB** (plus the 42 MB transpiled folder, which stays) | `plugin.js` 38 MB + `.jsc` 94 MB (minified), 93 + 110 MB unminified |

Small plugins (jco output under 1 MB of JS) gain nothing, and an executable costs 85 to 97 MB each:

| Plugin | build | `aot/plugin.exe` | `load` Worker / AOT | `startup` Worker / AOT |
|---|---|---|---|---|
| hello-rust | 2.7 s | 85 MB | 40 / 38 ms | 20 / 16 ms |
| spin-rust | 2.5 s | 85 MB | not measured | not measured |
| hello-js (QuickJS, no UI) | 4.5 s | 93 MB | 82 / 94 ms | 16 / 13 ms |

## What was found

1. **`compile.aot` works on Windows** with the canary Zinc already uses (`gpui-ui/scripts/_bun-canary.ts`; `ZN_BUN_CANARY` overrides). Same pattern as `gpui-ui/scripts/build.ts`: the stable Bun process (installer, build script) starts `<canary>/bun src/package/aot-compile.ts <entry> <out>` as a child.
2. **JSPI works under AOT.** `WebAssembly.Suspending` and `WebAssembly.promising` exist in the exe, and a jco `--async-mode jspi` component with async imports runs (the import round trip to the host works, `ui.push`-style imports included through the supervisor).
3. **The core wasm modules are compiled at build time.** A `.wasm` imported statically without `with { type: "file" }` is compiled by the build, and the runtime finds the compiled copy by content when jco's `getCoreModule` builds the module from `Bun.file(path).arrayBuffer()` (the trick `build.ts` uses for `fulltext.wasm`). Evidence is indirect: `load` (28 core modules, 4.9 MB of wasm) takes 143 ms in the exe against 2.4 s of compile and instantiate under the JIT host, and the build grows with the wasm. I did not dump machine code.
4. **jco's glue does not break on frozen built-ins.** The 4.6-million-line `plugin.js` ran unchanged, and the full supervisor suite passes with every plugin as an AOT process (see Tests).
5. **The 15 to 22 s first-call cost is gone**, because the 240,000-line functions are compiled at build time instead of on first call. It is the same effect the bytecode cache gave (25 ms), at 3x the disk and 1.5x the build time, but it needs a different process model.
6. **Steady-state speed is the same** (about 3 ms per `on-event`, dominated by the IPC hop and QuickJS inside wasm), so AOT gives no throughput gain here, only cold start.
7. **No dynamic loading.** An AOT executable cannot take a plugin at run time (code built at run time is interpreted, built-ins are frozen). So each plugin is its own executable: `src/plugin-runtime.ts` + the jco glue + the core `.wasm` files, all static. The plugin host runs it as a child process.

Costs and blockers:

- **Disk**: 85 MB for a Rust plugin, 93 MB for QuickJS, 316 MB for a UI plugin. The jco output stays too (the installer re-checks its hash). C: is tight; this is the main reason not to turn it on for every plugin.
- **Needs the canary at install time**, on the user's machine (`gpui-ui/scripts/_bun-canary.ts` downloads it from npm; the packaged Zinc would have to ship or fetch it). A failed build only logs and the plugin keeps running in a Worker.
- **Build time** 2.5 to 4.5 s for small plugins, about 2 minutes for a big UI plugin, on top of 20 to 35 s of jco.
- **Linux**: the AOT exe turns on `PR_SET_MDWE` (see `building.md`, "The AOT canary"). Not tried here.
- **Type checking in the AOT build**: a `plugin.d.ts` next to `plugin.js` made the canary report TS errors and fail. The installer and `build-plugin.ts` use `noTypescript: true`, so there is none; keep it that way.
- **Child processes must not inherit `BUN_BE_BUN=1`**: the host process has it set, and the exe then runs as the `bun` CLI and exits with code 70. `worker.ts` clears it.
- **Cleanup when the host is killed**: on Windows the AOT child died with the host in every test (spinning plugin included, no leftover `plugin.exe` processes). That is OS job-object behaviour, not something this code guarantees. The exe also exits when its stdin closes and when the host pid is gone, but those checks run on its main thread and cannot fire while the wasm is spinning. Linux and macOS: not tested; a watchdog thread in the exe would be needed.

## Bytecode cache (done first, then stopped)

`Bun.build({ entrypoints: [plugin.js], target: "bun", format: "cjs", bytecode: true })` works on stable 1.4.4 and gives `plugin.js` + `plugin.js.jsc`; Bun loads the `.jsc` next to the `.js` automatically. `format: "esm"` is refused ("ESM bytecode requires compile: true"). It reached 25 ms for the first `mount` and 326 ms for `load`, in the normal Worker, with stable Bun, no canary, no extra process. A truncated `.jsc` is **silently ignored**: the plugin then runs on the plain JS with the old 20 s first calls, and Bun logs nothing, so a fallback message would have to come from our own check. I stopped there on the coordinator's instruction and left no bytecode code in the tree. Of the two, bytecode is the cheaper way to remove the cold start; AOT is the one that also compiles the wasm ahead of time.

## WASM compile cache

Nothing in Bun 1.4.4 or in the JSC it embeds exposes a serialized compiled `WebAssembly.Module` (no `module.serialize()`, no code cache option on `WebAssembly.compile`; `v8.serialize` does not take modules). The only ahead-of-time route is the canary's build-time compile above, which `aot-process` uses. Under the JIT host the core modules compile lazily and take about 2.4 s for this plugin, so this is not where the 15 to 22 s went.

## What was built (all under `plugin-host/`)

| File | What |
|---|---|
| `src/plugin-runtime.ts` | The old body of `worker.ts` (imports, resources, `call`, wasi stubs), now with `startRuntime(send, load)`. Shared by the Worker and the AOT exe. |
| `src/worker.ts` | Thin: the Worker path as before. With env `ZN_PLUGIN_RUNNER=aot-process` and an `aot/plugin.exe`, it starts the exe (`Bun.spawn`, Bun IPC, `serialization: "advanced"`, stdin pipe) and relays messages. If the exe is missing, cannot be started, or exits before it answered `init`, it logs a warning and runs the plugin in the Worker. A later exit surfaces as a Worker error, so `host-main` reports `plugin-exit` as before. |
| `src/package/aot-layout.ts` | `AOT_EXE` (`aot/plugin.exe`, no extension off Windows). |
| `src/package/aot.ts` | `buildAot(pkgDir)`: writes the entry from the template, runs the canary on `aot-compile.ts`, moves the result to `aot/plugin.exe` (nothing half-written). Also `findCanary()`, `hashFile()`, `aotEntrySource()`. |
| `src/package/aot-entry.template.ts`, `aot-compile.ts` | The exe's entry (static glue and static core `.wasm` imports) and the `Bun.build({ compile: { aot: true } })` call. |
| `src/package/installer.ts` | Option `aot: true \| { minBytes, build }` (default off; threshold 8 MB of transpiled JS, the same as `coldBudget`). Builds into the staging folder after jco, records `aotHash` in `state.json`. At load, an exe that does not match its hash is deleted with a warning and the plugin runs in a Worker. A failed build only logs. |
| `src/supervisor.ts` | Option `runner?: "worker" \| "aot-process"` (passes `ZN_PLUGIN_RUNNER` to the host). `coldBudget` is unchanged (see below). |
| `scripts/build-plugin.ts` | **Not changed.** It builds the dev folder; `buildAot(out)` can be called on its output. See "Left". |
| `test/aot.test.ts` | 8 tests, below. `test/helpers.ts`: `ZN_TEST_RUNNER=aot-process` builds an exe for each fixture and runs every supervisor test through it. |

Run: `bun -e 'import {buildAot} from "./src/package/aot"; console.log(await buildAot("<built plugin folder>"))'`, then a supervisor with `runner: "aot-process"`, or `ZN_PLUGIN_RUNNER=aot-process` for a host started by hand. Install-time: `createPluginRuntime({ manager: { aot: true }, supervisor: { runner: "aot-process" } })`.

## Tests

| Command | Result |
|---|---|
| `bun test` in `plugin-host/` (default runner) | **135 pass, 2 fail** (137). The 2 failures are in `test/data/e2e.test.ts` ("library.apply from the guest ... origin self" and the test after it): the batch with `origin: self` never arrives. They are caused by the change-feed work in `core/` (`core/src/changes/`, `db.ts`, `api.ts` are modified and uncommitted by another agent), not by this change: the same two fail with `ZN_TEST_RUNNER=aot-process`, and they use no AOT code. I could not re-run them against the old `worker.ts` (not committed). Before this work the suite was 129/129. |
| `ZN_TEST_RUNNER=aot-process bun test` (all fixtures as AOT executables) | 127 pass, 2 fail (the same two; that run was before `test/aot.test.ts` existed). Includes the timeout-kills-host-and-restart tests with a spinning Rust plugin as an AOT child, unload, and callbacks. No `plugin.exe` processes left after the run. |
| `bun test test/aot.test.ts` | 8 pass: entry source has every core module; missing exe falls back to a Worker with a warning; garbage exe falls back; install builds only over the threshold and records the hash; a failed build does not fail the install and leaves no `aot/`; a modified exe is deleted at load; **a real install compiles `aot/plugin.exe` and the plugin runs as the AOT child process**; a timeout kills the host and its AOT child. The last two need the canary and are skipped without it. |
| `bun check` in `plugin-host/` | no errors (92 files) |

## Recommendation

- Do not change the default. Keep `coldBudget` as is: the default Worker runner still has the 20 s first calls, so lowering it would break big plugins (I left `supervisor.ts` `coldBudget` alone).
- If the 20 s is to go, there are three routes, and the cheap one is not AOT: (1) shrink what jco inlines (WIT or jco change, the fix proposed in `phase2-integrate.md`); (2) the stable-Bun bytecode cache above, 25 ms first call, no canary, no extra process, but it needs our own staleness check because Bun falls back silently; (3) this AOT runner, which also compiles the wasm ahead of time, but costs 3x the disk of the bytecode route per big plugin, a canary on the user's machine, a 2 minute install step and a process per plugin.
- If AOT is wanted, turn it on only for plugins over the size threshold (`aot: true` already does), keep Worker fallback, and decide what the packaged Zinc does for the canary and for Linux (MDWE).

## Left

- `build-plugin.ts` has no `--aot` flag; call `buildAot(out)` on its output (a one-line change if wanted).
- No watchdog thread in the exe for a spinning child on Linux and macOS.
- No numbers for a Rust UI plugin (none exists), and one run per number, so treat the ms values as indicative.
- `host-main.ts` is unchanged: the process relay lives in `worker.ts`, one extra Worker thread per AOT plugin that only forwards messages.

## WIT changes

None.

## Needs from other areas

- `core/` change-feed work: `plugin-host/test/data/e2e.test.ts` fails 2 tests while it is uncommitted (see Tests).
- Decision for the coordinator: how the packaged Zinc gets a canary (or whether to prefer the bytecode route).
