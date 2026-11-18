# Worlds, permissions, manifest, locale, prefs

Contents: worlds; permissions; manifest; locale files; default prefs; ids.

## Worlds (what each adds)

`plugin-core` < `plugin-library` < `plugin-extend` < `plugin-ui`; `plugin-reader` and `plugin-dialogs` also build on `plugin-extend`; `plugin` is everything. Source: `plugin-api/wit/world.wit`.

| World | Imports | Exports (callbacks) |
|---|---|---|
| `plugin-core` | app, prefs, l10n, log, timers | lifecycle, events |
| `plugin-library` | + library, attachments, fulltext, schema, cite, translate, sync-control, data-utils, notifier | + notifier-handler |
| `plugin-extend` | + extend (menus, columns, panes, section registration, toolbar, shortcuts) | + extend-handlers |
| `plugin-dialogs` | + ui (toasts, dialogs, windows, `push`) | (no ui-events) |
| `plugin-ui` | + ui | + ui-events (mount, on-event, ...) |
| `plugin-reader` | + annotations, reader, note-editor | + reader-events, note-events |
| `plugin` | + net, fs, clipboard, shell, secrets, util, permissions, plugins | + net-events |

Consequences that bite:

- A **section** needs `ui-events` (it is mounted as a view), so it needs `plugin-ui`, not `plugin-extend`.
- A **dialog** reports its answer as a `close` event on `ui-events.on-event`. With only `plugin-dialogs` (Rust feature `dialogs`) the dialog opens but the answer never reaches the plugin. Dialogs with an outcome need `plugin-ui` (feature `ui`). Toasts alone are fine with `plugin-dialogs`.
- **net, fs, clipboard, shell, secrets** exist only in `plugin`. Reader plus any UI also means `plugin` (Rust: features `reader` + `ui` select it, or use `full`).
- Calling an import the world lacks is a build error (Rust) or an import error at load (JS). Not a runtime permission error.

## Permissions

Declared in `manifest.json` `permissions.capabilities`; enforced per call. A call without the grant fails with `permission-denied(<id>)` (JS: throws, Rust: `Err`). The user grants at install; `optional_permissions` can be requested later. The schema in `plugin-api/manifest.schema.json` (`$defs.capability`, with `x-risk` tiers) is the authority; the host rejects unknown ids.

No permission needed: registering menus, columns, sections, panes, shortcuts, toolbar buttons; dialogs, toasts, prompts; own prefs; l10n; log; timers; util; `fs` roots `data`, `bundled`, `temp` and files the user picked or dropped.

| Need | Id (tier) |
|---|---|
| read items, collections, tags; the selection in a callback `ctx` (`items`) | `library.read` (low) |
| `library.apply` writes | `library.write` (medium); `library.trash`, `library.erase` (high) for those changes |
| full text of attachments | `library.fulltext.read` (low), `.write` (medium) |
| file bytes, paths, open | `library.files.read` / `.paths` (medium), `.write` / `.open` (high) |
| citations, translators, sync | `library.cite`, `library.cite.styles`, `library.translate`, `library.sync` |
| clipboard, URLs | `clipboard.write` (low), `clipboard.read` (high); `shell.open-url`, `shell.reveal` (low), `shell.open-file` (high) |
| tabs, side panels, extra windows | `ui.windows`; drops: `ui.drop`; move selection / open items: `ui.navigate`; theme: `ui.theme` |
| reader menus, toolbar, overlays | `reader.ui`; read reader state `reader.read`; control `reader.control` |
| annotations | `annotations.read`, `annotations.write` |
| note editor | `note-editor.read` / `.write` / `.control` / `.ui` |
| other plugins, app prefs | `plugins.read`, `prefs.app-read` |
| web hosts | `permissions.net.hosts`, not an id |

