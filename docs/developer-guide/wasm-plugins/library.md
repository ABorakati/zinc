# WASM plugin API: library, search, batching, notifier

Area `library`. WIT: [`plugin-api/wit/library.wit`](../../../plugin-api/wit/library.wit). Phase 1 is design only. "Needs core" in a status means the WIT is written but Zinc's core (`core/src/`, `core/schema.sql`) does not serve the feature yet; that is fine for phase 1.

Sources read: Zotero `chrome/content/zotero/xpcom/data/*.js` (items, collections, searches, tags, relations, libraries, groups, notes, itemFields, cachedTypes, creators, feeds), `search` conditions (`data/searchConditions.js`, 59 conditions), `attachments.js`, `fulltext.js`, `cite.js`, `quickCopy.js`, `duplicates.js`, `notifier.js`, `db.js`, `translation/translators.js`; Zinc's `core/schema.sql`, `core/src/api-types.ts`, `docs/developer-guide/http-api.md`, `database.md`, and the earlier compat layer (`gpui-ui/src/plugins/zotero/`). `Zotero.Translate` itself and `Zotero.Utilities.Item` live in git submodules that the sparse checkout does not contain; their rows come from Zotero's public API, not from the checked-out source.

## Interfaces in `library.wit`

| Interface | Direction | What |
|---|---|---|
| `library` | import | libraries, items (query, get), collections, tags, relations, saved searches, duplicates, trash, `apply` (atomic batch) |
| `attachments` | import | attachment info, file bytes, import / link / replace / rename, Find Full Text, reader view state |
| `fulltext` | import | indexed text, index state, set content, search |
| `schema` | import | item types, fields, creator types |
| `cite` | import | styles, bibliography / citation formatting, Quick Copy |
| `translate` | import | list / run import, export, lookup, web translators |
| `sync-control` | import | sync state, start a sync |
| `data-utils` | import | dates, CSL JSON, note title, display title, `extra` parsing, identifier extraction |
| `notifier` | import | `subscribe`, `unsubscribe`, `trigger`, and the event types |
| `notifier-handler` | **export** | the plugin implements `on-events(subscription, batch)` |

`world.wit` (lifecycle) must import `library`, `attachments`, `fulltext`, `schema`, `cite`, `translate`, `sync-control`, `data-utils`, `notifier` and export `notifier-handler`. The world needs the export and the import to be different interfaces because a world cannot export and import the same interface name; that is why the callback is not inside `notifier`.

Types come from `types.wit`: `item-key`, `collection-key`, `search-key`, `library-id`, `json`, `error`, `plugin-id`, `epoch-ms`. No local error type was needed.

## 1. Parity table

Status: `covered`, `partial` (what is missing is stated), `not planned` (why, and what to do instead).

### Items and item objects (`data/items.js`, `data/item.js`, `data/dataObjects.js`, `data/dataObject.js`)

