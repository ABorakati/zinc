// Tool definitions of plugins (plugin-api/wit/mcp.wit): the shape jco gives the host, reading a manifest's static `mcp.tools`, checking
// what a plugin registers, and the registry of run-time registrations. Pure TS, no UI imports.
import { checkSchema } from "../../../../core/src/mcp/plugin-tools";
import { witError } from "../../../../plugin-host/src/imports/registry";
import type { PluginManifest } from "../../../../plugin-host/src/manifest";

/** `mcp.tool-def` in jco's representation (an absent option is undefined). */
export interface ToolDef {
	name: string;
	description: string;
	/** JSON text. */
	inputSchema: string;
	/** JSON text. */
	outputSchema?: string;
	annotations: { readOnly: boolean; destructive: boolean; idempotent: boolean };
}

export const MAX_TOOLS_PER_PLUGIN = 64;
export const MAX_SCHEMA_BYTES = 64 * 1024;
const NAME = /^[A-Za-z0-9_.-]{1,48}$/;

function parseSchema(text: unknown, what: string): Record<string, unknown> {
	if (typeof text !== "string") throw witError("invalid-argument", `${what} must be JSON text`);
	if (text.length > MAX_SCHEMA_BYTES) throw witError("invalid-argument", `${what} is over ${MAX_SCHEMA_BYTES} bytes`);
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch (e) {
		throw witError("invalid-argument", `${what} is not JSON: ${(e as Error).message}`);
	}
	if (!v || typeof v !== "object" || Array.isArray(v)) throw witError("invalid-argument", `${what} must be a JSON object`);
	const o = v as Record<string, unknown>;
	if (o.type !== undefined && o.type !== "object") throw witError("invalid-argument", `${what} must describe an object (type "object")`);
	const bad = checkSchema(o);
	if (bad) throw witError("invalid-argument", `${what} is not a valid JSON Schema: ${bad}`);
	return o;
}

/** Throws a WitError (`invalid-argument`) when a tool is malformed. Returns a clean copy. */
export function checkTool(t: ToolDef): ToolDef {
	if (!t || typeof t !== "object") throw witError("invalid-argument", "tool must be a record");
	if (typeof t.name !== "string" || !NAME.test(t.name)) throw witError("invalid-argument", `tool name ${JSON.stringify(t.name)} must be 1-48 characters from A-Z a-z 0-9 _ . -`);
	if (typeof t.description !== "string" || !t.description.trim()) throw witError("invalid-argument", `tool ${t.name}: description is empty`);
	if (t.description.length > 4000) throw witError("invalid-argument", `tool ${t.name}: description is over 4000 characters`);
	parseSchema(t.inputSchema, `tool ${t.name}: input-schema`);
	const outputSchema = t.outputSchema === undefined || t.outputSchema === null ? undefined : t.outputSchema;
	if (outputSchema !== undefined) parseSchema(outputSchema, `tool ${t.name}: output-schema`);
	const a = t.annotations ?? { readOnly: false, destructive: true, idempotent: false };
	return {
		name: t.name,
		description: t.description,
		inputSchema: t.inputSchema,
		outputSchema,
		annotations: { readOnly: !!a.readOnly, destructive: !!a.destructive, idempotent: !!a.idempotent },
	};
}

/** The tools a manifest declares under `mcp.tools`. A bad entry is skipped (and named in `problems`). */
export function manifestTools(manifest: PluginManifest): { tools: ToolDef[]; problems: string[] } {
	const raw = (manifest as { mcp?: { tools?: unknown } }).mcp?.tools;
	const tools: ToolDef[] = [];
	const problems: string[] = [];
	if (!Array.isArray(raw)) return { tools, problems };
	for (const e of raw.slice(0, MAX_TOOLS_PER_PLUGIN)) {
		const t = e as {
			name?: string;
			description?: string;
			input_schema?: unknown;
			output_schema?: unknown;
			annotations?: { read_only?: boolean; destructive?: boolean; idempotent?: boolean };
		};
		try {
			const readOnly = t.annotations?.read_only === true;
			tools.push(
				checkTool({
					name: t.name as string,
					description: t.description as string,
					inputSchema: JSON.stringify(t.input_schema ?? { type: "object" }),
					outputSchema: t.output_schema === undefined ? undefined : JSON.stringify(t.output_schema),
					annotations: { readOnly, destructive: readOnly ? false : t.annotations?.destructive !== false, idempotent: t.annotations?.idempotent === true },
				}),
			);
		} catch (err) {
			problems.push(`${String(t?.name)}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return { tools, problems };
}

/** Run-time registrations per plugin, and the static tools a plugin unregistered. */
export class McpRegistry {
	private runtime = new Map<string, Map<string, ToolDef>>();
	private removed = new Map<string, Set<string>>();
	private listeners = new Set<() => void>();

	/** Called when anything changes (a registration, a removal, a plugin cleared). */
	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}
	private emit(): void {
		for (const l of [...this.listeners]) {
			try {
				l();
			} catch (e) {
				console.error("[mcp] listener failed:", e instanceof Error ? e.message : e);
			}
		}
	}

	/** `staticNames`: what the manifest declares (a run-time tool replaces a static one of the same name; the limit counts both). */
	register(plugin: string, tool: ToolDef, staticNames: string[]): void {
		const mine = this.runtime.get(plugin) ?? new Map<string, ToolDef>();
		const names = new Set([...staticNames, ...mine.keys()]);
		if (!names.has(tool.name) && names.size >= MAX_TOOLS_PER_PLUGIN) throw witError("limit-exceeded", `at most ${MAX_TOOLS_PER_PLUGIN} tools per plugin`);
		mine.set(tool.name, tool);
		this.runtime.set(plugin, mine);
		this.removed.get(plugin)?.delete(tool.name);
		this.emit();
	}

	/** Static tools can be unregistered too, until the plugin restarts. */
	unregister(plugin: string, name: string, staticNames: string[]): void {
		const hadRuntime = this.runtime.get(plugin)?.delete(name) ?? false;
		const gone = this.removed.get(plugin);
		const wasStatic = staticNames.includes(name) && !gone?.has(name);
		if (!hadRuntime && !wasStatic) throw witError("not-found", `tool ${name} is not registered`);
		if (staticNames.includes(name)) {
			const set = gone ?? new Set<string>();
			set.add(name);
			this.removed.set(plugin, set);
		}
		this.emit();
	}

	/** The manifest's tools minus the unregistered ones, then the run-time ones. */
	effective(plugin: string, statics: ToolDef[]): ToolDef[] {
		const gone = this.removed.get(plugin);
		const out = new Map<string, ToolDef>();
		for (const t of statics) if (!gone?.has(t.name)) out.set(t.name, t);
		for (const t of this.runtime.get(plugin)?.values() ?? []) out.set(t.name, t);
		return [...out.values()];
	}

	/** Forget what a plugin registered (it stopped, was disabled or failed), or every plugin's (the host restarted). */
	clear(plugin?: string): void {
		if (plugin === undefined) {
			this.runtime.clear();
			this.removed.clear();
		} else {
			this.runtime.delete(plugin);
			this.removed.delete(plugin);
		}
		this.emit();
	}
}

export const mcpRegistry = new McpRegistry();
