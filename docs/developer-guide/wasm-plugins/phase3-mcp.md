# Phase 3: plugin MCP tools (report)

Design and how-to: [`mcp.md`](mcp.md). User side: `docs/user-guide/mcp.md` ("Tools from plugins"). Core side: `core/MCP.md` ("Plugin tools").

## Test results

| What | Result |
|---|---|
| `core`: `bun test test/mcp` (new `plugin-tools.test.ts`: fake provider, listing, naming, schema validation, errors, timeout, annotations, disabled/empty/throwing provider, output schema, `list_changed`, HTTP with the global provider) | 31 pass (14 new) |
| `gpui-ui`: `bun test src/wasmplugins/mcp` (handler, provider gating, bridge install and HTTP) | 10 pass |
| `plugin-api/sdk/js`: `bun test test` | 20 pass (6 new) |
| `bun check` in `core/`, `gpui-ui/`, `plugin-api/sdk/js/`, `plugin-host/` | clean |
| `jco types` for all 9 worlds (plugin, plugin-minimal, plugin-core, plugin-library, plugin-extend, plugin-ui, plugin-reader, plugin-dialogs, plugin-mcp) | all ok |
| `cargo build --target wasm32-wasip2` in `plugin-api/sdk/rust` with `--features full`, `mcp`, `library` | all build (the stable toolchain has the target; `cargo` is not on this shell's PATH) |
| `bun plugin-api/samples/test.ts` (word-count, quick-tags, mcp-tools, highlight-export) | PASS, 77 checks (mcp-tools section: 29) |

The `mcp-tools` section is end to end through the real chain: a throwaway core (a fresh fixture library in `%TEMP%`, started with `startServer` on a free port), the real MCP endpoint, the gpui-ui bridge, the real supervisor
and the real `library` host handlers talking to that core. It checks: switch off lists nothing and a call fails; switch on lists the manifest tool and the run-time tool with prefixed names, description prefix,
annotations and schemas; `count_tagged` returns `structuredContent` from the real library; invalid arguments are tool errors before the plugin runs; `add_tag` really writes the tag in the throwaway database;
a plugin `not-found` is a tool error with its message; switch off again; stop lists nothing; restart brings both tools back; revoking `mcp.expose` removes them.
The supervisor worked in this run.

## Files

New: `plugin-api/wit/mcp.wit`; `core/src/mcp/plugin-tools.ts`, `plugin-tools-server.ts`; `core/test/mcp/plugin-tools.test.ts`; `gpui-ui/src/wasmplugins/mcp/{tools,handler,provider,exposure}.ts`, `mcp.test.ts`;
`plugin-api/sdk/js/src/mcp.ts`; `plugin-api/sdk/rust/src/mcp.rs`; `plugin-api/samples/mcp-tools/{manifest.json,README.md,src/main.js}`; `docs/developer-guide/wasm-plugins/mcp.md`, this report.

Edited: `plugin-api/wit/world.wit`; `plugin-api/manifest.schema.json`; the fixture copy `gpui-ui/src/wasmplugins/ui/test/fixture-ui-js/wit/deps/zinc-plugin/{mcp,world}.wit`;
`core/src/mcp/{server,http}.ts` (`createMcpServer(db, { pluginTools })`; http passes the global provider), `core/MCP.md`, `docs/user-guide/mcp.md`;
`gpui-ui/src/wasmplugins/{index,register}.ts`, `extend/settings.tsx` (per-plugin switch row); `plugin-api/sdk/js/{src/plugin.ts,src/index.ts,scripts/build.ts,template/src/main.js,test/sdk.test.ts}`;
`plugin-api/sdk/rust/{Cargo.toml,src/lib.rs,src/plugin.rs}`; `plugin-api/samples/test.ts`.

## WIT changes in full

`plugin-api/wit/mcp.wit` (new):

```wit
interface mcp {
  use types.{json, error};
  record tool-annotations { read-only: bool, destructive: bool, idempotent: bool }
  record tool-def {
    name: string,            // 1-48 of [A-Za-z0-9_.-]
    description: string,     // up to 4000
    input-schema: json,      // object schema, up to 64 KiB
    output-schema: option<json>,
    annotations: tool-annotations,
  }
  register-tool: func(tool: tool-def) -> result<_, error>;     // replaces a same-named tool; max 64 per plugin
  unregister-tool: func(name: string) -> result<_, error>;     // not-found if absent; also removes a manifest tool until restart
  list-tools: func() -> list<tool-def>;                        // manifest tools, then run-time ones
}
interface mcp-handler {
  use types.{json, error};
  on-mcp-call: func(tool: string, args: json) -> result<json, error>;
}
```

(Doc comments in the file carry the full rules.) `world.wit`:

- `world plugin`: added `import mcp;` and `export mcp-handler;`.
- New `world plugin-mcp { include plugin-library; import mcp; export mcp-handler; }`.
- The `plugin-minimal` comment lists the new interfaces; no other world changed.

Default `mcp-handler` so that nothing built against `plugin` has to opt in: the JS SDK (`definePlugin` fallback and `build.ts`, which appends a default `mcpHandler` export to a `plugin` or `plugin-mcp` bundle that
lacks one) and the Rust SDK (`Plugin::on_mcp_call` default, implemented by `Glue` whenever the world has `mcp-handler`) list no tools and answer calls with `not-found`. Verified: the three existing samples build and pass unchanged.

Manifest schema: capability `mcp.expose` (examples and `x-risk.medium`, 37 ids), top-level `mcp.tools` (`$defs.mcpTool`: `name`, `description`, `input_schema`, `output_schema`, `annotations.read_only/destructive/idempotent`),
world enum gains `plugin-mcp`, and an `if/then` that `mcp.tools` requires `mcp.expose`.

## Needs from other areas

1. `plugin-host/test/pkg/units.test.ts` line ~134: `expect(KNOWN_CAPABILITIES.length).toBe(36)` becomes `37` (the schema list gained `mcp.expose`; the test will fail until then).
2. `plugin-host/src/manifest.ts`: add `"plugin-mcp"` to the `PluginWorld` union (type only).
3. `plugin-host/src/package/json-schema.ts` ignores `if/then/contains`, so the schema rule "mcp.tools needs mcp.expose" is not enforced at install. Either add those keywords, or a rule in `package/validate.ts`. The bridge is safe
   meanwhile (it never lists a plugin without the grant).
4. The other WIT copies (`plugin-host/test/fixtures/*/wit`, `plugin-host/test/pkg/fixtures/e2e-js/wit`, `gpui-ui/test/wasm-extend-fixture/wit`) were not touched; refresh them when their owners next sync the WIT. They still build (older `plugin` world).
5. Done (2026-11-19): the skills (`.claude/skills/zinc-plugin-*`) cover `plugin-mcp`, `defineTool`, `mcp::Tool` and the `mcp.expose` permission (SKILL.md, `choose-and-manifest.md`, the JS and Rust recipes, the port skill's rules), and `scaffold.ts --with mcp` writes a working tool in JS or Rust. They are published as zips: [agent-skills.md](agent-skills.md).

## What is left / notes

- No `notifications/tools/list_changed` over HTTP: stateless and POST-only, so impossible without sessions and a GET stream. Long-lived connections (in-memory, a future SSE) get it via `provider.onChange` (tested).
- The settings row is not covered by a screenshot test (no window); `bun check` and the toggle's store (`exposure.ts`) are exercised through the provider tests. Static tools only are counted in the row's description.
- Core wraps the MCP SDK's private `_requestHandlers` map to add JSON-Schema tools (McpServer only accepts zod). A test fails first if an SDK upgrade moves it.
- `fill()` in the JS SDK does not default variant fields (`item-query.scope`): the sample passes `scope: { tag: "all" }`. A trap in the guest was the symptom.
- A Rust version of the sample was not written; the Rust SDK compiles with the `mcp` feature but has no end-to-end test.
- One test run of `samples/test.ts` showed a transient field-order mismatch in quick-tags (`{kind,name}` vs `{name,kind}`); it passed in the next runs. It is outside this change (another agent was editing `sdk/js/src/ui.ts` and `defaults.ts` at the time).
- Housekeeping: early on I ran an edit with the wrong working directory against the MAIN checkout's `core/src/mcp/server.ts` and reverted it at once with `git apply -R` (content identical to HEAD; `git status` there still lists the file as stat-modified because of line endings). No other file in the main checkout was touched.
