// Registers this feature's menu entries, dialogs and sidebar sections (see lib/registry.ts).
// Add Item by Identifier, New Item, attachments (stored file / linked file / link), notes, Retrieve Metadata for PDF,
// plus window-level drag-and-drop of files and paste of identifiers.
import { FilePlus, FileSearch, Link, Paperclip, StickyNote, WandSparkles } from "lucide-solid";
import { createComponent } from "solid-js";
import { toast } from "solid-sonner";
import { registerAppAction, registerItemAction, registerOverlay } from "~/lib/registry";
import { AddItemsDialogs } from "./Dialogs";
import { createNote, dialog, importFiles, looksLikeIdentifiers, pickFiles, retrieveMetadata, setDialog } from "./client";

registerOverlay("additems-dialogs", () => createComponent(AddItemsDialogs, {}));

const openIdentifier = (text?: string) => setDialog({ kind: "identifier", text });

registerAppAction({ id: "add.identifier", label: "Add Item by Identifier…", icon: WandSparkles, menu: "add", shortcut: "Ctrl+Shift+I", run: () => openIdentifier() });
registerAppAction({ id: "add.newItem", label: "New Item…", icon: FilePlus, menu: "add", shortcut: "Ctrl+Shift+N", run: () => setDialog({ kind: "newItem" }) });
registerAppAction({ id: "add.note", label: "New Standalone Note", icon: StickyNote, menu: "add", run: () => void createNote() });
registerAppAction({ id: "add.storedFile", label: "Add Attachment: Stored File…", icon: Paperclip, menu: "add", run: () => pickFiles((f) => void importFiles(f)) });
registerAppAction({ id: "add.linkFile", label: "Add Attachment: Link to File…", icon: Link, menu: "add", run: () => setDialog({ kind: "linkFile" }) });
registerAppAction({ id: "add.linkUri", label: "Add Attachment: Link to URI…", icon: Link, menu: "add", run: () => setDialog({ kind: "linkUri" }) });

const isRegular = (t: string) => t !== "attachment" && t !== "note" && t !== "annotation";
const single = (ctx: { keys: string[]; item: { itemType: string } }) => ctx.keys.length === 1 && isRegular(ctx.item.itemType);

registerItemAction({ id: "add.attachFile", label: "Add Attachment: Stored File…", icon: Paperclip, group: "edit", visible: single, run: (ctx) => pickFiles((f) => void importFiles(f, { parentKey: ctx.item.key })) });
registerItemAction({ id: "add.attachLinkFile", label: "Add Attachment: Link to File…", icon: Link, group: "edit", visible: single, run: (ctx) => setDialog({ kind: "linkFile", parentKey: ctx.item.key }) });
registerItemAction({ id: "add.attachLinkUri", label: "Add Attachment: Link to URI…", icon: Link, group: "edit", visible: single, run: (ctx) => setDialog({ kind: "linkUri", parentKey: ctx.item.key }) });
registerItemAction({ id: "add.childNote", label: "Add Note", icon: StickyNote, group: "edit", visible: single, run: (ctx) => void createNote(ctx.item.key) });
registerItemAction({
	id: "add.retrieveMetadata",
	label: "Retrieve Metadata for PDF",
	icon: FileSearch,
	group: "maintain",
	visible: (ctx) => ctx.item.itemType === "attachment",
	run: (ctx) => void retrieveMetadata(ctx.keys),
});

// ---------------------------------------------------------------- window-level listeners

const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
const inEditable = (el: Element | null) => !!el && (el.matches("input, textarea, select, [contenteditable=''], [contenteditable='true']") || !!(el as HTMLElement).isContentEditable);

if (typeof window !== "undefined") {
	window.addEventListener("dragover", (e) => {
		if (!hasFiles(e)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
	});
	window.addEventListener("drop", (e) => {
		if (!hasFiles(e)) return;
		e.preventDefault();
		const files = [...(e.dataTransfer?.files ?? [])];
		if (files.length) void importFiles(files);
	});

	window.addEventListener("paste", (e) => {
		if (inEditable(document.activeElement) || dialog()) return;
		const text = e.clipboardData?.getData("text/plain") ?? "";
		if (!looksLikeIdentifiers(text)) return;
		e.preventDefault();
		toast("Identifier on the clipboard", {
			description: text.trim().length > 80 ? text.trim().slice(0, 80) + "…" : text.trim(),
			duration: 8000,
			action: { label: "Add by identifier", onClick: () => openIdentifier(text.trim()) },
		});
	});

	window.addEventListener("keydown", (e) => {
		if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === "i") {
			e.preventDefault();
			openIdentifier();
		}
	});
	// Ctrl+Shift+N (maintenance/shortcuts.ts) asks for a new item.
	window.addEventListener("zn:new-item", () => setDialog({ kind: "newItem" }));
}
