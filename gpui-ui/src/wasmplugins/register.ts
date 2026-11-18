// Start-up registration that must exist even while plugins are off: the Settings > Plugins section (the switch). Light: no supervisor.
import { registerPluginsSettings } from "./extend/settings";
import { pluginList } from "./host";

export function register(): void {
	registerPluginsSettings(() => pluginList().map((p) => ({ id: p.id, name: String(p.manifest.name ?? p.id), version: p.manifest.version, status: p.status })));
}
