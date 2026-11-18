import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { witError } from "../src/imports/registry";
import { PluginError } from "../src/protocol";
import type { PluginSupervisor, SupervisorEvents } from "../src/supervisor";
import { alive, buildFixtures, newSupervisor, until, zincHandlers } from "./helpers";

let dirs: Awaited<ReturnType<typeof buildFixtures>>;
beforeAll(async () => {
	dirs = await buildFixtures();
}, 180_000);

const open: PluginSupervisor[] = [];
afterAll(async () => {
	await Promise.all(open.map((s) => s.shutdown()));
});
const make = (lines: string[], extra = {}) => {
	const s = newSupervisor(lines, extra);
	open.push(s);
	return s;
};

describe("load and call", () => {
	test("Rust guest: startup runs, host (where: host) and zinc handlers answer, callbacks reach the export", async () => {
		const lines: string[] = [];
		const logs: SupervisorEvents["log"][] = [];
		const sup = make(lines);
		sup.on("log", (l) => logs.push(l));
		const info = await sup.load(dirs["hello-rust"]);
		expect(info.status).toBe("loaded");
		await sup.start(info.id);
		expect(sup.get(info.id)?.status).toBe("running");

		expect(lines).toContain("hello-rust@zinc.test: hello-rust startup hello-rust@zinc.test 0.1.0");
		// prefs.get ran in the host process (where: "host"); log.write ran here (where: "zinc").
		expect(lines).toContain(`hello-rust@zinc.test: pref greeting=hello-from-host-${sup.hostPid}`);
		// timers.set-timeout (zinc handler) later calls events.on-timer back through ctx.callExport.
		expect(lines).toContain("hello-rust@zinc.test: timer=ok(7)");
		await until(() => lines.includes("hello-rust@zinc.test: timer 7 fired"), 3000, "callback");

		// A direct call.
		expect(await sup.call(info.id, "events", "on-timer", [3, "interval"])).toBeUndefined();
		expect(await sup.call(info.id, "zinc:plugin/events@0.1.0", "on-timer", [4, "interval"])).toBeUndefined();
		expect(lines).toContain("hello-rust@zinc.test: timer 3 fired");
		expect(lines).toContain("hello-rust@zinc.test: timer 4 fired");

		// An export the component does not have.
		const err = (await sup.call(info.id, "events", "no-such-fn").catch((e) => e)) as PluginError;
		expect(err).toBeInstanceOf(PluginError);
		expect(err.kind).toBe("no-such-export");

		await sup.stop(info.id);
		expect(lines).toContain("hello-rust@zinc.test: hello-rust shutdown");
		expect(sup.get(info.id)?.status).toBe("stopped");
	}, 30_000);

	test("QuickJS guest (componentize-qjs): same path, jco value shapes (variant, enum)", async () => {
		const lines: string[] = [];
		const sup = make(lines);
		const info = await sup.load(dirs["hello-js"]);
		await sup.start(info.id, { why: "addon-enable" });
		expect(lines).toContain("hello-js@zinc.test: hello-js startup hello-js@zinc.test 0.2.0 why=addon-enable");
		expect(lines).toContain(`hello-js@zinc.test: pref greeting=hello-from-host-${sup.hostPid}`);
		await until(() => lines.includes("hello-js@zinc.test: js timer 7 timeout fired"), 3000, "callback");
		await sup.call(info.id, "events", "on-timer", [9, "interval"]);
		expect(lines).toContain("hello-js@zinc.test: js timer 9 interval fired");
	}, 30_000);

	test("an import nobody handles returns error::unavailable (the plugin sees it as a result error)", async () => {
		const lines: string[] = [];
		const logOnly = zincHandlers(lines).filter((h) => h.interface.endsWith("/log")); // no timers handler
		const sup = make(lines, { importHandlers: logOnly });
		const info = await sup.load(dirs["hello-rust"]);
		await sup.start(info.id);
		expect(lines).toContain(
			"hello-rust@zinc.test: timer=unavailable(unsupported: no handler for zinc:plugin/timers#setTimeout)",
		);
	}, 30_000);

	test("re-entrancy: an export can run while the same instance waits in an import", async () => {
		const lines: string[] = [];
		const sup = make(lines, {
			importHandlers: [
				...zincHandlers(lines).filter((h) => h.interface.endsWith("/log")),
				{
					interface: "zinc:plugin/timers",
					where: "zinc",
					functions: {
						// startup is suspended in this call; the callback runs the plugin's on-timer export meanwhile
						"set-timeout": async (ctx: any) => {
							await ctx.callExport("events", "on-timer", [5, "timeout"]);
							lines.push("reentrant call returned");
							return 7;
						},
					},
				},
			],
		});
		const info = await sup.load(dirs["hello-rust"]);
		await sup.start(info.id);
		const i = (m: string) => lines.indexOf(`hello-rust@zinc.test: ${m}`);
		expect(lines).toContain("reentrant call returned");
		expect(i("timer 5 fired")).toBeGreaterThan(-1);
		expect(i("timer=ok(7)")).toBeGreaterThan(i("timer 5 fired")); // startup continued after its import returned
	}, 30_000);
});