| Zotero capability | Zinc WIT | Status |
|---|---|---|
| `Zotero.Items.get/getAsync/getByLibraryAndKey(Async)` (dataObjects.js) | `library.get-items(keys, get-options)` returns item JSON | covered. Numeric `itemID` is not exposed: Zinc has none; keys are unique across libraries |
| `Zotero.Items.getAll`, `getAllIDs/Keys`, `getDeleted` | `library.query-items`, `query-keys`, scope `all` / `trash` | covered |
| `Item.getField/setField/getFields`, `getCreators/setCreators/getCreator*`, `getTags`, `getCollections`, `getRelations`, `getNote`, `getAttachments` | fields of item JSON from `get-items`; changes through `apply.update-item` | covered. A plugin edits JSON, not an object with setters |
| `Item.toJSON`, `Item.fromJSON`, `toResponseJSON` (item.js) | item JSON is the Web API `data` object | covered (see design note on version and `dateModified`) |
| `Item.saveTx`, `item.save()` inside `executeTransaction` (dataObject.js) | `library.apply` with `create-item` / `update-item` | covered |
| `Item.hasChanged`, `Item.diff`, `multiDiff` | `item-update.expected-modified` for conflict detection; diff is guest-side on JSON | partial: no diff helper |
| `Item.clone`, `Zotero.Items.copyChildItems` | `create-item` with JSON copied by the plugin; `duplicate` exists in the core (`POST /api/items/:key/duplicate`) but has no WIT call | partial: add `duplicate-item` if wanted (open question 4) |
| `Item.moveToLibrary`, `Zotero.Items.moveChildItems`, `Attachments.moveAttachmentToLibrary/copyAttachmentToLibrary` | `create-item` with `library`, then `trash-items` | partial. A real move keeps keys; Zinc keys must stay globally unique, so a move is a copy plus trash. Needs core for files |
| `Item.isRegularItem/isNote/isAttachment/isTopLevelItem/isInTrash/isAnnotation`, `topLevelItem`, `Zotero.Items.getTopLevel/keepTopLevel/keepParents` | `itemType`, `parentItem`, `deleted` in JSON; `item-summary.parent-key`, `in-trash` | covered, guest-side helpers |
| `Item.numChildren/numNotes/numAttachments/numAnnotations` | `item-summary.attachment-count`, `note-count`; `get-children` | covered (annotation count: see reader) |
| `Item.getDisplayTitle`, `getTabTitle` | `data-utils.display-title` | covered (tab title is UI) |
| `Item.getNoteTitle`, `Zotero.Notes.noteToTitle` | `data-utils.note-to-title` | covered |
| `Item.setNote`, note HTML | `note` field of item JSON in `apply` | covered |
| `Zotero.Items.getFirstCreatorFromJSON/FromData`, `getSortTitle` | `data-utils.first-creator`, `sort-title` | covered |
| `Item.addRelatedItem/removeRelatedItem`, `getRelations`, `addRelation`, `removeRelation`, `setRelations` | `apply.add-related` / `remove-related`; `relations` in item JSON | covered for items. Zinc's core only knows `dc:relation` as a UI concept but stores `relations` JSON verbatim |
| `Zotero.Relations.getByPredicateAndObject/getByObject` (relations.js) | `library.find-by-relation` | partial. Needs core: no relation index (JSON in `items.data`) |
| `Item.getLinkedItem/addLinkedItem`, `Collection.getLinkedCollection` | `relations` (`owl:sameAs`) in JSON; `find-by-relation` | partial: no direct helper, same core gap |
| `Zotero.Items.addToPublications/removeFromPublications`, `Item.setPublications` | `apply.add-to-publications`, `remove-from-publications`; scope `publications` | partial. Core lists publications (`publications=1`) but has no write route |
| `Item.getExtraField`, `Zotero.Utilities.Internal.extractExtraFields` | `data-utils.parse-extra` | covered |
| `Item.getUsedFields`, `getFieldsNotInType`, `setType` | JSON edit and `schema.get-schema` | covered (type change by `update-item` with new `itemType`; core must drop invalid fields: needs core check) |
| `Item.getImageSrc`, `getItemTypeIconName` | UI | not planned here: icons belong to the ui area |
| `Item.migrateExtraFields`, `updateCreatedByUser` | internal migration | not planned: Zotero upgrade code, not a plugin API |
| `Zotero.Items.getLastRead/getLastReadAttachmentIDs/clearAllLastRead`, `Item.getItemLastRead` | `attachment-info.last-read` | partial. Needs core: no `lastRead` column |
| `Zotero.Items.findMissingLinkedFiles`, `numDistinctFileAttachmentsForLabel` | `query-items` plus `attachments.get-info` (`file-exists`) | partial: no single call |
| `Zotero.Items.merge`, `Zotero.Duplicates.findAll/find/findAllInSet`, `getSearchObject` | `library.merge-items`, `find-duplicates` | covered |
| `Zotero.Duplicates` "not a duplicate" marks | `library.mark-not-duplicates` | covered |
| `Zotero.Items.trash/trashTx`, `Item.deleted = true` | `apply.trash-items` | covered |
| `Item.deleted = false` (restore), `Zotero.Items.undoTrash` | `apply.restore-items` | covered |
| `Item.erase/eraseTx`, `Zotero.Items.erase` | `apply.erase-items` (must be trashed first) | covered |
| `Zotero.Items.emptyTrash`, `purge` | `library.empty-trash` | covered. `purge` (orphan value cleanup) is internal |
| `Zotero.Items.hasDeleted`, trash listing | `query-items` with scope `trash` | covered |
| `item.version`, `synced`, `dateModified` handling, `skipDateModifiedUpdate` | `version` and `dateModified` in JSON; host stamps `dateModified` on every change | partial: no `skipDateModifiedUpdate`; a plugin cannot back-date (by design, see notes) |
| Item types used by plugins: annotation items (`getAnnotations`, `isAnnotation`, `Zotero.Items.get(annotationID)`) | none in this area | partial: annotations are reader data in Zinc (`annotations` table). `reader.wit`'s `annotations` interface is the only route (typed, batched, with the same field names); `get-items`, `query-items` and `apply` answer `invalid-argument` for an annotation key |

### Collections (`data/collections.js`, `data/collection.js`)

