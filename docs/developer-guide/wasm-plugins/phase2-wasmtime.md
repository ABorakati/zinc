# Phase 2, Wasmtime spike: a native plugin host to compare with the Bun host

Status 2026-11-18. Package: [`plugin-host-wasmtime/`](../../../plugin-host-wasmtime/) (standalone Rust crate, its own empty `[workspace]`, no file outside it was changed; `plugin-api/` and `plugin-host/` were only read). Tests: **13 pass** (`bun test bench/host.test.ts`, about 3 s). `cargo build --release` clean (4 warnings: unused helper, unused imports).

Short answer. Wasmtime runs the same components with no jco glue. On the UI fixture a cold start (process, load, `startup`, first call of each of the four big UI exports) takes **79 ms** with a precompiled `.cwasm`, against **34 s** (80 s on a busy machine) through the Bun host. A stuck plugin is stopped by its own budget in 515 ms without killing the process, and a plugin that allocates without end is stopped at its memory cap. One thing in the current plugin API does not fit: a plugin that is suspended inside an import (`ui.run-dialog`) cannot be entered again (see "What blocks").

## What was built

| File | What it is |
|---|---|
| `Cargo.toml` | Crate `zinc-plugin-host-wasmtime`, binary `zhw`. wasmtime 50.0.2 (`runtime`, `component-model`, `async`, `cranelift`), tokio, serde_json. |
| `src/main.rs` | CLI: `zhw precompile <wasm> [out.cwasm]`, `zhw inspect <wasm>`, `zhw run [--bridge bridge.ts] [--aot] [--max-memory-mb N] [--native log.write,...]`. `run` is the NDJSON protocol loop on stdio. |
| `src/host.rs` | Engine (epoch interruption), the **generic linker** (built from the component's own import types, see below), `Host.load/call/unload/stats`, epoch budget, native `log.write` / `log.debug-enabled`. |
| `src/conv.rs` | `Val` to JSON and back in jco's JS shapes (camelCase fields, `{tag,val}` variants, `option` as value or null, flags as booleans, resources as handles). `u64`/`s64` as `{"$big":"..."}`, `list<u8>` as `{"$bytes":"<base64>"}`. |
| `src/wasi.rs` | Stubs for every `wasi:*` import (same values as `wasi-stubs.ts`): empty environment, no preopens, no terminals, clocks and random work, stdout and stderr lines become `log` messages (`[stderr] ...`), `exit`, `poll`, subscriptions, sockets, http, files trap with "WASI is not available to Zinc plugins". |
| `src/state.rs` | Per-plugin store state, `ResourceLimiter` (memory cap), the bridge client, the forwarder for imports that go on to Zinc. |
| `bench/bridge.ts` | The bridge: a small Bun process. Takes `{iface, fn, args}` as JSON lines and runs the **existing** handlers of `plugin-host/src/imports/` (`discoverHandlers("host")` and extra host modules), through the same `HandlerTable` and `runHandler` the Bun host uses. No handler is reimplemented. |
| `bench/lib.ts` | The harness: `WtHost` (spawns `zhw`, speaks the protocol) and `BunHost` (the existing supervisor), both behind one `Runner` interface. |
| `bench/prepare.ts`, `run.ts`, `all.ts`, `transpile-time.ts`, `smoke.ts`, `host.test.ts` | Prepare plugin folders and `.cwasm`, measurements, one-process-per-measurement driver, build-step timing, a manual smoke check, the tests. |

### How the host works

```
Zinc (or bench harness)  --NDJSON stdio-->  zhw (Rust, tokio, one wasmtime Store per plugin)
                                              |  guest imports (async, dynamic Val functions)
                                              +-- native Rust:   log.write, log.debug-enabled (and wasi:* stubs)
                                              +-- bridge (Bun):  where "host" handlers of plugin-host/src/imports/*.host.ts
                                              +-- no handler there: {t:"import"} to the parent, which answers {t:"import-reply"}
```

- **No `bindgen!`.** Every import is registered with `Linker::func_new_async`, in a loop over `component.component_type().imports()`. Arguments arrive as `Val`, go out as JSON; the answer is converted back using the function's own result type (`result<T,E>` follows the jco rule: a handler's `WitError` becomes `err(payload)`). One 120-line function serves every world (`plugin`, `plugin-minimal`, the per-family worlds, the test `hello` world). The same for resources: all imported resources, `wasi:*` and `net.body-reader` / `attachments.file-writer`, are `ResourceDynamic` handles; constructors, methods and drops use the same `[constructor]x`, `[method]x.y`, `[resource-drop]x` names as the Bun worker, so the existing `HandlerTable` resource code is reused.
- **bindgen! numbers** (host side, world `plugin`, async imports and exports, probe crate in scratch): `cargo check` 15.8 s and 0.78 GB peak rustc working set, debug `cargo build` 18.8 s and 0.76 GB. World `plugin-ui`: 10.6 s, 0.62 GB. World `plugin-core`: 1.7 s, 71 MB. So the host side is not the guest-side memory problem. The cost would be the 313 imported and 48 exported functions of the full world (counts from jco's build log for `quick-tags`) that a host written against `bindgen!` has to implement by hand, with the deep `ui.style` types. The dynamic linker avoids that; the price is some speed in conversion (see the UI row of the steady-state table).
- **Time budget** (`Config::epoch_interruption`). A ticker thread bumps the epoch every 10 ms. Each call sets a deadline (5 s for exports, 10 s for `startup`/`install`/`shutdown`/`uninstall`, or `timeoutMs` in the call message). An epoch callback runs every tick: it yields to the tokio runtime (so a spinning plugin does not starve the others) and traps when the deadline has passed. Everything from the start of a bridged or forwarded import to its return (argument conversion, bridge, handler, result conversion) is added to the deadline: it does not count against the plugin, same rule as `protocol.ts`. A trapped plugin is `dead`: the host answers its later calls with `disabled` and sends `{t:"plugin-exit"}`. Other plugins in the process are not touched.
- **Memory cap.** `Store::limiter` with a `ResourceLimiter`: `memory_growing` fails the call with "plugin exceeded its memory limit (N MiB)" when the memory would pass `--max-memory-mb` (default 256). Peak memory per plugin is recorded and returned by `{t:"stats"}`.
- **AOT.** `zhw precompile` is `Engine::precompile_component`. `--aot` makes `load` use `<dir>/plugin.cwasm` when it exists (`Component::deserialize_file`), otherwise it compiles `plugin.wasm` at load. A `.cwasm` only loads with the same wasmtime version and settings, so it is a per-machine cache, never part of a plugin package.
- **Protocol.** The messages of `plugin-host/src/protocol.ts` (`init`, `load`, `unload`, `call`, `import-reply`, `grants`, `exit`; `ready`, `heartbeat`, `reply`, `import`, `waiting`, `plugin-exit`, `log`), one JSON object per line instead of Bun IPC. Differences and additions: bigint and bytes escapes (above); `call` may carry `timeoutMs` (the host owns the timeout, so Zinc does not need to kill the process); `ready` adds `bridgePid` and `startupMs`; `load` replies with compile, link and instantiate times; a `{t:"stats"}` request; `kind:"timeout"` comes from the host. `call-reply` is accepted and ignored (see "Left").

## Run it

```bash
cd plugin-host-wasmtime
# first build compiles wasmtime: 9 min 44 s; a rebuild of this crate: 26 s. zhw.exe (release) is 15 MB.
# cc-rs treats `kache` as a C compiler wrapper and fails on cl.exe (wasmtime-internal-fiber has a C file). Workaround, env only:
cp "$(which kache)" "$TEMP/zn-wasm-wasmtime/kache-rustc.exe"
RUSTC_WRAPPER="$TEMP/zn-wasm-wasmtime/kache-rustc.exe" cargo build --release      # still cached by kache; shared target dir untouched

bun bench/prepare.ts            # copies the fixtures other agents built, builds bench-guest, precompiles all to .cwasm
bun test bench/host.test.ts     # 13 tests
bun bench/all.ts --reps 3       # the numbers below (one fresh process per measurement)
bun bench/transpile-time.ts     # jco transpile against zhw precompile, per plugin
bun bench/smoke.ts <plugin dir> [--nobridge] [--aot]
```

Scratch is `%TEMP%\zn-wasm-wasmtime` (fixtures, `bench-guest` source, probe crate); it is deleted at the end of the work, so `prepare.ts` needs the other agents' fixtures and samples again. Set `ZHW=<path>` to use another `zhw.exe`.

## Tests

| Test (bench/host.test.ts) | Result |
|---|---|
| zhw exists; protocol: ready lists the bridge's host interfaces; load, startup, call, kebab and camel names | pass |
| a bridged import runs the existing TypeScript handler (`prefs.get` answered by `test/handlers/prefs.host.ts`, tagged with the bridge pid) and a native one runs in Rust (`log.write`), counted in `stats` | pass |
| an import with no host-side handler is forwarded to the parent as `{t:"import"}` (`log.write`, `timers.set-timeout`) | pass |
| no WASI: empty environment, no files, stderr arrives as a log line | pass |
| unknown export, unknown plugin, bad argument; the plugin is still usable after a bad argument | pass |
| QuickJS guest (`hello-js`) loads, starts, answers | pass |
| UI plugin (QuickJS, `ui-fixture`): `mount` returns a render-result of more than 5 KB | pass |
| AOT: `.cwasm` loads (`fromCwasm`), faster than compiling `.wasm` | pass |
| epoch timeout: stuck plugin stopped at its 400 ms budget (`kind:"timeout"`, `ms:400`), `plugin-exit` sent, the other plugin answers in under 300 ms while it spins, later calls to the stuck one are `disabled`, a reload of it works in the same process | pass |
| time in a host import does not count: 10,000 bridged `prefs.get` calls (about 1.5 s) under a 100 ms budget | pass |
| memory cap: a plugin allocating without end traps at its 64 MiB cap ("memory limit"), peak at most 64 MiB, the other plugin and the host are fine | pass |
| memory cap: an allocation under the cap (20 MiB) works | pass |

Not tested: `callExport` from a host handler, resource methods against a real handler (`net`, `file-writer`), `grants` updates, plugins of the `plugin` world with a Rust guest (the Rust samples were not built, see "Samples").

## Measurements

One Windows 11 machine, shared with other agents compiling at the same time: treat single numbers as ±30 %. Median of 3 fresh processes per cell (the Bun UI baseline: 1 run, it takes minutes). Release build of `zhw`, Bun 1.4.4. "bun" = the existing supervisor with the jco output in a Worker, default options. "wt-aot" = Wasmtime with `.cwasm` and the Bun bridge. "wt-aot no bridge" = Wasmtime with `.cwasm` where every non-native import goes to the parent (the harness answers). "wt-jit" = Wasmtime compiling `plugin.wasm` at load. Bench plugins: `bench-guest` (Rust, `hello` world, written for this), `hello-rust`, `hello-js` (QuickJS), `quick-tags` (the sample, QuickJS, `plugin` world, built here), `ui-fixture` (QuickJS, every UI node kind).

### Cold start: process start to first call of every export done (ms unless "s")

| Plugin (wasm) | bun | wt-jit | wt-aot | wt-aot no bridge |
|---|---|---|---|---|
| bench-guest (0.10 MB) | 65 | 86 | 62 | **29** |
| hello-rust (0.13 MB) | 262 (95 to 137 in other runs) | 201 | 98 | **22** |
| hello-js (1.10 MB) | 145 | 430 | 115 | **30** |
| quick-tags (5.92 MB) | 3,160 | 2,070 | 65 | **20** |
| ui-fixture (5.20 MB) | **33,930** (80,490 when the machine was busy) | 2,310 | 79 | **24** |

Parts for `ui-fixture`: bun = process 37 + load 2,380 + startup 7 + first calls 7,470 / 7,190 / 7,600 / 9,240 (`mount`, `update-context`, `on-event`, `resync`); wt-aot = process 67 + load 3.5 + startup 0.9 + first calls 1.9 / 1.8 / 1.8 / 1.6. The first-call cost of jco (JavaScriptCore compiling 240,000-line glue functions, `phase2-integrate.md`) does not exist in Wasmtime: the first call costs the same as the hundredth. The bridge costs about 40 ms of process start (a Bun process starting and importing the handler registry) and 40 MB; without it the host is up in 11 to 24 ms.

### Memory (working set of the host process or processes, MB)

| Plugin | bun, idle host to after calls | wt-aot, same | wt-aot no bridge |
|---|---|---|---|
| bench-guest | 42 to 57 (+15) | 48 to 51 (+2) | 5 to 7 (+2) |
| hello-js | 43 to 80 (+38) | 48 to 53 (+5) | 5 to 9 (+4) |
| quick-tags | 43 to 767 (**+725**) | 48 to 55 (+7) | 5 to 11 (+6) |
| ui-fixture | 42 to 577 (**+534**) | 49 to 54 (+5) | 5 to 9 (+4) |

wt-aot includes the idle Bun bridge (about 43 MB); the plugin itself costs the "+" figure. Wasmtime reserves address space per linear memory but commits only what the guest touches.

### Steady-state call, one sequential round trip through the harness (microseconds, median / p95)

| Plugin, export | bun | wt-aot | wt-aot no bridge |
|---|---|---|---|
| bench-guest `events.on-timer` | 163 / 461 | 127 / 250 | 118 / 218 |
| hello-rust `events.on-timer` | 269 / 623 | 139 / 248 | 167 / 266 |
| hello-js `events.on-timer` | 436 / 906 | 269 / 419 | 230 / 347 |
| quick-tags `events.on-locale-changed` | 202 / 383 | 168 / 256 | 103 / 219 |
| ui-fixture `ui-events.update-context` (returns the whole tree, 5 KB+ of JSON) | 1,162 / 2,156 | 1,378 / 2,044 | 1,304 / 2,011 |

Most of these numbers are two pipe hops and JSON in the harness, not the call. The UI row shows the price of the dynamic `Val` conversion of a big result: Wasmtime is not faster than Bun there (JSC runs the lowering JS fast once it is compiled).

### Imports: native against bridged (the guest loops N imports inside one export call; microseconds per call)

| Import | Path | us/call |
|---|---|---|
| `log.debug-enabled` | **native Rust** (no I/O) | **0.4** |
| `log.debug-enabled` | Rust to Bun bridge (no handler) to parent, harness answers | 217 |
| `log.debug-enabled` | Rust to parent directly (no bridge) | 179 |
| `log.debug-enabled` | bun: Worker to host process to Zinc-side handler | 90 |
| `log.write` | native Rust, one NDJSON line to the parent per call | 44 |
| `log.write` | Rust to Bun bridge to parent | 236 |
| `log.write` | bun: Worker to host to Zinc-side handler | 103 |
| `prefs.get` | Rust to Bun bridge, the existing TS host handler | 121 |
| `prefs.get` | bun: Worker to host process, the same handler | 57 |

A native import is about 200 to 500 times cheaper than any hop to TypeScript. A bridged import costs about twice the Bun Worker to host path (two process hops and JSON each way, against one `postMessage`). The 44 us of native `log.write` is the line written to stdout and parsed by the harness; the call itself is under 1 us. The existing handler note "NOT DONE: batching" applies here too: batch in Rust before the pipe.

### Build step and size per plugin

| Plugin | wasm | jco transpile (Bun path) | JS + core wasm on disk | `zhw precompile` | `.cwasm` |
|---|---|---|---|---|---|
| bench-guest | 0.10 MB | 0.2 s | 0.3 MB | 0.03 s | 0.34 MB |
| hello-rust | 0.13 MB | 0.1 s | 0.4 MB | 0.03 s | 0.46 MB |
| hello-js | 1.10 MB | 0.3 s | 1.9 MB | 0.23 s | 4.2 MB |
| extend-fixture | 2.80 MB | 7.6 s | 29.1 MB | 1.2 s | 9.1 MB |
| quick-tags | 5.92 MB | 15.4 s | 48.9 MB | 2.4 s | 18.4 MB |
| ui-fixture | 5.20 MB | 13.6 s | 44.6 MB | 1.7 s | 16.3 MB |

jco figures use the options of `build-plugin.ts` (minified; the unminified UI plugin is 199 MB, `phase2-integrate.md`). A `.cwasm` is about 3.4x the wasm; a minified jco folder is 8 to 9x. Building `quick-tags` end to end took 60 s (componentize-qjs plus jco); the Wasmtime path would skip the jco half. Precompile ran 1.7 to 3.2 s on the busy machine for the large plugins.

### Safety, timed

| | Wasmtime | Bun host |
|---|---|---|
| Stuck plugin, 500 ms budget | call returned `timeout` after **515 ms**; the other plugin answered in **0.3 ms** while it spun; no process killed; stuck plugin is `disabled`, `plugin-exit` sent | call rejected after 520 ms; the whole host process is killed and restarted; the other (small) plugin answered again after 592 ms. For a UI plugin the reload repeats its cold start (7 to 20 s per first call) |
| Plugin allocates without end, 64 MiB cap | trapped after **17 ms** at 63 MiB with "plugin exceeded its memory limit"; the other plugin fine; host working set 73 MB | no cap: it grows until the machine pages (not run) |

## What works

- Every plugin in the fixtures loads and runs from `.wasm` or `.cwasm`: Rust (`wasm32-wasip2`, with its `wasi:*` imports stubbed), QuickJS (componentize-qjs, no WASI imports), the `hello`, `plugin-minimal` and full `plugin` worlds (`quick-tags` is built against `plugin`: 313 imports, 48 exports).
- The existing TypeScript handlers run unchanged through the bridge (`HandlerTable`, `runHandler`, `WitError`); `where: "zinc"` imports go to the parent as `import` messages, as `host-main.ts` does.
- Epoch timeouts per call with other plugins unaffected, memory cap per plugin, peak memory per plugin, AOT load, host-side time accounting that excludes imports.

## What blocks

1. **A plugin that is suspended inside an import cannot be entered again.** `ui.run-dialog` suspends the plugin while the dialog is open, and Zinc delivers the dialog's own events (`ui-events.on-event`) to the same instance meanwhile (`phase2-core.md`, "Re-entrancy"; the ui area's dialog code, `quick-tags` and the `ui-fixture` `dialog` handler rely on it). With jco and JSPI this works. With Wasmtime it cannot: a running call holds `&mut Store` for the whole `call_async`, and the Component Model forbids entering a synchronously lifted instance again while one of its calls is in flight. In this spike a second call to the same plugin waits on the per-plugin lock, and because time inside an import is not charged, it would wait until the dialog closes: the dialog could never be answered. Not tested in code (no way to express it with the Store API); stated from the API and the spec. The fix is in the WIT, not the host: split `run-dialog` into an `open-dialog` that returns at once and a result delivered later as `ui-events.on-event` (kind `close`, with the form values), with the plugin written in continuation style. That changes the ui area, both SDKs and the samples.
2. **Packaging.** `zhw` is a native binary (15 MB per platform; the first release build compiles wasmtime in about 10 min, later builds 26 s). A `.cwasm` depends on the exact wasmtime version, its settings and the CPU features, so it must be produced on the user's machine (1 to 3 s for a large plugin) and cached by `(wasm sha256, host version)`; never shipped in a plugin package and only loaded from Zinc's own cache (`deserialize` is unsafe for untrusted input). Without the cache a load compiles for 0.2 to 2 s (`wt-jit`).
3. **Build environment.** cc-rs in this repo's cargo setup passes `kache` as a C compiler wrapper to `cl.exe` and fails on `wasmtime-internal-fiber`. Worked around with an env-only copy of `kache.exe` under another name (see "Run it"); CI needs the same or a kache fix. The global kache config was not touched.

