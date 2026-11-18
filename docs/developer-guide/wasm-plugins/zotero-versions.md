# Zotero versions and their plugin APIs (7 to 11)

Status 2026-11-18. The current Zotero is **10** (10.0 released 17 August 2026). Zotero 11 is in pre-release for plugin
developers only. Zinc's parity tables in this folder were written against Zotero's source; this page lists what changed
for plugin developers since Zotero 7, so a port or a parity row can be checked against the version a plugin targets.

Sources: zotero.org/support/dev/zotero_{8,9,10,11}_for_developers (read 2026-11-18).

## Zotero 8 (Firefox 140 ESR)

- **New: `Zotero.MenuManager`** (`registerMenu`, `unregisterMenu`). Targets: `main/library/item`, `main/library/collection`,
  `main/tab`, `main/menubar/*`, `main/library/addAttachment`, `main/library/addNote`, `reader/menubar/*`,
  `itemPane/info/row`, `notesPane/addItemNote`, `notesPane/addStandaloneNote`, `sidenav/locate`. Entries are `menuitem` or
  `submenu` with `onShowing` and `onCommand`; menus are removed when the plugin shuts down. Zinc: `extend.register-menu`
  and the `menu-target` enum (`extend.md`).
- `.jsm` modules became `.mjs` / `.sys.mjs` (ESM, strict mode). Bluebird removed: `Zotero.Promise.map/filter/each`,
  `isResolved`, `isPending`, `cancel` are gone; `delay` and `defer` stay. `Zotero.spawn` removed.
- Firefox platform changes: `ChromeUtils.defineLazyGetter`, `addLoginAsync`, removed XPCOM interfaces.
- Preference panes get separate global scopes.

## Zotero 9

No API changes. Plugins only raise `strict_max_version` to `9.0.*`.

## Zotero 10 (Firefox 140 ESR, no platform change)

- **Multiple selection in the collection tree.** These now throw: `ZoteroPane.getCollectionTreeRow()`,
  `getSelectedLibraryID()`, `getSelectedCollection()`, `getSelectedSavedSearch()`, `getSelectedGroup()`, and the same
  `CollectionTree#getSelected*()` getters. Use the plural forms (`getCollectionTreeRows`, `getSelectedLibraryIDs`,
  `getSelectedCollections`, `getSelectedSavedSearches`). `ItemTree#collectionTreeRow` is gone: use `itemsView.viewMode`
  (`default`, `trash`, `duplicates`, `unfiled`, `feed`) or `collectionTreeRows`. The MenuManager contexts for
  `main/library/collection` and `main/library/item` give `collectionTreeRows`. Zinc: `extend.context` carries the selected
  collection-tree rows as a list.
- Items list: check `row.isObjectRow` before treating a row as an item.
- New: `item.saveTx({ undoAction })`, `Zotero.UndoHistory.stageAction()`, `Zotero.ftl.addResourceIds/removeResourceIds`,
  `Zotero.HTTP.newCookieContext()`, `Zotero.DB.loadExtension/onIdle/addCorruptionHandler`.
- Removed: `Zotero.CookieSandbox`. `Zotero.HTTP.download()` now streams and returns a `Response`.
- Search: condition groups; `fulltextWord` removed (use `fulltextContent`); `childNote` migrated to `note`.
- Database: WAL mode; full text moved to SQLite FTS5 in an attached `ftindex` database (`fulltextWords` tables dropped);
  accent-normalized shadow columns. Plugins that ran their own SQL through `Zotero.DB` break here. Zinc plugins have no
  SQL access at all: they use `library.*` queries and `library.apply`.
- Local server (port 23119): requires a localhost `Host` header.
- `strict_max_version` `10.0.*`.

## Zotero 11 (pre-release, Firefox 153)

`element.ownerGlobal` becomes `documentGlobal`; `hidden`, `collapsed`, `disabled` and similar are boolean attributes matched
on presence; the login manager is async-only; menu icons are `html:img`. Zotero asks plugin authors not to declare
Zotero 11 compatibility yet. None of this reaches Zinc plugins, which never touch the DOM or XPCOM.

## What this means for porting to Zinc

- A plugin's `strict_max_version` tells you which Zotero it was written for. Zinc ignores it.
- Calls that differ between Zotero versions (singular selection getters, `CookieSandbox`, Bluebird helpers, `.jsm` imports,
  raw `Zotero.DB` SQL against the full-text tables) all map to the same Zinc call, so a port works from one version-free API.
- Parity rows that assume one selected collection should be read as "the selected rows" (Zotero 10 behaviour).
