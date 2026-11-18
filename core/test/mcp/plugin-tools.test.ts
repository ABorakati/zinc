// Plugin tools through the MCP server, with a fake provider (no plugin host here: the real chain is tested by plugin-api/samples/test.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { handleMcp } from "../../src/mcp/http";
import { exposeTools, PluginToolError, pluginShortName, sanitizeName, setPluginToolProvider, type PluginToolProvider, type PluginToolSource } from "../../src/mcp/plugin-tools";
import { createMcpServer } from "../../src/mcp/server";
import { buildFixture, type Fixture } from "../fixture";

let fx: Fixture;
beforeAll(() => {
	fx = buildFixture();
});
afterAll(() => {
	setPluginToolProvider(undefined);
	fx.db.close(true);
});

const countSchema = {
	type: "object",
	properties: { tag: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 10 } },
	required: ["tag"],
	additionalProperties: false,
};

function sources(): PluginToolSource[] {
	return [
		{
			id: "mcp-tools@zinc.example",
			name: "MCP Tools",
			tools: [
				{ name: "count_tagged", description: "Count items with a tag.", inputSchema: countSchema, annotations: { readOnly: true, idempotent: true } },
				{ name: "add_tag", description: "Add a tag.", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] }, annotations: { destructive: false, idempotent: true } },
				{ name: "wipe", description: "Dangerous.", inputSchema: { type: "object", properties: {} } },
				{
					name: "stats",
					description: "With an output schema.",
					inputSchema: { type: "object", properties: {} },
					outputSchema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
					annotations: { readOnly: true },
				},
			],
		},
	];
}

interface Fake extends PluginToolProvider {
	calls: { plugin: string; tool: string; args: Record<string, unknown> }[];
	sources: PluginToolSource[];
	reply: (tool: string, args: Record<string, unknown>) => string | Promise<string>;
	fire(): void;
	failList?: boolean;
}