## What is left, and smaller risks

- **Bridge latency** (about 120 us for a TS handler, 2x the Bun path) and one more process (about 43 MB, 40 ms of start). Fine for `library.*` (they call core over HTTP anyway), poor for chatty imports (`log`, `prefs.get`, `timers`, `l10n`): make those native.
- `ctx.callExport` from a bridge handler is refused (the bridge throws). It needs the Rust per-plugin call lock behind a `call` message from the bridge; the rule that a host handler cannot call a plugin that is waiting for it stays.
- `grants` messages are accepted but not forwarded to the bridge (`ctx.grants` would be stale). Heartbeat is sent from a tokio timer.
- Resources for the zinc interfaces are generic but only the `wasi:*` ones ran end to end. `net.body-reader` and `file-writer` need a test with the real handlers.
- A plugin looping forever over cheap imports is never stopped (same as the Bun host: import time is not charged). A call counter would fix it.
- Budget granularity is one 10 ms tick; an `epoch` check costs a few percent of guest speed (not measured).
- No pooling allocator: each instance maps its memory with the default settings. Not needed at 5 to 10 plugins.
- `bench/` is not type-checked (no `package.json` or `node_modules` here by design; it imports `plugin-host/src` and resolves jco from `plugin-host`).

### Samples

`plugin-api/samples/quick-tags` (JS) was built (`bun plugin-api/sdk/js/scripts/build.ts ... --out <scratch>`, 60 s) and runs on both hosts. **Missing: `word-count` and `highlight-export`** (Rust, they depend on `plugin-api/sdk/rust`, which another agent is still changing; the full-world guest build is the known out-of-memory case, so it was not tried). The Rust paths are covered by `bench-guest` and `hello-rust`, which are also `wasm32-wasip2` components with the real `wasi:*` import set. `ui-fixture` and `extend-fixture` were taken from other agents' scratch folders. For the Bun baseline of `quick-tags` the harness adds a stub `zinc` handler for `extend.register-menu` (the discovered `*.zinc.ts` handlers are not loaded by the harness); Wasmtime answers it through the parent forwarder.

