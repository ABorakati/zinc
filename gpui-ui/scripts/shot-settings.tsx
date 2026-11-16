// Headless screenshots of the Settings tab and the sync popover (top bar + Settings only, so the list does not matter):
//   bun scripts/shot-settings.tsx [dark|light] [scene...] [--scheme id] [--font id] [--size 14]
// Scenes (default all): one per section id (appearance general reader sync shortcuts files integrations system), "search", "sync" (popover),
// "scheme" (a non-default colour scheme applied live), "font" (another UI font applied live). Files: <SHOTS>/shell-settings-<scene>[-light].png.
// Reads the core at ZN_URL (a library COPY); only GET requests are sent, plus Settings controls that you click here (none do).
import { SHOTS, boot } from "./shell-shot-lib";
import { Show } from "solid-js";
import { gotoSection, SettingsPage } from "../src/settings";
import { setSettingsQuery, settingsShown } from "../src/settings/registry";
import { openSettings } from "../src/shell/layout";
import { setThemePrefs } from "../src/shell/appearance";
import { setSyncPopoverOpen } from "../src/sync/SyncStatus";
import { store } from "../src/store";
import { textStyle, tw } from "../src/theme";
import { TopBar } from "../src/TopBar";
import { OverlayHost } from "../src/ui";

const args = process.argv.slice(2);
const mode = args.includes("light") ? "light" : "dark";
const ALL = [
	"appearance",
	"general",
	"reader",
	"sync",
	"shortcuts",
	"files",
	"integrations",
	"system",
	"search",
	"sync-popover",
	"scheme",
	"font",
];
const wanted = args.filter((a) => ALL.includes(a));
const scenes = wanted.length ? wanted : ALL;
const suffix = mode === "light" ? "-light" : "";

const h = await boot({
	prefs: { mode },
	view: () => (
		<div style={{ ...tw("flex flex-col bg-canvas", store.mode()), width: "100%", height: "100%" }}>
			<TopBar />
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					flexGrow: 1,
					minHeight: 0,
					width: "100%",
					backgroundColor: "transparent",
				}}
			>
				<Show
					when={store.activeTab() === "settings"}
					fallback={<text style={textStyle("text-foreground", store.mode())}>library tab</text>}
				>
					<SettingsPage active />
				</Show>
			</div>
			<OverlayHost />
		</div>
	),
});
openSettings();
settingsShown();
await h.settle(1500); // server-backed sections load

for (const sc of scenes) {
	setSettingsQuery("");
	setSyncPopoverOpen(false);
	if (sc === "search") {
		gotoSection("appearance");
		setSettingsQuery("dark");
	} else if (sc === "sync-popover") {
		gotoSection("sync");
		setSyncPopoverOpen(true);
		await h.settle(800);
	} else if (sc === "scheme") {
		gotoSection("appearance");
		setThemePrefs({ scheme: "teal" });
	} else if (sc === "font") {
		gotoSection("appearance");
		setThemePrefs({ font: "manrope", size: 14 });
	} else gotoSection(sc);
	await h.settle(600);
	await h.shot(`settings-${sc}${suffix}`);
}
h.t.unmount();
process.exit(0);
