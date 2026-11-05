// Registers the add-items feature (ui/src/additems/register.ts): Add Item by Identifier, New Item, attachments (stored file /
// linked file / link), notes, Duplicate Item, Retrieve Metadata for PDF, Create Parent Item. Window-level file drops and Ctrl+V
// "paste an identifier" in the list are handled directly by handleFileDrop and listKeyHandler.
import { registerAppAction, registerItemAction, registerOverlay } from "../../registry";
import { createNote, duplicateItems, pickAndImport, retrieveMetadata } from "./client";
import { openIdentifierDialog, openLinkFileDialog, openLinkUriDialog, openNewItemDialog } from "./dialogs";
import { openCreateParentDialog } from "./parent";
import { RetrievePanel } from "./RetrievePanel";

const isRegular = (t: string) => t !== "attachment" && t !== "note" && t !== "annotation";
const single = (ctx: { keys: string[]; item: { itemType: string } }) => ctx.keys.length === 1 && isRegular(ctx.item.itemType);

export function register(): void {
	registerOverlay("additems-retrieve-panel", () => <RetrievePanel />);

	registerAppAction({ id: "add.identifier", label: "Add Item by Identifier…", icon: "wand-sparkles", menu: "add", shortcut: "Ctrl+Shift+I", run: () => void openIdentifierDialog() });
	registerAppAction({ id: "add.newItem", label: "New Item…", icon: "file-plus", menu: "add", shortcut: "Ctrl+Shift+N", run: () => void openNewItemDialog() });
	registerAppAction({ id: "add.note", label: "New Standalone Note", icon: "sticky-note", menu: "add", run: () => void createNote() });
	registerAppAction({ id: "add.storedFile", label: "Add Attachment: Stored File…", icon: "paperclip", menu: "add", run: () => void pickAndImport() });
	registerAppAction({ id: "add.linkFile", label: "Add Attachment: Link to File…", icon: "link", menu: "add", run: () => void openLinkFileDialog() });
	registerAppAction({ id: "add.linkUri", label: "Add Attachment: Link to URI…", icon: "link", menu: "add", run: () => void openLinkUriDialog() });

	registerItemAction({ id: "add.childNote", label: "Add Note", icon: "sticky-note", group: "edit", visible: single, run: (ctx) => void createNote(ctx.item.key) });
	registerItemAction({ id: "add.attachFile", label: "Stored File…", submenu: "Add Attachment", icon: "paperclip", group: "edit", visible: single, run: (ctx) => void pickAndImport(ctx.item.key) });
	registerItemAction({ id: "add.attachLinkFile", label: "Link to File…", submenu: "Add Attachment", icon: "link", group: "edit", visible: single, run: (ctx) => void openLinkFileDialog(ctx.item.key) });
	registerItemAction({ id: "add.attachLinkUri", label: "Link to URI…", submenu: "Add Attachment", icon: "link", group: "edit", visible: single, run: (ctx) => void openLinkUriDialog(ctx.item.key) });
	registerItemAction({
		id: "add.duplicate",
		label: (ctx) => (ctx.keys.length > 1 ? "Duplicate Items" : "Duplicate Item"),
		icon: "copy",
		group: "edit",
		// Zotero duplicates top-level items only (the list shows nothing else); the trash keeps its own menu.
		visible: (ctx) => ctx.view.kind !== "trash",
		run: (ctx) => void duplicateItems(ctx.keys),
	});
	registerItemAction({
		id: "add.retrieveMetadata",
		label: "Retrieve Metadata for PDF",
		icon: "file-search",
		group: "maintain",
		// standalone attachments only; non-PDFs among them are filtered out when it runs (the item row does not carry the content type)
		visible: (ctx) => ctx.view.kind !== "trash" && ctx.item.itemType === "attachment",
		run: (ctx) => void retrieveMetadata(ctx.keys),
	});
	registerItemAction({
		id: "add.createParent",
		label: "Create Parent Item…",
		icon: "corner-up-left",
		group: "maintain",
		// a standalone attachment or note (a child item's parent already exists)
		visible: (ctx) => ctx.view.kind !== "trash" && ctx.keys.length === 1 && (ctx.item.itemType === "attachment" || ctx.item.itemType === "note"),
		run: (ctx) => void openCreateParentDialog(ctx.item.key),
	});
}
export { addByIdentifier, handleFileDrop } from "./client";
