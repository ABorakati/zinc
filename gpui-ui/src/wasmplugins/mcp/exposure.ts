// The user's per-plugin switch for MCP tools (Settings > Plugins). Off by default, stored with the other plugin settings
// (ui-state.json, key `shell.wasmPluginMcp`: plugin id -> true). Light on purpose: the settings page reads it.
import { persisted } from "../../shell/prefs";

const [exposed, setExposed] = persisted<Record<string, boolean>>("shell.wasmPluginMcp", {}, (v) => {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, on]) => on === true)) as Record<string, boolean>;
});

const listeners = new Set<() => void>();
/** Runs when a switch changes (the provider tells connected MCP clients that the tools changed). */
export const onMcpExposureChange = (fn: () => void): (() => void) => {
	listeners.add(fn);
	return () => listeners.delete(fn);
};

/** Has the user turned on "offer this plugin's tools to AI agents"? Reactive. */
export const mcpExposed = (plugin: string): boolean => exposed()[plugin] === true;

export function setMcpExposed(plugin: string, on: boolean): void {
	const next = { ...exposed() };
	if (on) next[plugin] = true;
	else delete next[plugin];
	setExposed(next);
	for (const l of [...listeners]) l();
}
