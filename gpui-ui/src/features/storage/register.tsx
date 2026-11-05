// Attachment storage (ZotMoov): the item menu's "Attachment Files" submenu. Settings: Files and folders > Attachment storage
// location (src/settings/defs/files.tsx and files-storage.tsx). Server side: core/src/files/{storage,organize}.ts.
//   Move to / Copy to Storage Folder   per the move-or-copy setting, into the folder and subfolder pattern chosen there
//   Move to Folder… / Copy to Folder…  the same into a folder picked now
//   Convert to Stored File             linked files become stored files in the library's own storage
//   Attach Newest File from <folder>   the newest file of the "attach from" folder becomes an attachment of the item
import { registerItemAction, type ItemActionContext } from "../../registry";
import { attachNewest, organize, organizeToFolder } from "./ops";
import { refreshStorage, storage } from "./state";
import { attachNewestLabel } from "./summary";

const SUB = "Attachment Files";
const regular = (t: string) => t !== "attachment" && t !== "note" && t !== "annotation";
const hasFiles = (ctx: ItemActionContext) => ctx.view.kind !== "trash" && (ctx.item.attachmentCount ?? 0) > 0;
const copying = () => storage()?.behavior === "copy";

export function register(): void {
	void refreshStorage();
	registerItemAction({
		id: "storage.moveToStorage",
		label: () => (copying() ? "Copy to Storage Folder" : "Move to Storage Folder"),
		icon: "folder-input",
		group: "maintain",
		submenu: SUB,
		visible: (ctx) => hasFiles(ctx) && !!storage()?.dir,
		run: (ctx) => void organize(ctx.keys, copying() ? "copy" : "move"),
	});
	registerItemAction({
		id: "storage.moveToFolder",
		label: "Move to Folder…",
		icon: "folder-output",
		group: "maintain",
		submenu: SUB,
		visible: hasFiles,
		run: (ctx) => void organizeToFolder(ctx.keys, "move"),
	});
	registerItemAction({
		id: "storage.copyToFolder",
		label: "Copy to Folder…",
		icon: "copy",
		group: "maintain",
		submenu: SUB,
		visible: hasFiles,
		run: (ctx) => void organizeToFolder(ctx.keys, "copy"),
	});
	registerItemAction({
		id: "storage.convertToStored",
		label: "Convert to Stored File",
		icon: "paperclip",
		group: "maintain",
		submenu: SUB,
		visible: hasFiles,
		run: (ctx) => void organize(ctx.keys, "to-stored"),
	});
	registerItemAction({
		id: "storage.attachNewest",
		label: () => attachNewestLabel(storage()?.attachDir),
		icon: "file-down",
		group: "maintain",
		submenu: SUB,
		visible: (ctx) => ctx.view.kind !== "trash" && ctx.keys.length === 1 && regular(ctx.item.itemType) && !!storage()?.attachDir,
		run: (ctx) => void attachNewest(ctx.item.key),
	});
}
