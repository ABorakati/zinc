---
name: zinc-plugin-create
description: Create a new Zinc plugin from scratch. Zinc is a Zotero-compatible reference manager whose plugins are WebAssembly components written in JavaScript (QuickJS) or Rust. Use this skill whenever the user wants to make, start, scaffold, build, test or package a Zinc plugin, or to add anything to Zinc through a plugin, such as a menu entry or command, an item list column, an item pane section, a preferences pane, a dialog, a library-change listener, a reader toolbar button or annotation menu, or a plugin that calls a web API. Use it even if the user only says "add X to Zinc" and X is an extension point. Not for porting an existing Zotero (Firefox-style) plugin; use zinc-plugin-port for that.
---

# Creating a Zinc plugin

A Zinc plugin is a WebAssembly component that implements one **world** of the WIT package `zinc:plugin@0.1.0`. Zinc runs it in Wasmtime (precompiled at install), one instance per plugin, and the plugin can do only what its manifest permissions allow and the user grants. The plugin never touches a DOM: it registers extension points at startup and answers callbacks, and views are JSON UI trees.

Paths below are relative to the Zinc checkout (the folder holding `plugin-api/`). Scripts of this skill find it from the current directory, or from `ZINC_ROOT`/`--zinc`. Use Bun only (`bun`, `bunx`); never `bun install` in `gpui-ui/` or `core/`.

## Workflow

1. **Decide** (2 minutes): JS or Rust, which extension points, which world, which permissions. See "Decide" below.
2. **Scaffold** with the script, then edit the generated entry file:
   ```bash
   bun .claude/skills/zinc-plugin-create/scripts/scaffold.ts <dir> --id my-plugin@example.com --name "My Plugin" --lang js --with menu,section
   ```
   `--with` takes: `menu column section prefs dialog notifier library reader net toast`. The script writes `manifest.json`, `locale/en-US/plugin.ftl`, the entry file (`src/main.js` or `Cargo.toml` + `src/lib.rs`), picks the smallest world and the fewest permissions the parts need, and prints both. Put the plugin outside the Zinc tree (a scratch dir or its own repo); the script writes relative or absolute SDK paths as needed.
3. **Write the logic** with the recipes: `references/recipes-js.md` or `references/recipes-rust.md`. Every snippet there was built and run.
4. **Build**: `bun plugin-api/sdk/js/scripts/build.ts <dir> --out <out>` (JS, ~6 s) or `bun plugin-host/scripts/build-plugin.ts <dir> --out <out>` (Rust, ~40 s cold, ~15 s warm).
5. **Test** through the supervisor with stub imports: `bun .claude/skills/zinc-plugin-create/scripts/smoke.ts <out>` shows what startup registered; add `--call iface.fn '<json args>'` to drive callbacks, or copy `assets/plugin.test.ts` for assertions. UI trees are checked against `ui-tree.schema.json`. Details: `references/build-test-install.md`.
6. **Package**: `bun .claude/skills/zinc-plugin-create/scripts/pack.ts <out>` writes `<id>-<version>.zplugin`. Installing and in-app dev loading are in `references/build-test-install.md`.

If a build or test step fails for reasons outside the plugin (a missing `plugin-host/node_modules`, a `zhw` binary that is not built, an SDK that lags the WIT), say so and report it; do not patch `plugin-host/`, `plugin-host-wasmtime/` or the SDKs from a plugin task.

## Decide

**JS or Rust.** JS runs in QuickJS inside the component: the plugin's JS is interpreted, not JIT-compiled. That is fine for glue: register things, call imports, build small UI trees, react to events. It is slow for loops over thousands of items, text processing, parsing or hashing; call-time budgets (5 s per callback) count that time. Pick Rust when the plugin computes (full-text analysis, big lists, parsing) or needs the type checking. Pick JS for everything else: it builds in seconds, has no toolchain needs beyond Bun, and the SDK fills in record defaults for you. Both can use every world.

**World = the smallest that has what you use.** Each world is a subset of the next; a smaller world means fewer imports to link and, in Rust, a much faster compile.

| You use | World | Rust cargo feature |
|---|---|---|
| only prefs, l10n, log, timers | `plugin-core` | (none) |
| library, notifier | `plugin-library` | `library` |
| menus, columns, pref panes, toolbar, section registration | `plugin-extend` | `extend` |
| toasts (no dialog, no view) | `plugin-dialogs` | `dialogs` |
| item pane sections, dialogs (their close events arrive in `ui-events`), windows | `plugin-ui` | `ui` |
| reader listeners, annotations, note editor | `plugin-reader` | `reader` |
| tools for AI agents (MCP), with library access | `plugin-mcp` | `mcp` |
| reader plus UI, or net, fs, clipboard, shell, secrets | `plugin` | `full` |