describe("WASI is stubbed", () => {
	test("a plugin cannot read the environment or a file; stderr goes to the log", async () => {
		const lines: string[] = [];
		const logs: string[] = [];
		const sup = make(lines);
		sup.on("log", (l) => logs.push(l.message));
		const info = await sup.load(dirs["hello-rust"]);
		await sup.start(info.id);
		expect(lines).toContain("hello-rust@zinc.test: env_vars=0");
		expect(lines).toContain("hello-rust@zinc.test: fs_read=err");
		await until(() => logs.includes("[stderr] hello-rust stderr line"), 2000, "stderr");
	}, 30_000);
});

describe("a stuck plugin", () => {
	test("is killed with the host; the host restarts; the other plugin keeps working; the stuck one is disabled", async () => {
		const lines: string[] = [];
		const sup = make(lines, { callTimeoutMs: 400 });
		const events: string[] = [];
		sup.on("host-restart", (e) => events.push(`restart:${e.reason}:${e.plugin}`));
		sup.on("host-restarted", (e) => events.push(`restarted:${e.reloaded.join(",")}`));

		const hello = await sup.load(dirs["hello-rust"]);
		const spin = await sup.load(dirs["spin-rust"]);
		await sup.start(hello.id);
		await sup.start(spin.id);
		const pid1 = sup.hostPid;
		expect(alive(pid1)).toBe(true);
		expect(lines.filter((l) => l.includes("hello-rust startup")).length).toBe(1);

		// The plugin loops forever inside on-timer(999).
		const err = (await sup.call(spin.id, "events", "on-timer", [999, "timeout"]).catch((e) => e)) as PluginError;
		expect(err).toBeInstanceOf(PluginError);
		expect(err.kind).toBe("timeout");

		await until(() => events.some((e) => e.startsWith("restarted:")), 8000, "restart to finish");
		expect(events[0]).toBe(`restart:timeout:${spin.id}`);
		expect(events[1]).toBe(`restarted:${hello.id}`);
		expect(sup.restarts).toBe(1);

		// The old host process is dead (a Worker stuck in WebAssembly cannot be terminated, a process can be killed) and a new one runs.
		expect(alive(pid1)).toBe(false);
		expect(sup.hostPid).not.toBe(pid1);
		expect(alive(sup.hostPid)).toBe(true);

		// The stuck plugin is disabled, with a reason.
		const s = sup.get(spin.id)!;
		expect(s.status).toBe("disabled");
		expect(s.reason).toContain("exceeded 400 ms");
		const refused = (await sup.call(spin.id, "events", "on-timer", [1, "timeout"]).catch((e) => e)) as PluginError;
		expect(refused.kind).toBe("disabled");

		// The other plugin was reloaded and started again, and answers.
		expect(sup.get(hello.id)?.status).toBe("running");
		expect(lines.filter((l) => l.includes("hello-rust startup")).length).toBe(2);
		await sup.call(hello.id, "events", "on-timer", [5, "interval"]);
		expect(lines).toContain("hello-rust@zinc.test: timer 5 fired");
	}, 40_000);

	test("time spent waiting for a host import does not count against the budget", async () => {
		const lines: string[] = [];
		const sup = make(lines, {
			callTimeoutMs: 300,
			importHandlers: [
				{
					interface: "zinc:plugin/log",
					where: "zinc",
					functions: {
						write: async (ctx: any, _l: string, m: string) => {
							lines.push(`${ctx.pluginId}: ${m}`);
							await Bun.sleep(700); // slower than the budget
						},
					},
				},
			],
		});
		const info = await sup.load(dirs["hello-rust"]);
		await sup.start(info.id); // startup logs several times: ~3 s in imports, far over 300 ms of budget
		expect(sup.get(info.id)?.status).toBe("running");
		expect(sup.restarts).toBe(0);
	}, 40_000);
});

