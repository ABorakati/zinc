// Registers this feature's menu entries and shortcuts (see lib/registry.ts): Tools > Settings… and Ctrl+,.
import { Settings } from "lucide-solid";
import { registerAppAction } from "~/lib/registry";
import { registerShortcutHelp } from "~/maintenance/shortcutHelp";
import { store } from "~/store";

registerAppAction({ id: "settings-open", label: "Settings…", icon: Settings, menu: "tools", shortcut: "Ctrl+,", run: () => store.openSettings() });

registerShortcutHelp([
	{ group: "General", keys: "Ctrl+,", description: "Open Settings" },
	{ group: "Settings", keys: "/  or  Ctrl+F", description: "Search settings" },
	{ group: "Settings", keys: "Esc", description: "Clear the settings search" },
	{ group: "Settings", keys: "Enter", description: "Jump from the search box to the first matching setting" },
]);

if (typeof window !== "undefined") {
	// capture phase, like the library shortcuts, so focused controls cannot swallow it
	window.addEventListener("keydown", (e) => {
		if (e.defaultPrevented || e.isComposing || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey) || e.key !== ",") return;
		e.preventDefault();
		e.stopPropagation();
		store.openSettings();
	}, true);
}
