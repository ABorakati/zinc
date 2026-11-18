# Plugin UI: the declarative tree

Area: `ui`. Files: `plugin-api/wit/ui.wit` (interfaces `ui` and `ui-events`), `plugin-api/ui-schema/ui-tree.schema.json`.

A Zotero plugin builds UI with the DOM, XUL, Zotero's custom elements (`chrome/content/zotero/elements/`, 56 files) and CSS. A Zinc plugin cannot touch a DOM. It returns a UI tree as data. The host renders it with Zinc's own GPUIX/Solid components (`gpui-ui/src/ui/`: Button, TextInput, Select, Checkbox, Switch, Tabs, Resizable, menus, dialogs, popovers; tokens in `theme.ts`) and sends events back as calls with a handler id.

## Summary of the design

- **Trees are JSON (phase 3).** The phase 2 flat WIT tree (`nodes: list<node>` with child indices) is gone: WIT forbids recursive types and the typed style records made Rust builds take minutes. A tree, a patch set, a row's or cell's custom content and styles are JSON strings, specified by `plugin-api/ui-schema/ui-tree.schema.json` (`$defs.tree`, `patchSet`, `rowContent`/`node`, `style`, `namedStyles`). Every node has an optional `key` for identity. The text below that says "flat" or lists WIT node records describes the same shape as the schema's node kinds.
- **One spelling.** Both SDKs build the JSON form (JS nested objects, Rust `serde` builders); the host validates it against the schema (`full` mode in tests and debug builds, `cheap` in release).
- **Events are handler ids.** Any node carries `events: list<event-binding>`. The plugin gets `ui-events.on-event(instance, ui-event)` and returns the next `render-result`. Debounce, throttle and key filters are part of the binding, so the host only calls the plugin when it must.
- **Host-kept state, plugin-owned values.** Text being typed, scroll, selection and open/closed state live in the host. A plugin-supplied value (`value`, `open`, `selected`, ...) is applied only when it differs from the last value the plugin sent. To force a reset to the same value, change the node's `key`.
- **Updates.** Default is "return the whole tree" (the host diffs by key, so GPUIX only touches what changed). Big trees can send `patch-set`s. Big lists are pulled: the host asks for row ranges.
- **Style is tokens plus a small set of raw values, not CSS.** Theme tokens, light/dark color pairs, spacing scale, named styles, hover/pressed/focus states. Plugins can contribute colors to Zinc's own theme (`set-theme-override`).
- **Drawing:** a vector `canvas` draw list. **Web content:** a sandboxed `web-view` node (permission, count limit). **Zinc's own components:** an `embed` node (note editor, item box, tags box, pickers).

## Process boundary and cost

All calls cross into the plugin host process (spike: about 50 µs per round trip, plus lowering of the arguments). The rules that follow from that:

| Situation | What happens |
|---|---|
| Typing in a field | Host keeps the text. `change` (commit) is the default event. `input` is opt-in with `debounce-ms`. |
| Hover, scroll, resize, drag of a split or column | Host only. Events exist but are opt-in and throttled. |
| Canvas pan/zoom | Host transforms the draw list itself (`pan-zoom`); `view-changed` is throttled. Shape hit-testing and hover tips run in the host (`hit`, `hover-tip`). |
| Table with 50,000 rows | `rows-source.virtual`: host calls `render-range` for the visible window plus overscan, a few times per second at most. |
| Autocomplete | Local `items` need no call; `dynamic` calls `suggest` after `debounce-ms`. |
| Preference pane control | `node-props.pref` binds to a plugin pref with no call. |
| Async result (network answer) | Plugin calls `ui.push(instance, result)`. |
| Stale events | Events carry `rev`; the plugin can ignore events for a tree it already replaced. A patch with the wrong `base-rev` is dropped and the host calls `resync`. |

Estimate (not measured): a 300-node tree is a few tens of KB lowered; one `mount`/`on-event` round trip stays well under a millisecond plus the plugin's own work. A hung plugin is killed with the plugin host process; its views show a "plugin not responding" placeholder.

## What plugins build in practice

