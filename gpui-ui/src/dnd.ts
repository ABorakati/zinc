// Drag payload store shared by item drags and pane docking.
//
// GPUIX has no HTML5 drag-and-drop, so a drag is a mouse gesture: a card / table row calls startDrag() once the pointer has
// moved a few pixels with the left button held (see dragSource() below), and any element can react to it:
//
//   - a drop target highlights while `dragging()` is set and the pointer is over it (onMouseEnter / onMouseLeave), and on
//     onMouseUp reads `dragging()`, handles it and calls endDrag();
//   - the list ends the drag itself when the button is released over a non-target, or on Escape.
//
// Coordinate only through this file's API.
import { createSignal } from "solid-js";

export type DragPayload = { kind: "items"; keys: string[] } | { kind: "pane"; id: string };

const [dragging, setDragging] = createSignal<DragPayload | null>(null);
/** Last pointer position (window px) reported by the drag source while a drag is active, for ghost labels. */
const [dragPoint, setDragPoint] = createSignal<{ x: number; y: number } | null>(null);

/** The active drag, or null. */
export { dragging, dragPoint };

/**
 * Observer of the drag's life, installed by features/cite/dragout.ts: when the pointer leaves the window with items held, that file
 * hands the drag to the OS (Quick Copy text dropped into other apps). In-app drags (onto collections) never involve it.
 */
export interface DragHook {
	start(payload: DragPayload): void;
	end(): void;
}
let hook: DragHook | undefined;
export const setDragHook = (h: DragHook | undefined): void => {
	hook = h;
};

/** Begin a drag (no-op for an empty item list). */
export function startDrag(payload: DragPayload): void {
	if (payload.kind === "items" && payload.keys.length === 0) return;
	setDragging(payload.kind === "items" ? { kind: "items", keys: [...payload.keys] } : { kind: "pane", id: payload.id });
	hook?.start(payload);
}

/** End the drag (drop handled, released over nothing, or cancelled). */
export function endDrag(): void {
	setDragging(null);
	setDragPoint(null);
	hook?.end();
}

/** Called by drag sources on every mouse move while dragging. */
export function moveDrag(x: number, y: number): void {
	if (dragging()) setDragPoint({ x, y });
}

/** Label for a ghost / tooltip. Pane docking resolves its title from the pane registry. */
export function dragLabel(d: DragPayload | null = dragging()): string {
	if (!d) return "";
	if (d.kind === "pane") return d.id;
	return `${d.keys.length} ${d.keys.length === 1 ? "item" : "items"}`;
}

/** Pixels the pointer must travel with the button held before a press becomes a drag. */
export const DRAG_THRESHOLD = 5;

interface PressEvent {
	x?: number;
	y?: number;
	button?: number;
	pressedButton?: number;
}

/**
 * Helper for drag sources: returns mouse handlers to spread on a row.
 *   `keys()` supplies the keys to drag when the gesture turns into a drag (return [] to veto).
 *   `onStart` runs once when the drag begins (e.g. to add the row to the selection).
 * `wasDrag()` is true right after a drag ended on this source so its click handler can ignore the trailing click.
 */
export function dragSource(keys: () => string[], onStart?: () => void) {
	let press: { x: number; y: number } | null = null;
	let justDragged = false;
	return {
		onMouseDown(e: PressEvent) {
			if ((e.button ?? 0) !== 0) return;
			press = { x: e.x ?? 0, y: e.y ?? 0 };
		},
		onMouseMove(e: PressEvent) {
			if (dragging()?.kind === "pane") return;
			if (dragging()?.kind === "items") {
				moveDrag(e.x ?? 0, e.y ?? 0);
				if (e.pressedButton === undefined) endDrag();
				return;
			}
			if (!press) return;
			if (e.pressedButton !== 0) {
				press = null;
				return;
			}
			if (Math.hypot((e.x ?? 0) - press.x, (e.y ?? 0) - press.y) < DRAG_THRESHOLD) return;
			press = null;
			onStart?.();
			const k = keys();
			if (k.length) {
				startDrag({ kind: "items", keys: k });
				justDragged = true;
			}
		},
		onMouseUp() {
			press = null;
			if (dragging()?.kind === "items") endDrag();
		},
		/** true once after a drag that started on this source */
		wasDrag(): boolean {
			const v = justDragged;
			justDragged = false;
			return v;
		},
	};
}
