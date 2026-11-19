# WASM plugins for Zinc: design index (phase 1)

Zinc's own plugin system: WebAssembly components with WIT interfaces. A plugin written for it can do what a Zotero plugin can do (the target is the current Zotero, 10; plugins written for Zotero 7–9 are covered too), including full UI customization through declarative UI trees. Phase 1 was design only: WIT files, a manifest schema, a UI tree schema, and per-area parity tables against Zotero's source. Phase 2 built the host (jco under Bun, one Worker per plugin); phase 3 moved to Wasmtime (`phase3-wasmtime-plan.md`), and the Worker runner has since been removed: Wasmtime (`zhw`) is the only runner (`phase3-runner.md`). How Zotero's plugin API changed from 7 to 11, and what that means for porting: [zotero-versions.md](zotero-versions.md).

Read [RULES.md](RULES.md) first for the ground rules, and the runtime spike (`wasm-plugins-spike.md` in the spike worktree) for why plugins are components in a separate process.

## Area reports and totals

Totals are tallied by script from the status column of each report's parity tables (reconciled 2026-11-18).

| Area | Report | WIT file | What it covers | Rows | Covered | Partial | Not planned |
|---|---|---|---|---|---|---|---|
| lifecycle | [lifecycle.md](lifecycle.md) | [lifecycle.wit](https://github.com/ABorakati/zinc/blob/main/plugin-api/wit/lifecycle.wit), [types.wit](https://github.com/ABorakati/zinc/blob/main/plugin-api/wit/types.wit), [world.wit](https://github.com/ABorakati/zinc/blob/main/plugin-api/wit/world.wit) | Package and manifest, install / startup / shutdown / uninstall, prefs, secrets, strings (Fluent), network, files and file grants, timers, clipboard, shell, log, helpers, permissions | 114 | 77 | 15 | 22 |
| library | [library.md](library.md) | [library.wit](https://github.com/ABorakati/zinc/blob/main/plugin-api/wit/library.wit) | Items, collections, tags, searches, attachments and files, full text, schema, citations, translators, sync, change notifications | 133 | 69 | 39 | 25 |
| extend | [extend.md](extend.md) | [extend.wit](https://github.com/ABorakati/zinc/blob/main/plugin-api/wit/extend.wit) | Menus, item pane sections and rows, columns, collection tree, toolbar, shortcuts, preference panes, tabs, banners, selection, drag and drop | 126 | 86 | 16 | 24 |
| ui | [ui.md](ui.md) | [ui.wit](https://github.com/ABorakati/zinc/blob/main/plugin-api/wit/ui.wit), [ui-schema/](https://github.com/ABorakati/zinc/tree/main/plugin-api/ui-schema/) | The declarative UI tree, styles, events, views, dialogs, prompts, windows, toasts, popovers | 102 | 73 | 19 | 10 |
| reader | [reader.md](reader.md) | [reader.wit](https://github.com/ABorakati/zinc/blob/main/plugin-api/wit/reader.wit) | Reader events and panels, annotations, selection, themes, note editor | 105 | 73 | 20 | 12 |
| **Total** | | | | **580** | **378** | **109** | **93** |

## Other files

- [`plugin-api/manifest.schema.json`](https://github.com/ABorakati/zinc/blob/main/plugin-api/manifest.schema.json): JSON Schema for the `manifest.json` at the root of a plugin package. `$defs.capability` lists all 36 permission ids with risk tiers (`x-risk`).
- [`plugin-api/ui-schema/ui-tree.schema.json`](https://github.com/ABorakati/zinc/blob/main/plugin-api/ui-schema/ui-tree.schema.json): the nested JSON form of a UI tree.
- [`plugin-api/wit/world.wit`](https://github.com/ABorakati/zinc/blob/main/plugin-api/wit/world.wit): world `plugin` (every interface) and `plugin-minimal` (app, prefs, l10n, log, timers, extend, ui; no `fs`, `clipboard`, `shell`, `reader`).

## The WIT package

One package, `zinc:plugin@0.1.0`, spread over seven files.

| Interface | File | Direction | Purpose |
|---|---|---|---|
| `types` | types.wit | shared | Keys, ids, `error`, `json`, `localized-string`, `icon-ref`, `color` (and `color-token`), `item-ref`, `file-grant`, `pref-value` |
| `lifecycle` | lifecycle.wit | plugin exports | `install`, `startup`, `shutdown`, `uninstall`, `main-window-load`, `main-window-unload` |
| `events` | lifecycle.wit | plugin exports | Callbacks for prefs, timers, plugin events, locale, permissions |
| `app`, `plugins` | lifecycle.wit | host imports | App info and feature ids, windows, readiness; plugin records, updates |
| `prefs`, `secrets` | lifecycle.wit | host imports | Plugin preferences (and how UI controls bind to them); keys in the OS credential store |
| `l10n`, `log`, `timers`, `util` | lifecycle.wit | host imports | Strings and formatting; log; clock and timers; helpers |
| `net`, `net-events` | lifecycle.wit | imports, plugin exports | HTTP; download progress |
| `fs`, `clipboard`, `shell` | lifecycle.wit | host imports | Files in four roots and the file dialogs (the one set); clipboard (the one set); open URL, open file, reveal (the one set) |
| `permissions` | lifecycle.wit | host imports | Check and request permissions |
| `library`, `attachments`, `fulltext`, `schema`, `cite`, `translate`, `sync-control`, `data-utils`, `notifier` | library.wit | host imports | The library |
| `notifier-handler` | library.wit | plugin exports | Change event batches (data only: no UI-state types) |
| `extend` | extend.wit | host imports | Extension points in the main window |
| `extend-handlers` | extend.wit | plugin exports | Menu commands, column values, drops, and the selection, view, tab and theme events |
| `ui` | ui.wit | host imports | UI tree types, dialogs and prompts, windows, toasts, theme |
| `ui-events` | ui.wit | plugin exports | Mount, update, the one event entry point `on-event`, row ranges, suggestions |
| `annotations`, `reader`, `note-editor` | reader.wit | host imports | Annotations, readers, note editor |
| `reader-events`, `note-events` | reader.wit | plugin exports | Reader and note editor callbacks |

Check the whole package from the worktree root:

```bash
bunx @bytecodealliance/jco types plugin-api/wit --world-name plugin -o "$TEMP/zn-wit-check"
bunx @bytecodealliance/jco types plugin-api/wit --world-name plugin-minimal -o "$TEMP/zn-wit-check-min"
```

## Reconciled on 2026-11-18

Five areas were written in parallel. The coordinator's reconcile pass made them one design. What was merged (the area that owned the concept kept its design):

1. **One clipboard, one URL opener, one set of file dialogs.** Kept: `clipboard.write` / `read`, `shell.open-url`, `fs.pick-open` / `pick-save` / `pick-directory`. Removed: `ui.copy-text`, `ui.read-clipboard-text`, `ui.open-url`, `ui.pick-files` / `pick-folder` / `pick-save` and their types. **One file-grant type**: `types.file-grant` (`id`, `name`, `is-directory`, `size`). The `id` is `fs.root::granted(id)`, and `fs.read`, `fs.read-range`, `fs.write` turn it into bytes (the missing "token to bytes" path). Picks and drops arrive as the same record (`ui.drop-info.files`, `extend.drop-payload.files`); `fs.list-grants` was added. The ids `ui.pick-files`, `ui.file-dialogs` and `ui.clipboard-read` are gone: a user's pick is the consent.
2. **Dialogs and prompts have one owner, `ui`.** Extend has none and refers to ui. `open-dialog`, `open-window` and `set-theme-override` now return `result<_, error>`, because they need permissions or have a limit.
3. **Extend placeholders** (`node`, `node-event`, `form-values`, `file-grant`) were already replaced by the extend area with the ui types; the reconcile confirmed it. `ui-events.on-event` is the one event entry point (a section header button press is `kind: press` with `handler` = the button id). Reader had no placeholders.
4. **One colour type**: `types.color` (token, token with alpha, fixed, pair per mode) with `types.color-token`, moved from ui. The old `types.color` (hex or free token string) is gone. Annotation colours stay hex strings.
5. **`themed-icon`** stays in extend: only extend uses it (ui and reader take one `icon-ref`).
6. **One item reference**: `types.item-ref` replaced the local one in `annotations`. **Batch summaries**: `library.get-summaries(keys, fields, expand, include-trashed)` is the "get items by keys with a field list" call for extend. Annotation items are served by `annotations` only; the library's item calls refuse them. `cite.format` gained `note-citation` output for the note editor.
7. **One dotted permission style, 36 ids**, all in `manifest.schema.json` with risk tiers: 14 `library.*`; `clipboard.read` / `write`; `shell.open-url` / `open-file` / `reveal`; `plugins.read`; `prefs.app-read`; `ui.webview` / `windows` / `theme` / `drop` / `navigate`; `reader.read` / `control` / `ui` / `themes`; `annotations.read` / `write`; `note-editor.read` / `write` / `control` / `ui`. (`net.hosts` is a list, not an id.)
8. **Prefs and ui agree**: the `prefs` doc comment says how `ui.node-props.pref` and `extend.setting-row` controls bind (same rules as `get` and `set`, types per control, `secret` values in `secrets` as "pref:<key>").
9. **Selection, view, tab and theme events** come only from `extend.subscribe-events`. `notifier.object-type` lost `tab`, `itemtree`, `itempane`, `infobox`.
10. **Surfaces**: `ui.surface` lists every surface extend and reader use. `info-row` and `item-pane-header` (unused) were removed; `ui.window-kind` was removed (tabs and side panels are `extend.open-tab` and `register-side-panel`). `extend.menu-entry.swatch` (a `types.color`) was added for the reader's menus.
11. **`world.wit`** was checked against the files: every host interface is imported and every callback interface exported, names match the files. `plugin-minimal` stays and imports no `fs`, `clipboard`, `shell` or `reader`. The `app-info.features` ids of all areas are in one doc comment.
12. **Others**: the reader's view-state JSON has one owner (reader), with `attachments.get-view-state` as the stored copy; `file-filter` was duplicated in ui and fs (the ui copy is gone with the dialogs); `fulltext.get-content` and `reader.get-page-text` both stay.

## Decisions (user, 2026-11-18)

1. **Real menubar.** Phase 2 adds a File / Edit / View / Go / Tools / Help menubar; plugin `menubar-*` entries go into the named menu. The overflow "Plugins" menu is only a fallback until it exists.
2. **Plugin sections in reader tabs.** Item pane sections and the `notes-add-*` menus appear in reader tabs, as in Zotero.
3. **Virtual collections in v1.** Plugins can add rows to the collection tree (`extend.register-virtual-collection`).
4. **A change log in the core.** Phase 2 adds a change log and event stream to Zinc's core, so `notifier` sees every change, not only the plugin layer's own writes.

## Open questions for the user

Collected from the five reports (duplicates merged). Nothing here blocks phase 1.

**Runtime and platform**

1. **Re-entrancy while a call waits** (lifecycle 1, extend 1, ui). While a plugin is suspended in a host import (JSPI: `net.send`; `ui.run-dialog` was removed in phase 3: dialogs use `open-dialog` and a `close` event), may the host call another export of the same instance (a menu command, `on-event` for the dialog's own buttons)? If not, `ui` drops its waiting calls and a guest SDK wraps `open-dialog` into an awaitable. Needs a phase 2 spike.
2. **Code signing and a store** (lifecycle 2). Pin a hash and show a prompt only, or add publisher signatures or an allowlisted registry?
3. **Lazy start by default, and static `contributes`** (lifecycle 3, extend 3). Start plugins lazily when they list `contributes`? Should menus, columns, section headers and preference rows be declarable in the manifest?
4. **Zotero ports** (lifecycle 4). Keep the JS-sandbox compat layer in parallel, or map `Zotero.*` calls onto the WIT at build time?
5. **App prefs allowlist** (lifecycle 5, library, reader 5). Which Zinc settings and which `reader.*` prefs may `prefs.get-app` read, and may any be written (for example "default citation style")?
6. **Plugin data on uninstall** (lifecycle 6). Delete `data` and prefs by default (the design), or keep them like Zotero?
7. **WebSocket and SSE** (lifecycle 7). Needed in 0.1?
8. **External viewers** (lifecycle 8). Allow a user-chosen external program per file type as a Zinc setting that plugins can only trigger?

**Library**

9. **Read-only SQL view schema later?** (library 1).
10. **Permission scope** (library 2): per library or per collection?
11. **Permanent delete** (library 3): allow `erase` behind `library.erase` with a prompt, or trash only?
12. **First-class `duplicate-item`, `move-item-to-library`, `convert-to-stored-file` changes** (library 4).
13. **Plugin-supplied translators** (library 5): run in the core's translator sandbox, or only existing ones (the WIT offers the second)?
14. **Cap values** (library 6): query page 1000, file read 8 MiB, upload 64 MiB, event queue 256 are guesses.
15. **Audit trail of plugin writes** in the sync layer (library 7).

**Main window (extend)**

16. ~~Real menubar~~ (extend 2). **Decided: yes** (see "Decisions" below).
17. ~~Plugin sections in the reader~~ (extend 4, reader). **Decided: yes.**
18. ~~Virtual collections~~ (extend 5). **Decided: yes, in v1.**
19. **Cells** (extend 6): is the closed `cell-body` set enough, or may a cell hold a small `ui.tree`? (Recommended: no.)
20. **Banners** (extend 7): keep a tiny public API, or toasts only?

**UI (ui)**

21. **`set-theme-override`** (ui 1): colours from plugins wanted, or never?
22. **Custom fonts** from the plugin package (ui 2): v1 or later?
23. **`web-view` caps and z-order** (ui 3): 2 per plugin, 4 total, drawn above GPUIX content: acceptable?
24. **`embed.note-editor` edit access** (ui 4): edit, or read-only first?
25. **JSON form only for JS guests** (ui 5), typed form for Rust only?
26. **Drag to the OS** from plugin UI (ui 6): allow or not?
27. **Small ui gaps** (extend): a "close all toasts" call and a "choose from a list" prompt; row-style data on table nodes. Open, optional.

**Reader**

28. **EPUB and snapshot parity at launch** (reader 1): plugin UI in the web reader, or PDF first?
29. **Selection text and privacy** (reader 2): page text as a separate, higher-risk permission?
30. **Page overlays** (reader 3): shapes only, or add `label` and `icon` shapes?
31. **Link lists and PDF internals** (reader 4): `get-page-links`, PDF metadata?
32. **Note editor toolbar** (reader 6): an extension point in the note-editor fork, or the head strip only?
33. **Per-annotation private plugin data** (reader 7): a store, or the plugin's own storage?
34. **Read Aloud** (reader 8): the one command, or a fuller interface when Zinc has the feature?
35. **Image and text annotation tools** (reader 9): the WIT creates them before the tools exist: acceptable?

## What the reconcile could not settle by itself

- The two parts that depend on a phase 2 spike: question 1 above, and how the host serves reader UI in the EPUB and snapshot web reader (question 28).
- No JSON Schema validator was run against sample manifests or sample UI trees (none is installed and `bun install` is not allowed in this phase). Both schema files parse and every `$ref` in `ui-tree.schema.json` resolves.