function fake(): Fake {
	const listeners = new Set<() => void>();
	const f: Fake = {
		calls: [],
		sources: sources(),
		reply: (tool, args) => JSON.stringify({ tool, args }),
		list() {
			if (f.failList) throw new Error("provider is broken");
			return f.sources;
		},
		async call(plugin, tool, args) {
			f.calls.push({ plugin, tool, args });
			return f.reply(tool, args);
		},
		onChange(l) {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		fire() {
			for (const l of [...listeners]) l();
		},
	};
	return f;
}

async function connect(provider?: PluginToolProvider, opts: { onNotification?: () => void } = {}) {
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const server = createMcpServer(fx.db, { pluginTools: provider });
	await server.connect(st);
	const client = new Client({ name: "test", version: "0" });
	if (opts.onNotification) client.setNotificationHandler(ToolListChangedNotificationSchema, opts.onNotification);
	await client.connect(ct);
	return { client, server };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
	return (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: any };
}

describe("naming", () => {
	test("sanitizeName and pluginShortName", () => {
		expect(sanitizeName("My Tool!")).toBe("my-tool");
		expect(sanitizeName("__a__b__")).toBe("a__b");
		expect(pluginShortName("my-plugin@example.org", "X")).toBe("my-plugin");
		expect(pluginShortName("{12345678-1234-1234-1234-123456789abc}", "Fancy Plugin")).toBe("fancy-plugin");
		expect(pluginShortName("@x.org", "")).toBe("plugin");
	});

	test("names are <short>__<tool>, within 64 characters, unique and never a library tool", () => {
		const long = "t".repeat(100);
		const src: PluginToolSource[] = [
			{ id: "a@x.org", name: "A", tools: [{ name: "Do It", description: "", inputSchema: { type: "object" } }, { name: long, description: "", inputSchema: { type: "object" } }, { name: "search_library", description: "", inputSchema: { type: "object" } }] },
			{ id: "a@y.org", name: "A too", tools: [{ name: "Do It", description: "", inputSchema: { type: "object" } }] },
			{ id: "b@x.org", name: "B", tools: [{ name: "!!!", description: "", inputSchema: { type: "object" } }, { name: "x", description: "", inputSchema: { type: "object" } }] },
		];
		const r = exposeTools(src, ["a__search_library"]);
		const names = r.tools.map((t) => t.name);
		expect(new Set(names).size).toBe(names.length);
		expect(names).toContain("a__do-it");
		expect(names).toContain("a_2__do-it"); // the second plugin called "a"
		expect(names).toContain("b__x");
		expect(names).toContain("a__search_library_2"); // the reserved name is taken
		for (const n of names) {
			expect(n.length).toBeLessThanOrEqual(64);
			expect(n).toMatch(/^[a-z0-9_-]+$/);
		}
		expect(r.skipped.length).toBe(1); // "!!!"
		// deterministic: the same input gives the same names, whatever the order
		expect(exposeTools([...src].reverse(), ["a__search_library"]).tools.map((t) => t.name).sort()).toEqual([...names].sort());
	});

	test("a tool whose schema is not an object schema is skipped", () => {
		const r = exposeTools([{ id: "p@x.org", name: "P", tools: [{ name: "bad", description: "", inputSchema: { type: "array" } }, { name: "ok", description: "", inputSchema: { type: "object" } }] }]);
		expect(r.tools.map((t) => t.name)).toEqual(["p__ok"]);
		expect(r.skipped[0]).toContain("bad");
	});
});

describe("tools/list", () => {
	test("lists library tools and plugin tools with names, descriptions, schemas and annotations", async () => {
		const { client } = await connect(fake());
		const { tools } = await client.listTools();
		const by = Object.fromEntries(tools.map((t) => [t.name, t]));
		expect(tools.length).toBe(17 + 4);
		expect(by.search_library).toBeDefined();

		const count = by["mcp-tools__count_tagged"];
		expect(count.description).toBe("[MCP Tools] Count items with a tag.");
		expect(count.inputSchema).toMatchObject({ type: "object", required: ["tag"] });
		expect(count.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

		expect(by["mcp-tools__add_tag"].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
		// destructive defaults to true for a tool that is not read-only and does not say otherwise
		expect(by["mcp-tools__wipe"].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
		expect(by["mcp-tools__stats"].outputSchema).toMatchObject({ required: ["n"] });
		await client.close();
	});

	test("no provider, an empty provider and a plugin that went away list no plugin tools", async () => {
		const empty = fake();
		empty.sources = [];
		for (const provider of [undefined, empty]) {
			const { client } = await connect(provider);
			expect((await client.listTools()).tools.length).toBe(17);
			await client.close();
		}
		const f = fake();
		const { client } = await connect(f);
		expect((await client.listTools()).tools.length).toBe(21);
		f.sources = []; // the plugin was disabled or its switch turned off
		expect((await client.listTools()).tools.length).toBe(17);
		const r = await call(client, "mcp-tools__count_tagged", { tag: "x" });
		expect(r.isError).toBe(true); // and a call to it fails: it is not a tool any more
		await client.close();
	});

	test("a provider that throws leaves the library tools working", async () => {
		const f = fake();
		f.failList = true;
		const { client } = await connect(f);
		expect((await client.listTools()).tools.length).toBe(17);
		const r = await call(client, "list_collections");
		expect(r.isError).toBeFalsy();
		await client.close();
	});
});

describe("tools/call", () => {
	test("calls the plugin with its own tool name and the arguments, and returns its JSON", async () => {
		const f = fake();
		const { client } = await connect(f);
		const r = await call(client, "mcp-tools__count_tagged", { tag: "lung", limit: 3 });
		expect(r.isError).toBeFalsy();
		expect(f.calls).toEqual([{ plugin: "mcp-tools@zinc.example", tool: "count_tagged", args: { tag: "lung", limit: 3 } }]);
		expect(JSON.parse(r.content[0].text)).toEqual({ tool: "count_tagged", args: { tag: "lung", limit: 3 } });
		await client.close();
	});

	test("arguments are validated against the input schema before the plugin runs", async () => {
		const f = fake();
		const { client } = await connect(f);
		const missing = await call(client, "mcp-tools__count_tagged", {});
		expect(missing.isError).toBe(true);
		expect(missing.content[0].text).toContain("Invalid arguments");
		expect(missing.content[0].text).toContain("tag");
		const wrongType = await call(client, "mcp-tools__count_tagged", { tag: 5 });
		expect(wrongType.isError).toBe(true);
		const range = await call(client, "mcp-tools__count_tagged", { tag: "a", limit: 99 });
		expect(range.isError).toBe(true);
		const extra = await call(client, "mcp-tools__count_tagged", { tag: "a", nope: 1 });
		expect(extra.isError).toBe(true);
		expect(f.calls.length).toBe(0);
		await client.close();
	});

	test("a plugin error, a PluginToolError and a timeout are tool errors", async () => {
		const f = fake();
		const { client } = await connect(f);
		f.reply = () => {
			throw new PluginToolError("not-found: no such item");
		};
		const a = await call(client, "mcp-tools__add_tag", { key: "AAAAAAA1" });
		expect(a.isError).toBe(true);
		expect(a.content[0].text).toContain("no such item");
		expect(a.content[0].text).toContain("MCP Tools");
		f.reply = () => {
			throw new Error("plugin trapped");
		};
		const b = await call(client, "mcp-tools__add_tag", { key: "AAAAAAA1" });
		expect(b.isError).toBe(true);
		expect(b.content[0].text).toContain("plugin trapped");
		await client.close();

		const slow = fake();
		slow.reply = () => new Promise(() => {}); // never answers
		const { attachPluginTools } = await import("../../src/mcp/plugin-tools-server");
		const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
		const s = new McpServer({ name: "t", version: "0" });
		s.registerTool("noop", { description: "x", inputSchema: {} }, async () => ({ content: [{ type: "text" as const, text: "" }] }));
		attachPluginTools(s, slow, { callTimeoutMs: 50 });
		const [ct, st] = InMemoryTransport.createLinkedPair();
		await s.connect(st);
		const c2 = new Client({ name: "t", version: "0" });
		await c2.connect(ct);
		const t = await call(c2, "mcp-tools__add_tag", { key: "AAAAAAA1" });
		expect(t.isError).toBe(true);
		expect(t.content[0].text).toContain("timed out");
		await c2.close();
	});

	test("non-JSON output is shown as text; an output schema gives structuredContent and is enforced", async () => {
		const f = fake();
		const { client } = await connect(f);
		f.reply = () => "plain words";
		const plain = await call(client, "mcp-tools__add_tag", { key: "AAAAAAA1" });
		expect(plain.content[0].text).toBe("plain words");

		f.reply = () => JSON.stringify({ n: 3 });
		const ok = await call(client, "mcp-tools__stats");
		expect(ok.isError).toBeFalsy();
		expect(ok.structuredContent).toEqual({ n: 3 });

		f.reply = () => JSON.stringify({ n: "three" });
		const bad = await call(client, "mcp-tools__stats");
		expect(bad.isError).toBe(true);
		expect(bad.content[0].text).toContain("output schema");
		await client.close();
	});

	test("library tools still work, and an unknown tool is the SDK's error", async () => {
		const { client } = await connect(fake());
		const r = await call(client, "list_collections");
		expect(JSON.parse(r.content[0].text).total).toBeGreaterThanOrEqual(2);
		const unknown = await call(client, "nothing__here");
		expect(unknown.isError).toBe(true);
		await client.close();
	});
});

describe("list_changed", () => {
	test("a long-lived connection is told when the provider's tools change; closing unsubscribes", async () => {
		const f = fake();
		let n = 0;
		const { client, server } = await connect(f, { onNotification: () => void n++ });
		f.fire();
		await Bun.sleep(30);
		expect(n).toBe(1);
		await client.close();
		await server.close();
		f.fire(); // no listener left, and no throw
		await Bun.sleep(10);
		expect(n).toBe(1);
	});
});

describe("HTTP endpoint with the global provider", () => {
	const rpc = (body: unknown) =>
		new Request("http://127.0.0.1:23120/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Host: "127.0.0.1:23120", "MCP-Protocol-Version": "2025-06-18" },
			body: JSON.stringify(body),
		});
	const list = async () => ((await (await handleMcp(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }), fx.db))!.json()) as any).result.tools as { name: string }[];

	test("tools appear while a provider is set and go when it is cleared", async () => {
		expect((await list()).length).toBe(17);
		const f = fake();
		setPluginToolProvider(f);
		const names = (await list()).map((t) => t.name);
		expect(names).toContain("mcp-tools__count_tagged");
		const res = await handleMcp(rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mcp-tools__count_tagged", arguments: { tag: "x" } } }), fx.db);
		const body = (await res!.json()) as any;
		expect(JSON.parse(body.result.content[0].text).tool).toBe("count_tagged");
		setPluginToolProvider(undefined);
		expect((await list()).length).toBe(17);
	});
});
