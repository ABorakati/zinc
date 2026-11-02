// Left sidebar of the library window: LIBRARY (My Library / Unfiled / Trash / Duplicate Items / Saved Searches), COLLECTIONS tree
// and the TAGS pane, with a draggable split between the two panes. Mirrors ui/src/Collections.tsx + sidebar.tsx + Tags.tsx +
// searches/SavedSearches.tsx with the same Tailwind class strings, resolved through tw() / textStyle().
// The pieces live in sidebar/ (parts, state, bridge, Collections), searches/ and tags/.
import { createSignal, For, onMount, Show, type JSX } from "solid-js";
import type { HostElement } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/native";
import type { View } from "./contracts";
import { Icon } from "./icons";
import { sidebarSections } from "./registry";
import { SavedSearchesSection } from "./searches/SavedSearches";
import { currentView, setView } from "./sidebar/bridge";
import { errMsg, sidebarApi } from "./sidebar/client";
import { CollectionsGroup, reloadCollections, setCollectionsPane } from "./sidebar/Collections";
import { CountBadge, labelCls, pill, SCROLLBAR_GUTTER, SectionHeader, SPECIAL, t, tok, TRUNCATE, tx } from "./sidebar/parts";
import { collectionsFraction, libraryOpen, setCollectionsFraction, setLibraryOpen, tagsOpen } from "./sidebar/state";
import { TagList } from "./tags/TagList";
import { confirm, openMenu, toast } from "./ui";

export { collectionColor } from "./sidebar/parts";

/** Sidebar entries drawn here (or by Sidebar itself), so a feature that also registers one with the registry does not double them. */
const BUILT_IN_SECTIONS = new Set(["duplicates", "saved-searches", "tags", "collections"]);

async function emptyTrash() {
	try {
		const c = await sidebarApi.trashCounts();
		if (!c.items) return void toast("The Trash is empty");
		const ok = await confirm({
			title: "Empty Trash?",
			body: `${c.items} item${c.items === 1 ? "" : "s"} will be deleted permanently and removed from your Zotero library at the next sync. This cannot be undone.`,
			confirmLabel: "Empty Trash",
			danger: true,
		});
		if (!ok) return;
		const r = await sidebarApi.emptyTrash();
		toast(`Permanently deleted ${r.erased} item${r.erased === 1 ? "" : "s"}`, { kind: "success" });
		await reloadCollections();
	} catch (e) { toast("Could not empty the Trash", { kind: "error", description: errMsg(e) }); }
}

function Special(p: { view: View; label: string; icon: string; count?: number; onMenu?: (x: number, y: number) => void }): JSX.Element {
	const sel = () => {
		const v = currentView();
		return v.kind === p.view.kind && ("key" in p.view ? "key" in v && v.key === p.view.key : true);
	};
	return (
		<div
			role="treeitem"
			aria-selected={sel()}
			onClick={() => setView(p.view)}
			onAuxClick={(e) => { if (e.isRightClick) p.onMenu?.(e.x ?? 0, e.y ?? 0); }}
			style={{ ...t(SPECIAL), ...pill(sel()) }}
		>
			<Icon name={p.icon} size={16} color={tok(sel() ? "primary" : "muted-foreground")} />
			<text style={{ ...tx(labelCls(sel())), ...TRUNCATE, flexGrow: 1, flexBasis: 0 }}>{p.label}</text>
			<CountBadge n={p.count} />
		</div>
	);
}

