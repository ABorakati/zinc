// The host side of `zinc:plugin/mcp`: what a plugin's register-tool / unregister-tool / list-tools calls do in the app. Runs in the Zinc
// process. The registrations live in ./tools (mcpRegistry); ./provider turns them, the manifest's static tools, the plugin's status and the
// user's switch into what the MCP server lists.
import { defineHandler, witError, type HandlerContext } from "../../../../plugin-host/src/imports/registry";
import { checkTool, manifestTools, mcpRegistry, type ToolDef } from "./tools";

const staticOf = (ctx: HandlerContext): ToolDef[] => manifestTools(ctx.manifest).tools;

export const mcpHandler = defineHandler({
	interface: "zinc:plugin/mcp",
	where: "zinc",
	functions: {
		"register-tool"(ctx: HandlerContext, tool: ToolDef) {
			ctx.require("mcp.expose");
			const t = checkTool(tool);
			mcpRegistry.register(
				ctx.pluginId,
				t,
				staticOf(ctx).map((s) => s.name),
			);
		},
		"unregister-tool"(ctx: HandlerContext, name: string) {
			ctx.require("mcp.expose");
			if (typeof name !== "string") throw witError("invalid-argument", "name must be a string");
			mcpRegistry.unregister(
				ctx.pluginId,
				name,
				staticOf(ctx).map((s) => s.name),
			);
		},
		"list-tools"(ctx: HandlerContext) {
			ctx.require("mcp.expose");
			return mcpRegistry.effective(ctx.pluginId, staticOf(ctx));
		},
	},
});
