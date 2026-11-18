# Phase 2, core agent: the plugin host

Status 2026-11-18. Package: [`plugin-host/`](../../../plugin-host/). Tests: 15 pass (`bun test` in `plugin-host/`, about 7 s plus the fixture build), `bun check` clean.

## What was built

| File | What it is |
|---|---|
| `plugin-host/package.json`, `tsconfig.json`, `bun.lock` | Bun package. Dependencies: `@bytecodealliance/jco` 1.42 and `componentize-qjs` 0.6 (the QuickJS guest compiler the spike used; its npm name has no `@bytecodealliance` scope). One `bun install`, done here. |
| `src/protocol.ts` | The IPC messages (Zinc to host process, host process to Worker), `WireError`, `PluginError`, default timeouts. |
| `src/supervisor.ts` | `createPluginSupervisor(opts)`. Runs in the Zinc process. Spawns the host with Bun IPC, time budgets, heartbeat, restart and disable logic, answers `where: "zinc"` imports. |
| `src/host-main.ts` | The plugin host process entry. One Worker per plugin, import routing, `where: "host"` handlers, heartbeat. |
| `src/worker.ts` | One per plugin. Loads the jco output, builds the `zinc:plugin/*` imports (async functions that forward to the host), runs exports, WIT resources as classes. |
| `src/wasi-stubs.ts` | Every `wasi:*` import. No preview2-shim. |
| `src/imports/registry.ts`, `README.md` | The handler contract (`ImportHandler`, `HandlerContext`, `witError`, `discoverHandlers`, `HandlerTable`). Nothing else is in that folder. |
| `src/router.ts`, `names.ts`, `manifest.ts`, `wit.ts`, `index.ts` | Handler call wrapper; name normalisation; the loadable-folder layout and manifest reader; the WIT function lister; public exports. |
| `scripts/build-plugin.ts` | `bun scripts/build-plugin.ts <plugin dir> [--out dir] [--world name] [--js file]`. |
| `test/` | `supervisor.test.ts`, `units.test.ts`, `helpers.ts`, `handlers/prefs.host.ts`, `fixtures/hello-rust`, `fixtures/spin-rust`, `fixtures/hello-js`. |

## Which process starts the plugin host

**The Zinc app process creates the supervisor, and the supervisor spawns the plugin host.** Read of `architecture.md`: the UI (`gpui-ui`), the core and the in-process services all run in one Bun process (`zotero-next-gpui.exe`). The spike said "started by core". In this architecture core is a module inside the app process, not a separate service, and three of the five interface families that plugins need (`ui`, `extend`, `reader`, plus `clipboard` and `shell`) can only be answered by code that holds the UI. If the supervisor lived in `core/`, every one of those calls would need a second hop from core to the UI. So:

- `gpui-ui` (for example `src/platform.ts` next to the other background workers) creates the one supervisor: `createPluginSupervisor({ importHandlers: await discoverHandlers("zinc"), coreUrl, ... })`. Core does not import it.
- `where: "zinc"` handlers run in that process and can import UI and core modules directly.
- `where: "host"` handlers run in the plugin host process and reach core through HTTP, `coreUrl` (`http://127.0.0.1:<port>`; the in-process core already serves the API on its own port).
- The supervisor has no GPUIX, Solid or core import, so either side can drive it. A headless build (the connector host, an MCP-only core) can create one with only host handlers. The same module works unchanged.

Packaged builds: `process.execPath` is the Zinc executable, not `bun`. The supervisor spawns `[process.execPath, host-main.ts]` with `BUN_BE_BUN=1`, which makes a `bun build --compile` executable behave as `bun`. **This is not verified** (tests run under plain Bun). If it does not work, pass `runtime: ["<path to a bun executable>"]`.

## How it works

```
Zinc process                          plugin host process (bun host-main.ts)          Worker (one per plugin)
 supervisor  --Bun IPC (advanced)-->   main thread                      --postMessage-->  worker.ts
   where:"zinc" handlers   <--import--   where:"host" handlers (HandlerTable)   <--import--   jco instance (JSPI)
```

