// Drag to dock (docs/developer-guide/layouts.md, section 6; contract in layouts-phase2.md). CONTRACT STUB: the signatures below are
// what shell/PaneStack.tsx and shell/sectionPanes.tsx call; the "dock" agent implements them (and may add to this file freely).
import { createSignal, type Accessor, type JSX } from "solid-js";
import type { HostElement } from "@gpuix/solid";

/** What a registered element accepts when a pane is dropped on it. */
export type DropHostSpec =
	/** a stack host: its middle adds the pane as a tab, its top / bottom quarter makes a new stack above / below */
	| { kind: "stack"; column: "centre" | "right"; stack: number }
	/** an empty right column: the drop strip at the window's right edge, shown only while dragging */
	| { kind: "empty-right" }
	/** the gap before an item pane section (`before` null = after the last one): a dragged section returns to the item pane there */
	| { kind: "section-gap"; before: string | null };

/**
 * Register an element as a drop host for as long as it is mounted; returns the unregister function. `spec` is read when a drag
 * starts (stack indexes change as the layout changes). Bounds are read with ui/core.ts boundsOf at drag start.
 */
export function registerDropHost(_spec: () => DropHostSpec, _el: HostElement): () => void {
	return () => {};
}

/** The pane being dragged (its id), or null. */
const [dragged] = createSignal<string | null>(null);
export const paneDragging: Accessor<string | null> = dragged;

/**
 * Mouse handlers to spread on a drag source (a stack tab or header, an item pane section header). `id()` is the pane id to drag;
 * for an item pane section that is not detached yet, pass its future pane id ("section:<id>"). `wasDrag()` is true once right
 * after a drag ended on this source, so a click handler can ignore the trailing click (as dnd.ts dragSource).
 */
export function paneDragSource(_id: () => string): {
	onMouseDown: (e: { x?: number; y?: number; button?: number }) => void;
	onMouseMove: (e: { x?: number; y?: number; pressedButton?: number }) => void;
	onMouseUp: () => void;
	wasDrag: () => boolean;
} {
	return { onMouseDown: () => {}, onMouseMove: () => {}, onMouseUp: () => {}, wasDrag: () => false };
}

/** The pointer-capture layer, drop previews and ghost label; mounted once by shell/Frame.tsx. */
export function DockOverlay(): JSX.Element {
	return null;
}
