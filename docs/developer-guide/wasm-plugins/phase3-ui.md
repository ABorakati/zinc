# Phase 3, UI and WIT track (`phase3-ui.md`)

Date: 2026-11-18. Track: UI and WIT (items A1, B3, B4). Package version kept at `zinc:plugin@0.1.0`.

## Files changed

| File | What changed |
|---|---|
| `plugin-api/wit/ui.wit` | Removed `ui.run-dialog` and `dialog-outcome`. Replaced `tree`, `node`, `node-kind`, `node-props`, `style`, `state-styles`, `named-style`, and `patch-set` / `patch-op` records with JSON strings validated against `ui-tree.schema.json`. |
| `plugin-api/ui-schema/ui-tree.schema.json` | Expanded to be the full JSON contract for UI trees (`$defs.tree`), incremental patches (`$defs.patchSet`, `$defs.patchOp`), row/cell custom content (`$defs.rowContent` / `$defs.node`), node/row styles (`$defs.style`), and named styles (`$defs.namedStyles`). |
| `plugin-host/src/imports/ui.zinc.ts` | Removed the `"run-dialog"` handler registration. |
| `gpui-ui/src/wasmplugins/ui/validate.ts` | New schema-driven validator against `plugin-api/ui-schema/ui-tree.schema.json` with `"full"` (default in tests and debug builds) and `"cheap"` (release builds) modes. |
| `gpui-ui/src/wasmplugins/ui/types.ts` | Updated `ContentUpdate` (`unchanged \| json \| patch`), `Row` (`content` and `style` as JSON), `Cell` (`content` as JSON), and `RowBatch` (`styles` as optional JSON, no `nodes`). |
| `gpui-ui/src/wasmplugins/ui/convert.ts` | Added `jsonToPatch`, `parseBatchStyles`, JSON decoding for `row.content`, `cell.content`, and `row.style` in `resolveBatchRows`, and integrated full/cheap schema validation. |
| `gpui-ui/src/wasmplugins/ui/controller.ts` | Decodes JSON patches in `applyContent`, JSON initial dialog trees in `showInitial`, and JSON batch styles/row content in `fetchRange`. |
| `gpui-ui/src/wasmplugins/ui/host.tsx` | Removed `runDialog`. `openDialogNow` decodes and validates `spec.content` JSON and always delivers both `close` events (`button`/`none`, then `form`) on close. |
| `gpui-ui/src/wasmplugins/ui/index.ts` | Exported `jsonToPatch`, `getValidationMode`, `setValidationMode`, `ValidationMode`. |
| `gpui-ui/src/wasmplugins/ui/ui.test.ts` | Added tests for JSON patch sets, JSON row content/styles in `render-range`, and full vs. cheap schema validation. |
| `gpui-ui/src/wasmplugins/ui/test/fixture-ui-js/plugin.js` | Switched from `ui.runDialog` (with flat WIT nodes) to `ui.openDialog` (with JSON `content`, `close` event handling, and `ui.push`), and dropped `nodes` from `renderRange`.Synced `wit/deps/zinc-plugin/ui.wit`. |
| `gpui-ui/scripts/shot-wasm-ui.tsx` | Updated dialog assertions for `open-dialog` and its `close` events. |
| `gpui-ui/scripts/fixtures/wasm-reader/plugin.js` | Updated `renderRange` to match the new `row-batch` record (no `nodes`). |
| `plugin-api/sdk/js/src/ui.ts` | Tree builders emit JSON (`treeJson`, `render`, `patch`); `dialogSpec` serializes `content` to JSON; added `ui.dialog(spec)` returning a Promise resolved by the dialog's `close` event. |
| `plugin-api/sdk/js/src/plugin.ts` | `definePlugin` routes dialog `close` events in `uiEvents.onEvent` to `dispatchDialogEvent` and updates `renderRange` default to match `row-batch`. |
| `plugin-api/sdk/js/scripts/build.ts` | Wires `zinc:plugin/ui@0.1.0` `openDialog` for `ui.dialog()` when bundling a JS plugin. |
| `plugin-api/sdk/js/test/sdk.test.ts` | Updated for JSON tree/patch builders, `dialogSpec` JSON content, and the `ui.dialog()` Promise helper. |
| `plugin-api/sdk/rust/Cargo.toml` | Added `serde` (`derive`). |
| `plugin-api/sdk/rust/src/lib.rs` | Enabled `ui` module and `host::ui` for both `dialogs` and `ui` features; allowed combining `reader` + `dialogs`/`ui` (selects the full `plugin` world). |
| `plugin-api/sdk/rust/src/plugin.rs` | Updated `render_range` default (`RowBatch` without `nodes`); `Glue<P>::on_event` routes dialog `close` events to `ui::dispatch_dialog_event`. |
| `plugin-api/sdk/rust/src/ui.rs` | Replaced flat WIT tree builders with `serde` types (`Tree`, `El`, `Style`, `StateStyles`, `NamedStyle`, `Binding`, `PatchSet`, `PatchOp`) that serialize to `ui-tree.schema.json`, plus non-blocking dialog helpers (`open_dialog_with`, `ask`). |
| `plugin-api/samples/word-count/{Cargo.toml,src/lib.rs,README.md}` | Enabled cargo feature `ui` (`plugin-ui` world) and restored the **Word Count** item pane section (`mount`, `update_context`, `unmount`, `on_ui_event` with "Recount", and `ui::refresh` on pref change). |
| `plugin-api/samples/highlight-export/{Cargo.toml,src/lib.rs,README.md}` | Enabled `features = ["reader", "dialogs"]` and restored toast notifications (`ui::toast`) on export. |
| `plugin-api/samples/quick-tags/{src/main.js,README.md}` | Switched from `zui.runDialog` to `ui.dialog(dialog(items.length), zui)`. |
| `plugin-api/samples/{test.ts,README.md}` | Tested `word-count` pane section + recount + refresh, `quick-tags` `open-dialog` + `close` events, and `highlight-export` toasts. Fixed `freeMiB` for uutils `df -BM`. |
| `docs/developer-guide/wasm-plugins/writing-a-plugin.md` | Updated feature compile times, JSON tree/patch examples, and non-blocking dialog documentation for Rust and JS. |

