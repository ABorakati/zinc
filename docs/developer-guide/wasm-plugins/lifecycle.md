# WASM plugins: package, lifecycle and capabilities (the `lifecycle` area)

This is the phase 1 design report of the `lifecycle` agent (2026-11-18). It is design only: no host code exists yet. It covers a plugin as a package (manifest, files, prefs, strings), its life in Zinc (install, start, stop, remove, update), and the capabilities that Zotero gives every plugin without asking and that Zinc therefore gates (network, files, timers, clipboard, shell, log). It also holds the shared WIT types and the `plugin` world.

Files owned by this area:

- [`plugin-api/wit/types.wit`](https://github.com/ABorakati/zinc/blob/main/plugin-api/wit/types.wit): shared types.
- [`plugin-api/wit/lifecycle.wit`](https://github.com/ABorakati/zinc/blob/main/plugin-api/wit/lifecycle.wit): interfaces `lifecycle`, `events`, `app`, `plugins`, `prefs`, `secrets`, `l10n`, `log`, `timers`, `net`, `net-events`, `fs`, `clipboard`, `shell`, `util`, `permissions`.
- [`plugin-api/wit/world.wit`](https://github.com/ABorakati/zinc/blob/main/plugin-api/wit/world.wit): worlds `plugin` and `plugin-minimal`.
- [`plugin-api/manifest.schema.json`](https://github.com/ABorakati/zinc/blob/main/plugin-api/manifest.schema.json): JSON Schema of `manifest.json`.

Sources read: Zotero `xpcom/plugins.js` (whole file), `xpcom/prefs.js`, `xpcom/http.js`, `xpcom/file.js`, `xpcom/zotero.js` (launchFile, launchURL, window helpers, debug), plus Zinc's existing Zotero-compat layer (`gpui-ui/src/plugins/`, its doc `zotero-plugins.md`) as a map of what plugins actually call. The Zotero 7 manifest and bootstrap conventions are from the Zotero 7 developer documentation.

## 1. Parity table

Status: `covered` = a plugin can do the same thing; `partial` = part of it; `not planned` = deliberately left out.

### 1.1 Package and manifest

| # | Zotero capability (source) | Zinc WIT / manifest | Status |
|---|---|---|---|
| 1 | `manifest.json` `applications.zotero.id` (plugins.js: `addon.id`) | manifest `id` (same email-like or GUID rule, so a ported plugin keeps its id) | covered |
| 2 | `applications.zotero.strict_min_version` | manifest `zinc.min_version` | covered |
| 3 | `applications.zotero.strict_max_version` | manifest `zinc.max_version` and `zinc.strict_max`. Not enforced unless `strict_max` is true: pinned max versions made Zotero plugins stop at every release | covered |
| 4 | `applications.zotero.update_url` (updates.json) | manifest `update_url`, same JSON shape with an `applications.zinc` key, https and a sha256 hash required | covered |
| 5 | `icons` (`Zotero.Plugins.getIconURI`) | manifest `icons`; `plugins.get-icon` | covered |
| 6 | `name`, `version`, `description`, `author`, `homepage_url`, `manifest_version` | same fields; `name_l10n` and `description_l10n` for translated text | covered |
| 7 | `bootstrap.js` as the entry (plugins.js `_loadScope`, `loadSubScriptWithOptions`) | `main.wasm` (a component for world `plugin` or `plugin-minimal`) and the exported `lifecycle` interface | covered |
| 8 | The bootstrap sandbox with its globals: `Zotero`, `Services`, `ChromeUtils`, `IOUtils`, `PathUtils`, `Localization`, `fetch`, `XMLHttpRequest`, `Worker`, `DOMParser`, `Blob`, timers (plugins.js `_loadScope`) | A component has no ambient globals. Each global that does something maps to an interface (rows in 1.3 to 1.6). The rest is the guest language's own library | not planned (by design) |
| 9 | `chrome.manifest`, `aomStartup.registerChrome`, `chrome://` content/skin/locale packages, overlays, XUL/XHTML files, CSS (Zotero 7 dev docs; the compat layer's `registerChrome`) | None. Package files are reached through `fs` root `bundled`, and as `icon-ref.bundled` in UI. UI is declarative data (ui area), so there are no XHTML or CSS files to register | not planned |
| 10 | `rootURI`, `getRootURI`, `resolveURI`, `addon.getResourceURI()`, reading `chrome://` / `resource://` URLs (plugins.js; `Zotero.File.getResource`) | `fs.read` / `fs.read-text` with `root::bundled` and a relative path; `icon-ref::bundled`. No URL scheme | partial (no URIs) |
| 11 | `prefs.js` default prefs, `setDefaultPrefs` / `clearDefaultPrefs` (plugins.js) | manifest `default_prefs`; loaded before `startup`, dropped with the plugin | covered |
| 12 | `locale/<tag>/*.ftl` auto-registration with closest-locale fallback (`registerLocales`) | manifest `locales`; `l10n`; `localized-string` in `types.wit` | covered |
| 13 | `.xpi` zip, install from file or URL, unpacked folder for development | `.zplugin` zip with `manifest.json` at the root; folder load with `dev.watch` in dev mode | covered |
| 14 | Plugin blocklist (`blocked-plugins.json`: `id`, `versionRanges`, `reason`; hard block; built-in plus downloaded copy; `getBlockedPluginReason`) | Host feature with the same data shape. Visible as `plugin-state::blocked` and `plugin-info.state-detail` | covered |
| 15 | Add-on manager: enable, disable, uninstall, update toggle (AddonManager listener in plugins.js) | Settings > Plugins (host feature). The plugin sees the effects as lifecycle reasons | covered |
| 16 | Add-on signing: Zotero disables signature checks | `main.sha256` pinned at install; permission prompt at install. No code signing in 0.1 | partial |
| 17 | `ChromeUtils.registerWindowActor`, XUL overlays, hooking Zotero's DOM from a plugin | None. Zinc's UI is not DOM (ui and extend areas give declarative extension points) | not planned |

### 1.2 Lifecycle

| # | Zotero capability (source) | Zinc WIT | Status |
|---|---|---|---|
| 18 | `REASONS`: APP_STARTUP, APP_SHUTDOWN, ADDON_ENABLE, ADDON_DISABLE, ADDON_INSTALL, ADDON_UNINSTALL, ADDON_UPGRADE, ADDON_DOWNGRADE, MAIN_WINDOW_LOAD, MAIN_WINDOW_UNLOAD (plugins.js) | `lifecycle.reason` | covered |
| 19 | `install(data, reason)` | `lifecycle.install` | covered |
| 20 | `startup(data, reason)` | `lifecycle.startup` | covered |
| 21 | `shutdown(data, reason)` | `lifecycle.shutdown` | covered |
| 22 | `uninstall(data, reason)` | `lifecycle.uninstall` | covered |
| 23 | `onMainWindowLoad({ window })`, `onMainWindowUnload({ window })`, `notifyMainWindowLoad` | `lifecycle.main-window-load`, `main-window-unload` with a `window-id` | covered |
| 24 | Hook parameters `{ id, version, rootURI }` | `lifecycle.plugin-data` (`id`, `version`, `previous-version`). No `rootURI` | partial |
| 25 | A hook may return a promise that Zotero awaits | Every hook runs to completion; time limit per hook (`main.startup_timeout_ms`, default 10 s; 5 s on app shutdown) | covered |
| 26 | Version change flow: `shutdown` and `uninstall` of the old version with UPGRADE or DOWNGRADE, then `install` and `startup` of the new (`_addonObserver.onInstalling/onInstalled`) | Same order and reasons, see 2.2 | covered |
| 27 | Disabled or blocked plugins skip hooks except `shutdown` and `uninstall` (`_callMethod`) | Same rule in the host | covered |
| 28 | `Zotero.initializationPromise`, `Zotero.uiReadyPromise` (plugins start after both in Zinc's compat layer) | `startup` is called only after both; `app.is-ui-ready`, `app.wait-ui-ready` for plugins started later | covered |
| 29 | `Zotero.addShutdownListener` | `lifecycle.shutdown` with `reason::app-shutdown` | covered |
| 30 | `Zotero.Plugins.addObserver` / `removeObserver` (observer gets `install`, `startup`, `shutdown`, `uninstall` of all plugins) | `plugins.observe-plugins`, `plugins.stop-observing-plugins`, `events.on-plugin-event`; needs `plugins.read` | covered |
| 31 | `Zotero.Plugins.getAllPluginIDs`, `getName`, `getIconURI` | `plugins.list-plugins`, `plugins.get-info`, `plugins.get-icon`; needs `plugins.read` for other plugins | covered |
| 32 | `Zotero.Plugins.getPluginFromError`, `warnRemovedAPICall` (stack-based attribution) | None. Each plugin runs in its own Worker, so the host already knows which plugin raised an error | not planned |
| 33 | Update check through AddonManager (`findUpdates`) | `plugins.check-update`. A plugin cannot install an update; the user approves it | partial |
| 34 | "Restart required" / uninstalling state (`onUninstalling`, `onOperationCancelled`) | `plugin-state::uninstalling` | covered |
| 35 | `Zotero.getMainWindows()`, `getMainWindow()`, `getActiveZoteroPane()` | `app.main-windows`, `app.active-window` (ids, not window objects) | partial |
| 36 | `Zotero.version`, `Zotero.appName`, `Zotero.isMac/isWin/isLinux`, `Zotero.locale`, `Services.appinfo` | `app.get-info` (`app-info`: version, API version, claimed Zotero version, platform, arch, locale, time zone, dev flag, feature list) | covered |
| 37 | Plugins calling each other through shared globals (`Zotero.<MyPlugin>`, zotero-plugin-toolkit registries) | None. Components cannot share memory | not planned |

### 1.3 Preferences

| # | Zotero capability (source: prefs.js) | Zinc WIT | Status |
|---|---|---|---|
| 38 | `Zotero.Prefs.get(name)` (relative to `extensions.zotero.`), and `get("extensions.<id>.key", true)` for the plugin's own branch (`true` means the name is absolute) | `prefs.get` on the plugin's own namespace `extensions.<plugin-id>.`; the guest passes the short key | covered |
| 39 | `Zotero.Prefs.get(name, true)` with an absolute name that is not the plugin's own: Zotero's own and Firefox prefs | `prefs.get-app` (read only, allowlist, `prefs.app-read`) | partial |
| 40 | `Zotero.Prefs.set` (creates a pref of the right type; a type mismatch throws) | `prefs.set`, `prefs.set-many` (all or none); `pref-value` is bool, 32-bit int or string | covered |
| 41 | `Zotero.Prefs.set(name, value, true)` on Zotero, Firefox and other plugins' prefs; `Services.prefs` raw branches | None. Zotero had to undo plugins that changed `ui.popup.disable_autohide` (prefs.js migration 13). Zinc settings that plugins may change get a typed call in the area that owns the feature | not planned |
| 42 | `Zotero.Prefs.clear` | `prefs.clear` | covered |
| 43 | `Zotero.Prefs.prefHasUserValue` | `prefs.has-user-value` | covered |
| 44 | `Zotero.Prefs.resetBranch(exclude, branch)` | `prefs.reset(prefix, except)` | covered |
| 45 | `Zotero.Prefs.registerObserver(name, handler, global)` / `unregisterObserver` | `prefs.observe` / `unobserve`; callback `events.on-pref-changed` | covered |
| 46 | Observing Zotero's own prefs | `prefs.observe` with `pref-scope::app` | partial (same allowlist as 39) |
| 47 | `getForWindow`, `setForWindow`, `observeForWindow` (per-window settings) | None. Per-window state is a Zinc detail; a plugin keeps its own per-window state keyed by `window-id` | not planned |
| 48 | Listing a plugin's keys (`Services.prefs.getBranch().getChildList`) | `prefs.get-all(prefix)` | covered |

### 1.4 Localization

| # | Zotero capability | Zinc WIT | Status |
|---|---|---|---|
| 49 | Fluent in plugins: `Localization`, `document.l10n`, `data-l10n-id`, `data-l10n-args` | `localized-string` (`l10n-ref`: id, args, fallback) used by every UI type; `l10n.format`, `format-many`, `has-message` | covered |
| 50 | Locale fallback: exact, same language, en-US, first available (`registerLocales`) | Same chain with the manifest's `locales.default` instead of en-US | covered |
| 51 | One shared L10nFileSource for all plugins, so ids can collide (`PLUGIN_L10N_SOURCE_NAME`) | One bundle per plugin; ids are private | covered |
| 52 | `Zotero.getString(name, params, num)` (Zotero's own `.properties` strings) | None. A plugin ships its own strings | not planned |
| 53 | `Services.locale.requestedLocales`, `Zotero.locale` | `app.get-info().locale`, `l10n.locale`, `events.on-locale-changed` | covered |
| 54 | `Intl.DateTimeFormat` and `Intl.NumberFormat` in the UI language | `l10n.format-date`, `l10n.format-number` | partial (two helpers) |
| 55 | Live re-translation when the locale changes (l10n observes the DOM) | The host resolves `localized-string` at render time; no plugin call needed | covered |

### 1.5 Capabilities Zotero gives freely (gated in Zinc)

| # | Zotero capability (source) | Zinc WIT | Status |
|---|---|---|---|
| 56 | `Zotero.HTTP.request(method, url, options)` (http.js) | `net.send` | covered |
| 57 | Option `body` (string; Zotero also accepts objects as JSON), `headers`, `followRedirects` | `http-request.body` (bytes), `headers` (ordered, case kept, like `CasePreservingHeaders`), `redirect` | covered |
| 58 | Options `timeout`, `successCodes` (array or false) | `timeout-ms`, `success-codes` (none, list, or empty list for any) | covered |
| 59 | Options `responseType` (text, json, arraybuffer, blob), `responseCharset` | Body is always bytes; the guest decodes | covered |
| 60 | `responseType: "document"`, `processDocuments`, `loadDocuments`, `wrapDocument`, `getHTMLMetaRefreshURL` | None. There is no DOM; use an HTML parser library in the guest | not planned |
| 61 | Options `errorDelayIntervals`, `errorDelayMax`, `noRetryOnThrottle` | `retry-policy` (`delays-ms`, `max-total-ms`, `surface-throttle`); default is no retry | covered |
| 62 | Options `username`, `password` | `http-request.credentials` | covered |
| 63 | Options `anon`, `userContextId`, `newCookieContext()` (isolated cookie jars) | `cookie-mode` (`none` or `jar(name)`), `net.list-cookies`, `net.clear-cookie-jar`. Cookies of the user's real sessions are never shared | partial |
| 64 | Option `noCache` / `dontCache` | `bypass-cache` | covered |
| 65 | Option `cancellerReceiver` | `cancel-key` and `net.cancel` | covered |
| 66 | Options `requestObserver` (raw XHR after open), `onAuthorizationHeader`, `foreground` (certificate and login dialogs), `notificationCallbacks`, `debug`, `logBodyLength` | None for the first four; `debug` is the plugin's own `log` call | not planned |
| 67 | Errors `UnexpectedStatusException` (`is4xx`, `is5xx`), `TimeoutException`, `BrowserOfflineException`, `CancelledException`, `SecurityException` | `net-error`: `unexpected-status(http-response)`, `timeout`, `offline`, `cancelled`, `tls`, plus `dns`, `connection`, `too-large`, `blocked` | covered |
| 68 | `Zotero.HTTP.download(url, path, options)`, `Zotero.File.download` (progress callback `onProgress`, inactivity timeout) | `net.download` to a writable `path-ref`; progress through `net-events.on-download-progress` | covered |
| 69 | `fetch()` with a streamed body (`response.body.getReader()`), used by language-model plugins | `net.send-streamed` and the `body-reader` resource | covered |
| 70 | `XMLHttpRequest` events (`upload.onprogress`, `abort`) | `net.send` / `send-streamed` / `cancel` | partial (no upload progress) |
| 71 | `WebSocket`, `EventSource` | None in 0.1. A server-sent-events reply can be read with `send-streamed`. WebSocket needs a host connection object with push events across the process boundary; add it when a plugin needs it | not planned |
| 72 | Legacy `doGet`, `doPost`, `doHead`, `doOptions`, `promise` | `net.send` with the method | covered |
| 73 | `Zotero.HTTP.browserIsOffline()` | `net.is-online` | covered |
| 74 | Proxy authentication, `Zotero.Proxies`, `checkSecurity` dialogs, `triggerProxyAuth` | None. The system proxy is used; the host shows its own dialogs | not planned |
| 75 | Request to any host, including `localhost` and Zotero's local ports | Manifest `permissions.net.hosts`; loopback and private hosts must be listed exactly; Zinc's own server and ports 23119 and 23120 are always refused; redirects and DNS results are rechecked | partial (gated, by design) |
| 76 | `IOUtils.read`, `readUTF8`, `readJSON`; `Zotero.File.getContentsAsync`, `getBinaryContentsAsync` (file.js) | `fs.read`, `read-range`, `read-text` (JSON parsing is the guest's) | covered |
| 77 | `IOUtils.write`, `writeUTF8`, `writeJSON`; `Zotero.File.putContentsAsync` (safe stream) | `fs.write`, `write-text`, `append` with `write-options.atomic` | covered |
| 78 | `IOUtils.exists`, `stat` | `fs.stat` (kind, size, modified) | covered |
| 79 | `IOUtils.getChildren`, `OS.File.DirectoryIterator`, `Zotero.File.iterateDirectory`, `directoryIsEmpty` | `fs.list-dir` | covered |
| 80 | `IOUtils.makeDirectory`, `Zotero.File.createDirectoryIfMissingAsync` | `fs.make-dir` | covered |
| 81 | `IOUtils.remove`, `Zotero.File.removeIfExists` | `fs.remove` | covered |
| 82 | `IOUtils.move`, `Zotero.File.rename` (overwrite, unique), `moveDirectory` | `fs.move` with `conflict` | covered |
| 83 | `IOUtils.copy`, `Zotero.File.copyDirectory`, `copyToUnique`, `moveToUnique` | `fs.copy`; `conflict::rename-unique` | covered |
| 84 | `Zotero.getTempDirectory()`, `createUniqueFile`, `createUniqueDirectory` | `fs` root `temp` and `conflict::rename-unique` | covered |
| 85 | Absolute paths anywhere the user can write (profile, data directory, home, `PathUtils`, `OS.Path`) | None. Roots are `data` (own folder), `bundled`, `temp`, `granted` (user-picked). Path strings are relative and checked | not planned |
| 86 | `Zotero.DataDirectory.dir`, `Zotero.Profile.dir`, `Zotero.getStorageDirectory()` | None. Attachment files go through the library area (`attachments.*`, `library.files.*`) | not planned |
| 87 | `IOUtils.setModificationTime`, `setPermissions`, `openFileForSyncReading`; `Zotero.File.getFileSystemInfo`, `createSymlink`, `setNormalFilePermissions`, `isCloudStorageFolder`, `createShortened`, file locking probes | None | not planned |
| 88 | `Zotero.File.zipDirectory`, nsIZipWriter / ZipReader | None. Zip and unzip on bytes with a library in the guest | not planned |
| 89 | `FilePicker` (nsIFilePicker): open, open multiple, save, folder | `fs.pick-open`, `pick-save`, `pick-directory` (the plugin API's only file dialogs); results are `types.file-grant`s used as `root::granted(id)` and read with `fs.read` / `fs.write`; `fs.list-grants`, `release-grant` | covered |
| 90 | Pure path and string helpers: `PathUtils.join`, `Zotero.File.getValidFileName`, `truncateFileName`, `pathToFileURI`, `normalizeToUnix`, `generateDataURI` | None. The guest does these (paths are relative strings; the host normalizes on use) | partial |
| 91 | `setTimeout`, `clearTimeout` | `timers.set-timeout`, `clear`; callback `events.on-timer` | covered |
| 92 | `setInterval`, `clearInterval` | `timers.set-interval`, `clear` | covered |
| 93 | `requestIdleCallback`, `cancelIdleCallback` | `timers.request-idle`, `clear` | covered |
| 94 | `Zotero.Promise.delay(ms)`, `await` on a timer | `timers.sleep` | covered |
| 95 | `Date.now()`, `performance.now()` (a plugin has no WASI clock) | `timers.now`, `timers.monotonic-ms` | covered: the guest has no WASI clock, so the JS SDK supplies `Date` (and `performance.now`) from `timers`; Rust plugins call `timers` directly |
| 96 | `ChromeWorker`, `Worker` (threads) | None. A plugin is one single-threaded component; split long work into steps with `timers` | not planned |
| 97 | `Zotero.Utilities.Internal.copyTextToClipboard`, nsIClipboard writes (text, HTML, image) | `clipboard.write` (`clipboard.write`; the only clipboard write in the API) | covered |
| 98 | nsIClipboard reads | `clipboard.read` (`clipboard.read`; focused window; first read confirmed per session; the only clipboard read in the API) | covered |
| 99 | `Zotero.launchURL(url)` | `shell.open-url` (`shell.open-url`; other schemes need `permissions.shell.schemes` and a first-use prompt; the only way to open a URL, `ui` has none) | covered |
| 100 | `Zotero.launchFile(file)` | `shell.open-file` (`shell.open-file`; executables and scripts refused; only own, temp and granted files) | partial |
| 101 | `Zotero.File.reveal(file)` | `shell.reveal` (`shell.reveal`) | covered |
| 102 | `Zotero.launchFileWithApplication`, `Zotero.Utilities.Internal.exec`, `subprocess`, nsIProcess, native messaging | None. See 2.4 | not planned |
| 103 | `Zotero.debug(msg, level)`, `Zotero.warn` | `log.write` with `log-level` | covered |
| 104 | `Zotero.logError(e)` | `log.write-error` | covered |
| 105 | `Zotero.Debug.enabled` | `log.debug-enabled` | covered |
| 106 | `Zotero.Debug.get`, `setStore`, debug output submission | None. These are the user's tools (Help > Debug Output) | not planned |
| 107 | `Zotero.Utilities`: `cleanDOI`, `cleanISBN`, `toISBN13`, `cleanISSN`, `capitalizeTitle`, `text2html`, `unescapeHTML`, `semverCompare` | `util.clean-doi`, `clean-isbn`, `clean-issn`, `capitalize-title`, `text-to-html`, `html-to-text`, `semver-compare`. Dates, CSL and the Extra field are in `library.data-utils` | partial (curated; the rest is pure and left to the guest) |
| 108 | `crypto.getRandomValues`, `crypto.randomUUID`, `Zotero.Utilities.Internal.md5`, `crypto.subtle.digest` | `util.random-bytes`, `uuid-v4`, `hash` (md5, sha1, sha256, sha512) | partial (no HMAC, signing or encryption) |
| 109 | `DOMParser`, `XMLSerializer`, `TextEncoder`/`TextDecoder`, `URL`, `btoa`/`atob`, `Blob`, `File`, `FileReader` | The guest language's own libraries | not planned |
| 110 | `Services.logins` / login manager for API keys (kept in clear text in prefs by many plugins) | `secrets.get`, `set`, `delete`, `list-names` (OS credential store, per plugin). Zinc addition | covered |
| 111 | `Services.startup.quit`, `restart`, `Services.appShell`, `Services.wm`, `Services.io`, `Services.scriptloader`, `Services.console` | None for quit and restart (a plugin must not close Zinc); windows are in `app` and `extend`; the rest is not applicable | not planned |
| 112 | `Components.classes`, `Cc`, `Ci`, `Cu`, `ChromeUtils.importESModule` of Zotero or Firefox modules, `Cu.Sandbox` | None | not planned |
| 113 | `Zotero.alert`, `Zotero.ProgressWindow`, `Services.prompt` | Owned by the ui area, which is the one owner of dialogs and prompts (`ui.alert`, `confirm`, `prompt`, `open-dialog` with its `close` event, `show-toast`); extend has none. Counted in the ui table | covered (other area) |
| 114 | Zotero has no permission checks | `permissions.check`, `list-permissions`, `request`; `events.on-permission-changed`. Zinc addition, see section 3 | covered (new) |

Counts for this area, tallied by script from the status column: 114 rows; **covered 77, partial 15, not planned 22**. Row 113 (dialogs, owned by the extend and ui areas) and row 114 (permissions, a Zinc addition) are counted as covered.

## 2. Design notes

### 2.1 One process boundary, so few and coarse calls

Plugins run in a separate plugin host process (`zhw`, Wasmtime), one instance per plugin. Every host call crosses it. In this area that has three effects:

- Calls that are hot or chatty (`log.write`, `prefs.get`, `l10n.format`, `timers.now`) are served inside the plugin host process from a copy, with batched write-back. The WIT still looks like a plain call. A log line is not a round trip.
- Calls that really cross (`net.send`, `fs.*`, `permissions.request`) take whole values and return whole values. There is `prefs.set-many`, `net.send-many` (up to 16 requests), `l10n.format-many`, `prefs.get-all`.
- Time limits are explicit. A hook has 10 s. A hung plugin is stopped alone (Wasmtime epoch interruption) and marked `disabled`; the other plugins keep running and the host process is not restarted.

### 2.2 Lifecycle in order

```
first install        install(addon-install) -> startup(addon-install)
app start            startup(app-startup)
user disables        shutdown(addon-disable)
user enables         startup(addon-enable)
user uninstalls      shutdown(addon-uninstall) -> uninstall(addon-uninstall) -> data and prefs removed (unless kept)
new version          old: shutdown(addon-upgrade|downgrade) -> uninstall(same reason)
                     new: install(same reason) -> startup(same reason)       (data and prefs stay)
app quit             shutdown(app-shutdown), 5 s limit
extra window opens   main-window-load(window)       existing windows: use app.main-windows() in startup
```

Notes:

- Zotero runs the same sequence (plugins.js `onInstalling`, `onInstalled`, `onEnabling`, `onDisabled`, `onUninstalling`). `startup` runs after the library is open and the UI is ready, so plugins never wait on `initializationPromise` or `uiReadyPromise`. This is also what the compat layer already does.
- After `shutdown` the host removes everything the plugin still has: registrations of all areas, timers, pref and notifier subscriptions, in-flight requests, open readers and grants that were not persistent. A plugin that forgets to clean up leaves nothing. This is stronger than Zotero, where a forgotten element stays in the window.
- `startup` failing returns the plugin to `failed` and runs the same cleanup. Zinc does not call `shutdown` then.
- A plugin can be woken lazily (`activation_events`, `contributes`). `onStartup` is the default, which keeps Zotero behaviour. Lazy start matters because a Rust plugin costs about 107 MB of resident memory and a QuickJS plugin about 118 MB in the spike; ten idle plugins should not cost a gigabyte.

### 2.3 Package and manifest

A plugin is a zip named `<name>-<version>.zplugin`:

```
manifest.json
plugin.wasm            the component
icons/ ...             referenced by manifest `icons` and by UI `icon-ref.bundled`
locale/en-US/*.ftl     Fluent files; one folder per language
...                    any other asset the plugin reads with fs root `bundled`
```

`manifest.json` keeps Zotero's field names where they exist (see table 1.1). A short example:

```json
{
  "manifest_version": 1,
  "id": "citation-lookup@example.org",
  "name": "Citation Lookup",
  "version": "1.2.0",
  "description": "Looks up cited-by counts.",
  "icons": { "48": "icons/lookup.svg" },
  "zinc": { "api_version": "0.1", "min_version": "0.9.0" },
  "main": { "wasm": "plugin.wasm", "language": "rust" },
  "activation_events": ["onUiReady"],
  "update_url": "https://example.org/citation-lookup/updates.json",
  "permissions": {
    "capabilities": ["library.read", "library.write"],
    "net": { "hosts": ["https://api.openalex.org", "https://api.crossref.org"] }
  },
  "permission_reasons": {
    "library.write": "perm-library-write",
    "net.hosts": "Reads citation counts from OpenAlex and CrossRef."
  },
  "default_prefs": { "autoLookup": true, "maxResults": 25, "email": "" },
  "locales": { "default": "en-US" },
  "contributes": {
    "commands": [{ "id": "lookup", "title_l10n": "cmd-lookup", "icon": "icons/lookup.svg" }]
  }
}
```

Choices and why:

- The manifest carries the facts the host needs before it runs the component: id, versions, permissions, locales, default prefs, activation. It can then show an install prompt, a placeholder column or a Settings entry without starting the plugin.
- `zinc.api_version` is `MAJOR.MINOR`. Until 1.0 the minor must match, because 0.x may break between minors. A mismatch gives `plugin-state::incompatible`.
- `zinc.max_version` exists but is not enforced by default (row 3).
- `main.sha256` pins the component. The host checks it at install and at each load.
- `contributes` is a hint, not a replacement for runtime registration. Its entries share `id`, `title_l10n`, `icon`, `accelerator` and `when`; the owning area adds its own fields. This stays loose in 0.1 on purpose, because the ui, extend and reader areas are still moving.
- Update manifest: Zotero's `updates.json` shape, so existing update servers and tools (for example `zotero-plugin-scaffold`) can emit it with an `applications.zinc` key. `update_link` must be https and `update_hash` is required.

### 2.4 Permissions: declared, asked, denied

Zotero gives a plugin the whole app. Zinc cannot, because a plugin in WASM has no ambient authority, and because the plugin store implies code from people the user does not know. The model has three layers:

1. **Declared in the manifest.** `permissions.capabilities` lists ids, `permissions.net.hosts` lists hosts, `permissions.shell.schemes` lists extra URL schemes. `optional_permissions` lists ones the plugin may ask for later. `permission_reasons` explains each in the plugin's words.
2. **Asked of the user.** At install Zinc shows the list grouped by risk, with the reasons. Low risk ones are granted together; medium ones are separate checkboxes; high risk ones are off until ticked and shown in red. An upgrade that adds a permission stops at `plugin-state::disabled` until the user approves. At run time Zinc asks again only for: `clipboard.read` (first read per session), a new URL scheme in `shell.open-url`, and `permissions.request` for optional ones. Prompts need a focused Zinc window and a user action in the last 10 s, so a plugin cannot open dialogs from a timer.
3. **Denied by default, checked at call time.** Anything not declared returns `error::permission-denied(<id>)`. Calls are checked when made, not when the component links. This is needed because a component built for the full `plugin` world imports every interface even if it never calls it; a link-time check would refuse everyone. A plugin that wants a small footprint can target `plugin-minimal`.

Risk tiers (the same list is in the schema as `x-risk`):

| Tier | Ids (lifecycle area) | Ids used by other areas as of this writing |
|---|---|---|
| none (always allowed) | `prefs` (own), `secrets` (own), `l10n`, `log`, `timers`, `util`, `fs` roots `data`, `bundled`, `temp` and `granted`, `app`, own `plugins.self-info`, declarative UI | extend and ui registrations |
| low | `clipboard.write`, `shell.open-url`, `shell.reveal` | `library.read`, `library.fulltext.read`, `library.cite`, `library.cite.styles`, `ui.theme`, `ui.navigate`, `reader.ui`, `reader.themes`, `note-editor.control`, `note-editor.ui` |
| medium | `net.hosts` (a list of named hosts), `plugins.read`, `prefs.app-read` | `library.write`, `library.trash`, `library.files.read`, `library.files.paths`, `library.translate`, `library.sync`, `library.fulltext.write`, `ui.windows`, `ui.drop`, `reader.read`, `reader.control`, `annotations.read`, `annotations.write`, `note-editor.read`, `note-editor.write` |
| high | `net.hosts` containing `*` or a loopback or private host, `clipboard.read`, `shell.open-file` | `library.erase`, `library.files.write`, `library.files.open`, `ui.webview` |

The schema's `examples` and `x-risk` hold all 36 ids (the ids of this area, the 14 `library.*`, the 5 `ui.*`, and the 10 of the reader area). They are all dotted. Removed in the reconcile because the user's pick is the consent or another id already covers it: `ui.pick-files`, `ui.file-dialogs`, `ui.clipboard-read`.

Always refused, with no permission that unlocks them:

- running a program or loading native code (`subprocess`, `exec`, `launchFileWithApplication`, native messaging, `ctypes`);
- raw sockets and any request to Zinc's own server or to ports 23119 and 23120;
- reading or writing outside the four file roots, other plugins' data, Zinc's settings database, the user's library file on disk;
- reading the host environment, the process list, stdin and stdout;
- quitting or restarting Zinc, or changing its security settings.

Subprocess and native code are **not planned** (rows 87, 102, 112). A native call defeats every other check in this table, and Zinc cannot see what it does. A plugin that needs a tool should call a web service it names in `net.hosts`, ship the work as WASM, or ask the user to run the tool.

The network rule has some detail worth keeping: loopback and private ranges are checked after DNS resolution, so a public name that resolves to `127.0.0.1` is refused unless that exact host and port is listed. A local language-model server such as `http://localhost:11434` is a normal use and must be listed; the high-risk label shows it to the user.

### 2.5 Files without paths

A plugin names a file by `{ root, path }`. The host resolves it and refuses `..`, absolute paths, drive letters, reserved Windows names and symlinks that leave the root. Four roots cover what Zotero plugins do in practice:

- `data`: private, read and write, 512 MiB quota, replaces writes into the Zotero profile or data directory;
- `bundled`: read only, replaces `chrome://` reads;
- `temp`: emptied at start;
- `granted(id)`: a file or folder the user gave the plugin, in a dialog (`fs.pick-*`) or by dropping it on a drop target. All three produce the same `types.file-grant`, whose `id` is the `granted` id; `ui.drop-info.files` and `extend.drop-payload.files` carry it, and `fs.read`, `fs.read-range`, `fs.write` turn it into bytes. The pick or drop is the consent, so it needs no permission, and no area has a separate dialog or a separate id for it.

Attachment files are not a root here; they belong to `library.wit` (`attachments.*` with the `library.files.*` permissions), where the host can also update hashes and sync state. A plugin that needs to move bytes between an attachment and its own folder reads with `attachments` and writes with `fs`.

### 2.6 Strings

Plugins ship `locale/<tag>/*.ftl`. The host keeps one Fluent bundle per plugin and picks the language with the chain Zotero builds (exact, same language, default, first). The type `localized-string` in `types.wit` is the way any UI or registration says "show this text":

```
variant localized-string { plain(string), localized(l10n-ref) }
record l10n-ref { id, args: list<name-l10n-arg>, fallback: option<string> }
```

`id` may be `message.attribute` to read a Fluent attribute. The host resolves it when it draws, so changing the UI language updates every visible label without a call into the plugin. `l10n.format` gives a plugin the same resolution as a string for the cases where it needs text itself.

### 2.7 Prefs and secrets

`prefs` is a flat key to `pref-value` store, namespaced `extensions.<plugin-id>.`, with the three Firefox types. Defaults come from the manifest. A key that has a default keeps its type, which removes a class of bugs that Zotero's `Prefs.set` hides by creating a new pref of a different type. Reads are served from a local copy in the plugin host process, so `get` is free; `set` writes through. Observing is by subscription id and callback (`events.on-pref-changed`).

Zotero's `global` flag, which lets a plugin read and write any pref in the application, is replaced by `get-app` (read only, allowlisted) and nothing for writes (row 41). The allowlist is the list of Zinc settings that a plugin has a real use for, such as the UI language, theme, and default library; the settings owner area fills it in phase 2.

UI bindings: a control bound to a pref (`ui.node-props.pref`, and the `pref`, `toggle` and `choice` fields of `extend.setting-row`) is read and written by the host with the same rules as `prefs.get` and `prefs.set`, with no call into the plugin. The type of the default is enforced; `events.on-pref-changed` fires for the plugin's own observers. The doc comment of the `prefs` interface says which control binds to which type (`flag` for switches and checkboxes, `text` for selects, radios, colours and text, `integer` for number controls, or `text` for a fractional step). A pref bound to a `secret` text setting is stored in `secrets` under "pref:<key>" and `prefs.get` returns none for it.

API keys are a different problem. Many Zotero plugins keep them in prefs in clear text. `secrets` stores them in the operating system's credential store under the plugin, with no log output, and removes them with the plugin.

### 2.8 Net, in the shape of `Zotero.HTTP.request`

`net.send` takes one record whose fields follow the options of `Zotero.HTTP.request` one to one (rows 56 to 65). The differences are deliberate: bodies and responses are bytes (the guest has JSON and text libraries; WIT has no good "object" type); retrying is off unless asked; the cookie jar is the plugin's own; a status outside `success-codes` is returned as `err(unexpected-status(response))` so the plugin sees the body, as with `UnexpectedStatusException.xmlhttp`.

Large and streamed bodies go through `net.download` (to a file) and `net.send-streamed` (a `body-reader` resource with `read` and `close`). The resource is the only one in this area; it exists because a streamed reply has a lifetime and cannot be a list. Rust and JS guests both handle resources.

### 2.9 Rust and JS ergonomics

- Records, variants, enums, lists, options, and `result<_, error>`. One error variant for everything (`types.error`), plus `net-error` where HTTP needs more.
- Names avoid WIT keywords. (`own`, `package`, `static`, `stream`, `future`, `list` as a function name and similar; `own` is a case of `pref-scope` here only as `plugin-own`.)
- Async host imports are assumed (JSPI). Calls that wait (`net.send`, `timers.sleep`, `permissions.request`) are written as normal functions. Whether a plugin's other callbacks may run while one waits is a phase 2 decision (see open questions).
- Two worlds: `plugin` has everything, `plugin-minimal` has prefs, strings, log, timers, extend and ui, for the many plugins that only add UI.

## 3. Permission ids owned by this area

`library.*` ids belong to the library area (14), `ui.*` ids to ui and extend (`ui.webview`, `ui.windows`, `ui.theme`, `ui.drop`, `ui.navigate`), and `reader.*`, `annotations.*` and `note-editor.*` ids to the reader area (10); the table lists the ids this area defines.

| Id | Needed by | Tier |
|---|---|---|
| `net.hosts` (a list, not an id on its own) | `net.*`, and any other area's call that makes Zinc fetch a URL for the plugin | medium; high with `*`, loopback or private hosts |
| `clipboard.write` | `clipboard.write` | low |
| `clipboard.read` | `clipboard.read` | high, plus a first-use prompt |
| `shell.open-url` | `shell.open-url` for http, https, mailto | low |
| `shell.open-file` | `shell.open-file` | high |
| `shell.reveal` | `shell.reveal` | low |
| `plugins.read` | `plugins.get-info`, `list-plugins`, `get-icon`, `observe-plugins` (other plugins) | medium |
| `prefs.app-read` | `prefs.get-app`, `prefs.observe` with `app` | medium |

Not permissions, because they are always allowed: `prefs` (own), `secrets`, `l10n`, `log`, `timers`, `util`, `app`, `fs` roots `data`, `bundled`, `temp`, `granted`.

## 4. Open questions for the user

1. **Reentrancy while a call waits.** If a plugin is inside `net.send` (suspended by JSPI), may the host call another export of the same plugin, such as a menu command or an item pane render? If not, a slow request freezes every UI callback of that plugin. If yes, plugin authors must handle interleaving. The guest-side component model support for this is the open point. Until decided, `timers.sleep` and long awaits are described as "other callbacks may not run".
2. **Code signing and a store.** 0.1 pins a hash and shows a permission prompt, nothing more. Should phase 2 add publisher signatures, or an allowlisted registry, before a plugin can be installed from a URL?
3. **Lazy start by default?** `onStartup` keeps Zotero behaviour but costs about 110 MB per plugin. Should plugins that list `contributes` start lazily by default, with `onStartup` as an explicit opt-in?
4. **Zotero ports.** Should the Zotero-compat layer (the JS sandbox in `zotero-plugins`) keep running in parallel, or does a ported plugin use a shim that maps `Zotero.*` calls onto these WIT imports at build time? This decides how much of the `Zotero.Prefs.get(name, true)` style access has to exist.
5. **App prefs allowlist.** Which Zinc settings may a plugin read with `get-app`, and may any be written through a typed call (for example "default citation style")?
6. **Plugin data on uninstall.** Delete `data` and prefs by default, or keep them like Zotero (which keeps prefs)? The design deletes unless the user ticks "keep my data". Is that right?
7. **WebSocket.** Is a WebSocket or SSE push channel needed for 0.1? Language-model plugins work with `send-streamed`; collaboration plugins would need sockets.
8. **External viewers.** `launchFileWithApplication` is used by "open PDF in SumatraPDF" style plugins. Allow a user-chosen external program per file type as a Zinc setting that plugins can only trigger, not set?

## 5. Needs from other areas

Resolved in the reconcile of 2026-11-18 (see README): one clipboard (`clipboard`), one URL opener (`shell.open-url`), one set of file dialogs (`fs.pick-*`) with one grant type (`types.file-grant`, read with `fs.read`); the ui and extend areas have none of them. Extend's placeholders are replaced by the real ui types. Permission ids are all dotted and all in the schema (36 ids). Every area's `app-info.features` ids are listed in the doc comment of `app.app-info`. `types.window-id` is the window type in extend and reader; ui has no windows of its own other than `open-window` instances.

Still open:

- **App prefs allowlist (reader and library asked for it).** Which Zinc settings `prefs.get-app` may read: library wants `extensions.zotero.autoRenameFiles` and `export.quickCopy.setting`; reader wants the `reader.*` prefs (font size, text selection mode, auto-disable tools, themes). Same as open question 5. Open.

## 6. WIT check

The whole package parses with jco, for both worlds, at the time of the last run (after the other areas' files settled):

```bash
bunx @bytecodealliance/jco types plugin-api/wit --world-name plugin -o "$TEMP/zn-wit-check-lifecycle"
bunx @bytecodealliance/jco types plugin-api/wit --world-name plugin-minimal -o "$TEMP/zn-wit-check-lifecycle-min"
```

This area's files also parse alone, with a world that holds only their interfaces. `manifest.schema.json` was checked to be valid JSON and its regular expressions to compile; no JSON Schema validator was run against a sample manifest (none is installed and `bun install` is not allowed in this phase).
