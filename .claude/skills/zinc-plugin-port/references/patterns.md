# Rewrite cookbook: Zotero pattern to Zinc pattern

JS (QuickJS, the SDK in `plugin-api/sdk/js`) unless a pattern says Rust. Build/test/SDK basics: `.claude/skills/zinc-plugin-create/`.
Snippets marked **(run)** were built and executed through the supervisor in the worked example (`worked-example.md`); the others follow the WIT and the
samples in `plugin-api/samples/` and were not run: treat them as the shape, and check field names against `plugin-api/sdk/js/types/interfaces/*.d.ts`.

Contents: [0 Shape of a port](#0-the-shape-of-a-port) | [1 Lifecycle](#1-bootstrap-lifecycle-and-onmainwindowload) | [2 Prefs](#2-prefs-and-preference-panes) | [3 Fluent](#3-fluent-l10n) | [4 Menus](#4-menus-and-dom-injected-menu-items) |
[5 Columns](#5-itemtreemanager-columns) | [6 Sections](#6-itempanemanager-sections) | [7 Notifier](#7-notifier-observers) | [8 Items and DB](#8-zoteroitems-and-zoterodb) | [9 HTTP](#9-zoterohttp) |
[10 Prompts and dialogs](#10-prompts-and-dialogs) | [11 Reader](#11-reader-listeners-and-toolbar-buttons) | [12 Files](#12-file-io) | [13 Timers](#13-timers) | [14 Clipboard](#14-clipboard) |
[15 Monkey-patching](#15-monkey-patching) | [16 Traps](#16-traps-found-in-practice)

## 0. The shape of a port

A Zotero plugin is a pile of imperative code that reaches into live objects (`item.setField`, `document.getElementById`). A Zinc plugin is:

1. **Registrations** made once in `lifecycle.startup` (menu, column, section, pref pane, notifier subscription). Zinc removes them when the plugin stops, so most
   `shutdown` / `onMainWindowUnload` / `unregister*` code is deleted.
2. **Callbacks** the host calls when something happens (`extendHandlers.onMenuCommand`, `onColumnValues`, `notifierHandler.onEvents`, `uiEvents.mount`, `events.onTimer`).
   One call at a time per plugin; no re-entrancy.
3. **Data in, data out**: items are JSON (Web API `data` objects) identified by 8-char keys; writes go in one `library.apply` batch; UI is a JSON tree.

So the port is a re-expression of the *intent* of each feature, not a transliteration. Keep the pure logic (parsing, formatting, rules) unchanged; replace the I/O edges.
Skeleton (JS):

```js
import { definePlugin, ext, ui, fail } from "<zinc>/plugin-api/sdk/js/src/index.ts";
import extend from "zinc:plugin/extend@0.1.0";      // every WIT interface is a default import, functions in camelCase
import library from "zinc:plugin/library@0.1.0";
const plugin = definePlugin({ lifecycle: { startup() { /* register */ } }, extendHandlers: { /* callbacks */ } });
export const { lifecycle, events, netEvents, notifierHandler, uiEvents, extendHandlers, readerEvents, noteEvents } = plugin;
```

State that outlives one call lives in module variables (the instance persists between calls) or in `fs` root `data`.

## 1. Bootstrap lifecycle and onMainWindowLoad

Before (Zotero):

```js
async function startup({ id, version, rootURI }, reason) {
	await Zotero.initializationPromise;
	Services.scriptloader.loadSubScript(rootURI + "chrome/content/scripts/plugin.js", ctx);
	Zotero.MyPlugin.hooks.onStartup();            // register menus, columns, observers
}
async function onMainWindowLoad({ window }) { addMenuItems(window); window.document.addEventListener("keydown", h); }
function onMainWindowUnload({ window }) { removeMenuItems(window); }
function shutdown() { Zotero.Notifier.unregisterObserver(id); Zotero.MyPlugin.hooks.onShutdown(); chromeHandle.destruct(); }
```

After (Zinc): delete the sandbox plumbing (`loadSubScript`, `registerChrome`, `rootURI`, `chromeHandle`, `Zotero.MyPlugin` singleton, init promises). One `startup`.

```js
lifecycle: {
	startup(data, why) { registerEverything(); },        // reason: "app-startup" | "addon-enable" | "addon-install" | "addon-upgrade" ...
	shutdown(data, why) { /* flush plugin-owned files or timers only; registrations are removed for you */ },
	mainWindowLoad(data, windowId) { /* only for per-window state, keyed by windowId; no window object */ },
},
```

- `install` / `uninstall` still exist for one-time data setup; `uninstall` data cleanup is the host's by default (plugin `data` and prefs are deleted).
- Anything in `onMainWindowLoad` that touches `window` or `document` is a DOM injection: it becomes a registration (sections 4-6), or it is not portable (section 15).
- A hook has a time limit (startup 10 s): do slow work in a timer step after `startup` returns.

## 2. Prefs and preference panes

Before:

```js
// prefs.js:  pref("extensions.zotero.myplugin.label-new-items", false);
Zotero.Prefs.get("extensions.myplugin.label-new-items", true);      // true = the name is absolute
Zotero.Prefs.set("extensions.myplugin.label-new-items", "To Read", true);
Zotero.Prefs.registerObserver("extensions.myplugin.label-new-items", () => refresh(), true);
Zotero.PreferencePanes.register({ pluginID, src: rootURI + "prefs.xhtml", label: "My plugin", scripts: [...] });
// prefs.xhtml: <checkbox preference="extensions.zotero.myplugin.enable" data-l10n-id="pref-enable"/>
```

After. Defaults move to the manifest; keys are **relative** (the plugin's own branch); a pref's type is fixed by its default (bool, 32-bit int, string). **(run)**

```json
"default_prefs": { "label-new-items": "", "enable": true, "max-rows": 50 }
```

```js
import prefs from "zinc:plugin/prefs@0.1.0";
const v = prefs.get("label-new-items");            // pref-value | undefined, a VARIANT: { tag: "flag" | "integer" | "text", val }
const label = v?.val ?? "";
prefs.set("label-new-items", { tag: "text", val: "To Read" });
prefs.observe("plugin-own", "label-new-items", false);          // then:  events: { onPrefChanged(sub, scope, name, value) { ... } }
extend.registerPrefPane(ext.prefPane("my-prefs", ext.localized("pref-title"), [
	ext.settingToggle("enable", ext.localized("pref-enable"), "enable"),
	ext.settingNumber("max", ext.localized("pref-max"), "max-rows", { min: 1, max: 500 }),
	ext.setting("label", ext.localized("pref-label"), { tag: "choice", val: { pref: "label-new-items", options: [
		{ value: "", label: ext.localized("pref-off") }, { value: "To Read", label: { tag: "plain", val: "To Read" } }] } }),
]));
```

- XUL controls map to `setting-control`: checkbox -> `toggle`, textbox -> `text`, number textbox -> `number`, menulist/radiogroup -> `choice`, a button -> `button` (+ `extend-handlers.onPrefAction(pane, action)`), explanatory text -> `note`. `enabled-when` / `visible-when` `{pref, equals}` replace `disabled` bindings in script.
- A pane that needs a real custom UI (a table editor, a key-capture field): `content: { tag: "view" }` and return a ui tree from `uiEvents.mount` (`ctx.view === "<pane-id>"`). No XUL, no CSS file.
- Reading Zotero's own prefs (`Zotero.Prefs.get("export.quickCopy.setting")`) has no equivalent except `prefs.get-app` for an allowlist; decide a Zinc setting or drop the behaviour.
- A pref holding a list or JSON blob (e.g. `"a;b;c|x;y;z"`) stays a string pref: parse it in the plugin.
- API keys: `secrets.set/get` (permission-free, OS credential store), and `text-setting.secret: true` in the pane.

## 3. Fluent l10n

Before: `locale/en-US/addon.ftl`, `data-l10n-id="..."` in XHTML, `new Localization(["addon.ftl"])` + `formatValue(id, args)` in code, ids prefixed with the addon ref.

After: keep the `.ftl` files (rename ids freely, bundles are private). Declare them in the manifest; **(run)**

```json
"locales": { "default": "en-US", "dir": "locale" }
```

```js
ext.entry("id", ext.localized("status-none"))                          // anywhere a label is accepted: { id, args, fallback }
ext.localized("items-updated", { numItems: 3 })                         // Fluent args and plurals work as in Zotero
const s = l10n.format({ id: "tags-to-readstatus-message-done", args: [], fallback: "Done" })   // when you need the string in code
```

- Strip the `<addonRef>-` prefix handling you no longer need; a message used by DOM `data-l10n-id` attributes now goes in a node's `text` field as `{ id, args }`.
- Strings that come from Zotero itself (`Zotero.getString("general.cancel")`) are not available: copy the English text into your `.ftl`.
- `.properties` / `.dtd` sources must be converted to `.ftl`. Live re-translation on locale change is automatic.
- Plain strings are accepted everywhere a label is, so a quick port can start with literals and move to Fluent later.

## 4. Menus and DOM-injected menu items

Before (three styles seen in the wild):

```js
Zotero.MenuManager.registerMenu({ menuID: "my-menu", pluginID, target: "main/library/item",
	menus: [{ menuType: "submenu", l10nID: "menu-read", menus: [{ menuType: "menuitem", l10nID: "s-read", onCommand: (ev, ctx) => set(ctx.items, "Read") }] }] });
ztoolkit.Menu.register("item", { tag: "menu", label: getString("menu"), children: [...], getVisibility: () => getSelectedItems().length > 0 });
const mi = doc.createXULElement("menuitem"); mi.addEventListener("command", run); doc.getElementById("zotero-itemmenu").appendChild(mi);
```

After. One registration, flat entries with `parent`, visibility as data. **(run)**

```js
extend.registerMenu(ext.menu("my-menu", "library-item", [
	ext.submenu("my.root", ext.localized("menu-read"), { visibleWhen: { minItems: 1 } }),
	ext.entry("my.read", ext.localized("s-read"), { parent: "my.root", icon: "book-open", enabledWhen: { requireEditable: true } }),
]));
// extendHandlers: { onMenuCommand(menuId, entryId, checked, ctx) { ctx.items /* keys */, ctx.rows, ctx.library, ctx.editable } }
```

- Targets: `library-item`, `library-collection`, `menubar-tools|file|edit|view|go|help`, `library-add-attachment`, `library-add-note`, `tab`, `item-info-row`, `notes-add-item-note`, `notes-add-standalone-note`, `sidenav-locate`. `#zotero-itemmenu` -> `library-item`; `#zotero-collectionmenu` -> `library-collection`; `#menu_ToolsPopup` -> `menubar-tools`.
- `onShowing` rules like "only for journal articles / only when 1 item" -> `visibleWhen { itemTypes, minItems, maxItems, rowKinds, tabKinds }`. Only logic that needs data goes in `on-menu-showing` (set the entry's `hooks: { showing: true }`; it returns `entry-patch[]`; 120 ms limit).
- A big selection is cut (`ctx.itemsTruncated`): fetch the rest with `extend.listSelectedItems(undefined, 0, ctx.itemCount)`.
- Zotero 10 collection-tree multi-select: `ctx.rows` is a list; do not assume one collection (the singular getters throw in Zotero 10 anyway).
- Menu item per dynamic status list (built from a pref) -> `extend.replaceMenuEntries(menuId, entries)` when the pref changes.
- Keyboard shortcuts: `extend.registerShortcut` with an `accelerator` and `onShortcut(id, ctx)`; the user rebinds them in settings. A plugin with its own shortcut-recording UI and "one shortcut per status"
  keeps the per-status commands as separate shortcut registrations (no raw key events, no chords sequences).

## 5. ItemTreeManager columns

Before:

```js
Zotero.ItemTreeManager.registerColumn({ dataKey: "readstatus", label: "Read status", pluginID,
	dataProvider: (item) => item.isRegularItem() ? getStatus(item) : "",
	renderCell: (index, data, column) => { const span = document.createElementNS(XHTML, "span"); span.className = `cell ${column.className}`; span.textContent = data; return span; },
	zoteroPersist: ["width", "hidden", "sortDirection"] });
```

After. The provider is **batched** (one call per visible page of keys), values come back as typed cells, the host sorts. **(run)**

```js
extend.registerColumn(ext.column("readstatus", ext.localized("col"), { sort: "text", align: "start", width: 110 }));
// extendHandlers:
onColumnValues(dataKey, keys) {
	return loadItems(keys).map((j) => { const s = status(j); return { body: { tag: "text", val: s }, style: "normal", sortKey: { tag: "text", val: s } }; });
}
// after a data change:  extend.invalidateColumns("readstatus", changedKeys)
```

- Cell bodies: `text`, `icon`, `bar` (0-1), `rating {value, max}`, `chips [{text, color}]`; plus `color`, `style` (normal/bold/italic/muted/strikethrough), `tooltip`. If `renderCell` drew anything else, it does not port: pick the nearest kind or drop it.
- `htmlLabel` / `iconLabel` (icon header): `label` plus `icon: themed-icon`.
- Load data for the whole batch in one `library.getItems(keys, ...)` call (or `getSummaries(keys, fields, ...)` for plain fields), never one call per key.
- The provider must return exactly one cell per key, in order, even for missing items.
- Persisted width / visibility / sort: automatic.

## 6. ItemPaneManager sections

Before (DOM building):

```js
Zotero.ItemPaneManager.registerSection({ paneID: "my-section", pluginID,
	header: { l10nID: "sec-header", icon: "chrome://my/icon.svg" }, sidenav: { l10nID: "sec-nav", icon: "chrome://my/icon.svg" },
	onRender: ({ body, item, setSectionSummary }) => {
		const label = body.ownerDocument.createXULElement("label"); label.value = getStatus(item);
		const btn = body.ownerDocument.createXULElement("button"); btn.label = "Clear"; btn.addEventListener("command", () => clear(item));
		body.replaceChildren(label, btn); setSectionSummary(getStatus(item)); },
});
```

After. Register the section; the body is a **JSON tree** returned from `mount` / `updateContext`; clicks come back as `onEvent`.

```js
extend.registerSection(ext.section("my-section", ext.localized("sec-header"), "book-open"));
uiEvents: {
	mount: (instance, ctx) => renderSection(instance, ctx),
	updateContext: (instance, ctx) => renderSection(instance, ctx),     // the item changed
	unmount: (instance) => { current.delete(instance); },
	onEvent: (instance, ev) => { if (ev.handler === "clear") { applyStatus([current.get(instance)], undefined); return renderSection(...) } return ui.unchanged(); },
},
function renderSection(instance, ctx) {
	if (ctx.view !== "my-section") return ui.unchanged();
	const { itemKey } = JSON.parse(ctx.params);                       // also libraryID, tabType, editable
	current.set(instance, itemKey);
	const s = status(itemKey);
	return ui.render(ui.row({ style: { gap: 2 } }, ui.text(s || "None", { key: "status" }), ui.button("Clear", { on: { press: "clear" } })),
		{ meta: { summary: s } });                                     // setSectionSummary / setEnabled / setSectionButtonStatus live in meta
}
```

- Async content (a network lookup): return a "Loading" tree, then `ui.push(instance, ui.render(...))` (`zinc:plugin/ui` import) when the data arrives.
- `onItemChange` returning false (hide for some item types) -> `enabled-for: { itemTypes: [...] }` on the registration, or `decides-enabled` and `meta.enabled` for a data-dependent rule.
- Section header buttons (`sectionButtons`): `buttons` on the registration; a press arrives as `onEvent` with `kind: "press"` and `handler` = the button id.
- Elements -> nodes: `label`/`description` -> `text`; `button` -> `button`; `checkbox`/`menulist`/`textbox` -> `checkbox`/`select`/`text-input` (`name` gives a form value); `vbox`/`hbox` -> `column`/`row` with `style.gap`; `richlistbox` -> `list-view`; `html:table` -> `table`.
  See `ui.md` "elements and APIs plugins use" and `ui-tree.schema.json`.
- **Rust**: same shape with `ui::render(ui::row().gap(2).child(...))`; see `samples/word-count`. Choose Rust when the section's computation is heavy (section 0 of `go-no-go.md`).
- A Zotero *Info row* (a label + value in the Info section) is simpler: `extend.registerInfoRow` + `onInfoRowGet(rowId, item, tab, editable) -> { value, enabled, editable }`.

## 7. Notifier observers

Before:

```js
Zotero.Notifier.registerObserver({ notify: async (event, type, ids, extraData) => {
	if (event == "add") { const items = Zotero.Items.get(ids).filter((i) => i.isRegularItem()); label(items); } } }, ["item"], "my-plugin", 1);
```

After: subscribe once, receive **batches of events**; ids are keys (strings). **(run)**

```js
notifier.subscribe({ types: ["item"], kinds: ["add"], priority: 1, skipOwn: true, maxDelayMs: 200, label: "my-plugin" });   // import notifier from "zinc:plugin/notifier@0.1.0"
notifierHandler: { onEvents(subId, batch) {
	const keys = batch.events.filter((e) => e.object === "item" && e.kind === "add").flatMap((e) => e.ids);
	if (keys.length) label(keys);
} },
```

- `skipOwn: true` stops the loop where your own `library.apply` triggers your handler (Zotero code used `extraData` markers or `skipNotifier`); `batch.events[i].origin` says who wrote (`user`, `sync`, `connector`, `this-plugin`, `plugin(id)`, `external`).
- `file` / `open` (a file was opened in the reader) is not an item event: `reader.subscribe` with `opened` and `reader-events.onReaderEvent` (permission `reader.read`). `tab` events: `extend.subscribe-events`.
- `Notifier.trigger` of custom events and `itempane` / `itemtree` events: see api-map.
- The handler gets no live objects: fetch what you need with `library.getItems(keys, ...)` (permission `library.read`; the subscription itself needs it).
- Events made by the user come from the core change log; it exists since phase 2 of the host. If the core in front of you has no change log, only your own writes appear: say so in the report.

## 8. Zotero.Items and Zotero.DB

Rule: **rewrite the intent**. No object has `setField` and no SQL runs.

Before:

```js
const items = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).filter((i) => i.isRegularItem());
await Zotero.DB.executeTransaction(async () => { for (const item of items) { item.setField("extra", newExtra(item)); await item.saveTx({ skipDateModifiedUpdate: true }); } });
const rows = await Zotero.DB.queryAsync("SELECT itemID, value FROM itemData JOIN itemDataValues USING(valueID) WHERE fieldID = ?", [fid]);
const sel = ZoteroPane.getSelectedItems();
```

After. **(run)**

```js
const page = library.queryItems({ library: 1, scope: { tag: "all" }, tags: [], text: undefined, textMode: "title-creator-year",
	search: undefined, fields: ["extra"], expand: {}, sort: [], limit: 1000, offset: 0 });   // item-page { total, items: item-summary[] }; loop offset until done
const jsons = library.getItems(keys, { includeChildren: false, includeTrashed: false }).map((s) => (s ? JSON.parse(s) : undefined));   // json fields are STRINGS
library.apply(changes, { skipNotify: false });      // ONE atomic batch: all or none; throws { index, error } on failure
const changes = items.map((j) => ext.change("update-item", { key: j.key, patch: JSON.stringify({ extra: newExtra(j) }), expectedModified: j.dateModified }));
```

- `ext.change(tag, val)` tags: `create-item`, `update-item`, `trash-items`, `restore-items`, `erase-items`, `add-to-collection`, `remove-from-collection`, `add-tags`, `remove-tags`, `add-related`, `remove-related`, `create-collection`, `update-collection`, `erase-collection`, saved-search variants. Tags: `{ items, tags: [{ name, kind: "manual" | "automatic" }] }`.
- `patch` is PATCH semantics: only the fields present change; `creators`, `tags`, `collections`, `relations` replace the whole list; `""` clears a field. `expectedModified` gives a conflict check where Zotero relied on its in-memory object.
- Chunk big batches (a few hundred changes per apply) and report progress with a toast; a failed batch leaves nothing half-done, which is better than Zotero's loop.
- Counting/grouping SQL -> `library.countItems(query)`, `library.facets(query, field, limit)` (`"tag"`, `"itemType"`, `"year"`, `"creator"`, any field), `library.listTags`. Joins across tables that no call covers: report it.
- Numeric ids: collect keys from `query-keys` / `ctx.items` instead of `item.id`. `item.isRegularItem()` is `itemType not in (note, attachment, annotation)`.
- Extra field helpers: `dataUtils.parseExtra(extra)` exists; or keep your own line-based parser (pure code stays).
- Selected items arrive in the callback `ctx` (section 4); there is no `ZoteroPane` to ask.
- `skipDateModifiedUpdate` does not exist: the host stamps `dateModified` on every change.
- Attachments: `attachments.getInfo`, `readFileAll`, `importBytes` (see api-map), paths are not given unless `library.files.paths`.

## 9. Zotero.HTTP

Before:

```js
const xhr = await Zotero.HTTP.request("POST", "https://api.example.org/v1/lookup", { body: JSON.stringify({ doi }), headers: { "Content-Type": "application/json" },
	responseType: "json", timeout: 15000, successCodes: [200] });
const data = xhr.response;
```

After. Declare the host; bytes in, bytes out. **(from WIT, not run)**

```json
"permissions": { "capabilities": [], "net": { "hosts": ["https://api.example.org"] } }
```

```js
import net from "zinc:plugin/net@0.1.0";
const enc = new TextEncoder(), dec = new TextDecoder();
try {
	const res = net.send({ method: "POST", url: "https://api.example.org/v1/lookup", headers: [{ name: "Content-Type", value: "application/json" }],
		body: enc.encode(JSON.stringify({ doi })), timeoutMs: 15000, successCodes: [200], redirect: "follow", cookies: { tag: "none" }, bypassCache: false });
	const data = JSON.parse(dec.decode(res.body));
} catch (e) { const err = e.payload;   // net-error: { tag: "unexpected-status", val: response } | "timeout" | "offline" | "blocked" | ... }
```

- `fetch()` and `XMLHttpRequest` map to the same call. `response.json()` -> `JSON.parse(dec.decode(res.body))`.
- `responseType: "document"` / `processDocuments`: no DOM. Parse HTML with a pure-JS library bundled into the plugin, or use the JSON API of the same site.
- Local services (an Ollama or Obsidian REST server): list the exact `http://localhost:<port>` host; port 23119/23120 (Zotero's own) is refused. `*` as a host is a high-risk permission: prefer the list.
- Downloads: `net.download(req, { root: { tag: "temp" }, path: "x.pdf" }, options)` then `attachments.importBytes`, or `attachments.importFromUrl` directly (net permission applies).
- Rate limiting and retries: `retry: { delaysMs: [1000, 3000], maxTotalMs: 10000, surfaceThrottle: true }`.
- `timers.sleep(ms)` replaces `Zotero.Promise.delay` between requests.
- Cookie sessions of the user's real browser/Zotero are never shared; a `jar(name)` is private.

## 10. Prompts and dialogs

Before (blocking: the call returns the answer):

```js
const ps = Services.prompt;
if (ps.confirm(window, "Delete", "Remove all statuses?")) { clearAll(); }
const name = { value: "" }; if (ps.prompt(window, "Name", "Status name:", name, null, {})) add(name.value);
window.openDialog("chrome://my/content/dialog.xhtml", "", "chrome,modal", params);  // reads params.out afterwards
const pw = new Zotero.ProgressWindow(); pw.changeHeadline("Updating"); const ip = new pw.ItemProgress(icon, "Working"); pw.show(); ip.setProgress(50); ip.setText("Done"); pw.startCloseTimer(4000);
```

After: **non-blocking**. Open the dialog, return, and continue in the `close` handler. **(run in the samples: quick-tags)**

```js
import zui from "zinc:plugin/ui@0.1.0";
const content = ui.form({ key: "form" }, ui.column({ style: { gap: 2 } }, ui.label("Remove all statuses?"), ui.textInput("", { name: "reason", placeholder: "why" })));
ui.dialog(ui.dialogSpec("Delete", content, [{ id: "cancel", label: "Cancel", role: "cancel" }, { id: "ok", label: "Remove", role: "destructive", isDefault: true }]), zui)
	.then((outcome) => { if (outcome.button !== "ok") return; clearAll(ui.fieldValue(outcome.values, "reason")); });
// the lifecycle callback RETURNS right away; do not await it inside code that must finish synchronously.
```

- Simple cases have shortcuts: `zui.alert(title, message, tone)`; `zui.confirm({ title, message, acceptLabel, cancelLabel, destructive, checkboxLabel }) -> { accepted, checkbox }` and `zui.prompt(...)` are **synchronous host calls**; they are fine for a quick yes/no but check that your Zinc build answers them (they suspend the plugin: see open question 1 in `README.md`). If a run shows them unavailable, use `ui.dialog`.
- Three buttons, a checkbox, a list to choose from, `buttonDelay`: build it with `dialogSpec` (buttons carry `role`).
- A dialog that was an XHTML window with its own script: a ui tree in `content`; its inputs come back as `outcome.values` (named fields) or as `onEvent` events while open (`zui.updateDialog(instance, render-result)`).
- Progress: `zui.showToast({ title, lines: [{ text, progress }], tone, durationMs, actions })` returns an instance; `updateToast(instance, spec)`, `closeToast`. Keep the ids: there is no "close all".
- Code after the old blocking call moves into the `.then` / close handler; loops that asked the user per item become a state machine or one dialog with a list.
- At most one modal dialog per plugin at a time (`limit-exceeded`).

## 11. Reader listeners and toolbar buttons

Before:

```js
Zotero.Reader.registerEventListener("renderToolbar", (event) => {
	const { doc, append, reader } = event; const btn = doc.createElement("button"); btn.textContent = "Export"; btn.onclick = () => exportAnnotations(reader._item);
	append(btn); }, pluginID);
Zotero.Reader.registerEventListener("createAnnotationContextMenu", (event) => { event.append({ label: "Send to notes", onCommand: () => send(event.params.ids) }); }, pluginID);
const text = reader._internalReader._lastView._selectionPopup?.annotation.text;
```

After. **(from the `highlight-export` sample and reader.wit, not run here)** Permissions `reader.ui` (registrations), `reader.read` (state, selection), `annotations.read` / `annotations.write`.

```js
import reader from "zinc:plugin/reader@0.1.0";
reader.registerListener(ext.readerListener("my-tool", { tag: "slot", val: "toolbar" }));                       // toolbar button: a ui view
reader.registerListener(ext.readerListener("my-ann", { tag: "menu", val: "annotation" }, [ext.entry("my.send", "Send to notes")]));
// uiEvents.mount(instance, ctx) with ctx.view === "my-tool" returns the button tree; its press arrives in uiEvents.onEvent
// readerEvents.onMenuCommand(...) for the menu entry; params carry the annotations (full list) and the current one
const sel = reader.getSelection(readerId);               // reader id from reader-info or list-readers; text-selection { text, draft }, replaces _selectionPopup
const anns = annotations.listAnnotations({ library: 1, key: attachmentKey });   // replaces reader._internalReader._state.annotations
```

- Slots: `toolbar`, `text-selection-popup`, `sidebar-annotation-header`. Menus: `annotation`, `view`, `thumbnail`, `color`, `selector`, `theme`.
- `_internalReader` / `_iframeWindow` use is classified use by use in `api-map.md` (Reader) and the "What plugins use `_internalReader` and `_iframeWindow` for" table in `reader.md`: selected text, annotations, navigate, tool, page text, overlays, shortcuts have typed replacements; DOM restyling and pointer events do not.
- Reader opened/closed/page-change events: `reader.subscribe`.

## 12. File IO

Before:

```js
const path = PathUtils.join(Zotero.DataDirectory.dir, "my-plugin", "cache.json");
await IOUtils.writeJSON(path, data);  const back = await IOUtils.readJSON(path);
const fp = new FilePicker(); fp.init(window, "Export", fp.modeSave); fp.appendFilter("CSV", "*.csv"); if (await fp.show() == fp.returnOK) await IOUtils.writeUTF8(fp.file, csv);
const pdf = await item.getFilePathAsync();  const bytes = await IOUtils.read(pdf);
```

After. **(from WIT, not run)** Relative paths inside four roots, never absolute paths.

```js
import fs from "zinc:plugin/fs@0.1.0";
const f = { root: { tag: "data" }, path: "cache.json" };                        // data = the plugin's own folder (512 MiB), temp, bundled (read only), granted(id)
fs.writeText(f, JSON.stringify(data), { createParents: true, onConflict: "overwrite", atomic: true });
const back = JSON.parse(fs.readText(f));
const grant = fs.pickSave({ title: "Export", filters: [{ label: "CSV", extensions: ["csv"] }], persistent: false }, "export.csv");   // file-grant | undefined
if (grant) fs.writeText({ root: { tag: "granted", val: grant.id }, path: "" }, csv, { createParents: false, onConflict: "overwrite", atomic: true });
const bytes = attachments.readFileAll(attachmentKey, 64n * 1024n * 1024n);       // the file of an attachment, no path needed
```

- A user-chosen path stored in a pref (`export-dir`) becomes a persistent grant (`pick-directory` with `persistent: true`, keep `grant.id`; `fs.listGrants()` later) or an `fs.pickSave` each time.
- Reading a PDF's bytes: `attachments.readFile(key, offset, length)` / `readFileAll`. Path wanted by an external tool: `library.files.paths` permission and `attachment-info.path`, but there is no way to spawn a process.
- Opening in the OS: `shell.openFile`, `shell.reveal`, `shell.openUrl`, or `attachments.openFileExternal(key)`.
- Zip/unzip, symlinks, permission bits, `subprocess`: not available (bundle a zip library for bytes in memory).
- Bundled resources (templates, default JSON): ship them in the package and `fs.readText({ root: { tag: "bundled" }, path: "templates/x.html" })`.

## 13. Timers

Before: `setTimeout(() => refresh(), 500); const id = setInterval(poll, 5000); clearInterval(id);`

After: **(from WIT, not run)** timers are host-side; the callback is a single export.

```js
import timers from "zinc:plugin/timers@0.1.0";
const pending = new Map();                                  // timer id -> function
function later(ms, fn) { const id = timers.setTimeout(ms); pending.set(id, fn); return id; }
events: { onTimer(id, kind) { const f = pending.get(id); if (kind === "timeout") pending.delete(id); f?.(); } }
timers.clear(id);  timers.sleep(200);                       // sleep blocks the plugin (synchronous call)
const now = Number(timers.now());                           // epoch ms; use instead of Date.now()
```

- **Never call `new Date()` / `Date.now()` with no argument** in the JS guest: the component has no WASI clock and the call traps (`wasm unreachable`). `new Date(Number(timers.now()))` works. **(found in the dry run)**
- `performance.now()` -> `timers.monotonicMs()`. `requestIdleCallback` -> `timers.requestIdle(deadlineMs)`.
- Debounce = keep the latest timer id and `clear` it.

## 14. Clipboard

Before: `Zotero.Utilities.Internal.copyTextToClipboard(text)`, or `new CopyHelper().addText(html, "html").addText(text, "text").copy()`.

After. **(from WIT, not run)** Permission `clipboard.write` (low risk) or `clipboard.read` (high risk, first read is confirmed).

```js
import clipboard from "zinc:plugin/clipboard@0.1.0";
clipboard.write({ text, html: htmlFragment, imagePng: undefined });
const { text: pasted } = clipboard.read();                       // needs clipboard.read and a focused Zinc window
```

## 15. Monkey-patching

The plugin cannot change host code. For each patch in the inventory (`patching` area of the scan: `patch(`, `PatchHelper`, `ztoolkit.patch`, `X.prototype.y =`, `Zotero.A.b = function`):

1. **Say what the patch is for**, in one line of user-visible behaviour ("hide the read-status lines from exported Extra", "add a tag after an item is saved", "sort by a custom field").
2. **Find the closest extension point** with this table. If one covers the intent, port the intent through it.
3. **Otherwise report it as not portable** (go/no-go report: "Cannot be ported") and ask whether to ship the port without it. Never emulate by polling the host DOM or guessing at internals.

| What the patch usually does | Closest Zinc point | Verdict |
|---|---|---|
| Add a virtual field / computed value to items | column (`register-column`), info row (`register-info-row`), row style | covers display; not search or sort of built-in views |
| Change how rows look (colour, bold, icon) | `register-row-style`, `register-collection-decoration` | covered |
| Add a context-menu entry by wrapping the menu builder | `register-menu` | covered |
| Intercept item save / add / modify to run extra logic | `notifier.subscribe` + `library.apply` afterwards | after the fact, not before; cannot veto or alter the save |
| Alter export / citation output (e.g. strip a field from `itemToExportFormat`) | none in the pipeline; post-process `translate.export-items` / `cite.format` results in a plugin-owned command | **not portable** as a global hook (only for exports the plugin itself triggers) |
| Replace a Zotero dialog or pane (item box, collection tree behaviour) | sections, info rows, side panels, tabs | **not portable** |
| Override or add keyboard handling globally | `register-shortcut` (named chord) | partial |
| Patch the reader (`ReaderInstance`, `_internalReader`, PDF.js) | `reader.*` typed API, overlays, panels | case by case (api-map, Reader) |
| Change sync, translators, the schema, the DB layer | none | **not portable** |
| Wrap `Zotero.Prefs`, `Zotero.Notifier`, `Zotero.HTTP` to log or alter other plugins | none | **not portable** |

## 16. Traps found in practice

- **`new Date()` with no argument traps** in a JS guest (no WASI clock). Use `timers.now()`. The trap message is only `wasm unreachable`: bisect with `log.write` lines.
- **JSON-typed WIT fields are strings**: `library.getItems` returns `option<json>` (JSON text), `update-item.patch` and `dialog-spec.content` take JSON text. `JSON.parse` / `JSON.stringify` at the edge.
- **Variants are `{ tag, val }`**: a pref is `{ tag: "text", val: "x" }`, an event payload `{ tag: "button", val: "ok" }`, a cell body `{ tag: "text", val }`; an `option` is the value or `undefined`; `u64` is a `BigInt` (`timers.now()` returns one: `Number(...)`).
- **A required record field you leave out traps the guest.** The SDK builders (`ext.*`, `ui.*`) and `definePlugin` fill defaults for you; for a hand-built record use `fill("extend/ColumnRegistration", {...})`.
- **Colours above 2^31 are clamped** unless built with `rgba()` / `hexColor()` / `themedColor()` from the SDK.
- **Callbacks return, they do not wait.** No `await` on a dialog inside a callback that must produce a value (menu showing, column values).
- **One call at a time per plugin**: a slow `onColumnValues` delays menu commands. Batch library reads.
- **Writing files with a shell heredoc** can eat backslashes in regexes on this machine's shell hook: write source files with the editor tool, then `bun` the build.
- **The plugin id** `applications.zotero.id` carries over (`name@domain`); change it only if both plugins must be installable side by side (Zinc is a different app, so keeping it is fine).
