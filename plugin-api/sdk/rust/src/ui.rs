//! UI trees, patches, dialogs and toasts.
//!
//! Trees and patches cross the WIT boundary as JSON strings checked against `plugin-api/ui-schema/ui-tree.schema.json`.
//! [`Tree`], [`El`], [`Style`], [`PatchSet`] and [`PatchOp`] are `serde` types that serialize directly to that schema.
//!
//! ```ignore
//! use zinc_plugin::ui::*;
//! let view = column().gap(2).padding(3)
//!     .child(heading("Word count"))
//!     .child(text("1,204 words").key("count"))
//!     .child(button("Refresh").on(EventKind::Press, "refresh"));
//! let result = render(view);
//! ```

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};

use crate::host::types::{Color, ColorToken, LocalizedString};
use crate::text::IntoText;

pub use crate::host::ui::{
    self as raw, ButtonRole, ContentUpdate, DialogButton, DialogSpec, EventKind, EventPayload, FontFamily, FontSize,
    FontWeight, FormField, InstanceId, RenderResult, ScrollAlign, Surface, ToastAction, ToastLine, ToastSpec, Tone,
    UiEvent, Value, ViewContext, ViewMeta,
};

// ------------------------------------------------------------------------------------------------ serde schema types

/// Alignment values (`style.alignItems`, `style.alignSelf`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Align {
    Start,
    Center,
    End,
    Stretch,
    Baseline,
}

/// Justification values (`style.justifyContent`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Justify {
    Start,
    Center,
    End,
    SpaceBetween,
    SpaceAround,
    SpaceEvenly,
}

/// Flex / split direction (`style.direction`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Direction {
    Row,
    Column,
    RowReverse,
    ColumnReverse,
}

/// Text kind (`text.kind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextKind {
    Body,
    Label,
    Caption,
    Heading1,
    Heading2,
    Heading3,
    Title,
    Mono,
}

/// Button look (`button.look`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ButtonLook {
    Standard,
    Primary,
    Ghost,
    Outline,
    Destructive,
    Link,
}

/// Control size (`button.size`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ControlSize {
    Sm,
    Md,
    Lg,
}

/// Node style (`$defs.style` in `ui-tree.schema.json`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Style {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<Direction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrap: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align_items: Option<Align>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub justify_content: Option<Justify>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gap: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align_self: Option<Align>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flex_grow: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flex_shrink: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flex_basis: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_width: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_height: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_width: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_height: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub padding: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub margin: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreground: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub radius: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_weight: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strike: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_align: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_wrap: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_lines: Option<u8>,
}

/// Interaction state styles (`$defs.stateStyles`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateStyles {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hover: Option<Style>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pressed: Option<Style>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focus_visible: Option<Style>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled: Option<Style>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected: Option<Style>,
}

/// A named style (`$defs.namedStyle`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedStyle {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<Style>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub states: Option<StateStyles>,
}

/// Event binding in a node's `on` map (`$defs.binding`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Binding {
    Handler(String),
    Full {
        handler: String,
        #[serde(rename = "debounceMs", skip_serializing_if = "Option::is_none")]
        debounce_ms: Option<u32>,
        #[serde(rename = "throttleMs", skip_serializing_if = "Option::is_none")]
        throttle_ms: Option<u32>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        keys: Vec<String>,
        #[serde(rename = "preventDefault", skip_serializing_if = "Option::is_none")]
        prevent_default: Option<bool>,
        #[serde(rename = "stopPropagation", skip_serializing_if = "Option::is_none")]
        stop_propagation: Option<bool>,
    },
}

/// One node of a UI tree (`$defs.node` in `ui-tree.schema.json`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct El {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pref: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub class: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<Style>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub states: Option<StateStyles>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub on: BTreeMap<String, Binding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tooltip: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_focus: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub test_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<El>,
    #[serde(flatten)]
    pub props: BTreeMap<String, JsonValue>,
}

/// A full UI tree (`$defs.tree` / root of `ui-tree.schema.json`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tree {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rev: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub styles: Vec<NamedStyle>,
    pub root: El,
}