| Zotero capability | Zinc WIT | Status |
|---|---|---|
| `Zotero.Collections.getByLibrary/getByParent/get` | `library.list-collections` | covered |
| `Collection.getChildCollections/getDescendents`, `hasChildCollections` | `list-collections` (`parent`) | covered, guest-side |
| `Collection.getChildItems/hasChildItems/hasItem/hasDescendent` | `library.get-collection-items(key, recursive)`; scope `collection` | covered |
| `Collection.name = / parentID = / saveTx` | `apply.create-collection`, `update-collection` | covered |
| `Collection.addItem(s)/removeItem(s)` | `apply.add-to-collection`, `remove-from-collection` | covered |
| `Collection.erase / eraseTx`, `deleteItems` | `apply.erase-collection(trash-items)` | covered |
| `Collection.trash`, collections in the trash (Zotero 7), `Zotero.Collections` deleted flag | none | partial: Zinc deletes collections for good (`core/schema.sql` has no deleted flag). Needs core |
| `Collection.toJSON/fromJSON`, `serialize` | `collection-info` | covered (record, not JSON) |
| `Zotero.Collections.getRecent/addToRecent`, `registerChildCollection` | UI state | not planned: UI cache and recent-list for the collection picker |
| Collection relations | `relations` not on `collection-info` | partial. Needs core: collections have no relations column |
| `Collection.version`, sync fields | `collection-info.version` | covered |

### Tags (`data/tags.js`)

| Zotero capability | Zinc WIT | Status |
|---|---|---|
| `Zotero.Tags.getAll/getAllWithin/getTagItems` | `library.list-tags(library, within)`; `query-items` with `tags` | covered |
| `Item.addTag/removeTag/setTags/hasTag/replaceTag/removeAllTags`, tag type | `apply.add-tags`, `remove-tags`, `update-item.patch.tags`; `tag-kind` | covered |
| `Zotero.Tags.rename` | `library.rename-tag` | covered |
| `Zotero.Tags.removeFromLibrary`, `removeAutomaticFromLibrary`, `purge` | `library.delete-tags`, `delete-automatic-tags` | covered |
| `Zotero.Tags.getColor/getColors/setColor/getColorByPosition`, `toggleItemsListTags` | `library.get-tag-colors`, `set-tag-colors` | partial: colour list only. Emoji tags and `emojiTag` flags are UI display, left to ui |
| `Zotero.Tags.extractEmojiForItemsList`, `compareTagsOrder`, `equals`, `cleanData` | n/a | not planned: display and string helpers; the plugin can reimplement |

### Saved searches and searching (`data/search.js`, `searches.js`, `searchConditions.js`, `quicksearch`)

| Zotero capability | Zinc WIT | Status |
|---|---|---|
| `Zotero.Search.addCondition(name, operator, value, required)`, `getConditions`, `setScope`, `fromJSON/toJSON` | `search-definition` / `search-condition` | partial. The record carries any of Zotero's 59 condition names, but the core compiler (`core/src/searches/compile.ts`) supports a subset (title, creator, year, date fields, publicationTitle, itemType, tag, collection, note, attachmentFileType, fulltextContent, anyField, schema fields; no `groupStart/groupEnd`, `numberfield`, `lastRead`, `annotation*`, `retracted`, `tempTable`). Needs core |
| `Zotero.Search.search()` (item ids), `getSQL` | `library.query-items` / `query-keys` with `search` | covered for supported conditions; `getSQL` is `not planned` (no SQL) |
| `joinMode any/all`, `includeParentsAndChildren`, `recursive`, `noChildren`, `includeDeleted`, `required` | `search-options`, `search-condition.required` | covered |
| `Zotero.Search.setScope(search)` (search within search) | `item-query.scope = saved-search` plus `search` | partial: nesting one saved search in another via a `savedSearch` condition is not in the core |
| `Zotero.SearchConditions.getStandardConditions/getLocalizedName` | `library.list-search-conditions` | covered |
| `Zotero.Searches.getAll/getByLibrary/get`, `getNextName` | `library.list-saved-searches`, `get-saved-search` | covered |
| `Search.name = / saveTx / erase` | `apply.create-saved-search`, `update-saved-search`, `erase-saved-search` | covered |
| Quick search modes (`quicksearch-titleCreatorYear/fields/everything`, `Zotero.Search` quick) | `item-query.text` with `text-mode` | covered |
| `Zotero.Search.hasPostSearchFilter`, `tempTable` condition | n/a | not planned: internal SQL planner |
| Search results with `resultLevel`, `fulltextContent` | `item-query.search`, `fulltext.search` | partial: `resultLevel` is not in the core |
| Aggregates (`SELECT ... GROUP BY`) written by plugins in SQL | `library.facets` | partial: one grouping field per call, listed fields only |

### Libraries and groups (`data/libraries.js`, `library.js`, `groups.js`)

