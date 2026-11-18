//! Small JSON helpers. `ViewContext.params`, `library.get-items` and annotation selectors are JSON strings; `serde_json`
//! is re-exported for anything bigger.

pub use serde_json;
pub use serde_json::{json, Value};

pub fn parse(s: &str) -> Option<Value> {
    serde_json::from_str(s).ok()
}

/// `{"itemKey": "ABCD1234"}` -> `string_field(json, "itemKey") == Some("ABCD1234")`.
pub fn string_field(json: &str, name: &str) -> Option<String> {
    parse(json)?.get(name)?.as_str().map(str::to_owned)
}

pub fn bool_field(json: &str, name: &str) -> Option<bool> {
    parse(json)?.get(name)?.as_bool()
}

pub fn i64_field(json: &str, name: &str) -> Option<i64> {
    parse(json)?.get(name)?.as_i64()
}

/// Escape text for HTML (notes are HTML).
pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}
