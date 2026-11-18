// End to end: a built plugin (QuickJS component) queries the library, writes through library.apply, and receives notifier batches,
// all through the real plugin host process, import routing and a throwaway core.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { buildPlugin } from "../../scripts/build-plugin";
import { createPluginSupervisor, type PluginSupervisor } from "../../src/supervisor";
import { zincHandlers, fixtureOut } from "../helpers";
import { startCore, until, type TestCore } from "./core-fixture";

let core: TestCore;
let sup: PluginSupervisor;
const lines: string[] = [];
const fixture = join(import.meta.dir, "fixtures", "e2e-js");
const id = "e2e-data@zinc.test";

const events = () => lines.filter((l) => l.includes(": E2E ")).map((l) => JSON.parse(l.slice(l.indexOf(": E2E ") + 6)));
const find = (pred: (e: any) => boolean) => events().find(pred);

beforeAll(async () => {
	core = await startCore();
	const { out } = await buildPlugin({ dir: fixture, out: join(fixtureOut, "e2e-data"), world: "e2e" });
	sup = createPluginSupervisor({ importHandlers: zincHandlers(lines), coreUrl: core.url, callTimeoutMs: 8000, lifecycleTimeoutMs: 10_000 });
	if (process.env.ZN_DUMP_LOG) {
		for (const ev of ["host-restart", "host-restarted", "host-failed", "status", "log"] as const) sup.on(ev, (e: unknown) => lines.push(`SUP ${ev} ${JSON.stringify(e)}`));
	}
	await sup.load(out);
	await sup.start(id);
}, 120_000);

afterAll(async () => {
	if (process.env.ZN_DUMP_LOG) console.log(lines.join("\n"));
	await sup?.shutdown();
	core?.stop();
	rmSync(join(fixture, "wit", "deps"), { recursive: true, force: true });
});

const writeToCore = (path: string, body: unknown) => fetch(core.url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("a built plugin on the data area", () => {
	test("startup subscribes to the notifier", async () => {
		const e = await until(() => find((x) => "subscribed" in x || "subscribeError" in x), 5000, "subscription");
		expect(e).toEqual({ subscribed: 1 });
	});

	test("library.query-items from the guest", async () => {
		await sup.call(id, "events", "on-timer", [1, "timeout"]);
		const e = await until(() => find((x) => x.query || x.queryError), 5000, "query result");
		expect(e.queryError).toBeUndefined();
		expect(e.query.total).toBe(3);
		expect(e.query.items.map((i: any) => i.title)).toEqual(["Deep learning for radiology", "Surgical anatomy", "Zebra genetics"]);
		expect(e.query.items[0].fields).toEqual([["date", "2020-05-01"]]);
	});

	test("a write by someone else arrives as a notifier batch (origin unknown)", async () => {
		await new Promise((r) => setTimeout(r, 300)); // the feed has read the head
		const r = await (await writeToCore("/api/items", { data: { itemType: "book", title: "Written by the user" } })).json();
		const e = await until(() => find((x) => x.batch?.events.some((v: any) => v.ids.includes(r.data.key))), 6000, "batch for the user's write");
		expect(e.batch.sub).toBe(1);
		expect(e.batch.seq).toBeGreaterThanOrEqual(1);
		const ev = e.batch.events.find((v: any) => v.ids.includes(r.data.key));
		expect(ev).toMatchObject({ object: "item", kind: "add", origin: { tag: "unknown" } });
	}, 15_000);

	test("library.apply from the guest writes atomically and the batch carries origin self", async () => {
		await sup.call(id, "events", "on-timer", [2, "timeout"]);
		const e = await until(() => find((x) => x.applied || x.applyError), 6000, "apply result");
		expect(e.applyError).toBeUndefined();
		expect(e.applied.created).toEqual([e.key]);
		expect(e.applied.changed).toBe(1);
		const stored = await (await fetch(`${core.url}/api/items/${e.key}`)).json();
		expect(stored.data.title).toBe("Written by the plugin");
		const b = await until(() => find((x) => x.batch?.events.some((v: any) => v.ids.includes(e.key))), 6000, "batch for the plugin's own write");
		expect(b.batch.events.find((v: any) => v.ids.includes(e.key)).origin).toEqual({ tag: "this-plugin" });
	}, 15_000);

	test("a call without the permission comes back as error::permission-denied (library.trash is not granted)", async () => {
		await sup.call(id, "events", "on-timer", [3, "timeout"]);
		const e = await until(() => find((x) => x.trashError || x.trashed), 6000, "trash result");
		expect(e.trashed).toBeUndefined();
		expect(e.trashError.index).toBeUndefined(); // not tied to one change
		expect(e.trashError.error).toEqual({ tag: "permission-denied", val: "library.trash" });
		expect(((await (await fetch(`${core.url}/api/items/AAAAAAA1`)).json()) as any).data.deleted).toBeUndefined();
	});
});
