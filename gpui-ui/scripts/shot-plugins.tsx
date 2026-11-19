// Headless screenshots of Settings > Plugins with the package runtime: empty, one installed plugin running, the same plugin turned
// off, and the install prompt. Plugins live in a temporary folder (ZN_PLUGINS_DIR); the plugin is plugin-host's e2e test fixture.
//   bun scripts/shot-plugins.tsx [dark|light]
// Files: <SHOTS>/shell-plugins-<scene>[-light].png. No core is needed: set ZN_URL to a port nothing listens on (the default here).
import { SHOTS, boot } from "./shell-shot-lib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Show } from "solid-js";

process.env.ZN_URL ??= "http://127.0.0.1:23199"; // never the user's core
const root = mkdtempSync(join(tmpdir(), "zn-shot-plugins-"));
process.env.ZN_PLUGINS_DIR = join(root, "plugins");

const { buildE2e, myZincHandlers, pack } = await import("../../plugin-host/test/pkg/helpers");
const { gotoSection, SettingsPage } = await import("../src/settings");
const { settingsShown } = await import("../src/settings/registry");
const { openSettings } = await import("../src/shell/layout");
const { store } = await import("../src/store");
const { textStyle, tw } = await import("../src/theme");
const { OverlayHost } = await import("../src/ui");
const plugins = await import("../src/wasmplugins");
const { register } = await import("../src/wasmplugins/register");
const { promptInstall } = await import("../src/wasmplugins/ui/install");
const { describePermissions } = await import("../../plugin-host/src/permissions/risk");

const mode = process.argv.includes("light") ? "light" : "dark";
const suffix = mode === "light" ? "-light" : "";
register();

const h = await boot({
	prefs: { mode },
	height: 760,
	view: () => (
		<div style={{ ...tw("flex flex-col bg-canvas", store.mode()), width: "100%", height: "100%" }}>
			<Show when={store.activeTab() === "settings"} fallback={<text style={textStyle("text-foreground", store.mode())}>library tab</text>}>
				<SettingsPage active />
			</Show>
			<OverlayHost />
		</div>
	),
});
await plugins.startWasmPlugins({ force: true, runtime: true, bindUi: false, handlers: await myZincHandlers() });
openSettings();
settingsShown();
gotoSection("wasm-plugins");
await h.settle(800);
await h.shot(`plugins-empty${suffix}`);

const zplugin = join(root, "e2e.zplugin");
writeFileSync(zplugin, pack(await buildE2e()));
await plugins.installPluginPackage(zplugin, { approve: (req) => ({ grant: req.required }) });
await h.settle(800);
await h.shot(`plugins-installed${suffix}`);

await plugins.setPluginEnabled("e2e-js@zinc.test", false);
await h.settle(800);
await h.shot(`plugins-disabled${suffix}`);

// the install prompt for a plugin that asks for one permission of each tier, an optional one and a web host
const manifest = {
	manifest_version: 1,
	id: "sample@example.com",
	name: "Reading List",
	version: "1.2.0",
	author: "A. Author",
	description: "Marks items as to read, reading or read, with a column and a menu.",
	main: { wasm: "plugin.wasm" },
	permissions: { capabilities: ["library.read", "library.write", "library.erase"], net: { hosts: ["api.crossref.org"] } },
	optional_permissions: { capabilities: ["clipboard.write"] },
	permission_reasons: {
		"library.read": "Read the selected items to show their reading status.",
		"library.write": "Save the reading status as a tag.",
		"library.erase": "Empty the reading list for good when you ask.",
		"net.hosts": "Look up missing DOIs.",
		"clipboard.write": "Copy the reading list as text.",
	},
} as never;
const groups = describePermissions(manifest);
const answer = promptInstall({ action: "install", manifest, groups, required: ["library.read", "library.write", "library.erase", "net.hosts:api.crossref.org"] });
await h.settle(800);
await h.shot(`plugins-prompt${suffix}`);
void answer;

console.log(`shots in ${SHOTS}`);
await plugins.stopWasmPlugins();
h.t.unmount();
rmSync(root, { recursive: true, force: true });
process.exit(0);
