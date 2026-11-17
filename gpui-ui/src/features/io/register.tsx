// Registers import (Tools > Import…, Import from Clipboard, Import from Mendeley Desktop) and export (item context menu,
// collection menu, Settings > Export).
import { registerAppAction, registerCollectionAction, registerItemAction, registerSettingsSection } from "../../registry";
import { importFromClipboard, pickAndImport } from "./client";
import { ExportSettings, openExportDialog } from "./dialogs";
import { openMendeleyImport } from "./mendeley";

export function register(): void {
	// Zotero's keys: Ctrl+Shift+I and Ctrl+Shift+Alt+I
	registerAppAction({
		id: "io.import",
		label: "Import…",
		icon: "file-up",
		menu: "tools",
		shortcut: "Ctrl+Shift+I",
		run: () => void pickAndImport(),
	});
	registerAppAction({
		id: "io.importClipboard",
		label: "Import from Clipboard",
		icon: "clipboard-paste",
		menu: "tools",
		shortcut: "Ctrl+Alt+Shift+I",
		run: () => void importFromClipboard(),
	});
	registerAppAction({
		id: "io.importMendeley",
		label: "Import from Mendeley Desktop…",
		icon: "database",
		menu: "tools",
		run: () => void openMendeleyImport(),
	});

	registerItemAction({
		id: "io.export",
		label: (ctx) => (ctx.keys.length > 1 ? `Export ${ctx.keys.length} Items…` : "Export Item…"),
		icon: "file-down",
		group: "export",
		visible: (ctx) => ctx.item.itemType !== "attachment" && ctx.item.itemType !== "note",
		run: (ctx) => void openExportDialog({ kind: "items", keys: ctx.keys }),
	});

	registerCollectionAction({
		id: "io.exportCollection",
		label: "Export Collection…",
		icon: "file-down",
		run: (ctx) => void openExportDialog({ kind: "collection", collectionKey: ctx.collectionKey, name: ctx.name }),
	});

	registerSettingsSection({ id: "export", label: "Export", icon: "download", order: 70, render: () => <ExportSettings /> });
}
