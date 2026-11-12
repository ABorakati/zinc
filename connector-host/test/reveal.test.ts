// "Open in Zinc" (src/reveal.ts): the host asks a running app to show an item, or starts the app first. A fake app API stands in
// for the app; nothing here touches a real app or library.
import { afterEach, describe, expect, test } from "bun:test";
import { handleRequest } from "../src/dispatch";
import { launcherCandidates, revealInApp } from "../src/reveal";

type Server = ReturnType<typeof Bun.serve>;
let servers: Server[] = [];
afterEach(() => {
	for (const s of servers) s.stop(true);
	servers = [];
});

/** A stand-in for the app's /api/ui routes: records reveal requests; `missing` keys answer 404 like core/src/connector/ui.ts. */
function fakeApp(port = 0, missing = new Set<string>()) {
	const reveals: string[] = [];
	const s = Bun.serve({
		port,
		hostname: "127.0.0.1",
		async fetch(req) {
			const { pathname } = new URL(req.url);
			if (pathname === "/api/ui/selection") return Response.json({ selection: { kind: "library" }, rev: 1, ext: 1, reveal: null });
			if (pathname === "/api/ui/reveal" && req.method === "POST") {
				const { key } = (await req.json()) as { key: string };
				if (missing.has(key)) return Response.json({ error: "item not found" }, { status: 404 });
				reveals.push(key);
				return Response.json({ ok: true, rev: 2, seq: reveals.length });
			}
			return new Response("not found", { status: 404 });
		},
	});
	servers.push(s);
	return { port: s.port!, reveals };
}

/** A port nothing listens on (bound once, then released). */
function freePort(): number {
	const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	const p = s.port!;
	s.stop(true);
	return p;
}

describe("revealInApp", () => {
	test("a running app gets the reveal request", async () => {
		const app = fakeApp();
		const r = await revealInApp(app.port, "ABCD2345");
		expect(r).toEqual({ status: 200, body: { ok: true, started: false, seq: 1 } });
		expect(app.reveals).toEqual(["ABCD2345"]);
	});

	test("open: true is passed to the app, and its choice of attachment comes back", async () => {
		const bodies: unknown[] = [];
		const s = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				const { pathname } = new URL(req.url);
				if (pathname === "/api/ui/selection") return Response.json({ rev: 1, reveal: null });
				bodies.push(await req.json());
				return Response.json({ ok: true, seq: 1, opened: "PDFKEY01" });
			},
		});
		servers.push(s);
		const r = await revealInApp(s.port!, "ABCD2345", { open: true });
		expect(r).toEqual({ status: 200, body: { ok: true, started: false, seq: 1, opened: "PDFKEY01" } });
		expect(bodies).toEqual([{ key: "ABCD2345", open: true }]);
	});

	test("the app's 404 for an unknown item comes back as is", async () => {
		const app = fakeApp(0, new Set(["NOPE0000"]));
		const r = await revealInApp(app.port, "NOPE0000");
		expect(r.status).toBe(404);
		expect(r.body).toMatchObject({ ok: false, error: "item not found" });
	});

	test("a bad key is refused before anything is called", async () => {
		expect((await revealInApp(1, "../etc")).status).toBe(400);
		expect((await revealInApp(1, undefined)).status).toBe(400);
	});

	test("app not running and not installed: 503, nothing started", async () => {
		const launched: string[] = [];
		const r = await revealInApp(freePort(), "ABCD2345", { candidates: ["C:/nowhere/zotero-next-gpui.exe"], exists: () => false, launch: (e) => launched.push(e) });
		expect(r.status).toBe(503);
		expect(launched).toEqual([]);
	});

	test("app not running: it is started, then asked once its API answers", async () => {
		const port = freePort();
		let app: ReturnType<typeof fakeApp> | undefined;
		const r = await revealInApp(port, "ABCD2345", {
			candidates: ["C:/Zinc/zotero-next-gpui.exe"],
			exists: () => true,
			// the "app" comes up a moment after it is launched
			launch: () => void setTimeout(() => (app = fakeApp(port)), 300),
			waitMs: 5000,
		});
		expect(r).toEqual({ status: 200, body: { ok: true, started: true, seq: 1 } });
		expect(app?.reveals).toEqual(["ABCD2345"]);
	});

	test("a started app whose API never answers: 504", async () => {
		const r = await revealInApp(freePort(), "ABCD2345", { candidates: ["x.exe"], exists: () => true, launch: () => {}, waitMs: 600 });
		expect(r.status).toBe(504);
		expect(r.body.started).toBe(true);
	});

	test("launcher candidates: ZN_LAUNCHER, then the installer's folders", () => {
		expect(launcherCandidates({ ZN_LAUNCHER: "C:/z.exe", LOCALAPPDATA: "C:/L" }).map((p) => p.replaceAll("\\", "/"))).toEqual([
			"C:/z.exe",
			"C:/L/Programs/Zinc/zotero-next-gpui.exe",
			"C:/L/Programs/Zotero Next/zotero-next-gpui.exe",
		]);
	});
});

describe("host method revealInApp", () => {
	const env = (appPort: number) => ({ appPort, dbPath: null, getDb: () => { throw new Error("no library needed"); } });

	test("goes through handleRequest without opening the library", async () => {
		const app = fakeApp();
		const res = await handleRequest(env(app.port), { t: "req", id: 1, method: "revealInApp", body: { kind: "text", text: JSON.stringify({ key: "ABCD2345" }) } }, new Map());
		expect(res.status).toBe(200);
		expect(JSON.parse(new TextDecoder().decode(res.body))).toMatchObject({ ok: true, started: false });
		expect(app.reveals).toEqual(["ABCD2345"]);
	});

	test("no body: 400", async () => {
		const res = await handleRequest(env(1), { t: "req", id: 2, method: "revealInApp" }, new Map());
		expect(res.status).toBe(400);
	});
});
