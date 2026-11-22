// A page that refreshes to itself (or to a page that refreshes back) must not make the translator runtime loop for ever.
// Local throw-away server only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { beginRun, endRun, installHttp } from "../../src/translate/runtime/http";

let server: Bun.Server<unknown>;
let base: string;
let served = 0;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			served++;
			const u = new URL(req.url);
			const html = (b: string) => new Response(b, { headers: { "content-type": "text/html; charset=utf-8" } });
			const page = (to: string) => html(`<html><head><meta http-equiv="refresh" content="0; url=${to}"></head><body>x</body></html>`);
			if (u.pathname === "/self") return page("/self");
			if (u.pathname === "/a") return page("/b");
			if (u.pathname === "/b") return page("/a");
			if (u.pathname === "/chain") {
				const n = Number(u.searchParams.get("n") ?? 0);
				return n >= 2 ? html("<html><body id=end>done</body></html>") : page(`/chain?n=${n + 1}`);
			}
			return new Response("nf", { status: 404 });
		},
	});
	base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

function runtime() {
	const refreshes: string[] = [];
	const Z: any = {
		debug(m: string) {
			if (m.startsWith("Meta refresh to")) {
				refreshes.push(m);
				// stops the unfixed code from looping without end
				if (refreshes.length > 100) throw new Error("meta refresh did not stop");
			}
		},
	};
	installHttp(Z);
	return { Z, refreshes };
}

describe("meta refresh", () => {
	test("a page that refreshes to itself ends after a few hops and returns the page", async () => {
		const { Z, refreshes } = runtime();
		beginRun({});
		try {
			const r = await Z.HTTP.request("GET", `${base}/self`, { responseType: "document" });
			expect(r.status).toBe(200);
			expect(refreshes.length).toBeLessThanOrEqual(5);
		} finally {
			endRun();
		}
	});

	test("two pages that refresh to each other end too", async () => {
		const { Z, refreshes } = runtime();
		beginRun({});
		try {
			const r = await Z.HTTP.request("GET", `${base}/a`, { responseType: "document" });
			expect(r.status).toBe(200);
			expect(refreshes.length).toBeLessThanOrEqual(5);
		} finally {
			endRun();
		}
	});

	test("a short chain of refreshes is still followed to its end", async () => {
		const { Z } = runtime();
		beginRun({});
		try {
			const r = await Z.HTTP.request("GET", `${base}/chain`, { responseType: "document" });
			expect(r.response.getElementById("end")?.textContent).toBe("done");
		} finally {
			endRun();
		}
	});
});
