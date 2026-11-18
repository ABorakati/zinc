// Test template: copy next to your plugin, set BUILT to the build output (the folder with manifest.json + plugin.wasm), edit the ids,
// run with `bun test plugin.test.ts`. It loads the plugin through Zinc's supervisor with stub imports (see scripts/smoke.ts);
// it never touches a real library, core or port. Adjust SMOKE to where the skill lives (or copy smoke.ts beside this file).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeDialog, itemSummary, menuContext, openPlugin, uiEvent, viewContext, checkRender, type OpenPlugin } from "../scripts/smoke";

const BUILT = process.env.BUILT ?? "dist";
let p: OpenPlugin;

beforeAll(async () => {
	p = await openPlugin(BUILT, {
		// answer every import the plugin calls that is not in DEFAULT_ANSWERS; calls are recorded in p.calls
		"library.count-items": () => 42n,
		"library.get-summaries": (keys: string[]) => keys.map((k) => itemSummary(k)),
		"ui.open-dialog": () => 100n,
	});
});
afterAll(async () => {
	await p?.shutdown();
});

test("startup registers a menu", () => {
	const reg = p.calledWith("extend.register-menu")[0]?.args[0] as any;
	expect(reg.entries.length).toBeGreaterThan(0);
});

test("a section mounts, validates against the UI schema, and reacts to a press", async () => {
	const mounted = await p.call("ui-events", "mount", [1n, viewContext("SECTION-ID", { itemKey: "AAAA1111" })]);
	expect(checkRender(mounted)).toBeUndefined(); // unknown node props are errors in Zinc
	const after = await p.call("ui-events", "on-event", [1n, uiEvent("click")]);
	expect(checkRender(after)).toBeUndefined();
	expect(String(after.content.val)).toContain("clicked 1");
});

test("a dialog answer reaches the plugin", async () => {
	await p.call("extend-handlers", "on-menu-command", ["MENU-ID", "ENTRY-ID", undefined, menuContext({ items: ["AAAA1111"], itemCount: 1 })]);
	const opened = p.calledWith("ui.open-dialog").length;
	expect(opened).toBeGreaterThan(0);
	await closeDialog(p, 100n, "ok", [{ name: "name", value: { tag: "text", val: "Ada" } }]);
	expect(p.calledWith("ui.show-toast").length).toBeGreaterThan(0);
});

test("the plugin is still running", () => {
	expect(p.sup.get(p.id)?.status).toBe("running");
});
