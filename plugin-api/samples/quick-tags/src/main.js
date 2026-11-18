// Quick Tags: right-click items > "Quick tags...", type tags, they are added to every selected item.
// QuickJS guest. Imports are the WIT interfaces; the SDK is bundled in by plugin-api/sdk/js/scripts/build.ts.
import { definePlugin, fail, ui, ext } from "../../../sdk/js/src/index.ts";
import extend from "zinc:plugin/extend@0.1.0";
import library from "zinc:plugin/library@0.1.0";
import zui from "zinc:plugin/ui@0.1.0";
import log from "zinc:plugin/log@0.1.0";

const MENU = "quick-tags-menu";
const ENTRY = "quick-tags.add";

/** "a, b;c  ,, a" -> ["a", "b", "c"] */
function parseTags(input) {
	return [...new Set(String(input ?? "").split(/[,;\n]/).map((t) => t.trim()).filter(Boolean))];
}

function dialog(count) {
	const content = ui.form({ key: "form" },
		ui.column({ style: { gap: 2 } },
			ui.label(`Add tags to ${count} item${count === 1 ? "" : "s"}`),
			ui.textInput("", { name: "tags", placeholder: "tag one, tag two", autoFocus: true }),
			ui.caption("Separate tags with commas."),
		),
	);
	return ui.dialogSpec("Quick tags", content, [
		{ id: "cancel", label: "Cancel", role: "cancel" },
		{ id: "ok", label: "Add tags", role: "accept", isDefault: true },
	]);
}

function selectedItems(ctx) {
	// ctx.items holds at most a page of keys; ask for the rest when it was cut off
	if (!ctx.itemsTruncated) return ctx.items;
	return extend.listSelectedItems(undefined, 0, ctx.itemCount);
}

const plugin = definePlugin({
	lifecycle: {
		startup() {
			extend.registerMenu(
				ext.menu(MENU, "library-item", [
					ext.entry(ENTRY, "Quick tags...", { icon: "tag", visibleWhen: { minItems: 1 }, enabledWhen: { requireEditable: true } }),
				]),
			);
			log.write("info", "quick-tags started");
		},
	},
	extendHandlers: {
		onMenuCommand(menuId, entryId, _checked, ctx) {
			if (menuId !== MENU || entryId !== ENTRY) return;
			const items = selectedItems(ctx);
			if (!items.length) fail("invalid-argument", "no items selected");
			ui.dialog(dialog(items.length), zui).then((outcome) => {
				if (outcome.button !== "ok") return;
				const tags = parseTags(ui.fieldValue(outcome.values, "tags"));
				if (!tags.length) {
					zui.showToast(ui.toastSpec("Quick tags", "No tags entered.", "warning"));
					return;
				}
				library.apply([ext.change("add-tags", { items, tags: tags.map((name) => ({ name, kind: "manual" })) })], { skipNotify: false });
				zui.showToast(ui.toastSpec("Quick tags", `Added ${tags.length} tag${tags.length === 1 ? "" : "s"} to ${items.length} item${items.length === 1 ? "" : "s"}.`, "success"));
			});
		},
	},
});

export const { lifecycle, events, netEvents, notifierHandler, uiEvents, extendHandlers, readerEvents, noteEvents } = plugin;
