# Rules for the WASM plugin agents, phase 2 (2026-11-18)

## Goal

Phase 1 designed Zinc's WASM plugin API (`plugin-api/wit/*.wit`, reports in this folder; start with `README.md`). Phase 2
builds it: a working plugin host, the host side of the WIT imports, the Zinc UI side of the extension points, guest SDKs and
sample plugins. The WIT is the contract. If you find a real flaw in it, do not silently change it: make the smallest fix,
and list it under "WIT changes" in your report so the coordinator can review it.

The architecture is fixed by the spike (`C:\Users\abora\zotero-next\.claude\worktrees\wasm-plugin-spike-b1f662\docs\developer-guide\wasm-plugins-spike.md`,
section "Recommendation"; its code in `...\spikes\wasm-plugins\` shows working jco, JSPI, Worker and subprocess code):

- Plugins are components transpiled with `jco transpile --instantiation async --async-mode jspi` and run in ONE separate Bun
  "plugin host" process, one Worker per plugin.
- A call that times out kills the plugin host process; Zinc restarts it and reloads every plugin except the stuck one, which
  is disabled.
- Host imports are async (JSPI). No `Atomics.wait`.
- No WASI: every `wasi:*` import is a stub that traps or returns empty. Do not pass `@bytecodealliance/preview2-shim` through.
  Accept import keys with and without `@version` (see the spike's `host.ts`).
- Guests: Rust (`wasm32-wasip2` + `wit-bindgen`) and JS through QuickJS (`componentize-qjs`). No StarlingMonkey.

## Shared worktree

All agents work in `C:\Users\abora\zotero-next\.claude\worktrees\wasm-plugins` (branch `claude/wasm-plugins`). Each agent
owns files, named in its brief. Edit only your own files. If you need a change in a file you do not own, do not make it: list
it under "Needs from other areas" in your report. Never run git commands that change state (`commit`, `stash`, `checkout`,
`reset`, `restore`, `clean`, `add`, `merge`, `rebase`). Read-only git is fine. The coordinator commits.

`gpui-ui/node_modules` and `core/node_modules` are JUNCTIONS to the main checkout's folders
(`C:\Users\abora\zotero-next\gpui-ui\node_modules`). Never run `bun install`, `bun add` or `bun remove` in `gpui-ui/` or `core/`,
and never write inside those folders: it would change the main checkout. New dependencies go only in `plugin-host/package.json`.

## Disk

C: is nearly full. Before any `bun install`, `cargo build` or other large write, run `df -m /c` and STOP (report it, do not
continue) if free space is below 9216 MiB. Scratch output goes under `%TEMP%\zn-wasm-*` and is deleted when you finish.
Rust: plain `cargo build`. `CARGO_TARGET_DIR` is already set globally to a shared folder and `kache` wraps rustc: never set or
override `CARGO_TARGET_DIR`, `--target-dir` or profile settings.

## Safety

- Never open or write `data/library.sqlite`, `C:\Users\abora\Zotero\*`, or anything on ports 23119 / 23120.
- Tests that need a core start their own throwaway core on a free port with a temporary COPY of a library (see how existing
  tests do it: `core/test/`, `gpui-ui/scripts/shot-*.tsx`). A core on port 23160 (a copy) may be running; read-only use is fine.
- Bun only: `bun`, `bunx`. No node, npm or npx. Typecheck TypeScript with `bun check` (from `gpui-ui/`, or `bunx tsc --noEmit`
  is NOT allowed; use `bun check` in `plugin-host/` too if it has a tsconfig).
- No screen takeover: UI checks are headless (GPUIX `createTestRoot` / `TestRenderer`, screenshots to `%TEMP%`). Never open a
  window on the user's screen.
- No pushes, no network posts. Downloading crates and npm packages is fine.

## Report

Write `docs/developer-guide/wasm-plugins/phase2-<area>.md`: what you built (files), how to run it, the tests and their result,
WIT rows from the phase 1 parity tables that are now implemented (by interface.function), what is stubbed or left, WIT
changes, needs from other areas. Your final message: at most 8 lines with the test result first.