- **Layout of a plugin** (`src/manifest.ts`): `manifest.json`, `plugin.wasm`, `transpiled/plugin.js` (+ core wasm). `build-plugin` writes it; the future installer must write the same. The schema forbids extra keys in `main`, so the transpiled entry is by convention.
- **Imports.** jco calls `imports["zinc:plugin/prefs"].get(...)` (keys with or without `@version` work). The Worker answers with an async function that posts `{t:"import", iface, fn, args}` to the host main thread. If the host has a handler for that interface and function, it runs there; otherwise the call goes to Zinc. No handler anywhere: `error::unavailable("unsupported: no handler for ...")`. Function names are camelCase on the wire; handlers may be written kebab or camel.
- **Errors.** A handler throws `witError(tag, text)`, which jco turns into `result::err({tag, val})` in the plugin. Other exceptions become `internal(...)`. Exports that return `result::err` reject `supervisor.call` with `PluginError` of kind `"wit"` and `.payload`.
- **Resources.** `net.body-reader` and `attachments.file-writer` are WIT resources. The Worker makes jco classes whose instances hold a handle; methods become `[method]body-reader.read` imports; handlers declare `resources` (see `src/imports/README.md`). Tested with both (guest-made and host-made).
- **Time budgets** (`protocol.ts`): exports 5 s, `startup`/`install`/`shutdown`/`uninstall` 10 s (the manifest's `main.startup_timeout_ms` overrides), load 15 s, `shutdown` at most 5 s; all configurable. A budget counts only the time the plugin is running: while it waits in a host import (host or Zinc side) its timers stand still, so `net.send` or `ui.run-dialog` never causes a kill. (A plugin that loops over cheap imports forever is therefore never killed; add a call count limit if that matters.) The supervisor polls every 25 ms.
- **Stuck plugin.** On a timeout the supervisor: emits `host-restart`, marks the plugin `disabled` with the reason (`"events#on-timer exceeded 400 ms (the plugin host was restarted)"`), rejects its call with kind `"timeout"` and the other in-flight calls with `"host-restarting"`, kills the host (the old pid is dead, checked in the test), starts a new one, reloads every other plugin and starts again those that were running, then emits `host-restarted { reloaded, disabled }`. A second timeout during the reload kills the host again and is handled the same way. More than 5 restarts in 60 s: `host-failed`, plugins marked failed.
- **Other failures.** Heartbeat from the host every 1 s, a 5 s silence restarts it (a blocked handler, not a runaway plugin: that does not stop the main thread). The host process exiting restarts it. A component trap (panic) marks that plugin `failed` and unloads its Worker (the instance is poisoned); the host stays.
- **WASI** (`wasi-stubs.ts`): environment empty, no preopened directory (so `std::fs` fails with an error), no terminal, no sockets or http (traps with "WASI is not available to Zinc plugins"), `exit` traps, `poll` and clock subscriptions trap. Allowed because Rust std and QuickJS need them to start: clocks, random, stdin (empty), stdout and stderr (lines go to the supervisor's `log` event as `[stderr] ...`). QuickJS guests are built with `--stub-wasi`, so their component has no WASI imports at all.
- **Re-entrancy (README open question 1).** Tested: while a Rust (JSPI) plugin's `startup` is suspended in `timers.set-timeout`, the handler called `events.on-timer` on the same instance; it ran, returned, and `startup` continued afterwards. So a plugin may be re-entered from a handler, and the `ui` area need not drop its waiting calls. Verified only for a single-threaded Rust guest and the QuickJS sync runtime in these tests. The supervisor does not serialise calls to one plugin.

## Run it

```bash
cd plugin-host
bun install                      # already done; never in gpui-ui/ or core/
bun check                        # typecheck (tsconfig.json)
bun test                         # builds the three fixtures into %TEMP%\zn-wasm-fixtures, then runs the tests
bun scripts/build-plugin.ts test/fixtures/hello-rust --out "$TEMP/zn-wasm-x"
```

Fixtures live in `test/fixtures/`. They use a subset of `plugin-minimal` (`hello` world in each `wit/fixture.wit`: lifecycle and events exports; prefs, log, timers imports; the JS one also imports `net` and `attachments` for the resource tests). Reason: every export interface in `plugin-minimal` needs all its functions in Rust (about 40 stubs with long generated types), and the host accepts fewer exports. The stage 2 SDK should supply defaults.

## Tests and result

`bun test`: **15 pass, 0 fail** (74 expects), about 7 s after the first build (the first run adds the cargo and componentize steps, about 15 s).

| Test | Proves |
|---|---|
| Rust guest: startup, host + zinc handlers, callback | load, `start`, `stop`; `prefs.get` answered in the host process (reply carries its pid), `log.write` and `timers.set-timeout` in the Zinc process; `ctx.callExport` reaches `events.on-timer` later; direct calls with kebab/camel/versioned names; `no-such-export` error |
| QuickJS guest (componentize-qjs) | same path with jco's JS value shapes (variant, enum, option) |
| Unhandled import | `timers.set-timeout` with no handler returns `err(unavailable("unsupported: no handler for zinc:plugin/timers#setTimeout"))` to the guest |
| Re-entrancy | an export runs while the same instance waits in an import |
| WASI stubbed | `std::env::vars()` is empty (`env_vars=0`), `std::fs::read_to_string("C:/Windows/win.ini")` fails, stderr reaches the log event |
| Stuck plugin | spin-rust loops in `on-timer(999)`: call rejects with `timeout`; `host-restart` then `host-restarted`; old pid dead, new pid alive; stuck plugin `disabled` with reason and refuses calls (`disabled`); hello-rust reloaded, `startup` ran again, still answers |
| Budget pauses while waiting | a 700 ms import against a 300 ms budget does not kill the plugin |
| WIT resources | guest-made `file-writer` (append, finish, error at first call when `create` fails), host-made `body-reader` (read to end, close) |
| Units | name normalisation; handler table; async lists derived from the WIT (357 plain functions plus resource methods); WASI stubs |

## WIT rows now implemented

None of the parity-table rows is implemented here: this stage builds the machinery, not the interface bodies. `prefs.get`, `log.write`, `timers.set-timeout`, `net.send-streamed` and `attachments.file-writer` appear only as test handlers inside `test/`. Stage 2 fills `src/imports/*.host.ts` and `*.zinc.ts`.

## WIT changes

1. **`lifecycle.wit`, `util.clean-isbn`: parameter `to-13` renamed `to-isbn13`** (the doc comment too). A WIT identifier word cannot start with a digit; jco 1.42's parser and wit-bindgen 0.46 refuse the package (`invalid character in identifier '1'`). The phase 1 check evidently ran with a more tolerant tool. After the rename `jco types` passes for both worlds. Nothing else referenced the name.
2. **Not changed, for review:** `types.error` has no `unsupported` case. Unknown imports return `unavailable("unsupported: ...")`. A real `unsupported` case would be cleaner for plugins that want to feature-detect.
3. **Not changed, for review:** `http-request`, `import-bytes-request` and similar records have no defaults, so every guest spells out all fields (JS: optional fields may be left out; Rust: all). Guest SDKs should wrap this.

## For the stage 2 agents

### Add an import handler

1. File `plugin-host/src/imports/<area>.host.ts` (runs in the plugin host, talks to core over HTTP) or `<area>.zinc.ts` (runs in the Zinc process, may import UI). Do not edit `registry.ts`; the folder otherwise holds only your files. Details: `plugin-host/src/imports/README.md`.
2. Content:

```ts
import { defineHandler, witError } from "./registry";
export default defineHandler({
	interface: "zinc:plugin/log",
	where: "zinc",
	functions: {
		write(ctx, level: string, message: string) { /* ctx.pluginId, ctx.require("..."), ctx.callExport(...) */ },
	},
	// resources: { "body-reader": { methods: { read(ctx, self, max) { ... } } } },
});
```

3. Values are jco's: camelCase record fields, `option<T>` as `T | undefined`, variants `{ tag, val }`, enums as strings, u64 as bigint, `list<u8>` as `Uint8Array`. Failure: `throw witError("not-found", "text")`. Check permissions yourself with `ctx.require("library.read")`.
4. The app registers zinc handlers with `createPluginSupervisor({ importHandlers: await discoverHandlers("zinc") })` (a one-line change in whichever agent owns the app wiring: needs from other areas below). Host handlers need no registration.

### Build and load a plugin in a test

```ts
import { buildPlugin } from "../scripts/build-plugin";          // from plugin-host/test/
import { createPluginSupervisor } from "../src/supervisor";
import { loadHandlerModule } from "../src/imports/registry";

const { out } = await buildPlugin({ dir: "<plugin source dir with manifest.json>", out: "<temp dir>/my-plugin" });
const sup = createPluginSupervisor({
	importHandlers: await loadHandlerModule("<abs path>/src/imports/mine.zinc.ts"),   // or inline objects
	hostHandlerModules: ["<abs path>/src/imports/mine.host.ts"],                       // extra host modules for the host process
	coreUrl: "http://127.0.0.1:<throwaway core port>",
	callTimeoutMs: 2000,
});
const info = await sup.load(out);       // reads manifest.json, instantiates
await sup.start(info.id);               // lifecycle.startup
// ... sup.call(...) ...
await sup.shutdown();                   // in afterAll
```

`discoverHandlers` finds `src/imports/*.host.ts` for the host automatically; `hostHandlerModules` is for extra ones (tests). Build a Rust plugin that has its own `wit/` folder or targets `plugin`/`plugin-minimal` directly (`wit_bindgen::generate!({ world: "zinc:plugin/plugin-minimal", path: "../../../plugin-api/wit", generate_all })`); `build-plugin` finds the cargo target dir through `cargo metadata`. JS plugins: `plugin.js` next to `manifest.json`, `main.world` in the manifest (or `--world`); exports are `export const lifecycle = { startup(data, why) {...} }`, imports are `import prefs from "zinc:plugin/prefs@0.1.0"`; an `option` is `undefined | value`, a failing `result` import throws an object with `.payload`. The fixtures in `test/fixtures/` are working examples; copy `hello-rust` or `hello-js`.

### Call an export

```ts
await sup.call("hello-rust@zinc.test", "events", "on-timer", [3, "interval"]);   // iface, fn: kebab or camel, versioned or not
await sup.call(id, "lifecycle", "main-window-load", [{ id, version, previousVersion: undefined }, 1]);
const cells = await sup.call(id, "extend-handlers", "on-column-values", ["col", ["ABCD2345"]]);   // result<list<cell>, error>: value or throws
```

A `result::err` rejects with `PluginError` (`e.kind === "wit"`, `e.payload` is the `types.error` variant). From inside a handler use `ctx.callExport(iface, fn, args)`. Events to listen for: `sup.on("status" | "host-restart" | "host-restarted" | "host-failed" | "host-ready" | "log", fn)`. After `host-restarted` everything a plugin registered in the UI (menus, sections, columns) is gone from the plugin's side: the supervisor re-ran `startup` for the plugins it reloaded, so the extension-point owner must clear the registrations of every plugin when it sees `host-restart` and take the new ones from the replayed `startup`.

## Stubbed or left for later

- Grants: `grantsFor` defaults to what the manifest declares; user denials and the install prompt belong to the lifecycle area. `setGrants` pushes changes to the host but does not call `events.on-permission-changed`.
- No manifest schema validation (no validator installed); `readManifest` checks `id`, `version`, `main.wasm` only. No sha256 check at load (the hash is written by `build-plugin`).
- Packaged-build spawn (`BUN_BE_BUN=1`) not verified; see above.
- Activation events (lazy start), plugin install and uninstall flows, update checks: not here.
- `ctx.callExport` cannot be used to call a plugin that is `loading`/`failed`; it rejects with `not-loaded`.
- Imported resources passed as arguments to other functions are not marshalled (no WIT function takes one today); only method receivers and results.
- Memory limits and fuel are not possible with this runtime (see the spike).

## Needs from other areas

- **App wiring** (`gpui-ui/src/platform.ts` or equivalent, owner of gpui-ui): create the supervisor with `discoverHandlers("zinc")` and core's URL; call `load` and `start` for installed plugins after the UI is ready; clear plugin registrations on `host-restart`.
- **Whoever writes the installer:** produce the layout in `src/manifest.ts` (run the same jco transpile, with the same async lists, which `build-plugin.ts` exports as `buildPlugin`).
- **Core:** a stable HTTP surface for the `where: "host"` handlers (library, attachments, fulltext, cite, schema, prefs/secrets storage, change log stream for `notifier`).
