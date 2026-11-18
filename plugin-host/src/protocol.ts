// IPC messages between the Zinc app process and `zhw`, the Wasmtime plugin host (NDJSON on stdio, see transport-wasmtime.ts and
// protocol-ndjson.md).
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
	/** The component trapped (panic, unreachable, exception out of a JS guest, memory limit, import-call limit). The instance is no longer usable. */
	| { kind: "trap"; message: string; stack?: string }
	/** The active-time budget ran out. */
	| { kind: "timeout"; ms: number; phase: string }
	| { kind: "no-such-export"; iface: string; fn: string }
	| { kind: "not-loaded"; plugin: string }
	| { kind: "disabled"; plugin: string; reason: string }
	/** Re-entering the same plugin while it waits on a forwarded import. */
	| { kind: "reentrant"; plugin: string; message: string }
	/** The plugin host process (`zhw`) was killed or died while the call was running. Safe to retry once the plugin is running again. */
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
		case "reentrant":
			return `plugin ${e.plugin} cannot be re-entered: ${e.message}`;
		case "host-restarting":
			return "plugin host is restarting";
		case "internal":
			return `internal error: ${e.message}`;
	}
}

export interface PluginPrefsState {
	defaults?: Record<string, boolean | number | string>;
	user?: Record<string, boolean | number | string>;
	secrets?: string[];
}

export interface PluginL10nBundle {
	tag: string;
	ftl: string;
}

export interface PluginL10nState {
	defaultLocale?: string;
	bundles: PluginL10nBundle[];
}

/** What the host needs to load one plugin. `dir` is the loadable folder (see manifest.ts). */
export interface PluginSpec {
	id: string;
	dir: string;
	/** Optional precompiled `.cwasm` in Zinc's cache folder. */
	cwasm?: string;
	manifest: PluginManifest;
	grants: Grants;
	/** Initial cached prefs for native `prefs` imports. */
	prefs?: PluginPrefsState;
	/** Initial Fluent bundles for native `l10n` imports. */
	l10n?: PluginL10nState;
}

// ---- Zinc <-> `zhw` ---------------------------------------------------------------------------------------------

/** Zinc -> host. `id` is chosen by Zinc; the reply carries the same id. */
export type ToHost =
	/** First message. */
	| {
			t: "init";
			heartbeatMs: number;
			maxMemoryMb?: number;
			maxImportCalls?: number;
			native?: string[];
			debugEnabled?: boolean;
			app?: unknown;
	  }
	/** Answer to a `FromHost` `call` message. */
	| { t: "call-reply"; id: number; result: WireResult }
	/** Compile / deserialize and instantiate the component. Does not call `startup`. Reply: `reply`. */
	| { t: "load"; id: number; plugin: PluginSpec }
	/** Drop the plugin's instance. Reply: `reply`. */
	| { t: "unload"; id: number; plugin: string }
	/** Call one export. Reply: `reply` with the return value (or the error). */
	| { t: "call"; id: number; plugin: string; iface: string; fn: string; args: unknown[]; timeoutMs?: number; maxImportCalls?: number }
	/** Answer to a `FromHost` `import` message. */
	| { t: "import-reply"; id: number; result: WireResult }
	/** The grants of a loaded plugin changed. */
	| { t: "grants"; plugin: string; grants: Grants }
	/** `zhw`: update cached plugin prefs and/or allowlisted app settings. */
	| {
			t: "prefs";
			plugin?: string;
			defaults?: Record<string, boolean | number | string>;
			user?: Record<string, boolean | number | string>;
			secrets?: string[];
			appPrefs?: Record<string, boolean | number | string>;
	  }
	/** `zhw`: update cached Fluent bundles and/or global UI locale & time zone. */
	| {
			t: "l10n";
			plugin?: string;
			locale?: string;
			timeZone?: string;
			defaultLocale?: string;
			bundles?: PluginL10nBundle[];
	  }
	/** `zhw`: update cached `app` import state and hidden-window flag. */
	| {
			t: "app";
			info?: unknown;
			isUiReady?: boolean;
			mainWindows?: number[];
			activeWindow?: number | null;
			windowsHidden?: boolean;
	  }
	/** `zhw`: update `log.debug-enabled()` and debug line filtering. */
	| { t: "log-config"; debugEnabled: boolean }
	/** `zhw`: cancel native Rust timers for `plugin` (or every plugin when omitted). */
	| { t: "timers-clear"; plugin?: string }
	/** `zhw`: query host RSS and per-plugin telemetry. Reply: `reply`. */
	| { t: "stats"; id: number }
	/** Exit now. */
	| { t: "exit" };

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface LogBatchEntry {
	plugin?: string;
	level: LogLevel;
	message: string;
	stack?: string;
	isError?: boolean;
	dropped?: number;
}

/** Host -> Zinc. */
export type FromHost =
	/** Sent once after `init`. `interfaces` lists the host-side / native handler interfaces. */
	| { t: "ready"; pid: number; version?: string; interfaces: string[]; startupMs?: number }
	/** Every `heartbeatMs`, from the host's main thread / tokio runtime. */
	| { t: "heartbeat"; ts: number }
	| { t: "reply"; id: number; result: WireResult }
	/** A plugin called an import forwarded to Zinc. Zinc answers with `import-reply`. */
	| { t: "import"; id: number; plugin: string; iface: string; fn: string; args: unknown[] }
	/** A host-side handler (or native timer) calls an export of a plugin (`ctx.callExport`). Zinc queues it and answers with `call-reply`. */
	| { t: "call"; id: number; plugin: string; iface: string; fn: string; args: unknown[]; timeoutMs?: number }
	/** How many imports of this plugin are in flight. While n > 0 the plugin's call timers are paused. */
	| { t: "waiting"; plugin: string; n: number }
	/** Single-plugin fault (`zhw` timeout or trap). */
	| { t: "plugin-exit"; plugin: string; kind?: "timeout" | "trap"; message: string }
	/** Plugin log output (stderr of a Rust guest, host diagnostics, or single log entry). */
	| { t: "log"; plugin?: string; level: LogLevel; message: string; stack?: string; isError?: boolean; dropped?: number }
	/** `zhw`: batched native `log.write` / `log.write-error` lines, flushed before `reply` or `import`. */
	| { t: "log-batch"; entries: LogBatchEntry[] }
	/** `zhw`: active native Rust timer count for `plugin`. */
	| { t: "timers-count"; plugin: string; count: number };
