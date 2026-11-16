// Find Full Text: item menu entries, the progress panel (overlay), institution sign-in / settings in Tools, and Settings > Find Full Text.
import { registerAppAction, registerItemAction, registerOverlay, registerSettingsSection } from "../../registry";
import { findFullText } from "./jobs";
import { FullTextProgress } from "./Progress";
import { FullTextSettingsSection, openFullTextSettings } from "./settings";
import { signInToInstitution } from "./signin";

const regular = (t: string) => t !== "attachment" && t !== "note" && t !== "annotation";

export function register(): void {
	registerOverlay("fulltext-progress", () => <FullTextProgress />);

	registerItemAction({
		id: "fulltext.find",
		label: "Find Full Text",
		icon: "file-search",
		group: "edit",
		visible: (ctx) => ctx.view.kind !== "trash" && regular(ctx.item.itemType),
		run: (ctx) => findFullText(ctx.keys),
	});
	registerItemAction({
		id: "fulltext.find-oa",
		label: "Find Full Text (open access only)",
		icon: "file-search",
		group: "edit",
		visible: (ctx) => ctx.view.kind !== "trash" && regular(ctx.item.itemType),
		run: (ctx) => findFullText(ctx.keys, { openAccessOnly: true }),
	});

	registerAppAction({
		id: "fulltext.signin",
		label: "Sign in to Institution…",
		icon: "log-in",
		menu: "tools",
		run: () => void signInToInstitution(),
	});
	registerAppAction({
		id: "fulltext.settings",
		label: "Find Full Text Settings…",
		icon: "file-search",
		menu: "tools",
		run: openFullTextSettings,
	});

	registerSettingsSection({
		id: "fulltext",
		label: "Find Full Text",
		icon: "file-search",
		order: 50,
		render: () => <FullTextSettingsSection />,
	});
}

export { findFullText } from "./jobs";