/// One operation in a [`PatchSet`] (`$defs.patchOp` in `ui-tree.schema.json`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum PatchOp {
    SetNode {
        key: String,
        node: El,
    },
    Replace {
        key: String,
        node: El,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        styles: Vec<NamedStyle>,
    },
    Insert {
        parent: String,
        index: u32,
        node: El,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        styles: Vec<NamedStyle>,
    },
    Remove {
        key: String,
    },
    Move {
        key: String,
        parent: String,
        index: u32,
    },
    SetStyles {
        styles: Vec<NamedStyle>,
    },
}

/// An incremental patch set (`$defs.patchSet` in `ui-tree.schema.json`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSet {
    pub base_rev: u64,
    pub rev: u64,
    pub ops: Vec<PatchOp>,
}

// ------------------------------------------------------------------------------------------------ helpers

pub fn style() -> Style {
    Style::default()
}

fn text_json(t: LocalizedString) -> JsonValue {
    match t {
        LocalizedString::Plain(s) => JsonValue::String(s),
        LocalizedString::Localized(r) => {
            let mut args = serde_json::Map::new();
            for a in r.args {
                let v = match a.value {
                    crate::host::types::L10nArg::Text(s) => JsonValue::String(s),
                    crate::host::types::L10nArg::Integer(n) => json!(n),
                    crate::host::types::L10nArg::Number(n) => json!(n),
                    crate::host::types::L10nArg::Date(ms) => json!({ "date": ms }),
                };
                args.insert(a.name, v);
            }
            let mut obj = serde_json::Map::new();
            obj.insert("id".into(), JsonValue::String(r.id));
            if !args.is_empty() {
                obj.insert("args".into(), JsonValue::Object(args));
            }
            if let Some(fb) = r.fallback {
                obj.insert("fallback".into(), JsonValue::String(fb));
            }
            JsonValue::Object(obj)
        }
    }
}

fn token_str(t: ColorToken) -> &'static str {
    match t {
        ColorToken::Background => "background",
        ColorToken::Foreground => "foreground",
        ColorToken::Card => "card",
        ColorToken::Muted => "muted",
        ColorToken::MutedForeground => "muted-foreground",
        ColorToken::Popover => "popover",
        ColorToken::PopoverForeground => "popover-foreground",
        ColorToken::Border => "border",
        ColorToken::Input => "input",
        ColorToken::Ring => "ring",
        ColorToken::Primary => "primary",
        ColorToken::PrimaryForeground => "primary-foreground",
        ColorToken::PrimarySoft => "primary-soft",
        ColorToken::PrimaryTint => "primary-tint",
        ColorToken::PrimaryLine => "primary-line",
        ColorToken::PrimaryDeep => "primary-deep",
        ColorToken::Secondary => "secondary",
        ColorToken::SecondaryForeground => "secondary-foreground",
        ColorToken::Accent => "accent",
        ColorToken::AccentForeground => "accent-foreground",
        ColorToken::Destructive => "destructive",
        ColorToken::DestructiveForeground => "destructive-foreground",
        ColorToken::Success => "success",
        ColorToken::SuccessForeground => "success-foreground",
        ColorToken::Warning => "warning",
        ColorToken::WarningForeground => "warning-foreground",
        ColorToken::Error => "error",
        ColorToken::ErrorForeground => "error-foreground",
        ColorToken::PaletteBlue => "palette-blue",
        ColorToken::PaletteSky => "palette-sky",
        ColorToken::PaletteGreen => "palette-green",
        ColorToken::PaletteAmber => "palette-amber",
        ColorToken::PaletteRust => "palette-rust",
        ColorToken::PaletteRose => "palette-rose",
        ColorToken::PaletteViolet => "palette-violet",
        ColorToken::PaletteSlate => "palette-slate",
    }
}

fn rgba_hex(n: u32) -> String {
    if (n & 0xff) == 0xff {
        format!("#{:06x}", n >> 8)
    } else {
        format!("#{:08x}", n)
    }
}

