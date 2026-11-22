// Read-only smoke test of the stdio MCP server against a real library.
// Usage: bun core/scripts/mcp-smoke.ts <path/to/library.sqlite> [query]   (the path is required)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const db = process.argv[2];
if (!db) {
	console.error("usage: bun core/scripts/mcp-smoke.ts <path/to/library.sqlite> [query]");
	process.exit(2);
}
const query = process.argv[3] ?? "liver transplant frailty";

const client = new Client({ name: "mcp-smoke", version: "0.0.0" });
let t = performance.now();
await client.connect(
	new StdioClientTransport({
		command: process.execPath,
		args: [`${import.meta.dir}/mcp-stdio.ts`, "--db", db],
	}),
);
console.log(`connected in ${Math.round(performance.now() - t)} ms`);

const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((x) => x.name).join(", ")}`);

async function call(name: string, args: Record<string, unknown>) {
	t = performance.now();
	const res = await client.callTool({ name, arguments: args });
	const text = (res.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
	console.log(`\n## ${name} ${JSON.stringify(args)} (${Math.round(performance.now() - t)} ms)\n${text.slice(0, 700)}`);
	return text;
}

await call("search_library", { query, limit: 3 });
await call("list_collections", {});
await client.close();