## WIT rows implemented

Native in Rust: `log.write`, `log.debug-enabled` (default `--native log.write`). Every function that a `*.host.ts` handler implements is reachable unchanged through the bridge (library, attachments, fulltext, schema, cite, translate, sync-control, data-utils, notifier, util, net, fs-host); every `*.zinc.ts` function through the parent forward. Exercised here: `prefs.get` (the test handler), `log.write`, `log.debug-enabled`, `timers.set-timeout`, `extend.register-menu` (stubs). The real library and fs handlers were not run (they need a core).

## WIT changes

None made. One needed if Wasmtime becomes the runner: replace the blocking dialog with a non-blocking open plus a close event (blocker 1).

## Needs from other areas

- `plugin-host/src/supervisor.ts` (owned by the Bun-AOT agent): nothing was changed; see the estimate for what the wiring needs.
- The ui area decides about `run-dialog` (blocker 1).
- Bun AOT agent: the harness (`bench/lib.ts`, `Runner`) can time an AOT-process runner next to these two if it is given the same `load/startup/call` surface.

## Estimate: Wasmtime as the default runner

| Work | Days (one developer) |
|---|---|
| Supervisor wiring: a `runner: "wasmtime"` transport (spawn `zhw`, NDJSON with `$big`/`$bytes`, same message handling), timeouts taken from the host (`kind:"timeout"` and `plugin-exit` disable only that plugin, no restart of the process), drop `coldBudget` and the cold bonus for this runner, run the existing `supervisor.test.ts` and `queue.test.ts` against both runners | 3 to 4 |
| Handlers. **Option A** keep the bridge: no handler work, +120 us per host-handler call, one extra Bun process. **Option B** (recommended) drop the bridge and run the `*.host.ts` handlers in the Zinc process like the `*.zinc.ts` ones (they only need `coreUrl`): the supervisor already answers `import` messages; measured cost 180 us per call and no extra process | 1 (B) |
| Native Rust for the chatty imports: `log` (with batching), `prefs.get/has/get-all` with a cache the app updates, `timers`, `l10n`, `app`, `util`. Each family 0.5 day including a test; `library`, `attachments`, `net`, `fs` stay in TypeScript | 3 |
| Packaging: build `zhw` per platform in the app build, precompile at install and at host upgrade into a cache keyed by `(sha256, host version)`, fall back to JIT, remove stale entries | 2 to 3 |
| Finish the spike gaps: `callExport` through the call lock, `grants` forwarding, resource tests with real handlers, a call counter for import loops, the heartbeat from the host runtime | 2 |
| Dialogs (blocker 1): WIT change, ui area, JS and Rust SDK helpers, samples, docs | 3 to 4, owned by the ui area |
| Total | about 2.5 to 3 weeks, of which the dialog change is the part with the most risk |

The Bun runner can stay as a per-plugin fallback in the meantime, since both speak the same protocol. If the Bun AOT result closes most of the cold-start and memory gap, the remaining arguments for Wasmtime are the hard memory cap, killing nothing on timeout, and the removal of the jco glue from the build and the installer; the arguments against are the native binary per platform, the cwasm cache, and the dialog redesign.