Put the world in `manifest.json` `main.world` (JS: it is the componentize input; Rust: informational, but keep it true).

**Permissions = the fewest.** Registering menus, columns, sections, panes, dialogs, toasts, prefs and logging need none. Add only: `library.read` (reading items, and reading the selection from a callback context), `library.write` (`library.apply`), `library.trash`/`library.erase`, `library.fulltext.read`, `library.files.read`, `annotations.read`/`write`, `reader.ui` (reader toolbar and menus), `ui.windows` (tabs, side panels, extra windows), and `permissions.net.hosts` for each web host. Write a `permission_reasons` sentence for each: the install prompt shows it. Full table: `references/choose-and-manifest.md`.

## Recipe: tools for AI agents (MCP)

World `plugin-mcp` (Rust feature `mcp`; `full` also has it). Design: `docs/developer-guide/wasm-plugins/mcp.md`; working sample: `plugin-api/samples/mcp-tools` (JS).

- Manifest: capability `mcp.expose` (medium risk) with a `permission_reasons` sentence, plus whatever the tools themselves need (`library.read`, `library.write`). Optionally declare tools statically in `"mcp": {"tools": [{name, description, input_schema, output_schema?, annotations: {read_only, destructive, idempotent}}]}` so Settings > Plugins counts them before the plugin runs. `mcp.tools` without `mcp.expose` is invalid.
- Consent has two parts: the permission, and the user's per-plugin switch in Settings > Plugins ("Offer <plugin>'s tools to AI agents"), off by default. Agents see nothing until both hold and the plugin is running; they reach the tools only on the app's HTTP MCP endpoint. Tell the user to flip the switch when you hand the plugin over.
- JS: `defineTool({ name, description, input, output?, annotations }, handler)` with a JSON Schema `input` and a **synchronous** handler returning a JSON-able value; `definePlugin({ tools: [...] })` writes `mcpHandler.onMcpCall`, so export `mcpHandler` next to the other exports. Run-time tools: `registerTools(mcp, [tool])` in `startup` (`import mcp from "zinc:plugin/mcp@0.1.0"`); `mcpManifest(tools)` builds the static block. Fail with `fail("not-found", "...")`; it becomes a tool error with that message.
- Rust: `mcp::Tool::new(name, description, schema).read_only().destructive(false).idempotent().output(schema)`; `mcp::register_all(&tools())` in `startup`; implement `Plugin::on_mcp_call(tool, args_json) -> Result<String, Error>`, parse with `mcp::args::<T>(&args)` and answer with `mcp::ok(&value)`; `mcp::manifest` gives the manifest block. Unknown tool: `err::not_found`.
- Rules: tool name 1 to 48 of `[A-Za-z0-9_.-]` (agents see `<plugin>__<name>`), at most 64 tools, schemas are objects up to 64 KiB, results over 100000 characters are cut. Say `destructive: false` for add-only tools (MCP's default is destructive). Arguments are validated against `input` before your code runs. A call is a normal plugin call: queued with the others, time-limited, with the plugin's own permissions.
- Test with the `mcp-tools` section of `plugin-api/samples/test.ts`: switch off lists nothing, switch on lists the tools, calls return results, revoking `mcp.expose` removes them.

## Rules that save a debugging round

- Everything is registered in `lifecycle.startup`; Zinc removes it when the plugin stops. Rust state lives in `thread_local!`; JS state in module variables.
- A callback is one call into the plugin: one at a time per plugin, a time budget each. Do not block waiting for the user; open a dialog and continue in its close handler.
- JS: build records with the SDK helpers (`ext.*`, `ui.*`, `fill`). A record with a missing required field traps the plugin.
- Names in JS are camelCase, enums are strings, variants are `{ tag, val }`, `u64` is `BigInt`. In Rust the names are snake_case in `zinc_plugin::host::<interface>`.
- The full list of traps (u32 above 2^31, no `TextDecoder` in QuickJS, re-entrancy, time limits, dialog features) is in `references/pitfalls.md`. Read it before shipping.

## References

- `references/choose-and-manifest.md`: worlds, permission table, manifest fields, locale files, default prefs.
- `references/recipes-js.md` and `references/recipes-rust.md`: menus and commands, columns, item pane sections, dialogs, preferences and panes, notifier, library queries and writes, reader hooks, network, l10n, timers.
- `references/build-test-install.md`: build commands and output, supervisor testing, packaging, installing, dev loading.
- `references/pitfalls.md`: what broke in phases 2 and 3.
- Contract when you need more: `plugin-api/wit/*.wit` (doc comments are the spec), `plugin-api/manifest.schema.json`, `plugin-api/ui-schema/ui-tree.schema.json`, `docs/developer-guide/wasm-plugins/writing-a-plugin.md`, and the samples in `plugin-api/samples/`.
