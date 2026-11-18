# Phase 2, ui agent: the plugin UI

Folder `gpui-ui/src/wasmplugins/ui/`, handler `plugin-host/src/imports/ui.zinc.ts`, check scripts `gpui-ui/scripts/shot-wasm-ui.tsx`.

## What was built

| File | What it is |
|---|---|
| `index.ts` | The public names: `PluginView`, `ControllerView`, `ViewController`, `setUiSupervisor`, `promptPermission`, `clearUiOf`, `setLocalizer`, `setPrefsBackend`, `jsonToTree`, types. |
| `PluginView.tsx` | `<PluginView pluginId surface view params supervisor? visible? width? height? onController? onMeta? style? />`. Mounts through `ui-events.mount`, draws the result, `update-context` when `params`, size, locale or the theme change, `visibility` from `visible`, `unmount` on removal, mounts again after `host-restarted`. The supervisor is the prop, else `setUiSupervisor`, else `getPluginSupervisor()` of `../host`. |
| `ControllerView.tsx`, `controller.ts` | The view runtime. `ViewController` keeps the tree in a Solid store reconciled by node id, sends events (`on-event`, serialized per view, debounce / throttle / key filters from the bindings), batches `ui.push` to one frame (30 per second at most), applies patches (a wrong `base-rev` is dropped and `resync` is called), caches virtual rows, answers suggestions, keeps the named inputs' values. Failure shows a banner and keeps the last good tree. |
| `convert.ts`, `types.ts` | Nested JSON form to the flat WIT tree (`jsonToTree`, every default filled), flat tree to the nested `VNode` tree, patch application, the host limits (5000 nodes, depth 64). |
| `colors.ts`, `styleMap.ts` | `types.color` to a CSS colour per mode (the eight palette colours have light and dark values); `style` to a GPUIX style; text properties are kept apart and inherited down the tree by the renderer (GPUIX has no inheritance). |
| `render/*.tsx` | The 40 node kinds (`layout`, `content`, `inputs`, `collections`, `special`), the node wrapper with events, tooltips, context menus. |
| `canvasSvg.ts` | `canvas` draw list to one SVG (drawn by GPUIX as a full-colour image, text included) plus host-side hit testing and hover tips. |
| `markup.ts` | `html-subset` to Markdown through a whitelist parser (scripts, styles, event attributes, iframes, forms, `javascript:` links are dropped). |
| `host.tsx` | The host side of the `ui` import. `ui.zinc.ts` only adapts it. |
| `permission.tsx` | `promptPermission(req)`: the run-time permission dialog. |
| `l10n.ts`, `prefs.ts`, `measure.ts` | Text resolution (default: the package area's Fluent service, `setLocalizer` overrides), `pref` bindings (default: its PrefStore, `setPrefsBackend` overrides), text measurement. |
| `ui.test.ts` | 23 unit tests. |
| `test/fixture-ui-js/` | QuickJS fixture plugin: a tree with every node kind, handlers, dialog, toast, virtual rows. |
| `gpui-ui/scripts/shot-wasm-ui.tsx` | The end-to-end check (below). |

Wiring for the other agents: the extend agent already lists `./ui/index` and finds `ui.zinc.ts` through `discoverHandlers("zinc")`; `ui/index.ts` exports no handlers (they would be registered twice), so the `./ui/handlers` / `./ui/index` entries of `OPTIONAL_HANDLER_MODULES` can be dropped. The package area passes `promptPermission` as `prompt` to `createPluginRuntime`. On `onPluginRegistrationsReset` call `clearUiOf(pluginId)` (closes the plugin's dialogs). Section header button presses: `onController(c => ...)` then `c.fireRaw(buttonId, "press")`; `onMeta` gives title, summary, enabled, badge and button states.

## Decisions

- `box` lays out as a column unless `style.direction` says otherwise.
- In the JSON form an integer for `width`, `height`, `gap` ... is a spacing step (4 px); write `"160px"` for pixels (the schema says so; the fixture first got this wrong and drew an 800 px skeleton).
- `grid` is flex rows with cells sized from the tracks (`fill`, px, `content`), because GPUIX grids have equal columns only.
- Event handlers of a node: `press` and `context-menu` are always attached; hover, key, focus, tooltip and `visible` handlers are attached when the node is first shown with such a binding.
- Mixed text runs: one `<text>` when uniform; Markdown (bold, italic, mono, strike, links) when no run has its own colour or size; otherwise one `<text>` per word (links stay clickable, italic is dropped).
- A dialog's `close` event for `open-dialog`: one `close` with `button` (or `none`), then, when there are named inputs, a second `close` with `form`.
- Toast: GPUIX toasts have one title, one description and buttons. Lines become the description (with the progress as a percentage); tones `warning` and `neutral` show as info; `duration-ms` none stays until closed; there is no `close` event for a toast the user dismissed.

## Run it

```bash
cd gpui-ui
bun test src/wasmplugins/ui/ui.test.ts        # 23 unit tests, 1.5 s
bun scripts/shot-wasm-ui.tsx                   # builds the fixture into %TEMP%\zn-wasm-ui-fixture (kept; --clean removes it), screenshots to %TEMP%\zn-wasm-ui
bun check                                      # no errors in the ui files
```

The script starts a real supervisor and plugin host process (headless GPUIX test root, nothing on screen), mounts the fixture with `<PluginView>`, and checks: the tree draws, a button click, typing, form submit, checkbox, radio, a grouped select, a button menu, tabs, table sort, virtual rows, a toast, a dialog opened from a handler with events from the dialog arriving while `run-dialog` waits (re-entrancy), the dark-mode `update-context`, and `unmount`. `ZN_PLUGIN_LOG=1` prints the plugin's log lines with times.

## Test result

`bun test src/wasmplugins/ui/ui.test.ts`: **23 pass, 0 fail**. `bun scripts/shot-wasm-ui.tsx`: **30 checks pass, 0 fail** (about 2.5 minutes, nearly all of it the slow first calls below). `bun check` in `gpui-ui/` and `plugin-host/`: clean. Screenshots in `%TEMP%\zn-wasm-ui\`: `ui-light-top`, `ui-light`, `ui-dark`, `ui-select-open`, `ui-toast`, `ui-dialog`. Findings that matter:

- **Native `<input>` / `<textarea>` text keeps the colours of the mode it was created in** when the mode changes (`ui-dark.png`: typed text is dark on dark). Zinc's own `TextInput` has the same shape; not investigated.
- **The first call of each big export of a QuickJS guest takes about 15 to 22 s** (first `mount`, first `on-event`, first `update-context`; componentize-qjs 0.6, `--opt-size`, the size of `ui.wit`); later calls take milliseconds. `visibility`, `unmount`, `suggest` are instant. This is far over the 5 s call budget, so a real QuickJS plugin with UI is killed on its first mount (a `startup` warm-up does not help: each export pays once). The fixture test runs with a 120 s budget. Needs: the core area gives the first `ui-events` call of a plugin (or a `startup` warm-up) a long budget, or finds the cause (a build flag of `build-plugin.ts`, the guest's lazy type tables); the SDK area should know that JS guests pay this. Rust guests were not measured.
- Everything else is as fast as expected once warm.

## WIT rows now implemented (interface.function)

`ui.push`, `refresh`, `focus`, `scroll-to`, `form-values`, `web-post-message`, `run-dialog`, `open-dialog`, `update-dialog`, `close-dialog`, `alert`, `confirm`, `prompt`, `popup-menu`, `show-toast`, `update-toast`, `close-toast`, `get-theme`, `set-theme-override`, `clear-theme-override`, `measure-text`; `open-window` / `close-window` return the WIT error (below). `ui-events.mount`, `update-context`, `unmount`, `visibility`, `on-event`, `resync`, `render-range`, `suggest` are called by `PluginView` / `ViewController`. All 40 node kinds render; events press, double-press, context-menu, change, input, submit, focus, blur, key-down/up, hover, toggle, select, activate, sort, resize, scroll, close, message, web, pointer-down/move/up, wheel, view-changed, visible, embed are delivered where the node can fire them.

Parity rows (ui.md 1 and 2) that are covered by this: buttons, checkbox, switch, radio, select, text and number input, colour, slider, date, token input, box, grid, scroll, split, tabs, deck, group, section, label / link / image / icon, progress, separator, toolbar, list-view, table (inline and virtual, tree), context menu, popover, rich text, canvas, web view, embed (partial), alert / confirm / prompt, dialogs, toasts, preference binding, localized text, theme override, form submit.

## Stubbed or left

- `ui.open-window`: Zinc has one GPUIX window. Returns `permission-denied("ui.windows")` without the permission, else `unavailable`. Needs a second-window facility in the app.
- Modeless dialogs are drawn as modal overlays (the layer system has no modeless dialog); the limits (1 modal, 3 modeless) are enforced.
- `text-input`: `password` is drawn as plain text (the native input cannot mask); `select-on-focus`, `spellcheck`, `max-rows` on single lines are ignored. `select.searchable` has no search field. Italic is not available on plain `<text>` (GPUIX has no italic style).
- `style.z-index` is ignored (GPUIX paints in tree order). Column resizing in tables and `drag-start` / `drop` / `draggable` / `drop-target` are not wired. `states.selected` is not applied to rows.
- `image` with `attachment` source shows a placeholder (no thumbnail endpoint is used).
- `embed`: `item-box`, `abstract-box`, `tags-box`, `notes-box`, `attachments-box`, `related-box`, `libraries-collections-box` (count only), `item-picker` and `collection-picker` read the core API (permission `library.read`). `note-editor`, `attachment-preview`, `attachment-annotations`, `search-builder`, `style-picker` show "not available in this build".
- `web-view`: uses the `webview/host.ts` `WebHost` with the checks of ui.md (permission `ui.webview`, 2 per plugin, 4 in all, hosts in `allow-hosts` and the manifest's `net` hosts, strict CSP for `html` and `asset` pages, `window.zinc.postMessage`). `asset` pages are single files. Not exercised headlessly (no WebView2 in the test); only the "no permission" notice is checked.
- `ui.measure-text` is an estimate from character advances (GPUIX has no measuring call).
- `ui.set-theme-override` changes the colours plugin views draw with (`colors.ts` overrides); it does not restyle Zinc's own tokens: that needs the appearance module (`shell/appearance.ts`) to call `onThemeOverrideChange` and merge `themeOverrideList()`. No Settings switch yet.
- Changing the `on` map of an existing node does not attach new hover, key or focus handlers; give the node a new key.
- Patches: `set-node` cannot carry row `content` indices (no node table); after a failed op the earlier ops of the same patch stay applied and a resync follows.

## WIT changes

None.

## Needs from other areas

- **core / supervisor**: the first-call budget problem above.
- **extend / app**: mount `<PluginView>` in item pane sections, preference panes, tabs, side panels and toolbar slots with `surface` and `view`; call `clearUiOf` on registration resets; remove the `./ui/handlers` and `./ui/index` entries of `OPTIONAL_HANDLER_MODULES`. `<OverlayHost/>` must be mounted (the app has it) for dialogs, menus, popovers and tooltips.
- **reader**: the same `<PluginView>` for `reader-sidebar`, `reader-overlay` and `toolbar-slot`; pass `width` / `height` for the strips.
- **pkg**: `createPluginRuntime({ prompt: promptPermission })`.
- **app (appearance)**: theme overrides (above).
