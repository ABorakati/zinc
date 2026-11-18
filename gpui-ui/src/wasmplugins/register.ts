// Start-up registration that must exist even while plugins are off: the Settings > Plugins section (the switch). Light: no supervisor.
import { registerPluginsSettings } from "./extend/settings";
import { pluginList } from "./host";
import { manifestTools } from "./mcp/tools";

/** Does the plugin ask for `mcp.expose`? Then the settings page shows its switch. */
const asksMcp = (m: { permissions?: { capabilities?: string[] } }): boolean => !!m.permissions?.capabilities?.includes("mcp.expose");

export function register(): void {
	registerPluginsSettings(() => pluginList().map((p) => ({ id: p.id, name: String(p.manifest.name ?? p.id), version: p.manifest.version, status: p.status, mcpTools: asksMcp(p.manifest) ? manifestTools(p.manifest).tools.length : undefined })));
}
