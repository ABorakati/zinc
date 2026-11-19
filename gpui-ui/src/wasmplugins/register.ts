// Start-up registration that must exist even while plugins are off: the Settings > Plugins section (the switch). Light: no supervisor.
import { registerPluginsSettings, type PluginRowInfo } from "./extend/settings";
import { managedPlugins, packageRuntime, pluginList } from "./host";
import { manifestTools } from "./mcp/tools";

/** Does the plugin ask for `mcp.expose`? Then the settings page shows its switch. */
const asksMcp = (m: { permissions?: { capabilities?: string[] } }): boolean => !!m.permissions?.capabilities?.includes("mcp.expose");

/**
 * The rows: every installed plugin (the package manager's list, so a disabled plugin the supervisor unloaded stays listed), then
 * folders loaded straight into the supervisor (ZN_WASM_PLUGIN_DIRS), which cannot be turned off or removed from here.
 */
export function pluginRows(): PluginRowInfo[] {
	const loaded = pluginList();
	const status = new Map(loaded.map((p) => [p.id, p.status] as const));
	const managed = managedPlugins();
	const out: PluginRowInfo[] = managed.map((p) => ({
		id: p.id,
		name: p.name,
		version: p.version,
		// a plugin the user turned off reads "off"; other states keep their reason (a failure, "new permissions need your approval")
		status: p.state === "enabled" ? (status.get(p.id) ?? "not loaded") : p.state === "disabled" && p.detail === "disabled by the user" ? "off" : p.state,
		detail: p.state === "disabled" && p.detail === "disabled by the user" ? undefined : p.detail,
		managed: true,
		enabled: p.state !== "disabled",
		pending: !!p.pending?.length,
		mcpTools: p.mcpTools,
	}));
	const ids = new Set(managed.map((p) => p.id));
	for (const p of loaded) {
		if (ids.has(p.id)) continue;
		out.push({
			id: p.id,
			name: String(p.manifest.name ?? p.id),
			version: p.manifest.version,
			status: p.status,
			detail: p.reason,
			managed: false,
			enabled: true,
			pending: false,
			mcpTools: asksMcp(p.manifest) ? manifestTools(p.manifest).tools.length : undefined,
		});
	}
	return out;
}

export function register(): void {
	// Install needs the package runtime (a dev or test start has a supervisor but no package manager)
	registerPluginsSettings(pluginRows, packageRuntime);
}
