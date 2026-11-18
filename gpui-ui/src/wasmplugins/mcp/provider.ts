// The bridge between Zinc's MCP server (core/src/mcp) and the plugins: a PluginToolProvider that lists the tools of plugins that are
// running, hold the permission `mcp.expose` and have the user's switch on, and runs a tool through the supervisor:
//
//   tools/call -> provider.call(plugin, tool, args) -> supervisor.call(plugin, "mcp-handler", "on-mcp-call", [tool, argsJson])
//
// Nothing here changes the supervisor: `call` is generic. The normal per-call time limit and the plugin's own permissions apply.
import { PluginToolError, setPluginToolProvider, type PluginTool, type PluginToolProvider, type PluginToolSource } from "../../../../core/src/mcp/plugin-tools";
import type { PluginSupervisor } from "../../../../plugin-host/src/supervisor";
import { onPluginRegistrationsReset } from "../host";
import { mcpExposed, onMcpExposureChange } from "./exposure";
import { manifestTools, mcpRegistry, type McpRegistry, type ToolDef } from "./tools";

export interface ToolProviderDeps {
	supervisor: () => PluginSupervisor | undefined;
	/** The user's per-plugin switch. */
	exposed: (pluginId: string) => boolean;
	registry?: McpRegistry;
}

export interface BridgeProvider extends PluginToolProvider {
	/** Tell listeners (long-lived MCP connections) that the set of tools may have changed. */
	notify(): void;
}

const asTool = (t: ToolDef): PluginTool => ({
	name: t.name,
	description: t.description,
	inputSchema: JSON.parse(t.inputSchema) as Record<string, unknown>,
	outputSchema: t.outputSchema ? (JSON.parse(t.outputSchema) as Record<string, unknown>) : undefined,
	annotations: { readOnly: t.annotations.readOnly, destructive: t.annotations.destructive, idempotent: t.annotations.idempotent },
});

export function createToolProvider(deps: ToolProviderDeps): BridgeProvider {
	const registry = deps.registry ?? mcpRegistry;
	const listeners = new Set<() => void>();

	/** Plugins that offer tools now. Running AND permitted (the grant is live: a denied permission goes at once) AND switched on. */
	const sources = (): PluginToolSource[] => {
		const sup = deps.supervisor();
		if (!sup) return [];
		const out: PluginToolSource[] = [];
		for (const info of sup.list()) {
			if (info.status !== "running") continue;
			if (!info.grants.capabilities.includes("mcp.expose")) continue;
			if (!deps.exposed(info.id)) continue;
			const tools = registry.effective(info.id, manifestTools(info.manifest).tools).map(asTool);
			if (tools.length) out.push({ id: info.id, name: String(info.manifest.name ?? info.id), tools });
		}
		return out;
	};

	return {
		list: sources,
		async call(plugin, tool, args) {
			const src = sources().find((s) => s.id === plugin);
			if (!src || !src.tools.some((t) => t.name === tool)) throw new PluginToolError(`tool ${tool} of ${plugin} is not available (the plugin stopped, or its tools were switched off)`);
			const sup = deps.supervisor();
			if (!sup) throw new PluginToolError("plugins are off");
			const result = await sup.call(plugin, "mcp-handler", "on-mcp-call", [tool, JSON.stringify(args)]);
			if (typeof result !== "string") throw new PluginToolError(`the plugin returned ${typeof result}, not JSON text`);
			return result;
		},
		onChange(l) {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		notify() {
			for (const l of [...listeners]) l();
		},
	};
}

/**
 * Start offering plugin tools to Zinc's MCP server. Call once the supervisor exists; call the returned function when plugins stop.
 * Registers the provider with core, drops a plugin's run-time registrations when it stops, and keeps connected clients told.
 */
export function installMcpBridge(sup: PluginSupervisor, opts: { exposed?: (id: string) => boolean; registry?: McpRegistry } = {}): () => void {
	const registry = opts.registry ?? mcpRegistry;
	const provider = createToolProvider({ supervisor: () => sup, exposed: opts.exposed ?? mcpExposed, registry });
	const offs: Array<() => void> = [];
	offs.push(onPluginRegistrationsReset((plugin) => registry.clear(plugin)));
	offs.push(registry.subscribe(() => provider.notify()));
	offs.push(onMcpExposureChange(() => provider.notify()));
	offs.push(sup.on("status", () => provider.notify()));
	offs.push(sup.on("host-restarted", () => provider.notify()));
	setPluginToolProvider(provider);
	return () => {
		for (const off of offs.splice(0)) off();
		setPluginToolProvider(undefined);
		registry.clear();
	};
}
