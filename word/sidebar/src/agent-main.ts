// Entry of the headless agent page (agent.html): no UI. The add-in's MCP server posts {event:"agentCall", data:{id, tool, args}}
// to this page; the page runs the tool (agent.ts) through the same bridge the sidebar uses and answers with the host call
// "agent.result" ({id, ok, json | error}).
import { Agent } from "./agent";
import { createWebViewHost } from "./host";

const host = createWebViewHost();
const agent = new Agent(host);

host.on("agentCall", (d: { id: number; tool: string; args?: Record<string, unknown> }) => {
	agent
		.call(d.tool, d.args ?? {})
		.then(
			(result) => ({ id: d.id, ok: true, json: JSON.stringify(result ?? null) }),
			(e: unknown) => ({ id: d.id, ok: false, error: e instanceof Error ? e.message : String(e) }),
		)
		.then((msg) => host.call("agent.result", msg))
		.catch(() => undefined);
});

void host.call("agent.ready");
