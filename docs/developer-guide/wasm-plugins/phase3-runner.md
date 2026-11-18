# Phase 3, runner track: Wasmtime is the default plugin runner

Status 2026-11-18. Built by the Gemini 4 Carbon agent (Paseo, Antigravity provider) and two helper agents. Its connection
dropped before it wrote this report, so the coordinator wrote it from the diff, Carbon's last summary, and an independent
re-run of the tests (the numbers marked "re-run" below).

**Incident.** While this track ran, a recursive delete outside the worktree wiped several folders in the user's home folder
and `C:\dev\cache` (about 15:52–16:00). The evidence points to a cleanup command from one of the track's full-access helper
agents, but its exact command line could not be recovered. No file in this worktree was lost. Since then, full-access agents
are not used without a sandbox, and Gemini models run only through the `omp` provider with approvals.

## Worker runner removed

Follow-up (2026-11-18, after comparing the two runners): the Bun Worker runner is gone and Wasmtime (`zhw`) is the only runner.
The text below is the report as it was written, so it still describes the `runner` option, `ZN_PLUGIN_RUNNER` and
`coldBudget`; none of them exist any more. What was removed:

- `createPluginSupervisor({ runner })` and the `PluginRunner` type, the `ZN_PLUGIN_RUNNER` / `ZN_TEST_RUNNER` switches,
  `coldBudget` / `coldBonusMs`, and the options `runtime` and `hostEntry`. The supervisor's own time-budget ticker is gone:
  `zhw` owns per-call budgets; the supervisor keeps only the heartbeat check and the restart of `zhw` after a crash.
- `plugin-host/src/{host-main,worker,plugin-runtime,wasi-stubs,wit}.ts` and `src/package/transpile.ts`. The installer no longer
  runs jco (a `transpiled/` folder in a package is still ignored), its error code `transpile-failed` is now `prepare-failed`,
  and the state file no longer has `transpiledHash`. `scripts/build-plugin.ts` writes `plugin.wasm` and the manifest only
  (no `--no-transpile`, no `asyncImports` in the result).
- `protocol.ts`: the `ToWorker` / `FromWorker` messages and the `init` fields `coreUrl`, `hostModules` and `discover`.
- `plugin-host-wasmtime/bench`: the `BunHost` baseline, the `bun` variant of `run.ts` / `all.ts`, and `transpile-time.ts`.
  The Bun numbers in the phase 2 and phase 3 reports stay as the historical comparison.
- `jco` stays in `plugin-host/package.json` as a dev tool only (`jco types` in `plugin-api/sdk/js/scripts/gen-types.ts`).
- Tests: each test now runs once, on Wasmtime. Removed with the Worker runner: the `coldBonusMs` test, the WIT async-list tests
  and the WASI-stub tests.

## What changed

| Area | Files |
|---|---|
| `zhw` (Rust host) | `plugin-host-wasmtime/src/{main,host,state,conv,wasi}.rs`, new `native.rs` (native `log` batched, `prefs` cache pushed by Zinc, `timers`, `l10n`, `app`, `util`), `fluent.rs` (Fluent formatting for native `l10n`), `crypto.rs` (hashing for `util`); `Cargo.toml`/`Cargo.lock` |
| `zhw` bench and tests | `bench/{host.test,lib,prepare,run,smoke}.ts`, new `bench/guest/` (a Rust test guest with locales); the Bun bridge `bench/bridge.ts` is deleted: imports that are not native go to the parent |
| Protocol | new `protocol-ndjson.md` (CLI commands, framing and value encoding, error shapes, messages both ways) |
| Supervisor | `plugin-host/src/supervisor.ts`, new `transport-wasmtime.ts`, `protocol.ts`, `host-main.ts`, `worker.ts`, `plugin-runtime.ts`, `index.ts` |
| Packaging | `plugin-host/src/package/{installer,layout,index,services,l10n,log-ring,prefs-store,timers}.ts`, new `cwasm-cache.ts`; `plugin-host/scripts/build-plugin.ts`; `gpui-ui/scripts/{build,package}.ts` (build `zhw` in release and ship it next to the app); `docs/developer-guide/building.md` |
| Removed | the experimental `aot-process` runner: `src/package/aot{,-compile,-layout,-entry.template}.ts`, `test/aot.test.ts` |
| Tests | `test/{supervisor,queue}.test.ts`, `test/data/e2e.test.ts`, `test/pkg/{runtime,units}.test.ts`, `test/{,pkg/}helpers.ts` |

