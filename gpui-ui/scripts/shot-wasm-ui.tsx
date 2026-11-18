// Headless end-to-end check of the plugin UI: builds the QuickJS fixture plugin (src/wasmplugins/ui/test/fixture-ui-js) with the
// plugin-host build script, starts a real plugin supervisor with the real `ui` import handler, mounts the plugin's view with
// <PluginView> in a GPUIX test root, and checks the event round trips: a button click, typing, a dialog opened from a handler
// (re-entrancy), a toast, a menu, a virtual table pulled with render-range, a sort, a form submit and a dark-mode switch.
//   bun scripts/shot-wasm-ui.tsx [outDir]        screenshots go to %TEMP%\zn-wasm-ui (or outDir)
// Never opens a window on the screen; the supervisor starts the Wasmtime host (zhw) and stops it at the end.
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTestRoot } from "@gpuix/solid/testing";
import { buildPlugin } from "../../plugin-host/scripts/build-plugin";
import { loadHandlerModule, defineHandler } from "../../plugin-host/src/imports/registry";
import { createPluginSupervisor } from "../../plugin-host/src/supervisor";
import { registerFonts } from "../src/fonts";
import { store, uiState } from "../src/store";
import { OverlayHost } from "../src/ui";
import { tok } from "../src/ui/core";
import { PluginView } from "../src/wasmplugins/ui";
import type { ViewController } from "../src/wasmplugins/ui";

uiState.disableWrites();
const out = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? join(process.env.TEMP ?? "/tmp", "zn-wasm-ui");
mkdirSync(out, { recursive: true });
const work = join(process.env.TEMP ?? "/tmp", "zn-wasm-ui-fixture"); // kept between runs (the build is the slow, disk-writing part); delete with --clean
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
	if (!ok) failures.push(what);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- build the fixture (a copy: the build writes wit/deps next to the sources)
const src = resolve(import.meta.dir, "../src/wasmplugins/ui/test/fixture-ui-js");
rmSync(work, { recursive: true, force: true });
cpSync(src, join(work, "src"), { recursive: true });
const built = await buildPlugin({ dir: join(work, "src"), out: join(work, "plugin"), world: "ui-fixture", log: (l) => console.log("   build:", l.split("\n")[0]) });
console.log("built", built.manifest.id);

// ---- the supervisor with the real ui handler, a log handler that collects the plugin's lines
const lines: string[] = [];
const t00 = Date.now();
const sup = createPluginSupervisor({
	importHandlers: [
		...(await loadHandlerModule(resolve(import.meta.dir, "../../plugin-host/src/imports/ui.zinc.ts"))),
		defineHandler({ interface: "zinc:plugin/log", where: "zinc", functions: { write: (_c, _l: string, m: string) => void (lines.push(m), process.env.ZN_PLUGIN_LOG && console.log(`   [plugin +${Date.now() - t00} ms]`, m)) } }),
	],
	// The FIRST call of a QuickJS guest that returns a render-result takes ~20 s (componentize-qjs 0.6 + the size of ui.wit; later calls
	// take milliseconds), far over the 5 s default budget: see phase2-ui.md. The test gives the first call time.
	callTimeoutMs: 120_000,
	hostStderr: process.env.ZN_PLUGIN_HOST_STDERR ? "inherit" : "ignore",
});
sup.on("log", (e) => process.env.ZN_PLUGIN_LOG && console.log(`   [plugin log +${Date.now() - t00} ms]`, e.level, e.message));
const info = await sup.load(join(work, "plugin"));
await sup.start(info.id);

// ---- the test root
const t = createTestRoot({ width: 700, height: 900 });
(registerFonts as (r?: unknown) => void)(t.renderer);
store.setMode("light");
let ctl: ViewController | undefined;
let scroller: { id: number } | undefined;
t.render(() => (
	<div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", backgroundColor: tok("background") }}>
		<div ref={(e: { id: number }) => (scroller = e)} style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", overflow: "scroll" }}>
			<PluginView pluginId={info.id} surface="custom" view="fixture" params={{ hello: "world" }} supervisor={sup} onController={(c) => (ctl = c)} style={{ width: "100%" }} />
		</div>
		<OverlayHost />
	</div>
));
const settle = async (ms = 250) => {
	for (let i = 0; i < 4; i++) {
		t.renderer.flush();
		t.renderer.dispatchNativeEvents();
		await sleep(ms / 4);
	}
	t.renderer.flush();
};
const until = async (cond: () => boolean, ms = 8000) => {
	const t0 = Date.now();
	while (!cond() && Date.now() - t0 < ms) await settle(80);
	return cond();
};
const shot = async (name: string) => {
	await settle(400);
	t.renderer.captureScreenshot(join(out, `${name}.png`));
	console.log("   wrote", join(out, `${name}.png`));
};
const at = (label: string) => {
	const el = t.renderer.findByText(label);
	const b = el ? t.renderer.getElementBounds(el.id) : null;
	return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : undefined;
};
const reveal = async (label: string) => {
	const el = t.renderer.findByText(label);
	const b = el ? t.renderer.getElementBounds(el.id) : null;
	if (b && scroller && (b.y > 780 || b.y < 40)) {
		const off = t.renderer.getScrollOffset(scroller.id) ?? [0, 0];
		t.renderer.scrollTo(scroller.id, 0, (off[1] ?? 0) - (b.y - 250));
		await settle(200);
	}
};
const click = async (x: number, y: number, button = 0) => {
	t.renderer.nativeSimulateClick(x, y, button);
	await settle(300);
};
const clickText = async (label: string, button = 0) => {
	await reveal(label);
	const p = at(label);
	if (!p) return check(false, `text "${label}" is on screen`), false;
	await click(p.x, p.y, button);
	return true;
};
const key = async (k: string) => {
	t.renderer.simulateKeystrokes(k);
	await settle(120);
};
const has = (label: string) => !!at(label);
const logged = (needle: string) => lines.some((l) => l.includes(needle));

