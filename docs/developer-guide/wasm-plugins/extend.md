# Extending Zinc's main window from a WASM plugin (`extend`)

Phase 1 design, 2026-11-18. WIT: [`plugin-api/wit/extend.wit`](../../../plugin-api/wit/extend.wit), interfaces `extend` (the plugin calls the host) and `extend-handlers` (the host calls the plugin). It covers every place in Zotero's main window where a plugin adds or changes something, except the reader (`reader.wit`), items and collections as data (`library.wit`), and the UI tree, dialogs, prompts, windows and toasts (`ui.wit`). File pickers (`fs.pick-*`), the clipboard (`clipboard`) and opening a URL (`shell.open-url`) are in `lifecycle.wit`; this area has none of them.

Sources read: Zotero's `chrome/content/zotero/xpcom/pluginAPI/` (`menuManager.js`, `itemPaneManager.js`, `itemTreeManager.js`, `pluginAPIBase.mjs`), `xpcom/preferencePanes.js`, `xpcom/prompt.js`, `xpcom/progressWindow.js`, `xpcom/banners.js`, `tabs.js`, `zoteroPane.js`, `itemTree.jsx`, `itemTreeColumns.jsx`, `elements/itemBox.js`, `elements/itemPaneSidenav.js`, `elements/notesContext.js`, `standalone/standalone.js`; `windingwind/zotero-plugin-toolkit` (`src/helpers/*`, `src/managers/*`, `src/tools/ui.ts`); and Zinc's `gpui-ui/src/registry.ts`, `itempane/`, `table/`, `sidebar/`, `Toolbar.tsx`, `TopBar.tsx`, `shell/shortcuts.ts`, `settings/registry.ts`, `dnd.ts`, plus the Zotero-compat layer in the `zotero-plugins` worktree (`plugins/managers/`, `menus.ts`).

## How this fits with `ui.wit`

`ui.wit` already owns "a view the plugin draws": `ui-events.mount / update-context / unmount / visibility / on-event`, `ui.push`, `render-result` (with `meta` for title, summary, enabled, buttons), dialogs, windows, toasts, confirm and prompt, theme overrides. `extend.wit` does not repeat any of that. It adds what a view needs around it:

- **Registration**: where the surface lives (section header and side nav, tab, side panel, preference pane, toolbar slot), when it is enabled, its icon and label.
- **Declarative data for hot paths**: conditions, columns, row styles, collection decorations. These never mount a view.
- **Host actions with no content**: selection, navigation, tab management, banners, drop targets.

### `view-context.params` per surface

`ui.view-context.params` is a JSON object whose shape the owning area documents. For the surfaces registered here:

| `ui.surface` | `view-context.view` | `params` |
|---|---|---|
| `item-pane-section` | `pane-id` | `{"window":1,"tabID":"library","tabType":"library","tabSubType":null,"itemKey":"ABCD2345","libraryID":1,"editable":true}` |
| `tab` | `tab-id` | `{"window":1,"tabID":"…","kind":"my-kind","state":{…}\|null,"item":"ABCD2345"\|null}` |
| `side-panel` | `panel-id` | `{"window":1,"tabID":"library","tabType":"library","side":"right"}` |
| `preferences-pane` | `pane-id`, or `pane-id/row-id` for a `custom` row | `{"paneID":"…","rowID":null}` |
| `toolbar-slot` | `view-id` | `{"window":1,"slot":"library-toolbar"}` |

Header buttons of a section arrive as `ui-events.on-event` with `kind: press`, `handler` = the button `id`, `node-key` none (confirmed in `ui.wit`: `ui-events.on-event` is the one event entry point for every view, section, dialog, toast and tab).

## 1. Parity table

Status: `covered`, `partial` (what is missing is stated), `not planned` (why, and what to do instead). "ui" in the WIT column means the capability is in `ui.wit`, which this area relies on.

### 1.1 Item pane sections: `Zotero.ItemPaneManager.registerSection` (`itemPaneManager.js`)

