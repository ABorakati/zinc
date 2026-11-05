// Zotero's Locate submenu, shared by the item context menu and the item pane's More menu. The opener and the reveal call
// are injected so each surface keeps using its own existing helpers (cards/actions vs itempane/actions).
import type { MenuItem } from "../ui";
import { engineUrl } from "./engines";
import { enabledEngines } from "./engines-store";
import { buildOpenUrl, googleScholarUrl, viewOnlineUrl, type LocateItem } from "./openurl";
import { openUrlResolver } from "./prefs";

export interface LocateActions {
	/** openLink / openUrl of the calling surface (the core's POST /api/open-url). */
	openUrl(url: string): void;
	/** revealAttachment / ipApi.reveal: show the attachment's file in Explorer. */
	revealFile(attachmentKey: string): void;
}

/**
 * The built-in entries, always present: an entry that does not apply (no URL, no resolver, no file, no title) is disabled
 * rather than hidden, as Zotero's Locate menu. The user's enabled engines (Settings > General > Locate) follow after a divider.
 */
export function locateMenu(item: LocateItem, attachmentKey: string | null, actions: LocateActions): MenuItem[] {
	const online = viewOnlineUrl(item);
	const lookup = buildOpenUrl(item, openUrlResolver());
	const scholar = googleScholarUrl(item.title);
	const extra = enabledEngines();
	// Zotero's default engine IS Google Scholar: while it is enabled it stands in for the built-in entry instead of repeating it
	const scholarEngine = extra.some((e) => e.name.toLowerCase() === "google scholar");
	const entries: MenuItem[] = [
		{ label: "View Online", icon: "globe", disabled: !online, onSelect: () => { if (online) actions.openUrl(online); } },
		{ label: "Library Lookup", icon: "library", disabled: !lookup, onSelect: () => { if (lookup) actions.openUrl(lookup); } },
		...(scholarEngine ? [] : [{ label: "Search Google Scholar", icon: "graduation-cap", disabled: !scholar, onSelect: () => { if (scholar) actions.openUrl(scholar); } }]),
		{ label: "Show File", icon: "folder-open", disabled: !attachmentKey, onSelect: () => { if (attachmentKey) actions.revealFile(attachmentKey); } },
	];
	if (!extra.length) return entries;
	// an engine the item cannot fill in (no title ...) is disabled, not hidden
	return [
		...entries,
		{ separator: true },
		...extra.map((e): MenuItem => {
			const url = engineUrl(e, item);
			return { label: e.name, icon: "search", disabled: !url, onSelect: () => { if (url) actions.openUrl(url); } };
		}),
	];
}