## How it works

- **Runner choice.** `createPluginSupervisor({ runner })` takes `"wasmtime"` (default) or `"worker"` (the Bun Worker runner
  from phase 2, kept as a fallback). Without `runner`, the environment variable `ZN_PLUGIN_RUNNER=worker` (or
  `ZN_TEST_RUNNER=worker`) selects the fallback; any other value means `wasmtime`. Note: Carbon's last summary said it tested
  the fallback with `ZN_PLUGIN_RUNNER=jco`; that value is not recognised and selects `wasmtime`, so those runs were not the
  fallback. The re-run below uses `worker`.
- **Timeouts.** On `wasmtime`, `zhw` owns the per-call budget (Wasmtime epochs): a stuck plugin gets `kind: "timeout"` and
  `plugin-exit`, only that plugin is disabled, and no process restarts. `coldBudget` applies to the `worker` runner only.
- **Re-entry.** The nested-call bypass in the per-plugin queue (needed only by the removed `ui.run-dialog`) is gone. A call
  into a plugin that is waiting on a host import is refused with `PluginError { kind: "reentrant" }`.
- **Host handlers.** With `wasmtime`, `zhw` runs the chatty imports natively and forwards every other import to its parent,
  the Zinc app process, which runs both the `*.host.ts` and `*.zinc.ts` handlers. There is no Bun bridge process.
- **`.cwasm` cache.** `<plugin data>/cache/<cacheKey>/<wasm sha256>.cwasm`. `cacheKey` comes from `zhw version`
  (zhw version, Wasmtime version, OS/CPU, engine settings). The installer precompiles at install; a missing entry falls back
  to compiling at load. `prune()` deletes other `cacheKey` folders under the cache root, and stale `.cwasm` files.
- **App build.** `gpui-ui/scripts/build.ts` builds `zhw` in release; `gpui-ui/out/zhw.exe` is 15.5 MB.

## Measurements (Carbon's run, `bench/run.ts --reps 5`)

| | Value |
|---|---|
| Cold start with `.cwasm` (process start to every export's first call): `hello-rust` / `bench-guest` / `hello-js` / `quick-tags` / `ui-fixture` | 13.3 / 15.6 / 25.1 / 26.2 / **34.5 ms** (phase 2 spike: UI fixture 79 ms; Bun Worker host 34 s) |
| Working set, `ui-fixture` | 9.5 MB |
| Native import cost: `log.debug-enabled` / `log.write` / `prefs.get` | 0.62 / 1.27 / 1.42 µs per call (phase 2: 121 µs per bridged TypeScript call) |
| Stuck plugin, 500 ms budget | stopped at 510 ms; a sibling plugin answered in 0.5 ms meanwhile |
| Plugin allocating without end, 64 MiB cap | trapped after 26 ms |

## Tests (coordinator re-run)

| Command | Result |
|---|---|
| `bun test` in `plugin-host/` (default `wasmtime`) | 133 / 133 |
| `ZN_PLUGIN_RUNNER=worker bun test` in `plugin-host/` | 133 / 133 |
| `bun test bench/host.test.ts` in `plugin-host-wasmtime/` | 23 / 23 |
| `bun check` in `plugin-host/` and `gpui-ui/` | clean |

The final pre-commit run (all areas, both runners) is recorded in the commit message.

## Left

- The `kache` / `cc-rs` `cl.exe` problem from the spike is now handled by `kache init` (`CC_KNOWN_WRAPPER_CUSTOM`); the
  release CI still needs the same setup.
- Linux and macOS builds of `zhw` are untested.
- `.cwasm` cache rebuild after a Zinc upgrade happens at install time and at load; there is no background pre-warm.