fn color_json(c: Color) -> JsonValue {
    match c {
        Color::Token(t) => JsonValue::String(token_str(t).into()),
        Color::TokenAlpha(ta) => json!({ "token": token_str(ta.token), "alpha": ta.alpha }),
        Color::Rgba(n) => JsonValue::String(rgba_hex(n)),
        Color::Themed(tc) => json!({ "light": rgba_hex(tc.light), "dark": rgba_hex(tc.dark) }),
    }
}

fn event_kind_str(e: EventKind) -> &'static str {
    match e {
        EventKind::Press => "press",
        EventKind::DoublePress => "double-press",
        EventKind::ContextMenu => "context-menu",
        EventKind::Change => "change",
        EventKind::Input => "input",
        EventKind::Submit => "submit",
        EventKind::Focus => "focus",
        EventKind::Blur => "blur",
        EventKind::KeyDown => "key-down",
        EventKind::KeyUp => "key-up",
        EventKind::HoverEnter => "hover-enter",
        EventKind::HoverLeave => "hover-leave",
        EventKind::Toggle => "toggle",
        EventKind::Select => "select",
        EventKind::Activate => "activate",
        EventKind::Sort => "sort",
        EventKind::Resize => "resize",
        EventKind::Scroll => "scroll",
        EventKind::Drop => "drop",
        EventKind::DragStart => "drag-start",
        EventKind::Close => "close",
        EventKind::Message => "message",
        EventKind::Web => "web",
        EventKind::PointerDown => "pointer-down",
        EventKind::PointerMove => "pointer-move",
        EventKind::PointerUp => "pointer-up",
        EventKind::Wheel => "wheel",
        EventKind::ViewChanged => "view-changed",
        EventKind::Visible => "visible",
        EventKind::Embed => "embed",
    }
}

impl El {
    pub fn new(kind: impl Into<String>) -> El {
        El { kind: kind.into(), ..Default::default() }
    }
    pub fn prop(mut self, name: &str, value: impl Into<JsonValue>) -> El {
        self.props.insert(name.into(), value.into());
        self
    }
    /// Stable identity: needed for patches, host-kept state (typed text, scroll), focus and events that name a node.
    pub fn key(mut self, k: &str) -> El {
        self.key = Some(k.into());
        self
    }
    /// Form field name (read back from `form-values` and dialog outcomes).
    pub fn name(mut self, n: &str) -> El {
        self.name = Some(n.into());
        self
    }
    /// Bind a control's value to one of the plugin's own preferences.
    pub fn pref(mut self, p: &str) -> El {
        self.pref = Some(p.into());
        self
    }
    pub fn tooltip(mut self, t: impl IntoText) -> El {
        self.tooltip = Some(text_json(t.into_text()));
        self
    }
    pub fn disabled(mut self, d: bool) -> El {
        self.disabled = Some(d);
        self
    }
    pub fn hidden(mut self, h: bool) -> El {
        self.hidden = Some(h);
        self
    }
    pub fn test_id(mut self, id: &str) -> El {
        self.test_id = Some(id.into());
        self
    }
    /// Send `event` to the plugin's `on-ui-event` with `handler` as the handler id.
    pub fn on(mut self, event: EventKind, handler: &str) -> El {
        self.on.insert(event_kind_str(event).into(), Binding::Handler(handler.into()));
        self
    }
    /// Change the style in place.
    pub fn style_with(mut self, f: impl FnOnce(&mut Style)) -> El {
        let mut s = self.style.take().unwrap_or_default();
        f(&mut s);
        self.style = Some(s);
        self
    }
    /// Spacing between children, in steps of the spacing scale (n * 4 px).
    pub fn gap(self, step: u8) -> El {
        self.style_with(|s| s.gap = Some(json!(step)))
    }
    pub fn padding(self, step: u8) -> El {
        self.style_with(|s| s.padding = Some(json!(step)))
    }
    pub fn margin(self, step: u8) -> El {
        self.style_with(|s| s.margin = Some(json!(step)))
    }
    /// Take the remaining space.
    pub fn grow(self) -> El {
        self.style_with(|s| s.flex_grow = Some(1.0))
    }
    pub fn width_px(self, px: f32) -> El {
        self.style_with(|s| s.width = Some(JsonValue::String(format!("{px}px"))))
    }
    pub fn fill_width(self) -> El {
        self.style_with(|s| s.width = Some(JsonValue::String("fill".into())))
    }
    pub fn align(self, a: Align) -> El {
        self.style_with(|s| s.align_items = Some(a))
    }
    pub fn justify(self, j: Justify) -> El {
        self.style_with(|s| s.justify_content = Some(j))
    }
    pub fn color(self, c: Color) -> El {
        self.style_with(|s| s.foreground = Some(color_json(c)))
    }
    pub fn background(self, c: Color) -> El {
        self.style_with(|s| s.background = Some(color_json(c)))
    }
    pub fn child(mut self, c: El) -> El {
        self.children.push(c);
        self
    }
    pub fn children(mut self, cs: impl IntoIterator<Item = El>) -> El {
        self.children.extend(cs);
        self
    }

