# Writing a Zinc plugin

A Zinc plugin is a WebAssembly component that implements the `plugin` world or one of its smaller family worlds (`plugin-api/wit/world.wit`). You write it in Rust or JavaScript,
build it with one command, and Zinc loads it into a separate plugin host process. That host is Wasmtime (`zhw`), the only runner; the component is precompiled to a `.cwasm` when the plugin is installed (`phase3-runner.md`). The SDKs hide the parts of the world you do not use:
the world exports 48 callback functions, and a plugin writes only the ones it needs.

With an AI coding agent, install the [agent skills for plugin authors](agent-skills.md) instead of walking through this page by hand: `zinc-plugin-create` scaffolds, builds, tests and packages a new plugin, and `zinc-plugin-port` assesses and ports a Zotero plugin.

## Start

**Rust** (`plugin-api/sdk/rust`, crate `zinc-plugin`). Copy `plugin-api/samples/word-count`, rename it, and edit `manifest.json` and `src/lib.rs`.

```toml
# Cargo.toml
[lib]
crate-type = ["cdylib"]
[dependencies]
zinc-plugin = { path = "<zinc>/plugin-api/sdk/rust", features = ["ui"] }   # pick the world, see below
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

**Rust: pick a world with a cargo feature.** Each feature selects a subset world (or `full` for everything); the highest feature wins. Because UI trees and patches are serialized as JSON (`plugin-api/ui-schema/ui-tree.schema.json`), every feature—including `dialogs`, `ui`, and `full`—compiles in seconds.

| feature | world | adds | compile (incremental) |
|---|---|---|---|
| none | `plugin-core` | lifecycle, events, app, prefs, l10n, log, timers | ~2 s |
| `library` | `plugin-library` | library, attachments, fulltext, schema, cite, translate, sync-control, data-utils, notifier | ~4 s |
| `extend` | `plugin-extend` | menus, columns, panes, sections (registration only), extend-handlers | ~5 s |
| `dialogs` | `plugin-dialogs` | `ui` imports (toasts, windows, push) without `ui-events`. **Toasts only:** a dialog's outcome arrives as a `close` event on `ui-events`, so any dialog with an outcome needs `ui` | ~5 s |
| `ui` | `plugin-ui` | `ui` imports + `ui-events` callbacks (mounted views, sections, dialogs with outcomes) | ~6 s |
| `mcp` | `plugin-mcp` | `plugin-library` plus tools for AI agents (see "Exposing tools to AI agents (MCP)") | ~5 s |
| `reader` | `plugin-reader` | annotations, reader, note-editor, reader-events, note-events | ~6 s |
| `full` (or `reader` + `dialogs`/`ui`) | `plugin` | everything, including net, fs, clipboard, shell, secrets | ~8 s |

Plugin state lives in `thread_local!` statics (callbacks are plain functions; the guest is single threaded).

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
bun plugin-host/scripts/build-plugin.ts <plugin dir> [--out <dir>]        # Rust: cargo --target wasm32-wasip2
bun plugin-api/sdk/js/scripts/build.ts  <plugin dir> [--out <dir>]        # JS: bundle the SDK in, componentize-qjs
```

Output (default `<dir>/dist`): `manifest.json` (with the sha256 added), `plugin.wasm`. Rust needs the
`wasm32-wasip2` target and a recent toolchain. JS needs `plugin-host/node_modules`. Running a plugin needs the `zhw` binary
(`cd plugin-host-wasmtime && cargo build --release`).

## Manifest and permissions

`manifest.json` follows `plugin-api/manifest.schema.json`. The parts you always write: `id` (`name@domain`), `name`, `version` (semver), `zinc.api_version` (`"0.1"`),
`main` (`wasm`, `world`), `permissions`. Default prefs go in `default_prefs`; localized strings in `locale/`. `main.world` names the world the component was built for (a JS build uses it as the componentize input; for Rust the cargo feature decides and the field is informational, but keep it true). The samples `word-count`, `quick-tags` and `highlight-export` set it to `plugin`; `mcp-tools` sets `plugin-mcp`.

