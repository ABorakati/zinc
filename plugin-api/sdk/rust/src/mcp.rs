//! Tools for AI agents (`mcp.wit`; docs/developer-guide/wasm-plugins/mcp.md). Needs the cargo feature `mcp` (or `full`).
//!
//! ```ignore
//! use zinc_plugin::prelude::*;
//! use zinc_plugin::json::json;
//!
//! fn tools() -> Vec<Tool> {
//!     vec![Tool::new("count_tagged", "Count the items that have a tag.", json!({
//!         "type": "object", "properties": { "tag": { "type": "string" } }, "required": ["tag"]
//!     })).read_only()]
//! }
//!
//! impl Plugin for MyPlugin {
//!     fn startup(_: PluginData, _: Reason) -> Result<(), Error> { mcp::register_all(&tools()) }
//!     fn on_mcp_call(tool: String, args: String) -> Result<String, Error> {
//!         match tool.as_str() {
//!             "count_tagged" => { let a: Args = mcp::args(&args)?; mcp::ok(&json!({ "count": 3 })) }
//!             _ => Err(err::not_found(format!("no tool {tool}"))),
//!         }
//!     }
//! }
//! ```
//!
//! Tools can also be declared statically: copy [`manifest`] of the same list into manifest.json (`mcp`), so Settings > Plugins shows them
//! before the plugin runs. Both need the permission `mcp.expose`; agents see nothing until the user turns the plugin's switch on.

use crate::err::{self, Error};
use crate::host::mcp as raw;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

/// One tool, built with chained calls. Annotations default to MCP's: not read-only, destructive, not idempotent.
#[derive(Clone, Debug)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub output_schema: Option<Value>,
    pub read_only: bool,
    pub destructive: bool,
    pub idempotent: bool,
}

impl Tool {
    /// `name`: letters, digits, `_`, `-`, `.`; 1 to 48 characters. `input_schema`: a JSON Schema object.
    pub fn new(name: impl Into<String>, description: impl Into<String>, input_schema: Value) -> Self {
        Tool {
            name: name.into(),
            description: description.into(),
            input_schema,
            output_schema: None,
            read_only: false,
            destructive: true,
            idempotent: false,
        }
    }
    /// The tool changes nothing (also clears `destructive`).
    pub fn read_only(mut self) -> Self {
        self.read_only = true;
        self.destructive = false;
        self
    }
    /// Say whether the tool may delete or overwrite data. Tools that only add should say `false`.
    pub fn destructive(mut self, yes: bool) -> Self {
        self.destructive = yes;
        self
    }
    /// Calling again with the same arguments changes nothing more.
    pub fn idempotent(mut self) -> Self {
        self.idempotent = true;
        self
    }
    /// JSON Schema of the result, when it is an object with a fixed shape.
    pub fn output(mut self, schema: Value) -> Self {
        self.output_schema = Some(schema);
        self
    }

    /// The tool as `mcp.tool-def`.
    pub fn def(&self) -> raw::ToolDef {
        raw::ToolDef {
            name: self.name.clone(),
            description: self.description.clone(),
            input_schema: self.input_schema.to_string(),
            output_schema: self.output_schema.as_ref().map(Value::to_string),
            annotations: raw::ToolAnnotations {
                read_only: self.read_only,
                destructive: !self.read_only && self.destructive,
                idempotent: self.idempotent,
            },
        }
    }

    /// Offer this tool now (`mcp.register-tool`).
    pub fn register(&self) -> Result<(), Error> {
        raw::register_tool(&self.def())
    }
}

/// Offer every tool. Call it from `startup`.
pub fn register_all(tools: &[Tool]) -> Result<(), Error> {
    tools.iter().try_for_each(Tool::register)
}

/// The `mcp` block of manifest.json for these tools (static declaration).
pub fn manifest(tools: &[Tool]) -> Value {
    json!({
        "tools": tools.iter().map(|t| {
            let d = t.def();
            let mut o = json!({
                "name": d.name,
                "description": d.description,
                "input_schema": t.input_schema,
                "annotations": { "read_only": d.annotations.read_only, "destructive": d.annotations.destructive, "idempotent": d.annotations.idempotent },
            });
            if let Some(s) = &t.output_schema { o["output_schema"] = s.clone(); }
            o
        }).collect::<Vec<_>>()
    })
}

/// Parse the arguments JSON of `on_mcp_call` into your own type. A mismatch is `invalid-argument`.
pub fn args<T: DeserializeOwned>(json: &str) -> Result<T, Error> {
    serde_json::from_str(if json.is_empty() { "{}" } else { json }).map_err(|e| err::invalid(format!("arguments: {e}")))
}

/// Write a result as JSON text, for `on_mcp_call` to return.
pub fn ok<T: Serialize>(value: &T) -> Result<String, Error> {
    serde_json::to_string(value).map_err(err::from_display)
}
