// The plugin manager with the e2e plugin on the real supervisor and `zhw`: the `uninstall` hook runs once, and a hook that waits for
// ever in a host import does not hold up an uninstall or `startAll`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { defineHandler } from "../../src/imports/registry";
import type { ApproveFn } from "../../src/package/installer";
import { buildE2e, myZincHandlers, newRuntime, pack, rmTree, scratch } from "./helpers";

const ID = "e2e-js@zinc.test";
let built: string;
beforeAll(async () => {
	built = await buildE2e();
}, 120_000);

type Rt = Awaited<ReturnType<typeof newRuntime>>;
let current: Rt | undefined;
const roots: string[] = [];
async function closeCurrent() {
	if (!current) return;
	current.services.dispose();
	await current.supervisor.shutdown().catch(() => {});
	current = undefined;
}
afterAll(async () => {
	await closeCurrent();
	for (const r of roots) rmTree(r);
});

const grantAll: ApproveFn = (req) => ({ grant: req.required });
const never = () => new Promise<never>(() => {});
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => "settled" as const, () => "settled" as const), Bun.sleep(ms).then(() => "hung" as const)]);

/** A runtime whose `log.write` waits for ever for a line that starts with one of `hang` (it is read when the line is written). */
async function runtime(root: string, hang: { prefix?: string }, manager: Record<string, unknown> = {}): Promise<Rt> {
	await closeCurrent();
	if (!roots.includes(root)) roots.push(root);
	const log = (await myZincHandlers()).find((h) => h.interface.endsWith("/log"))!;
	const write = log.functions.write as (ctx: unknown, ...a: unknown[]) => unknown;
	const rt = await newRuntime(root, {
		extraHandlers: [
			defineHandler({
				interface: "zinc:plugin/log",
				where: "zinc",
				functions: { ...log.functions, write: (ctx: unknown, level: unknown, message: string) => (hang.prefix && message.startsWith(hang.prefix) ? never() : write(ctx, level, message)) },
			}),
		],
		manager: { zincVersion: "0.5.0", ...manager },
		// `log` is handled by `zhw` itself unless it is left out of this list: the stuck line must reach the handler above
		supervisor: { nativeImports: ["prefs", "timers", "l10n", "app", "util"] },
	});
	current = rt;
	return rt;
}

describe("uninstall", () => {
	test("a plugin that is disabled gets its uninstall hook once", async () => {
		const root = scratch("uninst-once");
		const rt = await runtime(root, {});
		await rt.services.manager.installPackage(pack(built), { approve: grantAll });
		await rt.services.manager.setEnabled(ID, false);
		expect(rt.supervisor.get(ID)).toBeUndefined();
		const seen: string[] = [];
		rt.supervisor.on("log", (l) => void seen.push(l.message));
		await rt.services.manager.uninstall(ID);
		expect(seen.filter((m) => m.startsWith("hook uninstall"))).toEqual(["hook uninstall addon-uninstall v=1.0.0"]);
		expect(existsSync(rt.services.manager.layout.installed(ID))).toBe(false);
	}, 90_000);

	test("an uninstall hook that waits for ever is given up on and the plugin is removed", async () => {
		const root = scratch("uninst-stuck");
		const hang: { prefix?: string } = {};
		const rt = await runtime(root, hang, { stuckMs: 500 });
		await rt.services.manager.installPackage(pack(built), { approve: grantAll });
		hang.prefix = "hook uninstall";
		expect(await within(rt.services.manager.uninstall(ID), 20_000)).toBe("settled");
		expect(existsSync(rt.services.manager.layout.installed(ID))).toBe(false);
		expect(rt.services.manager.get(ID)).toBeUndefined();
		expect(rt.supervisor.get(ID)).toBeUndefined();
	}, 90_000);
});

describe("startAll", () => {
	test("a startup that waits for ever does not hold up startAll; the plugin can then be disabled", async () => {
		const root = scratch("startall-stuck");
		const first = await runtime(root, {});
		await first.services.manager.installPackage(pack(built), { approve: grantAll });
		first.services.dispose();
		await first.supervisor.shutdown();
		current = undefined;

		const hang = { prefix: "hook startup" };
		const second = await runtime(root, hang, { stuckMs: 500 });
		const t0 = Date.now();
		expect(await within(second.services.manager.startAll(), 20_000)).toBe("settled");
		expect(Date.now() - t0).toBeLessThan(15_000);
		// the plugin is still starting; disabling it does not wait for the startup either
		expect(await within(second.services.manager.setEnabled(ID, false), 20_000)).toBe("settled");
		expect(second.supervisor.get(ID)).toBeUndefined();
	}, 90_000);
});
