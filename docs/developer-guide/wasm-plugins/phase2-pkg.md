# Phase 2, pkg agent: packages, permissions and the small host imports

Status 2026-11-18. Code: `plugin-host/src/package/`, `plugin-host/src/permissions/`, `plugin-host/src/imports/{app,plugins,prefs,secrets,l10n,log,timers,util,permissions}*`. Tests: `plugin-host/test/pkg/` (51 pass, about 19 s; `bun check` clean for `src` and, with `test/pkg` added to the tsconfig include, for the tests). No new dependency: zip, JSON Schema checking, Fluent and DPAPI are written here.

## What was built

| File | What it is |
|---|---|
| `src/package/installer.ts` | `PluginManager`: install and update from a `.zplugin` or a single-file `.wasm` (bytes or path; added in 0.2.3, see `wasm-package.ts`) or a folder, uninstall, enable and disable, `startAll`/`stopAll`, `windowLoaded`/`windowUnloaded`, permission grant and revoke, the lifecycle hook calls with their reasons. Drives a `PluginSupervisor`. |
| `src/package/zip.ts` | Zip reader (hostile input: names, sizes, CRC, symlinks, zip64 and encryption refused) and writer. |
| `src/package/wasm-package.ts` | Single-file plugins (0.2.3): the package zip in a `zinc:package` custom section of `plugin.wasm`. `embedPackage`, `extractPackage` (gives the files of a `.zplugin`, with the section cut out of the binary), `stripPackage`. Top-level sections only; the embedded zip is read with the same limits. |
| `src/package/json-schema.ts`, `validate.ts` | A small JSON Schema checker run against the real `plugin-api/manifest.schema.json`, plus rules a schema cannot say (known permission ids, required and optional do not overlap, reasons name real ids, integer prefs). |
| `src/package/layout.ts` | Folder layout under Zinc's data folder (below). |
| `src/package/transpile.ts` | The installer's build step: jco transpile of `plugin.wasm` with the same async lists as `scripts/build-plugin.ts`; tree hash. |
| `src/package/update.ts` | Update check (`updates.json` shape with `applications.zinc`; https and `update_hash` required) and download with hash check. |
| `src/package/{prefs-store,secrets-store,l10n,fluent,timers,log-ring,app-service,util-fns,semver}.ts` | The state behind the imports. |
| `src/package/services.ts` | `PluginServices` (one object wiring all of the above), `createPluginRuntime()` (services plus supervisor), the module slot the handlers read (`getServices()`). |
| `src/permissions/` | `ids.ts` (the 36 ids and tiers read from the schema), `risk.ts` (tiers, host entry parsing, prompt groups), `store.ts` (`GrantStore`, `permissionState`), `check.ts` (`requirePermission`, `matchNetHost`, `requireNetHost`), `service.ts` (`permissions.request`). |
| `src/imports/app.zinc.ts`, `plugins.zinc.ts`, `prefs.zinc.ts`, `secrets.zinc.ts`, `l10n.zinc.ts`, `log.zinc.ts`, `permissions.zinc.ts`, `timers.zinc.ts` | `where: "zinc"` handlers. |
| `src/imports/util.host.ts`, `timers.host.ts` | `where: "host"` handlers: pure helpers and the clock (no IPC round trip). |
| `test/pkg/` | `units.test.ts` (30 tests), `runtime.test.ts` (21, end to end), `helpers.ts`, `fixtures/e2e-js/` (a QuickJS plugin with Fluent files and an icon). |

## Layout on disk

`<root>` is `%APPDATA%\zotero-next-gpui\plugins` (`ZN_PLUGINS_DIR` overrides; `APPDATA` is honoured on every platform as in `core/src/platform-dirs.ts`; tests pass a temp folder):

```
installed/<id>/     manifest.json (sha256 pinned), plugin.wasm, transpiled/plugin.js (+ core wasm files), locale/, icons/, anything else shipped
data/<id>/          fs root `data` (removed on uninstall unless kept)
temp/               fs root `temp`, emptied at start
prefs/<id>.json    user-set prefs only (defaults are never written)
secrets/<id>.json  encrypted secrets; secrets/master.key.dpapi
state.json         per plugin: version, enabled, pendingApproval, hash of transpiled/
grants.json        per plugin: granted ids, ids the user has already seen
.staging/ .trash/  installer work folders
```

