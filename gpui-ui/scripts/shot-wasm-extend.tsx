// Headless check of the extension points in the main window, with a REAL plugin (the QuickJS fixture in test/wasm-extend-fixture) running
// in the plugin host process:
//   bun scripts/shot-wasm-extend.tsx [dark|light]
// A throw-away library (8 articles in a temp folder, the core runs in this process: ZN_CORE_DIRECT, no port) is opened in the whole <App/>
// in GPUIX's headless renderer. The plugin registers a section, an Info row, a column, a menu item, a Tools-menu item of the menubar, a toolbar
// button, a shortcut and a preference pane; the script checks that each is drawn and that a click (or the shortcut) reaches the plugin, and
// writes screenshots to <scratch>/gpui-shots/wasm-extend-*.png. Exit code 1 on a failed check. Never touches a real library or the screen.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SHOTS, STATE_FILE } from "./_shell-env";

const mode = process.argv.includes("light") ? "light" : "dark";
const tmp = join(process.env.TEMP ?? "/tmp", `zn-wasm-extend-shot-${process.pid}`);
mkdirSync(tmp, { recursive: true });
const dbPath = join(tmp, "library.sqlite");

// 1. the library: a few articles whose keys are 8 characters
{
	const { openDb } = (await import("../../core/src/db" as string)) as unknown as { openDb(p: string): { close(): void } };
	const { insertItem } = (await import("../../core/test/fixture" as string)) as unknown as {
		insertItem(db: unknown, d: Record<string, unknown>): void;
	};
	const db = openDb(dbPath);
	for (let i = 1; i <= 8; i++)
		insertItem(db, {
			key: `ABCD000${i}`,
			itemType: "journalArticle",
			title: `Extension point article ${i}`,
			creators: [{ creatorType: "author", firstName: "Ada", lastName: `Writer${i}` }],
			date: `${2010 + i}`,
			publicationTitle: "Journal of Fixtures",
		});
	db.close();
}
process.env.ZN_DB = dbPath;
process.env.ZN_CORE_DIRECT = "1";
process.env.ZN_SYNC = "0";

const { startCore } = await import("../src/core");
await startCore();

// 2. the plugin: build the fixture, start the supervisor, bind the window side
const { buildPlugin } = await import("../../plugin-host/scripts/build-plugin");
// ZN_EXTEND_FIXTURE=<folder>: a fixture already built by a previous run or by extend.test.ts (skips the componentize + jco step)
const pluginOut = process.env.ZN_EXTEND_FIXTURE ?? join(tmp, "plugin");
if (!process.env.ZN_EXTEND_FIXTURE) await buildPlugin({ dir: join(import.meta.dir, "../test/wasm-extend-fixture"), out: pluginOut, world: "ext" });
const { defineHandler } = await import("../../plugin-host/src/imports/registry");
const { extendHandler } = await import("../src/wasmplugins/extend/handler");
const { startWasmPlugins, stopWasmPlugins } = await import("../src/wasmplugins");
const lines: string[] = [];
const logHandler = defineHandler({
	interface: "zinc:plugin/log",
	where: "zinc",
	functions: { write: (_ctx: unknown, _level: string, message: string) => void lines.push(message) },
});
await startWasmPlugins({ force: true, dirs: [pluginOut], handlers: [logHandler, extendHandler] });

// 3. the window
const { boot, sleep } = await import("./shell-shot-lib");
const h = await boot({ prefs: { mode }, width: 1440, height: 880 });
const { store, uiState } = await import("../src/store");
uiState.disableWrites();
const { columnLayout } = await import("../src/table/layout");
const { handleWindowKeyDown } = await import("../src/shell/shortcuts");
const { openItemMenu } = await import("../src/cards/menus");
const { openSettings } = await import("../src/shell/layout");
const { gotoSection } = await import("../src/settings/SettingsPage");

