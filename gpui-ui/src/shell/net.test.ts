import { afterEach, describe, expect, test } from "bun:test";
import { setBaseUrl, setDirect } from "../api";
import { call } from "./net";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	setBaseUrl("http://127.0.0.1:23160");
});

describe("shell call()", () => {
	test("an /api path goes to the direct handler, not over the network", async () => {
		const fetched: string[] = [];
		globalThis.fetch = (async (u: string | URL | Request) => {
			fetched.push(String(u));
			return new Response("{}");
		}) as typeof fetch;
		const seen: string[] = [];
		setDirect(async (req) => {
			seen.push(`${req.method} ${new URL(req.url).pathname} ${req.method === "POST" ? await req.text() : ""}`.trim());
			return Response.json({ ok: true });
		});
		expect(await call<{ ok: boolean }>("GET", "/api/sync/status")).toEqual({ ok: true });
		expect(await call<{ ok: boolean }>("POST", "/api/websync/key", { apiKey: "x" })).toEqual({ ok: true });
		expect(seen).toEqual(["GET /api/sync/status", 'POST /api/websync/key {"apiKey":"x"}']);
		expect(fetched).toEqual([]);
	});

	test("an error answer keeps its status, so callers can tell a refusal from a failure", async () => {
		setDirect(() => Response.json({ error: "busy" }, { status: 409 }));
		const err = await call("POST", "/api/sync/now").catch((e: unknown) => e as Error & { status?: number });
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe("busy");
		expect((err as { status?: number }).status).toBe(409);
	});

	test("without a direct handler an /api path goes to BASE_URL", async () => {
		setBaseUrl("http://127.0.0.1:9");
		const fetched: string[] = [];
		globalThis.fetch = (async (u: string | URL | Request) => {
			fetched.push(String(u));
			return Response.json({ n: 1 });
		}) as typeof fetch;
		expect(await call<{ n: number }>("GET", "/api/settings")).toEqual({ n: 1 });
		expect(fetched).toEqual(["http://127.0.0.1:9/api/settings"]);
	});
});
