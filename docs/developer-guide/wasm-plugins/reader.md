# WASM plugin API: reader, annotations and the note editor

Phase 1 (design only). Owner: the `reader` area. WIT: `plugin-api/wit/reader.wit`. It holds five interfaces:

| Interface | Direction | Holds |
|---|---|---|
| `annotations` | import | annotation items: list, get, create, update, remove, images, embedded-annotation import |
| `reader` | import | open readers, navigation, state, selection, page text, themes, registration of slots, menus, panels, overlays, link interceptors |
| `note-editor` | import | editor instances, insert content, embedded images, note from annotations, the editor head strip |
| `reader-events` | export | `build-menu`, `on-menu-command`, `render-overlay`, `on-overlay-click`, `on-link`, `on-reader-event` |
| `note-events` | export | `on-note-event` |

`world.wit` (lifecycle) already imports `annotations`, `reader`, `note-editor` and exports `reader-events`, `note-events`. Nothing else is needed there.

Sources read for this report (all current main unless noted):

- `chrome/content/zotero/xpcom/reader.js` (event registry at lines 2693-2770; `ReaderInstance`, `ReaderTab`, `Reader`).
- `chrome/content/zotero/xpcom/annotations.js`, `xpcom/data/notes.js`, `elements/noteEditor.js`, `contextPane.js`, `xpcom/pluginAPI/menuManager.js`, `itemPaneManager.js`.
- `xpcom/editorInstance.js` (from github.com/zotero/zotero main; it is not in the sparse checkout).
- The reader iframe's source, from Zinc's own vendored clone `vendor/reader/src/` (the code that fires the events): `common/context-menu.js`, `common/components/common/custom-sections.js`, `common/reader.js`, `common/types.ts`, `pdf/pdf-view.js`, `dom/epub/epub-view.ts`.
- `windingwind/zotero-plugin-toolkit` `src/tools/reader.ts` (fetched; it has `getReader`, `getWindowReader`, `getSelectedAnnotationData`, `getSelectedText`).
- Zinc: `gpui-ui/src/reader/plugins.ts`, `reader/annotations/*`, `reader-host/`, `note-host/`, and the compat layer `gpui-ui/src/plugins/managers/reader.tsx` with `docs/developer-guide/zotero-plugins.md` from the `zotero-plugins` worktree.

Statements about what real plugins do come from the compat doc's corpus table and the toolkit source, not from reading each plugin's code.

## What Zotero offers, in one page

1. **Event registry.** `Zotero.Reader.registerEventListener(type, handler, pluginID)`. The reader iframe dispatches a `customEvent` on its window; `reader.js:255-264` adds `reader` to it and hands it to the registry. Nine types are fired by the reader source; the typedef at `reader.js:2693` lists eight (it omits `createThemeContextMenu`).
   - Three `render*` events (`renderToolbar`, `renderTextSelectionPopup`, `renderSidebarAnnotationHeader`). The handler gets `{ reader, doc, params, append }` and calls `append(...domNodes)` synchronously. `CustomSections` runs them in a React effect with no dependency list, so they run again on every render of that component.
   - Six `create*ContextMenu` events. The handler calls `append(...items)` where an item is `{ label, disabled, checked, color, onCommand, groups }`. Each `append` call is one item group; groups are separated by a line.
2. **Reader instances.** `Zotero.Reader._readers`, `getByTabID`, `open`, `openURI`, `openPreview`, `getSavedPageLabel`. A `ReaderInstance` has `type`, `itemID`, `tabID`, `_item`, `_window`, `_iframeWindow`, `_internalReader`, `getCurrentPage()`, `navigate()`, and a Proxy that forwards unknown properties to `_internalReader`.
3. **The internal reader** (`vendor/reader/src/common/reader.js`, about 100 public methods and a `_state` object). Plugins reach it as `reader._internalReader`. It is a private API; Zotero changes it between releases.
4. **The iframe.** `reader._iframeWindow` is the PDF.js or DOM-reader page itself. Plugins listen to `keydown`/`pointerup` on it, read `getSelection()`, and use `wrappedJSObject.PDFViewerApplication`.
5. **Annotations.** `Zotero.Annotations` (`annotations.js`) plus annotation items (`itemType: annotation`, parent = a file attachment).
6. **Notes in the reader context.** `ZoteroContextPane.activeEditor`, `EditorInstance.insertAnnotations`, `NoteEditor.renderCustomHead`, `Zotero.Notes.*`, and the `notesPane/*` menu targets.

## Zinc's reader today (why the WIT looks as it does)

- **PDF** is read natively (PDFium) in `gpui-ui/src/reader/`. It has its own in-process plugin contract, `reader/plugins.ts`: `toolbar`, `sidePanel`, `pageOverlay`, `selectionPopup`, `altView`, `onKey`, `onOpen`, `handlesRotation`. On the `zotero-plugins` branch it also has `annotationMenu`, `annotationHeader`, `viewMenu`, `thumbnailMenu`, `unregisterReaderPlugin`, `pluginMenuItems` and `openReaders`. The `wasm-plugins` branch, cut from `main`, does not have those five yet.
- **EPUB and snapshots** run in Zotero's own web reader, in a WebView2 popup (`reader-host/`, `WebTabView.tsx`). That reader fires the same `customEvent`s as Zotero's.
- **Annotations** use Zotero's annotation JSON, stored by the core (`GET/PUT/DELETE /api/attachments/:key/annotations`) and written into Zotero's database. Zinc's PDF tools today: highlight, underline, note, ink, eraser. Image and text annotations are in the model but have no tool yet.
- **No split view, no Read Aloud, no theme registry** (the PDF appearance has modes `normal`, `dark`, `sepia`, `custom`, `reading`). The WIT includes these so plugins can be written against Zotero's feature set; the host answers `unavailable` where Zinc lacks it.
- **The note editor** is Zotero's own `note-editor` build in a WebView2 popup laid over a placeholder box (`note-host/`, `itempane/RichNote.tsx`).

