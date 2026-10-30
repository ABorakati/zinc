// Shared state for the advanced-search dialog and the saved-searches list.
import { createResource, createRoot, createSignal } from "solid-js";
import { api, type SavedSearch } from "~/api";

const [rev, setRev] = createSignal(0);

export const savedSearches = createRoot(() =>
	createResource(rev, () => api.savedSearches().catch((): SavedSearch[] => [])),
)[0];

export const refreshSavedSearches = () => setRev((n) => n + 1);

export const [dialogOpen, setDialogOpen] = createSignal(false);
/** Key of the saved search being edited, or null for a fresh advanced search. */
export const [editKey, setEditKey] = createSignal<string | null>(null);

export function openAdvancedSearch(editing?: string) {
	setEditKey(editing ?? null);
	setDialogOpen(true);
}