| Zotero capability | Zinc WIT | Status |
|---|---|---|
| `Zotero.Libraries.getAll/get/exists/getName/getType`, `isEditable`, `isFilesEditable`, `hasTrash` | `library.list-libraries` → `library-info` | covered |
| `Zotero.Groups.getAll/get/getByLibraryID`, `getGroupIDFromLibraryID`, `getPermissionsFromJSON` | `library-info.group-id`, `editable`, `files-editable` | covered |
| `Zotero.Libraries.getVersion/setVersion/getLastSyncTime`, `Library.updateLastSyncTime`, `incrementClientVersion` | n/a | not planned: sync internals. Use `sync-control.get-state` |
| `Library.hasItems/hasCollections/hasSearches`, `waitForDataLoad`, `getDataLoaded` | n/a | not planned: Zinc has no lazy data loading phases; calls always see the data |
| `Library.saveTx/eraseTx`, `Zotero.Groups.register` (create/delete libraries) | n/a | not planned: libraries are created by sync from zotero.org, not by plugins |
| `Zotero.Libraries.userLibraryID`, `Zotero.Groups` selected library | `library-id` 1 | covered |

### Schema and types (`data/itemFields.js`, `cachedTypes.js`, `creators.js`)

| Zotero capability | Zinc WIT | Status |
|---|---|---|
| `Zotero.ItemTypes.getAll/getName/getID/getTypesForItemType`, `getLocalizedString` | `schema.get-schema` | partial: English labels only. Localized labels need the host's l10n (lifecycle) |
| `Zotero.ItemFields.getAll/getName/getItemTypeFields/getBaseMappedFields/isValidForType/isBaseField`, `isDate/isLong/isMultiline/isAutocompleteField` | `schema.field-info` (`base-field`, `is-date`, `is-long`, `is-multiline`) | partial. Needs core: `/api/schema` has no `is-*` flags; the host can hardcode them. Autocomplete flag omitted |
| `Zotero.CreatorTypes.getTypesForItemType/getPrimaryIDForType`, `isValidForItemType` | `schema.creator-type-info` | covered |
| `Zotero.ItemTypes.add`, custom types and fields (`isCustom`) | n/a | not planned: Zinc follows Zotero's schema. A plugin stores its own data in `extra`, relations or its private storage (lifecycle) |
| `Zotero.Creators.get/getIDFromData/getItemsWithCreator/countItemAssociations/updateCreator`, `Creators.cleanData` | n/a | not planned: Zinc stores creators inside item JSON, with no creator table. Rename a creator across items with `query-items` (condition `creator`) plus `apply.update-item` |
| `Zotero.DataObjectUtilities`, `Zotero.CollectionTreeRow` | n/a | not planned: Zotero UI internals |

### Attachments (`attachments.js`, item.js attachment methods)

| Zotero capability | Zinc WIT | Status |
|---|---|---|
| `Item.getAttachmentLinkMode/MIMEType/Charset`, `isPDFAttachment`, `isFileAttachment`, `isLinkedFileAttachment`, `isImportedAttachment`, `isSnapshotAttachment`, `isEPUBAttachment`, `getFilename`, `fileExists`, `getAttachmentLastPageIndex` | `attachments.get-info` → `attachment-info` | partial: `charset` and `last-read` need core |
| `Item.getFilePath/getFilePathAsync/getFile` | `attachment-info.path` (permission `library.files.paths`) | covered, permission-gated |
| `Attachments.getStorageDirectory(ByID/ByLibraryAndKey)`, `createDirectoryForItem`, `createTemporaryStorageDirectory`, `fixPathSlashes`, `getBaseDirectoryRelativePath`, `resolveRelativePath` | n/a | not planned: a plugin has no file system. Ask the host to read, write, import or rename instead |
| `Attachments.hasMultipleFiles/getNumFiles/getTotalFileSize` | `attachments.storage-of` | covered |
| `Attachments.importFromFile` | `attachments.import-bytes`, `file-writer` | covered. A plugin passes bytes, not a path |
| `Attachments.linkFromFile`, `linkFromFileWithRelativePath` | `attachments.link-file` | covered (path permission) |
| `Attachments.importFromURL`, `downloadFile`, `importSnapshotFromFile` | `attachments.import-from-url` | covered. Network permission applies |
| `Attachments.linkFromURL` | `attachments.link-url` | covered |
| `Attachments.importFromDocument`, `linkFromDocument`, `importFromSnapshotContent`, `importEmbeddedImage`, `copyEmbeddedImage` | `import-bytes` with HTML bytes | partial: no DOM `document`; embedded note images have no WIT call and the core does not store them separately. Needs core |
| `Attachments.importFromNetworkStream`, `createURLAttachmentFromTemporaryStorageDirectory` | n/a | not planned: Firefox network stream internals |
| `Item.renameAttachmentFile`, `Attachments.getFileBaseNameFromItem`, `getAttachmentRenameTemplate`, `shouldAutoRenameFile`, `isAutoRenameFilesEnabledForLibrary`, rename setting | `attachments.rename-file`, `rename-by-template` | partial: template read and auto-rename settings are prefs; the `prefs` interface (lifecycle) should expose them |
| `Item.relinkAttachmentFile`, `deleteAttachmentFile` | `attachments.relink-file`, `delete-file` | covered |
| `Attachments.convertLinkedFileToStoredFile` | `read-file` + `import-bytes` + trash | partial: no single call. Needs core |
| `Item.getBestAttachment(s)`, `getBestAttachmentState` | `attachments.best-attachment`, `best-attachments`; `item-summary.best-attachment` | covered |
| `Attachments.getFileResolvers/getPDFResolvers`, `addAvailableFile(s)`, `addAvailablePDF(s)`, `canFindFileForItem`, `downloadFirstAvailableFile`, `addFileFromURLs` | `attachments.find-available-files`, `get-find-job`, `cancel-find-job` | partial: Zinc has one fixed resolver chain (Unpaywall, Europe PMC, institution). A plugin cannot add a resolver |
| Attachment file write by plugin (`OS.File.writeAtomic` on the storage path, used by PDF tools) | `attachments.replace-file` | covered |
| `Zotero.launchFile`, `ZoteroPane.showAttachmentInFilesystem` | `attachments.open-file-external`, `reveal-file` | covered |
| `Attachments.isPDFJSDocument/isPDFJSBrowser`, `linkModeToName/FromName` | `link-mode` enum | covered |
| `Item.setAttachmentLastPageIndex`, reader view state file | `attachments.get-view-state`, `set-view-state` | covered (the stored copy of the JSON that `reader.reader-state.primary-view-state` holds while a reader is open; the reader owns the format) |

