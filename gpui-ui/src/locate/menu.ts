// Zotero's Locate submenu, shared by the item context menu and the item pane's More menu. The opener and the reveal call
// are injected so each surface keeps using its own existing helpers (cards/actions vs itempane/actions).
import type { MenuItem } from "../ui";
import { buildOpenUrl, googleScholarUrl, viewOnlineUrl, type LocateItem } from "./openurl";
import { openUrlResolver } from "./prefs";

export interface LocateActions {
	/** openLink / openUrl of the calling surface (the core's POST /api/open-url). */
	openUrl(url: string): void;
	/** revealAttachment / ipApi.reveal: show the attachment's file in Explorer. */
	revealFile(attachmentKey: string): void;
}

/**
 * The four entries, always present: an entry that does not apply (no URL, no resolver, no file, no title) is disabled
 * rather than hidden, as Zotero's Locate menu.
 */
export function locateMenu(item: LocateItem, attachmentKey: string | null, actions: LocateActions): MenuItem[] {
	const online = viewOnlineUrl(item);
	const lookup = buildOpenUrl(item, openUrlResolver());
	const scholar = googleScholarUrl(item.title);
	return [
		{ label: "View Online", icon: "globe", disabled: !online, onSelect: () => { if (online) actions.openUrl(online); } },
		{ label: "Library Lookup", icon: "library", disabled: !lookup, onSelect: () => { if (lookup) actions.openUrl(lookup); } },
		{ label: "Search Google Scholar", icon: "graduation-cap", disabled: !scholar, onSelect: () => { if (scholar) actions.openUrl(scholar); } },
		{ label: "Show File", icon: "folder-open", disabled: !attachmentKey, onSelect: () => { if (attachmentKey) actions.revealFile(attachmentKey); } },
	];
}
