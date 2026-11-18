//! UI trees. The WIT form is a flat node list with child indices; you write a nested expression and
//! [`El::into_tree`] flattens it.
//!
//! ```ignore
//! use zinc_plugin::ui::*;
//! let view = column().gap(2).padding(3)
//!     .child(heading("Word count"))
//!     .child(text("1,204 words").key("count"))
//!     .child(button("Refresh").on(EventKind::Press, "refresh"));
//! // a RenderResult for mount / on-event:
//! let result = render(view);
//! ```

use crate::host::types::{Color, IconRef, LocalizedString};
use crate::text::{plain, IntoText};

pub use crate::host::ui::{
    self as raw, Align, ButtonLook, ButtonRole, ControlSize, DialogOutcome, DialogSpec, Direction, EventKind, FontSize,
    FontWeight, FormField, InstanceId, Justify, Node, NodeKind, NodeProps, RenderResult, Space, Style, TextKind,
    Tone, Tree, UiEvent, Value, ViewContext,
};
use crate::host::ui::{
    A11y, BadgeSpec, ButtonSpec, CalloutSpec, CheckboxSpec, Choice, ContentUpdate, DialogButton, Dim, EventBinding,
    FormSpec, GroupSpec, ProgressLook, ProgressSpec, SectionSpec, SelectSpec, SeparatorSpec, TextInputKind,
    TextInputLook, TextInputSpec, TextRun, TextSpec, ToastLine, ToastSpec, MenuMode, Orientation,
};

/// A `style` with every field unset.
pub fn style() -> Style {
    Style {
        direction: None,
        wrap: None,
        align_items: None,
        justify_content: None,
        gap: None,
        align_self: None,
        flex_grow: None,
        flex_shrink: None,
        flex_basis: None,
        width: None,
        height: None,
        min_width: None,
        min_height: None,
        max_width: None,
        max_height: None,
        aspect_ratio: None,
        padding: None,
        margin: None,
        overflow: None,
        position: None,
        inset: None,
        z_index: None,
        grid_column: None,
        grid_row: None,
        background: None,
        foreground: None,
        border: None,
        border_top: None,
        border_bottom: None,
        border_start: None,
        border_end: None,
        radius: None,
        opacity: None,
        shadow: None,
        cursor: None,
        font_size: None,
        font_family: None,
        font_weight: None,
        italic: None,
        underline: None,
        strike: None,
        line_height: None,
        text_align: None,
        text_wrap: None,
        max_lines: None,
    }
}

fn props() -> NodeProps {
    NodeProps {
        key: None,
        name: None,
        pref: None,
        class: Vec::new(),
        style: style(),
        states: None,
        events: Vec::new(),
        a11y: A11y { role: None, label: None, description: None, live: None, hidden: false, tab_index: None },
        tooltip: None,
        context_menu: None,
        disabled: false,
        hidden: false,
        draggable: None,
        drop_target: None,
        auto_focus: false,
        test_id: None,
    }
}

fn edges(step: u8) -> crate::host::ui::Edges {
    let s = Some(Space::Step(step));
    crate::host::ui::Edges { top: s, end: s, bottom: s, start: s }
}

/// One element of a tree, with its children nested.
pub struct El {
    props: NodeProps,
    kind: NodeKind,
    children: Vec<El>,
}

impl El {
    pub fn new(kind: NodeKind) -> El {
        El { props: props(), kind, children: Vec::new() }
    }
    /// Stable identity: needed for patches, host-kept state (typed text, scroll), focus and events that name a node.
    pub fn key(mut self, k: &str) -> El {
        self.props.key = Some(k.into());
        self
    }
    /// Form field name (read back from `form-values` and `dialog-outcome.values`).
    pub fn name(mut self, n: &str) -> El {
        self.props.name = Some(n.into());
        self
    }
    /// Bind a control's value to one of the plugin's own preferences.
    pub fn pref(mut self, p: &str) -> El {
        self.props.pref = Some(p.into());
        self
    }
    pub fn tooltip(mut self, t: impl IntoText) -> El {
        self.props.tooltip = Some(t.into_text());
        self
    }
    pub fn disabled(mut self, d: bool) -> El {
        self.props.disabled = d;
        self
    }
    pub fn hidden(mut self, h: bool) -> El {
        self.props.hidden = h;
        self
    }
    pub fn test_id(mut self, id: &str) -> El {
        self.props.test_id = Some(id.into());
        self
    }
    /// Send `event` to the plugin's `on-ui-event` with `handler` as the handler id.
    pub fn on(mut self, event: EventKind, handler: &str) -> El {
        self.props.events.push(EventBinding {
            event,
            handler: handler.into(),
            debounce_ms: None,
            throttle_ms: None,
            keys: Vec::new(),
            prevent_default: false,
            stop_propagation: false,
        });
        self
    }
    /// Change the style in place: `.style_with(|s| s.gap = Some(Space::Step(2)))`.
    pub fn style_with(mut self, f: impl FnOnce(&mut Style)) -> El {
        f(&mut self.props.style);
        self
    }
    /// Spacing between children, in steps of the spacing scale (n * 4 px).
    pub fn gap(self, step: u8) -> El {
        self.style_with(|s| s.gap = Some(Space::Step(step)))
    }
    pub fn padding(self, step: u8) -> El {
        self.style_with(|s| s.padding = Some(edges(step)))
    }
    pub fn margin(self, step: u8) -> El {
        self.style_with(|s| s.margin = Some(edges(step)))
    }
    /// Take the remaining space.
    pub fn grow(self) -> El {
        self.style_with(|s| s.flex_grow = Some(1.0))
    }
    pub fn width_px(self, px: f32) -> El {
        self.style_with(|s| s.width = Some(Dim::Px(px)))
    }
    pub fn fill_width(self) -> El {
        self.style_with(|s| s.width = Some(Dim::Fill))
    }
    pub fn align(self, a: Align) -> El {
        self.style_with(|s| s.align_items = Some(a))
    }
    pub fn justify(self, j: Justify) -> El {
        self.style_with(|s| s.justify_content = Some(j))
    }
    pub fn color(self, c: Color) -> El {
        self.style_with(|s| s.foreground = Some(c))
    }
    pub fn background(self, c: Color) -> El {
        self.style_with(|s| s.background = Some(c))
    }
    pub fn child(mut self, c: El) -> El {
        self.children.push(c);
        self
    }
    pub fn children(mut self, cs: impl IntoIterator<Item = El>) -> El {
        self.children.extend(cs);
        self
    }

