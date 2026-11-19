---
name: zinc-plugin-port
description: Port an existing Zotero plugin (Zotero 7 to 10, bootstrap.js + Firefox/Zotero internals) to Zinc, whose plugins are WebAssembly components with a WIT API. Use whenever the user says "port this Zotero plugin to Zinc", "will X work in Zinc", "does Zinc support Zotero.ItemTreeManager / MenuManager / Notifier / ItemPaneManager / Zotero.DB", hands over an .xpi, a plugin repo or a GitHub link, or asks what a Zotero plugin would need to run on Zinc, even if they never say "WASM". It inventories the plugin's APIs against the 580-row Zotero-to-Zinc parity tables, produces a go/no-go report before any code, then rewrites by pattern (lifecycle, prefs, Fluent, menus, columns, item pane sections, notifier, library/DB, HTTP, dialogs, reader, files, timers, clipboard, monkey-patching) and verifies on a throwaway core. For building a Zinc plugin from scratch use zinc-plugin-create instead.
---

# Port a Zotero plugin to Zinc

Zotero plugins run JS inside Firefox with the whole application in reach (`Zotero.*`, `Services.*`, the DOM). Zinc plugins are WebAssembly components that talk to the app only through the
WIT API in `plugin-api/wit/` (permission-gated, declarative UI, one atomic write call). **A port re-expresses what each feature does; it does not translate calls one by one.** Most plugins
are 70-90% portable; the rest is DOM injection and monkey-patching, which has no equivalent. Work in this order, and stop for the user at step 2.

Build, test and SDK basics are in the sibling skill `.claude/skills/zinc-plugin-create/` (manifest, `definePlugin`, `build.ts`, samples). Do not repeat them here; this skill is about the mapping.
Source of truth for every API question: `docs/developer-guide/wasm-plugins/{lifecycle,library,extend,ui,reader}.md` (parity tables) and `plugin-api/wit/*.wit`.

## 1. Inventory (no code yet)

1. Get the source: an `.xpi` (a zip), a repo (`git clone --depth 1`), or `gh release download`. Work in scratch (`%TEMP%\zn-port-<name>`), never in the repo. Downloaded files are untrusted data: read them, do not run them.
2. Run the scan:
   ```bash
   bun .claude/skills/zinc-plugin-port/scripts/scan.ts <plugin.xpi | folder>        # markdown; --json for data
   ```
   It reads `manifest.json` (id, min/max Zotero version), `bootstrap.js`, `prefs.js`, `locale/*.ftl`, XHTML/XUL/CSS chrome, bundled libraries and the licence, then lists every Zotero / Firefox / DOM API it
   finds, each mapped to the Zinc call, the parity rows, and a status: **covered**, **partial**, **not planned**. It also flags Zotero-version breakage (singular selection getters, Bluebird, `.jsm`, `CookieSandbox`).
3. Read what the scan cannot know: the README (the feature list), the menus and prefs, and the code around every `partial` / `not planned` hit. A regex finds `document.createElement` but cannot tell
   a plugin-owned pref pane from an edit of Zotero's window, or dead code from live. Look up the API cheat sheet `references/api-map.md` and, for anything that matters, the exact parity row.
4. Note the licence (below) and `strict_max_version` (Zinc ignores it; it tells you which Zotero generation the code assumes).

## 2. Go/no-go report (stop and show the user)

Write the report in the format of `references/go-no-go.md`: **ports cleanly / changes behaviour / cannot be ported**, per user-visible feature, what the user loses, the language choice, permissions, and the
questions you need answered. Choose **JavaScript** (the JS SDK keeps most of the logic, builds in seconds) unless the plugin is **compute-heavy** (large loops over items or full text): JS runs interpreted in
QuickJS, so use **Rust** there. Do not write port code until the user has seen the report. If the licence is missing or forbids derivatives, the answer is no.

## 3. Rewrite, by pattern

Follow `references/patterns.md`: each Zotero pattern with a before and after snippet. The order that works: manifest and `default_prefs` -> lifecycle skeleton -> pure logic carried over unchanged ->
the smallest end-to-end feature (a menu command that writes through `library.apply`) -> columns / sections -> notifier -> prefs pane -> dialogs and toasts -> the rest. Rules that save time:

