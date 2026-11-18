# Phase 2, sdk agent: guest SDKs and sample plugins

Status 2026-11-18. **Not finished: the Rust SDK and the two Rust samples have never been compiled, and `samples/test.ts` has never run.** See "Result" for why.

## What was built

| Path | What it is |
|---|---|
| `plugin-api/sdk/rust/` (`zinc-plugin`) | Rust SDK. `src/lib.rs` generates the bindings for the full `plugin` world with `wit-bindgen` (`pub_export_macro`, `default_bindings_module`), re-exports imports as `host::*` and exported types as `callbacks::*`. `src/plugin.rs`: trait `Plugin` (all 48 callbacks with default no-op bodies; two name clashes renamed: `on_host_event`, `on_ui_event`, `build_reader_menu`, `on_reader_menu_command`), `Glue<P>` implementing the eight `Guest` traits, macro `export_plugin!(MyType)`. Builders: `text` (localized strings, `IntoText`), `err`, `menu` (entries, conditions), `reg` (column, section, setting rows, pref pane, reader listeners), `ui` (nested `El` tree flattened to the typed node list, dialogs, toasts, form values), `json` (serde_json, `escape_html`), `log`. |
| `plugin-api/sdk/js/` (`@zinc/plugin-sdk`) | JS SDK. `scripts/gen-types.ts` runs `jco types` and writes `types/` (per-interface `.d.ts`, `ambient.d.ts` for `import x from "zinc:plugin/x@0.1.0"`, `exports.d.ts`) and `src/generated/exports.ts` (the 48 export functions with return types). All generated and git-ignored. `src/plugin.ts`: `definePlugin` (defaults for every export), `fail`. `src/ui.ts`: nested-JSON builders, `render`, `toTree` (JSON to the typed flat tree for dialogs), `dialogSpec`, `toastSpec`, `fieldValue`. `src/ext.ts`: menu, column, section, settings, reader listener helpers. `scripts/build.ts`: bundles the SDK into the entry, then calls `plugin-host/scripts/build-plugin.ts`. `template/`: starting point. |
| `plugin-api/samples/{word-count,quick-tags,highlight-export}` | The three samples, each with `manifest.json`, source, `README.md`. |
| `plugin-api/samples/test.ts`, `support/host-entry.ts` | The test (below). |
| `docs/developer-guide/wasm-plugins/writing-a-plugin.md` | The author guide. |

How the "about 40 stubs" problem is solved: `Plugin` is one trait whose methods all have defaults; `Glue<P>` implements every generated `Guest` trait by calling `P`, and `export_plugin!` exports `Glue<P>` with `with_types_in`. JS: `definePlugin` builds the full export object from the generated function list, so a missing function is a no-op, an empty list, or `unavailable`, never a trap.

## How to run

```bash
bun plugin-api/sdk/js/scripts/gen-types.ts           # JS types from the WIT
bun check                                             # in plugin-api/sdk/js
bun plugin-api/samples/test.ts [--only name] [--keep] # builds, loads and checks the three samples (needs > 9 GiB free on %TEMP%'s drive)
```

## Result

- **Verified:** `gen-types.ts` (37 `.d.ts` files, 28 imports, 8 exports, 48 export functions); `bun check` in `sdk/js` clean; the JS sample `quick-tags` **builds** through `sdk/js/scripts/build.ts` and `build-plugin.ts` against the full `plugin` world (43 s, 5.6 MB component, 313 async imports, 48 async exports), so the QuickJS guest with SDK bundling and `definePlugin` componentizes.
- **Not verified:** everything Rust, and every test run. Two attempts to compile the SDK (`cargo check --target wasm32-wasip2`; then a probe crate with only `generate!` for `plugin-minimal`) did not finish in 20 and 5 minutes; `rustc` grew past 7 GB resident and the free space on `C:` fell from 11 GB to 6.2 GB (page file and other agents' builds), below the 9216 MiB floor of RULES-phase2.md. I killed the compiles and stopped building. `test.ts` also refuses to run below that floor.
- `samples/test.ts` is written but has not been executed. It builds the three samples, loads each through the supervisor with stub `where: "zinc"` handlers and a host entry that switches off the host process's own handler discovery (so the other agents' real handlers cannot interfere), calls `startup`, then the main exports, and asserts on what was registered and called (about 75 checks: word-count column, section, pref pane, pref change; quick-tags menu, dialog form, `library.apply` add-tags, toast, cancel, truncated selection; highlight-export two reader listeners, note HTML, escaping, ordering, filters).

