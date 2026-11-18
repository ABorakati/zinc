//! Rust SDK for Zinc WASM plugins.
//!
//! A plugin component targets the `zinc:plugin/plugin` world, which exports eight callback interfaces
//! (about 45 functions). `wit-bindgen` alone would make a plugin implement every one of them. This crate
//! generates the bindings once and gives you:
//!
//! * [`Plugin`]: one trait whose methods all have no-op defaults. Implement only the ones you use.
//! * [`export_plugin!`]: wires your type to the world (it replaces `wit_bindgen::generate!` + `export!`).
//! * Builders: [`text`] (localized strings), [`err`] (errors), [`menu`] (menu entries and registrations),
//!   [`ui`] (UI trees, the flat node list, from a nested expression), [`reg`] (extension point registration).
//! * [`prelude`]: the names a plugin usually needs.
//!
//! ```ignore
//! use zinc_plugin::prelude::*;
//!
//! struct Hello;
//! impl Plugin for Hello {
//!     fn startup(_data: PluginData, _why: Reason) -> Result<(), Error> {
//!         log::info("hello");
//!         Ok(())
//!     }
//! }
//! zinc_plugin::export_plugin!(Hello);
//! ```

#![allow(clippy::too_many_arguments)]

/// The raw generated bindings (every import interface and every export `Guest` trait of the selected world).
///
/// Exactly one world is generated, chosen by the cargo features (highest wins):
///
/// | feature   | world            | adds |
/// |-----------|------------------|------|
/// | (none)    | `plugin-core`    | lifecycle, events, app, prefs, l10n, timers, log |
/// | `library` | `plugin-library` | library, attachments, fulltext, schema, cite, translate, sync-control, data-utils, notifier |
/// | `extend`  | `plugin-extend`  | extend (menus, columns, panes, ...) and the extend-handlers callbacks |
/// | `ui`      | `plugin-ui`      | ui (views, dialogs, windows) and the ui-events callbacks: by far the slowest to compile |
/// | `reader`  | `plugin-reader`  | annotations, reader, note-editor, reader-events, note-events |
/// | `full`    | `plugin`         | everything, including net, fs, clipboard, shell, secrets |
///
/// `ui` and `reader` together need `full`.
pub mod bindings {
    #[cfg(all(feature = "ui", feature = "reader", not(feature = "full")))]
    compile_error!("features `ui` and `reader` together need the `plugin` world: enable `full`");

    #[cfg(feature = "full")]
    pub use self::w_plugin::*;
    #[cfg(all(feature = "ui", not(feature = "full")))]
    pub use self::w_ui::*;
    #[cfg(all(feature = "dialogs", not(feature = "ui"), not(feature = "reader"), not(feature = "full")))]
    pub use self::w_dialogs::*;
    #[cfg(all(feature = "reader", not(feature = "full"), not(feature = "dialogs")))]
    pub use self::w_reader::*;
    #[cfg(all(feature = "extend", not(feature = "dialogs"), not(feature = "reader"), not(feature = "full")))]
    pub use self::w_extend::*;
    #[cfg(all(feature = "library", not(feature = "extend"), not(feature = "full")))]
    pub use self::w_library::*;
    #[cfg(not(feature = "library"))]
    pub use self::w_core::*;

    macro_rules! world {
        ($m:ident, $cfg:meta, $name:literal) => {
            #[cfg($cfg)]
            mod $m {
                wit_bindgen::generate!({
                    world: $name,
                    path: "../../wit",
                    generate_all,
                    pub_export_macro: true,
                    default_bindings_module: "zinc_plugin::bindings",
                });
            }
        };
    }
    world!(w_plugin, feature = "full", "zinc:plugin/plugin");
    world!(w_ui, all(feature = "ui", not(feature = "full")), "zinc:plugin/plugin-ui");
    world!(
        w_dialogs,
        all(feature = "dialogs", not(feature = "ui"), not(feature = "reader"), not(feature = "full")),
        "zinc:plugin/plugin-dialogs"
    );
    world!(w_reader, all(feature = "reader", not(feature = "full"), not(feature = "dialogs")), "zinc:plugin/plugin-reader");
    world!(
        w_extend,
        all(feature = "extend", not(feature = "dialogs"), not(feature = "reader"), not(feature = "full")),
        "zinc:plugin/plugin-extend"
    );
    world!(w_library, all(feature = "library", not(feature = "extend"), not(feature = "full")), "zinc:plugin/plugin-library");
    world!(w_core, not(feature = "library"), "zinc:plugin/plugin-core");
}

