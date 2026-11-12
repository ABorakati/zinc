# Contributing

This page expands `CONTRIBUTING.md` at the repository root. Read [Architecture](architecture.md) first for the shape of the code.

## One-time setup

Bun 1.4.4 only. There is no Node, npm or npx anywhere in the workflow. From the repository root:

```
cd core         && bun install --frozen-lockfile
cd word/sidebar && bun install --frozen-lockfile     # the fuzz tests import word/sidebar/src
cd gpui-ui      && bun install --frozen-lockfile
bun core/scripts/fetch-zotero-vendor.ts              # Zotero's translators and framework, pinned commits
mkdir -p core/vendor/fulltext-wasm && : > core/vendor/fulltext-wasm/fulltext.wasm   # empty placeholder
```

The placeholder lets the module graph load; tests that need the real engine skip. Anything beyond this (the Rust library, the document worker, the reader, the executable, the installer) is covered in [Building](building.md). You only need it when you work on the part that uses it.

Run the app against a copy of a library, never the real one, because the core writes to its database:

```
cd gpui-ui
ZN_DB=C:/path/to/library-COPY.sqlite bun src/main.tsx
```

## Before you push

Run the checks for every project you touched. CI runs all of them on every push.

```
cd core        && bun check && bun test --timeout 30000
cd gpui-ui     && bun check && bun test --timeout 30000
cd word/sidebar && bun check && bun test
dotnet build word/addin/ZoteroNextWord.csproj -c Release -nologo -v q -o "$TEMP/addin-out"   # if you touched word/addin
cd connector-host && bun run build && bun test                                                # if you touched connector-host or core/src/connector
```

Notes:

- Typecheck with `bun check`, not `tsc` or `bunx tsc`.
- Pass `-o` to `dotnet build` so the build stays out of `word/dist`, which can be an installed add-in on a developer machine.
- If you change anything under `core/src/connector` or `core/src/db.ts`, rebuild the connector host: it embeds them.
- If you touch a parser or anything that reads untrusted data, run the long fuzz suite once: `cd core && ZN_FUZZ_RUNS=5000 bun test test/fuzz`. See [Testing](testing.md).
- A change to layout is checked with the headless screenshot scripts in `gpui-ui/scripts/`, not by tests.

## Code conventions

These are what the code does today; there is no formatter or linter configuration in the repository, so match the surrounding file.

- TypeScript and TSX in `core`, `gpui-ui`, `word/sidebar` and `connector-host` are indented with tabs. The C# in `word/addin` uses four spaces.
- Bun for everything: `bun:sqlite` for SQLite, `Bun.serve` for HTTP, `bun test` for tests, `bun check` for types.
- Files start with a comment saying what the file is for and any non-obvious constraint; follow that.
- GPUIX facts the UI code relies on (from `gpui-ui/src/features/kit.tsx`): every `<text>` has an explicit colour (use `Txt`), a `<text>` has one child (pass a template string), and there is no `display: none`. Icons are lucide kebab-case names.
- Do not hard-code a user name or a home folder. Locations come from the per-OS folders in `core/src/platform-dirs.ts` (do not assume `%APPDATA%`), the home folder or an environment variable (`core/src/library-location.ts` is the model). Code must also run on Linux and macOS: `core` is tested on Linux in CI, and a `process.platform` branch needs both sides.
- Do not add personal data, tokens or keys. The update private key lives outside the repository and the release script refuses a path inside it.
- Tests use temporary folders and libraries and never your real library or the network.

## Where things live

