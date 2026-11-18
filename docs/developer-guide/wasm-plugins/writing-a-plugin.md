# Writing a Zinc plugin

A Zinc plugin is a WebAssembly component that implements the `plugin` world or one of its smaller family worlds (`plugin-api/wit/world.wit`). You write it in Rust or JavaScript,
build it with one command, and Zinc loads it into a separate plugin host process. The SDKs hide the parts of the world you do not use:
the world exports 48 callback functions, and a plugin writes only the ones it needs.

Status: the SDKs and samples are new (phase 2) and have not run inside the real Zinc app yet; the extension points work as far as the
host handlers written so far (`phase2-*.md`).

## Start

**Rust** (`plugin-api/sdk/rust`, crate `zinc-plugin`). Copy `plugin-api/samples/word-count`, rename it, and edit `manifest.json` and `src/lib.rs`.

```toml
# Cargo.toml
[lib]
crate-type = ["cdylib"]
[dependencies]
zinc-plugin = { path = "<zinc>/plugin-api/sdk/rust", features = ["extend"] }   # pick the world, see below
[workspace]   # keeps the crate out of a parent workspace
```

```rust
use zinc_plugin::prelude::*;

struct Hello;
impl Plugin for Hello {                       // every method has a no-op default
    fn startup(_d: PluginData, _why: Reason) -> Result<(), Error> {
        reg::register_menu(&menu::registration("hello", MenuTarget::MenubarTools,
            vec![MenuEntryBuilder::item("hello.say", "Say hello").build()]))?;
        Ok(())
    }
    fn on_menu_command(_menu: String, entry: String, _checked: Option<bool>, _ctx: Context) -> Result<(), Error> {
        if entry == "hello.say" { log::info("hello"); }
        Ok(())
    }
}
zinc_plugin::export_plugin!(Hello);
```

**Rust: pick a world with a cargo feature.** The full `plugin` world is too big for rustc (about 400 imports, very deep records), so the SDK
generates the bindings of one smaller world only; the highest feature wins. Compile times are for `cargo build` (dev profile) on the dev machine.

| feature | world | adds | compile |
|---|---|---|---|
| none | `plugin-core` | lifecycle, events, app, prefs, l10n, log, timers | 2 s |
| `library` | `plugin-library` | library, attachments, fulltext, schema, cite, translate, sync-control, data-utils, notifier | 8 s |
| `extend` | `plugin-extend` | menus, columns, panes, sections (registration only), extend-handlers | 1.5 min |
| `reader` | `plugin-reader` | annotations, reader, note-editor, reader-events, note-events | 20 s (release sample: 3 min) |
| `dialogs`, `ui`, `full` | `plugin-dialogs`, `plugin-ui`, `plugin` | the `ui` interface (dialogs, toasts, views) | **does not finish**: `dialogs` alone passed 19 min and 640 CPU s and was stopped |

So a Rust plugin cannot draw views, dialogs or toasts yet (the `ui` types are inlined into every function that uses them, see phase2-integrate.md);
use JavaScript for those, or log. The `ui` builders in `sdk/rust/src/ui.rs` are written but have not been compiled. A section registration
(`reg::register_section`) is possible in Rust, but its view needs `ui-events`, so a Rust section is not available either.

Plugin state lives in `thread_local!` statics (callbacks are plain functions; the guest is single threaded). Do not hold a `RefCell` borrow
across a host call: the host may call the plugin again while it waits in `ui::run_dialog` or `net::send`.

**JavaScript** (`plugin-api/sdk/js`, QuickJS). Copy `plugin-api/sdk/js/template` (or `samples/quick-tags`).

```js
import { definePlugin, ext } from "<zinc>/plugin-api/sdk/js/src/index.ts";
import extend from "zinc:plugin/extend@0.1.0";      // the WIT interfaces are default imports
const plugin = definePlugin({
  lifecycle: { startup() { extend.registerMenu(ext.menu("hello", "menubar-tools", [ext.entry("hello.say", "Say hello")])); } },
  extendHandlers: { onMenuCommand(menu, entry) { /* ... */ } },
});
export const { lifecycle, events, netEvents, notifierHandler, uiEvents, extendHandlers, readerEvents, noteEvents } = plugin;
```

Names follow jco: functions and fields are camelCase, enums are strings (`"library-item"`), variants are `{ tag, val }`, an `option` is the value
or `undefined`, `u64` is a `BigInt`. A callback that returns `result<_, error>` fails by throwing: `fail("not-found", "no such item")`. An import that
fails throws an object with `.payload` (the `error` variant). Types: `bun plugin-api/sdk/js/scripts/gen-types.ts` writes them from the WIT into
`sdk/js/types/`; add `"include": ["<zinc>/plugin-api/sdk/js/types/index.d.ts"]` to your tsconfig. Typecheck with `bun check`.

## Build

```bash
bun plugin-host/scripts/build-plugin.ts <plugin dir> [--out <dir>]        # Rust: cargo --target wasm32-wasip2, then jco
bun plugin-api/sdk/js/scripts/build.ts  <plugin dir> [--out <dir>]        # JS: bundle the SDK in, componentize-qjs, then jco
```

Output (default `<dir>/dist`): `manifest.json` (with the sha256 added), `plugin.wasm`, `transpiled/` (what the host loads). Rust needs the
`wasm32-wasip2` target and a recent toolchain; the first build compiles the SDK bindings (see the table above). JS needs `plugin-host/node_modules` (one `bun install` in `plugin-host/`).

