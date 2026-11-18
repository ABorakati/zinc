# `zhw` NDJSON Stdio Protocol (`protocol-ndjson.md`)

Status: Phase 3 contract (2026-11-18). Connects the Zinc app process (`plugin-host/src/transport-wasmtime.ts`, driven by `supervisor.ts` and `package/services.ts`) to the native Wasmtime plugin host binary `zhw` (`plugin-host-wasmtime/`).

There is **no Bun bridge process**. `zhw` runs chatty, stateless or cached imports natively in Rust (`log`, `prefs`, `timers`, `l10n`, `app`, `util`, plus `wasi:*` stubs) and forwards every other `zinc:plugin/*` import directly to Zinc, where both `*.host.ts` and `*.zinc.ts` handlers run in the app process.

---

## 1. CLI Commands

```
zhw version
zhw precompile <plugin.wasm> [out.cwasm]
zhw inspect <plugin.wasm>
zhw run [--aot] [--max-memory-mb 256] [--max-import-calls 1000000] [--native log,prefs,timers,l10n,app,util]
```

- **`zhw version`**: prints one JSON line describing the binary and engine configuration used for `.cwasm` compatibility:
  ```json
  {"version":"0.1.0","wasmtime":"50.0.2","os":"windows","arch":"x86_64","opt":"default","cacheKey":"zhw-0.1.0-wt50.0.2-windows-x86_64-default"}
  ```
  Zinc's `.cwasm` cache (`plugin-host/src/package/cwasm-cache.ts`) combines `wasmSha256` with `cacheKey` (which encodes `zhw` version, Wasmtime version, target OS/CPU, and engine settings such as `ZHW_OPT` and epoch interruption) so stale entries are never loaded after an upgrade.
- **`zhw precompile <plugin.wasm> [out.cwasm]`**: compiles a WebAssembly component ahead of time with `Engine::precompile_component`, writes `out.cwasm` atomically, and prints:
  ```json
  {"input":"...","output":"...","wasmBytes":5201920,"cwasmBytes":16318464,"precompileMs":1680.4}
  ```
  Exits non-zero if the input is not a valid WebAssembly component.
- **`zhw inspect <plugin.wasm>`**: prints JSON `{"imports":[...],"exports":[...]}`.
- **`zhw run`**: runs the NDJSON protocol loop on `stdin` (requests/pushes from Zinc) and `stdout` (events/replies to Zinc). `stderr` carries only host-level panics or diagnostics. When `stdin` reaches EOF, `zhw` exits `0`.

---

## 2. Framing and Value Encoding

Each message is one UTF-8 JSON object followed by `\n` (NDJSON). Values inside `args` and `WireResult` use jco's JavaScript representation of WIT types so all existing TypeScript `ImportHandler` modules work unchanged, with two JSON escapes for types JSON lacks:

| WIT type | NDJSON wire form | JS runtime form (`transport-wasmtime.ts`) |
|---|---|---|
| `bool`, `s8..u32`, `f32`, `f64`, `char`, `string` | JSON boolean, number, string | `boolean`, `number`, `string` |
| `u64`, `s64` | `{"$big": "12345"}` (inbound also accepts JSON number/string) | `bigint` |
| `list<u8>` | `{"$bytes": "<base64>"}` (always tagged from WIT type, including empty `{"$bytes": ""}`) | `Uint8Array` |
| `list<T>` (`T != u8`), `tuple<...>` | JSON array `[...]` | `Array` |
| `record` | JSON object with `camelCase` keys (`option::none` fields omitted; inbound accepts `camelCase` or `kebab-case`) | plain object |
| `variant` | `{"tag": "<kebab-case>", "val": ...}` (`val` omitted when unit) | `{ tag, val }` |
| `enum` | `"<kebab-case>"` | `string` |
| `flags` | `{"flagName": true, ...}` | `Record<string, boolean>` |
| `option<T>` | `null` for `none`, encoded `T` for `some` | `undefined` for `none`, `T` for `some` |
| `result<T, E>` (top-level export / import) | `WireResult` (`{ok: true, value}` or `{ok: false, error: {kind: "wit", payload}}`) | return `T` or throw `WitError` / `PluginError` |
| `result<T, E>` (nested, e.g. `list<result<...>>`) | `{"tag": "ok" \| "err", "val": ...}` | `{ tag: "ok" \| "err", val }` |
| `own<R>` / `borrow<R>` (guest -> host arg) | handle integer (`i32`: positive for guest-constructed, negative for host-constructed) | handle `number` |
| `own<R>` (host -> guest result) | `{"$zinc-resource": "<kebab-name>", "id": -1}` | `ctx.resource(name, state)` |

