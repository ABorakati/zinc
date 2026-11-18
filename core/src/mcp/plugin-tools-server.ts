// Adds plugin tools to an McpServer: `tools/list` returns the library tools plus the plugin tools, `tools/call` runs a plugin tool when the
// name is one. See plugin-tools.ts for the rules.
//
// McpServer only takes zod schemas, and a plugin brings JSON Schema, so the two request handlers are wrapped at the protocol level. The
// SDK keeps its own handlers in a private map; the wrapper calls them for everything that is not a plugin tool. If an SDK upgrade moves
// that map, attachPluginTools throws at start-up (core/test/mcp/plugin-tools.test.ts fails first).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { exposeTools, validateArgs, type ExposedTool, type PluginToolProvider } from "./plugin-tools";

const MAX_RESULT_CHARS = 100_000;
const CALL_TIMEOUT_MS = 120_000;

type Handler = (request: unknown, extra: unknown) => Promise<any>;

function toolError(message: string) {
	return { content: [{ type: "text" as const, text: message }], isError: true };
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function attachPluginTools(server: McpServer, provider: PluginToolProvider, opts: { callTimeoutMs?: number } = {}): void {
	const low = server.server;
	const handlers = (low as unknown as { _requestHandlers?: Map<string, Handler> })._requestHandlers;
	const baseList = handlers?.get("tools/list");
	const baseCall = handlers?.get("tools/call");
	if (!baseList || !baseCall) throw new Error("MCP SDK changed: cannot find the tools/list and tools/call handlers to extend");

	let builtinNames: string[] | undefined;
	const builtins = async (request: unknown, extra: unknown): Promise<{ tools: { name: string }[] }> => {
		const r = (await baseList(request, extra)) as { tools: { name: string }[] };
		builtinNames ??= r.tools.map((t) => t.name);
		return r;
	};

	/** What the provider exposes right now. A failing provider exposes nothing: the library tools keep working. */
	const exposed = async (reserved: string[]): Promise<ExposedTool[]> => {
		try {
			return exposeTools(await provider.list(), reserved).tools;
		} catch (e) {
			console.error("[mcp] plugin tool provider failed:", messageOf(e));
			return [];
		}
	};

	low.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
		const base = await builtins(request, extra);
		const plugin = await exposed(builtinNames!);
		return {
			...base,
			tools: [
				...base.tools,
				...plugin.map((t) => ({
					name: t.name,
					description: t.description,
					inputSchema: t.inputSchema,
					...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
					annotations: t.annotations,
				})),
			],
		} as never;
	});

	low.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const name = request.params.name;
		if (!builtinNames) await builtins({ method: "tools/list", params: {} }, extra);
		if (builtinNames!.includes(name)) return baseCall(request, extra);
		const tool = (await exposed(builtinNames!)).find((t) => t.name === name);
		if (!tool) return baseCall(request, extra); // the SDK's own "tool not found" error
		return runPluginTool(provider, tool, request.params.arguments ?? {}, opts.callTimeoutMs ?? CALL_TIMEOUT_MS) as never;
	});

	// A long-lived transport (in-memory, SSE) gets `notifications/tools/list_changed` when the set of tools changes. The HTTP endpoint is
	// stateless (one request per server, no stream to push on), so there the client simply lists again.
	const off = provider.onChange?.(() => {
		try {
			server.sendToolListChanged();
		} catch {
			/* not connected */
		}
	});
	if (off) {
		const prev = low.onclose;
		low.onclose = () => {
			off();
			prev?.();
		};
	}
}

async function runPluginTool(provider: PluginToolProvider, tool: ExposedTool, args: unknown, timeoutMs: number) {
	if (!args || typeof args !== "object" || Array.isArray(args)) return toolError(`${tool.name}: arguments must be an object`);
	const invalid = validateArgs(tool.inputSchema, args);
	if (invalid) return toolError(`Invalid arguments for ${tool.name}: ${invalid}`);

	let text: string;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		text = await Promise.race([
			provider.call(tool.plugin, tool.tool, args as Record<string, unknown>),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
			}),
		]);
	} catch (e) {
		return toolError(`${tool.name} (${tool.pluginName}) failed: ${messageOf(e)}`);
	} finally {
		if (timer) clearTimeout(timer);
	}

	let value: unknown = text;
	let parsed = false;
	if (typeof text === "string") {
		try {
			value = JSON.parse(text);
			parsed = true;
		} catch {
			/* not JSON: shown as plain text */
		}
	}
	if (tool.outputSchema) {
		if (!parsed || !value || typeof value !== "object" || Array.isArray(value)) return toolError(`${tool.name} returned something that is not a JSON object, but declares an output schema`);
		const bad = validateArgs(tool.outputSchema, value);
		if (bad) return toolError(`${tool.name} returned data that does not match its output schema: ${bad}`);
	}
	let out = typeof value === "string" ? value : JSON.stringify(value, null, 1);
	if (out.length > MAX_RESULT_CHARS) out = out.slice(0, MAX_RESULT_CHARS) + `\n… (cut at ${MAX_RESULT_CHARS} characters)`;
	return {
		content: [{ type: "text" as const, text: out }],
		...(tool.outputSchema ? { structuredContent: value as Record<string, unknown> } : {}),
	};
}
