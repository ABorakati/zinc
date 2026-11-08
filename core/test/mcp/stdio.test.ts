import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { buildFixture } from "../fixture";

test("stdio server opens the db directly and answers tool calls", async () => {
	const fx = buildFixture();
	const dbPath = join(fx.dir, "lib.sqlite");
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [join(import.meta.dir, "../../scripts/mcp-stdio.ts"), "--db", dbPath],
		stderr: "ignore",
	});
	const client = new Client({ name: "test", version: "0" });
	await client.connect(transport);
	try {
		const { tools } = await client.listTools();
		expect(tools.length).toBe(17);
		const r = (await client.callTool({ name: "search_library", arguments: { query: "zebra" } })) as {
			content: { text: string }[];
		};
		expect(JSON.parse(r.content[0].text).total).toBe(1);
	} finally {
		await client.close();
		fx.db.close(true);
	}
});
