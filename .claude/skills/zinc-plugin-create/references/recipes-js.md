# Recipes, JavaScript (QuickJS)

All snippets were built with `plugin-api/sdk/js/scripts/build.ts` and run through the supervisor (stub imports) unless marked "built only". Contents: skeleton; menus and commands; columns; item pane sections; dialogs; preferences; notifier; library; reader; network; l10n; timers.

## Skeleton

```js
import { definePlugin, fail, fill, u32, ui, ext } from "<zinc>/plugin-api/sdk/js/src/index.ts";   // the scaffold writes the path
import extend from "zinc:plugin/extend@0.1.0";      // one default import per WIT interface your world has
import library from "zinc:plugin/library@0.1.0";
import prefs from "zinc:plugin/prefs@0.1.0";
import timers from "zinc:plugin/timers@0.1.0";
import zui from "zinc:plugin/ui@0.1.0";
import log from "zinc:plugin/log@0.1.0";

const plugin = definePlugin({
	lifecycle: { startup() { /* register everything here */ } },
	extendHandlers: { /* onMenuCommand, onColumnValues, ... */ },
	uiEvents: { /* mount, updateContext, onEvent, unmount */ },
	events: { /* onPrefChanged, onTimer, onLocaleChanged */ },
	notifierHandler: { /* onEvents */ },
	readerEvents: { /* onMenuCommand, buildMenu */ },
});
// Keep this line: the QuickJS guest looks its exports up by these names. If a newer WIT adds an exported interface
// (check sdk/js/types/exports.d.ts after `bun plugin-api/sdk/js/scripts/gen-types.ts`), add its camelCase name here.
export const { lifecycle, events, netEvents, notifierHandler, uiEvents, extendHandlers, readerEvents, noteEvents } = plugin;
```

`definePlugin` supplies a safe default for every export you leave out. Failing a `result<_, error>` callback: `fail("invalid-argument", "msg")` (throws). A failing import throws an object; its `.payload` is the `error` variant: `{ tag: "permission-denied", val: "library.write" }`. Imports that are `u64` return `BigInt` (`library.countItems`): use `Number(x)` before arithmetic, and never `JSON.stringify` a BigInt (it throws).

## Menus and commands

Targets (`menu-target`): `menubar-file|edit|view|go|tools|help`, `library-item` (item context menu), `library-collection`, `library-add`, `library-add-attachment`, `library-add-note`, `tab`, `item-info-row`, `notes-add-item-note`, `notes-add-standalone-note`, `sidenav-locate`.

```js
startup() {
	extend.registerMenu(ext.menu("my-item-menu", "library-item", [
		ext.entry("my.tag", "Tag selected items", { icon: "tag", visibleWhen: { minItems: 1 }, enabledWhen: { requireEditable: true } }),
		ext.separator("my.sep"),
		ext.submenu("my.more", "More"),
		ext.entry("my.flag", "Flag", { parent: "my.more", check: true }),                // check item: `checked` arrives in the command
		ext.entry("my.dyn", "Dynamic", { showing: true }),                                 // asks for onMenuShowing before it is drawn
	]));
},
// extendHandlers:
onMenuCommand(menuId, entryId, checked, ctx) {
	if (menuId !== "my-item-menu") return;
	const items = ctx.itemsTruncated ? extend.listSelectedItems(undefined, 0, ctx.itemCount) : ctx.items;   // ctx.items has at most 2000 keys
	if (entryId === "my.tag") { /* ... */ }
},
```

`ctx` (`extend.context`): `window`, `tab`, `library`, `rows` (the selected collection-tree rows, a list: several can be selected), `items`, `itemCount`, `itemsTruncated`, `editable`, `field`. Reading it needs `library.read`. Other conditions: `itemTypes: ["journalArticle"]`, `maxItems`, `tabKinds`, `rowKinds`. Menubar entries go into the named menu (Tools, Edit, ...). Other entry points: `extend.registerShortcut`, `extend.registerToolbarButton` (+ `onShortcut`, `onToolbarClick`).

## Item list column

```js
startup() { extend.registerColumn(ext.column("my-col", "Mine", { width: 90 })); },     // sort: "number" default; pass { sort: "text" } for text keys
// extendHandlers:
onColumnValues(dataKey, keys) {
	if (dataKey !== "my-col") fail("invalid-argument", "unknown column " + dataKey);
	// ONE batched import call for all keys (e.g. library.getSummaries(keys, [], {}, false)), then one cell per key, in order
	return keys.map((key) => ({ body: { tag: "text", val: "42" }, style: "normal", sortKey: { tag: "number", val: 42 } }));
},
```

