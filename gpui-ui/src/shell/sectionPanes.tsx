// Item pane sections as panes (docs/developer-guide/layouts.md, section 4.1; contract in layouts-phase2.md). CONTRACT STUB: the
// signatures below are what shell/dock.tsx and shell/PaneStack.tsx call; the "sections" agent implements them, registers the
// "section:<id>" panes and may add to this file freely.
import { sectionPaneId, type DropTarget } from "./frameLayout";
import { libraryLayout, moveLibraryPane } from "./layout";

/** Whether a section is in a pane of its own in the library (placed in the layout, whether or not hidden). */
export function isDetached(sectionId: string): boolean {
	const id = sectionPaneId(sectionId);
	return [...libraryLayout().centre.stacks, ...libraryLayout().right.stacks].some((s) => s.panes.includes(id));
}

/** Detach a section into its own pane at `to` (default: a new stack at the bottom of the right column). Undoable. */
export function detachSection(sectionId: string, to?: DropTarget): boolean {
	return moveLibraryPane(sectionPaneId(sectionId), to ?? { kind: "split", column: "right", at: libraryLayout().right.stacks.length });
}

/** Return a detached section to the item pane, before section `before` (null: last; undefined: where it was). Undoable. */
export function returnSection(sectionId: string, _before?: string | null): boolean {
	return moveLibraryPane(sectionPaneId(sectionId), { kind: "section" });
}
