// A per-request MCP server is closed even when connecting its transport fails.
import { afterEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handleMcp } from "../../src/mcp/http";
import { buildFixture } from "../fixture";

const proto = McpServer.prototype as any;
const realConnect = proto.connect;
const realClose = proto.close;
afterEach(() => {
	proto.connect = realConnect;
	proto.close = realClose;
});

describe("handleMcp", () => {
	test("closes the server when connect throws", async () => {
		const fx = buildFixture();
		let closed = 0;
		proto.connect = async () => {
			throw new Error("transport refused");
		};
		proto.close = async () => {
			closed++;
		};
		const req = new Request("http://127.0.0.1:23120/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		await expect(handleMcp(req, fx.db)).rejects.toThrow("transport refused");
		expect(closed).toBe(1);
		fx.db.close(true);
	});
});
