// Maintenance: Empty Trash, Delete Permanently, Rename File from Parent Metadata, automatic-tag clean-up, Keyboard Shortcuts (Ctrl+/).
// Delete / Shift+Delete / Ctrl+A / Ctrl+F are plain-key or list shortcuts: the list owns their key handling and calls
// deleteSelected() from ./ops; they are listed in the help dialog here.
import { registerAppAction, registerItemAction } from "../../registry";
import { deleteAutomaticTags, deletePermanently, emptyTrash, renameFilesFromParent } from "./ops";
import { registerShortcutHelp, showShortcutHelp } from "./shortcutHelp";

export function register(): void {
	registerShortcutHelp([
		{ group: "Items", keys: "Ctrl+Shift+N", description: "New item" },
		{ group: "Items", keys: "Ctrl+Shift+I", description: "Add item by identifier" },
		{ group: "Items", keys: "Ctrl+Shift+C", description: "Copy bibliography of the selected items" },
		{ group: "Items", keys: "Ctrl+Shift+A", description: "Copy citation of the selected items" },
		{ group: "Items", keys: "Delete", description: "Move selected items to the Trash (permanently delete in the Trash)" },
		{ group: "Items", keys: "Shift+Delete", description: "Delete selected items permanently" },
		{ group: "Items", keys: "Ctrl+A", description: "Select all items" },
		{ group: "Navigation", keys: "Ctrl+F", description: "Search the library" },
		{ group: "Navigation", keys: "Ctrl+Shift+L", description: "Focus the collections pane" },
		{ group: "Navigation", keys: "+", description: "Expand all collections" },
		{ group: "Navigation", keys: "-", description: "Collapse all collections" },
		{ group: "Navigation", keys: "Ctrl+W", description: "Close the current tab" },
		{ group: "General", keys: "Ctrl+/", description: "Show keyboard shortcuts" },
	]);

	registerAppAction({ id: "maintenance-empty-trash", label: "Empty Trash…", icon: "eraser", menu: "tools", run: () => void emptyTrash() });
	registerAppAction({ id: "maintenance-delete-auto-tags", label: "Delete Automatic Tags…", icon: "tags", menu: "tools", run: () => void deleteAutomaticTags() });
	registerAppAction({ id: "maintenance-shortcuts", label: "Keyboard Shortcuts", icon: "keyboard", menu: "tools", shortcut: "Ctrl+/", run: showShortcutHelp });

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