To finish: free disk, then `bun plugin-api/samples/test.ts`, and fix the compile errors in `sdk/rust` (the trait and builders were written from the WIT by hand, so type-name mistakes are likely; the compiler will list them).

## Likely compile problem to look at first

The generated bindings for the full world are huge (about 400 imported functions with deep records: `ui.style` has 50 fields, `node-kind` 40 cases). If the compile stays that slow, options: (1) generate bindings only for the imports plugins use, with `wit-bindgen`'s `with`/`skip` or a purpose-built smaller world (the world file is not mine: see below); (2) split `ui` and `reader` out of the SDK behind cargo features, each using its own world; (3) `opt-level` is irrelevant for `check`, so this is rustc front-end cost: try `RUSTFLAGS=-Zthreads` on nightly, or `codegen-units`/`lto` only affect later stages.

## WIT rows now implemented

None: the SDKs and samples are guests. They exercise (once run) `extend.register-menu`, `register-column`, `register-section`, `register-pref-pane`, `invalidate-columns`, `prefs.observe`, `prefs.get`, `library.apply`, `library.get-summaries`, `fulltext.get-content`, `annotations.list-annotations`, `reader.register-listener`, `ui.run-dialog`, `ui.show-toast`, `log.write`, and the callbacks `extend-handlers.on-menu-command` / `on-column-values`, `ui-events.mount` / `on-event`, `reader-events.on-menu-command`, `events.on-pref-changed`, via stubs.

## Stubbed or left

- Rust builders cover the common nodes (box, card, section, text, button, text input, checkbox, select, form, callout, badge, progress); other node kinds: use `El::new(NodeKind::...)`. No table or list builders. `reg` covers column, section, settings, reader listeners; other registrations: fill the WIT records by hand.
- JS `toTree` supports the same common nodes; anything else throws a clear error (use `ui.render` JSON for views).
- No Fluent file loading helper; `text::l10n` only builds the reference.
- Samples use `plugin` world (not `plugin-minimal`) because they call library, reader and annotations.

## WIT changes

None made. Suggested (not made):

1. **`dialog-spec.content`, `window-spec.content` are typed `tree`, while views can return the nested JSON.** JS guests have to flatten the tree themselves (`sdk/js/src/ui.ts` `toTree`), which duplicates the host's JSON-to-flat conversion. Suggest a `content-update`-like variant (or an extra `content-json: option<json>`) on those two records.
2. **No `Default` for records in Rust.** `style`, `node-props`, `column-registration` and others have 20 to 50 fields; the SDK writes them out by hand (`ui::style()`, `reg::column`). WIT has no default values; nothing to change, but any new field in those records breaks the SDK compile until updated (the compile error says where).
3. **Reader toolbar `on-menu-command` receives the entry id as `command`** is assumed by the highlight-export sample; reader.md should say so for `slot(toolbar)` listeners with a `static-menu`.
4. The `world` doc says a plugin must export every function; with the `plugin` world that is what makes the SDK necessary. A smaller world per extension point family (for example `plugin-ui`, `plugin-reader`) would let a plugin export only `lifecycle` and the callbacks it uses, and would also shrink the generated Rust bindings.

## Needs from other areas

- **core / host:** an option on `createPluginSupervisor` (or `host-main.ts`) to skip `discoverHandlers("host")`, so tests with stub handlers need no source rewriting (`samples/support/host-entry.ts` patches that one call at load time and fails loudly if the line changes).
- **core:** `build-plugin.ts` for Rust uses `cargo metadata` `packages[0]`; fine for the samples (each is its own workspace root).
- **Whoever owns the installer:** the layout and an install command; `writing-a-plugin.md` says "no installer yet".