### Full text (`fulltext.js`)

| Zotero capability | Zinc WIT | Status |
|---|---|---|
| `Zotero.Fulltext.getIndexedState/isFullyIndexed/getPages`, `getIndexStats` | `fulltext.get-index-state` | partial: no page counts, no stats. Needs core |
| Read `.zotero-ft-cache` / indexed content | `fulltext.get-content` | covered |
| `Fulltext.setItemContent`, custom indexing by plugins | `fulltext.set-content` | partial. Needs core: `fulltext.source` accepts only `zotero-cache` and `document-worker`; add `plugin` |
| `Fulltext.indexItems`, `indexDocument/indexPDF/indexEPUB`, `rebuildIndex`, `reindexTruncated`, `queueItem` | `fulltext.reindex` | partial. Needs core: no reindex route |
| `Fulltext.findItemsWithContent`, `findTextInItems`, `getContentSearchSQL` | `fulltext.search`; `fulltextContent` search condition | partial: FTS5 (stemmed) rather than Zotero's word index; results differ |
| `Fulltext.getAttachmentIndexQueueCount`, `processAttachmentIndexQueue`, etc. | `fulltext.get-queue-status` | partial: counts only |
| `Fulltext.canIndex`, `getItemCacheFile`, `semanticSplitter`, converter paths, sync content (`getUnsyncedContent`, `processSyncedContent`, `registerSyncContentProcessor`), `clearItemWords`, `vacuum`, `optimizeContentIndex` | n/a | not planned: Zotero's own index internals and its full-text sync. Zinc uses SQLite FTS5 |

### Raw database (`db.js`)

| Zotero capability | Zinc WIT | Status |
|---|---|---|
| `Zotero.DB.queryAsync/valueQueryAsync/rowQueryAsync/columnQueryAsync/queryTx` (read) | `library.query-items`, `query-keys`, `count-items`, `facets`, `list-tags` | not planned for raw SQL; see design note 3. Common read cases covered by the query interface |
| `Zotero.DB.queryAsync` writes (UPDATE/INSERT/DELETE), `executeSQLFile` | `library.apply` | not planned for raw SQL writes. Writing around the data layer breaks the sync outbox triggers, the FTS and quick-search indexes and migrations |
| `Zotero.DB.executeTransaction`, `inTransaction`, `requireTransaction`, `waitForTransaction`, `Zotero.DB.transactionTimestamp` | `library.apply` (one atomic batch) | covered. No interactive transactions: a transaction cannot span calls, so one cannot hold the write lock across a process boundary |
| `Zotero.DB.tableExists/columnExists/indexExists/getColumns`, `vacuum`, `backupDatabase`, `integrityCheck`, `addCallback`, `observe`, `loadExtension`, corruption handlers, `closeDatabase` | n/a | not planned: Zotero schema and storage engine specifics |
| `Zotero.DataDirectory` paths for the database | n/a | not planned: a plugin must not name library files; also unsafe |

### Notifier (`notifier.js`)

