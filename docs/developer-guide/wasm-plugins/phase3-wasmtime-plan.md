# Phase 3 plan: Wasmtime as the default plugin runner (2026-11-18)

Decision (user, 2026-11-18): plugins run in Wasmtime, precompiled to `.cwasm` on the user's machine. Evidence:
`phase2-wasmtime.md` against `phase2-aot.md`.

| UI plugin | Bun Worker (today) | Bun `--aot` process | Wasmtime `.cwasm` |
|---|---|---|---|
| Cold start, all first calls | 34 s | 2–6 ms per call, ~2 min build | 79 ms total |
| Memory per plugin | +534 MB | n/a | +4–7 MB |
| On disk | 44.6 MB jco glue | 316 MB exe | 16.3 MB |
| Stuck plugin | host killed, all reload | its process killed | that plugin stopped, others run |
| Memory cap | none | none | per plugin |

## Defaults chosen (change any before phase B starts)

1. **No Bun bridge.** `zhw` forwards every import it does not run natively to its parent, the Zinc app process, which
   runs both the `*.host.ts` and `*.zinc.ts` handlers (option B in `phase2-wasmtime.md`). One process fewer, 180 µs per
   forwarded call.
2. **Native Rust for chatty imports:** `log` (batched), `prefs` (cache pushed by Zinc), `timers`, `l10n` (strings pushed
   by Zinc), `app`, `util`. `library`, `attachments`, `fulltext`, `net`, `fs` and the rest stay in TypeScript.
3. **WIT change 1, dialogs:** remove the blocking `ui.run-dialog`. `open-dialog` plus its `close` event already exist.
   The SDKs add an await-style helper on top. `alert`, `confirm`, `prompt` and `fs.pick-*` stay blocking: they show no
   plugin content, so no event needs to re-enter the plugin while they wait.
4. **WIT change 2, UI trees as JSON:** `render-result.content` carries the tree, or patches, as a JSON string checked
   against `plugin-api/ui-schema/ui-tree.schema.json` on the Zinc side. The deep `node` / `node-kind` / `style` WIT
   types go. Gains: Rust plugins can use `ui` (today rustc never finishes), smaller components, and no slow dynamic
   conversion of big results in `zhw`. Cost: the tree is typed by the JSON schema and the SDKs, not by WIT.
5. **The package stays `zinc:plugin@0.1.0`.** Nothing is published, so breaking changes cost nothing yet.
6. **Runners:** `wasmtime` becomes the default. The Bun Worker runner stays as a fallback setting for one release
   (update: it was removed afterwards, see "Worker runner removed" in `phase3-runner.md`). The
   experimental `aot-process` runner and its build step are removed (316 MB per plugin, needs the canary).
7. **`.cwasm` is a per-machine cache**, keyed by `(wasm sha256, zhw version, engine settings)`, built at install and
   after a Zinc upgrade, never shipped in a package and only read from Zinc's own cache folder. If it is missing,
   `zhw` compiles at load (0.2–2 s).

## Who does it (user, 2026-11-18): two Gemini agents in parallel

The work splits into two tracks that do not wait on each other: `zhw` converts values dynamically from whatever the WIT
says, so the runner does not depend on the tree shapes. Each track runs its items in order. The phases below describe the
items; this table says who owns what.

| Track | Agent (Paseo, Antigravity) | Items, in order | Owns |
|---|---|---|---|
| UI and WIT | Gemini 4 Argon (High) | A1, B3, B4 | `plugin-api/wit/**`, `plugin-api/ui-schema/**`, `plugin-api/sdk/**`, `plugin-api/samples/**`, `plugin-api/manifest.schema.json`, `gpui-ui/src/wasmplugins/**`, `gpui-ui/scripts/shot-wasm-*.tsx`, `gpui-ui/test/wasm-*`, `plugin-host/src/imports/ui.zinc.ts`, `plugin-host/src/imports/{extend,reader}.zinc.ts`, `writing-a-plugin.md`, report `phase3-ui.md` |
| Runner | Gemini 4 Carbon (High) | A2, B1, B2, B5, then the runner half of C (default `wasmtime`, delete `aot-process`) | `plugin-host-wasmtime/**`, `plugin-host/src/**` except the three `*.zinc.ts` above, `plugin-host/test/**`, `plugin-host/scripts/**`, `gpui-ui/scripts/{build,package}.ts` (zhw step only), `docs/developer-guide/building.md`, `protocol-ndjson.md`, report `phase3-runner.md` |

Hand-offs: the supervisor's call queue still lets nested calls bypass it, which only `run-dialog` needed. Carbon removes the
bypass after Argon reports `run-dialog` gone (both note it in their reports). The coordinator runs the rest of C.

## Phases and agents

Rules: `RULES-phase2.md` still applies (shared worktree, disk floor 9216 MiB, Rust target rules, Bun only, headless
UI checks, no git state changes by agents). The items are grouped into the two tracks above; within a track they run in
order, and B items belong to the track named in the table.