    /// Flatten into the WIT `tree` (revision 0; use [`El::into_tree_rev`] to count up).
    pub fn into_tree(self) -> Tree {
        self.into_tree_rev(0)
    }
    pub fn into_tree_rev(self, rev: u64) -> Tree {
        let mut nodes = Vec::new();
        push_node(self, &mut nodes);
        Tree { rev, root: 0, nodes, styles: Vec::new() }
    }
}

fn push_node(el: El, out: &mut Vec<Node>) -> u32 {
    let idx = out.len() as u32;
    // reserve the slot so the parent index comes before its children
    out.push(Node { props: el.props, kind: el.kind, children: Vec::new() });
    let kids: Vec<u32> = el.children.into_iter().map(|c| push_node(c, out)).collect();
    out[idx as usize].children = kids;
    idx
}

impl From<El> for Tree {
    fn from(e: El) -> Tree {
        e.into_tree()
    }
}

// ---- containers -------------------------------------------------------------------------------------------------

/// A vertical stack.
pub fn column() -> El {
    El::new(NodeKind::Box_).style_with(|s| s.direction = Some(Direction::Column))
}
/// A horizontal row.
pub fn row() -> El {
    El::new(NodeKind::Box_).style_with(|s| s.direction = Some(Direction::Row))
}
pub fn boxed() -> El {
    El::new(NodeKind::Box_)
}
pub fn card() -> El {
    El::new(NodeKind::Card)
}
pub fn spacer() -> El {
    El::new(NodeKind::Spacer)
}
pub fn separator() -> El {
    El::new(NodeKind::Separator(SeparatorSpec { orientation: Orientation::Horizontal }))
}
pub fn group(caption: impl IntoText) -> El {
    El::new(NodeKind::Group(GroupSpec { caption: Some(caption.into_text()) }))
}
/// A collapsible section (as in the item pane).
pub fn section(title: impl IntoText) -> El {
    El::new(NodeKind::Section(SectionSpec {
        title: title.into_text(),
        icon: None,
        open: None,
        summary: None,
        count: None,
        buttons: Vec::new(),
        persist_key: None,
    }))
}
/// A form: a `submit` button inside it sends `submit` with the values of all named fields.
pub fn form() -> El {
    El::new(NodeKind::Form(FormSpec { busy: false }))
}

// ---- content ----------------------------------------------------------------------------------------------------

fn run(text: LocalizedString) -> TextRun {
    TextRun {
        text,
        bold: false,
        italic: false,
        underline: false,
        strike: false,
        mono: false,
        color: None,
        size: None,
        link: None,
    }
}
fn text_of(kind: TextKind, t: LocalizedString) -> El {
    El::new(NodeKind::Text(TextSpec { kind, runs: vec![run(t)], selectable: false }))
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
    El::new(NodeKind::Callout(CalloutSpec {
        tone,
        title: None,
        message: Some(message.into_text()),
        icon: None,
        dismissible: false,
    }))
}
pub fn badge(label: impl IntoText, tone: Tone) -> El {
    El::new(NodeKind::Badge(BadgeSpec { label: label.into_text(), tone, color: None, icon: None, removable: false }))
}
/// `value` in 0..=1, or `None` for indeterminate.
pub fn progress(value: Option<f32>) -> El {
    El::new(NodeKind::Progress(ProgressSpec { value, look: ProgressLook::Bar, label: None }))
}

// ---- controls ---------------------------------------------------------------------------------------------------

