// Pane docking: snapshot painted hosts at drag start, capture the pointer, then apply one undoable layout move.
import { batch, createSignal, onCleanup, Show, type Accessor, type JSX } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import { dragging, dragPoint, DRAG_THRESHOLD, endDrag, moveDrag, startDrag } from "../dnd";
import { withAlpha } from "../theme";
import { boundsOf, t, tok, windowSize } from "../ui/core";
import { toast } from "../ui/overlay";
import { createDockZones, hitDockZone, type DockZone, type DropHostSpec } from "./dockZones";
import { canMove, isSectionPane, sectionIdOf } from "./frameLayout";
import { libraryLayout, moveLibraryPane, undoLayout } from "./layout";
import { paneDef } from "./panes";
import { returnSection } from "./sectionPanes";
import { addKeyHandler } from "./shortcuts";

export type { DropHostSpec } from "./dockZones";

const hosts = new Set<{ spec: () => DropHostSpec; el: HostElement }>();

/** Register while mounted. Specs and painted bounds are read once when a drag starts. */
export function registerDropHost(spec: () => DropHostSpec, el: HostElement): () => void {
	const host = { spec, el };
	hosts.add(host);
	return () => { hosts.delete(host); };
}

/** The pane being dragged (its id), or null. Item drags never show the dock overlay. */
export const paneDragging: Accessor<string | null> = () => {
	const d = dragging();
	return d?.kind === "pane" ? d.id : null;
};

const [zones, setZones] = createSignal<DockZone[]>([]);
const [target, setTarget] = createSignal<DockZone | null>(null);
const title = (id: string) => paneDef(id)?.title() ?? id;

function cancel() {
	batch(() => {
		setTarget(null);
		setZones([]);
		if (paneDragging()) endDrag();
	});
}

function move(e: { x?: number; y?: number; pressedButton?: number }) {
	if (!paneDragging()) return;
	if (e.pressedButton !== 0) {
		cancel();
		return;
	}
	const point = { x: e.x ?? 0, y: e.y ?? 0 };
	batch(() => {
		moveDrag(point.x, point.y);
		setTarget(hitDockZone(zones(), point));
	});
}

function drop(point = dragPoint()) {
	const id = paneDragging();
	const zone = point ? hitDockZone(zones(), point) : null;
	cancel();
	if (!id || !zone || !canMove(libraryLayout(), id, zone.target)) return;
	const section = sectionIdOf(id);
	const moved = zone.target.kind === "section" && section !== null
		? returnSection(section, zone.before)
		: moveLibraryPane(id, zone.target);
	if (moved) toast(`Moved ${title(id)}`, { id: "pane-moved", action: { label: "Undo", run: () => { undoLayout(); } } });
}

/**
 * Spread on a pane header, tab or section header. wasDrag consumes the trailing-click guard once.
 * Sections still inside the item pane use their future "section:<id>" pane id.
 */
export function paneDragSource(id: () => string): {
	onMouseDown: (e: { x?: number; y?: number; button?: number }) => void;
	onMouseMove: (e: { x?: number; y?: number; pressedButton?: number }) => void;
	onMouseUp: () => void;
	wasDrag: () => boolean;
} {
	let press: { x: number; y: number } | null = null;
	let justDragged = false;
	return {
		onMouseDown(e) {
			if ((e.button ?? 0) !== 0 || dragging()) return;
			justDragged = false;
			press = { x: e.x ?? 0, y: e.y ?? 0 };
		},
		onMouseMove(e) {
			if (paneDragging()) { move(e); return; }
			if (!press) return;
			if (e.pressedButton !== 0 || dragging()) { press = null; return; }
			if (Math.hypot((e.x ?? 0) - press.x, (e.y ?? 0) - press.y) < DRAG_THRESHOLD) return;
			press = null;
			const pane = id();
			const win = windowSize();
			const snapshots = [...hosts].flatMap((h) => {
				const spec = h.spec();
				const bounds = boundsOf(h.el) ?? (spec.kind === "empty-right" ? { x: 0, y: 0, ...win } : null);
				return bounds ? [{ spec, bounds }] : [];
			});
			const next = createDockZones(snapshots, windowSize(), isSectionPane(pane))
				.filter((z) => canMove(libraryLayout(), pane, z.target));
			batch(() => {
				setZones(next);
				startDrag({ kind: "pane", id: pane });
				move(e);
			});
			justDragged = true;
		},
		onMouseUp() { press = null; if (paneDragging()) drop(); },
		wasDrag() { const was = justDragged; justDragged = false; return was; },
	};
}

/** Mount once in Frame. A window-sized layer captures movement and release over all pane content. */
export function DockOverlay(): JSX.Element {
	onCleanup(addKeyHandler((e) => {
		if (e.key !== "escape" || !paneDragging()) return false;
		cancel();
		return true;
	}));
	onCleanup(cancel);
	const ghost = () => {
		const p = dragPoint() ?? { x: 0, y: 0 };
		const w = windowSize();
		return { left: Math.max(0, Math.min(p.x + 14, w.width - 180)), top: Math.max(0, Math.min(p.y + 16, w.height - 32)) };
	};
	return (
		<Show when={paneDragging()}>
			<anchored fill="window" priority={1000} style={{ backgroundColor: "rgba(0, 0, 0, 0.004)" }}>
				<div
					testId="dock-capture"
					onMouseMove={move}
					onMouseUp={(e) => drop(e.x !== undefined && e.y !== undefined ? { x: e.x, y: e.y } : dragPoint())}
					style={{ width: "100%", height: "100%", position: "relative", cursor: "grabbing" }}
				>
					<Show when={zones().find((z) => z.hostKind === "empty-right")}>
						{(z) => <div testId="dock-empty-right" style={{
							position: "absolute", left: z().rect.x, top: z().rect.y, width: z().rect.width, height: z().rect.height,
							backgroundColor: withAlpha(tok("primary"), 0.08), pointerEvents: "none",
						}} />}
					</Show>
					<Show when={target()}>
						{(z) => <div testId="dock-preview" style={{
							position: "absolute", left: z().rect.x, top: z().rect.y, width: z().rect.width, height: z().rect.height,
							backgroundColor: withAlpha(tok("primary"), 0.2), borderColor: tok("primary"), borderWidth: 1, pointerEvents: "none",
						}} />}
					</Show>
					<div testId="dock-ghost" style={{
						...t("rounded-md border bg-popover px-3 py-1.5 shadow-md"), position: "absolute", ...ghost(), pointerEvents: "none",
					}}>
						<text style={t("text-sm text-popover-foreground")}>{title(paneDragging()!)}</text>
					</div>
				</div>
			</anchored>
		</Show>
	);
}