    pub fn into_tree(self) -> Tree {
        Tree { rev: None, styles: Vec::new(), root: self }
    }
    pub fn into_tree_rev(self, rev: u64) -> Tree {
        Tree { rev: Some(rev), styles: Vec::new(), root: self }
    }
    /// Serialize as a JSON tree string (`$defs.tree` in `ui-tree.schema.json`).
    pub fn to_json_tree(&self) -> String {
        serde_json::to_string(&Tree { rev: None, styles: Vec::new(), root: self.clone() }).unwrap_or_else(|_| "{\"root\":{\"type\":\"box\"}}".into())
    }
    /// Serialize as a single JSON node (`$defs.node`, for `row.content` and `cell.content`).
    pub fn to_json_node(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{\"type\":\"box\"}".into())
    }
}

impl From<El> for Tree {
    fn from(e: El) -> Tree {
        e.into_tree()
    }
}

impl Tree {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{\"root\":{\"type\":\"box\"}}".into())
    }
}

// ---- containers -------------------------------------------------------------------------------------------------

/// A vertical stack.
pub fn column() -> El {
    El::new("box").style_with(|s| s.direction = Some(Direction::Column))
}
/// A horizontal row.
pub fn row() -> El {
    El::new("box").style_with(|s| s.direction = Some(Direction::Row))
}
pub fn boxed() -> El {
    El::new("box")
}
pub fn card() -> El {
    El::new("card")
}
pub fn spacer() -> El {
    El::new("spacer")
}
pub fn separator() -> El {
    El::new("separator")
}
pub fn group(caption: impl IntoText) -> El {
    El::new("group").prop("caption", text_json(caption.into_text()))
}
/// A collapsible section (as in the item pane).
pub fn section(title: impl IntoText) -> El {
    El::new("section").prop("title", text_json(title.into_text()))
}
/// A form: a `submit` button inside it sends `submit` with the values of all named fields.
pub fn form() -> El {
    El::new("form")
}

// ---- content ----------------------------------------------------------------------------------------------------

fn text_of(kind: TextKind, t: LocalizedString) -> El {
    El::new("text")
        .prop("kind", serde_json::to_value(kind).unwrap_or(JsonValue::String("body".into())))
        .prop("text", text_json(t))
}
pub fn text(t: impl IntoText) -> El {
    text_of(TextKind::Body, t.into_text())
}
pub fn label(t: impl IntoText) -> El {
    text_of(TextKind::Label, t.into_text())
}
pub fn caption(t: impl IntoText) -> El {
    text_of(TextKind::Caption, t.into_text())
}
pub fn heading(t: impl IntoText) -> El {
    text_of(TextKind::Heading2, t.into_text())
}
pub fn mono(t: impl IntoText) -> El {
    text_of(TextKind::Mono, t.into_text())
}
pub fn callout(tone: Tone, message: impl IntoText) -> El {
    let tone_s = match tone {
        Tone::Neutral => "neutral",
        Tone::Info => "info",
        Tone::Success => "success",
        Tone::Warning => "warning",
        Tone::Error => "error",
    };
    El::new("callout")
        .prop("tone", tone_s)
        .prop("message", text_json(message.into_text()))
}
pub fn badge(label: impl IntoText, tone: Tone) -> El {
    let tone_s = match tone {
        Tone::Neutral => "neutral",
        Tone::Info => "info",
        Tone::Success => "success",
        Tone::Warning => "warning",
        Tone::Error => "error",
    };
    El::new("badge")
        .prop("label", text_json(label.into_text()))
        .prop("tone", tone_s)
}
/// `value` in 0..=1, or `None` for indeterminate.
pub fn progress(value: Option<f32>) -> El {
    let el = El::new("progress").prop("look", "bar");
    match value {
        Some(v) => el.prop("value", json!(v)),
        None => el,
    }
}

