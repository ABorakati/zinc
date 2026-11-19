// The one plugin supervisor of the app process, and the "registrations were cleared" signal.
//
// Kept apart from index.ts so the extend handler (plugin-host/src/imports/extend.zinc.ts) and the UI components can reach the
// supervisor without importing the start-up code. index.ts re-exports everything here.
import { createSignal } from "solid-js";
import type { PluginInfo, PluginSupervisor } from "../../../plugin-host/src/supervisor";

let supervisor: PluginSupervisor | undefined;
const [supervisorRev, setSupervisorRev] = createSignal(0);

/** The supervisor, once start-up has created it (undefined while plugins are off). */
export function getPluginSupervisor(): PluginSupervisor | undefined {
	return supervisor;
}
/** Reactive: re-runs when the supervisor appears or goes. */
export function pluginSupervisor(): PluginSupervisor | undefined {
	supervisorRev();
	return supervisor;
}
export function setPluginSupervisor(s: PluginSupervisor | undefined): void {
	supervisor = s;
	setSupervisorRev((n) => n + 1);
}

/**
 * Everything one plugin registered in the UI (menus, sections, columns, panes, views ...) must go when the plugin stops, is disabled,
 * or its host process restarts (the supervisor then runs `startup` again and the plugin registers anew). Each area that keeps
 * registrations (extend, ui, reader) adds a clearer here; `plugin` undefined = every plugin.
 */
export type ResetListener = (plugin: string | undefined) => void;
const listeners = new Set<ResetListener>();
export function onPluginRegistrationsReset(fn: ResetListener): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
export function resetPluginRegistrations(plugin?: string): void {
	for (const fn of [...listeners]) {
		try {
			fn(plugin);
		} catch (e) {
			console.error("[wasmplugins] reset listener failed:", e instanceof Error ? e.message : e);
		}
	}
}

/** Call an export of a plugin's `extend-handlers` (or any interface). Rejects when the supervisor is not running. */
export async function callPlugin(plugin: string, iface: string, fn: string, args: unknown[] = [], timeoutMs?: number): Promise<unknown> {
	const s = supervisor;
	if (!s) throw new Error("plugins are off");
	return s.call(plugin, iface, fn, args, timeoutMs ? { timeoutMs } : undefined);
}

/** The plugins the supervisor knows (id, manifest, status), as a signal; index.ts keeps it current. */
const [pluginList, setPluginList] = createSignal<PluginInfo[]>([]);
export { pluginList, setPluginList };

/**
 * The plugins the package manager installed (state.json), including disabled ones the supervisor has unloaded. Settings > Plugins
 * draws its install, enable and remove controls from this; index.ts keeps it current. Empty while plugins are off.
 */
export interface ManagedPlugin {
	id: string;
	name: string;
	version: string;
	/** `PluginState`: enabled, disabled, failed, blocked, incompatible, uninstalling. */
	state: string;
	detail?: string;
	/** Permissions an update added that wait for the user's approval. */
	pending?: string[];
	/** Asks for `mcp.expose`: how many tools its manifest declares. */
	mcpTools?: number;
}
const [managedPlugins, setManagedPlugins] = createSignal<ManagedPlugin[]>([]);
export { managedPlugins, setManagedPlugins };

/** True while the package runtime (package manager, install, prefs) is up; false while plugins are off or in a dev/test start. */
const [packageRuntime, setPackageRuntime] = createSignal(false);
export { packageRuntime, setPackageRuntime };

/**
 * What the Settings > Plugins buttons do. index.ts sets these when the package runtime starts and clears them when it stops, so the
 * settings page never imports the runtime (which the browser build cannot bundle: node:crypto, child processes).
 */
export interface PluginActions {
	installFromFile(): Promise<void>;
	setEnabled(id: string, on: boolean): Promise<void>;
	remove(id: string): Promise<void>;
	approvePermissions(id: string): Promise<void>;
}
let actions: PluginActions | undefined;
export const setPluginActions = (a: PluginActions | undefined): void => {
	actions = a;
};
export const pluginActions = (): PluginActions | undefined => actions;
