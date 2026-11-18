# Phase 2, extend agent: extension points in the main window

Status 2026-11-18. WIT: [`extend.wit`](../../../plugin-api/wit/extend.wit). Result: `bun test src/wasmplugins/extend/extend.test.ts` in `gpui-ui/`: **16 pass**; `bun scripts/shot-wasm-extend.tsx`: **all 21 checks pass** (headless, with the real QuickJS fixture plugin in the plugin host process); `bun check` in `gpui-ui/`: clean; the existing sidebar / shell / cards / table / itempane tests (90) still pass.

## What was built

| File | What it is |
|---|---|
| `gpui-ui/src/wasmplugins/index.ts` | App wiring. `startWasmPlugins()` creates the one supervisor, collects every `where:"zinc"` handler, loads and starts the installed plugins, binds the window side, clears registrations on `host-restart` and on a plugin's `stopped` / `disabled` / `failed`. Accessors for the ui and reader agents: `getPluginSupervisor()`, `pluginSupervisor()` (reactive), `useWasmPlugins()`, `callPlugin()`, `onPluginRegistrationsReset(fn)`, `addZincHandlers()`. |
| `wasmplugins/host.ts`, `flag.ts`, `register.ts` | Light parts: supervisor holder and reset signal; the switch; the Settings > Plugins section. |
| `wasmplugins/extend/handler.ts` | The `zinc:plugin/extend` import handler (every function of the interface). `plugin-host/src/imports/extend.zinc.ts` re-exports it (named `.zinc.ts` so `discoverHandlers("zinc")` finds it). |
| `extend/registry.ts`, `wit.ts` | Reactive registries per extension point, namespaced by plugin; jco-shaped TS types of the WIT. |
| `extend/navigation.ts`, `bind.ts`, `context.ts` | The host the handler uses (selection, view, tabs, navigation), bound to the store; `context` and condition context; mirrors of plugin menu entries and shortcuts into `registry.ts`; the debounced `on-event` stream. |
| `extend/conditions.ts`, `cache.ts`, `data.ts`, `menus.ts`, `drop.ts`, `prefs.ts`, `text.ts`, `style.ts` | `condition` evaluation; the batch cache; column cells, row styles, decorations and info row values (cached, invalidated); menu resolution, `on-menu-showing` (120 ms), commands; file drops; plugin prefs adapter; text and colour conversion. |
| `extend/Sections.tsx`, `InfoRows.tsx`, `ToolbarSlot.tsx`, `Chrome.tsx`, `Tree.tsx`, `settings.tsx`, `viewSlot.tsx`, `columns.ts` | The UI: item pane sections, Info rows, toolbar buttons and views, menubar, banners, tabs, side panels, collection decorations and virtual collections, preference panes, the `PluginView` slot, table columns. |
| Edits to existing files | `registry.ts` (unregister functions, `disabled`, group `"plugins"`), `cards/menus.ts`, `itempane/index.tsx`, `itempane/Info.tsx`, `Toolbar.tsx`, `TopBar.tsx`, `App.tsx`, `sidebar/Collections.tsx`, `table/defs.ts`, `table/headless.ts`, `table/Table.tsx`, `features.ts`, `platform.ts`. All are no-ops while no plugin registered anything. |
| `extend/extend.test.ts`, `gpui-ui/test/wasm-extend-fixture/`, `gpui-ui/scripts/shot-wasm-extend.tsx` | Tests, the QuickJS fixture plugin, the headless window check. |

## Run it

```bash
cd gpui-ui
bun check
ZN_UI_STATE=off bun test src/wasmplugins/extend/extend.test.ts        # builds the fixture first (about 12 s); ZN_EXTEND_FIXTURE=<built folder> skips that
bun scripts/shot-wasm-extend.tsx [dark|light]                         # needs no core: it makes a throw-away library and runs the core in-process
```

