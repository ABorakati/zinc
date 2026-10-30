// Registers Duplicate Items sidebar section, overlay dialog, and item context menu action.
import { createComponent } from "solid-js";
import { GitMerge } from "lucide-solid";
import { registerAppAction, registerItemAction, registerOverlay, registerSidebarSection } from "~/lib/registry";
import { DuplicateDialog, DuplicateSidebarEntry, dupState } from "./DuplicateDialog";

registerSidebarSection("duplicates", 20, () => createComponent(DuplicateSidebarEntry, {}));

registerOverlay("duplicates-dialog", () => createComponent(DuplicateDialog, {}));

registerItemAction({
	id: "duplicates.merge-items",
	label: "Merge Items…",
	icon: GitMerge,
	group: "maintain",
	visible: (ctx) => ctx.view.kind !== "trash" && ctx.keys.length >= 2,
	run: (ctx) => dupState.openMergeForKeys(ctx.keys),
});

registerAppAction({
	id: "duplicates.open-panel",
	label: "Duplicate Items…",
	icon: GitMerge,
	menu: "tools",
	run: () => dupState.openDuplicatesPanel(),
});