| # | Zotero capability | Zinc WIT | Status |
|---|---|---|---|
| 1 | `registerSection({paneID, pluginID})`, `unregisterSection`, ids namespaced by plugin, clash with built-in ids refused | `extend.register-section`, `unregister(section, id)`, `conflict` error | covered |
| 2 | `header {l10nID, l10nArgs, icon, darkIcon}` | `section-registration.header` (`localized-string`, `themed-icon`) | covered |
| 3 | `sidenav {l10nID, l10nArgs, icon, darkIcon, orderable}` | `section-registration.sidenav` | covered |
| 4 | `bodyXHTML` (initial body markup) | none: the body is a `ui.tree` from `mount` | not planned: plugins get no DOM or XHTML; return a tree instead |
| 5 | `onInit` (set up data, no rendering) | `ui-events.mount` | covered |
| 6 | `onDestroy` | `ui-events.unmount` | covered |
| 7 | `onItemChange` returning bool, with `setEnabled` | `section-registration.enabled-for` (declarative, no call) and `ui-events.update-context` returning `render-result.meta.enabled` | covered |
| 8 | `onRender` (sync) and `onAsyncRender` | `mount` / `update-context` return the tree; `ui.push` for later updates; `body-height` reserves space | covered |
| 9 | `onToggle` | `ui-events.visibility` | covered |
| 10 | `sectionButtons[] {type, icon, darkIcon, l10nID, onClick}` | `section-registration.buttons`; press arrives as `on-event` | covered |
| 11 | `setL10nArgs`, `setSectionSummary`, `setSectionButtonStatus` | `render-result.meta` (`title`, `summary`, `buttons`) | covered |
| 12 | `setEnabled` from any hook | `render-result.meta.enabled` | covered |
| 13 | `refresh()` exposed to `onInit` | `ui.refresh(instance)` | covered |
| 14 | Hook args `doc`, `body` (DOM nodes) | none | not planned: no DOM access. All content is the returned tree |
| 15 | Hook args `item`, `tabType`, `editable` | `view-context.params` (`itemKey`, `tabType`, `editable`) | covered |
| 16 | Section shown in the library item pane, the reader context pane and the note window (`tabType` tells which) | `params.tabType`; `enabled-for.tab-kinds` | covered: decided 2026-11-18 that Zinc's reader tab shows plugin sections (host work in phase 2) |
| 17 | `isSectionOrderable`, `customSectionData` (host internals) | none | not planned: used only by Zotero's own item pane |
| 18 | Collapsed sections are still called on every item change (so a plugin can hide itself) | `decides-enabled` flag | covered: default is lazy (a collapsed section is updated when expanded); a plugin that must run to hide itself sets `decides-enabled` |

### 1.2 Info rows: `Zotero.ItemPaneManager.registerInfoRow`

| # | Zotero capability | Zinc WIT | Status |
|---|---|---|---|
| 19 | `registerInfoRow({rowID, label, position, multiline, nowrap, editable})`, `unregisterInfoRow` | `register-info-row`, `unregister(info-row, id)` | covered |
| 20 | `onGetData` | `extend-handlers.on-info-row-get` | covered |
| 21 | `onSetData` | `on-info-row-set` | covered |
| 22 | `onItemChange` with `setEnabled`, `setEditable` | `info-row-value.enabled/editable` returned by `on-info-row-get`; `enabled-for` | covered |
| 23 | `refreshInfoRow(rowID)` | `refresh-info-row` | covered |
| 24 | `customInfoRowData`, `getInfoRowHook` | none | not planned: Zotero host internals |

### 1.3 Item list columns: `Zotero.ItemTreeManager` (`itemTreeManager.js`, `itemTree.jsx`)

