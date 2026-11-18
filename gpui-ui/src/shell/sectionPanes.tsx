// Item sections share the library's item model, whether the item pane is visible or not.
import { createEffect, createMemo, createRoot, For, Show, untrack, type JSX } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import { DetachedSectionContext, t, tok, tx } from "../itempane/kit";
import { PaneContext, viewPaneModel, usePane } from "../itempane/model";
import { createSectionEntries } from "../itempane/sections";
import { NoteClip } from "../itempane/RichNote";
import { registries } from "../wasmplugins/extend/registry";
import { sectionDomId } from "../wasmplugins/extend/Sections";
import { iconName, lstr } from "../wasmplugins/extend/text";
import { sectionPaneId, type DropTarget } from "./frameLayout";
import { libraryLayout, moveLibraryPane } from "./layout";
import { registerPane, unregisterPane } from "./panes";
import { persisted } from "./prefs";
import { RIGHT_PARTS, rightLayout } from "./sidebarLayout";

// sidebarLayout normalises built-in ids only. Keep plugin positions as anchors without changing its API.
const [pluginPositions, setPluginPositions] = persisted<Record<string, string | null>>("shell.itempanePluginPositions", {});
export function sectionOrder(pluginIds: string[]): string[] {
	const order = [...rightLayout.layout().order];
	const pending = new Set(pluginIds);
	const insert = (id: string) => {
		if (!pending.delete(id)) return;
		const before = pluginPositions()[id];
		if (before && pending.has(before)) insert(before);
		const at = before ? order.indexOf(before) : -1;
		order.splice(at < 0 ? order.length : at, 0, id);
	};
	for (const id of pluginIds) insert(id);
	return order;
}

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
export function returnSection(sectionId: string, before?: string | null): boolean {
	if (sectionId === before) return false;
	const detached = isDetached(sectionId);
	if (detached && !moveLibraryPane(sectionPaneId(sectionId), { kind: "section" })) return false;
	const layout = rightLayout.layout();
	const pluginIds = registries.sections.list().map(sectionDomId);
	if (!layout.order.includes(sectionId) && !pluginIds.includes(sectionId)) return detached;
	let reordered = false;
	if (before !== undefined) {
		const order = sectionOrder(pluginIds).filter((id) => id !== sectionId);
		const at = before === null ? -1 : order.indexOf(before);
		order.splice(at < 0 ? order.length : at, 0, sectionId);
		reordered = order.join("\0") !== sectionOrder(pluginIds).join("\0");
		rightLayout.set({ order: order.filter((id) => !id.startsWith("plug:")), hidden: layout.hidden.filter((id) => id !== sectionId) });
		const positions = { ...pluginPositions() };
		for (let i = 0; i < order.length; i++)
			if (order[i]!.startsWith("plug:")) positions[order[i]!] = order[i + 1] ?? null;
		setPluginPositions(positions);
	} else {
		rightLayout.set({ ...layout, hidden: layout.hidden.filter((id) => id !== sectionId) });
	}
	return detached || reordered;
}

function SectionList(p: { id: string }): JSX.Element {
	const pane = usePane();
	const entriesOf = createSectionEntries();
	const entries = createMemo(() => entriesOf(p.id));
	let box: HostElement | undefined;
	return (
		<div
			ref={(el: HostElement) => { box = el; }}
			testId={`section-content-${p.id}`}
			data-item={pane.itemKey()}
			style={{ ...t("flex flex-col w-full h-full min-h-0") }}
		>
			<NoteClip.Provider value={{ el: () => box }}>
				<virtual-list testId={`section-list-${p.id}`} estimatedItemHeight={28} overdraw={80} style={{ width: "100%", flexGrow: 1, minHeight: 0 }}>
					<For each={entries()}>{(entry) => entry.render()}</For>
				</virtual-list>
			</NoteClip.Provider>
		</div>
	);
}

function SectionPane(p: { id: string }): JSX.Element {
	const pane = viewPaneModel();
	return (
		<PaneContext.Provider value={pane}>
			<DetachedSectionContext.Provider value={true}>
				<div testId={`section-pane-${p.id}`} style={{ ...t("rounded-[14px] bg-background shadow-raised overflow-hidden"), width: "100%", height: "100%", minWidth: 0 }}>
					<Show when={pane.detail()} fallback={
						<div style={{ ...t("flex items-center justify-center p-5"), width: "100%", height: "100%" }}>
							<text style={{ ...tx("text-sm text-muted-foreground"), color: tok("muted-foreground") }}>
								{!pane.key() ? "Select one item to view this section" : pane.error() ? "Could not load item" : "Loading…"}
							</text>
						</div>
					}>
						<SectionList id={p.id} />
					</Show>
				</div>
			</DetachedSectionContext.Provider>
		</PaneContext.Provider>
	);
}

for (const section of RIGHT_PARTS) registerPane({
	id: sectionPaneId(section.id),
	title: () => section.label,
	icon: section.icon,
	views: ["library"],
	minSize: { w: 200, h: 120 },
	render: () => <SectionPane id={section.id} />,
});

// Track registration independently of selection. Disabled plugins leave their pane positions as ghosts.
createRoot(() => {
	let registered = new Set<string>();
	createEffect(() => {
		const sections = registries.sections.list();
		untrack(() => {
			const next = new Set(sections.map((s) => sectionPaneId(sectionDomId(s))));
			for (const id of registered) if (!next.has(id)) unregisterPane(id);
			for (const s of sections) registerPane({
				id: sectionPaneId(sectionDomId(s)),
				title: () => lstr(s.reg.header.label, s.id),
				icon: iconName(s.reg.header.icon),
				views: ["library"],
				minSize: { w: 200, h: 120 },
				render: () => <SectionPane id={sectionDomId(s)} />,
			});
			registered = next;
		});
	});
});