## Install

There is no installer UI yet. For development, load the output folder with the supervisor (`createPluginSupervisor(...).load(dir)` then
`start(id)`; see `plugin-api/samples/test.ts` for a complete example), or copy it to the plugins folder when the lifecycle area's installer
exists. The folder layout is fixed by `plugin-host/src/manifest.ts`.

## Manifest and permissions

`manifest.json` follows `plugin-api/manifest.schema.json`. The parts you always write: `id` (`name@domain`), `name`, `version` (semver), `zinc.api_version` (`"0.1"`),
`main` (`world`: `plugin` or `plugin-minimal` in the schema today; the family worlds are not in its enum yet and a Rust build does not read the field; a JS build passes it to componentize-qjs, so it must be a world that exists), `permissions`. Default prefs go in `default_prefs`; localized strings in `locale/`.

A plugin can do only what `permissions.capabilities` lists (36 ids, with risk tiers in the schema) and the user grants. Calling an import without its permission returns
`error::permission-denied(<id>)`. Network hosts are listed in `permissions.net.hosts`. Ask for the least: `library.read` for reading, `library.write` for
`library.apply`, `library.fulltext.read` for indexed text, `annotations.read` / `annotations.write`, `reader.ui` for reader menus and buttons, `ui.windows`
for extra windows. Dialogs, toasts, prefs and logging need none. Put a sentence in `permission_reasons` for each: the install prompt shows it.

## The extension points

All are registered in `lifecycle.startup`. Zinc removes them when the plugin stops. Callbacks arrive through the exported interfaces; the SDK
trait method for each is in parentheses (Rust) and the export name in brackets (JS).

| What | Register | Callback |
|---|---|---|
| Menu entries (item, collection, menubar, tab, ...) | `extend.register-menu(menu-registration)` | `on-menu-command` [`extendHandlers.onMenuCommand`], `on-menu-showing` for dynamic entries |
| Item list column | `extend.register-column` | `on-column-values(data-key, keys)` returns one `cell` per key |
| Item pane section | `extend.register-section` | `ui-events.mount(instance, ctx)` with `ctx.view == pane-id`, returns a tree; events come to `on-event` (Rust `on_ui_event`) |
| Settings pane | `extend.register-pref-pane` with `setting-row`s bound to prefs (no callback needed) | `on-pref-action` for buttons |
| Toolbar button, shortcut, tab, banner, side panel | `register-toolbar-button`, `register-shortcut`, `open-tab`, `show-banner`, `register-side-panel` | `on-toolbar-click`, `on-shortcut`, ... |
| Reader toolbar button, reader menus, overlays, panels | `reader.register-listener` (target `slot(toolbar)` or `menu(...)`), `register-overlay`, `register-panel` | `reader-events.build-menu` / `on-menu-command` (Rust `build_reader_menu` / `on_reader_menu_command`), `render-overlay` |
| Library changes | `notifier.observe` | `notifier-handler.on-events` |
| Dialogs, prompts, toasts | `ui.run-dialog` (waits), `ui.open-dialog`, `ui.confirm`, `ui.prompt`, `ui.show-toast` | the dialog's own events through `ui-events.on-event` |

Short examples. A column cell (Rust): `Cell { body: CellBody::Text("42".into()), tooltip: None, color: None, style: extend::TextStyle::Normal, sort_key: Some(extend::SortKey::Number(42.0)) }`.
Writing tags (JS): `library.apply([ext.change("add-tags", { items, tags: [{ name: "to-read", kind: "manual" }] })], { skipNotify: false })`.
A note (Rust): `library::apply(&[library::Change::CreateItem(library::NewItem { key: None, library: Some(1), data: json!({"itemType":"note","parentItem":parent,"note":html}).to_string() })], library::ApplyOptions { skip_notify: false })`.

### UI trees

A view returns a tree of nodes (`box`, `text`, `button`, `text-input`, `checkbox`, `select`, `section`, `form`, `callout`, `table`, ...). Events name a handler id; you answer with the next tree.

```rust
// Rust: nested builders, flattened for you
ui::render(ui::column().gap(2)
    .child(ui::heading("Title"))
    .child(ui::text_input("").name("q").placeholder("search"))
    .child(ui::button("Go").on(EventKind::Press, "go")))
```
```js
// JS: the nested JSON form (plugin-api/ui-schema/ui-tree.schema.json)
ui.render(ui.column({ style: { gap: 2 } }, ui.heading("Title"), ui.textInput("", { name: "q" }), ui.button("Go", { on: { press: "go" } })))
```

Dialogs need the typed tree: Rust `ui::dialog(title, el, buttons)` / `ui::ask(...)`, JS `ui.dialogSpec(title, node, buttons)` (it converts the nested form;
supported nodes are the common ones, see `sdk/js/src/ui.ts`). Read form values with `ui::field_text(&values, "name")` / `ui.fieldValue(values, "name")`.

## Testing without Zinc

`plugin-api/samples/test.ts` is a template: build the plugin, load it with `createPluginSupervisor`, answer imports with stub `where: "zinc"` handlers
that record calls, then `sup.call(id, "extend-handlers", "on-menu-command", [...])` and assert on the recorded calls.
