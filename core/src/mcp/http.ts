// Streamable HTTP endpoint (/mcp) on the core server. Stateless: each request gets its own
// MCP server and transport, JSON responses, no sessions to leak.

import type { Database } from "bun:sqlite";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getPluginToolProvider } from "./plugin-tools";
import { createMcpServer } from "./server";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostnameOf(hostHeader: string): string {
	// Strip the port; IPv6 literals are bracketed.
	if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1);
	return hostHeader.split(":")[0];
}

function reject(status: number, message: string): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

// DNS-rebinding and CSRF guard: the Host must be loopback, and a browser Origin (if sent)
// must be a loopback origin too. Non-browser MCP clients send no Origin.
export function checkRequestOrigin(req: Request): Response | null {
	const host = req.headers.get("host");
	if (host && !LOOPBACK.has(hostnameOf(host).toLowerCase())) return reject(403, "forbidden host");
	const origin = req.headers.get("origin");
	if (origin !== null) {
		let h: string;
		try {
			h = new URL(origin).hostname;
		} catch {
			return reject(403, "forbidden origin");
		}
		if (!LOOPBACK.has(h.toLowerCase()) && !LOOPBACK.has(`[${h}]`)) return reject(403, "forbidden origin");
		// A page on another localhost port is still cross-origin; only same-origin is allowed.
		if (host && new URL(origin).host !== host) return reject(403, "cross-origin requests are not allowed");
	}
	return null;
}

export async function handleMcp(req: Request, db: Database): Promise<Response | null> {
	if (new URL(req.url).pathname !== "/mcp") return null;
	const denied = checkRequestOrigin(req);
	if (denied) return denied;
	if (req.method !== "POST") {
		// Stateless server: no standalone SSE stream and no sessions to terminate.
		return new Response(null, { status: 405, headers: { Allow: "POST" } });
	}
	const server = createMcpServer(db, { pluginTools: getPluginToolProvider() });
	const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	await server.connect(transport);
	try {
		return await transport.handleRequest(req);
	} finally {
		// Response bodies are fully buffered in JSON mode, so it is safe to close now.
		void server.close();
	}
}
