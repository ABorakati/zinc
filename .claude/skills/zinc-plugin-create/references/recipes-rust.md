# Recipes, Rust

Built with `bun plugin-host/scripts/build-plugin.ts` against the matching cargo feature (menu, column, section, prefs, dialog, notifier, library, reader, toast, and the condition/apply/query/note/prefs/timers/push snippets below); the `net` snippet is marked where it was not compiled. Contents: skeleton; menus and commands; columns; sections; dialogs; preferences; notifier; library; reader; network; tools for AI agents (MCP); l10n; timers.

## Skeleton

```toml
# Cargo.toml (the scaffold writes it)
[package]
name = "my-plugin"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib"]
[dependencies]
zinc-plugin = { path = "<zinc>/plugin-api/sdk/rust", features = ["ui"] }   # the world, see SKILL.md table
[workspace]   # keeps the crate out of a parent workspace
# no CARGO_TARGET_DIR, no per-plugin profile flags: the environment shares one target dir
```

```rust
use zinc_plugin::host::{extend, library, prefs, timers, types::ItemKey, ui as host_ui};   // only what the world has
use zinc_plugin::json::{self, json};
use zinc_plugin::menu::ConditionExt;                  // for menu::when().with_min_items(..)
use zinc_plugin::prelude::*;                          // Plugin, reg, menu, ui, err, log, l10n, plain, Error, Context, Cell, ...

struct MyPlugin;
impl Plugin for MyPlugin {                            // every method has a no-op default; implement only what you use
    fn startup(_data: PluginData, _why: Reason) -> Result<(), Error> { /* register everything here */ Ok(()) }
}
zinc_plugin::export_plugin!(MyPlugin);
```

Trait methods are associated functions (no `self`). State goes in `thread_local!` (the guest is single threaded). Callback names: `on_menu_command`, `on_column_values`, `mount`, `update_context`, `unmount`, `on_ui_event`, `on_pref_changed`, `on_timer`, `on_events` (notifier), `on_pref_action`, `on_menu_showing`, `build_reader_menu`, `on_reader_menu_command`. Errors: `err::invalid("..")`, `err::not_found`, `err::denied`, `err::unavailable`, `err::internal`, `err::from_display(e)`, `err::from_apply(apply_error)`, `err::message(&e)`. Host imports are `zinc_plugin::host::<interface>::<snake_case_fn>`; WIT records are Rust structs with snake_case fields and Vec/Option, enums are Rust enums, `flags` are bitflags (`library::ItemInclude::TAGS`, `::empty()`).

## Menus and commands

```rust
fn startup(_d: PluginData, _w: Reason) -> Result<(), Error> {
    reg::register_menu(&menu::registration("my-item-menu", MenuTarget::LibraryItem, vec![
        MenuEntryBuilder::item("my.tag", "Tag selected items").icon("tag")
            .visible_when(menu::when().with_min_items(1))
            .enabled_when(menu::when().editable())
            .build(),
        MenuEntryBuilder::separator("my.sep").build(),
        MenuEntryBuilder::submenu("my.more", "More").build(),
        MenuEntryBuilder::item("my.flag", "Flag").parent("my.more").check(false).build(),
    ]))?;
    Ok(())
}
fn on_menu_command(menu_id: String, entry_id: String, checked: Option<bool>, ctx: Context) -> Result<(), Error> {
    if menu_id != "my-item-menu" { return Ok(()); }
    let items: Vec<ItemKey> = if ctx.items_truncated { extend::list_selected_items(None, 0, ctx.item_count)? } else { ctx.items.clone() };
    match entry_id.as_str() { "my.tag" => { /* ... */ } _ => {} }
    Ok(())
}
```

Targets: `MenuTarget::MenubarTools`, `MenubarFile|Edit|View|Go|Help`, `LibraryItem`, `LibraryCollection`, `LibraryAdd`, `Tab`, ... `ctx` has `rows` (the selected collection-tree rows, several allowed), `items`, `item_count`, `items_truncated`, `editable`. Reading it needs `library.read`. Dynamic entries: `MenuEntryBuilder::...hooks(MenuHooks::SHOWING)` plus `on_menu_showing`. Shortcuts and toolbar: `extend::register_shortcut`, `extend::register_toolbar_button` with `on_shortcut` / `on_toolbar_click`.

## Item list column

