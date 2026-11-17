// Maintenance: Empty Trash, Delete Permanently, Rename File from Parent Metadata, automatic-tag clean-up, Keyboard Shortcuts (Ctrl+/).
// Delete / Shift+Delete / Ctrl+A / 1–9 are list keys: the list owns their key handling and calls deleteSelected() from ./ops;
// they are listed in the help dialog here.
import { registerAppAction, registerItemAction } from "../../registry";
import { deleteAutomaticTags, deletePermanently, emptyTrash, renameFilesFromParent } from "./ops";
import { registerShortcutHelp, showShortcutHelp } from "./shortcutHelp";

export function register(): void {
	// fixed keys of the item list and the sidebar (the commands are listed with their current keys by the dialog itself)
	registerShortcutHelp([
		{
			group: "Items",
			keys: "Delete",
			description: "Move to the Trash; in a collection, remove from it; in the Trash, delete permanently",
		},
		{ group: "Items", keys: "Shift+Delete", description: "Move to the Trash without asking (from a collection too)" },
		{ group: "Items", keys: "Ctrl+A", description: "Select all items" },
		{ group: "Items", keys: "1–9", description: "Add or remove the coloured tag at that position" },
		{ group: "Navigation", keys: "Up / Down", description: "Move through the items, or the sidebar's rows" },
		{ group: "Navigation", keys: "Left / Right", description: "Close / open an item or a collection" },
		{ group: "Navigation", keys: "+ / -", description: "Expand / collapse all" },
		{ group: "Navigation", keys: "F2", description: "Rename the selected collection or saved search" },
	]);

	registerAppAction({
		id: "maintenance-empty-trash",
		label: "Empty Trash…",
		icon: "eraser",
		menu: "tools",
		run: () => void emptyTrash(),
	});
	registerAppAction({
		id: "maintenance-delete-auto-tags",
		label: "Delete Automatic Tags…",
		icon: "tags",
		menu: "tools",
		run: () => void deleteAutomaticTags(),
	});
	registerAppAction({
		id: "maintenance-shortcuts",
		label: "Keyboard Shortcuts",
		icon: "keyboard",
		menu: "tools",
		shortcut: "Ctrl+/",
		run: showShortcutHelp,
	});

	registerItemAction({
		id: "maintenance-delete-permanently",
		label: "Delete Permanently…",
		icon: "trash-2",
		group: "edit",
		visible: (ctx) => ctx.view.kind === "trash",
		run: (ctx) => void deletePermanently(ctx.keys),
	});
	registerItemAction({
		id: "maintenance-rename-files",
		label: "Rename File from Parent Metadata",
		icon: "file-pen",
		group: "maintain",
		visible: (ctx) => ctx.view.kind !== "trash" && (ctx.item.attachmentCount ?? 0) > 0,
		run: (ctx) => void renameFilesFromParent(ctx.keys),
	});
}

export { deleteAutomaticTags, deleteSelected, deleteTag, emptyTrash, renameFilesFromParent, renameTag, trashItems } from "./ops";
export { registerShortcutHelp, showShortcutHelp } from "./shortcutHelp";
