// Registers this feature's menu entries, dialogs and sidebar sections (see lib/registry.ts).
import { Eraser, FilePen, Keyboard, Trash2 } from "lucide-solid";
import { registerAppAction, registerItemAction, registerOverlay } from "~/lib/registry";
import { ConfirmDialog, PromptDialog, ShortcutsDialog } from "./dialogs";
import { deletePermanently, emptyTrash, renameFilesFromParent } from "./ops";
import { installShortcuts } from "./shortcuts";
import { setHelpOpen } from "./shortcutHelp";

registerOverlay("maintenance-confirm", () => ConfirmDialog({}));
registerOverlay("maintenance-prompt", () => PromptDialog({}));
registerOverlay("maintenance-shortcuts", () => ShortcutsDialog({}));

registerAppAction({ id: "maintenance-empty-trash", label: "Empty Trash…", icon: Eraser, menu: "tools", run: () => void emptyTrash() });
registerAppAction({
	id: "maintenance-shortcuts", label: "Keyboard Shortcuts", icon: Keyboard, menu: "tools", shortcut: "Ctrl+/",
	run: () => setHelpOpen(true),
});

registerItemAction({
	id: "maintenance-delete-permanently",
	label: "Delete Permanently…",
	icon: Trash2,
	group: "edit",
	visible: (ctx) => ctx.view.kind === "trash",
	run: (ctx) => void deletePermanently(ctx.keys),
});

registerItemAction({
	id: "maintenance-rename-files",
	label: "Rename File from Parent Metadata",
	icon: FilePen,
	group: "maintain",
	visible: (ctx) => ctx.view.kind !== "trash" && ctx.item.attachmentCount > 0,
	run: (ctx) => void renameFilesFromParent(ctx.keys),
});

installShortcuts();
