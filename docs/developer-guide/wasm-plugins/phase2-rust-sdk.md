# Phase 2, Rust SDK agent: family worlds, a Rust SDK that compiles, samples, JS defaults

Status 2026-11-18. `bun plugin-api/samples/test.ts`: **PASS, 40 checks, 0 failed** (word-count and highlight-export in Rust, quick-tags in JS). `bun test plugin-api/sdk/js/test`: 14 pass. `bun check` in `sdk/js`: clean.

Not solved: Rust plugins still cannot use the `ui` interface (views, dialogs, toasts). See "Left".

## WIT changes (every one; old -> new)

| File | Change | Why | Consumers to sweep |
|---|---|---|---|
| `library.wit` | `variant origin`: case `self` renamed **`this-plugin`** | `self` becomes the Rust keyword `Self` in generated bindings; wit-bindgen 0.46 and 0.63 both fail to compile it ("expected identifier, found keyword `Self`"). rustc could not compile it otherwise. | Anything that builds or reads `origin`: `plugin-host/src/imports/data/notifier-hub.ts:79` (`{ tag: "self" }` -> `{ tag: "this-plugin" }`, also the `origin.tag === "self"` test at line 200 is on the host's own variable, same tag), `plugin-host/test/data/e2e.test.ts:70`, `phase2-data.md`, any `*/fixtures/*/wit/deps` copy of `library.wit`. |
| `types.wit` | new `enum theme-mode { light, dark }` | moved from `ui.wit` (same cases, same order) | see next row |
| `ui.wit` | `enum theme-mode` removed; `ui` now does `use types.{..., theme-mode}` | `extend` used `ui.{theme-mode}`, which made every plugin that imports `extend` also import the whole `ui` interface (the part that rustc cannot compile). `ui.theme-mode` is still nameable (it is a `use`), values are identical. | jco output: type `ThemeMode` now comes from the `types` module (`ui.d.ts` re-exports it). Fixtures that copy `ui.wit`/`extend.wit`/`types.wit` must be refreshed together. |
| `extend.wit` | `extend` and `extend-handlers`: `use ui.{theme-mode}` -> `use types.{..., theme-mode}` | same | same |
| `world.wit` | new worlds `plugin-core`, `plugin-library`, `plugin-extend`, `plugin-ui`, `plugin-reader`, `plugin-dialogs`. `plugin` and `plugin-minimal` unchanged. | smaller bindings | all validated with `jco types --world-name <w>` (all 8 worlds OK). |

No other renames or shape changes. No field, case, function or interface was renamed in `extend.wit`, `lifecycle.wit` or `ui.wit`.

Worlds (each a subset of the next; `include` is used):

| world | contents |
|---|---|
| `plugin-core` | import app, prefs, l10n, log, timers; export lifecycle, events |
| `plugin-library` | core + library, attachments, fulltext, schema, cite, translate, sync-control, data-utils, notifier; export notifier-handler |
| `plugin-extend` | library + extend; export extend-handlers (no `ui`) |
| `plugin-dialogs` | extend + import ui (no ui-events) |
| `plugin-ui` | dialogs + export ui-events |
| `plugin-reader` | extend + annotations, reader, note-editor; export reader-events, note-events (no `ui`) |

## What was built

- `plugin-api/sdk/rust`: cargo features choose the world, one `wit_bindgen::generate!` per world, the highest feature wins (`library`, `extend`, `dialogs`, `ui`, `reader`, `full`; `ui` + `reader` needs `full`). `Plugin` trait methods, `Glue` impls, `host::*`, `callbacks::*`, `prelude`, `menu`, `reg`, `ui` modules are `cfg`-gated by feature. wit-bindgen bumped 0.46 -> 0.63.
- Samples: `word-count` (feature `extend`), `highlight-export` (feature `reader`). `word-count` lost its pane section and `highlight-export` its toasts (log lines instead), because both need the Rust `ui` bindings.
- `samples/test.ts`: host-entry patch removed (`samples/support/` deleted), uses `discoverHostHandlers: false`; assertions for the dropped section and toasts replaced.
- JS SDK: `src/defaults.ts` + generated `src/generated/defaults.ts` (from `gen-types.ts`): `fill("<iface>/<RecordName>", value)` fills missing required fields (string "", number 0, bigint 0n, false, [], first enum case, nested records, records inside variant cases and lists). Used by every `ext.*` helper, `ui.toTree`, `dialogSpec`, `toastSpec`, and `definePlugin` completes the records its callbacks return (`fill` spec per export function). Variants and tuples have no neutral default and are left alone.
- u32 workaround: measured with componentize-qjs 0.6 + jco: a JS number >= 2^31 passed as a `u32` record field or return value arrives as 2147483647; the signed int32 with the same bits arrives correctly. `u32(n)`, `rgba()`, `hexColor()`, `themedColor()` do that; `toTree` colours use it. Passing a `u32` straight as an import *argument* was not clamped in the test. Also confirmed: a missing required record field traps ("unreachable").
- Tests: `plugin-api/sdk/js/test/sdk.test.ts` (14).
- Docs: `writing-a-plugin.md` (feature/world table), sample READMEs.

## How to run

```bash
bun plugin-api/sdk/js/scripts/gen-types.ts && (cd plugin-api/sdk/js && bun test test && bun check)
bun plugin-api/samples/test.ts                    # builds and runs all three samples (about 3 min the first time)
bunx @bytecodealliance/jco types plugin-api/wit --world-name plugin-reader -o %TEMP%\zn-wasm-x    # per world
```

## Compile numbers (cargo build, dev profile, `-j 2`; the shared target dir was often locked by other agents, so wall times include waits)

core 2 s; library 8 s; extend 1.5 min; reader 19 s; release samples: word-count 12 s, highlight-export 2 m 47 s (first build, includes wit-bindgen). Peak memory of the extend world before the `theme-mode` move (it imported `ui`): 10 GB, 215 CPU s. `dialogs` (extend + `ui` imports only): stopped at 19 min, 640 CPU s, 3 GB+.

## WIT rows now implemented

None (guests). Exercised by the samples through stubs: `extend.register-column`, `register-pref-pane`, `invalidate-columns`, `prefs.observe`, `library.get-summaries`, `fulltext.get-content`, `annotations.list-annotations`, `library.apply`, `reader.register-listener`, `reader.unregister`, `log.write`; callbacks `extend-handlers.on-column-values`, `events.on-pref-changed`, `reader-events.on-menu-command`, `lifecycle.startup/shutdown`; quick-tags (JS) also `ui.run-dialog`, `ui.show-toast`, `ui-events`.

## Left

- **Rust and `ui`.** wit-bindgen inlines the lowering of every nested type into each function that uses it, so `ui.node-kind`/`ui.style` explode (same cause as the jco 4.6M-line output in phase2-integrate.md). Real fix is a WIT change: pass trees and `style` as JSON (or share them through a `resource`), or make `style` far smaller. Until then the Rust `ui.rs` builders, `dialogs`, `ui`, `full` features and `plugin-dialogs`/`plugin-ui`/`plugin` for Rust are uncompiled. `plugin-dialogs` is valid WIT and fine for JS.
- Rust section registration works but cannot be drawn (needs `ui-events`).
- `ui.rs`/`menu.rs`/`reg.rs` for the `full` world are unchecked.

## Needs from other areas

- `plugin-api/manifest.schema.json` `main.world` enum is `["plugin","plugin-minimal"]` (and `plugin-host/src/manifest.ts` types it the same): add the new worlds. The samples keep `"world": "plugin"` in their manifests so the installer's schema check passes; a Rust build ignores the field, a JS build passes it to componentize-qjs (quick-tags uses `plugin`).
- Host consumers of `origin`: `self` -> `this-plugin` (see table).
- Fixtures with copies of the WIT (`*/fixtures/*/wit/deps`): refresh.
- Optional: `build-plugin.ts` could pick the Rust world automatically; nothing needed today.
