//! Menu entries and registrations (`extend.register-menu`).

use crate::host::extend::{
    Condition, EntryKind, MenuEntry, MenuHooks, MenuRegistration, MenuTarget, RowKind, ThemedIcon,
};
use crate::host::types::{Color, IconRef};
use crate::text::IntoText;

/// A built-in (Lucide) icon, the same in light and dark.
pub fn icon(name: &str) -> ThemedIcon {
    ThemedIcon { light: IconRef::Builtin(name.into()), dark: None }
}

/// A condition that holds everywhere. Chain the `with_*` methods below on the result.
pub fn when() -> Condition {
    Condition {
        tab_kinds: Vec::new(),
        min_items: None,
        max_items: None,
        item_types: Vec::new(),
        row_kinds: Vec::new(),
        require_editable: false,
    }
}

pub trait ConditionExt: Sized {
    fn with_min_items(self, n: u32) -> Self;
    fn with_max_items(self, n: u32) -> Self;
    fn with_tab_kinds(self, kinds: &[&str]) -> Self;
    fn with_item_types(self, types: &[&str]) -> Self;
    fn with_row_kinds(self, kinds: &[RowKind]) -> Self;
    fn editable(self) -> Self;
}
impl ConditionExt for Condition {
    fn with_min_items(mut self, n: u32) -> Self {
        self.min_items = Some(n);
        self
    }
    fn with_max_items(mut self, n: u32) -> Self {
        self.max_items = Some(n);
        self
    }
    fn with_tab_kinds(mut self, kinds: &[&str]) -> Self {
        self.tab_kinds = kinds.iter().map(|s| s.to_string()).collect();
        self
    }
    fn with_item_types(mut self, types: &[&str]) -> Self {
        self.item_types = types.iter().map(|s| s.to_string()).collect();
        self
    }
    fn with_row_kinds(mut self, kinds: &[RowKind]) -> Self {
        self.row_kinds = kinds.to_vec();
        self
    }
    fn editable(mut self) -> Self {
        self.require_editable = true;
        self
    }
}

pub struct MenuEntryBuilder(MenuEntry);

impl MenuEntryBuilder {
    fn base(id: &str, kind: EntryKind, label: Option<crate::host::types::LocalizedString>) -> Self {
        MenuEntryBuilder(MenuEntry {
            id: id.into(),
            parent: None,
            kind,
            label,
            icon: None,
            swatch: None,
            check: None,
            accelerator: None,
            visible_when: None,
            enabled_when: None,
            hooks: MenuHooks::empty(),
        })
    }
    pub fn item(id: &str, label: impl IntoText) -> Self {
        Self::base(id, EntryKind::Item, Some(label.into_text()))
    }
    pub fn separator(id: &str) -> Self {
        Self::base(id, EntryKind::Separator, None)
    }
    pub fn submenu(id: &str, label: impl IntoText) -> Self {
        Self::base(id, EntryKind::Submenu, Some(label.into_text()))
    }
    pub fn parent(mut self, id: &str) -> Self {
        self.0.parent = Some(id.into());
        self
    }
    /// A built-in icon by name.
    pub fn icon(mut self, name: &str) -> Self {
        self.0.icon = Some(icon(name));
        self
    }
    pub fn swatch(mut self, c: Color) -> Self {
        self.0.swatch = Some(c);
        self
    }
    /// Makes it a check item (`Some(initial state)`).
    pub fn check(mut self, checked: bool) -> Self {
        self.0.check = Some(checked);
        self
    }
    pub fn accelerator(mut self, a: &str) -> Self {
        self.0.accelerator = Some(a.into());
        self
    }
    pub fn visible_when(mut self, c: Condition) -> Self {
        self.0.visible_when = Some(c);
        self
    }
    pub fn enabled_when(mut self, c: Condition) -> Self {
        self.0.enabled_when = Some(c);
        self
    }
    /// Ask the host to call `on-menu-showing` / `on-menu-phase` for this entry.
    pub fn hooks(mut self, h: MenuHooks) -> Self {
        self.0.hooks = h;
        self
    }
    pub fn build(self) -> MenuEntry {
        self.0
    }
}

impl From<MenuEntryBuilder> for MenuEntry {
    fn from(b: MenuEntryBuilder) -> MenuEntry {
        b.0
    }
}

/// Build a registration: `menu::registration("my-menu", MenuTarget::LibraryItem, [entry1.into(), ...])`.
pub fn registration(menu_id: &str, target: MenuTarget, entries: Vec<MenuEntry>) -> MenuRegistration {
    MenuRegistration { menu_id: menu_id.into(), target, entries }
}
