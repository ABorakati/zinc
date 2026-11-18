//! The [`Plugin`] trait and the glue that turns it into the eight `Guest` traits of the `plugin` world.
//!
//! Naming: two interfaces have a callback with the same name, so the trait renames them:
//! `extend-handlers.on-event` is [`Plugin::on_host_event`], `ui-events.on-event` is [`Plugin::on_ui_event`],
//! `reader-events.build-menu` / `on-menu-command` are [`Plugin::build_reader_menu`] / [`Plugin::on_reader_menu_command`].
//!
//! Methods are associated functions (no `self`): a plugin instance is one Wasm instance, so keep state in a
//! `thread_local!` (the guest is single-threaded).

use crate::callbacks::{events, lifecycle};
#[cfg(feature = "extend")]
use crate::callbacks::extend_handlers as eh;
#[cfg(any(feature = "full", all(feature = "dialogs", feature = "reader")))]
use crate::callbacks::net_events;
#[cfg(feature = "reader")]
use crate::callbacks::{note_events, reader_events as re};
#[cfg(feature = "library")]
use crate::callbacks::notifier_handler;
#[cfg(any(feature = "full", all(feature = "dialogs", feature = "reader"), all(feature = "mcp", not(feature = "extend"))))]
use crate::callbacks::mcp_handler;
#[cfg(any(feature = "ui", all(feature = "dialogs", feature = "reader")))]
use crate::callbacks::ui_events;
#[cfg(feature = "library")]
use crate::host::notifier;
#[cfg(feature = "extend")]
use crate::host::extend;
#[cfg(feature = "reader")]
use crate::host::reader;
#[cfg(feature = "dialogs")]
use crate::host::ui;
use crate::host::{
    prefs, timers,
    types::{Error, PluginId, PrefValue, WindowId},
};
#[cfg(feature = "extend")]
use crate::host::types::{ItemKey, LibraryId};

type Res<T = ()> = Result<T, Error>;

#[cfg(feature = "dialogs")]
fn empty_render() -> ui::RenderResult {
    ui::RenderResult { content: ui::ContentUpdate::Unchanged, meta: None, focus: None }
}