Cell body variants: `text`, `icon`, `bar` (0..1), `rating`, `chips`. `style`: `normal|bold|italic|muted|strikethrough`. Missing required fields of a returned cell are filled for you. When your data changes, redraw: `extend.invalidateColumns("my-col", undefined)` (all rows) or `("my-col", ["KEY1"])`. The host calls `onColumnValues` for the visible rows, so keep it cheap; cache by key and clear the cache when inputs change.

## Item pane section (JSON tree, events, push, refresh)

```js
const SECTION = "my-section";
const mounted = new Map();                                  // instance (bigint) -> state

function view(st) {
	return ui.render(ui.column({ style: { gap: 2 } },
		ui.text(`Item ${st.key}: ${st.clicks}`, { key: "label" }),
		ui.button("Click me", { on: { press: "click" } }),
		ui.checkbox("Enabled", false, { pref: "enabled" }),     // a control can bind straight to a plugin pref
	));
}
function mountSection(instance, ctx) {
	if (ctx.view !== SECTION) return ui.unchanged();
	const key = JSON.parse(ctx.params).itemKey;             // ctx.params is JSON; for an item pane section it holds itemKey
	const st = { key, clicks: 0 };
	mounted.set(instance, st);
	return view(st);
}
startup() { extend.registerSection(ext.section(SECTION, "My section", "info")); },   // label, built-in icon name
// uiEvents:
mount(instance, ctx) { return mountSection(instance, ctx); },
updateContext(instance, ctx) { return mountSection(instance, ctx); },   // the selected item changed: same body as mount (a shared function: do not use `this`)
onEvent(instance, event) {                                  // event: { handler, nodeKey, kind, payload, rev }
	const st = mounted.get(instance);
	if (st && event.handler === "click") { st.clicks++; return view(st); }
	return ui.unchanged();
},
unmount(instance) { mounted.delete(instance); },
```

- Every handler must return a render result: `ui.render(tree)`, `ui.unchanged()`, or `ui.patch(baseRev, rev, ops)` for incremental edits (nodes need `key`s).
- Update a view later (after a network call or a timer) with `zui.push(instance, ui.render(newTree))`. Ask the host to call `updateContext` again with `zui.refresh(instance)`.
- Form values: `event.payload` is `{ tag: "value" | "toggled" | "form" | ... }`; read all named fields with `zui.formValues(instance)` and `ui.fieldValue(values, "name")`.
- Node builders: `ui.column/row/box/card/group/section/form/spacer/separator`, `ui.text/label/caption/heading/mono`, `ui.callout(tone, msg)`, `ui.badge`, `ui.progress`, `ui.button/submitButton`, `ui.textInput(value, {name, placeholder})`, `ui.checkbox`, `ui.select([[value,label],...], value)`; anything else with `ui.h("table", { columns, rows, ... }, ...children)`. The tree must match `plugin-api/ui-schema/ui-tree.schema.json`; unknown props are errors. Check trees in tests with `checkRender` from `scripts/smoke.ts`. Limits: 5000 nodes, depth 64. Props that take text accept a string or `{ id, args, fallback }`.
- Section header buttons: `ext.section(id, label, icon, { buttons: [{ id: "refresh", icon: ext.icon("refresh-cw"), hidden: false, disabled: false }] })`; a press arrives in `onEvent` with `handler` = the button id.

## Dialogs (promise helper)

```js
function askName() {
	const content = ui.form({ key: "form" }, ui.column({ style: { gap: 2 } }, ui.label("Name"), ui.textInput("", { name: "name", autoFocus: true })));
	const spec = ui.dialogSpec("My Plugin", content, [
		{ id: "cancel", label: "Cancel", role: "cancel" },
		{ id: "ok", label: "OK", role: "accept", isDefault: true },
	]);
	ui.dialog(spec, zui).then((out) => {                    // out: { button, values }; button is undefined if dismissed
		if (out.button !== "ok") return;
		zui.showToast(ui.toastSpec("My Plugin", `Hello, ${ui.fieldValue(out.values, "name")}!`, "success"));
	});
}
```

