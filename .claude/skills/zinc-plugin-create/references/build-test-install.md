# Build, test, package, install

Contents: build; testing with the supervisor; what a test must never touch; packaging; installing and dev loading; the runner.

## Build

```bash
bun plugin-api/sdk/js/scripts/build.ts   <plugin dir> [--out <dir>]      # JS: bundle the SDK in, componentize-qjs   (~6 s)
bun plugin-host/scripts/build-plugin.ts  <plugin dir> [--out <dir>]      # Rust: cargo build --release --target wasm32-wasip2 (~40 s cold, ~15 s warm)
```

(Run from the Zinc checkout, or use absolute paths.) Output, default `<dir>/dist`, or `--out`: `manifest.json` (copy of yours with `main.wasm`, `main.language` and `main.sha256` set), `plugin.wasm`, and copies of `locale/`, `icons/`, `assets/`. Build to a scratch `--out` outside the plugin source tree when testing.

Needs: Bun; `plugin-host/node_modules` (componentize-qjs, and jco for the SDK type generator; if it is missing, tell the user and do not install into `gpui-ui/` or `core/`); for Rust, the `wasm32-wasip2` target (`rustup target add wasm32-wasip2`) and plenty of free disk (the sample test refuses below 9216 MiB free on the `%TEMP%` drive). Cargo uses the shared target dir from the environment (`CARGO_TARGET_DIR`): do not set another one or per-plugin profile flags. The build script finds `cargo` itself if it is not on PATH.

Typecheck JS: the scaffold's `tsconfig.json` includes the SDK types (`bun plugin-api/sdk/js/scripts/gen-types.ts` writes them from the WIT once); then `bun check` in the plugin dir. Types are advisory: componentize does not read them.

A build error from `componentize-qjs` about a missing export means the world exports an interface your `export const { ... } = plugin;` line does not name (add its camelCase name). A Rust error naming `Guest is not implemented for Glue<...>` means the SDK lags the WIT: that is an SDK bug, not yours.

## Test through the supervisor (stub imports, throwaway)

`samples/test.ts` shows the method: build, load with `createPluginSupervisor` and stub `where: "zinc"` handlers that record calls, `sup.call(id, iface, fn, args)`, assert on the recorded calls. This skill packages it:

```bash
bun .claude/skills/zinc-plugin-create/scripts/smoke.ts <built dir>                       # load, run startup, list what the plugin registered
bun .../smoke.ts <built dir> --call extend-handlers.on-menu-command '["my-menu","my.hello",null,{"window":1,"tab":{"id":"library","kind":"library"},"rows":[],"items":["AAAA1111"],"itemCount":1,"itemsTruncated":false,"editable":true}]'
bun .../smoke.ts <built dir> --call ui-events.mount '[1,{"view":"my-section","surface":"item-pane-section","params":"{\"itemKey\":\"AAAA1111\"}","theme":"light","locale":"en-US"}]'
```

It prints each call's result and every import the call made, and checks returned UI trees against `ui-tree.schema.json`; exit code 1 on failure. In `--call` JSON, `null` becomes `undefined` (an absent option) and `"123n"` a BigInt.

For real assertions copy `assets/plugin.test.ts`, edit the ids, and run `BUILT=<out> bun test plugin.test.ts`. It imports from `scripts/smoke.ts`: `openPlugin(dir, answers)` returns `{ call, calledWith, calls, sup, shutdown }`, and there are builders `menuContext`, `viewContext`, `uiEvent`, `closeDialog` (delivers the two `close` events a dialog sends), `itemSummary`, `checkRender`. Answer the imports your plugin uses in the `answers` map (`"library.query-items": () => ({ total: 0n, items: [] })`); `DEFAULT_ANSWERS` already covers registrations, prefs, timers and toasts. An import without an answer reaches the plugin as `error::unavailable`, which is also something a test can assert.

Values are jco values: camelCase fields, enums as strings, variants `{ tag, val }`, options as the value or `undefined`, `u64` as BigInt (instance ids too: pass `1n`). Every required record field must be present in arguments you hand in. Callback `rev` is a BigInt.

What a test cannot show: how the tree looks, real library data, real permission prompts. For those, run Zinc itself (below), against a throwaway profile.

## What tests must never touch

The user's real library and the real core: ports 23119 and 23120, the user's profile, `%APPDATA%\zotero-next-gpui`. The supervisor-with-stubs method touches none of them. If you run the app to look at the plugin, use a throwaway profile and core on other ports and a scratch `ZN_PLUGINS_DIR`, and do not drive the user's screen. If you cannot do that, stop at the supervisor test and say so.

## Package

```bash
bun .claude/skills/zinc-plugin-create/scripts/pack.ts <built dir> [--out <file or dir>]    # -> <id>-<version>.zplugin
```

A `.zplugin` is a zip with `manifest.json`, `plugin.wasm`, `locale/`, `icons/`, `assets/`. The script validates the manifest against the schema and the permission rules, checks the hash, leaves out `transpiled/` and `target/` (the installer ignores a shipped `transpiled/` on purpose and prepares its own), and reads the zip back with the installer's reader. Zip limits: 5000 entries, 128 MiB per entry, 256 MiB total.

## Install and dev loading

- **Installer** (`plugin-host/src/package/installer.ts`, `PluginManager.installPackage(path | bytes)` / `installDir(folder)`): checks the zip, the manifest, `zinc.api_version` compatibility, the hash, asks for permission approval (`groups` of low, medium, high ids; optional permissions are never granted at install), precompiles into a per-machine `.cwasm` cache, writes `installed/<id>/` under the plugins root (`%APPDATA%\zotero-next-gpui\plugins`, or `ZN_PLUGINS_DIR`), then runs `install` and `startup`. An update that adds permissions stays disabled until approved. In this tree Settings > Plugins has the on/off switch (`shell.wasmPlugins`) but no install button yet; call the manager from code (with a scratch `ZN_PLUGINS_DIR`) or ask the user how they want to install.
- **Dev loading** into a running app: `ZN_WASM_PLUGINS=1 ZN_WASM_PLUGIN_DIRS=<built dir>[;<more>]` (path-list separator of the OS). The folders load as they are, with the permissions their manifests declare, and no package manager. Restart the app after a rebuild. Never aim this at the user's live app without asking.
- **Uninstall** removes `data/<id>`, prefs and secrets unless the plugin says otherwise; the `uninstall` hook runs first.

## Runner

Plugins run in Wasmtime (`zhw`, `plugin-host-wasmtime`); the component is precompiled to `.cwasm` (a per-machine cache keyed by wasm hash, `zhw` version and engine settings; if missing, `zhw` compiles at load, 0.2 to 2 s). Cold start is tens of milliseconds and a stuck plugin stops alone. Wasmtime is the only runner (the Bun Worker runner was removed). `smoke.ts` needs the `zhw` binary (`resolveZhwPath`: `ZHW`/`ZN_ZHW`, next to the executable, `plugin-host-wasmtime/target/release`, `gpui-ui/out`, the shared target dir); build it with `cd plugin-host-wasmtime && cargo build --release` if it is missing and the user wants it. If `zhw` fails for reasons outside your plugin (the host code is under active change), report it and test with stubs in `plugin-api/samples/test.ts` style.