// ---- controls ---------------------------------------------------------------------------------------------------

pub fn button(label: impl IntoText) -> El {
    El::new("button").prop("label", text_json(label.into_text()))
}
/// A primary button that submits its form.
pub fn submit_button(label: impl IntoText) -> El {
    button(label).look(ButtonLook::Primary).prop("submit", true)
}
pub fn text_input(value: &str) -> El {
    El::new("text-input").prop("value", value)
}
pub fn checkbox(label: impl IntoText, checked: bool) -> El {
    El::new("checkbox")
        .prop("label", text_json(label.into_text()))
        .prop("checked", checked)
}
/// `options`: (value, label) pairs.
pub fn select(options: &[(&str, &str)], value: Option<&str>) -> El {
    let opts: Vec<JsonValue> = options.iter().map(|(v, l)| json!({ "value": v, "label": l })).collect();
    let el = El::new("select").prop("options", JsonValue::Array(opts));
    match value {
        Some(v) => el.prop("value", v),
        None => el,
    }
}

impl El {
    pub fn placeholder(self, t: impl IntoText) -> El {
        self.prop("placeholder", text_json(t.into_text()))
    }
    pub fn multiline(self, min_rows: u8) -> El {
        self.prop("multiline", true).prop("minRows", min_rows)
    }
    pub fn auto_focus(mut self) -> El {
        self.auto_focus = Some(true);
        self
    }
    pub fn look(self, l: ButtonLook) -> El {
        self.prop("look", serde_json::to_value(l).unwrap_or(JsonValue::String("standard".into())))
    }
    pub fn size(self, s: ControlSize) -> El {
        self.prop("size", serde_json::to_value(s).unwrap_or(JsonValue::String("md".into())))
    }
    pub fn icon(self, name: &str) -> El {
        self.prop("icon", name)
    }
    /// Section: open or closed by default.
    pub fn open(self, open: bool) -> El {
        self.prop("open", open)
    }
    pub fn title(self, t: impl IntoText) -> El {
        self.prop("title", text_json(t.into_text()))
    }
}

// ---- results ----------------------------------------------------------------------------------------------------

/// The whole tree as the answer to `mount` / `update-context` / `on-event`.
pub fn render(root: impl Into<Tree>) -> RenderResult {
    RenderResult { content: ContentUpdate::Json(root.into().to_json()), meta: None, focus: None }
}
/// Same tree as last time: nothing to do.
pub fn unchanged() -> RenderResult {
    RenderResult { content: ContentUpdate::Unchanged, meta: None, focus: None }
}
/// A tree in the nested JSON form (`ui-schema/ui-tree.schema.json`).
pub fn render_json(json: impl Into<String>) -> RenderResult {
    RenderResult { content: ContentUpdate::Json(json.into()), meta: None, focus: None }
}
/// An incremental patch set (`$defs.patchSet` in `ui-schema/ui-tree.schema.json`).
pub fn render_patch(patch: &PatchSet) -> RenderResult {
    let s = serde_json::to_string(patch).unwrap_or_else(|_| "{\"baseRev\":0,\"rev\":0,\"ops\":[]}".into());
    RenderResult { content: ContentUpdate::Patch(s), meta: None, focus: None }
}

// ---- dialogs, toasts, form values ---------------------------------------------------------------------------------

/// Outcome delivered when a dialog opened with [`open_dialog_with`] or [`ask`] closes.
#[derive(Clone, Debug)]
pub struct DialogOutcome {
    /// Pressed button id, or `None` if dismissed.
    pub button: Option<String>,
    /// Values of the named inputs in the dialog when it closed.
    pub values: Vec<FormField>,
}

struct PendingDialog {
    button: Option<String>,
    cb: Box<dyn FnOnce(DialogOutcome)>,
}