Turn plugins on in the real app: Settings > Plugins (takes effect at the next start) or `ZN_WASM_PLUGINS=1`. Installed plugins are the folders under `ZN_PLUGINS_DIR` (default `%APPDATA%\zotero-next-gpui\plugins`), each in the layout of `plugin-host/src/manifest.ts` (`manifest.json`, `transpiled/plugin.js`). Off by default: with the switch off nothing starts, no menubar is drawn and the default app is unchanged.

## What the tests prove

`extend.test.ts`: conditions; the batch cache (50 rows = one call, cached, per-key invalidation, 200-key batches, a failing call keeps the last value); the handler (namespacing, `conflict`, permissions `ui.windows` / `ui.drop` / `ui.navigate` / `library.read`, built-in tab kinds refused, all-or-none `register-columns`, navigation through a bound host, `unavailable` without one); menu resolution (children, conditions, patches); and the QuickJS fixture through the real supervisor: everything is registered at startup, a column for 40 rows is fetched in ONE call of 40 keys, a menu command and a toolbar click reach the plugin, the Info row value comes from the plugin, and registrations are gone after the plugin stops.

`shot-wasm-extend.tsx` (whole `<App/>`, headless): toolbar button drawn and its click reaches the plugin; item pane section header drawn; Info row label and plugin value drawn; the menubar (File / Edit / View / Go / Tools / Help) drawn with the plugin's Tools entry and its click reaching the plugin; the item context menu entry drawn and its click reaching the plugin (`items=1`); the shortcut reaches the plugin; the plugin column's cells drawn in the Classic table, fetched in batches; the plugin's preference pane row drawn in Settings. Screenshots go to `<scratch>/gpui-shots/wasm-extend-*.png`.

## WIT rows now implemented (interface.function)

`extend.`: `register-menu`, `replace-menu-entries`, `patch-menu`, `register-section`, `register-info-row`, `refresh-info-row`, `register-column`, `register-columns`, `invalidate-columns`, `register-row-style`, `invalidate-row-styles`, `register-collection-decoration`, `invalidate-collection-decorations`, `register-virtual-collection`, `invalidate-virtual-collection`, `register-toolbar-button`, `set-toolbar-button-state`, `register-toolbar-view`, `register-side-panel`, `set-side-panel-open`, `register-shortcut`, `register-pref-pane`, `replace-pref-rows`, `open-tab`, `select-tab`, `close-tab`, `rename-tab`, `set-tab-pinned`, `move-tab`, `list-tabs`, `selected-tab`, `show-banner`, `hide-banner`, `get-context`, `list-selected-items`, `get-view`, `list-view-items`, `select-items`, `select-row`, `set-search`, `set-panel-visible`, `open-settings`, `open-item`, `register-drop-target`, `register-drag-format` (registry only), `subscribe-events`, `unregister`.
`extend-handlers.` called by the host: `on-menu-showing`, `on-menu-phase` (helper only, see below), `on-menu-command`, `on-toolbar-click`, `on-shortcut`, `on-info-row-get`, `on-info-row-set`, `on-column-values`, `on-row-styles`, `on-collection-decorations`, `on-virtual-collection-items`, `on-pref-pane-open`, `on-pref-pane-close`, `on-pref-action`, `on-tab-closing`, `on-banner-action`, `on-drop`, `on-event` (selection, view, tab-selected, theme; debounced 100 ms).

## How each extension point is mounted

