//! Localized strings: `plain("Save")` or a Fluent message of the plugin: `l10n("saved").arg_int("count", 3).fallback("Saved")`.

use crate::host::types::{L10nArg, L10nRef, LocalizedString, NameL10nArg};

pub fn plain(s: impl Into<String>) -> LocalizedString {
    LocalizedString::Plain(s.into())
}

pub fn l10n(id: impl Into<String>) -> L10nBuilder {
    L10nBuilder { id: id.into(), args: Vec::new(), fallback: None }
}

pub struct L10nBuilder {
    id: String,
    args: Vec<NameL10nArg>,
    fallback: Option<String>,
}

impl L10nBuilder {
    pub fn arg_text(mut self, name: &str, v: impl Into<String>) -> Self {
        self.args.push(NameL10nArg { name: name.into(), value: L10nArg::Text(v.into()) });
        self
    }
    pub fn arg_int(mut self, name: &str, v: i64) -> Self {
        self.args.push(NameL10nArg { name: name.into(), value: L10nArg::Integer(v) });
        self
    }
    pub fn arg_num(mut self, name: &str, v: f64) -> Self {
        self.args.push(NameL10nArg { name: name.into(), value: L10nArg::Number(v) });
        self
    }
    /// Shown if the plugin has no message with this id.
    pub fn fallback(mut self, s: impl Into<String>) -> Self {
        self.fallback = Some(s.into());
        self
    }
    pub fn build(self) -> LocalizedString {
        LocalizedString::Localized(L10nRef { id: self.id, args: self.args, fallback: self.fallback })
    }
}

/// Anything that is text for the user: `&str`, `String`, a `LocalizedString`, an `l10n(..)` builder.
pub trait IntoText {
    fn into_text(self) -> LocalizedString;
}
impl IntoText for &str {
    fn into_text(self) -> LocalizedString {
        plain(self)
    }
}
impl IntoText for String {
    fn into_text(self) -> LocalizedString {
        plain(self)
    }
}
impl IntoText for &String {
    fn into_text(self) -> LocalizedString {
        plain(self.as_str())
    }
}
impl IntoText for LocalizedString {
    fn into_text(self) -> LocalizedString {
        self
    }
}
impl IntoText for L10nBuilder {
    fn into_text(self) -> LocalizedString {
        self.build()
    }
}