## Parity table

Status means: `covered` = the WIT gives a plugin the capability. `partial` = the WIT gives most of it; the gap is stated. `not planned` = deliberately left out; the reason and the alternative are stated. A `covered` row can still be unavailable in a given Zinc build (for example split view); the "Zinc WIT" column says so when it matters.

Names in the WIT column are `interface.function` or `interface.type`.

Totals over the 105 rows (counted by script after the reconcile): 73 covered, 20 partial, 12 not planned.

### Reader events (`Zotero.Reader.registerEventListener`)

| # | Zotero capability (source) | Zinc WIT | Status |
|---|---|---|---|
| 1 | `renderToolbar`: nodes added to the reader toolbar (`custom-sections.js`, `toolbar.js:272`) | `reader.register-listener` with `slot(toolbar)`; content is a ui view (surface `toolbar-slot`) | covered |
| 2 | `renderTextSelectionPopup`: nodes in the popup at a text selection; `params.annotation` is the draft (`selection-popup.js:62`) | `register-listener` with `slot(text-selection-popup)`; surface `popover`; params carry a `text-selection` | covered |
| 3 | `renderSidebarAnnotationHeader`: nodes in the header of an annotation card (`preview.js:344`) | `register-listener` with `slot(sidebar-annotation-header)`; surface `toolbar-slot`; params carry the `annotation` | covered |
| 4 | `createColorContextMenu` (`context-menu.js:31,87`) | `register-listener` with `menu(color)`; `reader-events.build-menu` or `static-menu` | covered |
| 5 | `createViewContextMenu` (`context-menu.js:138,266`) | `menu(view)` | covered |
| 6 | `createAnnotationContextMenu`; `params.ids`, `currentID`, `view`, `popup` (`context-menu.js:271,413`) | `menu(annotation)`; `annotation-menu-params` has the full `annotation` list, `current`, `from-view`, `popup` | covered |
| 7 | `createThumbnailContextMenu`; `params.ids`, `pageIndexes` (`context-menu.js:418,445`) | `menu(thumbnail)`; params carry the 0-based pages | covered |
| 8 | `createSelectorContextMenu`; `params.enableClearSelection` (`context-menu.js:450,463`) | `menu(selector)` | covered |
| 9 | `createThemeContextMenu`: fired by the reader (`context-menu.js:468,492`), missing from the typedef | `menu(theme)` | covered |
| 10 | Menu item shape `{ label, disabled, checked, color, onCommand, groups }`; each `append` call is one group (`reader.js:1455-1486`) | `extend.menu-entry` (flat, `parent` for submenus; `color` is `menu-entry.swatch`, a `types.color`, so a hex string becomes `rgba`) and `reader-events.on-menu-command` | covered: groups become `separator` entries |
| 11 | `event.doc` and `append(...Element)`: plugins build real DOM nodes, including `<style>`, custom elements and `innerHTML` | The plugin returns a ui tree; the ui area defines the node set | partial: declarative nodes only. Arbitrary HTML and CSS are not planned (`ui.md`). |
| 12 | Handlers run again on every React render; a plugin can replace its node later (the doc example does it after a timeout) | ui `mount` / `update-context` calls the plugin only when params change; `reader.invalidate` or `ui.refresh` for async updates | covered |
| 13 | `event.reader` is the `ReaderInstance` | `reader-info` in every callback context | covered (the object itself is not given; see rows 55-56) |
| 14 | `unregisterEventListener(type, handler)` | `reader.unregister(id)` | covered |
| 15 | Listeners removed when the plugin shuts down (`reader.js:2678-2681`) | The host removes every registration of the plugin | covered |

### Reader instances and state (`Zotero.Reader`, `ReaderInstance`)

