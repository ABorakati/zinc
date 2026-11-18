// IPC messages. Two links:
//   (a) Zinc process  <-> plugin host process   (Bun IPC, `serialization: "advanced"`, so bigint and Uint8Array survive)
//   (b) host process  <-> one Worker per plugin (postMessage, structured clone)
//
// VALUES. Calls carry arguments and results in jco's JS representation of the WIT types: kebab names are camelCase, `u64`/`s64`
// are bigint, `option<T>` is `T | undefined`, records are objects, variants are `{ tag, val }`, enums are strings, `list<u8>` is
// a Uint8Array, `result<T,E>` is "return T or throw" (see WireError.kind "wit"). Names of interfaces and functions may be given
// kebab or camel, with or without package and version; they are normalised with names.ts.
import type { Grants, PluginManifest } from "./manifest";

/** Default time budgets in ms. A budget counts only time the plugin spends running: waiting for a host import does not use it. */
export const DEFAULT_TIMEOUTS = {
	/** Any export call (events, handlers, ...). */
	call: 5_000,
	/** `lifecycle.startup`, `install`, `shutdown`, `uninstall` (the manifest's `main.startup_timeout_ms` overrides). */
	lifecycle: 10_000,
	/** Loading and instantiating a component (compile + the instantiate step). */
	load: 15_000,
} as const;

/** Why a call or a plugin failed. */
export type WireError =
	/** The plugin's export returned `result::err(payload)`, or an import handler failed. `payload` is a WIT `types.error`: `{ tag: "not-found", val: "..." }` etc. */
	| { kind: "wit"; payload: unknown }
	/** The component trapped (panic, unreachable, exception out of a JS guest). The instance is no longer usable. */
	| { kind: "trap"; message: string; stack?: string }
	/** The active-time budget ran out. The host process was killed. */
	| { kind: "timeout"; ms: number; phase: string }
	| { kind: "no-such-export"; iface: string; fn: string }
	| { kind: "not-loaded"; plugin: string }
	| { kind: "disabled"; plugin: string; reason: string }
	/** The plugin host process was killed or died while the call was running. Safe to retry once the plugin is running again. */
	| { kind: "host-restarting" }
	| { kind: "internal"; message: string };

export type WireResult = { ok: true; value: unknown } | { ok: false; error: WireError };

/** Thrown by supervisor.call / ctx.callExport on every failure. `.error` is the WireError. */
export class PluginError extends Error {
	constructor(readonly error: WireError) {
		super(describeError(error));
		this.name = "PluginError";
	}
	get kind(): WireError["kind"] {
		return this.error.kind;
	}
	/** For kind "wit": the WIT `error` variant, e.g. `{ tag: "not-found", val: "..." }`. */
	get payload(): unknown {
		return this.error.kind === "wit" ? this.error.payload : undefined;
	}
}

export function describeError(e: WireError): string {
	switch (e.kind) {
		case "wit": {
			const p = e.payload as { tag?: string; val?: unknown } | undefined;
			return p && typeof p === "object" && "tag" in p ? `${p.tag}${p.val !== undefined ? `: ${String(p.val)}` : ""}` : `wit error: ${JSON.stringify(p)}`;
		}
		case "trap":
			return `plugin trapped: ${e.message}`;
		case "timeout":
			return `plugin timed out after ${e.ms} ms in ${e.phase}`;
		case "no-such-export":
			return `plugin has no export ${e.iface}#${e.fn}`;
		case "not-loaded":
			return `plugin ${e.plugin} is not loaded`;
		case "disabled":
			return `plugin ${e.plugin} is disabled: ${e.reason}`;
		case "host-restarting":
			return "plugin host is restarting";
		case "internal":
			return `internal error: ${e.message}`;
	}
}

/** What a worker needs to load one plugin. `dir` is the loadable folder (see manifest.ts). */
export interface PluginSpec {
	id: string;
	dir: string;
	manifest: PluginManifest;
	grants: Grants;
}

// ---- (a) Zinc <-> plugin host ----------------------------------------------------------------------------------

/** Zinc -> host. `id` is chosen by Zinc; the reply carries the same id. */
export type ToHost =
	/** First message. `hostModules`: absolute paths of extra handler modules (besides src/imports/*.host.ts). */
	| { t: "init"; coreUrl?: string; hostModules: string[]; heartbeatMs: number; /** false: do not load src/imports/*.host.ts (tests with their own handlers) */ discover?: boolean }
	/** Answer to a `FromHost` `call` message. */
	| { t: "call-reply"; id: number; result: WireResult }
	/** Create the plugin's Worker, compile and instantiate the component. Does not call `startup`. Reply: `reply` with value undefined. */
	| { t: "load"; id: number; plugin: PluginSpec }
	/** Terminate the plugin's Worker. Reply: `reply`. */
	| { t: "unload"; id: number; plugin: string }
	/** Call one export. Reply: `reply` with the return value (or the error). */
	| { t: "call"; id: number; plugin: string; iface: string; fn: string; args: unknown[] }
	/** Answer to a `FromHost` `import` message. */
	| { t: "import-reply"; id: number; result: WireResult }
	/** The grants of a loaded plugin changed. */
	| { t: "grants"; plugin: string; grants: Grants }
	/** Exit now. */
	| { t: "exit" };

export type LogLevel = "error" | "warn" | "info" | "debug";

/** Host -> Zinc. */
export type FromHost =
	/** Sent once after `init`. `interfaces` lists the host-side handler interfaces that were loaded. */
	| { t: "ready"; pid: number; interfaces: string[] }
	/** Every `heartbeatMs`, from the host's main thread. A runaway plugin does not stop it; a blocked handler does. */
	| { t: "heartbeat"; ts: number }
	| { t: "reply"; id: number; result: WireResult }
	/** A plugin called an import that no host-side handler has. Zinc looks for a `where: "zinc"` handler and answers with `import-reply`. */
	| { t: "import"; id: number; plugin: string; iface: string; fn: string; args: unknown[] }
	/** A host-side handler calls an export of a plugin (`ctx.callExport`). Zinc queues it with the plugin's other calls and answers with `call-reply`. */
	| { t: "call"; id: number; plugin: string; iface: string; fn: string; args: unknown[]; timeoutMs?: number }
	/** How many host-side imports of this plugin are in flight. While n > 0 the plugin's call timers are paused. */
	| { t: "waiting"; plugin: string; n: number }
	/** The plugin's Worker died by itself (not through `unload`). */
	| { t: "plugin-exit"; plugin: string; message: string }
	/** Plugin log output (stderr of a Rust guest, host diagnostics). Not the `log` WIT interface: that one is a handler. */
	| { t: "log"; plugin?: string; level: LogLevel; message: string };

// ---- (b) host <-> Worker -----------------------------------------------------------------------------------------

export type ToWorker =
	| { t: "init"; spec: PluginSpec }
	| { t: "call"; id: number; iface: string; fn: string; args: unknown[] }
	| { t: "import-reply"; id: number; result: WireResult };

export type FromWorker =
	/** Reply to `init` (id 0) or `call`. */
	| { t: "reply"; id: number; result: WireResult }
	/** An import call. The host answers with `import-reply` using the same id. `fn` is camelCase as in jco. */
	| { t: "import"; id: number; iface: string; fn: string; args: unknown[] }
	| { t: "log"; level: LogLevel; message: string };
