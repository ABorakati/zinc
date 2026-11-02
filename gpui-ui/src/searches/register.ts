// Registers the searches feature's app action (src/features.ts calls register() once). The saved-searches list itself is drawn
// by Sidebar.tsx inside the Library group, so no sidebar section is registered here.
import { registerAppAction } from "../registry";
import { openAdvancedSearch } from "./AdvancedSearch";

export function register(): void {
	registerAppAction({
		id: "advanced-search",
		label: "Advanced Search…",
		icon: "search-code",
		menu: "tools",
		shortcut: "Ctrl+Shift+F",
		run: () => void openAdvancedSearch(),
	});
}
