// Panes that can be placed in the frame's centre and right columns (docs/developer-guide/layouts.md, section 4). A pane is a unit
// of content with an id, a title and an icon; the frame renderer (shell/Frame.tsx) creates each pane once per view and moves it
// between places, so a pane keeps its state while the layout changes. Built-in panes are registered in shell/builtinPanes.tsx.
import { createSignal, type JSX } from "solid-js";
import type { KnownPanes, ViewKind } from "./frameLayout";

export interface PaneDef {
	/** "items", "item", later "notes", "section:<id>", "plugin:<plugin>:<panel>" */
	id: string;
	title: () => string;
	/** lucide icon name */
	icon: string;
	/** views the pane may appear in */
	views: ViewKind[];
	/** the view cannot do without it ("items" in the library): never hidden, re-added if missing */
	required?: boolean;
	/** least size in px; the frame keeps a column at least as wide as its widest pane's minimum */
	minSize: { w: number; h: number };
	/** the pane's content, filling its place (it draws its own card chrome) */
	render: () => JSX.Element;
}

const [list, setList] = createSignal<PaneDef[]>([]);

/** Register a pane (a second registration with the same id replaces the first). */
export function registerPane(def: PaneDef): void {
	setList((l) => [...l.filter((p) => p.id !== def.id), def]);
}
export function unregisterPane(id: string): void {
	setList((l) => l.filter((p) => p.id !== id));
}

/** Registered panes of a view, reactive. */
export const panesOf = (view: ViewKind): PaneDef[] => list().filter((p) => p.views.includes(view));
export const paneDef = (id: string): PaneDef | undefined => list().find((p) => p.id === id);

/** What normalizeLayout needs for a view. */
export function knownPanes(view: ViewKind): KnownPanes {
	const l = panesOf(view);
	return { ids: l.map((p) => p.id), required: l.filter((p) => p.required).map((p) => p.id) };
}