/// Everything a plugin can implement. Every method has a default that does nothing (or answers "not handled").
#[allow(unused_variables)]
pub trait Plugin: 'static {
    // ---- lifecycle -------------------------------------------------------------------------------------------
    fn install(data: lifecycle::PluginData, why: lifecycle::Reason) -> Res {
        Ok(())
    }
    /// Register your menus, sections, columns and so on here.
    fn startup(data: lifecycle::PluginData, why: lifecycle::Reason) -> Res {
        Ok(())
    }
    fn shutdown(data: lifecycle::PluginData, why: lifecycle::Reason) -> Res {
        Ok(())
    }
    fn uninstall(data: lifecycle::PluginData, why: lifecycle::Reason) -> Res {
        Ok(())
    }
    fn main_window_load(data: lifecycle::PluginData, window: WindowId) -> Res {
        Ok(())
    }
    fn main_window_unload(data: lifecycle::PluginData, window: WindowId) -> Res {
        Ok(())
    }

    // ---- events ----------------------------------------------------------------------------------------------
    fn on_pref_changed(subscription: u32, scope: prefs::PrefScope, name: String, value: Option<PrefValue>) {}
    fn on_timer(timer: u32, kind: timers::TimerKind) {}
    fn on_plugin_event(plugin: PluginId, which: lifecycle::Hook, why: lifecycle::Reason) {}
    fn on_locale_changed(locale: String) {}
    fn on_permission_changed(permission: String, granted: bool) {}
    #[cfg(any(feature = "full", all(feature = "dialogs", feature = "reader")))]
    fn on_download_progress(url: String, received: u64, total: Option<u64>) {}

    // ---- tools for AI agents (the `mcp` feature or the full world) --------------------------------------------------
    /// Run the tool `tool` (the name you registered, not the prefixed name an agent sees). `args` is the JSON text of the arguments,
    /// already checked against the tool's input schema. Return the result as JSON text (see `mcp::ok`). Default: `not-found` (no tools).
    #[cfg(any(feature = "full", all(feature = "dialogs", feature = "reader"), all(feature = "mcp", not(feature = "extend"))))]
    fn on_mcp_call(tool: String, args: String) -> Res<String> {
        Err(Error::NotFound(format!("no tool named {tool}")))
    }

    // ---- library change notifications --------------------------------------------------------------------------
    #[cfg(feature = "library")]
    fn on_events(subscription: u32, batch: notifier::EventBatch) {}

    // ---- ui-events (item pane sections, dialogs opened with open-dialog, windows, popovers) --------------------------
    #[cfg(feature = "dialogs")]
    fn mount(instance: ui::InstanceId, ctx: ui::ViewContext) -> ui::RenderResult {
        empty_render()
    }
    #[cfg(feature = "dialogs")]
    fn update_context(instance: ui::InstanceId, ctx: ui::ViewContext) -> ui::RenderResult {
        empty_render()
    }
    #[cfg(feature = "dialogs")]
    fn unmount(instance: ui::InstanceId) {}
    #[cfg(feature = "dialogs")]
    fn visibility(instance: ui::InstanceId, visible: bool) {}
    #[cfg(feature = "dialogs")]
    /// `ui-events.on-event`.
    fn on_ui_event(instance: ui::InstanceId, event: ui::UiEvent) -> ui::RenderResult {
        empty_render()
    }
    #[cfg(feature = "dialogs")]
    fn resync(instance: ui::InstanceId) -> ui::RenderResult {
        empty_render()
    }
    #[cfg(feature = "dialogs")]
    fn render_range(instance: ui::InstanceId, request: ui::RangeRequest) -> ui::RowBatch {
        ui::RowBatch { start: request.start, rows: Vec::new(), styles: None, total: Some(0) }
    }
    #[cfg(feature = "dialogs")]
    fn suggest(instance: ui::InstanceId, request: ui::SuggestRequest) -> Vec<ui::Suggestion> {
        Vec::new()
    }

    // ---- extend-handlers -------------------------------------------------------------------------------------
    #[cfg(feature = "extend")]
    fn on_menu_showing(menu_id: String, ctx: extend::Context) -> Res<Vec<extend::EntryPatch>> {
        Ok(Vec::new())
    }
    #[cfg(feature = "extend")]
    fn on_menu_phase(menu_id: String, entry_id: String, phase: eh::MenuPhase, ctx: extend::Context) {}
    #[cfg(feature = "extend")]
    fn on_menu_command(menu_id: String, entry_id: String, checked: Option<bool>, ctx: extend::Context) -> Res {
        Ok(())
    }
    #[cfg(feature = "extend")]
    fn on_toolbar_click(button_id: String, toggled: Option<bool>, ctx: extend::Context) -> Res {
        Ok(())
    }
    #[cfg(feature = "extend")]
    fn on_shortcut(shortcut_id: String, ctx: extend::Context) -> Res {
        Ok(())
    }
    #[cfg(feature = "extend")]
    fn on_info_row_get(row_id: String, item: ItemKey, tab: extend::TabRef, editable: bool) -> Res<extend::InfoRowValue> {
        Err(Error::Unavailable("on-info-row-get is not implemented".into()))
    }
    #[cfg(feature = "extend")]
    fn on_info_row_set(row_id: String, item: ItemKey, tab: extend::TabRef, value: String) -> Res {
        Ok(())
    }
    #[cfg(feature = "extend")]
    /// One cell per key, in order. The default answers an error, so a column you forgot shows empty.
    fn on_column_values(data_key: String, keys: Vec<ItemKey>) -> Res<Vec<extend::Cell>> {
        Err(Error::Unavailable("on-column-values is not implemented".into()))
    }
    #[cfg(feature = "extend")]
    fn on_row_styles(style_id: String, keys: Vec<ItemKey>) -> Res<Vec<Option<extend::RowStyle>>> {
        Ok(keys.iter().map(|_| None).collect())
    }
    #[cfg(feature = "extend")]
    fn on_collection_decorations(
        decoration_id: String,
        rows: Vec<extend::TreeRow>,
    ) -> Res<Vec<Option<extend::CollectionDecoration>>> {
        Ok(rows.iter().map(|_| None).collect())
    }
    #[cfg(feature = "extend")]
    fn on_virtual_collection_items(
        view_id: String,
        library: LibraryId,
        query: eh::VirtualQuery,
        offset: u32,
        limit: u32,
    ) -> Res<eh::VirtualItems> {
        Ok(eh::VirtualItems { keys: Vec::new(), total: 0 })
    }
    #[cfg(feature = "extend")]
    fn on_pref_pane_open(pane_id: String) {}
    #[cfg(feature = "extend")]
    fn on_pref_pane_close(pane_id: String) {}
    #[cfg(feature = "extend")]
    fn on_pref_action(pane_id: String, action_id: String) -> Res {
        Ok(())
    }
    #[cfg(feature = "extend")]
    /// Return false to veto closing the tab.
    fn on_tab_closing(tab_id: String) -> bool {
        true
    }
    #[cfg(feature = "extend")]
    /// Return true if the plugin restored the tab.
    fn on_tab_restore(tab_id: String, kind: String, state: String) -> bool {
        false
    }
    #[cfg(feature = "extend")]
    fn on_banner_action(banner_id: String, action_id: String) {}
    #[cfg(feature = "extend")]
    fn on_drop(drop_id: String, payload: extend::DropPayload, ctx: extend::Context) -> Res<eh::DropOutcome> {
        Ok(eh::DropOutcome::Ignored)
    }
    #[cfg(feature = "extend")]
    fn on_drag_format(format_id: String, keys: Vec<ItemKey>) -> Res<String> {
        Err(Error::Unavailable("on-drag-format is not implemented".into()))
    }
    #[cfg(feature = "extend")]
    /// `extend-handlers.on-event`: selection, view, tab and theme events (after `extend::subscribe_events`).
    fn on_host_event(event: eh::HostEvent) {}

    // ---- reader-events -----------------------------------------------------------------------------------------
    #[cfg(feature = "reader")]
    /// `reader-events.build-menu`: the entries for a reader menu or toolbar slot registered with `reader::register_listener`.
    fn build_reader_menu(listener_id: String, context: re::MenuContext) -> Vec<extend::MenuEntry> {
        Vec::new()
    }
    #[cfg(feature = "reader")]
    /// `reader-events.on-menu-command`.
    fn on_reader_menu_command(listener_id: String, command: String, context: re::MenuContext) {}
    #[cfg(feature = "reader")]
    fn render_overlay(listener_id: String, reader: reader::ReaderInfo, page_index: u32) -> Vec<re::OverlayShape> {
        Vec::new()
    }
    #[cfg(feature = "reader")]
    fn on_overlay_click(listener_id: String, reader: reader::ReaderInfo, page_index: u32, command: String) {}
    #[cfg(feature = "reader")]
    fn on_link(listener_id: String, context: re::LinkContext) {}
    #[cfg(feature = "reader")]
    fn on_reader_event(event: re::ReaderEvent) {}
    #[cfg(feature = "reader")]
    fn on_note_event(event: note_events::NoteEvent) {}
}

