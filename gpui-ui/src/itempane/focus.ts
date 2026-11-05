// "Open the new item's title in the editor": Zotero puts the cursor in the title of a duplicated item and of a parent item it
// just created. Features call focusTitle(key) after selecting the item; the Info section's title field opens for editing once
// that item is the one the pane shows.
import { createSignal } from "solid-js";
import { goToSection } from "./kit";

const [editFor, setEditFor] = createSignal<string | null>(null);

/** Scroll the pane to the Info section and open `key`'s title for editing (once, when that item is shown). */
export function focusTitle(key: string): void {
	setEditFor(key);
	goToSection("info");
}

/** Whether the title field of this item should be open in the editor (read reactively by the Info section). */
export const titleEditWanted = (key: string): boolean => editFor() === key;

/** The title's editor closed: the request is used up. */
export function clearTitleEdit(key: string): void {
	if (editFor() === key) setEditFor(null);
}