| Zotero capability | Zinc WIT | Status |
|---|---|---|
| `Zotero.Notifier.registerObserver(ref, types, id, priority)` | `notifier.subscribe(subscription)` + export `notifier-handler.on-events` | partial. Needs core: no change feed. Today only this layer's own writes are seen (see notes). Decided 2026-11-18: the core gets a change log in phase 2 |
| `ref.notify(event, type, ids, extraData)` | `event` record: `object`, `kind`, `ids`, `extra` | covered |
| `unregisterObserver(id)` | `notifier.unsubscribe` | covered |
| Types: collection, search, item, file, collection-item, item-tag, tag, group, trash, relation, setting, sync, share, share-items, bucket, api-key, feed, feedItem | `object-type` enum | covered as names. Events fire only for data Zinc has: no `share`, `share-items`, `bucket`, `api-key`, `feed`, `feed-item` events (no such features): partial |
| UI types `tab`, `itemtree`, `itempane`, `infobox` | none in `object-type`. Tab changes (with selection, view and theme changes) arrive once, from `extend.subscribe-events`; the other three are internal refresh signals | partial: tab events are in `extend`; `itemtree`, `itempane`, `infobox` are not planned |
| Events add, modify, delete, move, remove, refresh, redraw, trash, restore, index | `event-kind` | covered. `unreadCountUpdated`, `pageChange` (file) and `open` (file) belong to feeds / reader: not planned for feeds, reader area for the rest |
| Transaction merging, `Notifier.begin/commit/queue`, `skipNotifier`, `skipSelect`, `skipAutoSync` | batches merge per `apply` / flush; `apply-options.skip-notify`; `event.options` | partial: `skipSelect` is UI; plugins cannot open notifier transactions (`begin/commit` not planned) |
| Priority ordering of observers | `subscription.priority` | covered |
| `Notifier.trigger` by plugins (custom events) | `notifier.trigger` for `other` and UI types only | partial: by design a plugin cannot forge `item` events |
| `Notifier.getLeakedObserverIDs` | n/a | not planned: window leak debugging |

### Cite, Quick Copy, Translate, Sync, utilities

