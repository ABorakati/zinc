// The MCP bridge without a window or a plugin host: the zinc handler (permission, validation, replace, limit), the provider (running +
// permission + switch, the call goes to mcp-handler.on-mcp-call, errors), and the install/clear of the core provider. The real chain with
// a built plugin is plugin-api/samples/test.ts (section mcp-tools).
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { handleMcp } from "../../../../core/src/mcp/http";
import { getPluginToolProvider } from "../../../../core/src/mcp/plugin-tools";
import { buildFixture, type Fixture } from "../../../../core/test/fixture";
import type { HandlerContext } from "../../../../plugin-host/src/imports/registry";
import type { PluginManifest } from "../../../../plugin-host/src/manifest";
import { PluginError } from "../../../../plugin-host/src/protocol";
import type { PluginInfo, PluginSupervisor } from "../../../../plugin-host/src/supervisor";
import { mcpHandler } from "./handler";
import { createToolProvider, installMcpBridge } from "./provider";
import { manifestTools, McpRegistry, mcpRegistry, MAX_TOOLS_PER_PLUGIN, type ToolDef } from "./tools";

const fns = mcpHandler.functions as Record<string, (ctx: HandlerContext, ...a: any[]) => any>;

const manifest = (over: Record<string, unknown> = {}): PluginManifest =>
	({
		manifest_version: 1,
		id: "demo@zinc.test",
		name: "Demo",
		version: "1.0.0",
		main: { wasm: "plugin.wasm" },
		permissions: { capabilities: ["mcp.expose"] },
		mcp: {
			tools: [
				{ name: "count", description: "Count things.", input_schema: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] }, annotations: { read_only: true, idempotent: true } },
				{ name: "add", description: "Add a tag.", input_schema: { type: "object", properties: {} }, annotations: { destructive: false } },
			],
		},
		...over,
	}) as PluginManifest;

const ctxFor = (m: PluginManifest, caps = ["mcp.expose"]): HandlerContext =>
	({
		pluginId: m.id,
		manifest: m,
		has: (p: string) => caps.includes(p),
		require(p: string) {
			if (!caps.includes(p)) throw Object.assign(new Error(`permission-denied: ${p}`), { payload: { tag: "permission-denied", val: p } });
		},
	}) as unknown as HandlerContext;

const tool = (name: string, over: Partial<ToolDef> = {}): ToolDef => ({
	name,
	description: `Does ${name}.`,
	inputSchema: JSON.stringify({ type: "object", properties: { a: { type: "integer" } } }),
	outputSchema: undefined,
	annotations: { readOnly: false, destructive: false, idempotent: false },
	...over,
});

const payloadTag = (f: () => unknown): string | undefined => {
	try {
		f();
	} catch (e) {
		return (e as { payload?: { tag: string } }).payload?.tag ?? "other";
	}
	return undefined;
};

describe("manifest tools", () => {
	test("static tools are read with the right annotations; bad ones are reported", () => {
		const m = manifest();
		const { tools, problems } = manifestTools(m);
		expect(problems).toEqual([]);
		expect(tools.map((t) => [t.name, t.annotations])).toEqual([
			["count", { readOnly: true, destructive: false, idempotent: true }],
			["add", { readOnly: false, destructive: false, idempotent: false }],
		]);
		const bad = manifestTools(manifest({ mcp: { tools: [{ name: "bad name!", description: "x", input_schema: {} }, { name: "ok", description: "x", input_schema: { type: "object" } }] } }));
		expect(bad.tools.map((t) => t.name)).toEqual(["ok"]);
		expect(bad.problems.length).toBe(1);
	});
});

