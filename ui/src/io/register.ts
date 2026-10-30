// Registers this feature's menu entries, dialogs and sidebar sections (see lib/registry.ts).
// Import (Tools > Import…, Import from Clipboard) and export (item context menu, collection menu).
import { ClipboardPaste, FileDown, FileUp } from "lucide-solid";
import { createComponent } from "solid-js";
import { registerAppAction, registerCollectionAction, registerItemAction, registerOverlay } from "~/lib/registry";
import { importFromClipboard, pickAndImport, setExportTarget } from "./client";
import { IoDialogs } from "./Dialogs";

registerOverlay("io-dialogs", () => createComponent(IoDialogs, {}));

registerAppAction({ id: "io.import", label: "Import…", icon: FileUp, menu: "tools", run: pickAndImport });
registerAppAction({ id: "io.importClipboard", label: "Import from Clipboard", icon: ClipboardPaste, menu: "tools", run: () => void importFromClipboard() });

registerItemAction({
	id: "io.export",
	label: (ctx) => (ctx.keys.length > 1 ? `Export ${ctx.keys.length} Items…` : "Export Item…"),
	icon: FileDown,
	group: "export",
	visible: (ctx) => ctx.item.itemType !== "attachment" && ctx.item.itemType !== "note",
	run: (ctx) => setExportTarget({ kind: "items", keys: ctx.keys }),
});

registerCollectionAction({
	id: "io.exportCollection",
	label: "Export Collection…",
	icon: FileDown,
	run: (ctx) => setExportTarget({ kind: "collection", collectionKey: ctx.collectionKey, name: ctx.name }),
});
