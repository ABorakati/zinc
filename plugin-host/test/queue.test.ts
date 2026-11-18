// One call at a time per plugin (supervisor.ts): calls queue, the budget starts when a call leaves the queue, and a host-side
// ctx.callExport joins the same queue.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineHandler, witError } from "../src/imports/registry";
import type { PluginSupervisor } from "../src/supervisor";
import { join } from "node:path";
import { buildFixtures, newSupervisor, prefsHostModule, until, zincHandlers } from "./helpers";

let dirs: Awaited<ReturnType<typeof buildFixtures>>;
beforeAll(async () => {
	dirs = await buildFixtures();
}, 180_000);

const open: PluginSupervisor[] = [];
afterAll(async () => {
	await Promise.all(open.map((s) => s.shutdown()));
});

/** hello-js's `on-timer` 100 / 101 / 102 each make several imports; these stubs are slow, so overlapping calls would interleave. */
function slowHandlers(lines: string[]) {
	return [
		...zincHandlers(lines).filter((h) => h.interface.endsWith("/log")),
		defineHandler({
			interface: "zinc:plugin/attachments",
			where: "zinc",
			functions: {},
			resources: {
				"file-writer": {
					create: (_ctx, req: { filename: string }) => {
						if (!req.filename) throw witError("invalid-argument", "filename");
						return { name: req.filename, chunks: [] as number[] };
					},
					methods: {
						append: async (_ctx, self: { chunks: number[] }, chunk: Uint8Array) => {
							await Bun.sleep(40);
							self.chunks.push(...chunk);
						},
						finish: (_ctx, self: { name: string; chunks: number[] }) => `ABCD2345:${self.name}:${self.chunks.join("")}`,
					},
				},
			},
		}),
		defineHandler({
			interface: "zinc:plugin/net",
			where: "zinc",
			functions: {
				"send-streamed": (ctx) => ({ status: 200, statusText: "OK", url: "https://example.test/", headers: [], body: ctx.resource("body-reader", { left: new TextEncoder().encode("0123456789") }) }),
			},
			resources: {
				"body-reader": {
					methods: {
						read: async (_c, self: { left: Uint8Array }, max: number) => {
							await Bun.sleep(40);
							if (!self.left.length) return undefined;
							const out = self.left.slice(0, max);
							self.left = self.left.slice(max);
							return out;
						},
						close: () => {},
					},
				},
			},
		}),
	];
}

describe("per-plugin call queue", () => {
	test("three calls started together run one after the other", async () => {
		const lines: string[] = [];
		const sup = newSupervisor(lines, { importHandlers: slowHandlers(lines) });
		open.push(sup);
		const info = await sup.load(dirs["hello-js"]);
		await sup.start(info.id);
		const mark = lines.length;
		const calls = [100, 101, 102].map((id) => sup.call(info.id, "events", "on-timer", [id, "timeout"]));
		await Promise.all(calls);
		const mine = lines.slice(mark).map((l) => l.replace("hello-js@zinc.test: ", ""));
		const at = (prefix: string) => mine.findIndex((l) => l.startsWith(prefix));
		// timer 100 ends with "writer key", timer 101 starts with "streamed" and ends with "body closed", timer 102 ends with "writer error"
		expect(at("writer key")).toBeGreaterThanOrEqual(0);
		expect(at("writer key")).toBeLessThan(at("streamed"));
		expect(at("body closed")).toBeLessThan(at("writer error"));
		expect(mine.filter((l) => l.startsWith("chunk ")).length).toBe(3);
	}, 30_000);

	test("the budget starts when a call leaves the queue, not when it is made", async () => {
		const lines: string[] = [];
		// 150 ms budget; each of the three calls takes about 400 ms (waiting in slow imports does not count), so none may time out
		const sup = newSupervisor(lines, { importHandlers: slowHandlers(lines), callTimeoutMs: 150 });
		open.push(sup);
		const info = await sup.load(dirs["hello-js"]);
		await sup.start(info.id);
		const results = await Promise.allSettled([100, 101, 102].map((id) => sup.call(info.id, "events", "on-timer", [id, "timeout"])));
		expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
		expect(sup.restarts).toBe(0);
	}, 30_000);

	test("a call a host-side handler makes with ctx.callExport joins the queue", async () => {
		// timers.set-timeout is answered in the host process, which calls events.on-timer back through the supervisor
		const lines: string[] = [];
		const sup = newSupervisor(lines, {
			importHandlers: zincHandlers(lines).filter((h) => h.interface.endsWith("/log")),
			hostHandlerModules: [prefsHostModule, join(import.meta.dir, "handlers", "timers-callback.host.ts")],
		});
		open.push(sup);
		const info = await sup.load(dirs["hello-rust"]);
		await sup.start(info.id);
		await until(() => lines.includes("hello-rust@zinc.test: timer 7 fired"), 3000, "the callback made by the host handler");
		expect(sup.get(info.id)?.status).toBe("running");
	}, 30_000);
});