/// Carries a [`Plugin`] to the generated `Guest` traits. Used by [`export_plugin!`](crate::export_plugin).
pub struct Glue<P: Plugin>(core::marker::PhantomData<P>);

impl<P: Plugin> lifecycle::Guest for Glue<P> {
    fn install(data: lifecycle::PluginData, why: lifecycle::Reason) -> Res {
        P::install(data, why)
    }
    fn startup(data: lifecycle::PluginData, why: lifecycle::Reason) -> Res {
        P::startup(data, why)
    }
    fn shutdown(data: lifecycle::PluginData, why: lifecycle::Reason) -> Res {
        P::shutdown(data, why)
    }
    fn uninstall(data: lifecycle::PluginData, why: lifecycle::Reason) -> Res {
        P::uninstall(data, why)
    }
    fn main_window_load(data: lifecycle::PluginData, window: WindowId) -> Res {
        P::main_window_load(data, window)
    }
    fn main_window_unload(data: lifecycle::PluginData, window: WindowId) -> Res {
        P::main_window_unload(data, window)
    }
}

impl<P: Plugin> events::Guest for Glue<P> {
    fn on_pref_changed(subscription: u32, scope: prefs::PrefScope, name: String, value: Option<PrefValue>) {
        P::on_pref_changed(subscription, scope, name, value)
    }
    fn on_timer(timer: u32, kind: timers::TimerKind) {
        P::on_timer(timer, kind)
    }
    fn on_plugin_event(plugin: PluginId, which: lifecycle::Hook, why: lifecycle::Reason) {
        P::on_plugin_event(plugin, which, why)
    }
    fn on_locale_changed(locale: String) {
        P::on_locale_changed(locale)
    }
    fn on_permission_changed(permission: String, granted: bool) {
        P::on_permission_changed(permission, granted)
    }
}

