// What a pane's hover header (shell/PaneStack.tsx) can do besides the pane menu: minimise a library pane to the rail at the frame's
// right edge (shell/Frame.tsx), maximise one to fill the frame, and show the buttons a detached section hands over (itempane/kit.tsx).
//
// Minimised = hidden in place (the layout's `hidden`, so it keeps its spot) and listed here, in the order it was minimised, so the
// rail can show it. A pane hidden another way (the pane menu's Hide, the close button) is not on the rail. Maximised is not kept
// across restarts: it is a moment's view, like a zoomed split.
import { createRoot, createSignal, type JSX } from "solid-js";
import { persisted } from "./prefs";
import { hideLibraryPane, libraryLayout } from "./layout";
import { locatePane } from "./frameLayout";
import { panesOf } from "./panes";

const okList = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined);
const [minimisedRaw, setMinimisedRaw] = persisted<string[]>("shell.layout.minimised", [], okList);

/** Library panes on the rail: minimised, still hidden, still placed and registered. */
export const minimisedPanes = (): string[] => {
	const l = libraryLayout();
	const reg = new Set(panesOf("library").map((d) => d.id));
	return minimisedRaw().filter((id) => reg.has(id) && l.hidden.includes(id) && locatePane(l, id) !== null);
};

const [maximised, setMaximised] = createRoot(() => createSignal<string | null>(null));
/** The library pane filling the frame, or null. */
export { maximised };

/** Minimise a library pane to the rail (undoable as a hide). */
export function minimisePane(id: string): void {
	if (maximised() === id) setMaximised(null);
	hideLibraryPane(id, true);
	if (libraryLayout().hidden.includes(id)) setMinimisedRaw([...minimisedRaw().filter((x) => x !== id), id]);
}
/** Bring a minimised (or hidden) library pane back to its place. */
export function restorePane(id: string): void {
	hideLibraryPane(id, false);
	setMinimisedRaw(minimisedRaw().filter((x) => x !== id));
}
/** Maximise `id`, or restore the layout when it is the maximised one. */
export function toggleMaximise(id: string): void {
	setMaximised(maximised() === id ? null : id);
}
export const clearMaximise = (): void => void setMaximised(null);

// ---- buttons a pane's content puts in its header (a detached section's own actions, e.g. Attachments' Find Full Text)
const [actions, setActions] = createRoot(() => createSignal<ReadonlyMap<string, () => JSX.Element>>(new Map()));
/** Show `render()` in pane `paneId`'s header; returns the function that takes it away again. */
export function setPaneHeaderActions(paneId: string, render: () => JSX.Element): () => void {
	setActions((m) => new Map(m).set(paneId, render));
	return () =>
		setActions((m) => {
			if (m.get(paneId) !== render) return m;
			const n = new Map(m);
			n.delete(paneId);
			return n;
		});
}
export const paneHeaderActions = (paneId: string): (() => JSX.Element) | undefined => actions().get(paneId);
