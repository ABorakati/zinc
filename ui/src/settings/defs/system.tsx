// Shortcuts (one read-only row per registered shortcut) and Advanced.
import { Keyboard, Wrench } from "lucide-solid";
import { toast } from "solid-sonner";
import { Button } from "~/components/ui/button";
import { shortcutEntries } from "~/maintenance/shortcutHelp";
import { emptyTrash } from "~/maintenance/ops";
import { Kbd } from "../controls";
import { BaseDirControl, LibraryControl, StorageControl, ZoteroFolderControl } from "../filesPanels";
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
	{
		id: "advanced.library", section: "advanced", group: "Files and Folders", label: "zotero-next library",
		description: "The database file this library is kept in.",
		keywords: ["database", "sqlite", "library.sqlite", "location", "path", "show in folder", "explorer"],
		control: LibraryControl,
	},
	{
		id: "advanced.zoteroDir", section: "advanced", group: "Files and Folders", label: "Zotero data folder", layout: "block",
		description: "The Zotero library zotero-next syncs with and imports from. Find Zotero looks for it in Zotero's settings and the usual places.",
		keywords: ["find zotero", "locate", "existing library", "zotero.sqlite", "database", "profile", "data directory", "browse", "validate", "import"],
		control: ZoteroFolderControl,
	},
	{
		id: "advanced.baseDir", section: "advanced", group: "Files and Folders", label: "Linked attachment base directory", layout: "block",
		description: "Store linked file paths relative to a folder so they survive a move.",
		keywords: ["linked files", "relative path", "attachments", "attachments:", "base path", "onedrive"],
		control: BaseDirControl,
	},
	{
		id: "advanced.storageDir", section: "advanced", group: "Files and Folders", label: "Attachment storage location", layout: "block",
		description: "Where imported files are kept, in a folder of your choice, optionally sorted into subfolders and stored as linked files.",
		keywords: ["data directory", "storage folder", "move", "zotmoov", "subfolder", "pattern", "author", "year", "linked files", "move attachments"],
		control: StorageControl,
	},
	{ id: "advanced.feedsUpdate", section: "advanced", group: "Feeds", label: "Update feeds automatically", keywords: ["rss", "atom", "subscriptions"], unavailable: true },
	{ id: "advanced.feedsInterval", section: "advanced", group: "Feeds", label: "Feed update interval", keywords: ["rss", "refresh", "minutes"], unavailable: true },
]);
