# Pitfalls (found in phases 2 and 3)

Read before shipping. Each item says what happens and what to do.

## QuickJS (JS plugins)

1. **A missing required record field traps the plugin.** A record you pass to an import or return from a callback with a required (non-option) field missing (a `bool`, `list`, `enum`, `string`) kills the call with "unreachable", not a catchable error: one forgotten `sortReverse` crashed a plugin at startup. Option fields may be left out. Build records with the SDK helpers (`ext.menu`, `ext.entry`, `ext.column`, `ext.section`, `ext.prefPane`, `ui.dialogSpec`, `ui.toastSpec`), or wrap your own in `fill("<iface>/<RecordName>", {...})` (`fill("library/ItemQuery", {...})`, `fill("net/HttpRequest", {...})`). `definePlugin` completes the records your callbacks return (cells, render results). Variants (`{ tag, val }`) and tuples have no default: supply them. Flag types are objects of booleans (`expand: { tags: true }`).
2. **u32 values at or above 2^31 are clamped to 2147483647** when a JS number crosses as a `u32` record field or return value (colours `0xRRGGBBAA` are the usual case: red as the top byte makes them large). Use `u32(n)` (the signed int with the same bits), or `rgba()`, `hexColor("#ff6666")`, `themedColor(light, dark)`. Rust is not affected. Pref integers are 32-bit signed anyway.
3. **QuickJS is not a browser.** No `TextDecoder`, `TextEncoder`, `URL`, `console`, `setTimeout`, `structuredClone`, `fetch`. There is `JSON`, `Promise`, `BigInt`, `atob`, `escape`/`unescape`, `queueMicrotask`. Use `log.write`, the `timers` import, `net.send`, and decode bytes by hand (see the `utf8` helper in recipes-js.md). `u64` values are `BigInt`: `JSON.stringify` of one throws, and `1n + 1` throws; convert with `Number()`.
4. **The JS is interpreted, not JIT.** A loop over 20,000 items or a regex over a whole book costs seconds and eats the call budget. Batch import calls (one `get-summaries` for all keys, not one `get-items` per key), keep work per callback small, or write the plugin in Rust.
5. **Instance ids are BigInt.** Map keys are fine; `==` against a number is not; template strings are fine.
6. **`this` in a callback is not reliable.** Share code through plain functions.
7. **The export line.** `export const { lifecycle, events, ... } = plugin;` must name every exported interface of the world, in camelCase. A newer WIT can add one (`mcpHandler`); regenerate types with `gen-types.ts` and add it.

## Calls into a plugin

8. **One call at a time per plugin, and no re-entry.** Zinc queues calls into a plugin (menu commands, view events, timers, pref observers, notifier batches) and runs them one after another. While a call waits in an import (`net.send`, `timers.sleep`, `prompt`/`confirm`/`alert`, `fs.pick-*`), the plugin's other callbacks wait, or, for a call that arrives while it is suspended, the Wasmtime host refuses it with `reentrant`. Rules that follow: never wait in an import for something that needs another callback to happen (a button press, a timer); open dialogs non-blocking (`ui.dialog` / `ui::ask`) and continue in the close handler; do not `sleep`; expect a pref or timer callback to arrive after the call that caused it has returned. (A QuickJS interpreter is not re-entrant: before the queue existed, a callback during a suspended call corrupted it with "Out of bounds memory access".)
9. **Overlapping calls.** Two calls started at the same time run in order, not in parallel; the second one's budget starts when it leaves the queue. A long first call delays every menu click and mount behind it.
10. **Time limits per call.** An exported callback gets 5 s of active guest time; `install`/`startup`/`shutdown`/`uninstall` 10 s (`main.startup_timeout_ms`, at most 60000); loading 15 s. Time spent waiting inside an import does not count, so a slow `net.send` is safe, but a loop that calls cheap imports a million times is stopped by an import-call limit. Exceeding a limit disables that plugin (it stops; with the Bun Worker fallback the whole plugin host restarts and every plugin reloads). Do slow work in small steps: each timer tick or dialog close is a new call with a fresh budget.
11. **A trap kills the instance.** A panic (Rust) or "unreachable" (JS) marks the plugin failed and unloads it. Return `Err` / `fail(...)` for expected problems instead of unwrapping. Rust: no `unwrap()` on host data.

## Dialogs and views

12. **No blocking `run-dialog`.** It was removed in phase 3. `open-dialog` returns at once; the answer is a `close` event (two of them: the pressed `button`, then the `form` values) on `ui-events.on-event`. JS `ui.dialog(spec, zui)` returns a Promise that `definePlugin` resolves; Rust `ui::ask` / `ui::open_dialog_with` take a closure. Code after "await the dialog" runs in a later call.
13. **Dialog outcomes need the `ui` world.** With only `plugin-dialogs` / feature `dialogs` the close event has nowhere to go.
14. **UI trees are JSON validated against `ui-tree.schema.json`** (`unevaluatedProperties: false`): an unknown prop or a wrong enum string is rejected by Zinc (full validation in tests and debug builds, cheap in release). 5000 nodes and depth 64 at most. Nodes you patch or focus need a `key`. Test trees with `checkRender`.
15. **Handler ids are yours**: the `on: { press: "click" }` string comes back as `event.handler`. A section header button press arrives as `kind: "press"` with `handler` = the button id.
16. **Sections need `update_context`.** The host reuses a mounted view when the selected item changes and calls `update-context`, not `mount`. Handle both the same way.

## Packaging and manifest

17. **`id` never changes**; it names the data folder and prefs.
18. **Do not ship `transpiled/`**; the installer ignores it. Do not write `main.sha256` by hand.
19. **`permissions.net.hosts` must list every host** including redirect targets; loopback and private hosts need an exact `http://host:port` entry.
20. **Permission-denied is a normal result.** Handle it: show a toast or log a line telling the user which permission is missing. Reading the selection (`ctx.items`) needs `library.read`.
21. **`default_prefs` types are fixed by the default**: boolean, int32, string. A `prefs.set` of another type is `invalid-argument`.
22. **Rust build hygiene**: one shared target dir, no per-plugin `CARGO_TARGET_DIR`, no profile overrides; keep the crate its own workspace (`[workspace]` in `Cargo.toml`); `wasm32-wasip2` target; WASI is stubbed at run time (no `std::fs`, no sockets, no threads; stdout and stderr lines go to the plugin log); use `zinc_plugin::host::*` and `timers` instead.
23. **Check the world twice.** Rust: the cargo feature picks the world and a feature that is too small fails to compile (`host::net` does not exist below `full`); the manifest `main.world` must say the same. JS: componentize uses the manifest world.
