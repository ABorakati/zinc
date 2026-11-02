// Shared state of the saved-searches list and the Advanced Search dialog (ui/src/searches/state.ts).
import { createSignal } from "solid-js";
import { sidebarApi, type SavedSearch } from "../sidebar/client";

const [searches, setSearches] = createSignal<SavedSearch[]>([]);
const [loaded, setLoaded] = createSignal(false);

/** The saved searches, newest changes last as the core returns them. */
export const savedSearches = searches;
/** False until the first fetch has finished. */
export const savedSearchesLoaded = loaded;

let seq = 0;
export function refreshSavedSearches(): Promise<void> {
	const my = ++seq;
	return sidebarApi.savedSearches().then(
		(l) => { if (my === seq) { setSearches(l); setLoaded(true); } },
		() => { if (my === seq) setLoaded(true); },
	);
}

/** Fetch the list once (called when the sidebar mounts, so an in-process core has started by then). */
let started = false;
export function ensureSavedSearches(): void {
	if (started) return;
	started = true;
	void refreshSavedSearches();
}