| Zotero capability | Zinc WIT | Status |
|---|---|---|
| `Zotero.Styles.getAll/getVisible/get`, `Zotero.Style.getXML` | `cite.list-styles`, `get-style-xml` | covered |
| `Zotero.Styles.install`, `Style.remove` | `cite.install-style`, `remove-style` | partial: install by repository id only; no install from XML text (core installs from zotero.org; add `install-style-xml`) |
| `Zotero.Cite.makeFormattedBibliographyOrCitationList`, `Zotero.QuickCopy.getFormattedNameFromSetting`, `Style.getCiteProc()` | `cite.format` | partial: output html / text / rtf / note citation markup (`note-citation`, for `note-editor.insert-html`), locator, prefix, suffix, suppress-author supported; a plugin cannot get the citeproc engine object, nor use footnote or `integration` callbacks |
| `Zotero.QuickCopy.getContentFromItems`, `getNoteFormat`, `getFormatFromURL`, `annotationsToNote`, site settings | `cite.quick-copy`, `get-quick-copy-settings` | partial: no per-site format rules, no export-translator Quick Copy format, no annotation to note. Needs core |
| `Zotero.Cite.System` (retrieveItem, getAbbreviation), `Zotero.Cite.getLocatorString` | n/a | not planned: citeproc engine glue. Plugin can ship its own citeproc and feed it CSL JSON from `data-utils.item-to-csl-json` |
| `Zotero.Translators.getAllForType/get/getWebTranslatorsForLocation/getImportTranslatorsForLocation` | `translate.list-translators` | partial: the web translators-for-URL matching is not exposed |
| `Zotero.Translators.save/load/loadFromFile` (install a translator) | n/a | not planned in phase 1: arbitrary translator JS would run in the core's translator sandbox, outside the plugin sandbox. Open question 5 |
| `Zotero.Translate.Import` (`setString`, `setTranslator`, `translate`) | `translate.import-text` | covered |
| `Zotero.Translate.Export` | `translate.export-items` | covered (text output only; binary output formats are not returned: partial) |
| `Zotero.Translate.Search` (lookup by identifier) | `translate.lookup` | covered for DOI, PMID, PMCID, arXiv, ISBN (what Zinc's lookup resolves); other search translators: partial |
| `Zotero.Translate.Web`, `HiddenBrowser`, `Zotero.Translate.ItemSaver`, translator callbacks (`setHandler`, `select`) | `translate.web`, `web-select` | partial: choose-then-select flow only. No DOM `Document` hand-over, no custom item saver or handlers |
| `Zotero.Sync.Runner.sync()`, `Runner.running`, `Sync.Runner.addListener` | `sync-control.sync-now`, `get-state`; notifier type `sync` | covered |
| `Zotero.Sync.Data`, `Sync.Storage`, `Sync.Server`, `Zotero.SyncedSettings` | n/a | not planned: sync engine internals. Plugin data syncs through item JSON `relations` or `extra`, or not at all |
| `Zotero.Date.strToDate`, `strToISO`, `sqlToDate`, `dateToSQL`, `multipartToStr`, `getLocaleDateOrder` | `data-utils.parse-date`, `to-iso-date`, `display-date` | partial: the three common ones; SQL date helpers are pure and a plugin can use its own date library. Locale date order: ui/lifecycle l10n |
| `Zotero.Utilities.Item.itemToCSLJSON`, `itemFromCSLJSON` | `data-utils.item-to-csl-json`, `item-from-csl-json` | covered (`item-from-csl-json` needs core: no CSL to item mapper outside import) |
| `Zotero.Utilities.extractIdentifiers`, `cleanDOI`, `cleanISBN`, `isDOI` | `data-utils.extract-identifiers` | covered for extraction. Cleaning is guest-side |
| `Zotero.Utilities` string, HTML and XML helpers (`trim`, `cleanTags`, `capitalizeTitle`, `xpath`, `parseURL`) | n/a | not planned: generic code; ship it in the plugin |
| Feeds: `Zotero.Feeds`, `FeedItems`, `Feed`, `FeedReader` | n/a | not planned: Zinc has no RSS feeds feature. A plugin can fetch a feed with the lifecycle's network permission and create items with `apply` |
| `Zotero.Retractions`, `Zotero.Report`, `Zotero.Timeline` | n/a | not planned: retraction checks and reports are features of Zotero itself; plugins read the `retracted` search condition when it exists (needs core) |

Counts (rows in the tables above, counted by script): covered 69, partial 39, not planned 25.

## 2. Design notes

1. **One write call, `library.apply`.** Zotero writes with `item.saveTx()`, `Zotero.DB.executeTransaction(async () => {...})` and many small awaits. Each await would be a process crossing, and an interactive transaction (read, decide, write while holding the lock) would let a stuck plugin hold the library write lock. Instead a plugin sends a list of `change`s and the core runs them in one SQLite transaction in order, all or nothing, and answers with the new keys. `new-keys` lets a plugin link objects it creates in the same batch (parent and child, collection and member) without a round trip. Conflicts use optimistic concurrency (`expected-modified`) in place of `hasChanged`. Failure reports the change index.
2. **Items are JSON, lists are cheap.** Item data travels as Zotero Web API item JSON because the core stores it that way (`items.data`) and every guest language has a JSON parser; the open-ended field set needs no WIT change when Zotero adds fields. Lists use `item-summary` records with opt-in `fields` and `expand` flags, so item tables do not cost a call per row. `get-items` takes many keys, and `get-summaries(keys, fields, expand)` returns the cheap summary form with a field list for many keys (the call the extend area's custom columns, menu contexts and row styles use after they receive item keys). There is no object with setters and no handle, so there is nothing to keep alive across the boundary and nothing to leak.
3. **Raw SQL: not planned.** Reasons: Zinc's tables are not Zotero's (no `itemData`, `itemDataValues`, `itemAttachments`; items are JSON); `core/schema.sql` changes through migrations that plugins would break; writes would bypass the sync outbox triggers and the FTS5 and quick-search indexes; reading `data` JSON in SQL ties plugins to storage details. What covers the common plugin SQL: finding items by field value or date (`query-items` with conditions); counts by tag, type, year, creator (`facets`, `list-tags`); membership (`get-collection-items`); full-text hits (`fulltext.search`); relations (`find-by-relation`). Open question 1 proposes a read-only view schema for later.
4. **Notifier delivery.** `subscribe` is a host import; delivery is the exported `on-events(subscription, batch)`. The host coalesces events (default 50 ms window, max 1 s) and merges ids per `(object, kind)` as Zotero does when it commits a transaction, so a 5,000-item import is a few calls, not 5,000. One batch is in flight per subscription; the queue is bounded (256), and overflow turns into a `refresh` event so a plugin re-reads instead of trusting a stream with holes. `origin` is new and lets a plugin ignore its own writes; Zotero code uses ad-hoc flags for that. `on-events` returns nothing, so the host never waits on plugin code and a slow plugin only slows itself. A plugin that needs a full rescan after downtime uses `refresh` plus its own stored "last seen" marker (storage is a lifecycle matter).
5. **What the notifier sees today.** The old compat layer saw only changes made through itself and the UI. The core has a `sync_outbox` fed by triggers, but those are suppressed while sync applies remote changes and rows are de-duplicated, so they are not a change feed. Phase 2 needs a core change log: a table fed by unsuppressed triggers with `seq`, object type, key, kind, `origin` and library, plus an HTTP or in-process stream. SQLite `data_version` (already used by `/api/ui/selection`) can detect changes by other processes and produce a `refresh`.
6. **Permissions.** Declared in the manifest, enforced per call; the proposed ids are `library.read`, `library.write`, `library.trash` (move to trash, restore), `library.erase` (permanent delete, empty trash, delete a collection or saved search), `library.files.read` (file bytes), `library.files.write` (import, replace, rename, delete files, Find Full Text), `library.files.paths` (see or give absolute paths; also needed for `link-file` and `relink-file`), `library.files.open` (reveal, open externally), `library.fulltext.read`, `library.fulltext.write`, `library.cite`, `library.cite.styles`, `library.translate`, `library.sync`. `import-from-url` and `translate.web` need the lifecycle network permission for the target host. A plugin gets no notifier event for objects it could not read. The default install prompt should group them: read-only, edit library, files, dangerous (erase).
7. **File access without a file system.** Bytes cross the boundary, not paths. Reads are chunked (8 MiB per call, 64 MiB whole-file cap), writes take bytes up to 64 MiB or stream through the `file-writer` resource, the one `resource` here, because a partly written upload needs a handle with a lifetime. Absolute paths are hidden unless `library.files.paths` is granted, since paths contain the user's name and a plugin could otherwise recover it.
8. **Rust and JS ergonomics.** Plain records, variants and lists; no callbacks except `on-events`. `option<option<collection-key>>` in `collection-update.parent` is the one awkward type; it gives "unchanged" versus "move to top level" and could become a `variant` in a later revision. Names avoid WIT keywords (`include`, `from`, `import`, `export`, `type` were renamed: `expand`, `old-name`, `importer`, `exporter`, `object`).
9. **Keys, not IDs.** Zotero plugins use numeric `itemID`. Zinc has no numeric item id, and keys are unique across libraries. Plugin code written for Zotero that stores `itemID` must store keys.
10. **No object model for search.** `Zotero.Search` is a stateful builder. Here a search is a `search-definition` value, used inline in `item-query` or saved with `create-saved-search`. The condition name set is Zotero's, so documented plugin searches port; the host answers `invalid-argument` for conditions it cannot compile.

## 3. Open questions for the user

1. Offer a read-only SQL interface later over a stable view schema (`items`, `fields`, `creators`, `tags`, `collections`), for plugins that need ad-hoc analytics? It would be versioned and independent of the real tables. Phase 1 says no.
2. Should permissions be scoped to a library (My Library only, or chosen groups), or to a collection? The WIT takes `library` arguments everywhere, so the host can enforce either.
3. Should `erase` (permanent delete) be allowed to plugins at all, or only trash? Zotero plugins can erase. Proposal: allowed behind `library.erase` with a visible prompt.
4. Add `duplicate-item`, `move-item-to-library`, and `convert-to-stored-file` as first-class `change` variants? They exist in Zotero and the core has duplicate already.
5. Translators: run a plugin-supplied translator (JS) in the core's translator sandbox, or only existing ones? The second is what the WIT offers.
6. Cap values (query page 1000, file read 8 MiB, upload 64 MiB, event queue 256) are guesses; confirm.
7. Should plugin writes mark `dateModified` as a plugin change in a way the sync layer can show to the user (an audit trail of what each plugin changed)?

## 4. Needs from other areas

Resolved in the reconcile of 2026-11-18 (see README): `world.wit` imports and exports every interface of this file; `types.wit` has `item-ref` and the one `color`; the permission ids of design note 6 are in the manifest schema; the notifier no longer has `tab`, `itemtree`, `itempane`, `infobox`; the view state JSON has one owner (reader), with `attachments.get-view-state` as its stored copy; `get-summaries` was added for extend; `cite.format` has the `note-citation` output for reader; annotation items go through `annotations` only; `fulltext.get-content` (whole document, indexed) and `reader.get-page-text` (pages of an open reader) both stay.

Still open:

- **lifecycle (prefs):** the attachment rename template, auto-rename setting and Quick Copy settings are Zotero prefs; `prefs.get-app` should let a plugin read them (`extensions.zotero.autoRenameFiles`, `export.quickCopy.setting`). Part of the app prefs allowlist question.
- **reader:** file-open events (Zotero's `file` notifier type, `open`, `pageChange`) come from `reader.subscribe` (`opened`, `page-changed`), not from the notifier. Relations on annotations (reader.md row 81) are not served by `library.find-by-relation`: open, needs a decision with the reader area.
- **ui:** item and collection icons, emoji tags, and "select this item" (`ZoteroPane.selectItem`) are `extend.select-items`; item and collection icons and emoji tags have no call yet. Open.
- **Core features missing (phase 2)**: change log and event stream; atomic batch route (`POST /api/batch`); relation index and collection relations; collection trash; `lastRead`; charset and `source = plugin` for full text; reindex route; search compiler coverage (groups, number fields, `lastRead`, annotation conditions, `retracted`); schema flags; publications write; item duplicate and library move in the batch.

