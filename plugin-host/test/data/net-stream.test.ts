// net.download and net.send-streamed: the inactivity timeout counts time without data, not time since the response began.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandlerTable } from "../../src/imports/registry";
import net from "../../src/imports/net.host";
import { configureFs } from "../../src/imports/data/fs-roots";
import { call, failure, fakeCtx, manifestOf, wait } from "./core-fixture";

let server: ReturnType<typeof Bun.serve>;
let base: string;
let root: string;
beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "zn-net-stream-test-"));
	configureFs({ dataRoot: join(root, "data"), tempRoot: join(root, "temp"), bundledDirFor: () => undefined });
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 30,
		fetch(req) {
			const u = new URL(req.url);
			// `chunks` pieces of `size` bytes, one every `every` ms; `stall` = after the first piece, send nothing more
			const chunks = Number(u.searchParams.get("chunks") ?? 10);
			const every = Number(u.searchParams.get("every") ?? 300);
			const size = Number(u.searchParams.get("size") ?? 1024);
			const stall = u.searchParams.get("stall") === "1";
			return new Response(
				new ReadableStream({
					async start(c) {
						for (let i = 0; i < chunks; i++) {
							c.enqueue(new Uint8Array(size).fill(65));
							if (stall && i === 0) await wait(60_000);
							await wait(every);
						}
						c.close();
					},
				}),
			);
		},
	});
	base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
	server.stop(true);
	rmSync(root, { recursive: true, force: true });
});

const request = (url: string, over: Record<string, unknown> = {}) => ({
	method: "GET",
	url,
	headers: [],
	body: undefined,
	timeoutMs: undefined,
	successCodes: undefined,
	redirect: "follow",
	credentials: undefined,
	cookies: { tag: "none" },
	retry: undefined,
	bypassCache: false,
	maxResponseBytes: undefined,
	cancelKey: undefined,
	...over,
});
const netCtx = () => fakeCtx(undefined, manifestOf({ netHosts: [base] }));
const data = (path: string) => ({ root: { tag: "data" }, path });
const opts = (over: Record<string, unknown> = {}) => ({ reportProgress: false, onConflict: "fail", createParents: true, inactivityTimeoutMs: 1000, ...over });

describe("a stream that keeps sending is not an inactive one", () => {
	test("download: ten pieces over 3 s with a 1 s inactivity timeout completes", async () => {
		const c = netCtx();
		const done = await call(net, c, "download", request(`${base}/s?chunks=10&every=300`), data("dl/slow.bin"), opts());
		expect(done).toMatchObject({ status: 200, bytes: 10240n });
	}, 30_000);

	test("send-streamed: every piece of a 3 s body is read with a 1 s timeout", async () => {
		const c = netCtx();
		const refs: unknown[] = [];
		const ctx = { ...c, resource: (name: string, state: unknown) => (refs.push(state), { "$zinc-resource": name, id: -refs.length }) } as typeof c;
		await new HandlerTable([net]).call(ctx, net.interface, "send-streamed", [request(`${base}/s?chunks=10&every=300`, { timeoutMs: 1000 })]);
		const t = new HandlerTable([net]);
		const handle = t.createResource(c.pluginId, "body-reader", refs[0]);
		let bytes = 0;
		for (;;) {
			const chunk = await t.call(c, net.interface, "[method]body-reader.read", [handle.id, 65536]);
			if (chunk === undefined) break;
			bytes += chunk.length;
		}
		expect(bytes).toBe(10240);
	}, 30_000);
});

describe("a stream that stops sending is aborted and cleaned up", () => {
	test("download: a stalled body ends in `timeout` and leaves no .part file", async () => {
		const c = netCtx();
		const e = await failure(call(net, c, "download", request(`${base}/s?chunks=3&stall=1`), data("dl/stalled.bin"), opts({ inactivityTimeoutMs: 400 })));
		expect(e).toMatchObject({ tag: "timeout" });
		const dir = join(root, "data", c.pluginId, "dl");
		expect(existsSync(join(dir, "stalled.bin"))).toBe(false);
		expect(readdirSync(dir).filter((n) => n.endsWith(".part"))).toEqual([]);
		// the file really is closed: on Windows a folder cannot be removed while a file in it is still open
		rmSync(dir, { recursive: true });
		expect(existsSync(dir)).toBe(false);
	}, 30_000);
});
