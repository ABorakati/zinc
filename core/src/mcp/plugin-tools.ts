// Tools contributed by WASM plugins, served through the MCP server next to the library tools.
//
// Core does not know about plugins. The app (gpui-ui/src/wasmplugins/mcp) registers a PluginToolProvider while plugins run and
// clears it on shutdown; this module turns what the provider lists into MCP tools:
//
//   name         `<plugin-short-name>__<tool>`, sanitised to [a-z0-9_-], at most 64 characters, unique among plugin tools and never one of
//                the library tools (a clash gets a `_2`, `_3` ... suffix on the plugin short name or the tool part)
//   description  starts with `[<plugin name>] `, so the agent knows where the tool comes from
//   input        the plugin's JSON schema; arguments are validated against it (Ajv, through the MCP SDK's provider) before the plugin runs
//   annotations  readOnlyHint / destructiveHint / idempotentHint from the plugin's declaration; openWorldHint false
//   errors       a plugin error, a timeout or invalid arguments is an MCP tool error (`isError: true`), never a protocol error
//
// Listing and calling are stateless: every `tools/list` and `tools/call` asks the provider afresh, so a plugin that stopped, was
// disabled or whose switch was turned off disappears at the next request. Only the HTTP transport inside the running app has a
// provider (stdio never does). The provider decides who may be listed (consent: manifest `mcp.expose` AND the user's per-plugin
// switch); core lists whatever it is given.
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";

/** One tool a plugin offers. `inputSchema` must be a JSON Schema of `type: "object"`. */
export interface PluginTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations?: { readOnly?: boolean; destructive?: boolean; idempotent?: boolean };
}

/** A running, consenting plugin and its tools. */
export interface PluginToolSource {
	/** The plugin id from its manifest, for example `my-plugin@example.org`. */
	id: string;
	/** Display name (manifest `name`). */
	name: string;
	tools: PluginTool[];
}

export interface PluginToolProvider {
	/** Plugins that currently expose tools: running, enabled, permitted and switched on by the user. */
	list(): PluginToolSource[] | Promise<PluginToolSource[]>;
	/**
	 * Run one tool. `tool` is the plugin's own tool name. Resolves with the JSON text the plugin returned; throws (any Error, or a
	 * PluginToolError) when the plugin fails, is stopped or times out.
	 */
	call(plugin: string, tool: string, args: Record<string, unknown>): Promise<string>;
	/** The set of tools changed. Long-lived transports (in-memory, SSE) turn this into `notifications/tools/list_changed`. */
	onChange?(listener: () => void): () => void;
}

/** An error with a message meant for the agent. */
export class PluginToolError extends Error {}

let current: PluginToolProvider | undefined;

/** The app calls this when plugins start (with the provider) and when they stop (with undefined). */
export function setPluginToolProvider(provider: PluginToolProvider | undefined): void {
	current = provider;
}
export function getPluginToolProvider(): PluginToolProvider | undefined {
	return current;
}

// ---------------------------------------------------------------- naming

const MAX_NAME = 64;
const SEP = "__";
const MAX_DESCRIPTION = 4000;
const MAX_SCHEMA_BYTES = 64 * 1024;

/** [a-z0-9_-] only, runs of other characters become one `-`, no leading or trailing `-`/`_`. */
export function sanitizeName(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "");
}

/** `my-plugin@example.org` -> `my-plugin`. A GUID id or an empty result falls back to the display name, then to `plugin`. */
export function pluginShortName(id: string, name: string): string {
	const local = id.startsWith("{") ? "" : sanitizeName(id.split("@")[0] ?? "");
	return local || sanitizeName(name) || "plugin";
}

export interface ExposedTool {
	/** The name the MCP client sees. */
	name: string;
	plugin: string;
	pluginName: string;
	/** The plugin's own tool name. */
	tool: string;
	description: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: false };
}

const isObjectSchema = (s: unknown): s is Record<string, unknown> =>
	!!s && typeof s === "object" && !Array.isArray(s) && ((s as Record<string, unknown>).type === "object" || (s as Record<string, unknown>).type === undefined);

