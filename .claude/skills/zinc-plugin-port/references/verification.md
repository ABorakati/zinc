# Verifying a port

Three levels, cheapest first. Do all three for a port you hand over; say which ones you could not run and why.

## 1. Build

```bash
bun plugin-api/sdk/js/scripts/build.ts   <plugin dir> --out "$TEMP/zn-port/<name>"        # JS (QuickJS)
bun plugin-host/scripts/build-plugin.ts  <plugin dir> --out "$TEMP/zn-port/<name>"        # Rust (wasm32-wasip2)
```

Output: `manifest.json` (with the sha256 added), `plugin.wasm`, `locale/`. Needs `plugin-host/node_modules` for JS. Never `bun install` in `gpui-ui/` or `core/`. JS plugin source may
live outside the repo (scratch): import the SDK by absolute path (`import { definePlugin, ext } from "C:/.../plugin-api/sdk/js/src/index.ts"`); `build.ts` bundles it in.
A syntax error or a missing field shows up here only partly: a record with a required field missing builds fine and **traps at the call** (see `patterns.md`, Traps).

## 2. Run through the supervisor, on a throwaway core

`scripts/verify-port.ts` (in this skill) builds the plugin, starts **its own** core on a free port over a **temporary library** (core's test fixture: a few items, an attachment, full text), loads
the plugin through the real plugin supervisor, answers the Zinc-app-side interfaces (`extend`, `ui`, `reader`, `prefs`, `l10n`, ...) with recording stubs, and runs a scenario you write.

```bash
bun .claude/skills/zinc-plugin-port/scripts/verify-port.ts <plugin dir> --scenario <scenario.ts>
```

- It never opens `data/library.sqlite`, the Zotero data folder, or ports 23119 / 23120. It deletes its scratch (`%TEMP%\zn-verify-port-*`, the temp library) at the end. **Do not** point it at a copy of
  the user's real library unless the user asks; the fixture library is enough for behaviour checks. If you need the user's data shape, copy the sqlite file into scratch and start the core on the copy
  (`startServer({ dbPath: <copy>, port: 0 })` in your own script); never run the app against the original.
- A scenario is `export default async (t) => {...}`; see `scripts/scenario.example.ts`. Typical steps: assert what `startup` registered (`t.calls`), call a callback the way the host would
  (`t.sup.call(t.id, "extend-handlers", "on-menu-command", [menuId, entryId, undefined, ctx])`), then read the result back from the core (`t.api("/api/items/<key>")`), and for notifier logic write through the
  core (`POST /api/items`) and poll with `t.until`.
- Callback argument shapes are the jco ones (camelCase fields, variants `{tag, val}`, `bigint` for u64): copy the `emptyCtx`, `viewContext`, `uiEvent` helpers from `plugin-api/samples/test.ts`.
- What is real: the wasm, the plugin host process, the host-side handlers (`library`, `attachments`, `fulltext`, `net`, `notifier`, `fs` reads and writes, ...). What is stubbed: everything drawn by the app (menus,
  columns, panes, dialogs, toasts). So this proves the logic and data effects, not the pixels.
- If a stub needs a real answer (a pref, a selection), set it in the `answers` table at the top of the script or in `t.prefs`.
- For the **drawn result** (does the column show, does the menu appear) use the app's own shot scripts if present (`gpui-ui/scripts/shot-wasm-extend.tsx`, `shot-wasm-ui.tsx`, `shot-wasm-reader.tsx` build their own fixtures
  and render headless); run them only if the user asks and never against a live app instance (headless throwaway only). If you can't run them, say the UI was not seen.
- Runner caveat: `plugin-host/`, `plugin-host-wasmtime/` and the host handlers change often. If the harness fails for a reason outside your plugin (import errors in `src/`, a missing `zhw` binary, a core that does
  not start), say that plainly, show the error, and fall back to the stub pattern of `plugin-api/samples/test.ts` (it needs only the build and the supervisor).
- A `wasm unreachable` trap with no message: a required record field missing, or the clock (`new Date()`); bisect with `log.write`.
- `core/vendor` must exist (a junction to the main checkout's `core/vendor`, git-ignored). Disk: a Rust build needs several GiB free on the `%TEMP%` drive.

## 3. Check behaviour against the original

The port is correct when it does what the original did for the same inputs, minus the documented cuts. Build the comparison from the report:

1. **Pure logic first.** Functions you kept (parsers, formatters, rules) get the same test vectors as the original (copy its tests if it has them; otherwise write 5-10 inputs from reading the code). Run them with `bun test`.
2. **Data effects.** For each feature: starting library state -> action -> expected library state. In the original that action is a menu click or an observer firing: read the code to know exactly which fields and tags it writes
   (e.g. `Extra` lines, automatic vs manual tags, `dateModified`), then assert the same in the scenario (`t.api("/api/items/<key>")`). Check the edge cases the original handled: non-regular items skipped, no-op writes skipped, existing
   lines replaced not duplicated, empty selection.
3. **Settings.** Every pref in the original appears in the port (manifest `default_prefs` + a setting row) or is listed as dropped in the report, with the same default.
4. **Strings.** Every Fluent id the original used exists in the port's `.ftl` (the scan prints the count; diff the ids).
5. **Permissions.** The port requests only what the features use; exercise a call without the permission once (expect `permission-denied`) to prove the gate is real.
6. **Report the diff.** End with a table: feature | original behaviour | port behaviour | verified how (test / scenario / not verified). Anything not verified is named as such.

If the original can be run (the user has Zotero), ask the user for before/after screenshots or an exported item JSON for one representative case rather than driving their Zotero yourself.
