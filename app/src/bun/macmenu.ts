import { ApplicationMenu } from "electrobun/main";

// macOS sends Cmd+C / Cmd+V / Cmd+A and friends through the application menu, so without one they do nothing in the
// web view. Windows and Linux handle those keys in the web view itself and show no menu bar.
export function installMacMenu(): void {
	if (process.platform !== "darwin") return;
	ApplicationMenu.setApplicationMenu([
		{ label: "Zotero Next", submenu: [{ role: "about" }, { type: "divider" }, { role: "hide" }, { role: "hideOthers" }, { role: "showAll" }, { type: "divider" }, { role: "quit" }] },
		{ label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "divider" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "pasteAndMatchStyle" }, { role: "delete" }, { role: "selectAll" }] },
		{ label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "toggleFullScreen" }, { type: "divider" }, { role: "close" }, { role: "bringAllToFront" }] },
	]);
}
