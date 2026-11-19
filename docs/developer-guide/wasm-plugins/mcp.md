# Plugin tools for AI agents (MCP)

A plugin can offer tools to AI agents through Zinc's MCP server. The WIT is `plugin-api/wit/mcp.wit` (interfaces `mcp` and `mcp-handler`), the world
for a plugin that does only this is `plugin-mcp` (`plugin-library` plus mcp); the `plugin` world has both too. The sample is
`plugin-api/samples/mcp-tools`.

## What an agent sees

- Tool name `<plugin-short-name>__<tool>`: the short name is the part of the manifest id before `@` (a GUID id uses the plugin name), lower-cased to `[a-z0-9_-]`, at most
  64 characters in all, unique among plugins and never the name of a library tool (a clash gets `_2`).
- Description `[<plugin name>] <your description>`.
- The input schema you wrote, annotations `readOnlyHint`, `destructiveHint`, `idempotentHint` (and `openWorldHint: false`), and your output schema if any.
- Only on the HTTP endpoint of the running app (`http://127.0.0.1:<port>/mcp`), never over stdio.

## Consent (both are required)

1. The manifest permission `mcp.expose` (medium risk). The mcp calls return `permission-denied("mcp.expose")` without it, and the app's bridge never lists a plugin whose grant lacks it
   (the user can revoke it).
2. The user's switch for the plugin in Settings > Plugins ("Offer <plugin>'s tools to AI agents"), **off by default**, stored as `shell.wasmPluginMcp` in ui-state.json.

A plugin that is not `running` (stopped, disabled, failed, not yet activated) offers nothing. With the switch off the plugin's calls still succeed.

## Declaring tools

Statically, in manifest.json (`mcp.tools`; Settings > Plugins counts them before the plugin runs; they are served as soon as the plugin runs):

```json
"permissions": { "capabilities": ["library.read", "mcp.expose"] },
"mcp": { "tools": [ { "name": "count_tagged", "description": "...", "input_schema": { "type": "object", "properties": { "tag": { "type": "string" } }, "required": ["tag"] },
                      "annotations": { "read_only": true, "idempotent": true } } ] }
```

At run time, `mcp.register-tool(tool-def)` / `unregister-tool(name)` / `list-tools()` (for tools that depend on state). A run-time tool with a manifest tool's name replaces it;
`unregister-tool` also removes a manifest tool until the plugin restarts. At most 64 tools per plugin. Registrations are dropped when the plugin stops, is disabled or the host restarts; register again in `startup`.

Tool names: `[A-Za-z0-9_.-]`, 1 to 48. Description up to 4000 characters. Schemas: JSON objects (`type` "object" or absent), up to 64 KiB, checked by Ajv at registration.
Annotations: MCP defaults are "not read-only, destructive, not idempotent". Say `destructive: false` for tools that only add.

## Calls

`tools/call` -> core checks the arguments against the input schema (a mismatch is a tool error, the plugin never runs) -> provider -> `supervisor.call(pluginId, "mcp-handler", "on-mcp-call", [tool, argsJson])`
with the normal per-call limit, queued behind the plugin's other calls, with the plugin's own permissions -> the JSON text you return. A `result::err` or a trap/timeout is an MCP tool error with the message.
A result that is not JSON is shown as plain text. With an output schema the result must be a JSON object that matches; it is returned as `structuredContent`. Results over 100000 characters are cut.

## SDKs

JS (`plugin-api/sdk/js`): `defineTool({ name, description, input, output, annotations }, handler)`; `definePlugin({ tools })` writes `mcpHandler.onMcpCall` (handlers are synchronous; a plain Error becomes `internal`;
`fail("not-found", "...")` passes through); `registerTools(mcp, tools)` for run-time registration (pass `import mcp from "zinc:plugin/mcp@0.1.0"`); `mcpManifest(tools)` for the manifest block. Export `mcpHandler` next to the others.
Plugins written before this change need no edit: `sdk/js/scripts/build.ts` adds a default `mcpHandler` (no tools, `not-found`) to a `plugin` or `plugin-mcp` build that lacks one, and `definePlugin` fills it too.

Rust (`plugin-api/sdk/rust`): cargo feature `mcp` (world `plugin-mcp`; with extend/ui/reader use `full`). `mcp::Tool::new(..).read_only().destructive(false).idempotent().output(..)`, `mcp::register_all`, `mcp::manifest`,
`mcp::args::<T>(json)`, `mcp::ok(&value)`, and `Plugin::on_mcp_call` (default `not-found`). In the `full` world the default exists already.

## In the app

`gpui-ui/src/wasmplugins/mcp/`: `handler.ts` (the `where: "zinc"` handler of `zinc:plugin/mcp`, added in `collectZincHandlers`), `tools.ts` (checks, manifest reader, run-time registry),
`provider.ts` (`createToolProvider`, `installMcpBridge(sup)`: sets core's provider, clears registrations on stop/restart), `exposure.ts` (the switch). Core's side: `core/src/mcp/plugin-tools.ts`, `core/MCP.md`.

## Limits and notes

- No `notifications/tools/list_changed` over HTTP (stateless, POST only); long-lived connections get it when the provider's `onChange` fires. Clients re-list per request.
- The installer's JSON Schema checker ignores `if/then`, so "mcp.tools needs mcp.expose" is enforced by the bridge (it never lists a plugin without the grant), not at install.
- `fill()` in the JS SDK does not default variant fields: pass `scope: { tag: "all" }` in an `item-query`.
