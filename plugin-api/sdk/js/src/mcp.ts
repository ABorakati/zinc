// Tools for AI agents (plugin-api/wit/mcp.wit; docs/developer-guide/wasm-plugins/mcp.md).
//
//   const countTagged = defineTool(
//     { name: "count_tagged", description: "Count the items that have a tag.", input: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] },
//       annotations: { readOnly: true } },
//     ({ tag }) => ({ count: library.countItems({ tags: [tag] }) }),
//   );
//   export const { lifecycle, mcpHandler } = definePlugin({ tools: [countTagged] });
//
// `definePlugin({ tools })` implements `mcp-handler.on-mcp-call` (looks the tool up by name, parses the arguments, runs the handler, writes the
// result as JSON). Tools are offered to agents either statically (copy `mcpManifest(tools)` into manifest.json: Settings > Plugins can then
// show them before the plugin runs) or at run time (`registerTools(mcp, tools)` in `startup`, with `import mcp from "zinc:plugin/mcp@0.1.0"`;
// the interface is passed in so a plugin that does not use it does not import it). Both need `mcp.expose` in the manifest.
import { fail } from "./plugin";

/** A JSON Schema object. */
export type JsonSchema = { [key: string]: unknown };

export interface ToolSpec {
	/** The tool's own name: letters, digits, `_`, `-`, `.`; 1 to 48 characters. Agents see it as `<plugin>__<name>`. */
	name: string;
	/** For the agent: what the tool does and when to use it. */
	description: string;
	/** JSON Schema of the arguments (default: any object). Zinc validates the agent's arguments against it before the handler runs. */
	input?: JsonSchema;
	/** JSON Schema of the result, when it is an object with a fixed shape. Zinc then refuses a result that does not match. */
	output?: JsonSchema;
	annotations?: {
		/** The tool changes nothing. */
		readOnly?: boolean;
		/** The tool may delete or overwrite data. Default true for a tool that is not read-only: say `false` for tools that only add. */
		destructive?: boolean;
		/** Calling again with the same arguments changes nothing more. */
		idempotent?: boolean;
	};
}

/** What the handler returns: any JSON value. Throw `fail("not-found", "...")` for an error the agent should see. */
export type ToolHandler<A = any> = (args: A) => unknown;

export interface Tool<A = any> {
	readonly spec: ToolSpec;
	readonly handler: ToolHandler<A>;
}

const NAME = /^[A-Za-z0-9_.-]{1,48}$/;

export function defineTool<A = any>(spec: ToolSpec, handler: ToolHandler<A>): Tool<A> {
	if (!NAME.test(spec.name)) throw new Error(`defineTool: name ${JSON.stringify(spec.name)} must be 1-48 characters from A-Z a-z 0-9 _ . -`);
	if (!spec.description?.trim()) throw new Error(`defineTool(${spec.name}): description is required`);
	if (typeof handler !== "function") throw new Error(`defineTool(${spec.name}): handler must be a function`);
	return { spec, handler };
}

/** The tool as `mcp.tool-def` (JSON text schemas, every annotation set). */
export function toolDef(tool: Tool) {
	const a = tool.spec.annotations ?? {};
	const readOnly = a.readOnly === true;
	return {
		name: tool.spec.name,
		description: tool.spec.description,
		inputSchema: JSON.stringify(tool.spec.input ?? { type: "object" }),
		outputSchema: tool.spec.output === undefined ? undefined : JSON.stringify(tool.spec.output),
		annotations: { readOnly, destructive: readOnly ? false : a.destructive !== false, idempotent: a.idempotent === true },
	};
}

/** The `mcp` block of manifest.json for these tools (static declaration). */
export function mcpManifest(tools: Tool[]) {
	return {
		tools: tools.map((t) => {
			const d = toolDef(t);
			return {
				name: d.name,
				description: d.description,
				input_schema: JSON.parse(d.inputSchema),
				...(d.outputSchema ? { output_schema: JSON.parse(d.outputSchema) } : {}),
				annotations: { read_only: d.annotations.readOnly, destructive: d.annotations.destructive, idempotent: d.annotations.idempotent },
			};
		}),
	};
}

/** Offer tools at run time. `mcp` is the imported interface: `import mcp from "zinc:plugin/mcp@0.1.0"`. Call it from `lifecycle.startup`. */
export function registerTools(mcp: { registerTool(def: ReturnType<typeof toolDef>): void }, tools: Tool[]): void {
	for (const t of tools) mcp.registerTool(toolDef(t));
}

const isWitError = (e: unknown): e is { tag: string } => !!e && typeof e === "object" && typeof (e as { tag?: unknown }).tag === "string";

/** `mcp-handler.on-mcp-call` for a list of tools. `definePlugin({ tools })` uses it. */
export function callTool(tools: Tool[], name: string, argsJson: string): string {
	const tool = tools.find((t) => t.spec.name === name);
	if (!tool) fail("not-found", `no tool named ${name}`);
	let args: unknown;
	try {
		args = argsJson ? JSON.parse(argsJson) : {};
	} catch {
		fail("invalid-argument", "the arguments are not valid JSON");
	}
	let result: unknown;
	try {
		result = tool.handler(args);
	} catch (e) {
		if (isWitError(e)) throw e;
		fail("internal", `${name}: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (result && typeof (result as { then?: unknown }).then === "function") fail("unavailable", `${name}: tool handlers must return their result, not a Promise (plugins run synchronously)`);
	return result === undefined ? "null" : JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
}