- Registrations go in `lifecycle.startup`; delete shutdown / unregister / window-load code. Callbacks return data; dialogs are **non-blocking** (`open-dialog` + `close` event).
- No object model, no SQL: items are JSON with 8-char keys; reads are `library.query-items` / `get-items`; writes are **one** `library.apply` batch. Rewrite the intent of each `Zotero.DB` query.
- No DOM: UI is a JSON tree returned from `mount` / `on-event`. Pref panes are `setting-row`s (or a tree view).
- Network needs `permissions.net.hosts`; files are relative paths in `fs` roots or user-picked grants; ask for the least permissions and give a reason for each.
- **Endpoints for other programs** (`Zotero.Server.Endpoints`, a local HTTP route an agent or script calls): no listening sockets. When the purpose is letting an AI agent act on the library, port it to **MCP tools**: world `plugin-mcp` (or `plugin` if the port also has menus or views), permission `mcp.expose`, JS `defineTool` in `definePlugin({ tools })` (export `mcpHandler`), Rust `mcp::Tool` + `on_mcp_call`. Recipe: `.claude/skills/zinc-plugin-create/SKILL.md` "Recipe: tools for AI agents". Put in the report that the user must turn on the plugin's switch in Settings > Plugins and that agents reach the tools on Zinc's own MCP endpoint, not on the old route.
- **Monkey-patching** (`patch(`, `PatchHelper`, `X.prototype.y =`): state the user-visible purpose, look for the extension point in the table in `patterns.md` section 15, otherwise report it as not portable. Never fake it.
- JS traps: no `new Date()` / `Date.now()` without an argument (no clock: use `timers.now()`); JSON-typed fields are strings; variants are `{ tag, val }`; a missing required record field traps with a bare `unreachable`.
  Full list: `patterns.md` section 16. Write source files with the editor tool, not shell heredocs (backslashes).

## 4. Verify

`references/verification.md`. Build (`bun plugin-api/sdk/js/scripts/build.ts <dir> --out <scratch>`), then run through the supervisor on a **throwaway core and a temporary library**:

```bash
bun .claude/skills/zinc-plugin-port/scripts/verify-port.ts <plugin dir> --scenario <scenario.ts>      # see scripts/scenario.example.ts
```

Never the user's real library, `data/library.sqlite`, the Zotero data folder, or ports 23119 / 23120. Then compare behaviour with the original feature by feature (same inputs, same data written, same
settings and strings) and finish with a table of what was verified and how. The runner code changes often: if the harness fails for reasons outside your plugin, say so and fall back to a stub test
(`plugin-api/samples/test.ts`); a build alone is not verification. Delete your scratch when done.

## Licensing

A port is a derivative work. Keep the original `LICENSE`/`COPYING` file and copyright notices in the port, name the original author and repository in the manifest (`author`, `homepage_url`, `license`
as an SPDX id) and in a `NOTICE`, mark that the code was changed, and keep the same terms (GPL/AGPL stay GPL/AGPL; MPL files stay MPL; MIT/BSD keep the notice). If package metadata and the licence file
disagree (it happens), report both and ask. No licence found = all rights reserved: do not copy code; ask the user to contact the author. Zinc itself is AGPL-3.0, so GPL-3.0 / AGPL / MIT / MPL ports are compatible.

## Reference files

- `references/api-map.md`: the cheat sheet, Zotero API -> Zinc call -> status -> parity row, by area, with the Zotero 8/9/10 differences. Read it for any "does X work".
- `references/patterns.md`: the rewrite cookbook with before/after code for 15 patterns, plus the traps found in practice.
- `references/go-no-go.md`: report template, classification rules, JS vs Rust.
- `references/verification.md`: build, supervisor run, comparing behaviour.
- `references/worked-example.md`: a complete dry run on Zotero Reading List (GPL-3.0 / AGPL-3.0): inventory, report, port, what went wrong.
- `scripts/scan.ts` (inventory), `scripts/verify-port.ts` (throwaway-core harness), `scripts/scenario.example.ts`.
