// Persisted sidebar UI state, kept in the shared ui-state.json through store.ts's uiState (%APPDATA%\zotero-next-gpui\ui-state.json;
// ZN_UI_STATE redirects it). Every key of this module starts with "sidebar.".
import { createSignal, type Accessor } from "solid-js";
import { uiState } from "../store";

/** A signal backed by one key of ui-state.json. `valid` rejects stored values of the wrong shape. */
export function persisted<T>(key: string, fallback: T, valid: (v: unknown) => v is T): [Accessor<T>, (v: T) => void] {
	const stored = uiState.get<unknown>(key, undefined);
	const [get, set] = createSignal<T>(stored !== undefined && valid(stored) ? stored : fallback);
	return [get, (v) => { set(() => v); uiState.set(key, v); }];
}

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isFraction = (v: unknown): v is number => typeof v === "number" && v > 0.1 && v < 0.9;

/** Width (px) of the sidebar, from its onLayout (0 until the first layout): rows clip their one-line labels to it (clip.ts). */
export const [sidebarWidth, setSidebarWidth] = createSignal(0);

/** Sections (ui/src/sidebar.tsx sectionOpen): Library and Collections open, Tags closed. */
export const [libraryOpen, setLibraryOpen] = persisted("sidebar.library", true, isBool);
export const [collectionsOpen, setCollectionsOpen] = persisted("sidebar.collections", true, isBool);
export const [tagsOpen, setTagsOpen] = persisted("sidebar.tags", false, isBool);
/** Expanded collection keys. */
export const [expandedKeys, setExpandedKeys] = persisted<string[]>("sidebar.expanded", [], isStrings);
/** Height fraction of the collections pane while the tags pane is open (web UI: flex 3 : 2 = 0.6). */
export const [collectionsFraction, setCollectionsFraction] = persisted("sidebar.split", 0.6, isFraction);
/** Tag selector: show tags added automatically (ui/src/settings/prefs.ts showAutoTags). */
export const [showAutoTags, setShowAutoTags] = persisted("sidebar.showAutomaticTags", true, isBool);