Net hosts: `"api.example.org"` (https assumed), `"*.example.org"`, `"http://localhost:11434"` (http and private hosts must be written out, exact host and port), `"*"` (any public host: shown as high risk, avoid). A redirect to an unlisted host is refused.

Start from nothing, add one permission per feature, and write its reason in `permission_reasons` (key = the id or `net.hosts`; a value with a space is shown as plain text, otherwise it is a Fluent message id).

## manifest.json

Schema: `plugin-api/manifest.schema.json`; the installer validates against it (and rejects unknown permission ids, ids in both required and optional, non-integer prefs). Minimal useful manifest (the scaffold writes this):

```json
{
  "manifest_version": 1,
  "id": "my-plugin@example.com",
  "name": "My Plugin",
  "version": "0.1.0",
  "description_l10n": "plugin-description",
  "license": "MIT",
  "zinc": { "api_version": "0.1" },
  "main": { "wasm": "plugin.wasm", "world": "plugin-ui", "language": "js" },
  "activation_events": ["onStartup"],
  "permissions": { "capabilities": ["library.read"], "net": { "hosts": ["api.example.org"] } },
  "permission_reasons": { "library.read": "Read the selected items.", "net.hosts": "Look up metadata." },
  "default_prefs": { "enabled": true },
  "locales": { "default": "en-US" }
}
```

- `id`: `name@domain` (or a GUID in braces). It names the data folder and pref branch and **must never change** between versions.
- `version`: semver; decides install, upgrade or downgrade.
- `main.wasm` is always `plugin.wasm`: the build writes it, and adds `main.sha256` to the built manifest. Never write the hash by hand.
- `main.startup_timeout_ms`: budget for install, startup, shutdown (default 10000, max 60000).
- `activation_events`: keep `["onStartup"]`. Lazy activation needs a `contributes` block; skip it for a first version.
- `icons`, `homepage_url`, `author`, `update_url` (https, needs a hash) are optional.

## Locale files

`locale/<tag>/*.ftl` next to `manifest.json` (Fluent). `locales.default` names the fallback tag; `locales.available` is optional. The build copies `locale/`, `icons/` and `assets/` into the output. Message ids are kebab-case. Fluent plurals and arguments work:

```ftl
plugin-description = Counts words in PDFs.
items-tagged = { $count ->
    [one] Tagged one item.
   *[other] Tagged { $count } items.
}
```

Use them as a localized text: JS `{ id: "items-tagged", args: { count: 3 }, fallback: "Tagged 3 items." }` anywhere a `Text` is accepted by the SDK helpers (`ext.entry`, `ui.button` label, ...), or `ext.localized(id, args, fallback)`; Rust `l10n("items-tagged").arg_int("count", 3).fallback("...")` (accepted wherever a label is). `name_l10n` and `description_l10n` in the manifest take a message id. The locale chain is exact tag, same language, default, first listed; a missing message falls back to `fallback`, then the id. `events.on-locale-changed` fires when the UI language changes: rebuild views you cached.

## Default prefs

`default_prefs` in the manifest; keys are relative to the plugin's own branch; the type of the default fixes the type: boolean, **32-bit signed integer**, or string (no floats, no values over 2^31 - 1). Defaults are never written to disk; `prefs.set` stores only user values. Read with `prefs.get(key)` (value or none: `{ tag: "flag" | "integer" | "text", val }`), write with `prefs.set`, watch with `prefs.observe(scope, key, prefix)` and `events.on-pref-changed` (delivered after the call that changed it returned). Bind a settings-pane control straight to a pref and no code is needed (see the recipes). Secrets (API keys): a text setting with `secret: true` stores the value in the OS credential store, and the plugin reads it from `secrets.get("pref:<key>")` (world `plugin`).

## Ids to keep unique per plugin

menu ids, column `dataKey`, section `paneId`, pref pane ids, reader listener ids, handler ids in UI trees. Prefix entry ids with the plugin slug (`my-plugin.do-thing`) so a log line shows whose they are.