- **Menus.** `library-item` entries become item actions (group `"plugins"`, last before Trash; submenus one level), `library-collection` collection actions, `library-add`, `library-add-attachment`, `library-add-note` entries of the Add menu. Visible and enabled conditions and `entry-patch`es apply when the menu is built; `on-menu-showing` runs for the item menu in parallel with the detail fetch (at most 120 ms). Accelerators on any entry bind a global shortcut. **Real menubar: built.** The top bar has room, so File / Edit / View / Go / Tools / Help sit at its left, shown only while plugins run (the default app has none). Built-in contents are small (File: the Add actions; Edit: Select all; View: panel toggles and List/Classic; Go: Library, Settings; Tools: the Tools actions; Help: empty), plugin `menubar-*` entries follow after a separator. `app-info` feature `extend.menubar` should be true while plugins run (lifecycle owner). The overflow "Plugins" menu was not needed.
- **Item pane sections.** Frame (collapsible header, icon, header buttons) and body (a `PluginView`) are entries of the pane's virtual list, after the built-in sections, plus a tab in the side nav row. `enabled-for`, `default-open`, `body-height`, and `render-result.meta.enabled` for `decides-enabled` sections are honoured. **Reader tabs:** `PluginSectionsList` (Sections.tsx) takes a `TabRef` and an item key; the reader agent mounts it. Header button presses are forwarded to `pressViewButton(plugin, view, buttonId)` of the ui agent's module if it exports one.
- **Info rows.** Three positions (start, after creators, end); value from `on-info-row-get` through the cache, editable rows call `on-info-row-set`.
- **Columns.** Id `plugin:<plugin id>:<data key>`; offered in the column picker under "Plugin columns"; text, bar, rating and chips are shown as text (colour and text style are applied); one batched `on-column-values` per screenful (up to 200 keys), cached, invalidated by `invalidate-columns`, by the app's `itemsRev` (any data change) and on plugin stop. **Not sortable** (see below).
- **Row styles.** Background tint and text colour on plain cells of the Classic table.
- **Toolbar.** Buttons (toggle, badge, menu with `on-menu-showing`, accelerator, conditions) and views in `library-toolbar` (before Tools) and `top-bar` (before the sync status).
- **Side panels, tabs, banners.** Library side panels dock left or right of the library (fixed `default-width`, a toggle button in the top bar); plugin tabs are chips after the reader chips and bodies in the window (`store.setActiveTab("plugin:<plugin>:<tab>")`; `on-tab-closing` is honoured); banners stack above the top bar.
- **Shortcuts.** App actions bound to the default accelerator, so Settings > Shortcuts lists and rebinds them; scope and `enabled-when` apply.
- **Preference panes.** Each top-level pane is a Settings section (order 900+); `rows` panes use the host's own controls bound to plugin prefs (toggle, text, secret text, number, choice, button, note, custom view), `view` panes and `custom` rows are `PluginView`s; children draw under their parent; `open-settings` goes to the section.
- **Collection tree.** Decorations (badge, icon, colour) after the collection name, one batch per screenful. **Virtual collections** (decided: in v1): rows at the end of the Collections group; choosing one replaces the list with `VirtualCollectionView`, a plain list of the plugin's items (title, type, date; click selects the item in the item pane), asked with `on-virtual-collection-items` (first 200 keys). Choosing any other row leaves it ("Back to library" too).
- **Selection and navigation.** `get-context` (items capped at 2000, `item-count` real), `list-selected-items`, `get-view`, `list-view-items` (through the core, current query), `select-items` (`store.revealItem` per key), `select-row`, `set-search`, `set-panel-visible`, `open-settings`, `open-item`.
- **Drop targets.** `window` (App) and `collection-row` (each collection row) for OS file drops; the first matching plugin target gets `on-drop`; `ignored` falls through to the built-in import.

## Stubbed or left