| # | Zotero capability | Zinc WIT | Status |
|---|---|---|---|
| 25 | `registerColumn({dataKey, label, pluginID})`, `unregisterColumn`, key namespaced by plugin | `register-column`, `unregister(column, id)` | covered |
| 26 | `registerColumns`, `unregisterColumns` (deprecated plurals) | `register-columns` (all or none); unregister one by one | covered |
| 27 | `enabledTreeIDs` (`main`, `*`, other tree ids) | `column-registration.trees` | covered |
| 28 | `defaultIn`, `disableIn` (deprecated) | none | not planned: deprecated in Zotero |
| 29 | `sortReverse` | `sort-reverse` | covered |
| 30 | `flex`, `width`, `fixedWidth`, `staticWidth`, `noPadding`, `minWidth` | same names | covered |
| 31 | `iconPath` | `icon` | covered |
| 32 | `iconLabel` (React component) and `htmlLabel` (HTML string or component) | none | not planned: no HTML or React from a plugin. Use `label` plus `icon` |
| 33 | `showInColumnPicker`, `columnPickerSubMenu` | `show-in-picker`, `picker-submenu` | covered |
| 34 | `dataProvider(item, dataKey)`, called per cell | `on-column-values(data-key, keys[]) -> cell[]`, batched, cached, async | covered: the shape changes from per row to per batch, by design |
| 35 | `renderCell(index, data, column, isFirstColumn, doc)` returning a DOM element | `cell.body`: `text`, `icon`, `bar`, `rating`, `chips`, plus `color`, `style`, `tooltip` | partial: the cell kinds cover the common cases (progress bars, stars, tags, coloured marks). Arbitrary DOM in a cell is not planned |
| 36 | Plugin columns sort | `sort-mode` (`text`, `number`) and `cell.sort-key` | covered: the host fetches values in batches and sorts itself (Zotero's sort calls the provider per comparison) |
| 37 | `zoteroPersist` (width, hidden, sortDirection) | the host always persists these three for plugin columns | covered: not optional |
| 38 | `primary` (one primary column) | none | not planned: the title is the only primary column |
| 39 | `refreshColumns()` | `invalidate-columns` | covered |
| 40 | `getCustomColumns`, `isCustomColumn`, `getCustomCellData`, `customColumnUpdateID` | none | not planned: host internals |

### 1.4 Menus: `Zotero.MenuManager` (`menuManager.js`)

| # | Zotero capability | Zinc WIT | Status |
|---|---|---|---|
| 41 | `registerMenu({menuID, pluginID, target, menus})`, `unregisterMenu` | `register-menu`, `unregister(menu, id)`, `replace-menu-entries` | covered |
| 42 | Target `main/menubar/tools` | `menu-target.menubar-tools` | covered |
| 43 | Targets `main/menubar/file`, `edit`, `view`, `go`, `help` | `menubar-file`, `-edit`, `-view`, `-go`, `-help` | covered: decided 2026-11-18 that Zinc gets a real menubar in phase 2; until then the host shows the entries in an overflow "Plugins" menu with the menu name as a prefix |
| 44 | Target `main/library/item` | `library-item` (table and cards) | covered |
| 45 | Target `main/library/collection` | `library-collection` | covered |
| 46 | Targets `main/library/addAttachment`, `main/library/addNote` | `library-add-attachment`, `library-add-note` | covered |
| 47 | Target `main/tab` | `menu-target.tab` | covered |
| 48 | Targets `reader/menubar/*` (deprecated) | none | not planned: deprecated; use `menubar-*` with `visible-when.tab-kinds = ["reader/*"]` |
| 49 | Target `itemPane/info/row` | `item-info-row`, `context.field` | covered |
| 50 | Targets `notesPane/addItemNote`, `notesPane/addStandaloneNote` | `notes-add-item-note`, `notes-add-standalone-note` | covered |
| 51 | Target `sidenav/locate` | `sidenav-locate` | covered |
| 52 | `menuType` `menuitem`, `separator`, `submenu`, nested `menus` | `entry-kind`; flat list with `parent`; `swatch` (a `color`, for the reader's colour menus) | covered |
| 53 | `l10nID`, `l10nArgs` | `label: localized-string` | covered |
| 54 | `icon`, `darkIcon` | `themed-icon` | covered |
| 55 | `enableForTabTypes` | `condition.tab-kinds` | covered |
| 56 | `onShowing` (can call `setVisible`, `setEnabled`, `setL10nArgs`, `setIcon`) | `on-menu-showing` returns `entry-patch[]`; `patch-menu` | covered: 120 ms limit. Selection-based rules should use `visible-when` / `enabled-when`, which need no call |
| 57 | `onShown`, `onHiding`, `onHidden` | `on-menu-phase` | covered |
| 58 | `onCommand(event, context)` | `on-menu-command(menu-id, entry-id, checked, context)` | covered |
| 59 | Context object: `items`, `collectionTreeRows`, `tabType`, `tabSubType`, `tabID`, `editable`, `fieldName` | `context` (keys instead of item objects; `field`) | covered |
| 60 | Context `menuElem`, `targetElem`, and the DOM `event` argument | none | not planned: no DOM |
| 61 | Automatic grouping of plugin items under a separator, overflow into a "plugin actions" submenu; no top-level separators | host behaviour for `library-item` and `library-collection` | covered: same rule, decided by the host from the real menu height |
| 62 | Menu removed when the plugin shuts down | automatic | covered |
| 63 | Check menu items (not in the official API; plugins set `type=checkbox` on DOM menuitems) | `menu-entry.check`, `entry-patch.checked`, `on-menu-command.checked` | covered |
| 64 | Accelerators shown on items | `menu-entry.accelerator` (also bound, rebindable) | covered |

### 1.5 Preference panes: `Zotero.PreferencePanes.register` (`preferencePanes.js`)

| # | Zotero capability | Zinc WIT | Status |
|---|---|---|---|
| 65 | `register({pluginID, id, label, image, parent, helpURL})`, `unregister`, removed on shutdown | `register-pref-pane`, `unregister(pref-pane, id)` | covered |
| 66 | `src` (XHTML fragment with XUL) | `pane-content.rows` (declarative) or `pane-content.view` (a `ui.tree`) | partial: no XUL or XHTML. Rows cover the usual controls; `view` covers the rest |
| 67 | `scripts[]` (the pane's code, `onload`) | `on-pref-pane-open/close`, `on-pref-action`, and `ui-events` for `view` panes | covered (as callbacks) |
| 68 | `stylesheets[]` | none | not planned: panes use Zinc's theme. A plugin that wants to change colours uses `ui.set-theme-override` |
| 69 | `defaultXUL` | none | not planned: implementation detail of XUL panes |
| 70 | XUL `preference="..."` bindings (checkbox, textbox, menulist, radiogroup) | `setting-control` (`toggle`, `text`, `number`, `choice`) bound to plugin prefs | covered |
| 71 | Enable/disable a control from another pref (`disabled` bindings in script) | `setting-row.enabled-when`, `visible-when` | covered |
| 72 | Pane searchable in Zotero's preferences search | `setting-row.keywords`; rows join Zinc's settings search | covered |
| 73 | `ZoteroPane.openPreferences(paneID)` | `open-settings` | covered |
| 74 | Secret values (API keys) in a text field | `text-setting.secret` | covered: new |

### 1.6 Tabs: `Zotero_Tabs` (`tabs.js`)

| # | Zotero capability | Zinc WIT | Status |
|---|---|---|---|
| 75 | `add({id, type, data, title, index, select, pinned})` | `open-tab(tab-spec)` | covered |
| 76 | The returned `container` element the plugin fills | view mounted with `ui.surface.tab` | covered |
| 77 | `onClose` option | `on-tab-closing` (can veto) | covered |
| 78 | `select`, `selectPrev`, `selectNext`, `selectLast`, `jump` | `select-tab` with `list-tabs` | covered |
| 79 | `close`, `closeAll`, `undoClose` | `close-tab` (one tab); `list-tabs` plus `close-tab` for all | partial: `undoClose` is a user feature of Zotero's own tabs and plugin tabs are not reopened |
| 80 | `rename`, `move`, `setPinned` | `rename-tab`, `move-tab`, `set-tab-pinned` | covered |
| 81 | `selectedID`, `getTabInfo`, `_tabs` | `selected-tab`, `list-tabs`, `tab-info` | covered |
| 82 | `getState`, `restoreState` (session restore) | `tab-spec.state`, `on-tab-restore` | covered |
| 83 | `tabHooks` for a custom tab type (load, unload, focus) | `ui-events.mount`, `unmount`, `visibility` | covered |
| 84 | Tab notifier events (`add`, `close`, `select`, `move` on type `tab`) | `subscribe-events(tab-changed)`, `host-event.tab-*` | covered |
| 85 | `addLibraryTab` (a second library tab) | none | not planned: Zinc has one library tab |
| 86 | `moveToWindow`, tear-off, `setAudioStatus`, `toggleAudio` | none | not planned: windows are managed by the host; audio is for web snapshots |
| 87 | `selectOptions`, `preventJumpback`, `_prevSelectedID` (jump-back history) | none | not planned: internal navigation history |
| 88 | Tab context menu (`main/tab`) | `menu-target.tab` | covered (see row 47) |

### 1.7 Selection, view and navigation: `ZoteroPane` (`zoteroPane.js`)

| # | Zotero capability | Zinc WIT | Status |
|---|---|---|---|
| 89 | `getSelectedItems(asIDs)` | `context.items`, `get-context`, `list-selected-items` | covered |
| 90 | `getSelectedCollection(s)`, `getSelectedSavedSearch(es)`, `getSelectedGroup`, `getSelectedLibraryID(s)`, `getCollectionTreeRow`, `getSelectedObjects` | `context.rows`, `context.library` | covered |
| 91 | `getSortedItems`, `getSortField`, `getSortDirection` | `list-view-items`, `get-view` (`sort`) | covered |
| 92 | `selectItem`, `selectItems` | `select-items` | covered |
| 93 | `collectionsView.selectLibrary`, `selectCollection`, `selectSearch`, selecting rows | `select-row` | covered |
| 94 | Quick search box text (`#zotero-tb-search`) | `set-search` | covered |
| 95 | `toggleItemPane`, collapse the collections pane | `set-panel-visible` | covered |
| 96 | `viewAttachment`, `viewItems` | `open-item(key, mode)` | covered |
| 97 | Selection and collection change events (item tree `onSelect`, collection tree `onSelect`) | `subscribe-events` (`selection-changed`, `view-changed`), debounced | covered |
| 98 | `newItem`, `newNote`, `newCollection`, `createEmptyParent`, `addAttachmentFromDialog` | none in `extend` | not planned here: creating data is `library.wit`; the "open a new note in the editor" step is the `reader` area's note editor |
| 99 | `ZoteroPane_Local`, `Zotero.getMainWindow()`, `window.ZoteroPane.itemsView` (the live tree objects) | `context`, `window-id` (lifecycle `app.main-windows`) | not planned: no object access. `itemsView.ensureRowsAreLoaded`, `expandAllRows` etc. have no use without the object |
| 100 | `setItemsPaneMessage`, item pane message ("No items selected") | none | not planned: rare; use a banner or a side panel |

### 1.8 Banners, prompts, progress, dialogs, windows (`banners.js`, `prompt.js`, `progressWindow.js`)

| # | Zotero capability | Zinc WIT | Status |
|---|---|---|---|
| 101 | `Zotero.Banners` bars above the tab strip (not a plugin API in Zotero; plugins use it or inject DOM) | `show-banner`, `hide-banner`, `on-banner-action` | covered: new, small |
| 102 | `Zotero.Prompt.confirm({title, text, button0..2, checkbox, buttonDelay})` | `ui.confirm`, or `ui.run-dialog` with three buttons | partial: `ui.confirm` has two buttons and a checkbox; three-button prompts and `buttonDelay` need `ui.run-dialog` |
| 103 | `Services.prompt.alert`, `prompt`, `select`; `Zotero.alert` | `ui.alert`, `ui.prompt`; `select` via `ui.run-dialog` | partial: no built-in "choose from list" prompt |
| 104 | `Zotero.ProgressWindow` (`changeHeadline`, `addLines`, `ItemProgress` with `setProgress`, `setText`, `setError`, `setIcon`, `show`, `startCloseTimer`, `close`) | `ui.show-toast`, `update-toast`, `close-toast` (title, lines with progress, tone, `duration-ms`) | covered |
| 105 | `ProgressWindowSet.closeAll` | none | partial: the plugin keeps its toast ids and closes them; there is no "close all" |
| 106 | `Zotero.ProgressQueue` / `progressQueueDialog.jsx` (a dialog that lists queued items and their status) | none | not planned: build it as a `ui.open-dialog` with a list and update it with `ui.update-dialog` |
| 107 | `window.openDialog`, `Services.ww.openWindow` with a `chrome://` XHTML dialog | `ui.run-dialog`, `ui.open-dialog`, `ui.open-window` | partial: the content is a `ui.tree`, not XHTML |
| 108 | File and folder pickers (`FilePicker`, toolkit `FilePickerHelper`) | `fs.pick-open`, `fs.pick-save`, `fs.pick-directory` (lifecycle); results are `types.file-grant`s read with `fs.read` | covered |

### 1.9 Unofficial but widely used: from zotero-plugin-toolkit and from patching

| # | Capability (where plugins get it) | Zinc WIT | Status |
|---|---|---|---|
| 109 | Add items to the main window's menus through the DOM (`ztoolkit.Menu`, `#zotero-itemmenu`, `#zotero-collectionmenu`, `#menu_ToolsPopup`) | the menu rows above | covered |
| 110 | Toolbar buttons added to `#zotero-items-toolbar`, `#zotero-tabs-toolbar` | `register-toolbar-button`, `register-toolbar-view`, `set-toolbar-button-state` | partial: two slots (library toolbar, top bar). Arbitrary elements anywhere are not planned |
| 111 | Keyboard shortcuts (`KeyboardManager`: `keydown`/`keyup` on the main window and reader iframes, key combos) | `register-shortcut`, `on-shortcut`; user rebinds in Settings > Shortcuts | partial: named commands with one chord. Raw key events, key sequences and overriding built-in shortcuts are not planned (a plugin cannot hear every key press; the user owns key bindings) |
| 112 | Command palette (`PromptManager`, older toolkit) | `shortcut-registration.in-command-search`; or `ui.open-dialog` | partial: Zinc has no command search yet; the flag is ignored until it does |
| 113 | Custom dialogs (`DialogHelper`, `SettingsDialog`) | `ui.run-dialog` / pref pane | covered |
| 114 | Table in a plugin UI (`VirtualizedTableHelper`, React `VirtualizedTable`) | `ui` list and table nodes with `render-range` | covered (ui) |
| 115 | Custom UI added anywhere in Zotero's DOM (`UITool.appendElement`, `createElement`) | the extension points here, plus `register-side-panel` | not planned: no DOM. Where the plugin wanted its own box, use a section, a tab, a side panel or a toolbar view |
| 116 | Injected stylesheets that restyle Zotero (make-it-red style) | `ui.set-theme-override` | partial: colour tokens only, not arbitrary CSS |
| 117 | Item tree row styling (plugins patch `ItemTree` rendering) | `register-row-style`, `on-row-styles` | covered: new; batched like columns |
| 118 | Collection tree badges and icons (patching `collectionTree.jsx`) | `register-collection-decoration`, `on-collection-decorations` | partial: badge, icon, colour, tooltip. Custom columns in the collection tree are not planned (Zinc's tree has none) |
| 119 | Extra rows in the collection tree (custom "virtual" collections) | `register-virtual-collection`, `on-virtual-collection-items` | partial: a flat row whose items come from the plugin; no nested subtree of its own. Wanted for v1 (decided 2026-11-18) |
| 120 | Drop files, URLs or text onto the item list, the collection tree or the window (`drop` listeners) | `register-drop-target`, `on-drop`; dropped files are `types.file-grant`s read with `fs.read` | partial: declared filters and one call per drop. No `dragover` hook, no custom drop effect |
| 121 | Add formats to items dragged out of Zotero (`Zotero.DragDrop`, patching the item tree) | `register-drag-format`, `on-drag-format` | partial: text formats only, one call at drag start |
| 122 | `PatchHelper` and monkey-patching Zotero functions (`ItemTree.prototype`, `ZoteroPane`, `Zotero.Item.prototype.getField`) | none | not planned: a plugin cannot change host code. Common reasons are covered by columns, info rows, row styles and menus. Virtual fields: info row or column |
| 123 | `GuideHelper` (highlight elements with a tour) | none | not planned: no element references. Use a `ui` popover or a banner |
| 124 | `ztoolkit.getGlobal`, `Zotero_Tabs._tabs`, any private field | none | not planned: private to Zotero |
| 125 | Notifier types `itempane`, `infobox`, `itemtree` that fire after registrations change | none | not planned: internal refresh signals |
| 126 | `ZoteroContextPane` (the reader's context pane: notes, item pane for the attachment) | sections with `tab-kinds`, `notes-add-*` menus | partial: depends on how the `reader` area shows the context pane |

Counts for this area, tallied by script over the tables above: 126 rows; **covered 86, partial 16, not planned 24** (rows 16 and 43 moved to covered after the user's decisions of 2026-11-18).

## 2. Design notes

**Registration is data; behaviour is a few coarse callbacks.** Zotero registers an options object with functions in it. A WASM plugin cannot pass functions, so each registration is a record and the behaviour is an exported handler named by an id. The ids are chosen by the plugin so the plugin never has to remember a host-made handle. The host namespaces them by plugin id, as Zotero does with `pluginID`, so two plugins cannot clash.

**The process boundary decides the shape of every hot path.** Every call from the host into a plugin crosses a process boundary, so no handler is called on scroll, mouse move or drag.
1. *Conditions replace callbacks.* `condition` is a small record (tab kind, number of items, item types, tree row kinds, editable) that the host evaluates itself. It replaces nearly all uses of `onShowing`, `onItemChange` and `enableForTabTypes`. A menu opens with no call to the plugin unless the plugin asked for `showing`.
2. *Columns, row styles and decorations are batched, cached values.* The plugin gets a list of item keys and returns a list of `cell`s. The host asks for the rows on screen plus a margin (at most 200 keys), keeps the answers per item, drops them when the item's modified date changes or the plugin calls `invalidate-columns`, and never waits for a slow answer: the cell stays blank and is asked for again. `renderCell` becomes `cell.body`, a closed set of cell kinds that the host draws with its own components. This is what makes a custom column cost one call per screen of rows instead of one per cell.
3. *Sorting a plugin column* needs a value for every item in the view. The host fetches them in the background in batches of up to 1000 keys, caches them, and sorts itself or passes the sort keys to the core. Zotero calls the provider inside the comparison function, which is O(n log n) calls. Here it is n/1000 calls.
4. *Drag and drop* is declared (`accepts`, `extensions`, `enabled-when`) so the host highlights targets without asking. The plugin is called once, at drop. The same is true for the drag-out format: one call at drag start.
5. *Events are opt-in and debounced.* `subscribe-events` turns on selection, view, tab and theme events. Selection and view events are limited to one call per 100 ms. Plugins that do not subscribe cost nothing.

**Contexts carry keys, not objects.** Zotero's menu context has `Zotero.Item` objects. Here `context.items` is a list of item keys (at most 2000, with the real count and a `list-selected-items` pager), and the plugin reads fields with `library.wit` in one batch. This keeps a context cheap to send even when the user selects 50,000 items.

**Content is the `ui` area's job.** A section body, a tab, a side panel or a custom pane row is a view mounted through `ui-events`. That removes `onRender`, `onAsyncRender`, `onInit`, `onDestroy`, `onToggle`, `setEnabled`, `setL10nArgs`, `setSectionSummary` and `setSectionButtonStatus` from `extend`, because `ui-events` and `render-result.meta` already have them. `extend` only says where a view goes and when it is enabled.

**Lazy updates for collapsed sections.** Zotero calls `onItemChange` on every section for every selection. With N plugin sections that is N calls per click. In Zinc a collapsed section is updated only when the user expands it, unless the plugin set `decides-enabled`. Most sections use `enabled-for` and need no call at all while the item is irrelevant.

**Nothing waits for the user.** In `extend`, no function stays open while the user decides something. Dialogs belong to `ui`, which offers both a waiting call (`run-dialog`) and a non-waiting one (`open-dialog`). The waiting form depends on the host being able to deliver `ui-events` to the plugin while the plugin is suspended in an import. That is not yet tested (see open question 1).

**Preference panes are mostly declarative.** A `rows` pane has no code: the host draws toggles, text, number, choice and button rows in Zinc's settings style, bound to the plugin's prefs, with Zinc's settings search and enabled/visible rules from other prefs. `view` panes and `custom` rows give full control. Secret text fields are stored by the host with the plugin's secrets. This replaces XUL `preference=` bindings and per-pane scripts, which were the largest part of most Zotero plugins' preference code.

**Shortcuts are commands, not key listeners.** A plugin registers a named command with a default chord. Zinc already has Settings > Shortcuts with rebinding (`shell/bindings.ts`), so the plugin's commands appear there. There is no raw key event for plugins. A plugin that needs every key press in its own text area gets those through `ui` events.

**Permissions.** Nothing in `extend` needs a permission except the ones below. Registering UI is allowed for every plugin. All of these ids are in `manifest.schema.json`, and `extend.wit` lists them in its header:
- `ui.windows` for `ui.open-window` (already in `ui.wit`) and for `open-tab` and `register-side-panel`, because both put plugin content in the main window.
- `ui.drop` for `register-drop-target` and `register-drag-format`, because the drop payload hands the plugin file tokens.
- `ui.navigate` for `select-items`, `select-row`, `set-search`, `open-item`, `set-panel-visible` and `open-settings`, which change what the user sees.
- Reading the selection (`get-context`, handler contexts, `list-selected-items`, `list-view-items`) needs `library.read`, because it reveals which items the user selected.

**Rust and JS ergonomics.** All records use `option`, `list`, `enum` and `flags` only. No resources and no recursion (menus and preference rows use a flat list with a parent id). A JS plugin sees plain objects; a Rust plugin sees structs. Fields that are almost always empty (`visible-when`, `icon`) are `option`s, so a guest SDK can offer builder functions with defaults. A guest SDK can also wrap `register-menu` plus `on-menu-command` into one `menu.add({ id, label, onCommand })` call and keep the handler table itself.

**Static declaration (proposal).** Registrations that need no code to be created (menus, columns, section headers, preference rows, toolbar buttons, shortcuts) could also be written in the manifest, as the same records in JSON. Zinc could then show a plugin's menu items and columns before the plugin's wasm is loaded, and load it on first use. This is `lifecycle`'s file (`manifest.schema.json`); see open question 3.

## 3. Open questions for the user

1. **Re-entrancy in the plugin host.** `ui.run-dialog` and similar calls suspend the plugin inside a host import (JSPI) while the user answers, and the host must call `ui-events.on-event` for the dialog's own buttons during that time. Does jco let the host call another export of the same instance while one is suspended in an async import? If not, `ui` must drop its waiting calls and use `open-dialog` plus an event, and a guest SDK wraps that into an awaitable. Phase 2 spike needed before this is fixed.
2. **Where do the other five menubar targets go?** Decided 2026-11-18: phase 2 adds a real File / Edit / View / Go / Help menubar; the overflow "Plugins" menu is only the fallback until it exists.
3. **Manifest `contributes` for lazy loading.** Should menus, columns, section headers and preference rows be declarable in the manifest so a plugin loads only when used? It saves start-up time and memory for plugins with many entries. The cost is two ways to say the same thing.
4. **Section visibility in the reader.** Do plugin item-pane sections appear in a reader tab's side panel? Zotero shows them there (`tabType` is `reader`), and many plugins (translation, reference tools) depend on it. Decided 2026-11-18: yes, sections and the `notes-add-*` menus appear in reader tabs (host work in phase 2).
5. **Virtual collections.** Decided 2026-11-18: yes, plugin-supplied rows in the collection tree are in v1.
6. **How far to go with cells.** The `cell-body` set (text, icon, bar, rating, chips) covers what common plugins draw. Is it enough, or should a cell be allowed a small `ui.tree` (a mini view, rendered per row)? A tree per cell is much more expensive for the host, and I recommend not allowing it.
7. **Banners.** Zotero's banners are internal. Worth keeping a tiny public API, or should plugins use toasts only?

## 4. Needs from other areas

Resolved in the reconcile of 2026-11-18 (see README):

- `extend.wit` has no placeholder types. Its views are `ui.view-context` and `ui.render-result` through `ui-events.mount`, `update-context`, `unmount`, `visibility` and `on-event` (the one event entry point; a section header button press is `kind: press` with `handler` = the button id). Dropped files are `types.file-grant`s. Dialogs, prompts, alerts, windows and toasts are only in `ui`; there is no copy here. File pickers, clipboard and opening a URL are `fs.pick-*`, `clipboard` and `shell.open-url`.
- `ui.surface` has `item-pane-section`, `tab`, `side-panel`, `preferences-pane`, `toolbar-slot` (and `popover`, `reader-sidebar`, `reader-overlay` for the reader). `info-row` was removed from it (info rows are plain text values). `ui.window-kind` was removed: `ui.open-window` makes OS windows only; tabs and side panels are `open-tab` and `register-side-panel`. `ui.theme-mode` stays in `ui`.
- `library.get-summaries(keys, fields, expand, include-trashed)` is the batch "get items by keys with a field list" that `on-column-values`, `on-row-styles` and the menu `context` readers use.
- Selection, view, tab and theme events are delivered only by `subscribe-events`; the notifier has no `tab`, `itemtree`, `itempane` or `infobox` types.
- Permission ids `ui.windows`, `ui.drop`, `ui.navigate` and `library.read` are in the manifest schema.
- `themed-icon` stays in `extend.wit`: only extend uses it (ui and reader take a single `icon-ref`).
- `tab-ref.kind` "reader" with subtypes "pdf", "epub", "snapshot" are the names of `reader.reader-kind`; `condition.tab-kinds` entries "reader/pdf" and so on follow them. Reader menus honour `static-menu` entries' `visible-when` and `enabled-when` against the reader tab's context, and use `reader-events.on-menu-command`, not `extend-handlers.on-menu-command`. A `register-shortcut` with `scope: reader` is delivered with a `context` whose `tab` is the reader's tab (`reader.selected-reader` reads it).

Still open:

- **ui: close all toasts and a "choose from a list" prompt** would complete rows 103 and 105 (both small). Open.
- **ui: row-style data on table nodes.** Item list and table nodes could accept `row-style`-like data so a plugin table uses the same cell kinds as `extend.cell`. Optional. Open.
- **reader: sections in reader tabs.** Decided 2026-11-18: Zinc's reader tab shows plugin item pane sections and the `notes-add-*` menus (rows 16, 50, 126). The WIT supports it (`view-context.params.tabType` is `reader`); the host builds it in phase 2.
- **Menu targets `reader/menubar/*`, `notesPane/*`, `main/tab`**: `menu-target` has `tab` and `notes-add-*`; `reader/menubar/*` is deprecated in Zotero and stays not planned (row 48).
- **lifecycle: manifest `contributes`** for static menus, columns, section headers and preference rows (open question 3). Open.