describe("zinc:plugin/mcp handler", () => {
	const m = manifest({ id: "h@zinc.test" });
	afterEachClear();

	test("every call needs mcp.expose", () => {
		const nope = ctxFor(m, []);
		expect(payloadTag(() => fns["register-tool"](nope, tool("x")))).toBe("permission-denied");
		expect(payloadTag(() => fns["unregister-tool"](nope, "x"))).toBe("permission-denied");
		expect(payloadTag(() => fns["list-tools"](nope))).toBe("permission-denied");
	});

	test("register, replace, list, unregister", () => {
		const c = ctxFor(m);
		expect(fns["list-tools"](c).map((t: ToolDef) => t.name)).toEqual(["count", "add"]); // the manifest's
		fns["register-tool"](c, tool("extra"));
		fns["register-tool"](c, tool("count", { description: "Replaced." })); // replaces the static one
		const now = fns["list-tools"](c) as ToolDef[];
		expect(now.map((t) => t.name)).toEqual(["count", "add", "extra"]);
		expect(now.find((t) => t.name === "count")!.description).toBe("Replaced.");
		fns["unregister-tool"](c, "extra");
		fns["unregister-tool"](c, "add"); // a static tool can be removed too
		expect((fns["list-tools"](c) as ToolDef[]).map((t) => t.name)).toEqual(["count"]);
		expect(payloadTag(() => fns["unregister-tool"](c, "extra"))).toBe("not-found");
		expect(payloadTag(() => fns["unregister-tool"](c, "add"))).toBe("not-found");
	});

	test("a malformed tool is invalid-argument", () => {
		const c = ctxFor(m);
		expect(payloadTag(() => fns["register-tool"](c, tool("bad name")))).toBe("invalid-argument");
		expect(payloadTag(() => fns["register-tool"](c, tool("x".repeat(49))))).toBe("invalid-argument");
		expect(payloadTag(() => fns["register-tool"](c, tool("d", { description: "  " })))).toBe("invalid-argument");
		expect(payloadTag(() => fns["register-tool"](c, tool("d", { inputSchema: "not json" })))).toBe("invalid-argument");
		expect(payloadTag(() => fns["register-tool"](c, tool("d", { inputSchema: "[]" })))).toBe("invalid-argument");
		expect(payloadTag(() => fns["register-tool"](c, tool("d", { inputSchema: JSON.stringify({ type: "string" }) })))).toBe("invalid-argument");
		expect(payloadTag(() => fns["register-tool"](c, tool("d", { inputSchema: JSON.stringify({ type: "object", properties: { a: { type: "nonsense" } } }) })))).toBe("invalid-argument");
		expect(payloadTag(() => fns["register-tool"](c, tool("d", { outputSchema: "{" })))).toBe("invalid-argument");
	});

	test("at most 64 tools per plugin", () => {
		const reg = new McpRegistry();
		for (let i = 0; i < MAX_TOOLS_PER_PLUGIN; i++) reg.register("p", tool(`t${i}`), []);
		expect(payloadTag(() => reg.register("p", tool("one-more"), []))).toBe("limit-exceeded");
		reg.register("p", tool("t0", { description: "again" }), []); // replacing is fine
	});
});

function afterEachClear() {
	afterEach(() => mcpRegistry.clear()); // the handler uses the shared registry
}

// ---- provider ---------------------------------------------------------------------------------------------------------------------

interface FakeSup extends PluginSupervisor {
	calls: { id: string; iface: string; fn: string; args: unknown[] }[];
	plugins: PluginInfo[];
	reply: (args: unknown[]) => unknown;
	emit(event: string): void;
}

function fakeSupervisor(plugins: PluginInfo[]): FakeSup {
	const handlers = new Map<string, Set<(e: unknown) => void>>();
	const sup = {
		calls: [] as FakeSup["calls"],
		plugins,
		reply: (args: unknown[]) => JSON.stringify({ got: args }),
		list: () => sup.plugins,
		async call(id: string, iface: string, fn: string, args: unknown[] = []) {
			sup.calls.push({ id, iface, fn, args });
			return sup.reply(args);
		},
		on(event: string, h: (e: unknown) => void) {
			const set = handlers.get(event) ?? new Set();
			set.add(h);
			handlers.set(event, set);
			return () => set.delete(h);
		},
		emit(event: string) {
			for (const h of handlers.get(event) ?? []) h({ plugin: "demo@zinc.test", status: "running" });
		},
	};
	return sup as unknown as FakeSup;
}

const info = (m: PluginManifest, status: PluginInfo["status"] = "running", caps = ["mcp.expose"]): PluginInfo => ({
	id: m.id,
	dir: "/x",
	manifest: m,
	status,
	grants: { capabilities: caps, netHosts: [] },
});

