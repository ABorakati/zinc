// An error that escapes a feature handler answers JSON with an opaque message. The errors the routes catch themselves keep saying
// what went wrong: the app shows that text to the user.
import { describe, expect, test } from "bun:test";
import { buildFixture, call } from "./fixture";

describe("unexpected errors", () => {
	test("one that escapes a feature handler is a JSON 500 that does not repeat the exception text", async () => {
		const fx = buildFixture();
		fx.db.close();
		const r = await call(fx.db, "GET", "/api/ui/selection");
		expect(r.status).toBe(500);
		expect(r.headers.get("content-type")).toContain("application/json");
		const body = await r.text();
		expect(JSON.parse(body)).toEqual({ error: "internal error" });
		expect(body.toLowerCase()).not.toContain("closed");
	});

	test("one that a route catches itself still says what went wrong", async () => {
		const fx = buildFixture();
		fx.db.close();
		for (const path of ["/api/collections", "/api/references/AAAAAAA1", "/api/files/settings"]) {
			const r = await call(fx.db, "GET", path);
			expect(r.status).toBe(500);
			expect(((await r.json()) as any).error).toMatch(/closed/i);
		}
	});

	test("an expected error keeps its own status and message", async () => {
		const fx = buildFixture();
		const r = await call(fx.db, "GET", "/api/items/NOSUCHKEY");
		expect(r.status).toBe(404);
		expect(typeof ((await r.json()) as any).error).toBe("string");
	});
});