const ID = "extend-fixture@zinc.test";
let failed = 0;
const check = (ok: boolean, what: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
	if (!ok) failed++;
};
const shot = async (name: string) => {
	await h.settle(500);
	const file = `${SHOTS}/wasm-extend-${name}.png`;
	h.t.renderer.captureScreenshot(file);
	console.log("wrote", file);
};
const has = (text: string) => !!h.t.renderer.findByText(text);
const waitFor = async (cond: () => boolean, ms = 8000) => {
	const t0 = Date.now();
	while (!cond() && Date.now() - t0 < ms) {
		await h.settle(200);
		await sleep(50);
	}
	return cond();
};
const clickTestId = async (id: string) => {
	const el = h.t.renderer.findByTestId(id);
	const b = el && h.t.renderer.getElementBounds(el.id);
	if (!b) return false;
	await h.click(b.x + b.width / 2, b.y + b.height / 2);
	return true;
};

try {
	// the list and the first item
	await waitFor(() => store.total() >= 8);
	const first = store.itemAt(0);
	check(!!first, "the throw-away library shows its items");
	if (first) store.selectItem(first.key);

	// toolbar button: drawn, and a click reaches the plugin
	check(await waitFor(() => !!h.t.renderer.findByTestId(`plugin-toolbar-${ID}-tb1`)), "toolbar button is drawn");
	await clickTestId(`plugin-toolbar-${ID}-tb1`);
	check(await waitFor(() => lines.includes("toolbar-click tb1 tab=library")), "a toolbar click reaches the plugin");

	// item pane: section header, Info row
	check(await waitFor(() => has("FIXTURE SECTION")), "item pane section header is drawn");
	check(await waitFor(() => has("Fixture row")), "Info row label is drawn");
	check(await waitFor(() => !!first && has(`row row1 of ${first.key}`)), "Info row value comes from the plugin");
	await shot(`pane-${mode}`);

	// menubar: File ... Help, with the plugin's Tools entry; a click reaches the plugin
	check(!!h.t.renderer.findByTestId("plugin-menubar"), "the menubar is drawn");
	for (const m of ["File", "Edit", "View", "Go", "Tools", "Help"]) check(has(m), `menubar has ${m}`);
	await h.clickText("Tools");
	check(await waitFor(() => has("Fixture tools entry")), "the plugin's menubar Tools entry is drawn");
	await shot(`menubar-${mode}`);
	await h.clickText("Fixture tools entry");
	check(await waitFor(() => lines.some((l) => l.startsWith("menu-command m2/tools-hello"))), "a menubar entry click reaches the plugin");

	// item context menu
	if (first) {
		await openItemMenu({ x: 300, y: 200 }, first, 0);
		check(await waitFor(() => has("Fixture: say hello")), "the plugin's item menu entry is drawn");
		await h.clickText("Fixture: say hello");
		check(await waitFor(() => lines.some((l) => l.startsWith("menu-command m1/hello items=1"))), "an item menu click reaches the plugin");
	}

	// shortcut
	handleWindowKeyDown({ key: "j", modifiers: { ctrl: true, alt: true, shift: false }, defaultPrevented: false, preventDefault() {} } as never);
	check(await waitFor(() => lines.includes("shortcut sc1")), "the shortcut reaches the plugin");

	// column in the Classic table: one batch for the rows on screen
	columnLayout.toggle(`plugin:${ID}:len`, true);
	store.setViewMode("table");
	check(await waitFor(() => has("len 8")), "the plugin column's cells are drawn");
	check(lines.filter((l) => l.startsWith("column-values len n=")).length <= 2, "the column was fetched in batches, not per row");
	console.log(lines.filter((l) => l.startsWith("column-values")).join(" | "));
	await shot(`table-${mode}`);

	// preference pane in Settings
	openSettings();
	gotoSection(`plugin:${ID}:pane1`);
	check(await waitFor(() => has("Fixture switch")), "the plugin's preference pane row is drawn");
	await shot(`settings-${mode}`);
} catch (e) {
	console.error(e);
	failed++;
}

await stopWasmPlugins();
h.t.unmount();
try {
	rmSync(tmp, { recursive: true, force: true });
} catch {
	/* the library file is still open (EBUSY): the temp folder is removed with the next clean-up of %TEMP% */
}
rmSync(STATE_FILE, { force: true });
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
