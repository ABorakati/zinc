// Test server: serves reader-host/dist at /reader-host/ and mocks the attachment routes
// of core/src/api-types.ts against a real sample PDF. Run: bun reader-host/mock-api.ts
import { join, normalize, resolve } from "node:path";

const HERE = import.meta.dir;
const DIST = join(HERE, "dist");
const SAMPLE_PDF = resolve(HERE, "../vendor/reader/demo/pdf/demo.pdf");
const PORT = Number(process.env.MOCK_PORT ?? 23122);

export const state = {
	annotations: new Map<string, any>(),
	viewState: null as any,
	log: [] as { method: string; path: string; body?: unknown; at: number }[],
};

const json = (data: unknown, status = 200) => Response.json(data, { status });

export function startMock(port = PORT) {
	return Bun.serve({
		hostname: "127.0.0.1",
		port,
		async fetch(req) {
			const url = new URL(req.url);
			const p = url.pathname;
			const m = req.method;

			if (p === "/__log") return json(state.log);
			if (p === "/__state") return json({ annotations: [...state.annotations.values()], viewState: state.viewState });

			if (p.startsWith("/reader-host/")) {
				let rel = decodeURIComponent(p.slice("/reader-host/".length)) || "index.html";
				const file = normalize(join(DIST, rel));
				if (!file.startsWith(DIST)) return new Response("forbidden", { status: 403 });
				const f = Bun.file(file);
				if (!(await f.exists())) return new Response("not found", { status: 404 });
				return new Response(f, { headers: { "Cache-Control": "no-cache" } });
			}

			const att = p.match(/^\/api\/attachments\/([^/]+)\/(file|annotations|view-state)$/);
			if (att) {
				const [, , what] = att;
				if (what === "file" && m === "GET") {
					return new Response(Bun.file(SAMPLE_PDF), { headers: { "Content-Type": "application/pdf" } });
				}
				if (what === "annotations") {
					if (m === "GET") return json([...state.annotations.values()]);
					const body = await req.json();
					if (m === "PUT") {
						for (const a of body) state.annotations.set(a.id, a);
						state.log.push({ method: m, path: p, body: body.map((a: any) => ({ id: a.id, type: a.type })), at: Date.now() });
						console.log(
							"PUT annotations",
							body.map((a: any) => `${a.type}:${a.id}`),
						);
						return json({ ok: true });
					}
					if (m === "DELETE") {
						for (const id of body.ids) state.annotations.delete(id);
						state.log.push({ method: m, path: p, body, at: Date.now() });
						console.log("DELETE annotations", body.ids);
						return json({ ok: true });
					}
				}
				if (what === "view-state") {
					if (m === "GET") return json(state.viewState);
					if (m === "PUT") {
						state.viewState = await req.json();
						state.log.push({ method: m, path: p, body: state.viewState, at: Date.now() });
						console.log("PUT view-state", JSON.stringify(state.viewState).slice(0, 120));
						return json({ ok: true });
					}
				}
			}

			const item = p.match(/^\/api\/items\/([^/]+)$/);
			if (item && m === "GET") {
				const key = item[1];
				const base = { children: [], collections: [], tags: [] };
				if (key === "PARENT") return json({ ...base, data: { key, itemType: "journalArticle", title: "Mock Parent Item Title" } });
				return json({
					...base,
					data: { key, itemType: "attachment", title: "demo.pdf", parentItem: "PARENT", contentType: "application/pdf" },
				});
			}

			return json({ error: "not found: " + m + " " + p }, 404);
		},
	});
}

if (import.meta.main) {
	const s = startMock();
	console.log(`mock listening on http://127.0.0.1:${s.port}/reader-host/index.html?attachment=TEST`);
}