describe("tool provider", () => {
	test("lists only running plugins that hold mcp.expose and are switched on", () => {
		const m = manifest();
		const reg = new McpRegistry();
		const sup = fakeSupervisor([info(m)]);
		let on = false;
		const p = createToolProvider({ supervisor: () => sup, exposed: () => on, registry: reg });
		expect(p.list()).toEqual([]); // switch off (the default)
		on = true;
		const src = p.list() as { id: string; name: string; tools: { name: string }[] }[];
		expect(src.map((s) => [s.id, s.name, s.tools.map((t) => t.name)])).toEqual([["demo@zinc.test", "Demo", ["count", "add"]]]);
		sup.plugins = [info(m, "stopped")];
		expect(p.list()).toEqual([]);
		sup.plugins = [info(m, "disabled")];
		expect(p.list()).toEqual([]);
		sup.plugins = [info(m, "failed")];
		expect(p.list()).toEqual([]);
		sup.plugins = [info(m, "running", [])]; // the permission was denied by the user
		expect(p.list()).toEqual([]);
		sup.plugins = [info(m)];
		expect((p.list() as unknown[]).length).toBe(1);
		const none = createToolProvider({ supervisor: () => undefined, exposed: () => true, registry: reg });
		expect(none.list()).toEqual([]);
	});

	test("run-time registrations join the manifest's and go when cleared", () => {
		const m = manifest();
		const reg = new McpRegistry();
		const sup = fakeSupervisor([info(m)]);
		const p = createToolProvider({ supervisor: () => sup, exposed: () => true, registry: reg });
		reg.register(m.id, tool("dyn"), ["count", "add"]);
		expect((p.list() as any[])[0].tools.map((t: any) => t.name)).toEqual(["count", "add", "dyn"]);
		reg.clear(m.id);
		expect((p.list() as any[])[0].tools.map((t: any) => t.name)).toEqual(["count", "add"]);
	});

	test("call goes to mcp-handler.on-mcp-call with the tool name and the arguments as JSON text", async () => {
		const m = manifest();
		const sup = fakeSupervisor([info(m)]);
		const p = createToolProvider({ supervisor: () => sup, exposed: () => true, registry: new McpRegistry() });
		const out = await p.call(m.id, "count", { tag: "lung" });
		expect(sup.calls).toEqual([{ id: m.id, iface: "mcp-handler", fn: "on-mcp-call", args: ["count", JSON.stringify({ tag: "lung" })] }]);
		expect(JSON.parse(out)).toEqual({ got: ["count", '{"tag":"lung"}'] });
	});

	test("call refuses a tool that is not offered, and passes plugin errors on", async () => {
		const m = manifest();
		const sup = fakeSupervisor([info(m)]);
		let on = true;
		const p = createToolProvider({ supervisor: () => sup, exposed: () => on, registry: new McpRegistry() });
		await expect(p.call(m.id, "nope", {})).rejects.toThrow("not available");
		on = false;
		await expect(p.call(m.id, "count", {})).rejects.toThrow("not available");
		expect(sup.calls.length).toBe(0);
		on = true;
		sup.reply = () => {
			throw new PluginError({ kind: "wit", payload: { tag: "not-found", val: "no such item" } } as never);
		};
		await expect(p.call(m.id, "count", { tag: "x" })).rejects.toThrow("not-found: no such item");
	});
});

// ---- install + the HTTP endpoint ------------------------------------------------------------------------------------------------------

describe("bridge install", () => {
	let fx: Fixture | undefined;
	afterEach(() => {
		fx?.db.close(true);
		fx = undefined;
	});

	test("install registers the provider with core, clears registrations on stop and on shutdown; the HTTP endpoint serves the tools", async () => {
		const m = manifest();
		const sup = fakeSupervisor([info(m)]);
		const reg = new McpRegistry();
		let on = true;
		expect(getPluginToolProvider()).toBeUndefined();
		const dispose = installMcpBridge(sup, { exposed: () => on, registry: reg });
		expect(getPluginToolProvider()).toBeDefined();

		fx = buildFixture();
		const db: Database = fx.db;
		const rpc = (body: unknown) =>
			new Request("http://127.0.0.1:23120/mcp", {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Host: "127.0.0.1:23120", "MCP-Protocol-Version": "2025-06-18" },
				body: JSON.stringify(body),
			});
		const names = async () => (((await (await handleMcp(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }), db))!.json()) as any).result.tools as { name: string; description: string; annotations: any }[]);
		const list = await names();
		const count = list.find((t) => t.name === "demo__count")!;
		expect(count.description).toBe("[Demo] Count things.");
		expect(count.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
		expect(list.find((t) => t.name === "demo__add")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });

		const res = await handleMcp(rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "demo__count", arguments: { tag: "lung" } } }), db);
		expect(JSON.parse(((await res!.json()) as any).result.content[0].text)).toEqual({ got: ["count", '{"tag":"lung"}'] });
		const invalid = await handleMcp(rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "demo__count", arguments: {} } }), db);
		expect(((await invalid!.json()) as any).result.isError).toBe(true);

		// the user turns the switch off: the tools are gone at the next request
		on = false;
		expect((await names()).some((t) => t.name.startsWith("demo__"))).toBe(false);
		on = true;
		reg.register(m.id, tool("dyn"), ["count", "add"]);
		expect((await names()).some((t) => t.name === "demo__dyn")).toBe(true);

		dispose();
		expect(getPluginToolProvider()).toBeUndefined();
		expect((await names()).some((t) => t.name.startsWith("demo__"))).toBe(false);
	});
});
