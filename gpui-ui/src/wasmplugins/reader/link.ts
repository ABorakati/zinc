// How the reader bridge calls into plugins (their `reader-events`, `ui-events`, `note-events` exports). Defaults to the app's one
// supervisor (wasmplugins/host.ts); a test passes its own with `setReaderCaller`.
//
// There is no queue here any more: the supervisor runs ONE CALL AT A TIME PER PLUGIN (plugin-host/src/supervisor.ts), queues the
// calls of every area, and gives a plugin with a large transpiled JS file the longer budget its slow first calls need
// (phase2-integrate.md). This module only picks the supervisor.
import { getPluginSupervisor, callPlugin as appCall } from "../host";
import type { CallPlugin } from "./types";

/** The part of the supervisor this area uses. */
export interface ReaderSupervisor {
	call: CallPlugin;
	get?(id: string): { status: string } | undefined;
	on?(event: "host-restart" | "host-restarted" | "status", handler: (e: any) => void): () => void;
}
let override: ReaderSupervisor | undefined;
/** A test's own supervisor (default: the app's, wasmplugins/host.ts). */
export const setReaderCaller = (sup: ReaderSupervisor | undefined): void => {
	override = sup;
};
const base = (): ReaderSupervisor | undefined => override ?? getPluginSupervisor();

/** Call a plugin export; rejects when plugins are off. Errors are the caller's to handle (a callback never throws into the reader). */
export const callPlugin: CallPlugin = (plugin, iface, fn, args, opts) =>
	override ? override.call(plugin, iface, fn, args, opts) : appCall(plugin, iface, fn, args, opts?.timeoutMs);

/** The supervisor to hand to `PluginView`: `call` picks the test's or the app's supervisor at call time, the rest is the real one's. */
export const queuedSupervisor = {
	call: (id: string, iface: string, fn: string, args: unknown[] = [], opts?: { timeoutMs?: number }) => callPlugin(id, iface, fn, args, opts),
	get: (id: string) => base()?.get?.(id) as { id: string; dir: string; status: string } | undefined,
	on: (event: "host-restart" | "host-restarted" | "status", handler: (e: any) => void) => base()?.on?.(event, handler) ?? (() => {}),
};

/** Fire a callback into a plugin and log a failure; for hooks that cannot wait (menu commands, link clicks). */
export function notifyPlugin(plugin: string, iface: string, fn: string, args: unknown[]): void {
	void callPlugin(plugin, iface, fn, args).catch((e) => console.error(`[wasm-reader] ${plugin} ${iface}.${fn}:`, e instanceof Error ? e.message : e));
}
