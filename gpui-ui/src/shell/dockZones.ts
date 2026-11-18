// Drop zones for drag to dock (layouts.md, section 6). Pure TS, no UI runtime imports, so it is unit tested on its own
// (dockZones.test.ts). shell/dock.tsx reads the registered hosts' bounds at drag start and hit-tests the pointer against these.
import type { DropTarget } from "./frameLayout";

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** What a registered element accepts when a pane is dropped on it (same shape as dock.tsx registerDropHost). */
export type DropHostSpec =
	/** a stack host: its middle adds the pane as a tab, its top / bottom quarter makes a new stack above / below */
	| { kind: "stack"; column: "centre" | "right"; stack: number }
	/** an empty right column: the drop strip at the window's right edge, shown only while dragging */
	| { kind: "empty-right" }
	/** the gap before an item pane section (`before` null = after the last one): a dragged section returns to the item pane there */
	| { kind: "section-gap"; before: string | null };

export interface DockZone {
	/** window coordinates, clipped to the window */
	rect: Rect;
	target: DropTarget;
	/** the kind of host the zone came from (tells the empty-right strip apart without looking at geometry) */
	hostKind: DropHostSpec["kind"];
	/** only for section gaps: the section the pane goes before (null = last) */
	before?: string | null;
}

/** Width of the empty-right drop strip at the window's right edge. */
export const EMPTY_RIGHT_STRIP = 48;

/** `r` cut to the window; null when nothing is left. */
function clip(r: Rect, win: { width: number; height: number }): Rect | null {
	const x0 = Math.max(r.x, 0);
	const y0 = Math.max(r.y, 0);
	const x1 = Math.min(r.x + r.width, win.width);
	const y1 = Math.min(r.y + r.height, win.height);
	if (!(x1 > x0) || !(y1 > y0)) return null;
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * The drop zones for the registered hosts, in priority order: section gaps, then the empty-right strip, then stacks (each group
 * keeps registration order). Section gaps exist only when `section` is true (a section pane is being dragged). A stack host
 * gives three zones from its original bounds: the top quarter splits at `stack`, the bottom quarter splits at `stack + 1`, the
 * middle half adds a tab. Every zone is clipped to the window. Stack and section-gap hosts with unusable bounds (not finite, or no
 * size) give none. An empty-right host needs no bounds (its column is display:none): registering it is enough for the strip.
 */
export function createDockZones(
	hosts: readonly { spec: DropHostSpec; bounds: Rect }[],
	window: { width: number; height: number },
	section: boolean,
): DockZone[] {
	if (!Number.isFinite(window.width) || !Number.isFinite(window.height) || window.width <= 0 || window.height <= 0) return [];
	const gaps: DockZone[] = [];
	const edge: DockZone[] = [];
	const stacks: DockZone[] = [];
	let strip = false;
	for (const { spec, bounds: b } of hosts) {
		if (spec.kind === "empty-right") {
			// the empty column is display:none, so it has no painted bounds: registration alone gives the strip
			strip = true;
			continue;
		}
		const sized = Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.width) && Number.isFinite(b.height);
		if (!sized || b.width <= 0 || b.height <= 0) continue;
		if (spec.kind === "section-gap") {
			if (!section) continue;
			const rect = clip(b, window);
			if (rect) gaps.push({ rect, target: { kind: "section" }, hostKind: "section-gap", before: spec.before });
		} else {
			const { column, stack } = spec;
			const q = b.height / 4;
			const bands: [number, number, DropTarget][] = [
				[b.y, q, { kind: "split", column, at: stack }],
				[b.y + q, b.height - 2 * q, { kind: "tab", column, stack }],
				[b.y + b.height - q, q, { kind: "split", column, at: stack + 1 }],
			];
			for (const [y, height, target] of bands) {
				const rect = clip({ x: b.x, y, width: b.width, height }, window);
				if (rect) stacks.push({ rect, target, hostKind: "stack" });
			}
		}
	}
	if (strip) {
		const rect = clip({ x: window.width - EMPTY_RIGHT_STRIP, y: 0, width: EMPTY_RIGHT_STRIP, height: window.height }, window);
		if (rect) edge.push({ rect, target: { kind: "split", column: "right", at: 0 }, hostKind: "empty-right" });
	}
	return [...gaps, ...edge, ...stacks];
}

/** The first zone containing `point` (half-open: left / top edges in, right / bottom edges out), or null. */
export function hitDockZone(zones: readonly DockZone[], point: { x: number; y: number }): DockZone | null {
	const { x, y } = point;
	for (const z of zones) {
		const r = z.rect;
		if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) return z;
	}
	return null;
}