| You want to change | Look in |
| --- | --- |
| A screen, dialog or control | `gpui-ui/src/` (`App.tsx`, `Sidebar.tsx`, `itempane/`, `cards/`, `table/`, `reader/`, `settings/`, `features/`) |
| Shell extension points | `gpui-ui/src/registry.ts` |
| Database, migrations | `core/src/db.ts`, `core/src/migrations/`; see [Database](database.md) |
| An API route | `core/src/api.ts` or the feature's `api.ts`; see [HTTP API](http-api.md) |
| Importers and exporters | `core/src/io/`, `core/src/import/`, `core/src/zport/` |
| Translators | `core/src/translate/`; see [Translators](translators.md) |
| Citations | `core/src/cite/` |
| Sync | `core/src/sync/` (local Zotero), `core/src/websync/` (zotero.org) |
| PDF rendering | `gpui-ui/native/pdf/` and `gpui-ui/src/reader/pdf.ts` |
| Per-OS code (web view, display, printing) | `gpui-ui/src/webview/` (`win32.ts`, `x11.ts`, `cocoa.ts`), `gpui-ui/src/shell/`, `gpui-ui/src/reader/printGtk.ts`, `printMac.ts`; see [Architecture](architecture.md) |
| Build, package, release | `gpui-ui/scripts/` (including `appimage.ts` and `dmg.ts`), `gpui-ui/installer/`, `.github/workflows/`; see [Building](building.md), [Releasing](releasing.md) |
| The Word add-in | `word/addin/` (C#), `word/sidebar/` (TypeScript) |
| Documentation | `docs/user-guide/`, `docs/developer-guide/` |

## Add a setting

Settings are data. `gpui-ui/src/settings/registry.ts` holds a list of sections and a list of `SettingDef` rows; the Settings page renders and searches them.

1. Persist the value. `gpui-ui/src/shell/prefs.ts` exposes `persisted(key, default, validator)`, which returns a signal pair stored in the UI-state file. Look at `gpui-ui/src/settings/generalPrefs.ts`:

   ```ts
   import { isBool, persisted } from "../shell/prefs";
   export const [autoTag, setAutoTag] = persisted<boolean>("general.autoTag", true, isBool);
   ```

   A feature uses `persisted` re-exported from `gpui-ui/src/features/prefs.ts`, with keys namespaced `features.<feature>.<name>`. A setting that must be shared with other programs or survive a library change belongs in the core (an API route and the database) instead.

2. Add a row to an existing section in `gpui-ui/src/settings/defs/*.tsx` (appearance, general, reader, sync, files, integrations, system, updates), or register one from a feature:

   ```tsx
   registerSettings([{
     id: "system.example", section: "system", group: "Diagnostics",
     label: "Example", description: "One sentence for the user.",
     keywords: ["synonyms", "the user might search"],
     control: () => <Toggle checked={autoTag()} onChange={setAutoTag} />,
   }]);
   ```

   `gpui-ui/src/features/report/register.tsx` is a small real example. Controls (`Toggle`, `Choice`, `Segmented`, `TextField`, `Btn`, `Value`) are in `gpui-ui/src/settings/controls.tsx`. The control must read signals inside its function so it stays reactive.

3. A new section: call `registerSection({ id, label, icon, order })` first. A section may also use the lower-level `registerSettingsSection` from `gpui-ui/src/registry.ts` with its own `render()`.

4. If users will look for it, add its words to `keywords`, and mention it on the matching page of the [settings guide](../user-guide/settings.md).

## Add a feature

A feature is a folder `gpui-ui/src/features/<name>/` with a `register.tsx` exporting `register()`:

1. Create the folder with your UI, a small client for any core routes (for example `client.ts`), and pure logic in files with `*.test.ts` beside them.
2. In `register()` use the registry in `gpui-ui/src/registry.ts`: `registerItemAction`, `registerCollectionAction`, `registerAppAction` (the toolbar's add and tools menus, with an optional global shortcut), `registerOverlay` (a dialog that owns its open state), `registerSidebarSection`, `registerSettingsSection`.
3. Import it and add it to the list in `gpui-ui/src/features/index.ts`. `gpui-ui/src/features.ts` calls that once after the app mounts. Features that are not in that folder, such as saved searches and reader plugins, register through `gpui-ui/src/searches/register.ts` and `gpui-ui/src/reader/register.ts`.
4. If it needs data, add the route in `core` first ([HTTP API](http-api.md)) and a test there.
5. Keep features out of each other's files. The registry exists so they can stay independent.

## Add a migration

Follow the steps in [Database](database.md): a new file in `core/src/migrations/`, appended to `MIGRATIONS` in `list.ts` with the next id, never editing a released migration, with a test in `core/test/migrations.test.ts`.

## Update a translator

Translators come from the `zotero/translators` repository.

- To try newer translators without changing the repository: `bun core/scripts/update-translators.ts --data <scratch folder>` writes `<scratch folder>/translators`, which the app prefers when the library database is in that folder, or point `ZN_TRANSLATORS_DIR` at any folder of translator files.
- To move the baseline that everyone gets: change the commit in the `PINS` table of `core/scripts/fetch-zotero-vendor.ts`, re-run it with `--force`, run the core tests, and let the script rewrite `core/vendor/zotero/README.md` (do not edit it by hand). CI caches the vendored folder on the hash of the script, so a new pin refreshes the cache.
- Do not edit vendored files. They are unmodified AGPL-3.0 copies; see [Translators](translators.md).

## Documentation

User pages are in `docs/user-guide/`, developer pages in `docs/developer-guide/`. Use relative links between pages, write commands that work from a fresh checkout, and put facts in code comments where they would otherwise go stale. Do not include real keys, tokens or personal paths in examples; use placeholders such as `<repo>` and `%APPDATA%`.