export function Sidebar(): JSX.Element {
	const [dupCount, setDupCount] = createSignal<number | undefined>(undefined);
	// the duplicate scan takes a moment on a big library: fetch it after the first frames, not at startup
	onMount(() => {
		setTimeout(() => void sidebarApi.duplicateCount().then(setDupCount).catch(() => {}), 1200);
	});

	// ---- split between the collections and tags panes ----
	// While the handle is dragged a transparent window-sized layer takes the pointer (as ui/resizable.tsx), so the drag keeps
	// working when the cursor leaves the thin handle.
	let box = { y: 0, h: 1 };
	const [splitting, setSplitting] = createSignal(false);
	const [hot, setHot] = createSignal(false);
	const stop = () => { setSplitting(false); setHot(false); };

	return (
		// App.tsx: `zn-sidebar flex h-full min-h-0 flex-col gap-3 px-2.5 pt-1.5 pb-1`; the 12px gap is the split handle between the panes
		<div
			onLayout={(e) => { box = { y: e.y ?? 0, h: Math.max(1, e.height ?? 1) }; }}
			style={{ ...t("flex h-full min-h-0 w-full flex-col px-2.5 pt-1.5 pb-1"), userSelect: "none" }}
		>
			{/* CollectionsPane: `flex min-h-0 flex-col overflow-y-auto pr-2`, flex 3 1 0% (open) */}
			<div
				ref={(el: HostElement) => setCollectionsPane(el)}
				style={{
					...t("flex min-h-0 flex-col overflow-y-auto pr-2"),
					// web scrollbars (`scrollbar-width: thin`, ~11px) take layout space beside the pr-2; GPUIX's thumb overlays the
					// container's right edge, so reserve that gutter here and the thumb stays clear of the rows
					paddingRight: 8 + SCROLLBAR_GUTTER,
					flexGrow: tagsOpen() ? collectionsFraction() : 1,
					flexShrink: 1,
					flexBasis: 0,
				}}
			>
				{/* role="tree": `flex flex-col gap-4 pb-1` */}
				<div style={t("flex flex-none flex-col gap-4 pb-1")}>
					{/* Library group: `flex flex-col gap-px` */}
					<div style={t("flex flex-col gap-px")}>
						<SectionHeader label="Library" open={libraryOpen()} onToggle={() => setLibraryOpen(!libraryOpen())} />
						<Show when={libraryOpen()}>
							<Special view={{ kind: "library" }} label="My Library" icon="library" />
							<Special view={{ kind: "unfiled" }} label="Unfiled" icon="inbox" />
							<Special
								view={{ kind: "trash" }}
								label="Trash"
								icon="trash-2"
								onMenu={(x, y) => openMenu({ x, y }, [{ label: "Empty Trash…", icon: "trash-2", danger: true, onSelect: () => void emptyTrash() }])}
							/>
							{/* duplicates/DuplicateDialog.tsx DuplicateSidebarEntry */}
							<Special view={{ kind: "duplicates" }} label="Duplicate Items" icon="copy" count={dupCount()} />
							<For each={sidebarSections().filter((s) => !BUILT_IN_SECTIONS.has(s.id))}>{(s) => s.render()}</For>
							<SavedSearchesSection />
						</Show>
					</div>
					<CollectionsGroup />
				</div>
			</div>
			{/* the split handle: a 12px gap between the panes; draggable while the tags pane is open */}
			<div
				onMouseDown={(e) => { if (tagsOpen() && e.button === 0) { setSplitting(true); setHot(true); } }}
				onMouseEnter={() => tagsOpen() && setHot(true)}
				onMouseLeave={() => { if (!splitting()) setHot(false); }}
				style={{ flexShrink: 0, height: 12, display: "flex", alignItems: "center", justifyContent: "center", cursor: tagsOpen() ? "row-resize" : "default" }}
			>
				<Show when={tagsOpen() && hot()}>
					<div style={{ width: 36, height: 3, borderRadius: 2, backgroundColor: tok(splitting() ? "primary" : "border") }} />
				</Show>
			</div>
			{/* Tags.tsx TagList: flex 2 1 0% (open) | 0 0 auto (header only) */}
			<TagList />
			<Show when={splitting()}>
				<anchored fill="window" priority={1000} style={{ backgroundColor: "rgba(0, 0, 0, 0.004)" }}>
					<div
						onMouseMove={(e: EventPayload) => {
							if (e.pressedButton === undefined || e.pressedButton === null) return stop(); // released outside the window
							setCollectionsFraction(Math.min(0.85, Math.max(0.15, ((e.y ?? 0) - box.y - 6) / box.h)));
						}}
						onMouseUp={stop}
						style={{ width: "100%", height: "100%", cursor: "row-resize" }}
					/>
				</anchored>
			</Show>
		</div>
	);
}
