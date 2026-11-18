// MCP Tools: gives AI agents two tools through Zinc's MCP server. QuickJS guest; the SDK is bundled in by plugin-api/sdk/js/scripts/build.ts.
//   mcp-tools__count_tagged  read-only. Declared in manifest.json (static), so Settings > Plugins shows it before the plugin runs.
//   mcp-tools__add_tag       adds a tag to one item. Registered at run time in `startup` (`mcp.register-tool`). Not destructive.
// Agents only see them when the user turns on "Offer MCP Tools's tools to AI agents" in Settings > Plugins (the manifest asks for `mcp.expose`).
import { definePlugin, defineTool, fail, fill, ext, registerTools } from "../../../sdk/js/src/index.ts";
import library from "zinc:plugin/library@0.1.0";
import mcp from "zinc:plugin/mcp@0.1.0";
import log from "zinc:plugin/log@0.1.0";

const countTagged = defineTool(
	{
		name: "count_tagged",
		description: "Count the library items that carry a tag. Use it to see how many items a tag covers before listing or editing them.",
		input: {
			type: "object",
			properties: { tag: { type: "string", minLength: 1, description: "The tag, exactly as shown in the tag selector." } },
			required: ["tag"],
			additionalProperties: false,
		},
		output: { type: "object", properties: { tag: { type: "string" }, count: { type: "integer" } }, required: ["tag", "count"] },
		annotations: { readOnly: true, idempotent: true },
	},
	({ tag }) => ({ tag, count: Number(library.countItems(fill("library/ItemQuery", { scope: { tag: "all" }, tags: [tag] }))) }),
);

const addTag = defineTool(
	{
		name: "add_tag",
		description: "Add a tag to one item. The item keeps its other tags; adding a tag it already has changes nothing.",
		input: {
			type: "object",
			properties: {
				item: { type: "string", pattern: "^[A-Z0-9]{8}$", description: "8-character item key." },
				tag: { type: "string", minLength: 1, maxLength: 256 },
			},
			required: ["item", "tag"],
			additionalProperties: false,
		},
		annotations: { destructive: false, idempotent: true },
	},
	({ item, tag }) => {
		const found = library.getSummaries([item], [], fill("library/ItemInclude", {}), false).filter(Boolean);
		if (!found.length) fail("not-found", `no item ${item}`);
		library.apply([ext.change("add-tags", { items: [item], tags: [{ name: tag, kind: "manual" }] })], { skipNotify: false });
		return { item, tag, added: true };
	},
);

export const { lifecycle, events, mcpHandler } = definePlugin({
	tools: [countTagged, addTag],
	lifecycle: {
		startup() {
			registerTools(mcp, [addTag]); // count_tagged is declared in manifest.json
			log.write("info", "mcp-tools started");
		},
	},
});