#[cfg(any(feature = "full", all(feature = "dialogs", feature = "reader"), all(feature = "mcp", not(feature = "extend"))))]
impl<P: Plugin> mcp_handler::Guest for Glue<P> {
    fn on_mcp_call(tool: String, args: String) -> Res<String> {
        P::on_mcp_call(tool, args)
    }
}

#[cfg(any(feature = "full", all(feature = "dialogs", feature = "reader")))]
impl<P: Plugin> net_events::Guest for Glue<P> {
    fn on_download_progress(url: String, received: u64, total: Option<u64>) {
        P::on_download_progress(url, received, total)
    }
}

#[cfg(feature = "library")]
impl<P: Plugin> notifier_handler::Guest for Glue<P> {
    fn on_events(subscription: u32, batch: notifier::EventBatch) {
        P::on_events(subscription, batch)
    }
}

#[cfg(any(feature = "ui", all(feature = "dialogs", feature = "reader")))]
impl<P: Plugin> ui_events::Guest for Glue<P> {
    fn mount(instance: ui::InstanceId, ctx: ui::ViewContext) -> ui::RenderResult {
        P::mount(instance, ctx)
    }
    fn update_context(instance: ui::InstanceId, ctx: ui::ViewContext) -> ui::RenderResult {
        P::update_context(instance, ctx)
    }
    fn unmount(instance: ui::InstanceId) {
        P::unmount(instance)
    }
    fn visibility(instance: ui::InstanceId, visible: bool) {
        P::visibility(instance, visible)
    }
    fn on_event(instance: ui::InstanceId, event: ui::UiEvent) -> ui::RenderResult {
        if crate::ui::dispatch_dialog_event(instance, &event) {
            return empty_render();
        }
        P::on_ui_event(instance, event)
    }
    fn resync(instance: ui::InstanceId) -> ui::RenderResult {
        P::resync(instance)
    }
    fn render_range(instance: ui::InstanceId, request: ui::RangeRequest) -> ui::RowBatch {
        P::render_range(instance, request)
    }
    fn suggest(instance: ui::InstanceId, request: ui::SuggestRequest) -> Vec<ui::Suggestion> {
        P::suggest(instance, request)
    }
}

