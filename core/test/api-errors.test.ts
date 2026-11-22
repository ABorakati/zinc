// Unexpected errors answer the same JSON everywhere under /api/ with an opaque message: the exception text stays in the log.
import { describe, expect, test } from "bun:test";
import { buildFixture, call } from "./fixture";

describe("unexpected errors", () => {
	test("a failure inside a core route is a JSON 500 that does not repeat the exception text", async () => {
		const fx = buildFixture();
		fx.db.close();
		const r = await call(fx.db, "GET", "/api/collections");
		expect(r.status).toBe(500);
		expect(r.headers.get("content-type")).toContain("application/json");
		const body = await r.text();
		expect(JSON.parse(body)).toEqual({ error: "internal error" });
		expect(body.toLowerCase()).not.toContain("closed");
	});

	test("the same holds for a feature route", async () => {
		const fx = buildFixture();
		fx.db.close();
		// the first lets the exception escape its handler; the others catch it themselves
		for (const path of ["/api/ui/selection", "/api/references/AAAAAAA1", "/api/files/settings", "/api/websync/status"]) {
			const r = await call(fx.db, "GET", path);
			expect(r.status).toBe(500);
			const body = await r.text();
			expect(body.toLowerCase()).not.toContain("closed");
			expect(JSON.parse(body)).toEqual({ error: "internal error" });
		}
	});

	test("an expected error keeps its own status and message", async () => {
		const fx = buildFixture();
		const r = await call(fx.db, "GET", "/api/items/NOSUCHKEY");
		expect(r.status).toBe(404);
		expect(typeof ((await r.json()) as any).error).toBe("string");
	});
});
