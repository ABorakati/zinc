// MCP over stdio, opening the library SQLite file directly (works with the app closed;
// WAL + busy_timeout let it coexist with a running app).
// Usage: bun core/scripts/mcp-stdio.ts --db <path-to-library.sqlite>
// stdout carries the protocol, so all logging goes to stderr.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import { openDb } from "../src/db";
import { createMcpServer } from "../src/mcp/server";

const args = process.argv.slice(2);
let dbPath = "";
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--db") dbPath = args[++i] ?? "";
	else {
		console.error(`unknown argument: ${args[i]}`);
		process.exit(2);
	}
}
if (!dbPath) {
	console.error("usage: bun core/scripts/mcp-stdio.ts --db <path>");
	process.exit(2);
}
if (!existsSync(dbPath)) {
	console.error(`database not found: ${dbPath}`);
	process.exit(2);
}

const db = openDb(dbPath);
db.run("PRAGMA journal_mode = WAL");
const server = createMcpServer(db);
await server.connect(new StdioServerTransport());
console.error(`zotero-next MCP (stdio) ready, db=${dbPath}`);

const shutdown = () => {
	try {
		db.close(true);
	} catch {}
	process.exit(0);
};
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
