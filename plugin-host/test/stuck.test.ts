// A call that never ends (the plugin waits in a host import for ever) must not hold up stop, unload, disable or shutdown, and the
// requests that are not calls have wall-clock limits. Real supervisor; the plugin is the hello-js fixture on the real `zhw`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { defineHandler } from "../src/imports/registry";
import { PluginError } from "../src/protocol";
import { createPluginSupervisor, type PluginSupervisor } from "../src/supervisor";
import { buildFixtures, newSupervisor, until, zincHandlers } from "./helpers";

let dirs: Awaited<ReturnType<typeof buildFixtures>>;
beforeAll(async () => {
	dirs = await buildFixtures();
}, 180_000);

const open: PluginSupervisor[] = [];
afterAll(async () => {
	await Promise.all(open.map((s) => s.shutdown()));
});

const ID = "hello-js@zinc.test";
const never = () => new Promise<never>(() => {});
/** Resolves to "hung" if the promise has not settled after `ms`. */
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => "settled" as const, () => "settled" as const), Bun.sleep(ms).then(() => "hung" as const)]);
const asError = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as PluginError);

/** hello-js's `startup` calls timers.set-timeout and its `shutdown` writes a log line: either can be made to wait for ever. */
function hangingSupervisor(hang: { startup: boolean; shutdown: boolean }, extra = {}) {
	const lines: string[] = [];
	const sup = newSupervisor(lines, {
		importHandlers: [
			defineHandler({
				interface: "zinc:plugin/log",
				where: "zinc",
				functions: { write: async (_ctx, _level: string, message: string) => (hang.shutdown && message.includes("shutdown") ? never() : void lines.push(message)) },
			}),
			defineHandler({ interface: "zinc:plugin/timers", where: "zinc", functions: { "set-timeout": () => (hang.startup ? never() : 7) } }),
		],
		stuckCallMs: 400,
		...extra,
	});
	open.push(sup);
	return { sup, lines };
}

describe("a call that waits for ever", () => {
	test("stop gives up on it after the grace time: the call fails, the plugin is disabled, and the queue is free again", async () => {
		const hang = { startup: true, shutdown: false };
		const { sup } = hangingSupervisor(hang);
		await sup.load(dirs["hello-js"]);
		const started = asError(sup.start(ID));
		await until(() => sup.get(ID)?.status === "starting", 3000, "startup to be in flight");
		const t0 = Date.now();
		const stopped = within(sup.stop(ID), 8000);
		expect(await stopped).toBe("settled");
		expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
		const err = await started;
		expect(err).toBeInstanceOf(PluginError);
		expect(err!.kind).toBe("timeout");
		expect(sup.get(ID)?.status).toBe("disabled");
		expect(await within(sup.unload(ID), 3000)).toBe("settled");
		// the same plugin loads and starts again: nothing in its queue is stuck
		hang.startup = false;
		await sup.load(dirs["hello-js"]);
		expect(await within(sup.start(ID), 5000)).toBe("settled");
		expect(sup.get(ID)?.status).toBe("running");
	}, 60_000);

	test("unload fails the call that is in flight and frees the plugin's queue", async () => {
		const { sup } = hangingSupervisor({ startup: true, shutdown: false });
		await sup.load(dirs["hello-js"]);
		const started = asError(sup.start(ID));
		await until(() => sup.get(ID)?.status === "starting", 3000, "startup to be in flight");
		expect(await within(sup.unload(ID), 3000)).toBe("settled");
		expect((await started)?.kind).toBe("not-loaded");
		expect(sup.get(ID)).toBeUndefined();
	}, 60_000);

	test("stop does not wait for ever for a shutdown hook that waits for ever", async () => {
		const hang = { startup: false, shutdown: true };
		const { sup } = hangingSupervisor(hang);
		await sup.load(dirs["hello-js"]);
		await sup.start(ID);
		expect(sup.get(ID)?.status).toBe("running");
		const stop = asError(sup.stop(ID));
		expect(await within(stop, 8000)).toBe("settled");
		expect((await stop)?.kind).toBe("timeout");
		expect(sup.get(ID)?.status).toBe("disabled");
	}, 60_000);

	test("the supervisor's own shutdown ends although a plugin's shutdown hook waits for ever", async () => {
		const hang = { startup: false, shutdown: true };
		const { sup } = hangingSupervisor(hang, { controlTimeoutMs: 500 });
		await sup.load(dirs["hello-js"]);
		await sup.start(ID);
		const t0 = Date.now();
		expect(await within(sup.shutdown(), 8000)).toBe("settled");
		expect(Date.now() - t0).toBeLessThan(6000);
	}, 60_000);
});

describe("requests that are not calls have a wall-clock limit", () => {
	const fake = join(import.meta.dir, "fixtures", "fake-zhw", "fake-zhw.cmd");
	test.skipIf(process.platform !== "win32")("stats, load and unload give up on a host that never answers", async () => {
		const sup = createPluginSupervisor({ zhwPath: fake, controlTimeoutMs: 300, loadTimeoutMs: 100, discoverHostHandlers: false, importHandlers: zincHandlers([]) });
		open.push(sup);
		await sup.ready();
		const t0 = Date.now();
		const stats = await asError(sup.stats!());
		expect(stats?.kind).toBe("timeout");
		expect(Date.now() - t0).toBeLessThan(3000);
		const load = await asError(sup.load(dirs["hello-js"]));
		expect(load?.kind).toBe("timeout");
		expect(sup.get(ID)?.status).toBe("failed");
		const t1 = Date.now();
		await sup.unload(ID); // the host never answers: this still returns
		expect(Date.now() - t1).toBeLessThan(3000);
	}, 30_000);
});

describe("stop behind something that is not a call", () => {
	const slow = join(import.meta.dir, "fixtures", "fake-zhw", "slow-load.cmd");
	test.skipIf(process.platform !== "win32")("still stops a plugin that was loading for longer than the grace time", async () => {
		const sup = createPluginSupervisor({ zhwPath: slow, stuckCallMs: 200, discoverHostHandlers: false, importHandlers: zincHandlers([]) });
		open.push(sup);
		await sup.load(dirs["hello-js"]);
		await sup.start(ID);
		await sup.stop(ID);
		const enabled = sup.enable(ID); // loads again: nothing that stop could give up on
		await Bun.sleep(50);
		await sup.stop(ID);
		await enabled;
		expect(sup.get(ID)?.status).toBe("stopped");
	}, 30_000);
});

describe("a plugin that exceeded its budget", () => {
	test("is unloaded from the host, not kept there as a dead instance", async () => {
		const sup = newSupervisor([], { callTimeoutMs: 400 });
		open.push(sup);
		const spin = await sup.load(dirs["spin-rust"]);
		await sup.start(spin.id);
		const loaded = (await sup.stats!()) as { plugins: { plugin: string }[] };
		expect(loaded.plugins.map((p) => p.plugin)).toContain(spin.id);
		const err = (await sup.call(spin.id, "events", "on-timer", [999, "timeout"]).catch((e) => e)) as PluginError;
		expect(err.kind).toBe("timeout");
		expect(sup.get(spin.id)?.status).toBe("disabled");
		// the unload is a message to the host: give it a moment, then ask what the host still holds
		await Bun.sleep(300);
		const after = (await sup.stats!()) as { plugins: { plugin: string }[] };
		expect(after.plugins.map((p) => p.plugin)).not.toContain(spin.id);
	}, 60_000);
});