try {
	// ---- mount
	check(await until(() => ctl?.state.status === "ready" && has("Plugin UI fixture"), 90_000), "view mounted and the tree drawn (the first call is slow: see the budget note above)");
	check(logged("mount ") && logged("surface=custom"), "plugin got ui-events.mount with the surface");
	await shot("ui-light-top");

	// ---- every node kind produced something (the tree has no unknown-kind placeholder and no error banner)
	check(!has('unknown node kind "'), "no unknown node kind");
	check(ctl!.state.message === undefined, `no tree error (${ctl!.state.message ?? "none"})`);

	// ---- a button click reaches the plugin and the new tree is drawn
	check(await clickText("Click me"), "clicked the button");
	const tClick = Date.now();
	check(await until(() => logged("press btn clicks=1"), 120_000), `plugin received the press event (${Date.now() - tClick} ms; the first on-event of a QuickJS guest is slow too)`);
	check(await until(() => has("Clicks: 1")), "plugin's new tree drawn (Clicks: 1)");

	// ---- typing in an input reaches the plugin
	const inputs = t.renderer.findByType("input");
	check(inputs.length > 0, `inputs drawn (${inputs.length})`);
	const ib = t.renderer.getElementBounds(inputs[0]!.id)!;
	await click(ib.x + 20, ib.y + ib.height / 2);
	for (const ch of "hello") await key(ch);
	check(await until(() => logged("typed: hello")), "typing reached the plugin (input events)");
	check(await until(() => has("Echo: hello")), "echo of the typed text drawn");
	await key("enter");
	check(await until(() => logged("submitted: name=hello")), "Enter in the form fired submit with the named values");

	// ---- a checkbox and a radio
	await clickText("I agree");
	check(await until(() => logged("checked: true")), "checkbox change reached the plugin");
	await clickText("Option A");
	check(await until(() => logged("radio: a")), "radio change reached the plugin");

	// ---- a select menu (grouped) through Zinc's menu layer
	await clickText("Gamma");
	check(await until(() => has("Numbers")), "select opened its grouped menu");
	await shot("ui-select-open");
	await clickText("Beta");
	check(await until(() => logged("pick: beta")), "select choice reached the plugin");

	// ---- a button menu
	await clickText("Menu");
	check(await until(() => has("Second")), "button menu opened");
	await clickText("Second");
	check(await until(() => logged("menu m2")), "menu item reached the plugin as its handler id");

	// ---- tabs
	await clickText("Two");
	check(await until(() => logged("tab: two")), "tab change reached the plugin");
	await until(() => has("Panel two"));
	check(has("Panel two") && !has("Panel one"), "tab panel switched");

	// ---- sorting an inline table
	await clickText("Title");
	check(await until(() => logged("sort: title ascending")), "table sort event reached the plugin");

	// ---- virtual table: rows are pulled
	check(await until(() => logged("render-range vt")), "virtual table asked for rows (render-range)");
	check(await until(() => has("Virtual row 0")), "virtual rows drawn");

	// ---- a toast
	await clickText("Show toast");
	check(await until(() => has("Fixture toast")), "toast drawn");
	await shot("ui-toast");

	// ---- a dialog opened from a handler via ui.open-dialog (outcome delivered via close event)
	await clickText("Open dialog");
	check(await until(() => has("Fixture dialog")), "open-dialog drew the dialog");
	const di = t.renderer.findByType("input").map((e) => ({ e, b: t.renderer.getElementBounds(e.id)! })).filter((x) => x.b && x.b.x > 500 && x.b.x < 900 && x.b.y > 150).pop();
	if (di) await click(di.b.x + 20, di.b.y + di.b.height / 2);
	for (const ch of "ok") await key(ch);
	check(await until(() => logged("dialog typed: ok")), "an event from the dialog reached the plugin while open");
	await shot("ui-dialog");
	await key("enter"); // Enter in the dialog's input presses the default button
	const cancel = at("Cancel");
	if (cancel && has("Fixture dialog")) await click(cancel.x + 74, cancel.y); // fallback: the OK button sits right of Cancel
	check(await until(() => logged("dialog outcome: ok dlgtext=ok")), "open-dialog close events delivered the pressed button and input values");
	check(await until(() => has("Dialog outcome: ok dlgtext=ok")), "tree re-rendered after the dialog closed");

	// ---- a scrolled view of the lower half, in light and dark
	const scroller = t.renderer.findByType("div").find((e) => t.renderer.getElementBounds(e.id)?.height === 900 - 0);
	void scroller;
	await shot("ui-light");
	store.setMode("dark");
	check(await until(() => logged("update-context") && logged("theme=dark"), 60_000), "theme change called update-context with the new mode");
	await shot("ui-dark");
	store.setMode("light");
	await settle(300);

	// ---- unmount
	check(true, "unmount is sent when the view goes (checked below)");
} catch (e) {
	check(false, `exception: ${(e as Error).stack ?? e}`);
}

t.unmount();
await sleep(300);
check(logged("unmount "), "plugin got ui-events.unmount");
await sup.shutdown();
if (process.argv.includes("--clean")) rmSync(work, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
