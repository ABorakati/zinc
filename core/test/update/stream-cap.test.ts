// The installer download stops once the server has sent more than the signed manifest's size, instead of filling the disk.
// A local throw-away feed on a free port and a temp folder.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRealEnv } from "../../src/update/env";
import { tempDir } from "../fixture";

const MB = 1024 * 1024;
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(req) {
		const path = new URL(req.url).pathname;
		if (path === "/exact") return new Response(new Uint8Array(MB).fill(1));
		const chunk = new Uint8Array(64 * 1024).fill(2);
		let sent = 0;
		// no Content-Length: a chunked body of 8 MB, which the client must stop reading
		return new Response(
			new ReadableStream<Uint8Array>({
				pull(c) {
					if (sent++ >= 128) return c.close();
					c.enqueue(chunk);
				},
			}),
		);
	},
});
afterAll(() => server.stop(true));
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;

describe("download size cap", () => {
	test("a body larger than the manifest says is refused and not kept beyond the cap", async () => {
		const dir = tempDir();
		const env = createRealEnv({ updatesDir: dir });
		const dest = join(dir, "big.part");
		await expect(env.download(url("/big"), dest, { offset: 0, maxBytes: MB, onProgress: () => {} })).rejects.toMatchObject({
			code: "too-large",
		});
		expect(existsSync(dest) ? statSync(dest).size : 0).toBeLessThanOrEqual(MB);
	});

	test("a body of exactly the manifest size is fine", async () => {
		const dir = tempDir();
		const env = createRealEnv({ updatesDir: dir });
		const dest = join(dir, "ok.part");
		await env.download(url("/exact"), dest, { offset: 0, maxBytes: MB, onProgress: () => {} });
		expect(statSync(dest).size).toBe(MB);
	});
});
