// `ui.open-dialog` is an import handler: it runs while the plugin's own call is still open. The dialog's `ui-events.mount` must
// not be refused as re-entrant; it has to wait in the supervisor's queue for the plugin's call to finish. Real supervisor, real
// plugin (the hello-js fixture), real `openDialogNow`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolveZhwPath } from "../../../../plugin-host/src/transport-wasmtime";
import { defineHandler } from "../../../../plugin-host/src/imports/registry";
import type { PluginSupervisor } from "../../../../plugin-host/src/supervisor";
import { buildFixtures, newSupervisor, until, zincHandlers } from "../../../../plugin-host/test/helpers";
import { setPluginSupervisor } from "../host";
import { lookupInstance } from "./controller";
import { openDialogNow, type HostCtx } from "./host";

// needs the plugin host binary (plugin-host-wasmtime, a cargo build): skipped where it is not built, as in the gpui-ui CI job
const hasZhw = existsSync(resolveZhwPath());

let dirs: Awaited<ReturnType<typeof buildFixtures>>;
beforeAll(async () => {
	if (hasZhw) dirs = await buildFixtures();
}, 180_000);

let sup: PluginSupervisor | undefined;
afterAll(async () => {
	setPluginSupervisor(undefined);
	await sup?.shutdown();
});

describe.skipIf(!hasZhw)("ui.open-dialog from inside a plugin call", () => {
	test("the dialog's mount is queued behind the call, not refused as re-entrant", async () => {
		const lines: string[] = [];
		let instance: bigint | undefined;
		let opened: unknown;
		sup = newSupervisor(lines, {
			importHandlers: [
				...zincHandlers(lines).filter((h) => h.interface.endsWith("/log")),
				defineHandler({
					interface: "zinc:plugin/timers",
					where: "zinc",
					functions: {
						// hello-js calls this from `lifecycle.startup`: the handler opens a dialog before startup has returned
						"set-timeout": (ctx: HostCtx) => {
							try {
								instance = openDialogNow(ctx, {
									title: { tag: "plain", val: "t" },
									content: { root: { type: "text", text: "hi" } },
									buttons: [],
									resizable: false,
									modal: false,
									dismissOnEscape: true,
								} as never);
							} catch (e) {
								opened = e;
							}
							return 7;
						},
					},
				}),
			],
		});
		setPluginSupervisor(sup);
		const info = await sup.load(dirs["hello-js"]);
		await sup.start(info.id);
		expect(opened).toBeUndefined();
		expect(instance).toBeDefined();
		const ctl = lookupInstance(instance!)!;
		expect(ctl).toBeDefined();
		// hello-js exports no `ui-events`, so the mount fails with "no such export": that is the proof that it reached the plugin.
		await until(() => ctl.state.status !== "mounting" && ctl.state.message !== undefined, 5000, "the mount to finish");
		expect(ctl.state.message).not.toMatch(/waiting on a host import/);
		expect(ctl.state.message).toMatch(/ui-events/);
	}, 60_000);
});