`installed/<id>/` is exactly the loadable folder of phase2-core (`src/manifest.ts`): `supervisor.load(dir)` reads it as is. Plugin ids are validated by the schema and again (`assertSafeId`) at every path build.

## How it works

**Install** (`manager.installPackage(bytes | path)`, `installDir(folder)`): zip checks; `manifest.json` against the schema; compatibility (`zinc.api_version` same major and, before 1.0, equal minor; `min_version`; `max_version` only with `strict_max`; `platforms`); blocklist callback; `main.sha256` against `plugin.wasm` (pinned into the installed manifest when absent); permission approval; stage in `.staging/`; transpile; swap folders (old one moved to `.trash/` and restored if the move fails); write `state.json` and `grants.json`; then load, `install` hook, `startup`. A failed check throws `InstallError` (`code`: `invalid-package`, `invalid-manifest`, `incompatible`, `hash-mismatch`, `cancelled`, `transpile-failed`, `io`) and leaves nothing behind (tested). A hook or startup that fails after the files are in place leaves the plugin installed with state `failed` (`result.error`).

**A `transpiled/` folder inside a package is ignored.** It is JavaScript that would run in the host's Worker without WebAssembly's sandbox around it, so the installer always runs jco on the package's own `plugin.wasm` (tested with a hostile `transpiled/plugin.js`). The same applies to `installDir`. `phase2-core.md` suggested "zip with manifest.json + transpiled output": do not ship transpiled output. The installed `transpiled/` is hashed and the hash is checked at every load, as is `plugin.wasm` against `main.sha256` (tampering gives state `failed`, tested).

**Lifecycle calls** (reasons as in lifecycle.md 2.2):

| Event | Calls |
|---|---|
| first install | `install(addon-install)`, `startup(addon-install)` |
| update or downgrade | old: `shutdown`, `uninstall` with `addon-upgrade`/`addon-downgrade`; new: `install` (with `previous-version`), `startup`; data and prefs stay |
| uninstall | `shutdown(addon-uninstall)`, `uninstall(addon-uninstall)`, then folder, grants, data folder, prefs, secrets (all unless `keepData`) |
| disable, enable | `shutdown(addon-disable)` and the Worker is unloaded (a disabled plugin costs no memory); `startup(addon-enable)` |
| app start, quit | `manager.startAll()` with `startup(app-startup)` (4 at a time); `stopAll()` with `shutdown(app-shutdown)` |
| windows | `manager.windowLoaded(id)` / `windowUnloaded(id)` call `main-window-load` / `-unload` on every running plugin |

Hooks use `main.startup_timeout_ms` (default 10 s) as the time budget. A plugin that is disabled or not loaded when uninstalled is loaded just to run its `uninstall` hook. An update that adds a permission the user has not seen installs but stays `disabled` (`pendingApproval`) until `manager.approvePending(id, grantedIds)`; with an `approve` function it asks at once.

**Approval.** `approve(req)` gets `{ action, manifest, previousVersion, groups, required }` (`groups`: low, medium, high, each item `{ id, tier, reason, optional }`, hosts as `net.hosts:<entry>`) and returns `{ grant: ids }` or `false` (cancel). With no function, tiers none and low are granted and the rest is not. Optional permissions are never granted at install.

**Permissions at call time.** `GrantStore.grantsFor(manifest)` is what the supervisor uses (`createPluginRuntime` passes it; the manager also calls `setGrants` after every load). A permission the manifest no longer declares disappears from the grants. `manager.setPermission(id, perm, granted)` (Settings, or the answer to `permissions.request`) updates the grants, pushes them to the host and calls `events.on-permission-changed` (not awaited, see "Deliveries are serialised").

