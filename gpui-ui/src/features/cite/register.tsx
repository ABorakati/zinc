// Citations and bibliographies: Quick Copy (Ctrl+Shift+C / Ctrl+Shift+A), Create Bibliography dialogs, style settings.
import { api } from "../../api";
import { registerAppAction, registerCollectionAction, registerItemAction, registerSettingsSection } from "../../registry";
import { plural } from "../text";
import { selectedKeys } from "../shared";
import { CiteSettingsSection, openBibliography, openCiteSettings, quickCopy } from "./dialogs";

async function collectionKeys(collectionKey: string): Promise<string[]> {
	const keys: string[] = [];
	const q = { collection: collectionKey, sort: "creator", dir: "asc" as const };
	for (let offset = 0; ; offset += 1000) {
		const page = await api.items(q, offset, 1000);
		keys.push(...page.items.map((i) => i.key));
		if (keys.length >= page.total || page.items.length === 0) break;
	}
	return keys;
}

export function register(): void {
	registerItemAction({ id: "cite.copy-bibliography", label: "Copy Bibliography", icon: "clipboard-copy", group: "cite", shortcut: "Ctrl+Shift+C", run: (ctx) => void quickCopy(ctx.keys, "bibliography") });
	registerItemAction({ id: "cite.copy-citation", label: "Copy Citation", icon: "quote", group: "cite", shortcut: "Ctrl+Shift+A", run: (ctx) => void quickCopy(ctx.keys, "citation") });
	registerItemAction({
		id: "cite.create-bibliography",
		label: "Create Bibliography from Items…",
		icon: "book-marked",
		group: "cite",
		run: (ctx) => void openBibliography(plural(ctx.keys.length, "selected item"), ctx.keys),
	});

	registerCollectionAction({
		id: "cite.create-bibliography-collection",
		label: "Create Bibliography from Collection…",
		icon: "book-marked",
		run: (ctx) => void openBibliography(`Collection "${ctx.name}"`, () => collectionKeys(ctx.collectionKey)),
	});

	registerAppAction({ id: "cite.settings", label: "Citation Style Settings…", icon: "settings-2", menu: "tools", run: () => void openCiteSettings(selectedKeys().slice(0, 3)) });

	// The keyboard shortcuts act on the selection (the shell binds an app action's shortcut globally).
	registerAppAction({ id: "cite.shortcut-bibliography", label: "Copy Bibliography", menu: "none", shortcut: "Ctrl+Shift+C", run: () => void quickCopy(selectedKeys(), "bibliography") });
	registerAppAction({ id: "cite.shortcut-citation", label: "Copy Citation", menu: "none", shortcut: "Ctrl+Shift+A", run: () => void quickCopy(selectedKeys(), "citation") });

	registerSettingsSection({ id: "cite", label: "Cite", icon: "quote", order: 60, render: () => <CiteSettingsSection /> });
}
