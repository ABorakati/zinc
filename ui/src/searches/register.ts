// Registers this feature's menu entries, dialogs and sidebar sections (see lib/registry.ts).
import { createComponent } from "solid-js";
import { SearchCode } from "lucide-solid";
import { registerAppAction, registerOverlay, registerSidebarSection } from "~/lib/registry";
import { store } from "~/store";
import { AdvancedSearchDialog } from "./AdvancedSearch";
import { QUICK_MODES } from "./QuickSearchMode";
import { SavedSearchesSection } from "./SavedSearches";
import { openAdvancedSearch } from "./state";

registerOverlay("advanced-search", () => createComponent(AdvancedSearchDialog, {}));
registerSidebarSection("saved-searches", 50, () => createComponent(SavedSearchesSection, {}));

registerAppAction({
	id: "advanced-search",
	label: "Advanced Search…",
	icon: SearchCode,
	menu: "tools",
	shortcut: "Ctrl+Shift+F",
	run: () => openAdvancedSearch(),
});

// Quick-search mode switches in Tools (the label shows which one is active).
for (const m of QUICK_MODES) {
	registerAppAction({
		id: `quick-search-${m.mode}`,
		get label() { return `${!store.fulltext() && store.qmode() === m.mode ? "✓ " : " "}Quick search: ${m.label}`; },
		menu: "tools",
		run: () => { store.setFulltext(false); store.setQMode(m.mode); },
	});
}

if (typeof document !== "undefined") {
	document.addEventListener("keydown", (e) => {
		if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
			e.preventDefault();
			openAdvancedSearch();
		}
	});
}
