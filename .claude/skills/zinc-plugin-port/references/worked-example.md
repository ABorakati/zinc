# Worked example: Zotero Reading List

A dry run of this skill (2026-11-18). The plugin: **Zotero Reading List** by Dominic Dall'Osto, https://github.com/Dominic-DallOsto/zotero-reading-list,
release 1.7.2, ~600 stars, declares Zotero 7.0.9 to 10.0.\*. Licence: the `LICENSE.md` text is GPL-3.0 while `package.json` says AGPL-3.0-or-later (report both and ask which governs; both are copyleft,
so the port keeps the same terms and notices). The plugin lets you mark items as New / To Read / In Progress / Read / Not Reading, shows the status in an item-list column, adds a context
menu, can label new items, can change status when a file is opened, can mirror the status as tags, and has keyboard shortcuts and a custom-status editor. Status is stored in the item's Extra
field as `Read_Status: <name>` and `Read_Status_Date: <iso date>`. Nothing from the plugin's code is reproduced in this skill; the notes below are the process and the decisions.

## Step 1: inventory

```bash
gh release download v1.7.2 -R Dominic-DallOsto/zotero-reading-list -D "$TEMP/zn-skill-port/xpi"
bun .claude/skills/zinc-plugin-port/scripts/scan.ts "$TEMP/zn-skill-port/xpi/zotero-reading-list.xpi"       # the xpi
bun .claude/skills/zinc-plugin-port/scripts/scan.ts "$TEMP/zn-skill-port/src-clone/zrl"                      # or the repo
```

What the scan gave (xpi): 43 patterns, 22 covered, 12 partial, 9 not planned. It recognised that `zotero-plugin-toolkit` is bundled into the JS (the `// node_modules/...` markers of the esbuild
output) and skipped it, so the hits are the plugin's own code (before that fix the toolkit's own DOM helpers drowned the report). Reading the hits against the code:

| Feature | APIs seen | Verdict |
|---|---|---|
| status in Extra, set from a menu | `item.getField/setField("extra")`, `saveTx`, `ZoteroPane.getSelectedItems`, toolkit `Menu.register` (a submenu with one entry per status) | clean: menu + `library.apply` update-item |
| status column | `ItemTreeManager.registerColumn` with a DOM `renderCell` (a span) | clean: the cell is plain text; `renderCell` is dropped |
| label new items | `Notifier.registerObserver(["item"])`, event `add` | clean: `notifier.subscribe` + `onEvents` |
| prefs and pane | `Prefs.get/set(…, true)` on the plugin's own absolute names, `registerObserver`, `PreferencePanes.register` with an XHTML pane (checkboxes, radiogroups, a custom status editor table) | the simple prefs become setting rows; the status-list editor and shortcut recorder need a custom `view` pane: changed behaviour |
| change status when a file is opened | notifier type `file`, event `open` | changed: `reader.subscribe(opened)` (permission `reader.read`), not a notifier item event |
| keyboard shortcuts | `document.addEventListener("keydown")`, a modifier-mask recorder UI | partial: one named command per status via `register-shortcut`; the recorder UI is the host's |
| tag sync, "update all items" | `Items.getAll`, `DB.executeTransaction`, `item.addTag`, `ProgressWindow` | clean: `query-items` pages + chunked `apply` + a toast |
| strip the status lines from exports | monkey-patch of `Zotero.Utilities.Internal.itemToExportFormat` | **cannot be ported** (no export hook); report it |
| prompts | `Services.prompt.alert` for validation errors | clean: `ui.alert` or inline text |
| bootstrap plumbing | `Components.classes`, `registerChrome`, `loadSubScript`, `Cu.unload` | deleted |

## Step 2: go/no-go (what was told to the user, condensed)

GO with one cut. Ports cleanly: set/clear status from the item menu, the status column (text only), new-item labelling, tag synchronisation, per-status toasts. Changed: the preference
page (simple options become setting rows; the editor for custom statuses is a ui-tree pane), "change status on open" (reader event), shortcuts (one command per status, bound in Zinc's shortcut
settings), statuses by name in `Extra`, numeric ids gone. Cannot be ported: hiding the status lines from exported items (it patches Zotero's export serialiser). Language: JavaScript, since the work
is string handling over a handful of items; no heavy loops (tag synchronisation over a whole library is the only batch job, and it is I/O bound on `library.apply`).

## Step 3: the port (the core feature)

Scratch project: `manifest.json` + `locale/en-US/addon.ftl` + `src/main.js` (~90 lines), the original `LICENSE.md` copied in and a `NOTICE` naming the original author and repository.
Mapping used: `ZoteroPane.getSelectedItems` -> `ctx.items`; `registerColumn` + `dataProvider` -> `registerColumn` + `onColumnValues`; `ztoolkit.Menu.register` with children -> `registerMenu` with a submenu and
`parent` entries; `Notifier.registerObserver` -> `notifier.subscribe` + `onEvents`; `Zotero.Prefs.get/set` -> `prefs.get` (variant result) and `default_prefs`; XUL radiogroup -> `choice` setting row;
`item.setField("extra")` + `saveTx` -> one `library.apply` of `update-item` patches with `expectedModified`. The pure Extra-field parser was kept (rewritten only to be string-in, string-out).
Permissions: `library.read`, `library.write`. Not ported in the dry run: file-open trigger, shortcuts, tag sync, the custom-status editor, the export patch.

It built in ~4 s and ran through `verify-port.ts` against the throwaway core with a scenario that checked: startup registered one menu, one column, one pref pane; the "Read" menu command wrote
`Read_Status: Read` and a date into Extra; the column returned `Read`; "None" removed both lines; with the "label new items" pref set to "To Read", an item created through the core's API (origin: user)
received `Read_Status: To Read` from the notifier handler. 8 of 8 checks passed (`scripts/scenario.example.ts`).

## What went wrong on the way, and what the skill now says

- The first run trapped (`wasm unreachable`, no message) on the first menu command. Cause: `new Date().toISOString()` for the status date: the guest has no clock. Fix: `new Date(Number(timers.now()))`.
  The parity table says this (lifecycle row 95) but only in passing; `patterns.md` section 13 and 16 now call it out.
- The harness's pref stub first returned plain strings; `pref-value` is a variant (`{tag, val}`), so the notifier handler never saw the setting. The harness now wraps values; the pattern is in `patterns.md` section 2.
- `Zotero.Prefs.get(name, true)` made the scan flag "global prefs" as partial. In Zotero the `true` means "the name is absolute", and a plugin's own `extensions.<id>.key` is a normal case. The scan rule's note now says to
  check the key. (Parity table rows lifecycle 38 and 39 contradict each other on this point.)
- Heredocs written through the shell hook lost a regex's backslashes: write source with the editor tool.
- Scanning the bundled XPI first listed 70+ DOM hits that belonged to the toolkit library; the scanner now blanks bundled `node_modules` regions.