Taken from Zinc's Zotero-plugin test corpus (`docs/developer-guide/zotero-plugins.md` in the zotero-plugins worktree: make-it-red, linter, pdf-translate, reference, actions-tags, better-notes) and from Zotero's plugin APIs (`itemPaneManager.js`, `menuManager.js`):

- Item pane sections with a header, buttons and a body: lists of references, translated titles, relation graphs, backlinks (reference, pdf-translate, better-notes).
- Settings panes: checkboxes, text fields, dropdowns, sections, tables with editable rows, icon buttons, preference bindings (linter, actions-tags, reference).
- Menu items and submenus, some dynamic (`onShowing`).
- Dialogs with forms and buttons; progress windows; prompts; command-palette overlays (zotero-plugin-toolkit `Prompt`).
- A virtualized table (actions-tags), item and collection pickers (better-notes), a note editor (better-notes), a relation graph (better-notes).
- CSS that recolors or hides parts of Zotero (make-it-red, many small plugins).
- Embedded web pages (a few plugins; translation and AI-chat panels).

## 1. Parity table: elements and APIs plugins use

Status is the last column.

| Zotero capability (source) | Zinc WIT | Status |
|---|---|---|
| `button`, `html:button`, `toolbarbutton` (XUL/HTML) | `node-kind.button` (`look`, `size`, `icon`, `pressed` toggle, `loading`) | covered |
| `checkbox`, `input[type=checkbox]` | `checkbox` (with `indeterminate`) | covered |
| `moz-toggle` / switch | `switch` | covered |
| `radiogroup`, `radio` | `radio-group` | covered |
| `menulist`, `menupopup`, `menuitem`, `html:select` | `select` (groups, search, multiple) | covered |
| `html:input` text/search/password, `textbox`, `search-textbox`, `quick-search-textbox`, `query-textbox` | `text-input` (`kind`, `clear-button`, `suggest`) | covered |
| `html:textarea` | `text-input` with `multiline`, `min-rows`, `max-rows` | covered |
| `input[type=number]` | `number-input` | covered |
| `input[type=color]`, `color-picker` (`elements/colorPicker.js`) | `color-input` with `swatches` | covered |
| `input[type=range]` | `slider` | covered |
| `input[type=date/time]` | `date-input` | covered |
| `input[type=file]`, `FilePicker` | `fs.pick-open`, `fs.pick-save`, `fs.pick-directory` (lifecycle; the ui area has no file dialogs). A `button` press calls them. Results are `types.file-grant`s, never paths; `fs.read` and `fs.write` turn a grant into bytes | covered |
| `hbox`, `vbox`, `box`, `html:div` | `box` with `style.direction`, `gap`, `align-items` | covered |
| `grid`, `rows`, `columns`, `row` | `grid` (`columns`, `rows`, spans in `style.grid-column`) | covered |
| `scrollbox`, `overflow: auto` | `scroll` (`scroll-to`, `stick-to-end`) | covered |
| `splitter` | `split` (`sizes`, `min-sizes`, `persist-key`, `collapsible`) | covered |
| `tabbox`, `tabs`, `tab`, `tabpanels` | `tabs` (`keep-alive`, `closable`, `badge`) | covered |
| `deck` | `deck` | covered |
| `groupbox`, `caption` | `group` | covered |
| `html:details`/`summary`, `collapsible-section` (`elements/collapsibleSection.js`) | `section` (`open`, `summary`, `count`, `buttons`, `persist-key`) | covered |
| `label`, `description`, `html:span`/`p`/`h1`-`h6` | `text` (kinds, runs with bold/italic/mono/links) | covered |
| `html:a`, `zotero-text-link` (`elements/textLink.js`) | `link`, or a link run in `text` | covered |
| `html:img`, `image` | `image` (asset, PNG/JPEG bytes, SVG rasterized, attachment thumbnail) | covered |
| icons in `-moz-context-properties` style (`icon`/`darkIcon`) | `ui-icon` = `icon-ref` (builtin, bundled with `-dark` variant, svg), `icon` node | covered |
| `html:progress`, `progressmeter` | `progress` (bar, ring, spinner) | covered |
| `separator`, `spacer`, `toolbarseparator` | `separator`, `spacer` | covered |
| `toolbar`, `toolbarbutton` groups | `toolbar` (`overflow`) | covered |
| `richlistbox`, `richlistitem`, `richlistcheckbox` (`elements/richlistCheckbox.js`) | `list-view` with custom row content (`row.content`) | covered |
| legacy `listbox`, XUL `tree` | `list-view` / `table` with `tree: true` | covered |
| `VirtualizedTable` (React, used by actions-tags, better-notes pickers) | `table` with `rows-source.virtual` and `ui-events.render-range` | covered |
| `html:table` | `table` | covered |
| `menupopup` as context menu, `contextmenu` attribute | `node-props.context-menu`, `ui.popup-menu` | covered |
| `panel`, `popup`, `html:dialog` anchored panels | `popover` node (placement, arrow, dismiss) | covered |
| `tooltip`, `tooltiptext`, `title` | `node-props.tooltip` (text) | partial (plain text only; no rich tooltip content) |
| `html:canvas` 2D | `canvas` (vector draw list, hit testing, pan/zoom) | partial (no per-pixel drawing, no WebGL; see Canvas) |
| `html:iframe`, `xul:browser` | `web-view` (sandbox, host allow-list, messaging) | partial (permission, count limit, placed over the UI; see Web content) |
| `innerHTML`, `bodyXHTML` (`itemPaneManager.js`) | `rich-text` `html-subset` and `markdown` | partial (safe subset; no scripts, styles, forms, iframes) |
| Plugin-defined `customElements.define` | Plugin functions that build node subtrees; named styles for reuse | not planned (needs a DOM; a function returning nodes does the same job) |
| Direct DOM edits of Zotero's own windows (`getElementById`, `insertBefore`, `appendChild` into `zotero-items-tree`) | Extension points in `extend` (sections, menus, columns, toolbar slots) | not planned (Zinc's UI is native GPUIX, not DOM; the corpus shows this cannot work) |
| Inline and linked CSS for the plugin's own UI (`style=""`, `<style>`, `<link>`) | `style`, `named-style`, `state-styles`, color tokens and `themed-color` | partial (no selectors, cascade only for text; see Styling) |
| CSS that recolors Zotero (make-it-red) | `ui.set-theme-override` (token colors, light and dark) | partial (colors only, user can switch off) |
| CSS that hides, resizes or reflows built-in Zotero UI | none | not planned (arbitrary restyling breaks native components; use `extend` to hide registered items, theme tokens for color) |
| CSS animations, `@keyframes`, transitions | `icon.spin`, `progress`, `skeleton`; the host animates its own state changes | partial |
| `@font-face`, custom fonts | `font-family` is sans, title or mono | not planned (v1; see open questions) |
| DOM events: click, dblclick, contextmenu, input, change, keydown/up, focus, blur, scroll, mouseover/out, resize | `event-kind` + `event-binding` (debounce, throttle, key filter) | covered |
| `submit` of a form | `form` node, `submit` event with `form-field` list | covered |
| Drag and drop (`dragstart`, `drop`, `Zotero.DragDrop`) | `draggable`, `drop-target`, `drop` event (items, text, files as `types.file-grant`, custom) | partial (no drags out to the OS, no arbitrary MIME types) |
| `focus()`, `tabindex`, `autofocus` | `auto-focus`, `render-result.focus`, `ui.focus`, `a11y.tab-index` | covered |
| `aria-*`, `role` | `a11y` record on every node | covered |
| `data-l10n-id`, `.ftl`, `Zotero.getString` | `ui-text` = `localized-string` (Fluent id and args resolved by the host, so locale changes need no call) | covered |
| `dir="rtl"`, logical CSS | `edges.start/end`, `theme-info.rtl`, host mirrors layout | covered |
| `navigator.clipboard.writeText`, `copyTextToClipboard` | `clipboard.write` (lifecycle; the ui area has no clipboard calls) | covered |
| `navigator.clipboard.readText` | `clipboard.read` (lifecycle; permission `clipboard.read`) | covered |
| `Zotero.launchURL`, `openLink` | `shell.open-url` (lifecycle; a `link` node with a `url` target needs no call) | covered |
| `Services.prompt.alert`/`confirm`/`prompt`, `Zotero.alert` | `ui.alert`, `ui.confirm`, `ui.prompt` | covered |
| `Services.prompt.confirmEx` (up to 3 buttons, checkbox) | `ui.confirm` (checkbox) or `ui.open-dialog` (any buttons; the pressed button arrives as a `close` event) | covered |
| `window.openDialog` with plugin XHTML, zotero-plugin-toolkit `Dialog` | `ui.open-dialog` (answer in the `close` event), `update-dialog`, `close-dialog`, `dialog-spec` | covered |
| `Zotero.ProgressWindow` and toolkit `ProgressWindowHelper` | `ui.show-toast`, `update-toast`, `close-toast` (lines with progress, actions) | covered |
| Plugin windows (`window.open`, `openWindowByType`) | `ui.open-window` (an OS window; permission `ui.windows`; returns `result`) | covered |
| Custom main tabs (`Zotero_Tabs.add` content) | `extend.open-tab`: the tab content is a `ui` view with `surface.tab` (`ui.window-kind` was removed so there is one way to make a tab) | covered |
| Command palette / overlay (toolkit `Prompt`, DOM in main window) | `popover` or `open-window` with a `text-input` + `list-view`; global shortcut in `extend` | partial (no overlay above the whole window; a modal dialog is the nearest) |
| `Zotero.PreferencePanes.register` XHTML with `preference="..."` | `surface.preferences-pane` view; `node-props.pref` binds controls to plugin prefs with no call | covered |
| `ItemPaneManager.registerSection`: `onInit`, `onItemChange`, `onRender`, `onAsyncRender`, `onToggle`, `onDestroy` | `ui-events.mount`, `update-context`, `visibility`, `unmount`; async work uses `ui.push` | covered (registration is in `extend`) |
| Section hook args `setL10nArgs`, `setEnabled`, `setSectionSummary`, `setSectionButtonStatus`, `refresh` | `render-result.meta` (`view-meta`), `ui.refresh` | covered |
| Section `header` (icon, l10n), `sidenav`, `sectionButtons` (`onClick`) | registration in `extend`; button presses arrive as `press` with the button id; states via `view-meta.buttons` | partial (registration shape is `extend`'s) |
| `ItemPaneManager.registerInfoRow` (custom Info row: label, editable value) | `extend.register-info-row`, `on-info-row-get`, `on-info-row-set` (plain text values; `ui.surface.info-row` was removed, there is no view for a row) | covered |
| `MenuManager.registerMenu` `MenuData` (`menuType` menuitem, separator, submenu; `l10nID`, `icon`, `darkIcon`, `menus`) | `ui.menu`, `menu-item` (adds check, radio, heading, danger, hidden) | covered |
| `MenuData` hooks `onShowing`, `onShown`, `onHiding`, `onHidden`, `enableForTabTypes`; targets such as `main/library/item` | registration and hooks in `extend`; `menu` is the data they return | partial |
| Reader panels, toolbars, popups (reader plugin events) | `surface.reader-sidebar`, `reader-overlay` views; events in `reader` | partial (owned by `reader`) |
| Zotero's own item pane header and Info fields editable by plugins | none | not planned (native components; use `embed.item-box` for a copy) |

## 2. Parity table: every file in `chrome/content/zotero/elements/`

| Zotero element (file) | Zinc equivalent | Status |
|---|---|---|
| `abstractBox.js` (`abstract-box`) | `embed` `abstract-box` | covered |
| `advancedSearchDeck.js`, `advancedSearchPane.js`, `zoteroSearch.js` (`zoterosearch`, `search-condition-group`, `zoterosearchcondition`, `zoterosearchtextbox`, `zoterosearchagefield`) | `embed` `search-builder` (search JSON in and out) | covered |
| `annotationItemsPane.js`, `attachmentAnnotationsBox.js` | `embed` `attachment-annotations` | partial (read-only list in v1; reader surface is `reader`'s) |
| `annotationRow.js`, `noteRow.js`, `attachmentRow.js` | Compose with `list-view` rows and `text`/`icon`/`button` | covered |
| `attachmentBox.js`, `attachmentsBox.js` | `embed` `attachments-box` | covered |
| `attachmentPreview.js`, `attachmentPreviewBox.js` | `embed` `attachment-preview`; or `image` `attachment` thumbnail | covered |
| `autocompleteTextArea.js`, `shadowAutocompleteInput.js` | `text-input` with `suggest` | covered |
| `base.js` (`XULElementBase`, framework class) | Not a component | not planned (framework base class for Zotero's own elements; no equivalent needed) |
| `bubbleInput.js` (`bubble-input`) | `token-input` | covered |
| `collapsibleSection.js` | `section` | covered |
| `colorPicker.js` | `color-input` | covered |
| `contextNotesList.js`, `contextPane.js`, `notesContext.js` (reader context pane) | `surface.side-panel` / `reader-sidebar` views | partial (reader area owns the panel) |
| `duplicatesMergePane.js`, `mergeGroup.js` (`merge-group`, `merge-pane`) | Build from `table` and `radio-group`; merging through the library interface | partial (no ready-made merge UI) |
| `editableText.js` (`editable-text`) | `text-input` with `look: inline` | covered |
| `fileRenamingSettings.js` | Built-in settings control | not planned (specific to Zotero's own file-renaming preference; a plugin builds its own from controls) |
| `guidancePanel.js` | `popover` with `arrow` (anchored to a plugin node) | partial (cannot point at Zinc's own built-in elements) |
| `itemBox.js` (`info-box`) | `embed` `item-box` | covered |
| `itemDetails.js`, `itemPane.js`, `itemPaneContainerBase.mjs`, `itemPaneSectionElementBase.mjs`, `itemPaneCustomSection.js`, `itemPaneHeader.js`, `itemPaneSidenav.js`, `itemMessagePane.js` | Item pane host; plugin body is a view; registration in `extend` | partial (frame and sidenav are Zinc's own; `callout` replaces `item-message-pane` for in-body messages) |
| `itemTreeMenuBar.js` | Menu registration in `extend` | partial |
| `librariesCollectionsBox.js` | `embed` `libraries-collections-box` | covered |
| `libraryView.js` (`library-view`) | `embed` `collection-picker` | covered |
| `menulistItemTypes.js` (`menulist-item-types`) | `select` filled with item types from the library interface | covered |
| `noteBox.js`, `notesBox.js`, `relatedBox.js`, `tagsBox.js` | `embed` `notes-box`, `related-box`, `tags-box` | covered |
| `noteEditor.js` (`note-editor`, `links-box`) | `embed` `note-editor` | partial (the host offers its note editor with item key and read-only; no access to editor internals, so better-notes' deep editor patching is not possible; plugin uses `reader`'s `note-editor` interface) |
| `publicationsLicenseInfo.js` | Content for My Publications | not planned (Zinc has no My Publications; `rich-text` shows any license text) |
| `queryTextbox.js`, `quickSearchTextbox.js`, `searchTextbox.js` | `text-input` `kind: search` | covered |
| `richlistCheckbox.js` | `list-view` row with a `checkbox` | covered |
| `splitMenuButton.js` | `button` with `menu` and `menu-mode: split` | covered |
| `styleConfigurator.js` (`locale-selector`, `style-selector`, `style-configurator`) | `embed` `style-picker`; `select` for locale | covered |
| `tabContent.js`, `tabsMenuPanel.js` | Main tab strip | not planned (Zinc's own chrome; plugins add tabs through `extend`/`open-window`) |
| `utils/collapsiblePane.mjs` | Internal helper | not planned (implementation detail of `section`) |

Counts for this area, tallied by script over both tables above: 102 rows; **covered 73, partial 19, not planned 10**.

## 3. Node component reference

| Node kind | Main fields | Events it can fire | GPUIX base | Zotero equivalent |
|---|---|---|---|---|
| `box` | style only | press, hover, focus, key, drop, context-menu | `div` | hbox, vbox, div |
| `grid` | `columns`, `rows`, gaps | as box | `div` grid | grid |
| `scroll` | `axis`, `scroll-to`, `stick-to-end` | scroll | scroller | scrollbox |
| `split` | `orientation`, `sizes`, `min-sizes`, `persist-key` | resize | `Resizable` | splitter |
| `tabs` | `tabs`, `selected`, `look`, `keep-alive` | change (tab key), close | `Tabs` | tabbox |
| `deck` | `selected` | none | switch | deck |
| `section` | `title`, `open`, `summary`, `buttons` | toggle, press (button id) | `itempane/kit` `Section` | collapsible-section |
| `group`, `card` | `caption` | none | `div` | groupbox |
| `toolbar` | `overflow` | none | `div` | toolbar |
| `text`, `link` | `kind`, `runs`, `target` | press (link) | `text` | label, description, a |
| `image`, `icon` | `source`, `fit`, `alt`; `icon`, `spin` | press | `img`, `svg` | img, image |
| `progress`, `badge`, `callout`, `skeleton` | `value`, `tone`, `dismissible` | close | custom | progressmeter, item-message-pane |
| `rich-text`, `code` | `format`, `source`; `language` | press (link handler) | markdown renderer | innerHTML, pre |
| `button` | `look`, `size`, `pressed`, `menu`, `loading` | press, context-menu | `Button` | button, toolbarbutton, split-menu-button |
| `checkbox`, `switch`, `radio-group` | `checked`/`on`/`value` | change | `Checkbox`, `Switch` | checkbox, radiogroup |
| `select` | `options`, `value`, `multiple` | change | `Select` | menulist |
| `text-input` | `value`, `kind`, `look`, `multiline`, `suggest` | input, change, submit, focus, blur, key | `TextInput` | textbox, textarea, editable-text |
| `number-input`, `slider`, `color-input`, `date-input` | value, ranges | input, change | custom | input types |
| `token-input` | `tokens`, `suggest`, `allow-new` | change | custom | bubble-input |
| `form` | `busy` | submit | `div` | form |
| `list-view` | `rows`, `selection`, `selected` | select, activate, press, context-menu, drop, scroll | virtual list | richlistbox |
| `table` | `columns`, `rows`, `sort`, `tree` | select, activate, sort, resize, toggle, context-menu, drop | `table/Table` | VirtualizedTable |
| `popover` | `open`, `placement`, `arrow` | close | `Popover` | panel, popup |
| `canvas` | `ops`, `pan-zoom`, `view` | press, pointer-*, wheel, view-changed | custom paint | html:canvas |
| `web-view` | `source`, `sandbox`, `allow-hosts` | message, web | `webview/` host | iframe, browser |
| `embed` | `component`, `params` | embed, change | native Zinc components | Zotero custom elements |

Every node also has `key`, `name`, `pref`, `class`, `style`, `states`, `a11y`, `tooltip`, `context-menu`, `disabled`, `hidden`, `draggable`, `drop-target`, `auto-focus`.

## 4. Design notes

### Flat node list, and why

A recursive `node` is illegal in WIT. The options were (a) a JSON string (what the spike did), (b) a flat list with child indices, (c) a resource per node. (c) turns every node into a boundary call. (a) loses typing, so errors show at run time and nothing validates in Rust. The flat list keeps a typed contract, crosses the boundary once, and is easy to diff because the host builds the keyed tree from it. The nested JSON form is kept as a convenience, with a schema, because it is the natural thing for JS and for tools that generate UI. Node order does not matter except for children; a node used by two parents is an error.

### Identity, state and two-way binding

- `key` names a node across renders. Without it, identity is position among siblings.
- The host owns edit state. Controlled values follow the "apply only when the plugin's value changed" rule, so a re-render triggered by something else never overwrites what the user is typing.
- `form` + `name` gives one `submit` event with all values; `ui.form-values` reads them at any time; the dialog's `close` event (kind `form`) delivers them when it closes.
- `pref` gives zero-call binding for preference panes.

### Updates

1. `mount`, `update-context` and `on-event` each return a `render-result` (`content-update`): `unchanged`, `json` (a whole tree) or `patch` (a JSON patch set). One call, whole answer.
2. `patch-set` ops: `set-node`, `replace`, `insert`, `remove`, `move`, `set-styles`, all by key. Use them when a tree is large and a change is small (a table cell, a log line).
3. The host always diffs; patches only save serialization.
4. Async work calls `ui.push`. The host batches pushes per frame.
5. `view-meta` replaces Zotero's section helper calls (title args, enabled, summary, button status).

### Large lists

`rows-source.virtual` gives a row count and a row height. The host calls `render-range(start, count)` for the window plus `overscan`. Sorting is a request parameter (`range-request.sort`), so the plugin sorts, not the host. Tree tables expose only visible rows: on `toggle` the plugin returns a new count and the host re-requests. Inline rows (up to a few hundred) can be sorted by the host from `cell.sort-value`.

### Styling and "full customization" without CSS

Plugins get: layout (flex, grid, absolute), size, spacing on a 4 px scale, colors from theme tokens (the names in `theme.ts`), eight categorical palette colors, fixed colors per mode (`themed-color`), border, radius, shadow, opacity, font size/family/weight, text wrap and clamp, cursor, hover/pressed/focus/disabled/selected states, named styles for reuse. Icons are built-in names, bundled SVG/PNG (with `-dark` variants) or inline SVG. Raster pictures are `image` nodes.

Limits: no selectors, no descendant rules, no `calc`, no transforms outside `canvas`, no pseudo-elements, no custom fonts, no z-order above host chrome, no styling of built-in Zinc controls. Text properties inherit; everything else does not.

How Zotero plugins inject CSS today and what covers each case:

| Use | Covered by |
|---|---|
| Style the plugin's own pane, dialog or section | `style`, `named-style`, `states` (covered) |
| Light and dark variants of its own colors | `color-token`, `themed-color` (covered) |
| Recolor the whole app (make-it-red) | `set-theme-override` with `ui.theme` permission (covered for colors) |
| Change fonts, density, row height of built-in lists | not available; Zinc's own appearance settings do this |
| Hide or move built-in buttons and rows | not available; `extend` can hide only what a plugin registered |
| Icons for toolbar and menu items | `icon-ref` bundled/svg (covered) |

`set-theme-override` shows in Settings > Plugins with a switch; with several plugins the last enabled wins per token.

### Canvas

Choice: a vector draw list (`canvas.ops`: rect, ellipse, line, polyline, path, text, image, groups) plus `image` nodes for rasters.

- GPUIX's `<svg>` paints only an alpha mask (one color), so "return an SVG string" cannot draw a colored chart. An `image` node with SVG source is rasterized by the host in full color and covers static pictures.
- Interactive graphs (better-notes' relation graph, citation networks, timelines) need hit-testing and pan/zoom. With raster bytes, every hover would be a round trip. With a draw list, the host tests `hit` shapes, shows `hover-tip`, and pans and zooms with no calls; the plugin hears `press`, `pointer-*` and `view-changed`.
- Text size: `ui.measure-text` batches measurements for label layout.
- Cost: a draw list of 10,000 ops is lowered per update; use `patch` or fewer ops (polylines with flat `points`).
- Not offered: per-pixel drawing, WebGL, offscreen canvases. A plugin that needs them renders to PNG in WASM and shows an `image`, or uses `web-view`.

### Web content

Zinc's `gpui-ui/src/webview/` is WebView2 in its own owned popup window placed over a placeholder (GPUIX has no web element), about 100-200 MB per instance, created only when used. So `web-view` is offered with these limits, enforced by the host:

- Permission `ui.webview`; the manifest lists `net` hosts. `allow-hosts` must be a subset.
- At most 2 live views per plugin and 4 in total; a view that is hidden or scrolled out is released and reloaded when shown (state is lost unless `persist-storage`).
- Own WebView2 profile per plugin (cookies and storage separate from Zinc and other plugins).
- `html` and `asset` sources come from an opaque per-plugin origin with a strict content security policy: no network except `allow-hosts`, no `file:`, no access to Zinc's local server ports.
- No `eval` from the plugin. Communication is `window.zinc.postMessage` / `web-post-message` JSON only.
- It is drawn above GPUIX content: popovers and menus over it are cut (the host cuts holes for toasts as it does today). Do not place a popover over a web view.
- Navigation outside the allow-list is blocked and reported as a `web` event; the plugin may then call `shell.open-url`.
- Not available in Zinc builds without WebView2 (`webViewSupported()` false); `theme-info`/lifecycle features list reports it.

### Host components (`embed`)

Plugins such as better-notes embed Zotero's own elements. `embed` draws Zinc's native equivalents with the plugin's data: note editor, item box, tags, related, attachments, notes, attachment preview and annotations, item and collection pickers, search builder, style picker. Each needs the matching library permission (read for display; write for editing components). Parameters are JSON so components can grow without a WIT change. Events return as `embed` with a JSON payload.

### Accessibility and localization

Every node has an `a11y` record. Defaults come from the component (a `button` is a button). Icon-only buttons must set `a11y.label`; an `image` needs `alt` or `a11y.hidden`. `ui-text.localized` is resolved by the host against the plugin's Fluent files and the current locale, so a locale change re-resolves text with no plugin call. Layout uses `start`/`end` and mirrors for right-to-left locales.

### Rust and JS ergonomics

All records have many optional fields. Rust guests are expected to use an SDK of builders (phase 2). JS guests use the JSON form, where options are just missing keys and enums are strings. Both end in the same flat tree.

### Host limits (proposed, to be set in phase 2)

| Limit | Value |
|---|---|
| Nodes per tree | 5,000 (inline rows count; use virtual rows beyond that) |
| Tree depth | 64 |
| Draw ops per canvas | 20,000 |
| Image bytes per node | 4 MB; 32 MB per plugin in total |
| Update rate | at most 30 `push` per second per instance; extra pushes are merged |
| `on-event` / `render-range` time limit | 1 s, then the last good tree stays and the plugin is flagged |
| Open dialogs | 1 modal, 3 modeless per plugin |

## 5. Open questions for the user

1. Is `set-theme-override` (colors from plugins) wanted, or should plugins never touch Zinc's global look?
2. Custom fonts from the plugin package: allow in v1 (needs GPUIX font loading per plugin) or leave out?
3. `web-view` caps (2 per plugin, 4 total) and the "drawn above everything" behavior: acceptable?
4. Should `embed.note-editor` offer edit access to plugins, or read-only first?
5. Should the JSON form be the only form given to JS guests (smaller SDK), with the typed form for Rust only?
6. Drag and drop to the OS (files out of Zinc) from plugin UI: allow or not?

## 6. Needs from other areas

Resolved in the reconcile of 2026-11-18 (see README):

- **Colour:** there is one colour type, `types.color` (token, token with alpha, fixed, pair per mode), with `types.color-token`, moved from this file; extend uses it, `ui-tree.schema.json` documents its JSON form.
- **Permission ids:** `ui.webview`, `ui.windows`, `ui.theme` (and `ui.drop`, `ui.navigate` from extend) are in the manifest schema; `ui.clipboard-read` and `ui.file-dialogs` were removed with the calls they guarded. `world.wit` imports `ui` and exports `ui-events`. The features list names `ui.webview` and `ui.embed.<component>`.
- **Extend:** extend has no placeholders; it registers views and calls `ui-events.mount`, uses `ui.render-result`, `ui.ui-event` and `ui.form-field` and one `on-event` entry point. Dialogs and prompts have one owner (this area); extend refers to it. Menu data is `ui.menu` for popup menus and nodes; registered menus use `extend.menu-entry`.
- **Reader:** reader panels, overlays and strips are `surface.reader-sidebar`, `reader-overlay`, `toolbar-slot` and `popover` views (confirmed); page overlays are drawn from `reader-events.render-overlay` shapes, so `canvas` needs no page coordinates. The attachment preview that reader row 22 asked for is `embed-component.attachment-preview` (already here). For the reader strips, `view-context.height` holds the fixed strip height (the host's toolbar or annotation header height) and `width` the space available; a popover gets the host's chosen size.
- **Prefs:** `node-props.pref` binds through `prefs.get` and `prefs.set` rules in the plugin's own namespace; the `prefs` interface lists which control binds to which pref type.
- **Files:** `drop-info.files` carries `types.file-grant`; `fs.read` and `fs.write` turn it into bytes. `ui.open-window`, `open-dialog` and `set-theme-override` now return `result<_, error>` so a missing permission or a second modal dialog has an answer.

Still open: none from this area's list. The "close all toasts" call and a "choose from a list" prompt that extend asked for are open (see extend.md).
