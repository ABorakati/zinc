// Shortcuts (one read-only row per registered shortcut) and Advanced.
import { Keyboard, Wrench } from "lucide-solid";
import { toast } from "solid-sonner";
import { Button } from "~/components/ui/button";
import { shortcutEntries } from "~/maintenance/shortcutHelp";
import { emptyTrash } from "~/maintenance/ops";
import { Kbd } from "../controls";
import { registerSection, registerSettings, registerSettingsProvider } from "../registry";

registerSection({ id: "shortcuts", label: "Shortcuts", icon: Keyboard, order: 80, description: "Keyboard shortcuts of the app. Ctrl+/ shows them anywhere.", keywords: ["keyboard", "keys", "hotkeys", "bindings"] });
registerSection({ id: "advanced", label: "Advanced", icon: Wrench, order: 90, description: "Files and folders, feeds and maintenance.", keywords: ["files and folders", "feeds", "maintenance", "reset"] });

// every shortcut registered with registerShortcutHelp(), grouped as in the help overlay
registerSettingsProvider(() =>
	shortcutEntries().map((e) => ({
		id: `shortcuts.${e.group ?? "General"}.${e.keys}.${e.description}`,
		section: "shortcuts",
		group: e.group ?? "General",
		label: e.description,
		keywords: [e.keys, "keyboard", "shortcut", "key"],
		control: () => <Kbd>{e.keys}</Kbd>,
	})),
);

const resetPaneSizes = () => {
	try {
		for (const k of Object.keys(localStorage)) if (k.startsWith("zn.sizes.")) localStorage.removeItem(k);
		toast.success("Pane sizes reset", { description: "They return to normal the next time the app starts." });
	} catch { toast.error("Could not reset pane sizes"); }
};

registerSettings([
	{ id: "shortcuts.customise", section: "shortcuts", label: "Change shortcuts", description: "Rebind keys to other combinations.", keywords: ["customise", "customize", "rebind", "remap"], unavailable: true },

	{
		id: "advanced.panes", section: "advanced", group: "Interface", label: "Reset pane sizes",
		description: "Widths and heights of the collections, tags, item list and item panes.",
		keywords: ["layout", "resize", "panels", "splitter"],
		control: () => <Button variant="outline" size="sm" class="h-7 px-2 text-xs" onClick={resetPaneSizes}>Reset</Button>,
	},
	{
		id: "advanced.emptyTrash", section: "advanced", group: "Maintenance", label: "Empty Trash",
		description: "Permanently delete everything in the Trash (asks first).",
		keywords: ["delete", "deleted items", "bin", "purge"],
		control: () => <Button variant="outline" size="sm" class="h-7 px-2 text-xs" onClick={() => void emptyTrash()}>Empty Trash…</Button>,
	},
	{ id: "advanced.baseDir", section: "advanced", group: "Files and Folders", label: "Linked attachment base directory", description: "Store linked file paths relative to a folder so they survive a move.", keywords: ["linked files", "relative path", "attachments"], unavailable: true },
	{ id: "advanced.storageDir", section: "advanced", group: "Files and Folders", label: "Attachment storage location", description: "Where imported files are kept.", keywords: ["data directory", "storage folder", "move"], unavailable: true },
	{ id: "advanced.feedsUpdate", section: "advanced", group: "Feeds", label: "Update feeds automatically", keywords: ["rss", "atom", "subscriptions"], unavailable: true },
	{ id: "advanced.feedsInterval", section: "advanced", group: "Feeds", label: "Feed update interval", keywords: ["rss", "refresh", "minutes"], unavailable: true },
]);