#[cfg(feature = "extend")]
impl<P: Plugin> eh::Guest for Glue<P> {
    fn on_menu_showing(menu_id: String, ctx: extend::Context) -> Res<Vec<extend::EntryPatch>> {
        P::on_menu_showing(menu_id, ctx)
    }
    fn on_menu_phase(menu_id: String, entry_id: String, phase: eh::MenuPhase, ctx: extend::Context) {
        P::on_menu_phase(menu_id, entry_id, phase, ctx)
    }
    fn on_menu_command(menu_id: String, entry_id: String, checked: Option<bool>, ctx: extend::Context) -> Res {
        P::on_menu_command(menu_id, entry_id, checked, ctx)
    }
    fn on_toolbar_click(button_id: String, toggled: Option<bool>, ctx: extend::Context) -> Res {
        P::on_toolbar_click(button_id, toggled, ctx)
    }
    fn on_shortcut(shortcut_id: String, ctx: extend::Context) -> Res {
        P::on_shortcut(shortcut_id, ctx)
    }
    fn on_info_row_get(row_id: String, item: ItemKey, tab: extend::TabRef, editable: bool) -> Res<extend::InfoRowValue> {
        P::on_info_row_get(row_id, item, tab, editable)
    }
    fn on_info_row_set(row_id: String, item: ItemKey, tab: extend::TabRef, value: String) -> Res {
        P::on_info_row_set(row_id, item, tab, value)
    }
    fn on_column_values(data_key: String, keys: Vec<ItemKey>) -> Res<Vec<extend::Cell>> {
        P::on_column_values(data_key, keys)
    }
    fn on_row_styles(style_id: String, keys: Vec<ItemKey>) -> Res<Vec<Option<extend::RowStyle>>> {
        P::on_row_styles(style_id, keys)
    }
    fn on_collection_decorations(
        decoration_id: String,
        rows: Vec<extend::TreeRow>,
    ) -> Res<Vec<Option<extend::CollectionDecoration>>> {
        P::on_collection_decorations(decoration_id, rows)
    }
    fn on_virtual_collection_items(
        view_id: String,
        library: LibraryId,
        query: eh::VirtualQuery,
        offset: u32,
        limit: u32,
    ) -> Res<eh::VirtualItems> {
        P::on_virtual_collection_items(view_id, library, query, offset, limit)
    }
    fn on_pref_pane_open(pane_id: String) {
        P::on_pref_pane_open(pane_id)
    }
    fn on_pref_pane_close(pane_id: String) {
        P::on_pref_pane_close(pane_id)
    }
    fn on_pref_action(pane_id: String, action_id: String) -> Res {
        P::on_pref_action(pane_id, action_id)
    }
    fn on_tab_closing(tab_id: String) -> bool {
        P::on_tab_closing(tab_id)
    }
    fn on_tab_restore(tab_id: String, kind: String, state: String) -> bool {
        P::on_tab_restore(tab_id, kind, state)
    }
    fn on_banner_action(banner_id: String, action_id: String) {
        P::on_banner_action(banner_id, action_id)
    }
    fn on_drop(drop_id: String, payload: extend::DropPayload, ctx: extend::Context) -> Res<eh::DropOutcome> {
        P::on_drop(drop_id, payload, ctx)
    }
    fn on_drag_format(format_id: String, keys: Vec<ItemKey>) -> Res<String> {
        P::on_drag_format(format_id, keys)
    }
    fn on_event(event: eh::HostEvent) {
        P::on_host_event(event)
    }
}

#[cfg(feature = "reader")]
impl<P: Plugin> re::Guest for Glue<P> {
    fn build_menu(listener_id: String, context: re::MenuContext) -> Vec<extend::MenuEntry> {
        P::build_reader_menu(listener_id, context)
    }
    fn on_menu_command(listener_id: String, command: String, context: re::MenuContext) {
        P::on_reader_menu_command(listener_id, command, context)
    }
    fn render_overlay(listener_id: String, reader: reader::ReaderInfo, page_index: u32) -> Vec<re::OverlayShape> {
        P::render_overlay(listener_id, reader, page_index)
    }
    fn on_overlay_click(listener_id: String, reader: reader::ReaderInfo, page_index: u32, command: String) {
        P::on_overlay_click(listener_id, reader, page_index, command)
    }
    fn on_link(listener_id: String, context: re::LinkContext) {
        P::on_link(listener_id, context)
    }
    fn on_reader_event(event: re::ReaderEvent) {
        P::on_reader_event(event)
    }
}

#[cfg(feature = "reader")]
impl<P: Plugin> note_events::Guest for Glue<P> {
    fn on_note_event(event: note_events::NoteEvent) {
        P::on_note_event(event)
    }
}

/// Export your [`Plugin`] type as the component's implementation of the `plugin` world.
///
/// ```ignore
/// zinc_plugin::export_plugin!(MyPlugin);
/// ```
#[macro_export]
macro_rules! export_plugin {
    ($plugin:ty) => {
        #[doc(hidden)]
        type __ZincPluginExport = $crate::Glue<$plugin>;
        $crate::bindings::export!(__ZincPluginExport with_types_in $crate::bindings);
    };
}
