// References: the item menu's "References…" opens the panel in a dialog. The panel component itself (ReferencesPanel) is
// exported for the item pane / reader tabs to embed.
import { registerItemAction } from "../../registry";
import { store } from "../../store";
import { selectOnly } from "../shared";
import { openReferences } from "./ReferencesPanel";

const regular = (t: string) => t !== "attachment" && t !== "note" && t !== "annotation";

export function register(): void {
	registerItemAction({
		id: "references.show",
		label: "References…",
		icon: "library",
		group: "open",
		visible: (ctx) => ctx.keys.length === 1 && regular(ctx.item.itemType),
		run: (ctx) =>
			void openReferences(ctx.item.key, (key) => {
				selectOnly(key);
				store.selectItem(key);
			}),
	});
}

export { ReferencesPanel, openReferences } from "./ReferencesPanel";
export type { ReferencesPanelProps } from "./ReferencesPanel";
