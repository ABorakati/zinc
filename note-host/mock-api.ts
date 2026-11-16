// Test server: serves note-host/dist at /note-host/ and mocks note routes of core/src/api-types.ts.
// Run: bun note-host/mock-api.ts   (default port 23128)
import { join, normalize } from "node:path";

const DIST = join(import.meta.dir, "dist");
const PORT = Number(process.env.MOCK_PORT ?? 23128);

export const state = {
	note: '<div data-schema-version="9"><h1>Mock note</h1><p>Hello <b>world</b> from the mock API.</p><ul><li>one</li><li>two</li></ul></div>',
	log: [] as { method: string; path: string; body?: unknown; at: number }[],
};
const json = (data: unknown, status = 200) => Response.json(data, { status });
const detail = (key: string) => ({
	data: { key, itemType: "note", note: state.note, title: "Mock note", version: 1 },
	children: [],
	collections: [],
	tags: [],
});

export function startMock(port = PORT) {
	return Bun.serve({
		hostname: "127.0.0.1",
		port,
		async fetch(req) {
			const p = new URL(req.url).pathname;
			const m = req.method;
			if (p === "/__log") return json(state.log);
			if (p === "/__state") return json({ note: state.note });

			if (p.startsWith("/note-host/")) {
				const rel = decodeURIComponent(p.slice("/note-host/".length)) || "index.html";
				const file = normalize(join(DIST, rel));
				if (!file.startsWith(DIST)) return new Response("forbidden", { status: 403 });
				const f = Bun.file(file);
				if (!(await f.exists())) return new Response("not found", { status: 404 });
				return new Response(f, { headers: { "Cache-Control": "no-cache" } });
			}

			const item = p.match(/^\/api\/items\/([^/]+)$/);
			if (item && item[1] === "TESTNOTE") {
				if (m === "GET") {
					state.log.push({ method: m, path: p, at: Date.now() });
					console.log("GET", p);
					return json(detail(item[1]));
				}
				if (m === "PATCH") {
					const body = (await req.json()) as { data?: { note?: string } };
					if (typeof body.data?.note === "string") state.note = body.data.note;
					state.log.push({ method: m, path: p, body, at: Date.now() });
					console.log("PATCH", p, JSON.stringify(body).slice(0, 200));
					return json(detail(item[1]));
				}
			}
			if (p === "/api/open-url" && m === "POST") {
				const body = await req.json();
				state.log.push({ method: m, path: p, body, at: Date.now() });
				console.log("open-url", body);
				return json({ ok: true });
			}
			return json({ error: "not found: " + m + " " + p }, 404);
		},
	});
}

if (import.meta.main) {
	const s = startMock();
	console.log(`note-host mock on http://127.0.0.1:${s.port}/note-host/index.html?note=TESTNOTE`);
}