### Resource lifecycle over `import`

WIT resources (`net.body-reader`, `attachments.file-writer`) are bound dynamically with `ResourceDynamic`:
- **Guest constructor** (`[constructor]<name>`): `zhw` allocates a positive `i32` handle `rep`, forwards `args: [rep, ...ctorArgs]` to Zinc via `import`, and returns an owned resource handle to the guest. If `create` fails, `HandlerTable` records the rejected state and surfaces the `WitError` on the first method call.
- **Method call** (`[method]<name>.<method>`): forwarded with `args: [rep, ...methodArgs]`.
- **Resource drop** (`[resource-drop]<name>`): when the guest drops an owned handle, `zhw` forwards `args: [rep]` via `import` so `HandlerTable` runs the resource's `drop` hook and frees state. On `unload`, Zinc also calls `HandlerTable.dropPlugin`.

---

## 3. Error Shapes (`WireResult` and `WireError`)

```ts
type WireResult =
  | { ok: true; value: unknown }
  | { ok: false; error: WireError };

type WireError =
  | { kind: "wit"; payload: unknown }                         // WIT result::err(payload), e.g. { tag: "permission-denied", val: "library.read" }
  | { kind: "trap"; message: string; stack?: string }         // guest panic/unreachable, WASI denial, memory limit, or import-call limit
  | { kind: "timeout"; ms: number; phase: string }            // active CPU epoch budget expired in zhw
  | { kind: "no-such-export"; iface: string; fn: string }
  | { kind: "not-loaded"; plugin: string }
  | { kind: "disabled"; plugin: string; reason: string }      // plugin already trapped or timed out earlier
  | { kind: "reentrant"; plugin: string; message: string }    // call attempted while the same plugin waits on a forwarded import
  | { kind: "host-restarting" }                               // zhw exited unexpectedly while a request was in flight
  | { kind: "internal"; message: string };
```

---

## 4. Messages: Zinc -> `zhw` (`stdin`)

### `init`
Sent once immediately after spawning `zhw`.
```json
{
  "t": "init",
  "heartbeatMs": 1000,
  "maxMemoryMb": 256,
  "maxImportCalls": 1000000,
  "native": ["log", "prefs", "timers", "l10n", "app", "util"],
  "debugEnabled": false,
  "app": {
    "info": {
      "name": "Zinc",
      "version": "0.1.0",
      "apiVersion": "0.1.0",
      "zoteroVersion": "10.0.0",
      "platform": "windows",
      "arch": "x86_64",
      "locale": "en-US",
      "timeZone": "UTC",
      "devBuild": false,
      "features": []
    },
    "isUiReady": true,
    "mainWindows": [1],
    "activeWindow": 1,
    "windowsHidden": false
  }
}
```
- `native`: optional list of interface short names (`"log"`, `"prefs"`, `"timers"`, `"l10n"`, `"app"`, `"util"`) or `"iface.fn"` selectors handled natively in Rust. When omitted, `zhw` uses its `--native` flag (default: all six chatty families). Passing `[]` forwards every `zinc:plugin/*` import to Zinc (used by unit tests that supply stub handlers).
- Replies with `ready` (unsolicited event, no `id`) and starts the `heartbeat` task.

### `load`
```json
{
  "t": "load",
  "id": 1,
  "plugin": {
    "id": "my-plugin@example.org",
    "dir": "C:/.../installed/my-plugin@example.org",
    "cwasm": "C:/.../cache/ab12...ef.cwasm",
    "manifest": { "...": "..." },
    "grants": { "capabilities": ["library.read"], "netHosts": [] },
    "prefs": {
      "defaults": { "greeting": "hello" },
      "user": { "starts": 1 },
      "secrets": []
    },
    "l10n": {
      "defaultLocale": "en-US",
      "bundles": [{ "tag": "en-US", "ftl": "hello = Hello, { $name }!\n" }]
    }
  }
}
```
- `cwasm`: optional path to a precompiled `.cwasm` in Zinc's cache folder. `zhw` deserializes it if present; if `cwasm` is omitted, missing, or fails deserialization, `zhw` logs a warning and falls back to JIT compilation of `<dir>/<manifest.main.wasm>`. Untrusted `.cwasm` files inside `<dir>` are ignored unless `--aot` was explicitly passed on the CLI (bench harness).
- Replies with `reply`:
  ```json
  {"t":"reply","id":1,"result":{"ok":true,"value":{"compileMs":2.1,"linkMs":0.8,"instantiateMs":0.6,"totalMs":3.5,"fromCwasm":true}}}
  ```