A plugin can do only what `permissions.capabilities` lists (37 ids, with risk tiers in the schema) and the user grants. Calling an import without its permission returns
`error::permission-denied(<id>)`. Network hosts are listed in `permissions.net.hosts`. Ask for the least: `library.read` for reading, `library.write` for
`library.apply`, `library.fulltext.read` for indexed text, `annotations.read` / `annotations.write`, `reader.ui` for reader menus and buttons, `ui.windows`
for extra windows, `mcp.expose` to offer tools to AI agents. Dialogs, toasts, prefs and logging need none. Put a sentence in `permission_reasons` for each: the install prompt shows it.

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
| Dialogs, prompts, toasts | `ui.open-dialog` (wrapped by SDK `ui.dialog` / `ui::open_dialog_with`), `ui.confirm`, `ui.prompt`, `ui.show-toast` | dialog `close` and control events through `ui-events.on-event` |

### UI trees and dialogs

A view returns a tree of nodes (`box`, `text`, `button`, `text-input`, `checkbox`, `select`, `section`, `form`, `callout`, `table`, ...) serialized as JSON matching `plugin-api/ui-schema/ui-tree.schema.json`. Events name a handler id; you answer with the next tree or a JSON patch (`content-update.patch`).

```rust
// Rust: serde tree builders, serialized to JSON
ui::render(ui::column().gap(2)
    .child(ui::heading("Title"))
    .child(ui::text_input("").name("q").placeholder("search"))
    .child(ui::button("Go").on(EventKind::Press, "go")))
```
```js
// JS: the nested JSON form (plugin-api/ui-schema/ui-tree.schema.json)
ui.render(ui.column({ style: { gap: 2 } }, ui.heading("Title"), ui.textInput("", { name: "q" }), ui.button("Go", { on: { press: "go" } })))
```

Dialogs open non-blockingly via `ui.open-dialog`, and report their outcome (`{ button, values }`) through `close` events on `ui-events.on-event` (the pressed `button` first, then the `form` values). Because the event arrives on `ui-events`, a dialog with an outcome needs the `ui` feature or world; `dialogs` alone only covers toasts. `ui.alert`, `confirm` and `prompt` still block, which is fine because they show no plugin content. There is no blocking `run-dialog` (removed in phase 3):
- **JS**: `ui.dialog(ui.dialogSpec(title, content, buttons)).then((outcome) => { ... })` (or `await ui.dialog(...)`) returns a Promise resolved automatically by `definePlugin` when the dialog's `close` event arrives.
- **Rust**: `ui::open_dialog_with(&spec, |outcome| { ... })` or `ui::ask(title, content, "OK", |values| { ... })` registers a continuation callback invoked automatically by `Glue<P>` when the dialog's `close` event arrives.
Read form values with `ui::field_text(&values, "name")` / `ui.fieldValue(values, "name")`.

## Exposing tools to AI agents (MCP)

A plugin can offer tools to AI agents through Zinc's MCP server: declare them in `manifest.json` (`mcp.tools`) or register them at run time, and answer calls in `mcp-handler.on-mcp-call` (JS `defineTool`, Rust `mcp::Tool`). It needs the `mcp.expose` permission and the user's per-plugin switch in Settings > Plugins, which is off by default. See [mcp.md](mcp.md) and the sample `plugin-api/samples/mcp-tools`.

## Installing and managing

Settings > Plugins has on/off switches ("Enable plugins", experimental, applied at the next start, and the per-plugin MCP switch above) and lists each plugin with its status. It has no install button yet: installing goes through `PluginManager.installPackage` / `installDir` in `plugin-host/src/package/installer.ts` (see `phase2-pkg.md`). What users see: [Plugins](../../user-guide/plugins.md) in the user guide.

## Testing without Zinc

`plugin-api/samples/test.ts` is a template: build the plugin, load it with `createPluginSupervisor`, answer imports with stub `where: "zinc"` handlers
that record calls, then `sup.call(id, "extend-handlers", "on-menu-command", [...])` and assert on the recorded calls.