pub mod err;
pub mod json;
#[cfg(feature = "extend")]
pub mod menu;
pub mod plugin;
#[cfg(feature = "extend")]
pub mod reg;
pub mod text;
#[cfg(feature = "ui")]
pub mod ui;

pub use plugin::{Glue, Plugin};

/// The host imports, one module per WIT interface (`zinc_plugin::host::library::apply(...)`).
pub mod host {
    pub use crate::bindings::zinc::plugin::{app, l10n, prefs, timers, types};
    #[cfg(feature = "library")]
    pub use crate::bindings::zinc::plugin::{attachments, cite, data_utils, fulltext, library, notifier, schema, sync_control, translate};
    #[cfg(feature = "extend")]
    pub use crate::bindings::zinc::plugin::extend;
    #[cfg(feature = "ui")]
    pub use crate::bindings::zinc::plugin::ui;
    #[cfg(feature = "reader")]
    pub use crate::bindings::zinc::plugin::{annotations, note_editor, reader};
    #[cfg(feature = "full")]
    pub use crate::bindings::zinc::plugin::{clipboard, fs, net, permissions, plugins, secrets, shell, util};
}

/// The callback interfaces a plugin implements, with their types (`lifecycle::PluginData`, `events::...`).
pub mod callbacks {
    pub use crate::bindings::exports::zinc::plugin::{events, lifecycle};
    #[cfg(feature = "library")]
    pub use crate::bindings::exports::zinc::plugin::notifier_handler;
    #[cfg(feature = "extend")]
    pub use crate::bindings::exports::zinc::plugin::extend_handlers;
    #[cfg(feature = "ui")]
    pub use crate::bindings::exports::zinc::plugin::ui_events;
    #[cfg(feature = "reader")]
    pub use crate::bindings::exports::zinc::plugin::{note_events, reader_events};
    #[cfg(feature = "full")]
    pub use crate::bindings::exports::zinc::plugin::net_events;
}

/// `log::info("...")` and friends. Thin wrapper over `zinc:plugin/log`.
pub mod log {
    use crate::bindings::zinc::plugin::{log as raw, types::LogLevel};
    pub fn error(m: impl AsRef<str>) {
        raw::write(LogLevel::Error, m.as_ref())
    }
    pub fn warn(m: impl AsRef<str>) {
        raw::write(LogLevel::Warn, m.as_ref())
    }
    pub fn info(m: impl AsRef<str>) {
        raw::write(LogLevel::Info, m.as_ref())
    }
    pub fn debug(m: impl AsRef<str>) {
        raw::write(LogLevel::Debug, m.as_ref())
    }
}

/// The names a plugin usually needs.
pub mod prelude {
    pub use crate::callbacks::lifecycle::{Hook, PluginData, Reason};
    pub use crate::err::{self, Error};
    pub use crate::host::prefs::PrefScope;
    pub use crate::host::timers::TimerKind;
    pub use crate::host::types::{Color, ColorToken, IconRef, ItemRef, LocalizedString, PrefValue};
    pub use crate::plugin::Plugin;
    pub use crate::text::{self, l10n, plain};
    pub use crate::{host, log};

    #[cfg(feature = "extend")]
    pub use crate::callbacks::extend_handlers::{DropOutcome, HostEvent, MenuPhase, VirtualItems, VirtualQuery};
    #[cfg(feature = "extend")]
    pub use crate::host::extend::{
        Cell, CellBody, Context, EntryPatch, InfoRowValue, MenuEntry, MenuTarget, RowStyle, TabRef, TreeRow,
    };
    #[cfg(feature = "extend")]
    pub use crate::menu::{self, MenuEntryBuilder};
    #[cfg(feature = "extend")]
    pub use crate::reg;
    #[cfg(feature = "ui")]
    pub use crate::host::ui::{
        DialogOutcome, EventKind, EventPayload, InstanceId, RenderResult, Surface, UiEvent, ViewContext,
    };
    #[cfg(feature = "reader")]
    pub use crate::callbacks::reader_events::{
        AnnotationMenuParams, LinkContext, MenuContext, MenuParams, OverlayShape, ReaderEvent,
    };
    #[cfg(feature = "ui")]
    pub use crate::ui::{self, El};
}
