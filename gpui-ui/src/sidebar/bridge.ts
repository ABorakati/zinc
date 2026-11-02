// The sidebar's view of the shared store (ListStore: view / tag filter / refresh).
import type { Collection, View } from "../contracts";
import { store } from "../store";

/** The view the item list shows. */
export const currentView = (): View => store.view();
export const setView = (v: View): void => store.setView(v);

/** Tags the list is filtered by (several AND together). */
export const tagFilter = (): string[] => store.tagFilter();
export const setTagFilter = (tags: string[]): void => store.setTagFilter(tags);

/** Re-fetch collections + the list after a change. */
export const refreshStore = (): void => store.refresh();

/** The store's collection tree. */
export const storeCollections = (): Collection[] => store.collections();
