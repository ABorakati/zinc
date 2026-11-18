# Zotero 7-10 API to Zinc WIT: cheat sheet (current Zotero: 10)

A condensed form of the five parity reports in `docs/developer-guide/wasm-plugins/` (580 rows). The reports stay the source of truth: when a row matters
for a decision, open it (`lifecycle.md` rows 1-114, `extend.md` 1-126, `reader.md` 1-105; `library.md` and `ui.md` have unnumbered rows grouped by
heading). The `Rows` column below gives the row numbers or the heading.

Status: **C** covered (a plugin can do the same), **P** partial (part of it, or it behaves differently), **N** not planned (deliberately left out).
JS names are the jco form: `extend.registerMenu`, `library.apply`, fields in camelCase, enums as strings, variants as `{ tag, val }`.
Rust names are snake_case in `zinc_plugin::host::<interface>`. Permissions are in `manifest.json` `permissions.capabilities`; `net` hosts in
`permissions.net.hosts`. Basics of building, the SDKs and tests: `.claude/skills/zinc-plugin-create/`.

Parity-doc note (updated 2026-11-18): the rows that cited `ui.run-dialog` now point to `ui.open-dialog` and its `close` event. `ui.run-dialog` was removed in
phase 3 (`phase3-ui.md`). Where a row says "needs core", the WIT exists but the core may still answer
`unavailable`: check `docs/developer-guide/wasm-plugins/phase2-*.md` ("Stubbed or left") before promising it.