### `unload`
```json
{"t": "unload", "id": 2, "plugin": "my-plugin@example.org"}
```
Cancels all native timers of `plugin`, drops its `Store` and per-plugin caches, and replies `{"ok": true, "value": null}`.

### `call`
```json
{
  "t": "call",
  "id": 3,
  "plugin": "my-plugin@example.org",
  "iface": "lifecycle",
  "fn": "startup",
  "args": [{ "id": "my-plugin@example.org", "version": "1.0.0" }, "app-startup"],
  "timeoutMs": 10000,
  "maxImportCalls": 1000000
}
```
- **Per-plugin call lock & re-entrancy refusal**:
  - A Wasmtime component instance holds `&mut Store` across `call_async` and cannot be re-entered while suspended in a host import.
  - If `plugin` currently has `waiting > 0` (it is suspended awaiting an `import-reply` from Zinc), `zhw` **immediately refuses** a `call` for that same `plugin` with `{"ok": false, "error": {"kind": "reentrant", "plugin": "...", "message": "..."}}` instead of waiting on the store lock (which would deadlock).
  - Calls to *other* plugins while `plugin` waits on an import run concurrently on their own `Store` locks.
  - Overlapping non-reentrant calls to the same plugin (e.g. a native Rust timer firing while an export runs) serialize cleanly on the plugin's `tokio::sync::Mutex<Store<St>>`.
- **Budgets**:
  - Active guest execution is bounded by epoch ticks (`10 ms` tick; time spent inside forwarded imports and `timers.sleep` is excluded from the deadline).
  - Every import call (native or forwarded, except `wasi:*` startup calls during instantiation) increments the per-call import counter; exceeding `maxImportCalls` traps the call (`"plugin exceeded import call limit (...)"`) so a tight loop over cheap imports is always stopped.
  - Before sending `reply`, `zhw` flushes any buffered native `log` lines for `plugin` so logs arrive strictly before the call resolves.

### `import-reply`
```json
{"t": "import-reply", "id": 9, "result": {"ok": true, "value": "..."}}
```
Completes a forwarded `import` request of the same `id`.

### `grants`
```json
{"t": "grants", "plugin": "my-plugin@example.org", "grants": {"capabilities": ["library.read", "prefs.app-read"], "netHosts": []}}
```
Updates the live permission set of a loaded plugin in place. Native permission-gated imports (`prefs.get-app`) observe the change on the very next call.

### `prefs` (cache push)
```json
{
  "t": "prefs",
  "plugin": "my-plugin@example.org",
  "defaults": { "greeting": "hello", "limit": 10 },
  "user": { "greeting": "updated" },
  "secrets": ["apiKey"],
  "appPrefs": { "ui.locale": "en-US", "ui.theme.mode": "dark" }
}
```
- When `plugin` is present, updates that plugin's cached `user` map (and optional `defaults` / `secrets` list). Native `prefs.get`, `prefs.get-all`, and `prefs.has-user-value` serve directly from this cache; keys in `secrets` read as `none`.
- When `appPrefs` is present (with or without `plugin`), updates the allowlisted Zinc settings cache read by native `prefs.get-app`.
- Mutating calls (`prefs.set`, `set-many`, `clear`, `reset`, `observe`, `unobserve`) forward to Zinc (`prefs.zinc.ts`), which persists atomically to `prefs/<id>.json`, writes secret settings to `SecretStore`, emits `prefs` push **before** `import-reply`, and schedules `events.on-pref-changed`.

### `l10n` (strings & locale push)
```json
{
  "t": "l10n",
  "plugin": "my-plugin@example.org",
  "locale": "fr-CA",
  "timeZone": "UTC",
  "defaultLocale": "en-US",
  "bundles": [
    { "tag": "en-US", "ftl": "hello = Hello, { $name }!\n" },
    { "tag": "fr", "ftl": "hello = Bonjour, { $name } !\n" }
  ]
}
```
- Updates global `locale` and/or `timeZone` when present.
- When `plugin` and `bundles` are given, parses and caches the plugin's Fluent resources in Rust and clears its once-per-id missing-message warning set. If no `bundles` were pushed for a loaded plugin, `zhw` lazily loads `<dir>/<locales.dir>/` as a standalone fallback.

