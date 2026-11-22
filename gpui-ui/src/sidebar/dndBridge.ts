// Item drag-and-drop from the list (src/dnd.ts, owned by the list): collections accept the dragged items as drops.
// GPUIX gives a pointer capture to any element with both onMouseDown and onMouseMove, so while the list's drag source is held
// the drop targets get no enter / leave / up events. The source does report every move (dragPoint) and ends the drag on
// release (dragging() -> null), so the sidebar hit-tests by coordinates: hover = the last point, drop = the drag ending there.
import { dragging, dragOutcome, dragPoint } from "../dnd";

export interface ItemDragPayload {
	keys: string[];
}

/** The items currently being dragged out of the list, or null. */
export const itemDrag = (): ItemDragPayload | null => {
	const d = dragging();
	return d && d.kind === "items" ? d : null;
};

/** True when the drag that just ended was dropped in the window (not cancelled, not handed to the OS). */
export const itemDragDropped = (): boolean => dragOutcome() === "dropped";

/** Last pointer position (window px) reported by the drag source, or null. */
export const itemDragPoint = (): { x: number; y: number } | null => dragPoint();