**Prefs** (`PrefStore`): one JSON file per plugin, atomic write; defaults from `default_prefs`; key and size limits, 32-bit integers, the type of a default is enforced, `set-many` is all or none, one change notification per key whose effective value changed. Observers (`prefs.observe`) are delivered through `events.on-pref-changed` after the call that caused the change has returned. A change made by the UI goes through the same store (`getServices().prefs.set(id, key, value)`) and fires the same observers. Secret setting keys: `prefs.markSecret(id, key)`; they read as none and writes go to `secrets` under `pref:<key>`.

**Secrets.** Encrypted file store, not the Credential Manager (see "Stubbed"): AES-256-GCM per value, a per-plugin key derived with HKDF from a 32-byte user master key, the plugin id and secret name as authenticated data. On Windows the master key is wrapped with DPAPI through `bun:ffi` (`CryptProtectData`, tested), so only that Windows user can unwrap it; elsewhere it is a 0600 key file. 64 names, 8 KiB per value, values never logged.

**l10n.** Fluent subset parser (messages, terms, attributes, multi-line, `{ $var }`, message and term references, string and number literals, selects with plural categories and exact keys, `NUMBER`, `DATETIME`). Locale chain as lifecycle.md 2.6, and a message missing in the chosen locale is looked up in the rest of the chain, then `fallback`, then the id (a warning once per id). `getServices().l10n.resolve(pluginId, localizedString)` is for the ui and extend areas. `app.notifyLocaleChanged(tag)` drops the bundles and calls `events.on-locale-changed` on running plugins.

**Timers.** 64 per plugin (`limit-exceeded`), interval floor 10 ms, 1 s floor while `windowsHidden()` is true, an interval tick is skipped while the previous callback still runs; `now`, `monotonic-ms`, `sleep` are host handlers. All timers, pref observers and the plugin-event observer are dropped when the plugin's status becomes stopped, failed, disabled or loading, on uninstall, and on `host-restart`.

**Log.** `ctx.log` carries the line to the supervisor's `log` event, and `LogRing` (fed by that event, so Rust stderr and host diagnostics land in it too) keeps 5000 lines, 8 KiB per line (truncated), 200 lines a second per plugin (extra dropped and counted), debug lines only while `logs.debugEnabled`, and the last error (`write-error` and error-level lines) per plugin.

## Run it

```bash
cd plugin-host
bun test test/pkg            # 51 tests, builds the e2e QuickJS fixture into %TEMP%\zn-wasm-pkg-fixtures first (about 2 s)
bun check                    # src/ (add "test/pkg" to tsconfig.json "include" to check the tests too)
```

