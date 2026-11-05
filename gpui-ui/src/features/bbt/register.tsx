// Better BibTeX as native features: the "Copy Citation Key" item action and the Settings section.
// (The table column is in table/defs.ts, the item pane row in itempane/Info.tsx via ./InfoRow, the export formats in io/client.ts.)
import { registerItemAction, registerSettingsSection } from "../../registry";
import { copyCitationKeys } from "./copy";
import { hasCitationKey } from "./logic";
import { BbtSettingsSection } from "./Settings";

export function register(): void {
	registerItemAction({
		id: "bbt.copy-citation-key", label: "Copy Citation Key", icon: "key-round", group: "cite",
		visible: (ctx) => hasCitationKey(ctx.item.itemType), run: (ctx) => void copyCitationKeys(ctx.keys),
	});
	registerSettingsSection({ id: "bbt", label: "Better BibTeX", icon: "book-marked", order: 61, render: () => <BbtSettingsSection /> });
}