describe("WIT resources", () => {
	test("a guest-made resource (file-writer) and a host-made one (body-reader) work through jco classes", async () => {
		const lines: string[] = [];
		const events: string[] = [];
		const sup = make(lines, {
			importHandlers: [
				...zincHandlers(lines).filter((h) => h.interface.endsWith("/log")),
				{
					interface: "zinc:plugin/attachments",
					where: "zinc",
					functions: {},
					resources: {
						"file-writer": {
							create: (_ctx: any, req: { filename: string }) => {
								if (!req.filename) throw witError("invalid-argument", "filename");
								return { name: req.filename, chunks: [] as number[] };
							},
							methods: {
								append: (_ctx: any, self: { chunks: number[] }, chunk: Uint8Array) => void self.chunks.push(...chunk),
								finish: (_ctx: any, self: { name: string; chunks: number[] }) => `ABCD2345:${self.name}:${self.chunks.join("")}`,
							},
							drop: (_ctx: any, self: { name: string }) => void events.push(`dropped ${self.name}`),
						},
					},
				},
				{
					interface: "zinc:plugin/net",
					where: "zinc",
					functions: {
						"send-streamed": (ctx: any) => ({
							status: 200,
							statusText: "OK",
							url: "https://example.test/",
							headers: [],
							body: ctx.resource("body-reader", { left: new TextEncoder().encode("0123456789") }),
						}),
					},
					resources: {
						"body-reader": {
							methods: {
								read: (_c: any, self: { left: Uint8Array }, max: number) => {
									if (!self.left.length) return undefined;
									const out = self.left.slice(0, max);
									self.left = self.left.slice(max);
									return out;
								},
								close: () => void events.push("body closed on host"),
							},
						},
					},
				},
			],
		});
		const info = await sup.load(dirs["hello-js"]);
		await sup.start(info.id);
		const has = (m: string) => lines.includes(`hello-js@zinc.test: ${m}`);

		await sup.call(info.id, "events", "on-timer", [100, "timeout"]);
		expect(has("writer key=ABCD2345:a.txt:12345")).toBe(true);

		await sup.call(info.id, "events", "on-timer", [101, "timeout"]);
		expect(has("streamed status=200")).toBe(true);
		expect(lines.filter((l) => l.includes("chunk ")).map((l) => l.split(" ").pop())).toEqual(["4", "4", "2"]);
		expect(has("body closed")).toBe(true);
		expect(events).toContain("body closed on host");

		await sup.call(info.id, "events", "on-timer", [102, "timeout"]);
		expect(has("writer error=invalid-argument")).toBe(true);
	}, 30_000);
});