function unique(base: string, taken: Set<string>): string {
	let n = 1;
	let out = base;
	while (taken.has(out)) {
		n++;
		const suffix = `_${n}`;
		out = base.slice(0, MAX_NAME - suffix.length) + suffix;
	}
	taken.add(out);
	return out;
}

/**
 * The MCP tools for what a provider lists. Deterministic: plugins sorted by id, tools by name. `reserved` are names that may not be used
 * (the library tools). Tools that cannot be exposed (bad name, schema not an object, schema too large) are skipped and reported in `skipped`.
 */
export function exposeTools(sources: PluginToolSource[], reserved: Iterable<string> = []): { tools: ExposedTool[]; skipped: string[] } {
	const taken = new Set<string>(reserved);
	const tools: ExposedTool[] = [];
	const skipped: string[] = [];
	const shorts = new Set<string>();
	const plugins = [...sources].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	for (const src of plugins) {
		// one short name per plugin; leave room for the separator and a one-character tool part
		const short = unique(pluginShortName(src.id, src.name).slice(0, 28).replace(/[-_]+$/, "") || "plugin", shorts);
		for (const t of [...src.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			const part = sanitizeName(t.name);
			if (!part) {
				skipped.push(`${src.id}: tool name ${JSON.stringify(t.name)} has no usable characters`);
				continue;
			}
			if (!isObjectSchema(t.inputSchema) || JSON.stringify(t.inputSchema).length > MAX_SCHEMA_BYTES) {
				skipped.push(`${src.id}: ${t.name}: input schema must be an object schema under ${MAX_SCHEMA_BYTES} bytes`);
				continue;
			}
			if (t.outputSchema !== undefined && (!isObjectSchema(t.outputSchema) || JSON.stringify(t.outputSchema).length > MAX_SCHEMA_BYTES)) {
				skipped.push(`${src.id}: ${t.name}: output schema must be an object schema under ${MAX_SCHEMA_BYTES} bytes`);
				continue;
			}
			const name = unique((short + SEP + part).slice(0, MAX_NAME).replace(/[-_]+$/, ""), taken);
			const a = t.annotations ?? {};
			const readOnly = a.readOnly === true;
			const label = `[${src.name}] `;
			const description = (label + (t.description || "")).slice(0, MAX_DESCRIPTION);
			tools.push({
				name,
				plugin: src.id,
				pluginName: src.name,
				tool: t.name,
				description,
				inputSchema: { type: "object", ...t.inputSchema },
				outputSchema: t.outputSchema ? { type: "object", ...t.outputSchema } : undefined,
				// MCP: destructiveHint only means something when the tool is not read-only
				annotations: {
					readOnlyHint: readOnly,
					destructiveHint: readOnly ? false : a.destructive !== false,
					idempotentHint: a.idempotent === true,
					openWorldHint: false,
				},
			});
		}
	}
	return { tools, skipped };
}

// ---------------------------------------------------------------- validation

const validator = new AjvJsonSchemaValidator();
const compiled = new WeakMap<object, JsonSchemaValidator<unknown> | Error>();

/** Check `args` against a tool's input schema. Returns an error text for the agent, or undefined when valid. */
export function validateArgs(schema: Record<string, unknown>, args: unknown): string | undefined {
	let v = compiled.get(schema);
	if (!v) {
		try {
			v = validator.getValidator<unknown>(schema as never);
		} catch (e) {
			v = e instanceof Error ? e : new Error(String(e));
		}
		compiled.set(schema, v);
	}
	if (v instanceof Error) return `the tool's input schema is not valid JSON Schema: ${v.message}`;
	const r = v(args);
	return r.valid ? undefined : (r.errorMessage ?? "arguments do not match the input schema");
}

/** Is this a JSON Schema the validator can compile? Returns the problem, or undefined. For the plugin host's register-tool check. */
export function checkSchema(schema: Record<string, unknown>): string | undefined {
	try {
		validator.getValidator<unknown>(schema as never);
		return undefined;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}
