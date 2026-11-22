// bun test src/api.early.test.ts -- early answers (prefetch.ts) are for the first screen only: once the first page is in, answers that
// nobody asked for are dropped, so a later request reaches the core instead of a stale start-up snapshot.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

process.env.ZN_UI_STATE = "off"; // prefetch.ts imports nothing that reads the user's settings, but keep the rule for the store

let api: typeof import("./api");
let prefetch: typeof import("./prefetch");
const hits: string[] = []; // paths the fake core answered
const zdb = process.env.ZN_DB;
const zpf = process.env.ZN_PREFETCH;

beforeAll(async () => {
	api = await import("./api");
	prefetch = await import("./prefetch");
	api.setDirect(async (req) => {
		const u = new URL(req.url);
		hits.push(u.pathname);
		return new Response(JSON.stringify({ v: "fresh" }), { status: 200, headers: { "content-type": "application/json" } });
	});
});
afterAll(() => {
	if (zdb === undefined) delete process.env.ZN_DB;
	else process.env.ZN_DB = zdb;
	if (zpf === undefined) delete process.env.ZN_PREFETCH;
	else process.env.ZN_PREFETCH = zpf;
});

describe("early answers", () => {
	test("an answer is used once, and the ones left over after the first page are dropped", async () => {
		process.env.ZN_DB = "unused-by-this-test"; // saveHint only acts with the in-process core
		delete process.env.ZN_PREFETCH;
		// non-prefetchable paths: nothing is recorded, so saveHint writes no hint file
		api.expectEarly("/early-used", Promise.resolve('{"v":"snapshot"}'));
		api.expectEarly("/early-left-over", Promise.resolve('{"v":"snapshot"}'));
		expect(await api.apiRequest<{ v: string }>("GET", "/early-used")).toEqual({ v: "snapshot" });
		expect(hits).toEqual([]);
		prefetch.saveHint(); // the first page is in
		expect(await api.apiRequest<{ v: string }>("GET", "/early-left-over")).toEqual({ v: "fresh" });
		expect(hits).toEqual(["/api/early-left-over"]);
	});
});
