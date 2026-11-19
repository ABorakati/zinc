# Agent skills for plugin authors

Zinc ships two skills for AI coding agents that write Zinc plugins. A skill is a folder with instructions (`SKILL.md`), reference pages and small scripts. The agent reads it when a task matches, so it follows the steps that work in this repository instead of guessing. The skills are written for Claude Code, and they work with any agent that reads `SKILL.md` folders.

| Skill | Use it to | Download |
| --- | --- | --- |
| `zinc-plugin-create` | Make a new plugin: scaffold, build, test, package | [zinc-plugin-create.zip](https://aborakati.github.io/zinc/skills/zinc-plugin-create.zip) |
| `zinc-plugin-port` | Check whether a Zotero plugin can run on Zinc, then port it | [zinc-plugin-port.zip](https://aborakati.github.io/zinc/skills/zinc-plugin-port.zip) |

The zips are built from [`.claude/skills/`](https://github.com/ABorakati/zinc/tree/main/.claude/skills) every time the website is built, so they match `main`.

## zinc-plugin-create

Makes a plugin from nothing. The agent:

1. Picks JavaScript or Rust, the smallest world, and the fewest permissions for what you asked for. JavaScript runs interpreted (QuickJS), so it suits glue code and small views; Rust suits plugins that compute.
2. Scaffolds the plugin with `scripts/scaffold.ts`. The `--with` option picks the parts: `menu`, `column`, `section`, `prefs`, `dialog`, `notifier`, `library`, `reader`, `net`, `toast` and `mcp` (a tool for AI agents). The script writes `manifest.json`, the Fluent strings and the entry file, and prints the world and permissions it chose.
3. Writes the logic from tested recipes (menus, columns, item pane sections, dialogs, preference panes, the notifier, library reads and writes, reader hooks, network, tools for AI agents).
4. Builds it (`plugin-api/sdk/js/scripts/build.ts` or `plugin-host/scripts/build-plugin.ts`).
5. Tests it with `scripts/smoke.ts`, which loads the plugin in the real runner with stub imports and calls its callbacks. No library and no running app are needed.
6. Packages it as a `.zplugin` with `scripts/pack.ts`.

For tools for AI agents, the skill uses the `plugin-mcp` world (or `plugin` when the plugin also adds menus or views), the `mcp.expose` permission, and `defineTool` (JavaScript) or `mcp::Tool` (Rust). It reminds you that the tools stay hidden until you turn on the plugin's switch in Settings > Plugins. See [Exposing tools to AI agents](mcp.md).

## zinc-plugin-port

Ports a Zotero 7 to 10 plugin (`bootstrap.js` and Firefox internals) to Zinc. The agent:

1. Gets the source (an `.xpi`, a repository or a release) into a scratch folder and runs `scripts/scan.ts`. The scan lists every Zotero, Firefox and DOM API the plugin uses, maps each to the Zinc call and the row of the parity tables, and marks it covered, partial or not planned.
2. Writes a go/no-go report per feature: what ports cleanly, what changes, what cannot be ported, the language, the permissions, and the licence. **It stops here until you have read the report.**
3. Rewrites the plugin by pattern (lifecycle, prefs, Fluent strings, menus, columns, item pane sections, the notifier, library and database access, HTTP, dialogs, the reader, files, timers, monkey-patching). A plugin that serves an HTTP route to other programs is offered MCP tools instead, where that fits.
4. Verifies the port on a throwaway core and a temporary library with `scripts/verify-port.ts`, and compares it feature by feature with the original.

A port is a derivative work: the skill keeps the original licence and notices, and refuses to copy code that has no licence.

## Install a skill

Unzip it into one of these folders. Each zip holds one folder named after the skill.

- `~/.claude/skills/` (on Windows `%USERPROFILE%\.claude\skills\`): the skill is available in every project.
- `.claude/skills/` inside a project: only in that project. A checkout of the Zinc repository already has both skills there.

```powershell
Expand-Archive zinc-plugin-create.zip -DestinationPath "$HOME\.claude\skills"
```

```bash
unzip zinc-plugin-create.zip -d ~/.claude/skills
```

Start a new Claude Code session so it picks up the skill. Then ask for what you want, for example "make a Zinc plugin that adds a column with the number of PDF pages" or "port the Zotero plugin at <link> to Zinc". The agent loads the matching skill by itself; you can also name it.

## What the skills need

- A checkout of the Zinc repository. The scripts look for it (the folder that holds `plugin-api/`) from the current folder, from `ZINC_ROOT`, or from `--zinc <path>`. They use its SDKs, its WIT files and its build scripts.
- [Bun](https://bun.sh). For Rust plugins, a Rust toolchain with the `wasm32-wasip2` target.
- For testing: the plugin runner `zhw` (`cd plugin-host-wasmtime && cargo build --release`) and `plugin-host/node_modules`.

The skills never touch your real library, your Zotero data folder or the ports of a running Zinc (23119, 23120). See [Writing a Zinc plugin](writing-a-plugin.md) for the same steps done by hand.
