// A style, locale or catalogue download that never answers must fail after the timeout instead of hanging.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StyleStore } from "../../src/cite/engine";
import { HttpError } from "../../src/db";

let server: ReturnType<typeof Bun.serve>;
let hits = 0;
beforeAll(() => {
	// accepts the request and never answers it
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => {
			hits++;
			return new Promise<Response>(() => {});
		},
	});
});
afterAll(() => server.stop(true));

// the store's own URLs are fixed (zotero.org, GitHub): send them to the local server, keeping the options (and so the signal)
const toLocal = (_url: string, init?: RequestInit) => fetch(`http://127.0.0.1:${server.port}/x`, init);

describe("StyleStore downloads", () => {
	test("a server that never answers fails with a gateway timeout after the given time", async () => {
		const store = new StyleStore(mkdtempSync(join(tmpdir(), "zn-style-timeout-")), toLocal, 300);
		const t0 = Date.now();
		const err = await store.styleXml("some-style").catch((e) => e);
		expect(err).toBeInstanceOf(HttpError);
		expect((err as HttpError).status).toBe(504);
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(hits).toBeGreaterThan(0);
		// locales go through the same call
		const loc = await store.locale("de-DE").catch((e) => e);
		expect((loc as HttpError).status).toBe(504);
	}, 20_000);
});
