// Downloading into a file that cannot be written must fail with an error, not hang or leave an unhandled rejection.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpClient } from "../../src/fulltext/http";
import type { HttpReq } from "../../src/fulltext/proto";
import { tempDir } from "../fixture";

const req: HttpReq = { method: "get", url: "https://a.example.test/x.pdf", headers: {}, ua: "default", timeout_ms: 1500, follow_redirects: true, max_bytes: 0 };

/** A body that delivers a lot of data in many chunks, so the writer's buffer fills and a drain is awaited. */
function bigBody(): Response {
	let sent = 0;
	const chunk = new Uint8Array(256 * 1024).fill(7);
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(c) {
				if (sent++ >= 200) return c.close();
				c.enqueue(chunk);
			},
		}),
	);
}

describe("download to file", () => {
	test("a write error rejects promptly", async () => {
		const dir = tempDir();
		const target = join(dir, "is-a-directory");
		mkdirSync(target);
		const client = new HttpClient({ fetch: async () => bigBody() });
		const r = await Promise.race([
			client.request(req, { signal: new AbortController().signal, sink: "file", path: target }).then(
				() => "resolved",
				(e) => ({ rejected: e }),
			),
			new Promise<string>((res) => setTimeout(() => res("hung"), 6000)),
		]);
		expect(r).not.toBe("hung");
		expect(r).not.toBe("resolved");
	}, 20000);

	test("a normal download still works", async () => {
		const dir = tempDir();
		const target = join(dir, "ok.bin");
		const client = new HttpClient({ fetch: async () => new Response(new Uint8Array(70000).fill(1)) });
		const raw = await client.request(req, { signal: new AbortController().signal, sink: "file", path: target });
		expect(raw.bytes).toBe(70000);
		expect(readFileSync(target).length).toBe(70000);
	});
});