`ui.dialog` opens with `ui.open-dialog` (non-blocking) and resolves when the `close` event arrives in `uiEvents.onEvent`; `definePlugin` routes it. The code in `.then` (or after `await`) runs in that later call, with its own time budget. Return from the menu command without awaiting if you can (a void export that returns a pending Promise is allowed: the SDK returns `undefined` so the close event can enter). There is no blocking `run-dialog`. Quick answers without content: `zui.alert(title, message, tone)`, `zui.confirm(spec)`, `zui.prompt(spec)` block until the user answers (no plugin content is shown, so nothing needs to re-enter). Toasts: `zui.showToast(ui.toastSpec(title, message, tone))`; tones `neutral|info|success|warning|error`. Needs world `plugin-ui` for any dialog outcome.

## Preferences and preference panes

```js
// manifest.json: "default_prefs": { "enabled": true, "count": 3, "name": "x" }
startup() {
	extend.registerPrefPane(ext.prefPane("my-prefs", "My Plugin", [
		ext.settingToggle("enabled", "Enabled", "enabled"),                       // (row id, label, pref)
		ext.settingNumber("count", "Count", "count", { min: 0, max: 10, step: 1 }),
		ext.settingText("name", "Name", "name"),                                   // { secret: true } for API keys, { multiline: true }
	]));
	prefs.observe("plugin-own", "enabled", false);                               // (scope, key, prefix?) -> subscription id
},
// events:
onPrefChanged(subscription, scope, name, value) { /* value: { tag: "flag", val: true } | undefined */ },
```

Reading and writing: `prefs.get("count")` -> `{ tag: "integer", val: 3 }` or `undefined`; `prefs.set("count", { tag: "integer", val: 4 })`; `prefs.clear(key)`. Setting rows with a button (`{ tag: "button", ... }`) call `extendHandlers.onPrefAction(paneId, actionId)`. A whole-view pane: `content: { tag: "view" }` and the pane is mounted like a section. Prefs written by the user's settings page fire `onPrefChanged` like your own writes.

## Notifier (library changes)

```js
startup() { notifier.subscribe({ types: ["item"], kinds: ["add", "modify", "trash"], priority: 0, skipOwn: true, maxDelayMs: 250, label: "my-plugin" }); },
// notifierHandler:
onEvents(subscription, batch) {             // batch: { seq, at, events: [{ object, kind, ids, library, origin, ... }] }
	for (const ev of batch.events) if (ev.kind === "add") { /* ev.ids: string[] item keys */ }
},
```

Events are merged per (object, kind, library, origin) and flushed after `maxDelayMs`; `skipOwn: true` drops your own writes (avoids loops). You get no event for objects you cannot read (`library.read`). Subscriptions end with the plugin. Do not do heavy work inside `onEvents`: take the keys, then work in small steps.

## Library queries and `library.apply` writes

```js
// read (needs library.read): fill() supplies the required record fields you leave out
const page = library.queryItems(fill("library/ItemQuery", {
	scope: { tag: "all" }, tags: ["todo"], text: "graph", fields: ["DOI"], expand: { tags: true },
	sort: [{ field: "dateAdded", ascending: false }], limit: 50, offset: 0,
}));                                         // page: { total: BigInt, items: [item-summary] }; limit 0 = default 200, cap 1000
const total = Number(library.countItems(fill("library/ItemQuery", { scope: { tag: "all" } })));
const summaries = library.getSummaries(keys, ["DOI"], {}, false);          // batched: (keys, fields, include, includeTrashed); entries may be undefined
const json = library.getItems(keys, { includeChildren: false, includeTrashed: false });   // Web API item JSON strings

// write (needs library.write): ONE transaction, all changes or none
library.apply([
	ext.change("add-tags", { items, tags: [{ name: "demo", kind: "manual" }] }),
	ext.change("update-item", { key: "AAAA1111", patch: JSON.stringify({ title: "New" }), expectedModified: undefined }),
	ext.change("create-item", { key: undefined, library: undefined, data: JSON.stringify({ itemType: "note", parentItem: "AAAA1111", note: "<p>hi</p>" }) }),
	ext.change("add-to-collection", { collection: "COLL0001", items }),
], { skipNotify: false });
```

