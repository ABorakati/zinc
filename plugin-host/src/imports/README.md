# Import handlers

A plugin's `zinc:plugin/*` imports (`prefs`, `library`, `net`, `ui`, ...) are answered by **handler modules**. One module can serve
one WIT interface or several. The plugin host routes every import call: a `where: "host"` handler runs in the plugin host process; any
call with no host handler goes over IPC to the Zinc process, where a `where: "zinc"` handler answers it. A call with no handler at all
returns `error::unavailable("unsupported: no handler for zinc:plugin/<iface>#<fn>")` (types.wit has no `unsupported` case); a function
that does not return a `result` makes the plugin trap with that message.

## Where does my handler run?

| `where` | Process | Use it for | Reaches core by |
|---|---|---|---|
| `"host"` | plugin host (Bun, no UI) | `library`, `attachments`, `fulltext`, `schema`, `cite`, `net`, `fs`, `prefs`, `secrets`, `notifier` | HTTP (`ctx.coreUrl`) |
| `"zinc"` | the Zinc process that owns the supervisor | `ui`, `extend`, `reader`, `annotations`, `note-editor`, `clipboard`, `shell` and anything that needs the UI or in-process state | direct calls |

A "host" call costs about 40 us (JSPI); a "zinc" call adds one IPC round trip (about 50 us). The plugin's time budget does not run while
it waits for a handler (`net.send`, a dialog), so a slow handler never gets a plugin killed.

## Add a handler

1. Create `src/imports/<area>.host.ts` or `src/imports/<area>.zinc.ts`. The file name decides where it is loaded:
   `discoverHandlers("host")` (called by the host process) loads `*.host.ts`; `discoverHandlers("zinc")` (called by the app, which passes
   the result to `createPluginSupervisor({ importHandlers })`) loads `*.zinc.ts`. A `*.zinc.ts` file may import UI code; a `*.host.ts` file must not.
2. `export default` one handler or an array of them:

```ts
import { defineHandler, witError } from "./registry";

export default defineHandler({
	interface: "zinc:plugin/prefs",
	where: "host",
	functions: {
		// kebab or camel names both work; arguments and results are jco's JS values
		async get(ctx, key: string) {
			const r = await fetch(`${ctx.coreUrl}/api/plugin-prefs/${encodeURIComponent(ctx.pluginId)}/${encodeURIComponent(key)}`);
			if (r.status === 404) return undefined; // option<pref-value> none
			return (await r.json()) as { tag: "text"; val: string };
		},
		async "get-app"(ctx, key: string) {
			ctx.require("prefs.app-read"); // throws error::permission-denied("prefs.app-read")
			throw witError("not-found", key); // result<_, error> err
		},
	},
});
```

3. Test it (see "For the stage 2 agents" in `docs/developer-guide/wasm-plugins/phase2-core.md`). Do not edit `registry.ts`.

## The contract

- `ctx`: `pluginId`, `manifest`, `grants` (live), `where`, `coreUrl`, `has(p)`, `require(p)`, `callExport(iface, fn, args)` (a callback into the
  plugin, resolves with its return value, rejects with `PluginError`), `log(level, msg)`, `resource(name, state)`.
- **Values** are jco's JS representation: camelCase record fields, `option<T>` is `T | undefined`, variants are `{ tag, val }`, enums are
  strings (`"info"`), `u64`/`s64` are `bigint`, `list<u8>` is `Uint8Array`, `tuple` is an array.
- **Results.** Return the `ok` value, or throw `witError(tag, text)` for `err`. Tags: `not-found`, `invalid-argument`, `permission-denied`,
  `read-only`, `conflict`, `limit-exceeded`, `unavailable`, `internal` (with text) and `timeout`, `cancelled` (without). Any other exception
  becomes `internal(message)` and is logged.
- **Permissions.** The router does not check them: call `ctx.require("library.read")` yourself (permission ids: `manifest.schema.json`).
- **Resources** (`net.body-reader`, `attachments.file-writer`): add `resources: { "body-reader": { methods: { read(ctx, self, max) {...}, close(ctx, self) {...} } } }`.
  Return a host-made handle with `ctx.resource("body-reader", state)` anywhere inside a result. A guest-made one (`constructor(...)` in the WIT)
  needs `create(ctx, ...args)` that returns the state; the guest does not wait for it, so an error from `create` shows at the first method call.
  `drop(ctx, self)` runs when the plugin drops the handle or is unloaded.
- State shared by calls of one plugin: key it by `ctx.pluginId`. A host handler lives as long as the host process (it is lost when the host restarts).
