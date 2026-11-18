# Rules for the WASM plugin API agents, phase 1 (2026-11-18)

## Goal

Zinc gets its own plugin system: WebAssembly components with WIT interfaces. A plugin written for it must be able to do
everything a Zotero 7 plugin can do, including full UI customization. Phase 1 is DESIGN ONLY:

1. Find every capability a Zotero plugin has in your area (from Zotero's source, not from memory).
2. Write the WIT interface that gives a Zinc WASM plugin the same capability.
3. Write a parity table that maps each Zotero capability to your WIT, with a status.

Phase 2 (a later round, not now) builds the host. Do not write host code, TypeScript, Rust or tests in this phase.

## Five agents, one worktree

All five agents work at the same time in `C:\Users\abora\zotero-next\.claude\worktrees\wasm-plugins` (branch
`claude/wasm-plugins`, cut from `main`). Each agent owns files. Edit only your own files.

| Area | Owner files |
|---|---|
| `lifecycle` | `plugin-api/wit/types.wit`, `plugin-api/wit/world.wit`, `plugin-api/wit/lifecycle.wit`, `plugin-api/manifest.schema.json`, `docs/developer-guide/wasm-plugins/lifecycle.md`, `docs/developer-guide/wasm-plugins/README.md` |
| `library` | `plugin-api/wit/library.wit`, `docs/developer-guide/wasm-plugins/library.md` |
| `extend` | `plugin-api/wit/extend.wit`, `docs/developer-guide/wasm-plugins/extend.md` |
| `ui` | `plugin-api/wit/ui.wit`, `plugin-api/ui-schema/` (new folder), `docs/developer-guide/wasm-plugins/ui.md` |
| `reader` | `plugin-api/wit/reader.wit`, `docs/developer-guide/wasm-plugins/reader.md` |

- All WIT files are in one package: `package zinc:plugin@0.1.0;`. Each file holds one or more `interface` blocks.
- Shared types (item key, library id, error, JSON string alias, icon reference, localized string) go in `types.wit`.
  Only `lifecycle` edits it. If you need a shared type, define it locally in your own interface first, and list it under
  "Needs from other areas" in your report. The coordinator merges duplicates after phase 1.
- `world.wit` (owned by `lifecycle`) imports and exports the interfaces of all areas. Use these interface names so the world
  can reference them before your file is final: `lifecycle`, `library`, `notifier`, `prefs`, `extend`, `ui`, `reader`.
  You may add more interfaces in your own file; list their names in your report.
- If you need a change in a file you do not own, do not make it. Write it under "Needs from other areas".
- Never run git commands that change state (`commit`, `stash`, `checkout`, `reset`, `restore`, `clean`, `add`, `merge`,
  `rebase`). Read-only git is fine. The coordinator commits.

## Decisions already made (from the spike)

Read `C:\Users\abora\zotero-next\.claude\worktrees\wasm-plugin-spike-b1f662\docs\developer-guide\wasm-plugins-spike.md` and
the spike's WIT at `...\wasm-plugin-spike-b1f662\spikes\wasm-plugins\wit\plugin.wit`. In short:

- Plugins are WebAssembly components (the component model, WIT interfaces), run by jco under Bun.
- All plugins run in one separate "plugin host" process, one Worker per plugin. A hung plugin is handled by killing and
  restarting that process. So every host call crosses a process boundary: design for few, coarse calls (batch reads, return
  lists, no per-row callbacks in hot paths such as item tree cell rendering; prefer declarative data the host renders).
- Host imports can be async (JSPI). A plugin can await a host call.
- Plugins get no WASI: no files, no network, no clock, no env except what Zinc's own interfaces give. If Zotero gives a
  plugin a capability (HTTP, files, timers), design a Zinc interface for it, gated by a permission declared in the manifest.
- Guests are written in Rust or JS (QuickJS). Keep the WIT easy to use from both: plain records, variants, lists, options,
  results; `resource` types only where a handle with a lifetime is really needed.
- Plugin UI is declarative: the plugin returns a UI tree (data), the host renders it with Zinc's own components and theme.
  The plugin never touches a DOM. Events come back to the plugin as calls with an id. This is how "full UI customization" is
  reached: through a rich enough component set and extension points, not raw DOM access.

## Sources of truth

- Zotero's source (sparse, shallow, current main): `C:\Users\abora\AppData\Local\Temp\zotero-src`. Read-only. Add paths with
  `git -C <that dir> sparse-checkout add --no-cone <path>`. Key paths: `chrome/content/zotero/xpcom/pluginAPI/`,
  `chrome/content/zotero/elements/`, `chrome/content/zotero/xpcom/reader.js`, `xpcom/notifier.js`, `xpcom/prefs.js`,
  `xpcom/plugins.js`, `xpcom/data/`, `xpcom/search.js`, `zoteroPane.js`, `tabs.js`, `contextPane.js`, `itemTree.jsx`,
  `collectionTree.jsx`. Sparse-add more (for example `chrome/content/zotero/xpcom/data`, `xpcom/translation`) as you need.
- Zotero 7 developer docs: https://www.zotero.org/support/dev/zotero_7_for_developers ; `windingwind/zotero-plugin-toolkit`
  and `windingwind/zotero-types` on GitHub (what real plugins use in practice).
- Zinc's Zotero-compat layer (a different, JS-sandbox approach; useful as a map of what Zinc already exposes and how):
  `C:\Users\abora\zotero-next\.claude\worktrees\zotero-plugins\gpui-ui\src\plugins\` and its doc
  `...\zotero-plugins\docs\developer-guide\zotero-plugins.md`. Read-only.
- Zinc itself, in your worktree: `gpui-ui/src/` (the UI: `itempane/`, `table/`, `sidebar/`, `reader/` including
  `reader/plugins.ts`, `settings/`, `shell/`, `ui/`, `theme.ts`), `core/` (the local server; `core/schema.sql`), and
  `docs/developer-guide/http-api.md`, `architecture.md`, `database.md`.

## Checking your WIT

From the worktree root:

```bash
bunx @bytecodealliance/jco types plugin-api/wit --world-name plugin -o "$TEMP/zn-wit-check-<area>"
```

It parses the whole package, so another agent's half-finished file can break it. If the error is in a file you do not
own, check your own file alone: copy it with a minimal `world` into `$TEMP/zn-wit-check-<area>-solo/` and run the same
command there. Fix only errors in your own files.

## Safety

- Never open or write `data/library.sqlite`, `C:\Users\abora\Zotero\*`, or anything on ports 23119 / 23120.
- Bun only: `bun`, `bunx`. No node, npm or npx. No `cargo` in this phase.
- Disk C: is nearly full. Do not run `bun install` in the worktree. Write scratch output only under `%TEMP%`.
- No pushes, no network posts. Reading web pages and downloading Zotero's own source from github.com/zotero is fine.

## Report

Write `docs/developer-guide/wasm-plugins/<area>.md`:

1. Parity table. One row per Zotero API / element / event / option in your area, found in Zotero's source. Columns: Zotero
   capability (with source file), Zinc WIT (interface.function or type), status `covered` / `partial` (say what is missing)
   / `not planned` (say why: what in Zinc's design makes it impossible or unwise, and what a plugin should do instead).
2. Design notes: the main choices in your WIT and why (process boundary, batching, permissions, Rust/JS ergonomics).
3. Open questions for the user.
4. Needs from other areas.

Your final message: three lines. Line 1: counts of covered / partial / not planned. Line 2: WIT check result. Line 3: the
report path.