## WIT changes in full (`old -> new`)

All changes are in `plugin-api/wit/ui.wit` (neither `extend.wit` nor `reader.wit` embedded `ui.tree`, `ui.node`, or `ui.style`). All 8 worlds (`plugin`, `plugin-minimal`, `plugin-core`, `plugin-library`, `plugin-extend`, `plugin-ui`, `plugin-reader`, `plugin-dialogs`) pass `jco types`.

| Item in `plugin-api/wit/ui.wit` | Old | New |
|---|---|---|
| `ui.run-dialog` | `run-dialog: func(spec: dialog-spec) -> result<dialog-outcome, error>;` | **Removed** (use `open-dialog` + `ui-events.on-event` `close`). |
| `ui.dialog-outcome` | `record dialog-outcome { button: option<string>, values: list<form-field> }` | **Removed** (only `run-dialog` used it). |
| `ui.content-update` | `variant content-update { unchanged, full(tree), json(json), patch(patch-set) }` | `variant content-update { unchanged, json(json), patch(json) }` |
| `ui.dialog-spec.content` | `content: tree` | `content: json` |
| `ui.window-spec.content` | `content: tree` | `content: json` |
| `ui.cell.content` | `content: option<u32>` (index into `nodes`) | `content: option<json>` (`$defs.node` in `ui-tree.schema.json`) |
| `ui.row.content` | `content: option<u32>` (index into `nodes`) | `content: option<json>` (`$defs.node` in `ui-tree.schema.json`) |
| `ui.row.style` | `style: option<style>` | `style: option<json>` (`$defs.style` in `ui-tree.schema.json`) |
| `ui.row-batch` | `record row-batch { start: u32, rows: list<row>, nodes: list<node>, styles: list<named-style>, total: option<u32> }` | `record row-batch { start: u32, rows: list<row>, styles: option<json>, total: option<u32> }` |
| Unused style/node/tree/patch WIT types | `space`, `dim`, `edges`, `direction`, `align`, `justify`, `overflow`, `position`, `text-align`, `text-wrap`, `radius`, `shadow`, `cursor`, `border`, `grid-span`, `style`, `state-styles`, `named-style`, `event-binding`, `a11y-role`, `live-mode`, `a11y`, `drop-kind`, `drop-target`, `node-props`, `node`, `grid-spec`, `axis`, `scroll-target`, `scroll-spec`, `split-spec`, `tab-def`, `tabs-look`, `tabs-spec`, `deck-spec`, `section-button`, `section-spec`, `group-spec`, `orientation`, `overflow-mode`, `toolbar-spec`, `text-kind`, `link-target`, `text-run`, `text-spec`, `link-spec`, `image-fit`, `image-source`, `image-spec`, `icon-spec`, `progress-look`, `progress-spec`, `badge-spec`, `callout-spec`, `rich-format`, `rich-text-spec`, `code-spec`, `separator-spec`, `skeleton-spec`, `button-look`, `control-size`, `menu-mode`, `button-spec`, `checkbox-spec`, `switch-spec`, `choice`, `radio-group-spec`, `select-spec`, `text-input-kind`, `text-input-look`, `suggest-spec`, `text-input-spec`, `number-input-spec`, `slider-spec`, `color-input-spec`, `date-kind`, `date-input-spec`, `token`, `token-input-spec`, `form-spec`, `selection-mode`, `column`, `virtual-rows`, `rows-source`, `list-spec`, `table-spec`, `placement`, `popover-spec`, `stroke`, `text-anchor`, `shape-style`, `rect-op`, `ellipse-op`, `line-op`, `polyline-op`, `path-op`, `text-op`, `image-op`, `group-op`, `draw-op`, `canvas-spec`, `web-sandbox`, `web-source`, `web-view-spec`, `embed-component`, `embed-spec`, `node-kind`, `tree`, `set-node-op`, `replace-op`, `insert-op`, `move-op`, `patch-op`, `patch-set` | **Removed** (now specified in `plugin-api/ui-schema/ui-tree.schema.json`). Kept `font-size`, `font-family`, `font-weight`, `scroll-align`, `tone`, `drag-payload`, `suggestion`, `cell`, `row`. |

