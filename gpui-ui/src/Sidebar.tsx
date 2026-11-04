// Left sidebar of the library window: LIBRARY (My Library / Unfiled / Trash / Duplicate Items / Saved Searches), COLLECTIONS tree
// and the TAGS pane, with a draggable split between the two panes. Mirrors ui/src/Collections.tsx + sidebar.tsx + Tags.tsx +
// searches/SavedSearches.tsx with the same Tailwind class strings, resolved through tw() / textStyle().
// The pieces live in sidebar/ (parts, state, bridge, Collections), searches/ and tags/.
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { useGpuix, type HostElement } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/native";
import type { View } from "./contracts";
import { Icon } from "./icons";
import { sidebarSections } from "./registry";
import { savedSearchEntries } from "./searches/SavedSearches";
import { ensureSavedSearches } from "./searches/state";
import { currentView, setView } from "./sidebar/bridge";
import { errMsg, sidebarApi } from "./sidebar/client";
import { collectionEntries, creating, onBeforeCreate, reloadCollections, setCollectionsPane } from "./sidebar/Collections";
import { CountBadge, type Entry, labelCls, ListItem, pill, ROW_HOVER, SectionHeader, SPECIAL_STATIC, t, tok, tx } from "./sidebar/parts";
import { collectionsFraction, libraryOpen, setCollectionsFraction, setLibraryOpen, setSidebarWidth, sidebarWidth, tagsOpen } from "./sidebar/state";
import { clipText, textWidth } from "./clip";
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
	const [hov, setHov] = createSignal(false);
	// the label cut to the row (clip.ts): sidebar paddings 20 + 19, row pl 24 + pr 8, icon 16 + gap 4, then the count badge
	const label = () => {
		const W = sidebarWidth();
		if (W <= 0) return p.label;
		const badge = p.count ? 8 + Math.max(22, textWidth(p.count.toLocaleString("en-US"), 11, 600) + 12) : 0;
		return clipText(p.label, W - 20 - 19 - 24 - 8 - 16 - 4 - badge, 13, sel() ? 600 : 400);
	};
	return (
		<ListItem>
			<div
				role="treeitem"
				aria-selected={sel()}
				onMouseEnter={() => setHov(true)}
				onMouseLeave={() => setHov(false)}
				onClick={() => setView(p.view)}
				onAuxClick={(e) => { if (e.isRightClick) p.onMenu?.(e.x ?? 0, e.y ?? 0); }}
				style={{ ...t(SPECIAL_STATIC), ...(hov() ? t(ROW_HOVER) : {}), ...pill(sel()) }}
			>
				<Icon name={p.icon} size={16} color={tok(sel() ? "primary" : "muted-foreground")} />
				<text style={{ ...tx(labelCls(sel())), overflow: "hidden", whiteSpace: "nowrap", minWidth: 0, flexGrow: 1, flexBasis: 0 }}>{label()}</text>
				<CountBadge n={p.count} />
			</div>
		</ListItem>
	);
}

