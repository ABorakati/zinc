//! Extension point registrations with the boring fields filled in. Everything returns the WIT record, so you can still
//! change any field before calling the `register_*` function.

use crate::host::extend::{
    self, ColumnAlign, ColumnRegistration, SectionButton, SectionHeader, SectionRegistration, SectionSidenav,
    SettingControl, SettingRow, SortMode,
};
#[cfg(feature = "reader")]
use crate::host::reader::{self, ListenerRegistration, ListenerTarget, ReaderKind, SlotKind};
use crate::menu::icon;
use crate::text::IntoText;

pub use crate::host::extend::{register_column, register_menu, register_pref_pane, register_section, register_shortcut};

/// A column for the item list (`trees` = `["item-tree-main-default"]`). Values come from `on-column-values(data_key)`.
pub fn column(data_key: &str, label: impl IntoText) -> ColumnRegistration {
    ColumnRegistration {
        data_key: data_key.into(),
        label: label.into_text(),
        trees: vec!["item-tree-main-default".into()],
        sort: SortMode::Number,
        sort_reverse: false,
        flex: None,
        width: Some(90),
        min_width: None,
        fixed_width: false,
        static_width: false,
        no_padding: false,
        icon: None,
        align: ColumnAlign::End,
        show_in_picker: true,
        picker_submenu: false,
    }
}

/// An item pane section. The body is a view: the host calls `mount` with `ViewContext.view == pane_id`.
pub fn section(pane_id: &str, label: impl IntoText + Clone, icon_name: &str) -> SectionRegistration {
    SectionRegistration {
        pane_id: pane_id.into(),
        header: SectionHeader { label: label.clone().into_text(), icon: icon(icon_name) },
        sidenav: SectionSidenav { label: label.into_text(), icon: icon(icon_name), orderable: true },
        enabled_for: None,
        buttons: Vec::<SectionButton>::new(),
        body_height: None,
        default_open: true,
        decides_enabled: false,
    }
}

/// A settings row bound to a plugin pref, as a toggle.
pub fn setting_toggle(id: &str, label: impl IntoText, pref: &str) -> SettingRow {
    setting(id, label, SettingControl::Toggle(pref.into()))
}

/// A settings row with a number field bound to a plugin pref.
pub fn setting_number(id: &str, label: impl IntoText, pref: &str, min: Option<i32>, max: Option<i32>) -> SettingRow {
    setting(id, label, SettingControl::Number(extend::NumberSetting { pref: pref.into(), min, max, step: Some(1) }))
}

pub fn setting(id: &str, label: impl IntoText, control: SettingControl) -> SettingRow {
    SettingRow {
        id: id.into(),
        group: None,
        label: label.into_text(),
        description: None,
        keywords: Vec::new(),
        control,
        enabled_when: None,
        visible_when: None,
    }
}

/// A preference pane made of rows.
pub fn pref_pane(pane_id: &str, label: impl IntoText, rows: Vec<SettingRow>) -> extend::PrefPaneRegistration {
    extend::PrefPaneRegistration {
        pane_id: pane_id.into(),
        parent: None,
        label: Some(label.into_text()),
        icon: None,
        help_url: None,
        order: 0,
        content: extend::PaneContent::Rows(rows),
        open_close_hooks: false,
    }
}

#[cfg(feature = "reader")]
mod reader_part {
    use super::*;
    /// A reader listener: a toolbar slot or a menu. `static_menu` entries are used as is; `build-menu` can answer more.
    pub fn reader_listener(id: &str, target: ListenerTarget) -> ListenerRegistration {
        ListenerRegistration { id: id.into(), target, reader_kinds: vec![ReaderKind::Pdf, ReaderKind::Epub], static_menu: Vec::new() }
    }

    pub fn reader_toolbar(id: &str) -> ListenerRegistration {
        reader_listener(id, ListenerTarget::Slot(SlotKind::Toolbar))
    }

    pub fn register_reader_listener(r: &ListenerRegistration) -> Result<(), crate::err::Error> {
        reader::register_listener(r)
    }

}
#[cfg(feature = "reader")]
pub use reader_part::*;
