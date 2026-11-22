// notifier: one subscription-guard handle per plugin, not one per subscribe.
import { afterAll, describe, expect, test } from "bun:test";
import { HandlerTable } from "../../src/imports/registry";
import notifier, { resetNotifier } from "../../src/imports/notifier.host";
import { fakeCtx, manifestOf } from "./core-fixture";

afterAll(() => resetNotifier());

const sub = { types: ["item"], kinds: [], priority: 100, skipOwn: false, maxDelayMs: 0, label: "" };

describe("notifier guard handles", () => {
	test("subscribing and unsubscribing over and over makes one guard; a dropped plugin gets a new one", async () => {
		const table = new HandlerTable([notifier]);
		const base = fakeCtx({ url: "http://127.0.0.1:1" }, manifestOf({ capabilities: ["library.read"] }));
		let guards = 0;
		const ctx = { ...base, resource: (name: string, state: unknown) => (guards++, table.createResource(base.pluginId, name, state)) } as typeof base;
		for (let i = 0; i < 20; i++) {
			const id = (await table.call(ctx, notifier.interface, "subscribe", [sub])) as number;
			await table.call(ctx, notifier.interface, "unsubscribe", [id]);
		}
		expect(guards).toBe(1);
		// the plugin goes away: its handles are dropped, and the next subscription is guarded again
		await table.dropPlugin(ctx);
		await table.call(ctx, notifier.interface, "subscribe", [sub]);
		expect(guards).toBe(2);
		await table.dropPlugin(ctx);
	});
});
