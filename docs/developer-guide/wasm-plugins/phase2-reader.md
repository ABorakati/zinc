# Phase 2, reader agent: reader, annotations and the note editor

Status 2026-11-18. Check: `bun scripts/shot-wasm-reader.tsx` in `gpui-ui/` (49 of 49 PASS, about 80 s, headless), `bun test src/wasmplugins/reader` (16 pass), `bun check` clean in `gpui-ui/` for these files and in `plugin-host/`.

## What was built

| File | What it is |
|---|---|
| `plugin-host/src/imports/reader.zinc.ts` | The `where: "zinc"` handlers of `zinc:plugin/reader`, `annotations` and `note-editor` (one file, three handlers; the loader wants `*.zinc.ts`). Each function forwards to the service below through a global slot; the first call installs the bridge if the app has not. |
| `gpui-ui/src/wasmplugins/reader/index.ts` | `installReaderBridge()` (idempotent), `bindReaderApp`, `setReaderCaller`, `NoteEditorHead`, `setPluginViewComponent`. |
| `.../service.ts`, `reader.ts`, `annotations.ts`, `notes.ts` | The three imports. `service.ts` dispatches by interface and function name and checks permissions (`ctx.require`). |
| `.../registry.ts`, `bridge.tsx`, `menus.ts`, `view.tsx`, `link.ts` | Registrations per plugin, turned into Zinc `ReaderPlugin` objects (one per plugin, one per panel); menus; the view host (uses the ui area's `PluginView`, else a text stand-in); the per-plugin call queue. |
| `.../events.ts`, `noteevents.ts`, `host.ts` | `reader.subscribe` delivery; `note-editor.subscribe-note-events` (polling) and head registrations; the open readers and the app's tab functions. |
| `.../sections.tsx`, `notehead.tsx` | Plugin item pane sections in reader tabs (a "Plugins" sidebar tab); the strip over the note editor. |
| `.../convert.ts`, `types.ts`, `convert.test.ts` | Pure conversions (annotation JSON <-> WIT records, rects, menus), jco-shaped types, unit tests. |
| `gpui-ui/src/reader/ops.ts` (new), `plugins.ts`, `Reader.tsx`, `annotations/{Panel,PageOverlay,index}.tsx`, `core/layoutui.tsx` | Reader side: `ReaderOps` (navigate, zoom, layout, search, sidebar, page commands) registered per open document; hooks `colorMenu`, `selectorMenu`, `themeMenu`; `openAfterPlugins`. The `annotationMenu`, `annotationHeader`, `viewMenu`, `thumbnailMenu`, `unregisterReaderPlugin`, `pluginMenuItems` and `openReaders` hunks are copied **verbatim** from the `zotero-plugins` branch (same diff, so the two branches merge without conflict there). |
| `gpui-ui/scripts/shot-wasm-reader.tsx`, `scripts/fixtures/wasm-reader/` | The headless check and its QuickJS fixture plugin (world `reader-fixture`: reader, annotations, note-editor, log imports; lifecycle, reader-events, note-events, ui-events exports). |

## How it works

- A plugin calls `reader.register-listener / register-panel / register-overlay / register-link-interceptor`. `registry.ts` keeps them; `bridge.tsx` builds `ReaderPlugin` objects and calls `registerReaderPlugin`, so the reader shows them at once. `unregister`, plugin stop, disable, failure and host restart (the extend area's `onPluginRegistrationsReset`) remove them.
- Mapping to Zinc's in-process contract:

| WIT | `ReaderPlugin` hook |
|---|---|
| slot `toolbar` / `text-selection-popup` / `sidebar-annotation-header` | `toolbar` / `selectionPopup` / `annotationHeader` (surfaces `toolbar-slot`, `popover`, `toolbar-slot`; params as reader.md) |
| menu `annotation` / `view` / `thumbnail` | `annotationMenu` / `viewMenu` / `thumbnailMenu` |
| menu `color` / `selector` / `theme` (new hooks) | `colorMenu` (rows under the swatches of the tool popover), `selectorMenu` (end of the tag filter menu), `themeMenu` (right-click on an appearance in the appearance popup) |
| panel `sidebar-tab` / `alt-view` | `sidePanel` / `altView` (surfaces `reader-sidebar`, `reader-overlay`) |
| overlay | `pageOverlay` (fill, outline, underline in PDF points; clicks with a `command` go to `on-overlay-click`; hidden on rotated pages) |
| link interceptor | `ReaderContext.onLink` (claims the click and calls `on-link`) |

- **UI content** is the ui area's `PluginView` (`wasmplugins/ui/index.ts`), given `pluginId`, `plugin`, `view`, `surface`, `params` and a `supervisor`. If that module is missing, `view.tsx` mounts the view itself and shows the text of the tree (stand-in; instance ids are u64).
- **Reader controls** go through `ReaderOps` (`reader/ops.ts`), attached to each open document by `Reader.tsx`. Reader id and tab id are the attachment key (a reader tab's id is the attachment key).
- **Sections in reader tabs** (decision 2): the extend area's `PluginSectionsList` is mounted in a sidebar tab "Plugins" of the reader (`sections.tsx`) while any section is registered, for the parent item, with tab `{ kind: "reader", subtype: "pdf" }`. The `notes-add-*` menus are NOT in reader tabs: the reader has no notes pane to put them on.

### Annotation data path (decision)

An attachment **with an open reader** is served through that reader's annotation session (`reader/annotations/session.ts`): its store is what the sidebar and pages draw and what PUTs to the core, so a plugin's write shows at once and cannot be overwritten by the store's next save. An attachment **with no open reader** goes straight to the core's `/api/attachments/:key/annotations` (GET, PUT upsert, DELETE), the same wire format. Both run in the Zinc process, so the handlers are `where: "zinc"`; no host-process handler. The core has no lookup of an annotation by its key: `get-annotations` and `update-annotations` find it by the attachments this bridge has seen (an open reader's list, or an earlier list or create call); an unknown key answers none (get) or not-found (update). Writes to a closed attachment compute `sort-index` as `PPPPP|000000|00000` (no text layer without a reader) and `page-label` as page number.

### Menus

Zinc's menu layer reads its items once when a menu opens. Static menus (`static-menu`) are shown from the registration. A dynamic menu (`build-menu`): the annotation and thumbnail menus open through `openAfterPlugins` (`reader/plugins.ts`), which starts the plugin's call, waits for it (at most 600 ms), then opens the menu with the answer; the view and colour menus are asked for ahead of time (`warmMenus`) and reused for a second. `visible-when` and `enabled-when` of entries are not evaluated (a reader menu has no extend context); entries are shown and enabled. Submenus nest to four levels; `swatch` becomes a coloured dot.

### Events

`subscribe` kinds delivered to `on-reader-event`: `opened`, `closed`, `tab-selected` (needs `bindReaderApp({ activeTab })`), `page-changed` (after 200 ms), `selection-changed` (when the selection is final), `annotations-selected` (one annotation), `annotations-changed` (diff of the session's list; `by-this-plugin` for the plugin's own calls; for a closed attachment the service emits it), `tool-changed`, `view-state-changed` (at most once a second). Events of one kind to one plugin arrive in order. `note-events` come from polling the shared editor (see below).

## Run it

```bash
cd gpui-ui
bun scripts/shot-wasm-reader.tsx [--out DIR]      # build fixture, throwaway core, real supervisor + reader; PASS/FAIL per line, exit 1 on FAIL
ZN_DUMP_LOG=1 bun scripts/shot-wasm-reader.tsx    # also print every line the plugin logged
bun test src/wasmplugins/reader                   # unit tests
bun check                                         # typecheck
```

The script writes no file outside `%TEMP%\zn-wasm-reader-<pid>` (deleted at the end) and `%TEMP%\zn-wasm-reader\shots\wr-*.png` (toolbar, header, annotation-menu, view-menu, thumb-menu, selection, panel). It starts its OWN core on a free port over a temporary library with a generated 3-page PDF; it never touches `data/library.sqlite`, Zotero's data folder or ports 23119 / 23120 / 23160. It needs `core/vendor` (a junction to the main checkout's `core/vendor`, git-ignored, which I created in this worktree because the core imports `vendor/fulltext-wasm`).

## Tests and result

`shot-wasm-reader.tsx`: **49 PASS, 0 FAIL**. Covers: plugin load and start; events `opened`, `selection-changed`, `page-changed`, `view-state-changed`, `tool-changed`, `annotations-selected`, `annotations-changed` (own write, user's change, modified, removed); slots toolbar, text-selection-popup, sidebar-annotation-header (mount, params, drawn text); menus annotation (build-menu + command through a right-click on a card), view (static, through the View button), thumbnail (build-menu with pages through a right-click), color, selector, theme (through the hooks); sidebar panel; overlay (`render-overlay`, `invalidate`); link interceptor (through the hook, not a real click); `reader.list-readers`, `selected-reader`, `get-state`, `get-selection`, `navigate`, `navigate-step`, `run-command`, `set-tool`, `find`, `get-page-text`, `render-page` (PNG), `get-outline`, `get-page-labels`, `list-themes`, `set-theme-choice`, `set-sidebar`, `unregister`; `annotations.list`, `get`, `create`, `update`, `remove`, `annotation-colors` and the core's copy; `note-editor.serialize-annotations`, `list-editors`, `active-editor`, `open-note` (unavailable); shutdown removes everything. Not exercised (no WebView2 headless): `note-editor` insert, content, selection, apply-update, save-now, `note-events`, `create-note-from-annotations`; their pure parts (HTML, splice) are in `convert.test.ts`.

## WIT rows now implemented

- `annotations`: `list-annotations`, `get-annotations`, `create-annotations`, `update-annotations`, `remove-annotations`, `annotation-colors`; `get-annotation-image` for image and ink annotations of an open reader (drawn from the page), none otherwise. (Parity rows 69-76, 79-80, 82-83.)
- `reader`: `list-readers`, `get-reader`, `get-reader-by-tab`, `selected-reader`, `open` and `close` (need `bindReaderApp`), `focus`, `get-state`, `get-selection`, `get-outline`, `get-page-labels` (from annotation labels, else page number), `get-page-text`, `render-page`, `navigate` (annotation, position, page-index, page-label), `navigate-step` (back, forward, first, last, previous, next page), `run-command` (zoom-in, zoom-out, zoom-reset, zoom-auto, zoom-page-width, zoom-page-height, copy, print, close-find, show-in-library), `set-layout`, `set-tool` (pointer, highlight, underline, note, ink, eraser), `select-annotations` (one), `clear-selection`, `set-sidebar` (open, view), `find`, `rotate-pages`, `delete-pages`, `list-themes`, `get-theme-choice`, `set-theme-choice`, `save-theme`, `delete-theme`, `register-listener` (all slot and menu kinds), `register-panel`, `register-overlay`, `register-link-interceptor`, `unregister`, `invalidate`, `subscribe`. (Rows 1-10, 12-19, 21, 23-27, 29-31, 35-36, 38, 40-41, 43, 45, 47, 52-54, 57-58, 60-63; menu rows 4, 8, 9 are checked through the hooks, there is no UI to click for the first two without a tool or tags.)
- `reader-events`: `build-menu`, `on-menu-command`, `render-overlay`, `on-overlay-click`, `on-link`, `on-reader-event` (all called by the host). `note-events.on-note-event` is called by the poller.
- `note-editor`: `list-editors`, `active-editor`, `focus`, `get-content`, `get-selection`, `insert-html`, `insert-annotations`, `apply-update`, `save-now`, `serialize-annotations`, `create-note-from-annotations`, `exportable-html`, `register-head`, `unregister-head`, `invalidate-head`, `subscribe-note-events`, `embedded-images-available` (always true: Zinc keeps images inline), `delete-unused-embedded-images` (0). (Rows 86-87, 89-92, 94, 96-97, 100, 104.)

## Stubbed or left

- `unavailable` (the plugin gets `error::unavailable` with a reason): `annotations.set-annotation-image`, `import-embedded-annotations`; `reader.set-filter`, `show-annotations`, `set-split` (other than none), `navigate` with `pdf-dest`, `cfi`, `href`, `scroll-y-percent`, `navigate-step` section steps, `run-command` for `undo`, `redo`, `export-pdf`, both imports, `reload`, `toggle-context-pane`, `toggle-read-aloud`, `open-find`, `set-tool` with `hand`, `image`, `text`, `set-layout` with `page` or a flow mode; `note-editor.open-note`, `add-embedded-image`, `copy-embedded-images`.
- EPUB and snapshot readers are not listed and have no plugin UI (open question 1 stays: PDF first). Page overlays are shapes only; no `label` shape.
- Custom themes live in memory only (lost on restart); a custom theme maps to Zinc's "custom colour" appearance (its background). `reader-theme.foreground` is not used.
- `register-head`: the registration and `NoteEditorHead` exist, but `itempane/RichNote.tsx` does not draw the strip yet. `note-editor` has one instance (`note:<key>`), placement always `item-pane`, `read-only` false, library 1 (note-host does not report them). `insert-html` at start or end rewrites the note through the core and re-opens it in the editor (cursor and undo are lost); at the cursor it uses the editor's `insertHTML` message. `get-content` saves first. The templates are `{{highlight}}`, `{{comment}}`, `{{citation}}` (page only, no author-year), `{{image}}` (a placeholder), `{{tags}}`, `{{color}}`; the user's `annotations.noteTemplates.*` prefs are not read.
- `get-state`: `filter`, `split` and `secondary` are empty; `sidebar.width` cannot be set.
- The PDF `/PageLabels` are not read (the viewer cannot), so labels come from existing annotations.

## WIT changes

None. Observations for review: (1) `view-context.params` carries annotations with `date-added`/`date-modified` as u64; the bridge turns them into JSON numbers. (2) The types doc says a colour is `rgba(u32)`: a QuickJS guest cannot send one with a red byte of `0x80` or more (see below).

## Findings in other areas (found while testing)

1. **The first `ui-events` call of a QuickJS plugin takes about 19 s** (`mount`, `update-context`, `on-event`, `resync`; every export that returns `render-result`; later calls 3 to 15 ms; a Rust guest was not measured). componentize-qjs 0.6 spends it on the first call before the JS function is entered. At the default 5 s budget the supervisor kills the plugin host. The reader bridge gives the first ui-events call of each plugin 90 s (`link.ts`). **The supervisor or the package area should do the same for every plugin's first ui-events call (or warm it up at load); the ui area's own mounts need it too.**
2. **One call at a time per plugin.** The supervisor does not serialise calls to one plugin; a call that suspends in an import while another suspended call is open on the same instance hung the plugin (startup plus a mount, 10 s). Every call of this area goes through a per-plugin queue (`link.ts`) and waits for status `starting`/`loading` to end, and `PluginView` is given that queue as its `supervisor`. Calls from other areas (extend menu commands, ui events, timers) bypass it, so **the supervisor should queue calls per plugin**.
3. **u32 clamp in QuickJS guests:** a `u32` above 2^31 - 1 arrives as 2147483647, so `types.color.rgba(0xff6666ff)` becomes `#7fffff..`. Rust guests are not affected. The SDK for JS should convert, or the WIT should use `s32`/two fields.
4. `core/vendor` is missing in the worktree (git-ignored): any test that starts a core needs the junction.

## Needs from other areas

- **App wiring** (`wasmplugins/index.ts` `startWasmPlugins`, owner: extend/coordinator): call `installReaderBridge()` (it is also installed lazily by the first import call, but the registration clearing and the event watchers need it before plugins start) and `bindReaderApp({ libraryId: store.libraryId-of-the-attachment, openAttachment: store.openAttachment, closeTab: store.closeTab, setActiveTab: store.setActiveTab, activeTab: store.activeTab, selectItem: store.selectItem })` once the store exists. Without it `reader.open`, `close`, `tab-selected` and `show-in-library` answer `unavailable` and every library id is 1. The reader bridge uses `onPluginRegistrationsReset` and `getPluginSupervisor` from `wasmplugins/host.ts`.
- **Supervisor / package area:** items 1 and 2 above.
- **`itempane/RichNote.tsx` owner:** draw `<NoteEditorHead noteKey={...} />` between the header and the editor box.
- **`webview/notes.ts` owner:** an API for "this note was saved" and "this note is shown" (the bridge polls `noteDebug()` every 400 ms while a plugin subscribed), an `openNote(key)` for `note-editor.open-note`, and placement (item pane or tab) in the claim.
- **`ui` area:** nothing blocking. `PluginView` was used as published (`pluginId`, `view`, `surface`, `params`, `supervisor`). Surfaces used: `toolbar-slot`, `popover`, `reader-sidebar`, `reader-overlay`.
- **extend area:** `PluginSectionsList` is used for sections in reader tabs. The `notes-add-*` menu targets have no place in a reader tab until the reader has a notes pane.
- **Coordinator:** the `reader/plugins.ts` hunks shared with the `zotero-plugins` branch are identical; merge that branch first or accept the identical hunks.