export function Sidebar(): JSX.Element {
	const [dupCount, setDupCount] = createSignal<number | undefined>(undefined);
	// the duplicate scan takes a moment on a big library: fetch it after the first frames, not at startup
	onMount(() => {
		ensureSavedSearches();
		setTimeout(() => void sidebarApi.duplicateCount().then(setDupCount).catch(() => {}), 1200);
	});

	// ---- the scrolling part (Library group + Collections group) as the entries of ONE virtual list ----
	// The Library header; while open the built-in rows, the registry's sections and the Saved Searches block; then the Collections
	// group. The memo reads only what changes WHICH rows exist (open / closed groups, the tree, the saved searches); everything a
	// row shows (selection, counts, hover tints) is read inside its own render function, so it updates without rebuilding the list.
	const entries = createMemo<Entry[]>(() => {
		const open = libraryOpen();
		const out: Entry[] = [{
			id: "l:header",
			render: () => (
				<ListItem>
					<SectionHeader label="Library" open={libraryOpen()} onToggle={() => setLibraryOpen(!libraryOpen())} />
				</ListItem>
			),
		}];
		if (open) {
			out.push(
				{ id: "l:library", render: () => <Special view={{ kind: "library" }} label="My Library" icon="library" /> },
				{ id: "l:unfiled", render: () => <Special view={{ kind: "unfiled" }} label="Unfiled" icon="inbox" /> },
				{
					id: "l:trash",
					render: () => (
						<Special
							view={{ kind: "trash" }}
							label="Trash"
							icon="trash-2"
							onMenu={(x, y) => openMenu({ x, y }, [{ label: "Empty Trash…", icon: "trash-2", danger: true, onSelect: () => void emptyTrash() }])}
						/>
					),
				},
				// duplicates/DuplicateDialog.tsx DuplicateSidebarEntry
				{ id: "l:duplicates", render: () => <Special view={{ kind: "duplicates" }} label="Duplicate Items" icon="copy" count={dupCount()} /> },
			);
			for (const s of sidebarSections()) if (!BUILT_IN_SECTIONS.has(s.id)) out.push({ id: `l:reg:${s.id}`, render: () => <ListItem>{s.render()}</ListItem> });
			out.push(...savedSearchEntries());
		}
		// 16px (`gap-4`) between the groups; the Library block ends in a row with no bottom gap when open
		out.push(...collectionEntries(open ? 16 : 15));
		out.push({ id: "end", render: () => <div style={{ height: 4, width: "100%" }} /> }); // the old `pb-1`
		return out;
	});

	// A new row whose inline name field takes focus is "revealed" by GPUIX: the list scrolls it to the TOP of the viewport, which would
	// push the Library group (and the Collections header) out of view when you press "+". Keep the scroll position the user had
	// unless the new row would be off screen. The snapshot is taken before the row exists; the restore is queued right after it was
	// inserted and is applied after GPUIX's own scroll in the same frame.
	const gpuix = useGpuix();
	let list: { id: number } | undefined;
	let top: number[] | null = null;
	onBeforeCreate(() => { top = list ? (gpuix?.renderer.getListScrollTop?.(list.id) ?? null) : null; });
	onCleanup(() => onBeforeCreate(undefined));
	createEffect(on(creating, (key) => {
		const snap = top;
		top = null;
		if (!key || !snap || !list) return;
		const at = entries().findIndex((e) => e.id.startsWith("c:create:"));
		if (at < 0) return;
		const [ix = 0, off = 0, viewport = 0] = snap;
		const first = ix >= at ? ix + 1 : ix; // rows at or after the insertion point moved down by one
		if ((at - first) * 29 - off + 28 > viewport) return; // off screen: let GPUIX bring it into view
		gpuix?.renderer.scrollToItem?.(list.id, first, off);
	}, { defer: true }));

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
			onLayout={(e) => { box = { y: e.y ?? 0, h: Math.max(1, e.height ?? 1) }; const w = Math.round(e.width ?? 0); if (w !== sidebarWidth()) setSidebarWidth(w); }}
			style={{ ...t("flex h-full min-h-0 w-full flex-col px-2.5 pt-1.5 pb-1"), userSelect: "none" }}
		>
			{/* CollectionsPane: `flex min-h-0 flex-col overflow-y-auto pr-2`, flex 3 1 0% (open). The pane box itself no longer scrolls: the
			    virtual list inside does, and builds only the rows on screen. Its overlaid scrollbar thumb sits at the list's right edge; the
			    rows keep a gutter for it (ListItem), as the old container did with paddingRight 8 + SCROLLBAR_GUTTER. */}
			<div
				ref={(el: HostElement) => setCollectionsPane(el)}
				style={{
					...t("flex min-h-0 flex-col"),
					flexGrow: tagsOpen() ? collectionsFraction() : 1,
					flexShrink: 1,
					flexBasis: 0,
				}}
			>
				<virtual-list
					ref={(el: { id: number }) => { list = el; }}
					testId="sidebar-list"
					estimatedItemHeight={29}
					overdraw={60}
					style={{ width: "100%", flexGrow: 1, minHeight: 0, scrollbarColor: tok("input"), scrollbarWidth: 6 }}
				>
					<For each={entries()}>{(e) => e.render()}</For>
				</virtual-list>
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
