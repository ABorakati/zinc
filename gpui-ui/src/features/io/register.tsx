// Registers import (Tools > Import…, Import from Clipboard) and export (item context menu, collection menu, Settings > Export).
import { registerAppAction, registerCollectionAction, registerItemAction, registerSettingsSection } from "../../registry";
import { importFromClipboard, pickAndImport } from "./client";
import { ExportSettings, openExportDialog } from "./dialogs";

export function register(): void {
	registerAppAction({ id: "io.import", label: "Import…", icon: "file-up", menu: "tools", run: () => void pickAndImport() });
	registerAppAction({ id: "io.importClipboard", label: "Import from Clipboard", icon: "clipboard-paste", menu: "tools", run: () => void importFromClipboard() });

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