thread_local! {
    static PENDING_DIALOGS: RefCell<HashMap<InstanceId, PendingDialog>> = RefCell::new(HashMap::new());
}

/// Internal: called by `Glue<P>::on_event` to route dialog `close` events to registered callbacks.
pub fn dispatch_dialog_event(instance: InstanceId, event: &UiEvent) -> bool {
    if !matches!(event.kind, EventKind::Close) {
        return false;
    }
    let has = PENDING_DIALOGS.with(|m| m.borrow().contains_key(&instance));
    if !has {
        return false;
    }
    match &event.payload {
        EventPayload::Button(b) => {
            PENDING_DIALOGS.with(|m| {
                if let Some(d) = m.borrow_mut().get_mut(&instance) {
                    d.button = Some(b.clone());
                }
            });
            true
        }
        EventPayload::None => {
            PENDING_DIALOGS.with(|m| {
                if let Some(d) = m.borrow_mut().get_mut(&instance) {
                    d.button = None;
                }
            });
            true
        }
        EventPayload::Form(values) => {
            let entry = PENDING_DIALOGS.with(|m| m.borrow_mut().remove(&instance));
            if let Some(d) = entry {
                let button = d.button.or_else(|| if event.handler.is_empty() { None } else { Some(event.handler.clone()) });
                (d.cb)(DialogOutcome { button, values: values.clone() });
            }
            true
        }
        _ => false,
    }
}

pub fn dialog_button(id: &str, label: impl IntoText, role: ButtonRole) -> DialogButton {
    DialogButton {
        id: id.into(),
        label: label.into_text(),
        role,
        disabled: false,
        closes: true,
        is_default: matches!(role, ButtonRole::Accept),
    }
}

/// A modal dialog spec with `content` serialized to JSON and the given buttons.
pub fn dialog(title: impl IntoText, content: El, buttons: Vec<DialogButton>) -> DialogSpec {
    DialogSpec {
        title: title.into_text(),
        icon: None,
        content: content.to_json_tree(),
        buttons,
        width: Some(420.0),
        height: None,
        resizable: false,
        modal: true,
        dismiss_on_escape: true,
    }
}

/// Open a dialog without blocking and run `on_close` when its `close` event arrives.
pub fn open_dialog_with(
    spec: &DialogSpec,
    on_close: impl FnOnce(DialogOutcome) + 'static,
) -> Result<InstanceId, crate::err::Error> {
    let id = raw::open_dialog(spec)?;
    PENDING_DIALOGS.with(|m| {
        m.borrow_mut().insert(id, PendingDialog { button: None, cb: Box::new(on_close) });
    });
    Ok(id)
}

/// Open an OK / Cancel dialog and run `on_close` with `Some(values)` if the user pressed OK, or `None` if cancelled.
pub fn ask(
    title: impl IntoText,
    content: El,
    ok_label: impl IntoText,
    on_close: impl FnOnce(Option<Vec<FormField>>) + 'static,
) -> Result<InstanceId, crate::err::Error> {
    let spec = dialog(
        title,
        content,
        vec![
            dialog_button("cancel", "Cancel", ButtonRole::Cancel),
            dialog_button("ok", ok_label, ButtonRole::Accept),
        ],
    );
    open_dialog_with(&spec, move |out| {
        if out.button.as_deref() == Some("ok") {
            on_close(Some(out.values));
        } else {
            on_close(None);
        }
    })
}

/// The text value of a named form field.
pub fn field_text<'a>(values: &'a [FormField], name: &str) -> Option<&'a str> {
    values.iter().find(|f| f.name == name).and_then(|f| match &f.value {
        Value::Text(s) | Value::Color(s) => Some(s.as_str()),
        _ => None,
    })
}

/// Show a toast with one line. Returns its instance id.
pub fn toast(title: impl IntoText, message: impl IntoText, tone: Tone) -> InstanceId {
    raw::show_toast(&ToastSpec {
        title: Some(title.into_text()),
        lines: vec![ToastLine { text: message.into_text(), icon: None, progress: None, tone }],
        icon: None,
        tone,
        duration_ms: Some(4000),
        actions: Vec::new(),
    })
}