In the app (one call; `discoverHandlers("zinc")` loads every area's `*.zinc.ts`):

```ts
const { services, supervisor } = await createPluginRuntime({
	coreUrl,
	app: { version, locale: () => ..., mainWindows: () => [...], activeWindow: () => ..., features: () => [...], isUiReady, waitUiReady, windowsHidden, devBuild, appPrefs },
	prompt: (req) => showPermissionDialog(req),        // permissions.request: the ui area's dialog
	canPrompt: (pluginId) => windowFocused() && userActedWithin(10_000),
	manager: { approve: (req) => showInstallDialog(req), blocklist: (id, version) => reason | undefined },
	extraHandlers: [...],                                // anything else that is app-specific
});
await services.manager.startAll();                       // after the library is open and the UI is ready
```

## Tests and result

`bun test test/pkg`: **51 pass, 0 fail** (424 expects). Full `bun test` of the folder at the time of writing: 118 pass, 2 fail, both outside this area (see "Needs from other areas").

| Test | Proves |
|---|---|
| zip | round trip; unsafe names (`..`, absolute, drive, backslash, reserved, trailing dot or space) refused; CRC, size and duplicate checks |
| manifest | the real schema accepts the fixture and rejects bad id, version, extra keys, `..` in paths, unknown ids, bad host entries, non-integer prefs, http `update_url` |
| permissions | 36 ids and tiers from the schema; host risk (`*`, loopback, private ranges); prompt groups; `requirePermission` (live grants, unknown id is a bug); `matchNetHost` (scheme, port, subdomain, `*` never covers private hosts); states; `GrantStore`; `permissions.request` rules |
| prefs, secrets, Fluent, log ring, timers, util | as described above; DPAPI wrapping and restart on Windows |
| e2e, real jco | a `.zplugin` with a hostile `transpiled/` installs; the installed layout; hash pinned; hooks `install` then `startup(addon-install)`; low tier granted only |
| e2e, the imports | one built QuickJS plugin calls prefs (defaults, type errors, atomic `set-many`, observers incl. a UI-side write), timers (set, clear, interval, `sleep`, 64 limit), log (levels, truncation, last error), l10n (plurals, terms, attributes, fallback, locale change to French), secrets, util, app, plugins, permissions (check, list, request with and without a prompt, `on-permission-changed`, revoke) through the supervisor |
| lifecycle | upgrade and downgrade order and reasons, data and prefs kept; update adding a permission stays disabled until approved; uninstall removes everything, `keepData` keeps it, a reinstall finds it; disable and enable; main-window hooks; another plugin's events reach a `plugins.read` observer; `startAll` and `stopAll` on a second runtime over the same folder; tampered wasm or transpiled output refused; incompatible after a Zinc downgrade; 11 refusals that leave no folder behind |

## WIT rows now implemented

By `lifecycle.md` parity row: 1, 2, 3 (with `strict_max`), 4 (check and download; the user-approved install of the result is `installPackage(downloadUpdate(...))`), 5 (`icons`, `plugins.get-icon`, PNG only), 6, 7, 11, 12, 13 (the `.zplugin` and a folder; not `dev.watch`), 15 (the manager API; the Settings page is ui's), 16 (sha pinned), 18 to 29, 30, 31, 33 (`check-update`), 35, 36, 38 to 46, 48, 49 to 55, 91 to 95, 103 to 105, 107, 108, 110, 114. Row 14 is partial: a `blocklist(id, version)` callback, not the `blocked-plugins.json` data.

By interface.function:

- `lifecycle`: `install`, `startup`, `shutdown`, `uninstall`, `main-window-load`, `main-window-unload` (called, with the reasons above).
- `events`: `on-pref-changed`, `on-timer`, `on-plugin-event`, `on-locale-changed`, `on-permission-changed` (delivered).
- `app`: `get-info`, `is-ui-ready`, `wait-ui-ready`, `main-windows`, `active-window`.
- `plugins`: `self-info`, `get-info`, `list-plugins`, `get-icon`, `check-update`, `observe-plugins`, `stop-observing-plugins`.
- `prefs`: `get`, `get-app`, `get-all`, `set`, `set-many`, `clear`, `has-user-value`, `reset`, `observe`, `unobserve`.
- `secrets`: `get`, `set`, `delete`, `list-names`.
- `l10n`: `format`, `format-many`, `has-message`, `locale`, `plugin-locales`, `format-date`, `format-number`.
- `log`: `write`, `write-error`, `debug-enabled`.
- `timers`: `now`, `monotonic-ms`, `sleep`, `set-timeout`, `set-interval`, `request-idle`, `clear`.
- `util`: `random-bytes`, `uuid-v4`, `hash`, `semver-compare`, `clean-doi`, `clean-isbn`, `clean-issn`, `html-to-text`, `text-to-html`, `capitalize-title`.
- `permissions`: `check`, `list-permissions`, `request`.

## Stubbed or left

- **Secrets are not in the OS credential store.** Encrypted files keyed by a DPAPI-wrapped master key (Windows) or a 0600 key file (elsewhere). Reason: Credential Manager caps a credential at 2560 bytes (the WIT promises 8 KiB) and macOS and Linux need a keychain binding each. A secret is protected against other users and against copying the folder, not against another process of the same user. TODO: `security` and `secret-tool` key providers.
- **The app pref allowlist is open.** `APP_PREF_ALLOWLIST` in `app-service.ts` is an explicit short list (UI locale and theme, the `shell.reader.*` and `general.*` prefs of gpui-ui, `extensions.zotero.autoRenameFiles`, `export.quickCopy.setting`); the app supplies the values through `appPrefs.get/subscribe`, and without it `get-app` returns none. The names `ui.locale`, `ui.theme.mode` and `ui.theme.palette` are guesses: the settings owner must confirm.
- `timers.request-idle` has no idle signal: it fires after `min(deadline, 50 ms)`. `windowsHidden` is a provider the app must supply.
- The `permissions.request` rule "a focused window and a user action in the last 10 s" is the `canPrompt` provider; the default allows. The prompt itself (`prompt`) is the ui area's.
- `log.write` is one IPC message per line (no batching); `l10n`, `prefs` and `timers.set-*` are also one hop (they live in the Zinc process so the UI bindings share the stores).
- No `dev.watch` reload, no `blocked-plugins.json`, no automatic update installation (a user-approved `installPackage(await downloadUpdate(c))`), no `update_url` polling schedule.
- The transpiler needs `plugin-api/wit` next to the source tree (`DEFAULT_WIT_DIR`; `manager.witDir` overrides). A packaged build must ship that folder or pass `witDir`.
- Lazy activation (`activation_events`) is not implemented: every enabled plugin starts at `startAll`.
- `fs` root `temp` is emptied by `manager.init()`; the `fs` handlers (data agent) must use `layout.data(id)` / `layout.tempRoot` from `services.manager.layout`.

## WIT changes

None made. For review:

1. `plugins.get-info`, `list-plugins` and `get-icon` say "needs `plugins.read`" but return no `result`, so they cannot return `permission-denied` (a handler that throws makes the plugin trap). Implemented: without the permission, `get-info` of another plugin and `get-icon` give none, and `list-plugins` gives only the plugin's own record. Suggest changing them to `result<...>` or documenting this.
2. `util.random-bytes` has a 64 KiB limit and no `result`: over the limit the plugin traps. Same remark.
3. `util.text-to-html(text, single-paragraph)`: the parameter name is ambiguous. Implemented as Zotero's `singleNewlineIsParagraph`: true makes every line break a new `<p>`; false splits paragraphs at blank lines and turns a single break into `<br />`.
4. `prefs.set` with an `integer` outside 32 bits cannot be detected on the host: jco saturates the number before the handler sees it. Only the guest SDK can reject it.

## For other agents

**Permission checks.** In any handler:

```ts
import { requirePermission, requireNetHost } from "../permissions";   // from src/imports/<area>.ts
async read(ctx, key) {
	requirePermission(ctx, "library.read");     // throws error::permission-denied("library.read") -> result::err in the plugin
	...
}
```

`requirePermission(ctx, id)` reads the live grants (a revoke takes effect on the next call) and refuses an id that is not in the schema (`internal`: it is a handler bug, not a denial). Also: `hasPermission(ctx, id)`, `requireAnyPermission(ctx, ...ids)`, `requireNetHost(ctx, url)` / `matchNetHost(entries, url)` for the static part of the `net.hosts` rule (scheme, port, `*.`, `*` is https and public only; returns `privateHost`; the caller still checks DNS and redirects). The matcher, the entry parser and the private-address classifier live once, in `imports/data/nethosts.ts` and `core/src/translate/netguard.ts`. It is a plain function over `ctx`, so it works in `where: "host"` and `where: "zinc"` handlers. It does not apply to functions without a `result` (they cannot return an error): decide per function and say so, as `plugins.zinc.ts` does.

**Strings.** `getServices().l10n.resolve(pluginId, localizedString)` resolves a `types.localized-string` (plain or `localized(l10n-ref)`) in the UI locale. The ref is the jco shape: `{ id, args: [{ name, value: { tag: "text" | "integer" | "number" | "date", val } }], fallback }`.

**Prefs bound to UI controls.** Use `getServices().prefs`: `get(id, key)`, `set(id, key, value)`, `setMany`, `clear`, `getAll`, with JS primitives (boolean, integer number, string); they throw `PrefError` (`.tag` is `invalid-argument` or `limit-exceeded`); observers fire as for the plugin's own writes. A secret text setting: `prefs.markSecret(id, key)` once, then `getServices().secrets.get/set(id, "pref:" + key)`.

**Prompt hooks (ui area).** Pass to `createPluginRuntime`: `prompt(req)` for `permissions.request` (`req`: `pluginId`, `pluginName`, `permission`, `tier`, `reason` already resolved to text; return a boolean), `canPrompt(pluginId)` (focused window, user action in the last 10 s), and `manager.approve(req)` for the install prompt (`req.groups` are the tiers to draw; return `{ grant: [...] }` or `false`). The Settings > Plugins page reads `services.manager.list()` (`InstalledPlugin`: state, `stateDetail`, `granted`, `pendingApproval`), calls `setEnabled`, `uninstall(id, { keepData })`, `setPermission`, `approvePending`, `installPackage`, and listens to `manager.on("changed" | "installed" | "uninstalled" | "hook")`. `services.logs.recent({ plugin })` and `lastError(plugin)` feed the log view.

**Callbacks into a plugin.** Use `getServices().manager.callPlugin(pluginId, iface, fn, args)` instead of `supervisor.call` for callbacks the UI starts (menu commands, renders). It queues behind any other call into the same plugin (see below). `ctx.callExport` from inside a handler is unchanged.

**Stores that other areas need**: `services.manager.layout` gives `data(id)`, `tempRoot`, `installed(id)`; `services.manager.manifestOf(id)`; `services.app.providers` for window ids.

## Deliveries are serialised (a finding about the core)

A callback that enters a plugin while another call into the same instance is suspended in a host import corrupts a QuickJS guest: a pref observer fired while a probe waited in `prefs.get-app`, and the plugin trapped with "Out of bounds memory access" (reproduced, then fixed by the queue). The QuickJS interpreter is not re-entrant. phase2-core.md says re-entrancy works "for a single-threaded Rust guest and the QuickJS sync runtime"; that holds for a simple callback but not in general. `PluginManager.exclusive(id, fn)` now runs every lifecycle call and every callback this area makes (timers, pref observers, plugin events, locale, permission changes, startup, shutdown, window hooks) one at a time per plugin; the WIT already allows this ("the plugin's other callbacks may not run while it waits"). Calls other areas make straight on the supervisor are not covered. The right fix is a per-plugin call queue in `PluginSupervisor.call` for QuickJS guests (needs the core agent); until then those areas should use `manager.callPlugin`. Consequence: a plugin that waits in `timers.sleep` or `net.send` inside an export gets no callbacks until that export returns.

## One runtime per process

The handlers find their services through `getServices()` (a module slot), because `HandlerContext` carries no reference to the runtime. `createPluginRuntime` sets it; a second runtime in the same process replaces the first (the tests start one at a time and `services.dispose()` the previous). `getServices()` throws if nothing set it, on purpose: a stale handler must not create services over the user's real plugin folder.

## Needs from other areas

- **Core agent:** (1) a per-plugin call queue in the supervisor (above). (2) `tsconfig.json`: add `"test/pkg"` to `include`. (3) `src/index.ts`: re-export `./package/index` (`createPluginRuntime`, `PluginManager`, `requirePermission`, ...). (4) `test/supervisor.test.ts` "WIT resources" fails when run in this worktree now because the real `attachments.host.ts` and `net.host.ts` of the data agent replace the test handlers in the host process (`discoverHandlers("host")` loads every `*.host.ts`); the test needs its own handler folder or a way to turn discovery off.
- **UI agent:** the install prompt, the permission prompt and `canPrompt`, Settings > Plugins (all through `PluginManager`), and calling `app.notifyLocaleChanged(tag)` when the UI language changes. Window ids for `app.main-windows` and the `manager.windowLoaded/windowUnloaded` calls.
- **App wiring (gpui-ui):** `createPluginRuntime`, `appPrefs` (a provider over `shell/prefs` with the allowlisted names), `startAll()` after the UI is ready, `stopAll()` and `supervisor.shutdown()` on quit. If `process.execPath` is the packaged exe, the supervisor needs `BUN_BE_BUN=1` (unverified in phase2-core); the transpiler also needs `plugin-api/wit` (`manager.witDir`).
- **Data agent:** `fs` roots must come from `services.manager.layout` (`data/<id>`, `temp/`, `installed/<id>` for `bundled`), and an installed plugin's folder is read only.