Change tags: `create-item, update-item, trash-items, restore-items, erase-items, add-to-collection, remove-from-collection, add-tags, remove-tags, add-related, remove-related, create-collection, update-collection, erase-collection, create-saved-search, ...`. `update-item.patch` is partial JSON (absent fields untouched, `""` clears; `creators`, `tags`, `collections` replace the whole list). A failure throws; `e.payload` is the `apply-error` record `{ index, error }` (which change failed, and why). Catch and log it. Trash needs `library.trash`, erase `library.erase`. Writing from a notifier handler without `skipOwn` loops. Dates are ISO strings.

## Reader toolbar button and annotation menu (world `plugin-reader` or `plugin`)

```js
import reader from "zinc:plugin/reader@0.1.0";
import annotations from "zinc:plugin/annotations@0.1.0";
// permissions: reader.ui, annotations.read (+ library.write to save a note)
startup() {
	reader.registerListener(ext.readerListener("my-toolbar", { tag: "slot", val: "toolbar" },
		[ext.entry("my.export", "Export highlights", { icon: "file-down" })]));
	reader.registerListener(ext.readerListener("my-annot-menu", { tag: "menu", val: "annotation" },
		[ext.entry("my.export-sel", "Export to note")]));
},
shutdown() { reader.unregister("my-toolbar"); reader.unregister("my-annot-menu"); },
// readerEvents:
onMenuCommand(listenerId, command, context) {       // context: { reader, params }; params.tag "annotation" -> params.val.annotations
	if (listenerId === "my-toolbar" && command === "my.export") {
		const all = annotations.listAnnotations(context.reader.attachment);     // attachment is an item-ref
	}
},
```

Slots: `toolbar`, `text-selection-popup`, `sidebar-annotation-header`. Menu kinds: `color, view, annotation, thumbnail, selector, theme`. For dynamic entries implement `readerEvents.buildMenu(listenerId, context)` returning entries. Other reader points: overlays (`reader.registerOverlay` + `renderOverlay`), panels, link interceptors, `readerEvents.onReaderEvent`.

## Network (world `plugin`; manifest `permissions.net.hosts`)

```js
import net from "zinc:plugin/net@0.1.0";
// manifest: "permissions": { "net": { "hosts": ["api.example.org"] } }
function getJson(url) {
	try {
		const res = net.send(fill("net/HttpRequest", { method: "GET", url, headers: [{ name: "Accept", value: "application/json" }],
			redirect: "follow", cookies: { tag: "none" }, bypassCache: false, timeoutMs: 15000 }));
		return JSON.parse(utf8(res.body));       // res: { status, statusText, url, headers, body: Uint8Array }; non-2xx is an error unless successCodes lists it
	} catch (e) {
		fail("unavailable", "request failed: " + JSON.stringify(e.payload ?? String(e)));   // payload: net-error variant { tag: "offline" | "timeout" | "dns" | ... }
	}
}
function utf8(bytes) { let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); try { return decodeURIComponent(escape(s)); } catch { return s; } }   // QuickJS has no TextDecoder
```

(built only; the stub run did not answer `net.send`.) Request body: `body: Uint8Array`. The host owns `Host`, `Content-Length`, `Cookie`; default timeout 30 s; max response 64 MiB unless `maxResponseBytes`; redirects are re-checked against the host list; `net.sendMany(reqs)` runs up to 16 in parallel; `net.download(req, destPathRef, options)` streams to a file. While `net.send` waits, the plugin cannot be called into (see pitfalls). Only send data to hosts the user knows about.

## l10n

```js
ext.entry("my.tag", { id: "tag-label", fallback: "Tag" });                       // label from locale/*/plugin.ftl
ext.entry("my.n", ext.localized("items-tagged", { count: 3 }, "Tagged 3 items."));
ui.button({ id: "go-label", fallback: "Go" }, { on: { press: "go" } });          // UI trees take the same text objects
// import l10n from "zinc:plugin/l10n@0.1.0": l10n.format({ id, args: [{ name, value: { tag: "integer", val: 3n } }], fallback }) -> string
```

## Timers

```js
const id = timers.setTimeout(500);                      // or setInterval(ms); returns a number; at most 64 per plugin, interval floor 10 ms
// events:
onTimer(timer, kind) { /* kind: "timeout" | "interval" | "idle" */ if (shownInstance !== undefined) zui.push(shownInstance, ui.render(...)); },
```

There is no `setTimeout` global in QuickJS. `timers.sleep(ms)` blocks inside an import; avoid it (the plugin cannot be called while it sleeps).
