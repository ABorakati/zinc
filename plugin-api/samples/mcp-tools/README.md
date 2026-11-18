# mcp-tools (JavaScript / QuickJS)

Gives AI agents two tools through Zinc's MCP server (the HTTP endpoint of the running app).

| Tool (as an agent sees it) | Kind | Declared | What it does |
|---|---|---|---|
| `mcp-tools__count_tagged {tag}` | read-only, idempotent, has an output schema | statically, in `manifest.json` (`mcp.tools`) | `library.count-items` with the tag |
| `mcp-tools__add_tag {item, tag}` | not read-only, `destructive: false`, idempotent | at run time, `mcp.register-tool` in `startup` | `library.apply` with an `add-tags` change |

| Extension point | Where in the code |
|---|---|
| `mcp.register-tool` | `lifecycle.startup`, through `registerTools(mcp, [...])` of the SDK |
| `mcp-handler.on-mcp-call` | `definePlugin({ tools })` writes it: it looks the tool up by name and runs the handler |

Permissions: `library.read`, `library.write`, `mcp.expose`. Nothing is offered until the user turns on the plugin's switch in Settings > Plugins
(off by default). World: `plugin-mcp`. Build: `bun plugin-api/sdk/js/scripts/build.ts plugin-api/samples/mcp-tools`.
Guide: [`mcp.md`](../../../docs/developer-guide/wasm-plugins/mcp.md).