### `app` (app state push)
```json
{
  "t": "app",
  "info": { "name": "Zinc", "version": "0.1.0", "apiVersion": "0.1.0", "zoteroVersion": "10.0.0", "platform": "windows", "arch": "x86_64", "locale": "en-US", "timeZone": "UTC", "devBuild": false, "features": ["extend.menubar"] },
  "isUiReady": true,
  "mainWindows": [1],
  "activeWindow": 1,
  "windowsHidden": false
}
```
Updates cached values for native `app.get-info`, `is-ui-ready`, `wait-ui-ready` (waking waiters when `isUiReady` turns `true`), `main-windows`, `active-window`, and the hidden-window 1 s floor of native `timers`.

### `log-config`
```json
{"t": "log-config", "debugEnabled": true}
```
Updates `log.debug-enabled()` and whether `debug`-level lines in `log.write` are kept or dropped in Rust.

### `timers-clear`
```json
{"t": "timers-clear", "plugin": "my-plugin@example.org"}
```
Cancels all native Rust timers for `plugin` (or for every plugin when `plugin` is omitted).

### `stats`
```json
{"t": "stats", "id": 4}
```
Replies with host RSS and per-plugin telemetry:
```json
{
  "t": "reply",
  "id": 4,
  "result": {
    "ok": true,
    "value": {
      "rssBytes": 9437184,
      "plugins": [
        {
          "plugin": "my-plugin@example.org",
          "peakMemoryBytes": 4194304,
          "dead": false,
          "nativeCalls": 42,
          "forwardedCalls": 3,
          "activeTimers": 1
        }
      ]
    }
  }
}
```

### `exit`
```json
{"t": "exit"}
```
Flushes pending output and terminates `zhw` cleanly with exit code `0`.

---

## 5. Messages: `zhw` -> Zinc (`stdout`)

### `ready`
```json
{"t": "ready", "pid": 12345, "version": "0.1.0", "interfaces": ["log", "prefs", "timers", "l10n", "app", "util"], "startupMs": 4.2}
```

### `heartbeat`
```json
{"t": "heartbeat", "ts": 1795012345678}
```
Emitted every `heartbeatMs` from a tokio interval task on the `zhw` runtime.

### `reply`
```json
{"t": "reply", "id": 3, "result": {"ok": true, "value": null}}
```

### `import`
```json
{"t": "import", "id": 9, "plugin": "my-plugin@example.org", "iface": "zinc:plugin/library", "fn": "query-items", "args": [{ "...": "..." }]}
```
Forwarded import call. Zinc dispatches to its combined `HandlerTable` (`*.host.ts` + `*.zinc.ts` + extra handlers) and answers with `import-reply`.

### `waiting`
```json
{"t": "waiting", "plugin": "my-plugin@example.org", "n": 1}
```
Number of forwarded imports currently in flight for `plugin`.

### `plugin-exit` (single-plugin fault isolation)
```json
{"t": "plugin-exit", "plugin": "my-plugin@example.org", "kind": "timeout", "message": "timed out after 5000 ms in events#on-timer"}
```
- **Applies ONLY to `plugin`**: its `Store` is poisoned (`dead = true`) and its native timers are cancelled, while `zhw` and all other loaded plugins continue running without interruption.
- `kind: "timeout"`: Zinc's supervisor marks `plugin` `"disabled"` with the timeout reason and does **not** restart `zhw`.
- `kind: "trap"` (guest panic, memory cap, import-call loop limit): Zinc's supervisor marks `plugin` `"failed"`, unloads its slot, and does **not** restart `zhw`.

### `log` and `log-batch`
```json
{"t": "log", "plugin": "my-plugin@example.org", "level": "warn", "message": "[stderr] panic text"}
{"t": "log-batch", "entries": [{"plugin": "my-plugin@example.org", "level": "info", "message": "hello"}, {"plugin": "my-plugin@example.org", "level": "error", "message": "boom", "stack": "at x:1", "isError": true}]}
```
- `log.write` and `log.write-error` truncate messages above 8 KiB (`"... [truncated]"`), enforce the 200 lines/s per-plugin rate limit (reporting dropped counts via `dropped` when needed or dropping excess lines), buffer lines in memory, flush every 10 ms or 64 lines, and **always flush before any `reply` or `import`** so logs arrive in causal order.
- `isError: true` (from `log.write-error` or `error`-level `log.write`) instructs Zinc's `LogRing` to record `lastError(plugin)` with `message` and optional `stack`.

### `timers-count`
```json
{"t": "timers-count", "plugin": "my-plugin@example.org", "count": 2}
```
Emitted whenever a plugin's active native timer count changes (flushed before `reply`), keeping `TimerService.count(plugin)` accurate on the Zinc side.