| # | Zotero capability (source) | Zinc WIT | Status |
|---|---|---|---|
| 16 | `Zotero.Reader._readers` (`reader.js:2664`) | `reader.list-readers` | covered |
| 17 | `getByTabID(tabID)` (`reader.js:2883`) | `reader.get-reader-by-tab` | covered |
| 18 | Selected tab's reader (toolkit `ReaderTool.getReader`, via `Zotero_Tabs.selectedID`) | `reader.selected-reader` | covered |
| 19 | Readers in their own windows (toolkit `getWindowReader`) | `reader-info.window`; `list-readers` returns them | covered |
| 20 | `open(itemID, location, { title, tabIndex, tabID, openInBackground, openInWindow, allowDuplicate, primaryViewState, secondViewState, preventJumpback, window })` (`reader.js:2927`) | `reader.open` with `open-request` | partial: `tabID` and `preventJumpback` are not offered (tab ids and jump-back belong to the host and to `extend.select-tab`) |
| 21 | `openURI(itemURI, location, options)` (`reader.js:2921`) | `open-request.target = item-uri(...)` | covered |
| 22 | `openPreview(itemID, iframe)` (`reader.js:3048`): a read-only reader in a plugin-supplied iframe | `ui.embed-component.attachment-preview` (an `embed` node that shows a file's preview) | partial: a plugin has no iframe and gets no read-only reader, only the preview component |
| 23 | `ReaderInstance.type` | `reader-info.kind` | covered |
| 24 | `itemID`, `_item` (numeric id, `Zotero.Item`) | `reader-info.attachment` (library + key) and `parent-item`; read the item through `library` | covered |
| 25 | `tabID`, `_window`, `_title` | `reader-info.tab-id`, `window`, `title` | covered |
| 26 | `getCurrentPage()` (`reader.js:167`) | `reader.get-state` -> `primary.page-label` | covered |
| 27 | `getPrimaryViewState()`, `getSecondViewState()` | `reader-state.primary-view-state`, `secondary-view-state` (JSON); restore through `open-request` | covered |
| 28 | Saved state: `getSavedPageLabel(itemID)`, `.zotero-reader-state` | `attachments.get-view-state` / `set-view-state` (library area) | covered |
| 29 | `navigate(location)`; location forms `annotationID`, `position`, `dest`, `pageIndex`, `pageLabel`/`pageNumber`, `href`, `scrollYPercent`, `scrollCoords` (`reader.js:825`, `pdf-view.js:2228`, `epub-view.ts:1396`, `snapshot-view.ts:726`) | `reader.navigate` with `location` | partial: `scrollCoords` (snapshot pixel coordinates) is not offered; use `scroll-y-percent` |
| 30 | `navigateBack/Forward/ToFirstPage/ToLastPage/ToPreviousPage/ToNextPage/ToPreviousSection/ToNextSection` | `reader.navigate-step` | covered |
| 31 | `focus()` | `reader.focus` | covered |
| 32 | `close()` | `reader.close` | covered |
| 33 | `reload()`, `export()`, `showInLibrary()`, `transferFromPDF()`, `importFromEPUB()` | `reader.run-command` (`reload`, `export-pdf`, `show-in-library`, `import-annotations-from-pdf`, `import-annotations-from-epub`) | covered (the host asks the user where a prompt exists in Zotero; Zinc's web reader provides the EPUB import) |
| 34 | `zoomIn/Out/Reset/Auto/PageWidth/PageHeight`, `copy`, `undo`, `redo`, `print` | `run-command` | covered |
| 35 | Scroll, spread and flow mode (view menu actions) | `reader.set-layout`; read back in `view-stats` | covered |
| 36 | Zoom and page counts (`_state.primaryViewStats`, `ViewStats` in `types.ts`) | `reader-state.primary` / `secondary` (`view-stats`) | covered |
| 37 | Split view: `toggleHorizontalSplit`, `toggleVerticalSplit`, `disableSplitView`, `secondaryViewState` | `reader.set-split`; `reader-state.secondary` | covered; Zinc has no split view yet and answers `unavailable` |
| 38 | Sidebar: `toggleSidebar`, `setSidebarView`, `setSidebarWidth`, `getSidebarWidth`, `onToggleSidebar`/`onChangeSidebarWidth` callbacks | `reader.set-sidebar`; `reader-state.sidebar` | partial: no change event for the sidebar. Plugins that need it poll `get-state` on `view-state-changed`. |
| 39 | Context pane: `setContextPaneOpen`, `toggleContextPane`, `ZoteroContextPane.togglePane` | `run-command(toggle-context-pane)` | covered |
| 40 | Find bar: `findNext`, `findPrevious`, `toggleFindPopup`, `_state.primaryViewFindState` | `reader.find`; `reader-state.find` | covered |
| 41 | Tool: `setTool`, `toggleTool`, `_state.tool` | `reader.set-tool`; `reader-state.tool` | covered |
| 42 | `setFilter`, `_state.filter`, `showAnnotations` | `set-filter`, `show-annotations`; `reader-state.filter` | covered |
| 43 | `setSelectedAnnotations(ids)`, `_state.selectedAnnotationIDs`, toolkit `getSelectedAnnotationData` | `select-annotations`; `reader-state.selected-annotations` | covered |
| 44 | `deleteAnnotations`, `convertAnnotations(ids, type)`, `mergeAnnotations(ids)` | `annotations.remove-annotations`; `update-annotations` with `kind` (highlight <-> underline) | partial: no ink merge. Create the merged annotation and remove the parts. |
| 45 | Themes: `setLightTheme`, `setDarkTheme`, `setCustomThemes`, synced setting `readerCustomThemes`, `DEFAULT_THEMES` | `reader.list-themes`, `get-theme-choice`, `set-theme-choice`, `save-theme`, `delete-theme` | covered; Zinc's PDF appearance has fewer modes. A custom theme maps to its "reading" appearance (two colours). |
| 46 | Reader prefs `reader.*` (font size, ebook font family, hyphenate, `textSelectionAnnotationMode`, `autoDisableTool.*`, `popupPositions`, `lastSidebarTab`) | the `prefs` interface (lifecycle), if the host publishes the same names | partial: not guaranteed; the host decides which reader prefs exist (open question 5) |
| 47 | Rotate and delete PDF pages (`onRotatePages`, `onDeletePages`, `Zotero.PDFWorker`) | `reader.rotate-pages`, `delete-pages` | covered (they change the file; the host confirms a delete) |
| 48 | Read Aloud: `toggleReadAloudPaused`, `_readAloudStatus`, voices, annotations from segments | `run-command(toggle-read-aloud)` | partial: no status, voices, position or segment-annotation API (`enableReadAloud: true` in `reader.js:328`; the status goes through `_setReadAloudStatus`). Zinc has no Read Aloud. |
| 49 | Open a reader in another window: `moveToWindow`, `canMoveToWindow` | none | not planned: a gesture of the main window. A plugin can `close` and `open` with `in-window` and the saved `primary-view-state`. |
| 50 | `enableAddToNote`, `updateAddToNote`, `updateTitle`, `displayError`, `setReadOnly`, `setErrorMessage`, `setA11yMessage`, `freeze`, `unfreeze`, `setSuspended`, `trimMemory`, `setLoggedIn`, `setTitle`, `getUnsavedAnnotations`, `enterPassword`, `setColorScheme` | none | not planned: reader housekeeping the host does by itself. To show an error use `ui.show-toast`. |
| 51 | `Zotero.Reader.triggerAnnotationsImportCheck`, `flushAllReaderStates` | `annotations.import-embedded-annotations` for the explicit case | covered for the import; `flushAllReaderStates` is not planned (the host saves state itself) |
| 52 | Notifier events `file`: `open`, `close`, `pageChange`; `tab`: `add`, `select`, `close` (`reader.js:786,1128,1135`, `notify`) | `reader.subscribe` with `opened`, `closed`, `tab-selected`, `page-changed`; `reader-events.on-reader-event`. The `notifier` interface also has the `file` and `tab` types. | covered |
| 53 | Selection changes (no event in Zotero; plugins use `pointerup` on the iframe or poll `_selectionPopup`) | `subscribe(selection-changed)`; `reader.get-selection` | covered |
| 54 | Tool and annotation-selection changes (no event in Zotero; plugins watch `_state`) | `subscribe(tool-changed, annotations-selected, view-state-changed)` | covered |

### The internal reader and the iframe (`_internalReader`, `_iframeWindow`)

| # | Zotero capability (source) | Zinc WIT | Status |
|---|---|---|---|
| 55 | `reader._iframeWindow`: the reader page's `window` and DOM | none | not planned: a plugin never gets a DOM, and Zinc's PDF reader is not a web page. Alternatives are in the next section. |
| 56 | `reader._internalReader` (private object, about 100 methods, `_state`) | the typed functions above | not planned as an object. The public subset is covered by rows 26-47. |
| 57 | `_state.annotations` (the reader's copy of the annotation JSON) | `annotations.list-annotations` | covered |
| 58 | `_internalReader.getSelectionPosition()`, toolkit `getSelectedAnnotationData`, `getSelectedText` (reach into `_lastView._selectionPopup`) | `reader.get-selection` -> `text-selection { text, draft }` | covered |
| 59 | `_state.outline`, `_state.pageLabels`, `_state.thumbnails` | `reader.get-outline`, `get-page-labels` | partial: no thumbnails (the host draws them) |
| 60 | PDF.js: page text (`pdfDocument.getPage(i).getTextContent()`) | `reader.get-page-text(pages, with-words)` | covered for PDF; EPUB and snapshots return `unavailable` for now |
| 61 | PDF.js: rendering a page or a region to a canvas | `reader.render-page(page, scale, clip)` | covered for PDF |
| 62 | PDF.js: `pdfLinkService`, named destinations, `getDestination`, page links; patching link clicks | `reader.register-link-interceptor`, `reader-events.on-link`; `location.pdf-dest` for `navigate` | partial: no way to list a page's links or read the PDF's metadata or attachments; open question 4 |
| 63 | PDF.js: draw over a page (heatmaps, boxes, word highlights injected into `.page`) | `reader.register-overlay`, `reader-events.render-overlay` (declarative shapes in page space) | partial: PDF only; fill, outline and underline shapes; no arbitrary drawing or text labels |
| 64 | Key handling: `reader._iframeWindow.addEventListener('keydown', ...)` | `extend.register-shortcut` with scope `reader`; `extend-handlers.on-shortcut` | partial: modifier combinations the host allows; no bare-key capture and no key-up |
| 65 | Mouse events on the iframe (`pointerup`, `mouseup`, hover) | `subscribe(selection-changed)` for the common case (the user finished selecting) | partial: other pointer events are not planned (every one would cross the process boundary) |
| 66 | Injecting CSS or DOM into the reader (restyle, new sidebar buttons, extra panels) | `register-panel` (sidebar tab or alternate view), slots, overlays, themes | partial: the places Zotero plugins patch most are covered; arbitrary restyling is not planned |
| 67 | `reader._iframeWindow.wrappedJSObject.createReader` and the options object (`onSaveAnnotations`, `onOpenLink`, ...) | none | not planned: reader wiring owned by Zotero's chrome code. A plugin hooks the result (annotation changes, links) through events. |
| 68 | Drag and copy of annotations (`onSetDataTransferAnnotations`, `zotero/annotation` data, QuickCopy note format) | `note-editor.serialize-annotations` gives the same HTML for a plugin's own copy command | not planned for the drag payload itself |

### Annotations (`Zotero.Annotations`, annotation items)

| # | Zotero capability (source) | Zinc WIT | Status |
|---|---|---|---|
| 69 | Annotation types `highlight`, `underline`, `note`, `image`, `ink`, `text` (`annotations.js` constants, `ANNOTATION_TYPE_*`) | `annotations.annotation-kind` | covered |
| 70 | `COLORS`, `DEFAULT_COLOR` (eight palette colours) | `annotations.annotation-colors` | covered |
| 71 | `toJSON(item)` / `toJSONSync`: key, type, text, comment, color, pageLabel, sortIndex, position, tags (with tag colours), authorName, `isExternal`, `readOnly`, `lastModifiedByUser`, dateModified | `annotations.list-annotations`, `get-annotations` -> `annotation` | partial: `lastModifiedByUser` and `isAuthorNameAuthoritative` (group libraries) are not in the record |
| 72 | `saveFromJSON(attachment, json, options)`: create or update | `annotations.create-annotations`, `update-annotations` (patches) | covered. `sort-index` and `page-label` are computed when missing. |
| 73 | Delete: `item.eraseTx()` (annotations are erased, not trashed) | `annotations.remove-annotations` | covered |
| 74 | `splitAnnotationJSON`, `splitAnnotations` (position over 65000 characters) | done by `create-annotations`; the result can be longer than the input | covered |
| 75 | Position shapes: PDF `{ pageIndex, rects, nextPageRects, paths, width, fontSize, rotation }`; EPUB and snapshot: a selector object; SDT range | `annotations.position` (typed fields plus `selector` JSON) | partial: structured-document-text ranges (`start`/`end` paths) are not typed; they travel inside `selector` only if the host stores them |
| 76 | Image and ink cache: `saveCacheImage`, `hasCacheImage`, `getCacheImagePath`, `removeCacheImage` | `get-annotation-image`, `set-annotation-image`; `annotation.has-image` | covered; `getCacheImagePath` is not planned (plugins get no file paths) |
| 77 | `removeOrphanedCacheFiles`, `removeLibraryCacheFiles` | none | not planned: housekeeping |
| 78 | `getAllAuthors(libraryID)` (SQL) | none | not planned: compute it from `list-annotations` (`author-name`) |
| 79 | External annotations (`annotationIsExternal`, from the PDF file) and `readOnly` | `annotation.is-external`, `read-only`; `import-embedded-annotations` (`Zotero.PDFWorker.import`) | covered |
| 80 | Annotation tags and tag colours | `annotation.tags` (`annotation-tag`), `new-annotation.tags`, `annotation-patch.tags`; tag colours through `library` | covered |
| 81 | Relations on annotation items (the Mendeley import path in `saveFromJSON`) | none: Zinc's `annotations` table has no relations, and the library's generic calls refuse annotation keys | not planned: nothing in the reader needs relations; the Mendeley import path is `create-annotations` |
| 82 | Annotation items as `Zotero.Item`: `getAnnotations()`, `isAnnotation()`, `annotationType`, `annotationText`, `annotationComment`, `annotationColor`, `annotationPageLabel`, `annotationSortIndex`, `annotationPosition` | `annotations.list-annotations`, `get-annotations` return the same fields under the same names (`kind` is `annotationType`, `text`, `comment`, `color`, `page-label`, `sort-index`, `position`, `is-external`); the library's generic item calls refuse annotation keys, so `annotations` is the only route | covered |
| 83 | Item notifier events for annotations (`add`/`modify`/`delete`; `extraData.instanceID`) | `subscribe(annotations-changed)` -> batched `annotations-change` with `by-this-plugin` | covered |
| 84 | `Zotero.PDFRenderer.renderAttachmentAnnotations` (render with annotations) | `reader.render-page`, `annotations.get-annotation-image` | partial: no render-with-annotations flag |
| 85 | `ANNOTATION_POSITION_MAX_SIZE`, `PROPS` | n/a | covered (host detail) |

### Notes in the reader context (note editor)

| # | Zotero capability (source) | Zinc WIT | Status |
|---|---|---|---|
| 86 | `ZoteroContextPane.activeEditor`, selected note tab's editor | `note-editor.active-editor`, `list-editors` | covered |
| 87 | "Add to Note": `EditorInstance.insertAnnotations(annotations)` (`editorInstance.js:393`) | `note-editor.insert-annotations` | covered |
| 88 | `_postMessage({ action: 'insertHTML', pos, html })` | `note-editor.insert-html` with `insert-position` `cursor`/`start`/`end` | partial: no numeric document positions (ProseMirror offsets are not stable across versions) |
| 89 | `applyIncrementalUpdate(noteData, preserveSelection)` | `note-editor.apply-update` | covered |
| 90 | `saveSync()`, `getDataSync(true)` (the editor's current state) | `note-editor.save-now`, `get-content` | covered |
| 91 | The editor's selection (read from the iframe) | `note-editor.get-selection` | covered |
| 92 | `NoteEditor.renderCustomHead(callback)` (`noteEditor.js`) | `note-editor.register-head`; ui view, surface `toolbar-slot` | covered |
| 93 | `Zotero.Notes.open(itemID, location, options)` | `note-editor.open-note` | covered |
| 94 | `Zotero.Notes.getExportableNote(item)` | `note-editor.exportable-html` | covered |
| 95 | `ensureEmbeddedImagesAreAvailable`, `copyEmbeddedImages`, `deleteUnusedEmbeddedImages`, `EditorInstance._importImage` | `embedded-images-available`, `copy-embedded-images`, `delete-unused-embedded-images`, `add-embedded-image` | covered |
| 96 | `EditorInstanceUtilities.serializeAnnotations(annotations, skipEmbeddingItemData)` and the templates `annotations.noteTemplates.highlight` / `.note` (`editorInstance.js:1701-1857`) | `note-editor.serialize-annotations` (with an optional `template`) | covered |
| 97 | "Add Note from Annotations" | `note-editor.create-note-from-annotations` | covered |
| 98 | Citation HTML for notes: `formatCitation`, `span.citation[data-citation]` | `cite.format` (library area); `insert-html` turns Zotero's citation, highlight and image markup into live nodes | covered |
| 99 | Note templates as Better Notes uses them (user-written template code, run with `Zotero` objects in scope) | Typed annotations and items in, HTML out through `insert-html`, `create-note-from-annotations` or the library's note creation | partial: a template engine is the plugin's own code. A JS guest (QuickJS) may `eval` templates in its sandbox; a Rust guest needs an engine. Better Notes' `Zotero.*`-in-scope templates are not carried over. |
| 100 | Note editor events: item `modify` with `extraData.state` and `noteEditorID` (`noteEditor.js` `notify`) | `note-editor.subscribe-note-events` -> `note-saved` (with `by-this-plugin`), `editor-opened`, `editor-closed`; library `notifier` for the item change | partial: events arrive when the editor saves (about a second after typing stops), not per keystroke |
| 101 | `Zotero.Notes.noteToTitle(html)` | none | not planned: a pure string function. The plugin reimplements it; the host computes the title on save. |
| 102 | `replaceItemKey`, `replaceAllItemKeys`, `hasSchemaVersion`, `updateUser`, `upgradeSchemaV1`, `registerEditorInstance` | none | not planned: string work the plugin can do on the HTML, or internal sync and upgrade code |
| 103 | The editor's iframe, ProseMirror view and state (`editorInstance._iframeWindow.wrappedJSObject`, `_editorCore`), extra toolbar buttons injected into the editor | none | not planned: see the note editor decision below |
| 104 | Context-pane sections in a reader tab (`ZoteroContextPane.context`, item pane sections shown beside the reader; PDF Translate's "Translate" section) | `extend.register-section` (extend area), shown in the reader's context pane | covered by the extend area; listed in Needs |
| 105 | Menu targets `reader/menubar/*` (deprecated), `notesPane/*`, `main/tab` | `extend.register-menu` | covered by the extend area |

## What plugins use `_internalReader` and `_iframeWindow` for, and what Zinc offers instead

| Use | Typical code | Zinc |
|---|---|---|
| Get the reader of the active tab | `Zotero.Reader.getByTabID(Zotero_Tabs.selectedID)` | `reader.selected-reader` |
| Read the selected text | `reader._internalReader._lastView._selectionPopup?.annotation.text` (toolkit) | `reader.get-selection`, or the `text-selection` handed to a `text-selection-popup` view |
| Read or select annotations | `reader._internalReader._state.annotations`, `.setSelectedAnnotations(ids)` | `annotations.list-annotations`, `reader.select-annotations`, `reader-state.selected-annotations` |
| Jump to a place | `reader.navigate({ pageIndex })` or `_internalReader.navigate` | `reader.navigate` |
| Run a toolbar action | `_internalReader.zoomIn()`, `toggleTool('highlight')`, `findNext()` | `run-command`, `set-tool`, `find` |
| Add UI to the popup, header, toolbar | `registerEventListener('render...')` | slots (rows 1-3) |
| Keyboard shortcuts in the reader | `_iframeWindow.addEventListener('keydown', ...)` | `extend.register-shortcut` scope `reader` |
| Know when the user finished selecting | `_iframeWindow.addEventListener('pointerup', ...)` then read the selection | `subscribe(selection-changed)` |
| Read page text (search, translate, count words) | `PDFViewerApplication.pdfDocument.getPage(n).getTextContent()` | `reader.get-page-text` (many pages per call) |
| Draw over the page | inject elements into `.page` | `register-overlay` |
| Catch link clicks | patch `pdfLinkService` or add click listeners | `register-link-interceptor` |
| Add a sidebar view | insert DOM beside the thumbnails view | `register-panel` |
| Restyle the reader | add a `<style>` to the iframe | themes (`save-theme`); everything else not planned |
| Insert into the active note | `ZoteroContextPane.activeEditor.getCurrentInstance().insertAnnotations(...)` | `note-editor.active-editor`, `insert-annotations`, `insert-html` |

The compat layer (`zotero-plugins.md`) sets `_iframeWindow` to `null`. The WASM API does not have the object at all; a plugin written for it never looks.

## The note editor: what a plugin can do and what is not planned

Zotero's `note-editor` element has one official extension point, `renderCustomHead(callback)`, and the menu targets `notesPane/addItemNote` and `notesPane/addStandaloneNote`. Everything else a plugin like Better Notes does to the editor is patching: it reaches `editorInstance._iframeWindow`, posts messages (`insertHTML`, `updateIncrementally`), or edits the ProseMirror state. Zinc runs Zotero's own editor build in a web view, so the host can offer the message-level operations safely and nothing deeper.

**A plugin can:**

- find editors (`list-editors`, `active-editor`) and open notes in a tab or window (`open-note`);
- read what an editor holds, including unsaved edits, and its selected text and HTML (`get-content`, `get-selection`);
- insert HTML at the cursor, start or end, with Zotero's citation, highlight and image markup becoming live nodes (`insert-html`);
- add annotations the way "Add to Note" does (`insert-annotations`), or build HTML itself from typed annotations and insert it;
- replace the content while keeping the cursor and undo history where it can (`apply-update`), and force a save (`save-now`);
- change a note that is not open by changing its item through the `library` interface; an open editor picks the change up, as in Zotero;
- show a strip of its own UI above every editor (`register-head`);
- manage embedded images (`add-embedded-image`, `copy-embedded-images`, `delete-unused-embedded-images`, `embedded-images-available`) and export a note (`exportable-html`);
- turn annotations into note HTML with Zotero's own templates (`serialize-annotations`) or create a note from them (`create-note-from-annotations`);
- implement its own note templates: the template engine runs inside the plugin and talks to Zinc in typed data (annotations, items, `cite.format`) and HTML.

**Not planned:**

- The editor's DOM, iframe, and ProseMirror view or state. The editor build changes with each Zotero release and a plugin that holds those objects breaks. Plugins use the operations above.
- Extra buttons inside the editor's own toolbar, new ProseMirror node types or editor plugins. The note editor is built from Zotero's `note-editor` repository; an extension point would be a change to that fork (open question 6).
- Per-keystroke events. Events arrive on save.
- A host call for `Zotero.Notes.noteToTitle` and the key-rewriting helpers; they are string functions.
- Registering a template engine into Zotero's own "Add to Note" templates. Zotero has no such hook either; the templates are text in a pref (`annotations.noteTemplates.*`, readable and writable through `prefs`).

## Design notes

**One process boundary shapes everything.** Zotero calls a handler on every React render and the handler returns DOM. In Zinc a call into the plugin crosses a process boundary, so:

- **UI is a ui-area view, not a callback.** A slot, a panel and the note head strip are registered here and then mounted by the host through `ui-events.mount(instance, view-context)`. That gives patches, events and `unmount` for free, and the host calls the plugin again only when `view-context.params` change. `reader.invalidate` is the way to say "my data changed" (for example after an async lookup finished, the way the Zotero doc example replaces "Loading..." after a timeout).
- **Menus are static when they can be.** `listener-registration.static-menu` is a list of `extend.menu-entry`. The host shows them without a call. `build-menu` is for menus that depend on the annotation, and it carries full `annotation` records so the plugin needs no extra read. It has a time limit; a menu is not shown until it answers.
- **Page overlays are data.** `render-overlay(page)` returns a list of shapes in PDF points, the same coordinates as annotations. The host caches it per page and asks again only after `invalidate`. This replaces injecting DOM into `.page`.
- **Reads are batched.** `get-state` returns the whole reader snapshot in one call. `get-page-text` takes a list of pages. `annotations.get-annotations` takes a list of keys. Every `create`/`update`/`remove` takes lists and applies them in one transaction.
- **Events are opt-in and coalesced.** `subscribe` lists the event kinds; the host sends nothing else. `selection-changed` is sent when the pointer is released, not while the user drags; `page-changed` is sent after the page settles; `view-state-changed` at most about once a second; `annotations-changed` is one batch per attachment and transaction. A plugin's own writes are marked `by-this-plugin`.

**Position stays Zotero's.** `annotations.position` holds the typed PDF fields and a `selector` JSON for EPUB and snapshots, because the same plugin code must work against annotation items synced from Zotero. Rects are PDF points with a bottom-left origin, as in the library, so an annotation's rects can go straight into an overlay shape.

**Annotations are typed records, plus the library's generic items.** The library area can return an annotation item as a generic item with `annotationType` and the rest as fields. The plugin should prefer `annotations`: it is typed, it computes `sort-index` and `page-label`, it splits oversized positions, and it keeps the reader and the "Add to Note" flow consistent.

**Permissions** (dotted ids, as in `manifest.schema.json`; proposed additions to its list):

| Permission | Gates | Risk |
|---|---|---|
| `reader.read` | `list-readers`, `get-state`, `get-selection`, `get-outline`, `get-page-labels`, `get-page-text`, `render-page`, `list-themes`, `subscribe` | low (it can see what the user reads: medium if text is sent over `net`) |
| `reader.control` | `open`, `close`, `focus`, `navigate`, `run-command`, `set-layout`, `set-tool`, `set-filter`, `select-annotations`, `set-sidebar`, `set-split`, `find`, `rotate-pages`, `delete-pages` | medium; `rotate-pages` and `delete-pages` also need `library.files.write` (high) |
| `reader.ui` | `register-listener`, `register-panel`, `register-overlay`, `register-link-interceptor` | low |
| `reader.themes` | `set-theme-choice`, `save-theme`, `delete-theme` | low |
| `annotations.read` | `list-annotations`, `get-annotations`, `get-annotation-image`, `serialize-annotations` | low |
| `annotations.write` | `create-annotations`, `update-annotations`, `remove-annotations`, `set-annotation-image`, `import-embedded-annotations` | medium |
| `note-editor.read` | `list-editors`, `active-editor`, `get-content`, `get-selection`, `subscribe-note-events` | low |
| `note-editor.write` | `insert-html`, `insert-annotations`, `apply-update`, `save-now` | medium |
| `note-editor.control` | `open-note` | low |
| `note-editor.ui` | `register-head` | low |

`create-note-from-annotations`, `exportable-html`, `add-embedded-image` and the other note functions also need `library.read` or `library.write`, named in their comments. A read-only library gives `error.read-only`.

**Rust and JS ergonomics.** Plain records, variants, lists and options; no resources. WIT has no recursive types, so submenus are flat (`parent`, from `extend.menu-entry`) and outlines are flat with a `depth`. JSON is used only where Zotero's own payload is open-ended (`position` for navigate, view states, selectors) and for `view-context.params`.

**Mapping to Zinc's existing in-process contract** (`reader/plugins.ts`), for phase 2:

| WIT | `ReaderPlugin` hook |
|---|---|
| slot `toolbar` | `toolbar` |
| slot `text-selection-popup` | `selectionPopup` |
| slot `sidebar-annotation-header` | `annotationHeader` (zotero-plugins branch) |
| menu `annotation`, `view`, `thumbnail` | `annotationMenu`, `viewMenu`, `thumbnailMenu` (zotero-plugins branch) |
| menu `color`, `selector`, `theme` | none yet; Zinc has no such menus. The registration is accepted and the menu is shown once the host has one. |
| panel `sidebar-tab`, `alt-view` | `sidePanel`, `altView` |
| `register-overlay` | `pageOverlay` (with `handlesRotation` set by the host) |
| `register-link-interceptor` | `ReaderContext.onLink` |
| `extend.register-shortcut` (reader scope) | `onKey` |
| events `opened`, `closed`, selection, page | `onOpen`, `ReaderContext.selection`, `currentPage`, `openReaders` |
| `get-page-text`, `render-page` | `ReaderContext.textLayer`, `pdfBytes`, page rendering |

EPUB and snapshots run in the web reader, which fires Zotero's own `customEvent`s. For those readers the host must run the same registrations through `reader-host/src/host.js` (it would render the ui tree inside the page and answer menus), or the slot is simply not shown. That is host work for phase 2; the WIT does not change (`reader-kinds` on each registration limits a plugin to the kinds it supports).

**Zinc additions that Zotero does not have** (so there is no parity row): `register-panel`, `register-overlay`, `register-link-interceptor`, `annotations-changed`, `selection-changed`, `get-page-text`, `render-page`.

## `view-context.params` for reader views

The `ui` area passes `view-context.params` as JSON. For the views registered here, it is an object with `slot` and `reader` (or `editor`), plus:

| Registration | `view-context.surface` | `params` |
|---|---|---|
| `slot(toolbar)` | `toolbar-slot` | `{ "slot": "toolbar", "reader": reader-info }` |
| `slot(text-selection-popup)` | `popover` | `{ "slot": "text-selection-popup", "reader": reader-info, "selection": text-selection }` |
| `slot(sidebar-annotation-header)` | `toolbar-slot` | `{ "slot": "sidebar-annotation-header", "reader": reader-info, "annotation": annotation }` |
| `panel(sidebar-tab)` | `reader-sidebar` | `{ "slot": "panel", "reader": reader-info }` |
| `panel(alt-view)` | `reader-overlay` | `{ "slot": "panel", "reader": reader-info }` |
| `note-editor.register-head` | `toolbar-slot` | `{ "slot": "note-editor-head", "editor": editor-info }` |

`reader-info`, `text-selection`, `annotation` and `editor-info` are the WIT records, written as JSON with camelCase names (the convention in `ui-tree.schema.json`).

## Open questions for the user

1. **EPUB and snapshot parity in phase 2.** Zinc's PDF reader is native; EPUB and snapshots are Zotero's web reader in a web view. Should plugin UI (toolbar strips, popups, menus) work in the web reader at launch, or is PDF first enough? The WIT supports both; only the host work differs.
2. **Selection text and privacy.** `reader.read` lets a plugin see the text the user selects and the text of every page. Should reading the page text be a separate, higher-risk permission from reading the reader's state?
3. **Page overlays.** Are shapes enough (fill, outline, underline in page space)? Plugins like Zotero Style draw other things (badges, text labels, small icons). A `label` shape and an `icon` shape would cover most; arbitrary drawing would not be planned.
4. **Link lists and PDF internals.** Should the WIT offer `get-page-links(page)` and PDF metadata (`/Info`, embedded files), or is `register-link-interceptor` plus `get-outline` enough?
5. **Reader prefs.** Which `reader.*` prefs does the host publish through `prefs` (font size, text selection mode, auto-disable tools, themes)? Row 46 depends on it.
6. **Note editor toolbar.** Better Notes adds buttons inside the editor. Do we want an extension point in the note-editor fork (a "plugin toolbar" slot above the toolbar, or buttons registered by id), or is the head strip enough?
7. **Annotation plugin data.** Plugins keep extra data about an annotation in tags or relations, which sync to other devices. Should there be a private per-plugin key-value store per annotation (not synced), or leave that to the plugin's own storage keyed by annotation key?
8. **Read Aloud.** Zotero has Read Aloud (voices, a status, annotations made from segments); Zinc has none. Keep only the one command (`toggle-read-aloud`), or design a fuller interface when Zinc gets the feature?
9. **Ink merge and image/text tools.** Zinc has no image or text annotation tool yet. The WIT already creates them (`create-annotations` with `kind: image` or `text`); the reader draws what the model holds. Is that acceptable until the tools exist?

## Needs from other areas

Resolved in the reconcile of 2026-11-18 (see README):

- **ui:** the surface mapping is confirmed (`toolbar-slot` for the toolbar strip, annotation header and note head; `popover` for the selection popup; `reader-sidebar`; `reader-overlay`). The attachment preview is `ui.embed-component.attachment-preview` (row 22, partial). For strips `view-context.height` is the fixed strip height and `width` the space available.
- **extend:** `menu-entry.swatch` (a `types.color`) exists. `static-menu` entries honour `visible-when` and `enabled-when` against the reader tab's context; reader menus use `reader-events.on-menu-command`, not `extend-handlers.on-menu-command`. A `register-shortcut` with `scope: reader` is delivered with the selected tab in `context.tab`; `reader.selected-reader` reads it. `tab-ref.kind` "reader" with subtypes "pdf", "epub", "snapshot" are the names of `reader-kind`. `reader/menubar/*` and `main/tab` menu targets: `tab` exists; `reader/menubar/*` is deprecated and not planned.
- **library:** annotation items go through `annotations` only; the generic item calls answer `invalid-argument` for an annotation key. `item-ref` is `types.item-ref` now (used here, in `reader`, `note-editor` and the event interfaces). `attachments.get-view-state` and `set-view-state` are the stored copy of `reader-state.primary-view-state`; the reader owns the JSON. `cite.format` has the `note-citation` output for `insert-html`. `fulltext.get-content` (whole document, indexed) and `get-page-text` (pages of an open reader) both stay.
- **lifecycle:** the ten permission ids are in the manifest schema with risk tiers; the feature ids (`reader.events`, `reader.panels`, `reader.overlays`, `reader.split-view`, `reader.read-aloud`, `reader.web`, `note-editor.head`) are in the doc comment of `app.app-info`. Shared types all come from `types.wit`.

Still open:

- **Sections in reader tabs.** Decided 2026-11-18: yes, Zinc's reader tab shows plugin item pane sections and the `notes-add-*` menus (rows 16, 50, 126 and extend row 16). The WIT supports it (`view-context.params.tabType` is `reader`); the host builds it in phase 2.
- **Reader prefs.** Whether the `reader.*` prefs are readable through `prefs.get-app` and writable (row 46). Part of the app prefs allowlist question. Open.

## Interfaces added in `reader.wit`

`annotations`, `reader`, `note-editor`, `reader-events`, `note-events`. The world already lists all five.