Contents: [Lifecycle](#lifecycle) | [Prefs](#prefs) | [Strings](#strings-fluent) | [Menus](#menus-and-shortcuts) | [Columns, sections, rows](#columns-item-pane-and-row-decoration) |
[Notifier](#notifier) | [Items and DB](#items-collections-tags-searches-and-the-database) | [Attachments, full text](#attachments-and-full-text) | [Cite, translate, sync, utilities](#cite-translate-sync-utilities) |
[Network](#network) | [Files, shell, clipboard, timers, misc](#files-shell-clipboard-timers-misc) | [Dialogs and UI](#dialogs-prompts-toasts-windows-tabs) | [DOM and XUL](#dom-xul-css) |
[Selection and navigation](#selection-view-navigation) | [Reader](#reader) | [Annotations and notes](#annotations-and-the-note-editor) | [Patching](#monkey-patching-and-internals) | [Permissions](#permission-ids)

## Zotero version differences that matter for a port

Plugins in the wild target Zotero 7 to 10 (Zotero 10 is current; 11 is pre-release). Read the plugin's `strict_min_version` / `strict_max_version`: Zinc ignores
them (see lifecycle row 3), but they tell you which Zotero API generation the code was written against. What changed:

- **Zotero 8**: `Zotero.MenuManager` appears (targets `main/library/item`, `main/library/collection`, `main/tab`, `main/menubar/*`, `main/library/addAttachment`, `addNote`, `reader/menubar/*`,
  `itemPane/info/row`, `notesPane/*`, `sidenav/locate`). `.jsm` became `.mjs`/`.sys.mjs`. Bluebird is gone (`Zotero.Promise.map/filter/each`, `Zotero.spawn`); `delay`, `defer` stay.
- **Zotero 9**: no API change; only `strict_max_version` moved.
- **Zotero 10**: multi-select in the collection tree. The singular getters **throw**: `ZoteroPane.getCollectionTreeRow`, `getSelectedLibraryID`, `getSelectedCollection`,
  `getSelectedSavedSearch`, `getSelectedGroup` (plurals: `getCollectionTreeRows`, `getSelectedLibraryIDs`, `getSelectedCollections`, `getSelectedSavedSearches`); `ItemTree#collectionTreeRow` is gone
  (`itemsView.viewMode` or `collectionTreeRows`); menu contexts give `collectionTreeRows`. Zinc's `extend.context.rows` is already a list, so the Zinc side is the plural form. Also: `isObjectRow` on item
  list rows, `item.saveTx({undoAction})`, `Zotero.UndoHistory`, `Zotero.ftl.addResourceIds`, `CookieSandbox` removed (`HTTP.newCookieContext`), `HTTP.download` returns a Response, search condition groups,
  `fulltextWord` removed (use `fulltextContent`), WAL database and FTS5 full text in an attached `ftindex` database (direct `Zotero.DB` SQL is version-fragile: another reason to rewrite it as `library.*`),
  the local server on 23119 wants a localhost Host header (Zinc refuses 23119 and 23120 anyway).
- **Zotero 11 (pre-release)**: `ownerGlobal` becomes `documentGlobal`, boolean attributes, async login manager. All DOM-side, so nothing to map.
- Parity rows written before Zotero 10 (extend 90 "getSelectedCollection(s)...", extend 99, library "Searches", "Full text") assume a single selected collection or the old full-text tables. Treat the Zinc
  column as the plural form: `ctx.rows` can hold several rows.

## Lifecycle

| Zotero | Zinc | St | Rows |
|---|---|---|---|
| `manifest.json` `applications.zotero.{id,strict_min_version,strict_max_version,update_url}` | manifest `id` (same rule, keep the id), `zinc.min_version`, `zinc.max_version` (+ `strict_max`, off by default), `update_url` | C | lc 1-4 |
| `bootstrap.js` entry, sandbox globals (`Zotero`, `Services`, `ChromeUtils`, `IOUtils`, `fetch`, ...) | `main.wasm` component; no ambient globals, each global that does something maps to an interface | C | lc 7-8 |
| `chrome.manifest`, `registerChrome`, `chrome://`, XUL/XHTML, overlays, CSS | none. Package files via `fs` root `bundled`; icons via `icon-ref.bundled`; UI is data | N | lc 9, 17 |
| `rootURI`, `resource://`, `getResource` | `fs.read` / `read-text` with root `bundled` and a relative path | P | lc 10 |
| `prefs.js` defaults | manifest `default_prefs` (bool, 32-bit int, string) | C | lc 11 |
| `locale/<tag>/*.ftl` | manifest `locales {default, available, dir}`; `l10n` | C | lc 12 |
| `.xpi` zip; install from file or URL | `.zplugin` zip with `manifest.json` at the root; folder + `dev.watch` in dev mode | C | lc 13 |
| `install` / `startup` / `shutdown` / `uninstall` with `reason` | `lifecycle.install/startup/shutdown/uninstall(plugin-data, reason)`; same reasons; per-hook time limit (startup 10 s, 5 s at app shutdown) | C | lc 18-27 |
| `onMainWindowLoad/Unload({window})` | `lifecycle.main-window-load/-unload(data, window-id)`: an id, not an object | C | lc 23 |
| hook params `{id, version, rootURI}` | `plugin-data {id, version, previous-version}` | P | lc 24 |
| `await Zotero.initializationPromise / uiReadyPromise` | drop: `startup` runs after both; `app.is-ui-ready`, `app.wait-ui-ready` | C | lc 28 |
| `Zotero.addShutdownListener` | `lifecycle.shutdown` reason `app-shutdown` | C | lc 29 |
| `Zotero.Plugins.addObserver`, `getAllPluginIDs`, `getName`, `getIconURI` | `plugins.observe-plugins`, `list-plugins`, `get-info`, `get-icon` (permission `plugins.read` for other plugins) | C | lc 30-31 |
| `Zotero.getMainWindow(s)`, `getActiveZoteroPane` | `app.main-windows`, `app.active-window` (ids) | P | lc 35 |
| `Zotero.version`, `appName`, `isMac/isWin/isLinux`, `locale`, `Services.appinfo` | `app.get-info` | C | lc 36 |
| Cross-plugin globals (`Zotero.MyPlugin`, toolkit registries) | none: components share no memory | N | lc 37 |
| `Components.classes`, `Cc`, `Ci`, `Cu`, `ChromeUtils.importESModule`, `Cu.Sandbox` | none | N | lc 112 |
| `Services.startup.quit/restart`, `Services.wm`, `Services.io`, `Services.console` | none (a plugin must not close Zinc) | N | lc 111 |
| Add-on blocklist, enable/disable, uninstall UI | host feature; the plugin sees lifecycle reasons | C | lc 14-15, 26-27 |
| Signing | `main.sha256` pinned at install; no code signing in 0.1 | P | lc 16 |
| (new) permissions | `permissions.check / list-permissions / request`; `events.on-permission-changed` | new | lc 114 |

## Prefs

| Zotero | Zinc | St | Rows |
|---|---|---|---|
| `Zotero.Prefs.get("name")` / `get(name, true)` on the plugin's `extensions.<id>.` branch | `prefs.get("key")`: own namespace only, relative key | C | lc 38 |
| `Zotero.Prefs.get(name, true)` for Zotero's or Firefox prefs | `prefs.get-app` (read only, allowlist, `prefs.app-read`) | P | lc 39, 46 |
| `Zotero.Prefs.set/clear/prefHasUserValue/resetBranch` | `prefs.set`, `set-many` (all or none), `clear`, `has-user-value`, `reset(prefix, except)` | C | lc 40, 42-44 |
| Setting Zotero, Firefox or other plugins' prefs; `Services.prefs` raw | none | N | lc 41 |
| `registerObserver(name, handler, global)` | `prefs.observe(scope, key, prefix)` + export `events.on-pref-changed` | C | lc 45 |
| `getForWindow` / `setForWindow` | none: key your own state by `window-id` | N | lc 47 |
| `getChildList` on a branch | `prefs.get-all(prefix)` | C | lc 48 |
| `Services.logins` for API keys | `secrets.get/set/delete/list-names` (OS credential store, per plugin) | C | lc 110 |
| `PreferencePanes.register({id,label,image,src,scripts,stylesheets})` | `extend.register-pref-pane`: `content.rows` (declarative) or `content.view` (a ui tree) | C/P | ex 65-69 |
| XUL `preference="..."` bindings (checkbox, textbox, menulist, radiogroup) | `setting-control` toggle / text / number / choice bound to a pref; `node-props.pref` on your own ui nodes | C | ex 70 |
| enable/disable a control from another pref | `setting-row.enabled-when` / `visible-when` (`{pref, equals}`) | C | ex 71 |
| pane stylesheets, `defaultXUL` | none | N | ex 68-69 |
| `ZoteroPane.openPreferences(paneID)` | `extend.open-settings` | C | ex 73 |

## Strings (Fluent)

| Zotero | Zinc | St | Rows |
|---|---|---|---|
| `data-l10n-id`, `data-l10n-args`, `document.l10n`, `new Localization(...)`, `getString` over own `.ftl` | `localized-string {id, args, fallback}` accepted by every label in registrations and ui nodes; `l10n.format`, `format-many`, `has-message` | C | lc 49 |
| locale fallback chain | same chain with the manifest's `locales.default` | C | lc 50 |
| shared L10n source (id collisions between plugins) | one bundle per plugin | C | lc 51 |
| `Zotero.getString` (Zotero's own `.properties`) | none: ship your own string | N | lc 52 |
| `Zotero.locale`, `requestedLocales` | `l10n.locale`, `events.on-locale-changed` | C | lc 53 |
| `Intl.DateTimeFormat` / `NumberFormat` in UI language | `l10n.format-date`, `format-number` | P | lc 54 |
| `.properties` / `.dtd` strings | convert to `.ftl` | (rewrite) | |

## Menus and shortcuts

| Zotero | Zinc | St | Rows |
|---|---|---|---|
| `Zotero.MenuManager.registerMenu({menuID, pluginID, target, menus})` | `extend.register-menu({menuId, target, entries})`, `replace-menu-entries`, `patch-menu` | C | ex 41 |
| targets `main/menubar/{tools,file,edit,view,go,help}` | `menubar-tools`, `-file`, `-edit`, `-view`, `-go`, `-help` (a real menubar is planned; until then an overflow "Plugins" menu) | C | ex 42-43 |
| `main/library/item`, `main/library/collection`, `main/library/addAttachment`, `addNote`, `main/tab`, `itemPane/info/row`, `notesPane/*`, `sidenav/locate` | `library-item`, `library-collection`, `library-add-attachment`, `library-add-note`, `tab`, `item-info-row`, `notes-add-item-note`, `notes-add-standalone-note`, `sidenav-locate` | C | ex 44-51 |
| `reader/menubar/*` (deprecated) | use `menubar-*` with `visible-when.tabKinds = ["reader/*"]` | N | ex 48 |
| `menuType` menuitem / separator / submenu, nested `menus` | `entry-kind` item / separator / submenu; flat list with `parent` | C | ex 52 |
| `l10nID`, `icon`, `darkIcon` | `label: localized-string`, `icon: themed-icon` | C | ex 53-54 |
| `enableForTabTypes` | `condition.tabKinds` | C | ex 55 |
| `onShowing` + `setVisible/setEnabled/...` | `on-menu-showing(menu-id, ctx) -> entry-patch[]` (120 ms limit); prefer declarative `visible-when` / `enabled-when` (`minItems`, `maxItems`, `itemTypes`, `rowKinds`, `requireEditable`) | C | ex 56 |
| `onShown`, `onHiding`, `onHidden` | `on-menu-phase` (set `hooks` flags on the entry) | C | ex 57 |
| `onCommand(event, context)` | `on-menu-command(menu-id, entry-id, checked, ctx)`; `ctx.items` are keys | C | ex 58-59 |
| context `menuElem`, `targetElem`, DOM `event` | none | N | ex 60 |
| check items (`type=checkbox` on a DOM menuitem) | `menu-entry.check`, `entry-patch.checked`, callback `checked` | C | ex 63 |
| accelerators | `menu-entry.accelerator` (also rebindable) | C | ex 64 |
| DOM-injected menu items (`#zotero-itemmenu`, `#zotero-collectionmenu`, `#menu_ToolsPopup`, `ztoolkit.Menu`) | the rows above | C | ex 109 |
| toolbar buttons injected into `#zotero-items-toolbar`, `#zotero-tabs-toolbar` | `register-toolbar-button`, `register-toolbar-view`, `set-toolbar-button-state` (two slots) | P | ex 110 |
| `KeyboardManager`, `keydown` listeners, `ztoolkit.Keyboard` | `register-shortcut` + `on-shortcut`: a named command with one chord, user rebinds in Settings > Shortcuts. No raw key events, no sequences, no overriding built-ins | P | ex 111 |
| command palette (`PromptManager`) | `shortcut-registration.in-command-search` (ignored until Zinc has command search), or a dialog / popover | P | ex 112 |

## Columns, item pane, row decoration

| Zotero | Zinc | St | Rows |
|---|---|---|---|
| `ItemTreeManager.registerColumn({dataKey, label, dataProvider, renderCell, ...})` | `extend.register-column(reg)` + `extend-handlers.on-column-values(data-key, keys[]) -> cell[]`: **batched per call, not per row**; cached; async allowed | C | ex 25, 34 |
| `registerColumns`, `unregisterColumn` | `register-columns` (all or none); `extend.unregister(kind, id)` | C | ex 26 |
| `enabledTreeIDs`, `sortReverse`, `flex`, `width`, `fixedWidth`, `staticWidth`, `noPadding`, `minWidth`, `showInColumnPicker`, `columnPickerSubMenu`, `iconPath` | `trees`, `sort-reverse`, `flex`, `width`, `fixed-width`, `static-width`, `no-padding`, `min-width`, `show-in-picker`, `picker-submenu`, `icon` | C | ex 27-33 |
| `renderCell` returning DOM; `htmlLabel`, `iconLabel` | `cell.body` = text / icon / bar / rating / chips, plus `color`, `style`, `tooltip`; label + icon. Closed set | P | ex 32, 35 |
| sorting of plugin columns (provider called per comparison) | `sort-mode` (`text`/`number`) + `cell.sort-key`; the host batches and sorts | C | ex 36 |
| `zoteroPersist` | always persisted by the host | C | ex 37 |
| `primary` column, `defaultIn`, `disableIn`, `getCustomColumns` | none | N | ex 28, 38, 40 |
| `refreshColumns()` | `invalidate-columns(data-key?, keys?)` | C | ex 39 |
| item tree row styling (patching `ItemTree`) | `register-row-style` + `on-row-styles`, `invalidate-row-styles` | C | ex 117 |
| collection tree badges / icons (patching `collectionTree.jsx`) | `register-collection-decoration` + `on-collection-decorations` (badge, icon, colour, tooltip) | P | ex 118 |
| custom "virtual" collections | `register-virtual-collection` + `on-virtual-collection-items` (flat rows; no subtree) | P | ex 119 |
| `ItemPaneManager.registerSection({paneID, header, sidenav, sectionButtons, onInit, onItemChange, onRender, onAsyncRender, onToggle, onDestroy})` | `extend.register-section(reg)` + `ui-events.mount / update-context / visibility / unmount`; the body is a JSON ui tree; async updates with `ui.push(instance, ...)`; `ui.refresh` | C | ex 1-13 |
| `bodyXHTML`, hook args `doc`, `body` | none: return a tree | N | ex 4, 14 |
| `setEnabled`, `setL10nArgs`, `setSectionSummary`, `setSectionButtonStatus` | `render-result.meta {title, summary, enabled, buttons}`; declarative `enabled-for` | C | ex 7, 11-12 |
| hook args `item`, `tabType`, `editable` | `view-context.params` JSON (`itemKey`, `tabType`, `editable`) | C | ex 15 |
| section shown in the reader's context pane / note window | `enabled-for.tab-kinds`; Zinc's reader tab shows plugin sections | C | ex 16, 126 |
| collapsed sections still called on item change | opt in with `decides-enabled`; default is lazy | C | ex 18 |
| `registerInfoRow({rowID, label, position, onGetData, onSetData, ...})` | `extend.register-info-row` + `on-info-row-get / -set`, `refresh-info-row` (plain text values) | C | ex 19-24 |
| virtual item fields (patching `Item.prototype.getField`) | info row (read/write, one item) or column (list) | P | ex 122 |

## Notifier

| Zotero | Zinc | St | Rows |
|---|---|---|---|
| `Notifier.registerObserver({notify}, types, id, priority)` | `notifier.subscribe(subscription {types, kinds, priority, skip-own, max-delay-ms, label})` + export `notifier-handler.on-events(subscription, batch)`. Ids are **item keys (strings)**, not numbers. Batches carry `origin` (this-plugin, plugin, user, sync, connector, external) | C | lib: Notifier |
| `ref.notify(event, type, ids, extraData)` | `event {object, kind, ids, library, extra, options, origin}` | C | lib: Notifier |
| types collection, search, item, collection-item, item-tag, tag, trash, relation, setting, sync, group | `object-type` of the same names | C | lib: Notifier |
| types `feed`, `feedItem`, `bucket`, `share`, `api-key` | names exist, events never fire | N | lib: Notifier |
| type `file`, event `open` / `close` / `pageChange` (reader opened a file) | `reader.subscribe` `opened` / `closed` / `page-changed` + `reader-events.on-reader-event` (permission `reader.read`) | C | rd 52 |
| type `tab` (add, select, close) | `extend.subscribe-events` `tab-changed` -> `extend-handlers.on-event` | C | ex 84 |
| `itemtree`, `itempane`, `infobox` internal refresh events | none | N | ex 125 |
| events add, modify, delete, move, remove, refresh, redraw, trash, restore, index | `event-kind` of the same names | C | lib: Notifier |
| `Notifier.begin/commit/queue`, `skipSelect`, `skipAutoSync` | none; `apply-options.skip-notify` replaces `skipNotifier` | P | lib: Notifier |
| `Notifier.trigger` custom events | `notifier.trigger` for `other` / UI types only (a plugin cannot forge item events) | P | lib: Notifier |
| (core change log) | Today only the plugin layer's own writes are seen; the core change log is phase 2 work. Check `phase2-data.md` before relying on edits made by the user | P | README |

## Items, collections, tags, searches and the database

Zinc has **no object model and no SQL**. A plugin reads item JSON (Zotero Web API `data` object) and sends **one atomic batch** with `library.apply`.
Items are identified by 8-character **keys**, libraries by `library-id` (the user library is `1`). Needs `library.read` (reads), `library.write` (apply),
plus `library.trash` / `library.erase` for those changes.

| Zotero | Zinc | St | Rows |
|---|---|---|---|
| `Zotero.Items.get/getAsync/getByLibraryAndKey` | `library.get-items(keys, {includeChildren, includeTrashed}) -> option<json>[]` | C | lib: Items |
| `Items.getAll`, `getDeleted`, search results, quicksearch | `library.query-items(item-query)` (scope all / collection / unfiled / trash / publications / saved-search / children-of; `tags`, `text` + `text-mode`, `search`, `fields`, `expand`, `sort`, `limit` <= 1000, `offset`), `query-keys`, `count-items` | C | lib: Items, Searches |
| `Zotero.DB.queryAsync` reads (`SELECT ... FROM items ...`) | `query-items`, `query-keys`, `count-items`, `facets(query, field, limit)` (GROUP BY one field), `list-tags`, `get-collection-items` | N (raw SQL) | lib: Raw database |
| `Zotero.DB.queryAsync` writes, `executeTransaction`, `saveTx` | `library.apply(changes, {skipNotify})`: one transaction, in list order; failure is `{index, error}`. No interactive transactions | C | lib: Raw database |
| `item.getField/setField/getCreators/setCreators/getTags/getCollections/getRelations/getNote` | fields of the item JSON; change with `update-item {key, patch, expectedModified}` (PATCH semantics; `creators`, `tags`, `collections`, `relations` replace the whole list) | C | lib: Items |
| `new Zotero.Item(type)`, `saveTx` | `apply [{tag:"create-item", val:{data}}]`; get keys first with `library.new-keys` when children refer to the parent | C | lib: Items |
| `item.addTag/removeTag/setTags` | `add-tags {items, tags:[{name, kind:"manual"\|"automatic"}]}`, `remove-tags`; type 0/1 becomes `tag-kind` | C | lib: Tags |
| `Zotero.Tags.rename/removeFromLibrary/getColor/setColor` | `rename-tag`, `delete-tags`, `delete-automatic-tags`, `get-tag-colors`, `set-tag-colors` | C | lib: Tags |
| `Collection.addItem/removeItem`, `new Zotero.Collection`, `erase` | `add-to-collection`, `remove-from-collection {collection, items}`, `create-collection`, `update-collection`, `erase-collection {trash-items}` (`library.erase`) | C | lib: Collections |
| collections in the trash | none: Zinc deletes collections for good | P | lib: Collections |
| `item.deleted = true`, `Items.trash`, restore, `erase`, `emptyTrash` | `trash-items`, `restore-items`, `erase-items` (must be trashed first), `library.empty-trash` | C | lib: Items |
| `Items.merge`, `Zotero.Duplicates` | `library.merge-items`, `find-duplicates`, `mark-not-duplicates` | C | lib: Items |
| `item.clone`, `moveToLibrary` | create from copied JSON; a move is a copy plus trash (keys are global) | P | lib: Items |
| `addRelatedItem`, `Zotero.Relations` | `add-related` / `remove-related`; `relations` JSON; `find-by-relation` (needs core: no index) | P | lib: Items |
| `Zotero.Search`, `addCondition`, `Searches.getAll` | `item-query.search` (search-definition) and saved searches (`create-/update-/erase-saved-search`); core compiles a subset of the 59 condition names | P | lib: Searches |
| `Item.toJSON`, `fromJSON` | the item JSON is the Web API `data` object | C | lib: Items |
| numeric `itemID`, `libraryID` | none: use `key` and `library-id` | (rewrite) | lib: Items |
| `item.getExtraField`, `extractExtraFields` | `data-utils.parse-extra`; write `extra` back in a patch | C | lib: Items |
| `Item.getDisplayTitle`, `getNoteTitle`, `getFirstCreatorFromData`, `getSortTitle` | `data-utils.display-title`, `note-to-title`, `first-creator`, `sort-title` | C | lib: Items |
| `ItemTypes`, `ItemFields`, `CreatorTypes` | `schema.get-schema` (English labels only) | P | lib: Schema |
| custom item types / fields; `Zotero.Creators` table | none: store plugin data in `extra`, `relations` or plugin storage; creators live in item JSON | N | lib: Schema |
| annotation items as `Zotero.Item` | `annotations.*` only; the library calls refuse annotation keys | P | lib: Items |
| `Libraries.getAll/get/exists`, `Groups` | `library.list-libraries -> library-info` | C | lib: Libraries |
| `Libraries.getVersion`, `Library.saveTx`, creating libraries | none | N | lib: Libraries |
| `Zotero.Feeds`, `Retractions`, `Report`, `Timeline` | none | N | lib: last rows |

## Attachments and full text

| Zotero | Zinc | St | Rows |
|---|---|---|---|
| `getAttachmentLinkMode/MIMEType`, `isPDFAttachment`, `isFileAttachment`, `fileExists` | `attachments.get-info -> attachment-info` | P | lib: Attachments |
| `getFilePath/getFilePathAsync/getFile` | `attachment-info.path` (permission `library.files.paths`); prefer `read-file` / `read-file-all` / `open-file-external` / `reveal-file` | C | lib: Attachments |
| `Attachments.importFromFile`, `importFromURL`, `linkFromFile`, `linkFromURL`, `importFromDocument` | `import-bytes` (bytes, not a path), `import-from-url` (net permission applies), `link-file`, `link-url`; HTML documents as bytes | C/P | lib: Attachments |
| `getBestAttachment(s)` | `attachments.best-attachment(s)`; `item-summary.best-attachment` | C | lib: Attachments |
| `renameAttachmentFile`, `relinkAttachmentFile`, `deleteAttachmentFile`, `convertLinkedFileToStoredFile` | `rename-file`, `rename-by-template`, `relink-file`, `delete-file`, `replace-file`; conversion has no single call | C/P | lib: Attachments |
| storage directory paths, `getStorageDirectory`, `OS.File` on attachments | none: ask the host to read, write, import or rename | N | lib: Attachments |
| find available PDFs | `find-available-files` (one fixed resolver chain; no custom resolvers) | P | lib: Attachments |
| `Fulltext.getIndexedState`, read `.zotero-ft-cache` | `fulltext.get-index-state`, `get-content` | C/P | lib: Full text |
| `Fulltext.setItemContent`, `indexItems`, `findTextInItems` | `set-content`, `reindex` (need core), `search` (SQLite FTS5, results differ from Zotero's word index) | P | lib: Full text |
| reader view state / last page | `attachments.get-view-state / set-view-state` | C | lib: Attachments |

## Cite, translate, sync, utilities

| Zotero | Zinc | St | Rows |
|---|---|---|---|
| `Styles.getAll`, `Style.getXML`, install/remove | `cite.list-styles`, `get-style-xml`, `install-style`, `remove-style` (install by repository id only) | C/P | lib: Cite |
| bibliography / citation formatting, `QuickCopy` | `cite.format` (html/text/rtf/note-citation), `quick-copy`, `get-quick-copy-settings`; no citeproc engine object | P | lib: Cite |
| `Translate.Import/Export/Search/Web`, `Translators.getAllForType` | `translate.import-text`, `export-items` (text only), `lookup` (DOI, PMID, PMCID, arXiv, ISBN), `web` + `web-select`, `list-translators`; no custom translators, no DOM hand-over | C/P | lib: Translate |
| `Sync.Runner.sync()`, listeners | `sync-control.sync-now`, `get-state`; notifier type `sync` | C | lib: Sync |
| `Zotero.Date.strToDate/strToISO`, `Utilities.Item.itemToCSLJSON` | `data-utils.parse-date`, `to-iso-date`, `display-date`, `item-to-csl-json`, `item-from-csl-json` | C/P | lib: utilities |
| `Utilities.cleanDOI/cleanISBN/cleanISSN/capitalizeTitle/text2html/semverCompare`, `extractIdentifiers` | `util.clean-doi`, `clean-isbn`, `clean-issn`, `capitalize-title`, `text-to-html`, `html-to-text`, `semver-compare`; `data-utils.extract-identifiers` | P | lc 107 |
| other `Zotero.Utilities` string, HTML, XML helpers | none: generic code, ship it | N | lib: utilities |
| `crypto.getRandomValues/randomUUID`, md5, `subtle.digest` | `util.random-bytes`, `uuid-v4`, `hash` (md5, sha1, sha256, sha512); no HMAC or encryption | P | lc 108 |
| `DOMParser`, `TextEncoder`, `URL`, `btoa`, `Blob` | the guest language's own libraries | N | lc 109 |

## Network

Declare hosts: `"permissions": {"net": {"hosts": ["https://api.crossref.org", "*.example.org"]}}`. Https is assumed without a scheme; `http://` must be
written out; loopback and private hosts need an exact `host:port`; `*` is high risk. Zinc's own server and ports 23119 and 23120 are always refused.

| Zotero | Zinc | St | Rows |
|---|---|---|---|
| `Zotero.HTTP.request(method, url, opts)`, `doGet/doPost`, `fetch`, `XMLHttpRequest` | `net.send(http-request {method, url, headers, body (bytes), timeout-ms, success-codes, redirect, credentials, cookies, retry, bypass-cache, max-response-bytes, cancel-key}) -> http-response {status, headers, body (bytes)}` | C | lc 56-59, 72 |
| `responseType` json / text / arraybuffer | body is always bytes; decode in the guest | C | lc 59 |
| `responseType: "document"`, `processDocuments`, `loadDocuments` | none: parse HTML with a library in the guest | N | lc 60 |
| `errorDelayIntervals`, retries | `retry-policy {delays-ms, max-total-ms, surface-throttle}` (default: no retry) | C | lc 61 |
| `UnexpectedStatusException`, `TimeoutException`, `BrowserOfflineException` | `net-error` variants: `unexpected-status(response)`, `timeout`, `offline`, `cancelled`, `tls`, `dns`, `connection`, `too-large`, `blocked` | C | lc 67 |
| `HTTP.download`, `File.download` | `net.download(req, dest path-ref, options)` + `net-events.on-download-progress` | C | lc 68 |
| streamed `fetch` body | `net.send-streamed` + `body-reader` | C | lc 69 |
| `cancellerReceiver` | `cancel-key` + `net.cancel` | C | lc 65 |
| `WebSocket`, `EventSource` | none in 0.1 | N | lc 71 |
| `Zotero.Proxies`, proxy auth dialogs | none (system proxy) | N | lc 74 |
| A plugin that exposes an HTTP endpoint, local server route (`Zotero.Server.Endpoints`) or connector for AI agents or other tools to call | no listening sockets (`net` is outbound only). When the goal is letting an agent act on the library, offer **MCP tools**: manifest `mcp.expose` + `mcp.tools` or `mcp.register-tool`, answer in `mcp-handler.on-mcp-call` (world `plugin-mcp`; JS `defineTool`, Rust `mcp::Tool`). Agents reach them through Zinc's own MCP endpoint, and the user switches each plugin on in Settings > Plugins. A route that serves a browser extension or arbitrary HTTP clients has no equivalent | P | `docs/developer-guide/wasm-plugins/mcp.md` |
| `browserIsOffline` | `net.is-online` | C | lc 73 |
| isolated cookie jars | `cookie-mode` `jar(name)`; the user's real cookies are never shared | P | lc 63 |

## Files, shell, clipboard, timers, misc

| Zotero | Zinc | St | Rows |
|---|---|---|---|
| `IOUtils.read/write/exists/stat/remove/move/copy/makeDirectory`, `Zotero.File.*` | `fs.read/read-range/read-text/write/write-text/append/stat/list-dir/make-dir/remove/move/copy`; paths are `path-ref {root: data \| bundled \| temp \| granted(id), path}`, relative, no `..` | C | lc 76-84 |
| absolute paths (profile, data dir, home), `PathUtils`, `OS.Path`, `Zotero.getTempDirectory` | none: roots `data` (own folder, 512 MiB), `bundled` (read only), `temp`, `granted` | N | lc 84-86 |
| `FilePicker` / nsIFilePicker | `fs.pick-open / pick-save / pick-directory` -> `file-grant`s (`root::granted(id)`); the user's pick is the consent | C | lc 89 |
| `nsIFile`, zip, `setPermissions`, symlinks, file locking | none | N | lc 87-88 |
| `Zotero.launchURL` | `shell.open-url` (permission `shell.open-url`; other schemes need `permissions.shell.schemes`) | C | lc 99 |
| `Zotero.launchFile` | `shell.open-file` (own, temp, granted files; executables refused) | P | lc 100 |
| `Zotero.File.reveal` | `shell.reveal` | C | lc 101 |
| `launchFileWithApplication`, `Utilities.Internal.exec`, `subprocess`, native messaging | none | N | lc 102 |
| clipboard write (`copyTextToClipboard`, nsIClipboard) | `clipboard.write` (permission `clipboard.write`; text, html, image) | C | lc 97 |
| clipboard read | `clipboard.read` (permission `clipboard.read`, high risk, first read confirmed) | C | lc 98 |
| `setTimeout`, `setInterval`, `requestIdleCallback`, `Zotero.Promise.delay` | `timers.set-timeout/set-interval/request-idle/clear/sleep`; the callback is the export `events.on-timer(timer, kind)` | C | lc 91-94 |
| `Date.now`, `performance.now` | `timers.now`, `monotonic-ms` | C | lc 95 |
| `Worker`, `ChromeWorker` | none: one single-threaded component; split long work into timer steps or use Rust | N | lc 96 |
| `Zotero.debug`, `warn`, `logError`, `Debug.enabled` | `log.write(level, msg)`, `write-error`, `debug-enabled` | C | lc 103-105 |

## Dialogs, prompts, toasts, windows, tabs

| Zotero | Zinc | St | Rows |
|---|---|---|---|
| `Services.prompt.alert`, `Zotero.alert` | `ui.alert(title, message, tone)` | C | ui: Services.prompt |
| `Services.prompt.confirm/confirmEx`, `Zotero.Prompt.confirm` | `ui.confirm(spec {accept-label, cancel-label, destructive, checkbox-label}) -> {accepted, checkbox}`; three buttons or `buttonDelay` need `open-dialog` | P | ex 102 |
| `Services.prompt.prompt` | `ui.prompt(spec) -> option<string>` | C | ex 103 |
| `Services.prompt.select` | none built in: `open-dialog` with a `select` | P | ex 103 |
| `window.openDialog` with XHTML, toolkit `Dialog` | `ui.open-dialog(dialog-spec {title, content (tree JSON), buttons, modal, ...}) -> instance` (**non-blocking**); outcome arrives as `ui-events.on-event` `close` events (`button`, then `form` values); `update-dialog`, `close-dialog` | P | ex 107, 113 |
| `Zotero.ProgressWindow`, `ItemProgress`, toolkit `ProgressWindowHelper` | `ui.show-toast / update-toast / close-toast` (title, lines with progress, tone, duration, actions) | C | ex 104 |
| `ProgressWindowSet.closeAll` | keep your toast ids; no "close all" | P | ex 105 |
| `ProgressQueue` dialog | build with `open-dialog` + `update-dialog` | N | ex 106 |
| `window.open`, `openWindowByType` | `ui.open-window` (OS window; permission `ui.windows`) | C | ui: Plugin windows |
| `Zotero_Tabs.add({id, type, title, ...})`, select, close, rename, move, pin | `extend.open-tab`, `select-tab`, `close-tab`, `rename-tab`, `move-tab`, `set-tab-pinned`, `list-tabs`, `selected-tab`; tab content is a ui view; `on-tab-closing`, `on-tab-restore`; second library tab not planned | C | ex 75-88 |
| `Zotero.Banners` | `extend.show-banner / hide-banner`, `on-banner-action` | C | ex 101 |
| `setItemsPaneMessage` | none: banner or side panel | N | ex 100 |
| side boxes / panels | `register-side-panel`, `set-side-panel-open` | C | extend.wit |
| drag and drop onto the tree, window or item list | `register-drop-target` + `on-drop` (files arrive as `file-grant`s); `register-drag-format` + `on-drag-format` (text only) | P | ex 120-121 |
| tooltips, rich text, HTML | `tooltip` plain text; `rich-text` node with a safe html-subset or markdown | P | ui |

## DOM, XUL, CSS

A Zinc plugin has **no DOM**. UI is a JSON tree (`plugin-api/ui-schema/ui-tree.schema.json`) returned from `mount` / `update-context` / `on-event`
(or patched with `content-update.patch`). The element mapping in `ui.md` ("elements and APIs plugins use") covers: `button`, `checkbox`, `switch`,
`radio-group`, `select`, `text-input`, `number-input`, `color-input`, `slider`, `date-input`, `box`, `grid`, `scroll`, `split`, `tabs`, `deck`, `group`,
`section`, `text`, `link`, `image`, `icon`, `progress`, `separator`, `toolbar`, `list-view`, `table` (virtual rows via `render-range`), `popover`,
`form`, `callout`, `badge`, `web-view`, `canvas`, `embed`.

| Zotero | Zinc | St | Rows |
|---|---|---|---|
| `document.createElement`, `createXULElement`, `ztoolkit.UI.createElement`, `innerHTML` | build a tree; `rich-text` for a safe HTML subset | N | ui; ex 115 |
| `getElementById`, `querySelector`, `appendChild`, `insertBefore` on Zotero's own windows | extension points: sections, menus, columns, toolbar slots, side panels, tabs, banners | N | ui: Direct DOM edits |
| DOM events on your own UI (`click`, `input`, `change`, `keydown`, ...) | `event-kind` + `event-binding` (debounce, throttle, key filter); handler ids come back as `ui-events.on-event` | C | ui: DOM events |
| `<form>` submit | `form` node; `submit` event with `form-field`s | C | ui |
| inline / linked CSS for your own UI | `style`, `named-style`, `state-styles`, colour tokens; no selectors or cascade | P | ui: CSS |
| CSS that recolours Zotero (make-it-red) | `ui.set-theme-override` (token colours; user can turn it off) | P | ex 116 |
| CSS that hides, resizes or reflows built-in UI | none | N | ui |
| `@font-face`, `customElements.define`, `@keyframes` | none (custom elements: a function returning a subtree) | N | ui |
| `iframe`, `xul:browser` | `web-view` (permission `ui.webview`; 2 per plugin, drawn above the UI) | P | ui |
| `html:canvas` 2D | `canvas` vector draw list; no per-pixel or WebGL | P | ui |
| `VirtualizedTable` (React) | `table` with `rows-source.virtual` + `ui-events.render-range` | C | ex 114 |
| `GuideHelper` tours | none: popover or banner | N | ex 123 |
| private fields (`Zotero_Tabs._tabs`, `ztoolkit.getGlobal`) | none | N | ex 124 |

## Selection, view, navigation

| Zotero | Zinc | St | Rows |
|---|---|---|---|
| `ZoteroPane.getSelectedItems(asIDs)` | callback `ctx.items` (keys; `items-truncated` -> `extend.list-selected-items(window, offset, limit)`), `get-context` | C | ex 89 |
| `getSelectedCollections`, `getSelectedSavedSearches`, `getSelectedLibraryIDs`, `getCollectionTreeRows` (Zotero 10 plurals; the singular forms throw there) | `ctx.rows` (`tree-row {kind, library, key}`), `ctx.library` | C | ex 90 |
| `getSortedItems`, `getSortField` | `list-view-items`, `get-view` | C | ex 91 |
| `selectItem(s)`, collection tree `selectCollection`, quick search text, `toggleItemPane` | `select-items`, `select-row`, `set-search`, `set-panel-visible` | C | ex 92-95 |
| `viewAttachment`, `viewItems` | `open-item(key, mode)` | C | ex 96 |
| item tree / collection tree `onSelect` events | `subscribe-events` (`selection-changed`, `view-changed`, debounced) -> `extend-handlers.on-event` | C | ex 97 |
| `newItem`, `newNote`, `createEmptyParent` | creating data is `library.apply`; the note editor is `note-editor.open-note` | N (here) | ex 98 |
| `window.ZoteroPane.itemsView`, `collectionsView` live objects | none | N | ex 99 |

## Reader

Permissions: `reader.read`, `reader.control`, `reader.ui`, `reader.themes`. Row numbers refer to `reader.md`.

| Zotero | Zinc | St | Rows |
|---|---|---|---|
| `Reader.registerEventListener("renderToolbar" \| "renderTextSelectionPopup" \| "renderSidebarAnnotationHeader", handler)` | `reader.register-listener({id, target: slot(toolbar \| text-selection-popup \| sidebar-annotation-header), reader-kinds})`; content is a ui view (`mount`) | C | rd 1-3 |
| `createColorContextMenu`, `createViewContextMenu`, `createAnnotationContextMenu`, `createThumbnailContextMenu`, `createSelectorContextMenu`, `createThemeContextMenu` | `register-listener` with target `menu(color \| view \| annotation \| thumbnail \| selector \| theme)` + `reader-events.build-menu` / `on-menu-command` | C | rd 4-10 |
| `event.doc`, `append(...DOM)` | return a ui tree / menu entries | P | rd 11 |
| `Reader._readers`, `getByTabID`, selected tab's reader, window readers | `reader.list-readers`, `get-reader-by-tab`, `selected-reader` | C | rd 16-19 |
| `Reader.open(itemID, location, opts)`, `openURI` | `reader.open(open-request)` | C/P | rd 20-21 |
| `reader.navigate(location)`, back/forward/page steps, `focus`, `close` | `reader.navigate`, `navigate-step`, `focus`, `close` | C | rd 29-32 |
| zoom, copy, undo, print, export, reload, toggle context pane, `setTool`, `findNext`, `setFilter`, `setSelectedAnnotations` | `reader.run-command`, `set-tool`, `find`, `set-filter`, `select-annotations`, `set-layout`, `set-sidebar` | C | rd 33-43 |
| reader state (`_state`, view stats, split view, sidebar) | `reader.get-state -> reader-state` (split view answers `unavailable` for now; no sidebar change event) | C/P | rd 36-38 |
| themes, reader prefs `reader.*` | `reader.list-themes`, `set-theme-choice`, `save-theme`; prefs only if the host publishes the names | C/P | rd 45-46 |
| rotate / delete PDF pages | `reader.rotate-pages`, `delete-pages` | C | rd 47 |
| Read Aloud | `run-command(toggle-read-aloud)` only | P | rd 48 |
| notifier `file`/`tab` events, selection changes, tool changes | `reader.subscribe` (`opened`, `closed`, `tab-selected`, `page-changed`, `selection-changed`, `tool-changed`, `annotations-selected`, `view-state-changed`) | C | rd 52-54 |
| `_iframeWindow` DOM, `_internalReader`, `wrappedJSObject.createReader` | none; see replacements below | N | rd 55-56, 67 |
| `_internalReader._lastView._selectionPopup` selected text | `reader.get-selection` | C | rd 58 |
| PDF.js page text, page render | `reader.get-page-text(pages, with-words)` (PDF only), `render-page(page, scale, clip)` | C | rd 60-61 |
| patch `pdfLinkService` / link clicks | `register-link-interceptor` + `on-link` (cannot list page links) | P | rd 62 |
| draw over a PDF page (heatmaps, boxes) | `register-overlay` + `render-overlay` (declarative shapes in page space; PDF only) | P | rd 63 |
| `iframe.addEventListener("keydown")` in the reader | `register-shortcut` scope `reader` (modifier combos only) | P | rd 64 |
| pointer events on the reader iframe | `subscribe(selection-changed)` for "user finished selecting"; others not planned | P | rd 65 |
| inject CSS / DOM into the reader, sidebar buttons | `register-panel` (sidebar tab or alt view), slots, overlays, themes | P | rd 66 |
| reader context pane sections | `extend.register-section` with `tab-kinds` | C | rd 104 |

## Annotations and the note editor

| Zotero | Zinc | St | Rows |
|---|---|---|---|
| `Zotero.Annotations.toJSON`, annotation item getters (`annotationText`, `annotationColor`, `annotationPosition`, ...) | `annotations.list-annotations`, `get-annotations` (permission `annotations.read`); tag colours via `library` | C | rd 71, 80, 82 |
| `Annotations.saveFromJSON`, `eraseTx` | `create-annotations`, `update-annotations`, `remove-annotations` (`annotations.write`); `sort-index`, `page-label` computed if missing | C | rd 72-74 |
| annotation types highlight/underline/note/image/ink/text, `COLORS` | `annotation-kind`, `annotation-colors` | C | rd 69-70 |
| image / ink cache | `get-annotation-image`, `set-annotation-image` | C | rd 76 |
| item notifier events for annotations | `subscribe(annotations-changed)` -> batched `annotations-change` with `by-this-plugin` | C | rd 83 |
| annotation relations, `getAllAuthors`, cache housekeeping | none | N | rd 77-78, 81 |
| `ZoteroContextPane.activeEditor`, `insertAnnotations`, `_postMessage({action:"insertHTML"})` | `note-editor.active-editor`, `insert-annotations`, `insert-html` (cursor / start / end; no numeric positions) | C/P | rd 86-88 |
| `saveSync`, `getDataSync`, editor selection, `renderCustomHead`, `Notes.open`, `getExportableNote` | `save-now`, `get-content`, `get-selection`, `register-head`, `open-note`, `exportable-html` | C | rd 90-94 |
| embedded images, "Add Note from Annotations", citation HTML for notes | `embedded-images-available`, `copy-embedded-images`, `add-embedded-image`, `create-note-from-annotations`; `cite.format` with `note-citation` | C | rd 95-98 |
| Better Notes style templates (user code with `Zotero` in scope) | typed data in, HTML out through `insert-html` / `create-note-from-annotations` | P | rd 99 |
| ProseMirror view, editor iframe, extra editor toolbar buttons | none | N | rd 103 |
| `Notes.noteToTitle`, `replaceItemKey`, upgrade helpers | none (string work in the plugin); `data-utils.note-to-title` exists | N | rd 101-102 |

## Monkey-patching and internals

| Zotero | Zinc | St | Rows |
|---|---|---|---|
| `PatchHelper`, `ztoolkit.patch`, `Object.prototype.method = wrapper`, replacing `Zotero.X.y` | none. A plugin cannot change host code. Find the extension point that covers the intent (table in `patterns.md`, "Monkey-patching"), else report the feature as not portable | N | ex 122 |
| `ItemTree.prototype`, `ZoteroPane` patches for look and feel | `register-row-style`, `register-collection-decoration`, columns | P | ex 117-118 |
| `Zotero.Item.prototype.getField` virtual fields | info row or column | P | ex 122 |
| `Zotero.Utilities.Internal.itemToExportFormat` and other export hooks | none: post-process the output of `translate.export-items` | N | lib: Translate |

## Permission ids

36 ids, all in `plugin-api/manifest.schema.json` (`$defs.capability`, `x-risk`). Free (no entry): own `prefs`, `secrets`, `l10n`, `log`, `timers`, `util`,
`fs` roots `data` / `bundled` / `temp` / `granted`, `app`, declarative UI, dialogs, toasts.

`library.read`, `library.write`, `library.trash`, `library.erase`, `library.files.read`, `library.files.write`, `library.files.paths`, `library.files.open`,
`library.fulltext.read`, `library.fulltext.write`, `library.cite`, `library.cite.styles`, `library.translate`, `library.sync`; `clipboard.read`, `clipboard.write`;
`shell.open-url`, `shell.open-file`, `shell.reveal`; `plugins.read`; `prefs.app-read`; `ui.webview`, `ui.windows`, `ui.theme`, `ui.drop`, `ui.navigate`;
`reader.read`, `reader.control`, `reader.ui`, `reader.themes`; `annotations.read`, `annotations.write`; `note-editor.read`, `note-editor.write`,
`note-editor.control`, `note-editor.ui`. Net: `permissions.net.hosts`. Ask for the least, and give a `permission_reasons` sentence for each.