pub fn button(label: impl IntoText) -> El {
    El::new(NodeKind::Button(ButtonSpec {
        label: Some(label.into_text()),
        icon: None,
        look: ButtonLook::Standard,
        size: ControlSize::Md,
        pressed: None,
        loading: false,
        menu: None,
        menu_mode: MenuMode::Dropdown,
        submit: false,
    }))
}
/// A primary button that submits its form.
pub fn submit_button(label: impl IntoText) -> El {
    let mut b = button(label);
    if let NodeKind::Button(s) = &mut b.kind {
        s.look = ButtonLook::Primary;
        s.submit = true;
    }
    b
}
pub fn text_input(value: &str) -> El {
    El::new(NodeKind::TextInput(TextInputSpec {
        value: value.into(),
        placeholder: None,
        kind: TextInputKind::Text,
        look: TextInputLook::Field,
        multiline: false,
        min_rows: None,
        max_rows: None,
        max_length: None,
        read_only: false,
        select_on_focus: false,
        clear_button: false,
        spellcheck: false,
        prefix_icon: None,
        suggest: None,
    }))
}
pub fn checkbox(label: impl IntoText, checked: bool) -> El {
    El::new(NodeKind::Checkbox(CheckboxSpec { label: Some(label.into_text()), checked, indeterminate: false }))
}
/// `options`: (value, label) pairs.
pub fn select(options: &[(&str, &str)], value: Option<&str>) -> El {
    El::new(NodeKind::Select(SelectSpec {
        options: options
            .iter()
            .map(|(v, l)| Choice {
                value: (*v).into(),
                label: plain(*l),
                icon: None,
                description: None,
                disabled: false,
                group: None,
            })
            .collect(),
        value: value.map(Into::into),
        placeholder: None,
        multiple: false,
        values: Vec::new(),
        searchable: false,
    }))
}

impl El {
    pub fn placeholder(mut self, t: impl IntoText) -> El {
        if let NodeKind::TextInput(s) = &mut self.kind {
            s.placeholder = Some(t.into_text());
        }
        self
    }
    pub fn multiline(mut self, min_rows: u8) -> El {
        if let NodeKind::TextInput(s) = &mut self.kind {
            s.multiline = true;
            s.min_rows = Some(min_rows);
        }
        self
    }
    pub fn auto_focus(mut self) -> El {
        self.props.auto_focus = true;
        self
    }
    pub fn look(mut self, l: ButtonLook) -> El {
        if let NodeKind::Button(s) = &mut self.kind {
            s.look = l;
        }
        self
    }
    pub fn icon(mut self, name: &str) -> El {
        let i = Some(IconRef::Builtin(name.into()));
        match &mut self.kind {
            NodeKind::Button(s) => s.icon = i,
            NodeKind::Section(s) => s.icon = i,
            NodeKind::Callout(s) => s.icon = i,
            NodeKind::Badge(s) => s.icon = i,
            _ => {}
        }
        self
    }
    /// Section: open or closed by default.
    pub fn open(mut self, open: bool) -> El {
        if let NodeKind::Section(s) = &mut self.kind {
            s.open = Some(open);
        }
        self
    }
    pub fn title(mut self, t: impl IntoText) -> El {
        if let NodeKind::Callout(s) = &mut self.kind {
            s.title = Some(t.into_text());
        }
        self
    }
}

// ---- results ----------------------------------------------------------------------------------------------------

/// The whole tree as the answer to `mount` / `update-context` / `on-event`.
pub fn render(root: El) -> RenderResult {
    RenderResult { content: ContentUpdate::Full(root.into_tree()), meta: None, focus: None }
}
/// Same tree as last time: nothing to do.
pub fn unchanged() -> RenderResult {
    RenderResult { content: ContentUpdate::Unchanged, meta: None, focus: None }
}
/// A tree in the nested JSON form (`ui-schema/ui-tree.schema.json`).
pub fn render_json(json: impl Into<String>) -> RenderResult {
    RenderResult { content: ContentUpdate::Json(json.into()), meta: None, focus: None }
}

// ---- dialogs, toasts, form values ---------------------------------------------------------------------------------

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

/// A modal dialog with `content` and the given buttons.
pub fn dialog(title: impl IntoText, content: El, buttons: Vec<DialogButton>) -> DialogSpec {
    DialogSpec {
        title: title.into_text(),
        icon: None,
        content: content.into_tree(),
        buttons,
        width: Some(420.0),
        height: None,
        resizable: false,
        modal: true,
        dismiss_on_escape: true,
    }
}

/// OK / Cancel dialog: returns the form values if the user pressed OK, `None` if cancelled.
pub fn ask(title: impl IntoText, content: El, ok_label: impl IntoText) -> Result<Option<Vec<FormField>>, crate::err::Error> {
    let spec = dialog(
        title,
        content,
        vec![dialog_button("cancel", "Cancel", ButtonRole::Cancel), dialog_button("ok", ok_label, ButtonRole::Accept)],
    );
    let out = raw::run_dialog(&spec)?;
    Ok(if out.button.as_deref() == Some("ok") { Some(out.values) } else { None })
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