```rust
reg::register_column(&reg::column("my-col", "Mine"))?;          // in startup; returns the WIT record, tweak fields before registering
fn on_column_values(data_key: String, keys: Vec<ItemKey>) -> Result<Vec<Cell>, Error> {
    if data_key != "my-col" { return Err(err::invalid(format!("unknown column {data_key}"))); }
    // ONE batched import call for all keys (library::get_summaries(&keys, &[], library::ItemInclude::empty(), false)?), then one cell per key, in order
    Ok(keys.iter().map(|_| Cell {
        body: CellBody::Text("42".into()),            // also Icon, Bar(f32), Rating, Chips
        tooltip: None, color: None,
        style: extend::TextStyle::Normal,
        sort_key: Some(extend::SortKey::Number(42.0)),
    }).collect())
}
// when your data changes: extend::invalidate_columns(Some("my-col"), None);   (None = every row, or Some(&[key]))
```

## Item pane section

```rust
const SECTION: &str = "my-section";
thread_local! { static MOUNTED: RefCell<HashMap<InstanceId, (String, u32)>> = RefCell::new(HashMap::new()); }

fn view(key: &str, clicks: u32) -> RenderResult {
    ui::render(ui::column().gap(2)
        .child(ui::text(format!("Item {key}: {clicks}")).key("label"))
        .child(ui::button("Click me").on(EventKind::Press, "click"))
        .child(ui::checkbox("Enabled", false).pref("enabled")))          // bind a control straight to a plugin pref
}
// startup:  reg::register_section(&reg::section(SECTION, "My section", "info"))?;
fn mount(instance: InstanceId, ctx: ViewContext) -> RenderResult { Self::update_context(instance, ctx) }
fn update_context(instance: InstanceId, ctx: ViewContext) -> RenderResult {
    if ctx.view != SECTION { return ui::unchanged(); }
    match json::string_field(&ctx.params, "itemKey") {              // ctx.params is JSON; the item pane section's holds itemKey
        Some(key) => { MOUNTED.with(|m| m.borrow_mut().insert(instance, (key.clone(), 0))); view(&key, 0) }
        None => ui::render(ui::caption("Select an item")),
    }
}
fn unmount(instance: InstanceId) { MOUNTED.with(|m| m.borrow_mut().remove(&instance)); }
fn on_ui_event(instance: InstanceId, event: UiEvent) -> RenderResult {
    if event.handler == "click" { /* bump the state, then */ return view("KEY", 1); }
    ui::unchanged()
}
```

- Return `ui::render(tree)`, `ui::unchanged()`, `ui::render_patch(&PatchSet)` or `ui::render_json(string)` (a hand-built JSON tree) from every view callback.
- Push a new state later (network finished, timer): `host_ui::push(instance, &ui::render(tree));`. Ask for `update_context` again: `host_ui::refresh(instance);`.
- Builders (`zinc_plugin::ui`): `column() row() boxed() card() group(cap) section(title) form() spacer() separator()`, `text() label() caption() heading() mono()`, `callout(Tone, msg)`, `badge`, `progress`, `button`, `submit_button`, `text_input(value)`, `checkbox`, `select(&[(value,label)], Some(value))`. On any element: `.key() .name() .pref() .on(EventKind, "handler") .gap() .padding() .grow() .placeholder() .look(ButtonLook) .icon("name") .disabled(b)`. Anything else: `ui::El::new("table").prop("columns", json!([...]))`. The tree serializes to the JSON in `plugin-api/ui-schema/ui-tree.schema.json`; unknown props are errors in Zinc (test with `checkRender`, see build-test-install.md).
- Form values: `host_ui::form_values(instance)` and `ui::field_text(&values, "name")`.

## Dialogs (callback form)

```rust
fn ask_name() -> Result<(), Error> {
    let content = ui::form().child(ui::column().gap(2).child(ui::label("Your name")).child(ui::text_input("").name("name").auto_focus()));
    // open-dialog does not block: the closure runs later, when the dialog's close event arrives (Glue routes it)
    ui::ask("My Plugin", content, "OK", |values| {                  // Some(values) if OK was pressed, None if cancelled
        if let Some(values) = values {
            let name = ui::field_text(&values, "name").filter(|n| !n.is_empty()).unwrap_or("stranger");
            ui::toast("My Plugin", format!("Hello, {name}!"), Tone::Success);
        }
    })?;
    Ok(())
}
// full control (own buttons): let spec = ui::dialog(title, content, vec![ui::dialog_button("go", "Go", ButtonRole::Accept), ...]);
//                            ui::open_dialog_with(&spec, |out: ui::DialogOutcome| { /* out.button: Option<String>, out.values */ })?;
```