- **Column sorting.** The core sorts server-side; plugin columns have `sort: ""` and ignore header clicks. `sort-mode` and `sort-key` are not used. Needs either a core route that sorts by a key list or a client-side sort of the whole view.
- **Row styles** only tint the row and colour plain cells (no leading icon, tooltip or style on the title cell); the card (List) view has no columns or row styles.
- **Virtual collections** appear at the top level only (`parent` is ignored), without sorting, grouping, columns or paging beyond 200; the view cannot be left by clicking "Library" when that is already the view (use "Back to library").
- **Drop targets** `item-list` and `item-pane`, `urls` / `text` / `items` payloads, **drag formats** (`on-drag-format`): registry only. The grant id of a dropped file is `drop:<path>`; whoever owns `fs` must resolve it (`setDropGrantFactory`).
- **Tab restore** (`tab-spec.state`, `on-tab-restore`), `on-tab-closing` for closes the user does not start, **`on-menu-phase`** (the helper exists; the dropdown has no shown / hiding callbacks), `tab-added` / `tab-closed` / `tab-moved` events (only `tab-selected` is sent).
- `showing` hooks run for the item menu, toolbar button menus and the menubar (on hover), not for collection or tab menus. `entry-kind` separators are drawn; `swatch` is not. Entry `icon` and `themed-icon.dark`: only `builtin` (lucide) names are drawn; `bundled` and `svg` fall back to the puzzle icon. Localized strings show `fallback ?? id` until the `l10n` interface is wired.
- `menu-target`s `tab`, `item-info-row`, `notes-add-item-note`, `notes-add-standalone-note`, `sidenav-locate`: registrations are accepted and kept, nothing draws them yet (the note and info-row context menus have no host menu to join; `tab` needs a tab context menu).
- `selected-tab` / `list-tabs`: one window (id 1); no tab strip order for built-in tabs.
- Not covered by the headless script (covered by unit tests or by code only): side panels, plugin tabs, banners, virtual collections, decorations, drop targets, the `PluginView` bodies (the ui agent's renderer: the slot shows a note until `wasmplugins/ui/index.ts` exports `PluginView`).

## WIT changes

None. Findings that a later WIT / SDK change may want:

1. **A missing `bool` (or other non-option) field in a record argument makes a QuickJS guest trap** ("Unreachable code should not be executed") instead of throwing a catchable error, so one forgotten `sortReverse` kills the plugin at startup. The JS SDK must fill defaults for every non-option field (the fixture spells them all out); `phase2-core.md` says "optional fields may be left out" — that holds for `option<T>`, not for `bool`, `list` or `enum`.
2. `extend.register-pref-pane` rows are keyed by pref names that the host reads through the `prefs` interface; this area needs the same store (see below).

## Needs from other areas

- **ui agent:** export `PluginView` from `gpui-ui/src/wasmplugins/ui/index.ts` with props `{ plugin, view, surface, params?, width?, height?, visible?, onMeta? }` (`viewSlot.tsx` has the type), and optionally `pressViewButton(plugin, view, buttonId)` (a section header button press, `ui-events.on-event` with `kind: press`). Handlers: either `plugin-host/src/imports/ui.zinc.ts`, or `wasmplugins/ui/handlers.ts` exporting `zincHandlers`.
- **reader agent:** handlers as `plugin-host/src/imports/reader.zinc.ts`, or `gpui-ui/src/reader/wasmHandlers.ts` exporting `zincHandlers`; mount `PluginSectionsList` (`wasmplugins/extend/Sections.tsx`) and `PluginSidePanels tabKind="reader"` (`Chrome.tsx`) in reader tabs; call `onPluginRegistrationsReset(fn)` to drop reader registrations. The full path list `index.ts` tries is `OPTIONAL_HANDLER_MODULES`.
- **pkg / lifecycle:** the installer writes the plugin layout of `plugin-host/src/manifest.ts` under `pluginsDir()` (`ZN_PLUGINS_DIR`); `app-info.features` `extend.menubar` true while plugins run; user grants (`grantsFor`) before `ui.windows` / `ui.navigate` / `ui.drop` / `library.read` become usable by default only if the manifest asks for them.
- **data / core:** a `GET/PUT/DELETE /api/plugin-prefs/<plugin>/<key>` route (a `pref-value` JSON) or a call to `setPrefsAdapter` in `extend/prefs.ts`, so preference panes and `prefs.get` see the same values; `fs` resolution of `drop:<path>` grants; a core route that lists items by key set would let virtual collections reuse the real list.
- **Coordinator:** `plugin-host/src/imports/extend.zinc.ts` imports from `gpui-ui/`; `bun check` in `plugin-host/` follows that import into gpui-ui (checked: clean, 81 files). Packaging: `index.ts` loads the optional handler modules with a variable `import()` specifier, which `bun build --compile` will not follow; list them statically at packaging time.
- **Environment note:** free space on C: dropped from 9382 to about 6700 MiB while this agent worked (other agents building); the last fixture build ran at 9382. After that only already-built output was reused.