## Tests and results

| Command | Result |
|---|---|
| `jco types plugin-api/wit --world-name <w>` (all 8 worlds) | **PASS** (8/8 worlds) |
| `cargo build --features dialogs` in `plugin-api/sdk/rust` | **PASS** (37.6 s cold with deps, 0 warnings) |
| `cargo build --features ui,dialogs` in `plugin-api/sdk/rust` | **PASS** (6.0 s, 0 warnings) |
| `cargo build --features full` in `plugin-api/sdk/rust` | **PASS** (8.0 s, 0 warnings) |
| `bun test test && bun check` in `plugin-api/sdk/js` | **PASS** (14 pass, 0 fail; 0 type errors) |
| `bun test src/wasmplugins` in `gpui-ui/` | **PASS** (57 pass, 0 fail across `extend.test.ts`, `convert.test.ts`, `ui.test.ts`, 4.2 s) |
| `bun scripts/shot-wasm-ui.tsx` in `gpui-ui/` | **PASS** (30/30 checks pass, ~15 s including fixture build) |
| `bun scripts/shot-wasm-extend.tsx` in `gpui-ui/` | **PASS** (22/22 checks pass) |
| `bun scripts/shot-wasm-reader.tsx` in `gpui-ui/` | **PASS** (49/49 checks pass) |
| `bun plugin-api/samples/test.ts` | **PASS** (48/48 checks pass, 0 failed, 33 s total for all 3 samples) |
| `bun check` in `gpui-ui/` and `plugin-host/` | **PASS** (736 files in `gpui-ui/`, 92 files in `plugin-host/`, 0 errors) |

## Measurements

### 1. JSON tree decoding and schema validation cost (`jsonToTree` + `buildNested`, median / p95 over 25 runs)

| Tree size | JSON payload | `"full"` validation (tests & debug) | `"cheap"` validation (release) |
|---|---|---|---|
| 297 nodes (74 four-node rows) | 24.8 KB | **0.83 ms** (p95 5.90 ms) | **0.21 ms** (p95 2.75 ms) |
| 997 nodes (249 four-node rows) | 83.3 KB | **1.40 ms** (p95 3.97 ms) | **0.49 ms** (p95 2.18 ms) |
| 2,997 nodes (749 four-node rows) | 250.8 KB | **4.32 ms** (p95 11.49 ms) | **1.61 ms** (p95 6.55 ms) |

### 2. Impact of WIT change 2 on compile times and first-call latency

| Metric | Phase 2 (typed `node-kind` / `style` in WIT) | Phase 3 (JSON trees & patches in WIT) |
|---|---|---|
| Rust SDK `cargo build --features dialogs` | Did not finish (>19 min, >640 CPU s, killed) | **37.6 s** cold, **~5 s** incremental |
| Rust SDK `cargo build --features ui,dialogs` | Could not compile | **6.0 s** |
| Rust SDK `cargo build --features full` | Could not compile | **8.0 s** |
| `word-count` release build (`wasm32-wasip2`, feature `ui`) | Could not use `ui` | **15.0 s** (with pane section) |
| `highlight-export` release build (`wasm32-wasip2`, features `reader,dialogs`) | 2 m 47 s (without `ui`) | **13.9 s** (with `ui` toasts) |
| `quick-tags` build (`componentize-qjs` + `jco`) | 43–60 s | **2.0 s** |
| QuickJS UI fixture first `on-event` call on Bun Worker | 18.6–22 s | **< 1 ms** (0 ms in `shot-wasm-ui.tsx`) |

## What is left

- None in A1, B3, or B4.

## Hand-off and needs from other areas

- **Runner track (`plugin-host/src/supervisor.ts`):** **`ui.run-dialog` is now completely removed** from `plugin-api/wit/ui.wit`, `plugin-host/src/imports/ui.zinc.ts`, `gpui-ui/src/wasmplugins/ui/host.tsx`, the SDKs, fixtures, and samples. Dialogs now go exclusively through the non-blocking `ui.open-dialog` and its `close` events. **The Runner track can now remove the nested-call bypass in the supervisor's per-plugin call queue** that only `run-dialog` needed.
- **Runner track (`plugin-host-wasmtime/bench/`):** When re-running `bench/prepare.ts`, rebuild `ui-fixture` and `quick-tags` against the updated WIT.