Needs feature `ui` (a dialog's answer is a `ui-events` callback); `dialogs` alone is enough only for toasts. The closure must be `'static`: move owned data into it (clone keys first). Do not wait for the dialog: return from the command.

## Preferences and panes

```rust
// manifest.json: "default_prefs": { "enabled": true, "count": 3 }
reg::register_pref_pane(&reg::pref_pane("my-prefs", "My Plugin", vec![
    reg::setting_toggle("enabled", "Enabled", "enabled"),
    reg::setting_number("count", "Count", "count", Some(0), Some(10)),
]))?;
prefs::observe(prefs::PrefScope::PluginOwn, "enabled", false)?;
fn on_pref_changed(_sub: u32, _scope: PrefScope, name: String, _value: Option<PrefValue>) { /* clear caches, invalidate columns, host_ui::refresh(..) */ }

let on = !matches!(prefs::get("enabled"), Some(PrefValue::Flag(false)));       // default true
prefs::set("count", &PrefValue::Integer(4))?;                                    // Flag(bool) | Integer(i32) | Text(String)
```

Other rows: `reg::setting(id, label, extend::SettingControl::Text(..) | Choice(..) | Button(..) | Note)`; a Button row calls `on_pref_action(pane_id, action_id)`.

## Notifier

```rust
use zinc_plugin::host::notifier;
notifier::subscribe(&notifier::Subscription {
    types: vec![notifier::ObjectType::Item],
    kinds: vec![notifier::EventKind::Add, notifier::EventKind::Modify, notifier::EventKind::Trash],
    priority: 0, skip_own: true, max_delay_ms: 250, label: "my-plugin".into(),
})?;
fn on_events(_subscription: u32, batch: notifier::EventBatch) {
    for ev in batch.events { /* ev.object, ev.kind, ev.ids: Vec<String>, ev.origin */ }
}
```

Needs `library.read` to see anything. `skip_own: true` prevents loops when you write in response.

## Library queries and `library::apply`

```rust
let page = library::query_items(&library::ItemQuery {          // library.read
    library: None, scope: library::ItemScope::All, tags: vec!["todo".into()], text: Some("graph".into()),
    text_mode: library::TextMode::TitleCreatorYear, search: None, fields: vec!["DOI".into()],
    expand: library::ItemInclude::TAGS,
    sort: vec![library::SortKey { field: "dateAdded".into(), ascending: false }], limit: 50, offset: 0,
})?;                                                            // page.total: u64, page.items: Vec<ItemSummary>

library::apply(                                                 // library.write; ONE transaction
    &[library::Change::AddTags(library::TagEdit { items, tags: vec![library::Tag { name: "demo".into(), kind: library::TagKind::Manual }] })],
    library::ApplyOptions { skip_notify: false },
).map_err(err::from_apply)?;

let data = json!({ "itemType": "note", "parentItem": parent, "note": "<p>hi</p>" });
library::apply(&[library::Change::CreateItem(library::NewItem { key: None, library: None, data: data.to_string() })],
               library::ApplyOptions { skip_notify: false }).map_err(err::from_apply)?;
```

`Change` variants: `CreateItem, UpdateItem(ItemUpdate{key, patch, expected_modified}), TrashItems, RestoreItems, EraseItems, AddToCollection, RemoveFromCollection, AddTags, RemoveTags, AddRelated, ...`. Trash needs `library.trash`, erase `library.erase`. `library::count_items`, `get_summaries`, `get_items` (JSON strings), `list_collections`, `list_tags` exist. Escape text put into note HTML with `json::escape_html`.

## Reader hooks (feature `reader`; with `ui` use `full`)

```rust
use zinc_plugin::host::{annotations, reader};
// permissions: reader.ui, annotations.read (+ library.write to save)
let mut toolbar = reg::reader_toolbar("my-toolbar");
toolbar.static_menu = vec![MenuEntryBuilder::item("my.export", "Export highlights").icon("file-down").build()];
reg::register_reader_listener(&toolbar)?;
let mut m = reg::reader_listener("my-annot-menu", reader::ListenerTarget::Menu(reader::MenuKind::Annotation));
m.static_menu = vec![MenuEntryBuilder::item("my.export-sel", "Export to note").build()];
reg::register_reader_listener(&m)?;
// shutdown: reader::unregister("my-toolbar");

fn on_reader_menu_command(listener_id: String, command: String, context: MenuContext) {
    match (listener_id.as_str(), command.as_str(), &context.params) {
        ("my-annot-menu", "my.export-sel", MenuParams::Annotation(p)) => { /* p.annotations */ }
        ("my-toolbar", "my.export", _) => { let all = annotations::list_annotations(&context.reader.attachment); /* ... */ }
        _ => {}
    }
}
```

See `plugin-api/samples/highlight-export` for a complete one. Dynamic menus: `build_reader_menu`. Overlays, panels: `reader::register_overlay`, `render_overlay`.

## Network (feature `full`; manifest `permissions.net.hosts`)

```rust
use zinc_plugin::host::net;
let req = net::HttpRequest {
    method: "GET".into(), url: "https://api.example.org/v1/x".into(),
    headers: vec![zinc_plugin::host::types::NameValue { name: "Accept".into(), value: "application/json".into() }],
    body: None, timeout_ms: Some(10_000), success_codes: None, redirect: net::RedirectMode::Follow,
    credentials: None, cookies: net::CookieMode::None, retry: None, bypass_cache: false,
    max_response_bytes: Some(1 << 20), cancel_key: None,
};
match net::send(&req) { Ok(res) => { /* res.status, res.body: Vec<u8> */ } Err(e) => log::warn(format!("fetch failed: {e:?}")) }   // e: net::NetError
```

(This snippet was not compiled; the JS equivalent ran. The `full` world itself builds again: checked with features `full` + `mcp`.) Parse JSON with `json::parse(&String::from_utf8_lossy(&res.body))`. `net::send` blocks the plugin: no other call can enter it while it waits.

## Tools for AI agents (MCP) (feature `mcp`; with extend/ui/reader use `full` + `mcp`; manifest `mcp.expose`)

```rust
use zinc_plugin::host::library;
use zinc_plugin::json;
use zinc_plugin::prelude::*;                           // with feature `mcp`: mcp, Tool

// count_tagged is declared in manifest.json ("mcp": { "tools": [...] }), so nothing is registered for it in startup.
// Tools added at run time: mcp::register_all(&[Tool::new("name", "description", json::json!({ "type": "object" })).read_only()])?;
impl Plugin for MyPlugin {
    fn on_mcp_call(tool: String, args: String) -> Result<String, Error> {   // args: JSON text, already checked against the input schema
        match tool.as_str() {
            "count_tagged" => {
                let tag = json::string_field(&args, "tag").ok_or_else(|| err::invalid("tag is required"))?;
                let query = library::ItemQuery {
                    library: None, scope: library::ItemScope::All, tags: vec![tag.clone()], text: None,
                    text_mode: library::TextMode::TitleCreatorYear, search: None, fields: Vec::new(),
                    expand: library::ItemInclude::empty(), sort: Vec::new(), limit: 0, offset: 0,
                };
                let count = library::count_items(&query)?;
                mcp::ok(&json::json!({ "tag": tag, "count": count }))   // the result as JSON text
            }
            _ => Err(err::not_found(format!("no tool {tool}"))),        // -> a tool error for the agent
        }
    }
}
```

Built and called through `smoke.ts` (the `scaffold.ts --with mcp` output, alone with feature `mcp` and with `menu` under `full` + `mcp`); the `register_all` line is from the SDK docs (`plugin-api/sdk/rust/src/mcp.rs`). With serde in your own Cargo.toml, `mcp::args::<MyArgs>(&args)?` parses into a struct. `Tool` builder: `.read_only()`, `.destructive(false)` for add-only tools (the default is destructive), `.idempotent()`, `.output(schema)`; `mcp::manifest(&tools)` prints the manifest block. The user must still turn on the plugin's switch in Settings > Plugins.

## l10n

```rust
MenuEntryBuilder::item("my.tag", l10n("tag-label").fallback("Tag"))                       // from locale/en-US/plugin.ftl
MenuEntryBuilder::item("my.n", l10n("items-tagged").arg_int("count", 3).fallback("Tagged 3 items."))
```

Any API taking `impl IntoText` accepts `"literal"`, `String`, or `l10n(..)`. Plain strings from the catalog: `host::l10n::format(..)`.

## Timers

```rust
let id = timers::set_timeout(500)?;                  // set_interval(ms); at most 64 per plugin; interval floor 10 ms
fn on_timer(timer: u32, kind: TimerKind) { /* host_ui::push(instance, &ui::render(..)) */ }
```