### A. Contracts (coordinator, about 1 hour)

- A1. Apply WIT changes 1 and 2 in `plugin-api/wit/ui.wit` (plus every reader or extend type that embeds a tree) and
  make `ui-tree.schema.json` the contract. Check every world with `jco types`.
- A2. Write `protocol-ndjson.md`: the `zhw` stdio protocol as built in the spike, plus the additions phase B needs:
  prefs and l10n pushes, `grants`, a `call` from Zinc while a plugin waits on an import (refused for the same plugin),
  `plugin-exit` meaning only that plugin, `stats`.

### B. Build (5 agents in parallel)

| Agent | Owns | Work | Done when |
|---|---|---|---|
| B1 zhw | `plugin-host-wasmtime/src/**`, its tests | Remove the bridge (forward to parent). Native chatty imports. `callExport` through the per-plugin call lock. `grants`. Import-call counter (a loop over cheap imports is stopped). Heartbeat from the runtime. Forwarded resources (`net.body-reader`, `attachments.file-writer`) tested. Protocol per A2. | `bench/host.test.ts` plus new tests pass; cold start of the UI fixture under 150 ms |
| B2 Supervisor | `plugin-host/src/supervisor.ts`, `protocol.ts`, new `transport-wasmtime.ts`, `plugin-host/src/imports/registry.ts` (load host handlers in the app process), `plugin-host/test/**` | `runner: "wasmtime" \| "worker"`. Spawn `zhw`, speak NDJSON, timeouts owned by `zhw` (only that plugin disabled, no process restart), `coldBudget` only for `worker`. Run `supervisor`, `queue`, data `e2e` and pkg tests against both runners. | `bun test` in `plugin-host/` is green on both runners |
| B3 Zinc UI | `gpui-ui/src/wasmplugins/**`, `plugin-host/src/imports/ui.zinc.ts`, `gpui-ui/scripts/shot-wasm-*.tsx` | Decode and validate JSON trees and patches. Dialogs through `open-dialog` only. Remove the nested-call bypass in the call queue that `run-dialog` needed. | gpui-ui plugin tests and the 3 shot scripts pass |
| B4 SDKs + samples | `plugin-api/sdk/**`, `plugin-api/samples/**`, `writing-a-plugin.md` | JS SDK: tree builders that emit JSON; `dialog()` helper as a promise resolved by the `close` event. Rust SDK: serde tree types, and the `ui` and `dialogs` features compile. Samples: give back word-count's pane section and highlight-export's toasts; quick-tags uses the dialog helper. | `bun plugin-api/samples/test.ts` passes on both runners |
| B5 Packaging | `plugin-host/src/package/**` (installer, transpile, cache), `gpui-ui/scripts/{build,package}.ts` (zhw step only), `docs/developer-guide/building.md` | Build `zhw` (release) in the app build for every variant. Installer: no jco for the wasmtime runner; precompile into the cache; drop stale entries; fall back to JIT. Fix the kache/cc-rs `cl.exe` failure inside the build script's environment, not in global config. | A packaged build installs a sample and runs it with a warm cache; the cache rebuilds after a version bump |

Overlaps to watch: B2 and B5 both touch `plugin-host/src/package/` callers. B5 owns `package/**` and B2 calls it
without editing it. B3 and B4 share the JSON schema from A1 but neither edits it; changes go through the coordinator.

### C. Switch and verify (coordinator plus one agent, about 2 hours)

- Make `wasmtime` the default runner, keep `worker` behind a setting, delete `aot-process` and `src/package/aot*.ts`.
- Run everything: `bun check` in both packages, `bun test` in `plugin-host/` on both runners, gpui-ui plugin tests, the 3
  shot scripts, `samples/test.ts`, the `zhw` tests, and a packaged build start check (`scripts/start-check.ts`).
- Update `README.md` in this folder and the phase reports, then commit.

## Risks

- **Dialogs written in continuation style.** Any plugin code that relied on `run-dialog` returning a value has to move
  into the `close` handler. The SDK helper hides this for JS; Rust gets a callback form.
- **JSON tree validation cost** on big trees. Measure in B3; validate fully in debug and tests, and only cheaply in release.
- **Forwarded-call latency** (180 µs) for imports that stay in TypeScript. Fine for `library.*`, which calls core over HTTP
  anyway. Measure in B2 and move any hot import to native if it shows up.
- **`zhw` build time:** about 10 minutes for the first release build of wasmtime, 26 s after that. It uses the shared
  target folder, so disk use grows by a few GB once.
- **Packaging on Linux and macOS** is not tested here. `zhw` is plain Rust, so the risk is low, but the release CI needs
  the build step.

## Estimate

The spike estimated 2.5–3 developer-weeks. With the dialog change shrunk to removing one function, and five agents in
parallel, the expected wall-clock time is about a day of agent work. Phase B dominates (3–5 hours per agent), with A and
C about 3 hours together.
