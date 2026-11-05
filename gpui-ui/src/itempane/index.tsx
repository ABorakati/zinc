// The right-hand item pane: header, a section tab row, and one scroller with Info / Abstract / Notes / Attachments / Collections /
// Tags / Related; the multi-selection summary; the empty state. Port of ui/src/ItemPane.tsx.
//
//   import { ItemPane } from "./itempane";   // <ItemPane /> fills its parent; it follows store.selectedItem() (and store.selected() when
//   the list store has it: more than one key shows the multi-selection summary).
import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { useGpuix, type HostElement } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/native";
import { Icon } from "../icons";
import { store } from "../store";
import { withAlpha } from "../theme";
import { AbstractSection, Header } from "./Header";
import { AttachmentsSection } from "./Attachments";
import { CollectionsSection } from "./Collections";
import { useInfoEntries } from "./Info";
import { MultiSelect } from "./Multi";
import { NoteEditor, NotesSection } from "./Notes";
import { RelatedSection } from "./Related";
import { NoteClip } from "./RichNote";
import { richNotesAvailable } from "../webview/notes";
import { boundsOf } from "../ui/core";
import { TagsSection } from "./Tags";
import { Skeleton, setCollapsed, setGoTo, setLabelW, t, tok, tx, type Entry } from "./kit";
import { createPaneModel, PaneContext, usePane } from "./model";
import { firstLine } from "./util";

export { showNote } from "./Notes";

/** Sections in scroll order; `tab` is the short label in the tab row under the header. */
const SECTIONS: { id: string; tab: string; icon: string }[] = [
	{ id: "info", tab: "Details", icon: "info" },
	{ id: "abstract", tab: "Abstract", icon: "align-left" },
	{ id: "notes", tab: "Notes", icon: "sticky-note" },
	{ id: "attachments", tab: "Files", icon: "paperclip" },
	{ id: "collections", tab: "Collections", icon: "library" },
	{ id: "tags", tab: "Tags", icon: "tag" },
	{ id: "related", tab: "Related", icon: "link-2" },
];

function EmptyState(p: { text: string }): JSX.Element {
	return (
		<div data-testid="ip-empty" style={{ ...t("flex flex-col items-center justify-center gap-2 p-6"), height: "100%", width: "100%" }}>
			<Icon name="file-text" size={40} strokeWidth={1.25} color={tok("muted-foreground")} style={{ opacity: 0.4 }} />
			<text style={{ ...tx("text-muted-foreground"), textAlign: "center" }}>{p.text}</text>
		</div>
	);
}

function DetailSkeleton(): JSX.Element {
	return (
		<div style={{ ...t("flex flex-col gap-3 px-3 pt-3"), width: "100%" }}>
			<Skeleton w="75%" h={20} />
			<Skeleton w="33%" h={12} />
			<Skeleton w="100%" h={24} />
			<Skeleton w="100%" h={24} />
			<Skeleton w="66%" h={24} />
			<Skeleton w="100%" h={112} />
		</div>
	);
}

/** The scrolling body below the header: tab row + sections. */
function Body(): JSX.Element {
	const pane = usePane();
	const gp = useGpuix();
	const d = () => pane.detail()!;
	const [active, setActive] = createSignal("info");
	let list: HostElement | undefined;
	let listBox: HostElement | undefined; // the list's painted area (a <virtual-list> itself reports no bounds)

	// The body is one <virtual-list> (the native side builds only the entries on screen; a scrolling container would lay out and paint every
	// field of every section on every frame, even while only the item list scrolls). Its children are exactly the entries: the Info
	// section's header and rows, then one entry per other section.
	const infoEntries = useInfoEntries();
	const entryOf = (id: string, render: () => JSX.Element): Entry => ({ id, section: id, render });
	const rest: Entry[] = [
		entryOf("abstract", () => <AbstractSection />),
		entryOf("notes", () => <NotesSection />),
		entryOf("attachments", () => <AttachmentsSection />),
		entryOf("collections", () => <CollectionsSection />),
		entryOf("tags", () => <TagsSection />),
		entryOf("related", () => <RelatedSection />),
		{ id: "spacer", section: "related", render: () => <div style={{ width: "100%", height: 192, flexShrink: 0 }} /> },
	];
	const entries = createMemo(() => [...infoEntries(), ...rest]);
	const indexOf = (id: string) => entries().findIndex((e) => e.section === id);

	let lockUntil = 0; // a tab click scrolls programmatically; the highlight stays on the clicked tab meanwhile
	const spy = (e: EventPayload) => {
		if (Date.now() < lockUntil) return;
		const first = Math.floor(e.startIndex ?? 0);
		let cur = SECTIONS[0]!.id;
		for (const s of SECTIONS) {
			const i = indexOf(s.id);
			if (i >= 0 && i <= first) cur = s.id;
		}
		setActive(cur);
	};
	const goTo = (id: string) => {
		setCollapsed(id, false);
		lockUntil = Date.now() + 500;
		setActive(id);
		// after the section has expanded: scroll so its first entry meets the list's top
		setTimeout(() => {
			const i = indexOf(id);
			if (list && i >= 0) gp?.renderer.scrollToItem?.(list.id, i, 0);
			setActive(id);
		}, 30);
	};
	setGoTo(goTo);
	// the wheel that reached the end of an open note's own scrolling (webview/notes.ts) scrolls the pane on
	// (replayed as a wheel event over the list, so GPUI scrolls and clamps it exactly as for a real wheel)
	const scrollBy = (dy: number) => {
		type Wheel = (x: number, y: number, dx: number, dy: number) => void;
		const r = gp?.renderer as { simulateScrollWheel?: Wheel; nativeSimulateScrollWheel?: Wheel } | undefined; // live / test renderer
		const b = boundsOf(listBox);
		if (b && r) (r.simulateScrollWheel ?? r.nativeSimulateScrollWheel)?.call(r, b.x + b.width / 2, b.y + b.height / 2, 0, -dy);
	};

	const count = (id: string) =>
		id === "notes" ? d().children.filter((c) => c.itemType === "note").length
		: id === "attachments" ? d().children.filter((c) => c.itemType === "attachment").length
		: id === "tags" ? d().tags.length
		: id === "collections" ? d().collections.length
		: id === "related" ? (d().related?.length ?? 0)
		: 0;

	return (
		<>
			<div style={{ ...t("flex flex-none gap-3.5 px-5"), width: "100%", height: 38, overflowX: "scroll", borderBottomWidth: 1, borderColor: tok("border-soft") }}>
				<For each={SECTIONS}>
					{(s) => (
						<div
							role="tab"
							aria-selected={active() === s.id}
							aria-label={s.tab}
							testId={`ip-nav-${s.id}`}
							onClick={() => goTo(s.id)}
							style={{
								...t("flex flex-none items-center"), height: 38, cursor: "pointer",
								borderBottomWidth: 2, borderColor: active() === s.id ? tok("foreground") : "transparent",
							}}
						>
							<Icon name={s.icon} size={14} color={tok(active() === s.id ? "foreground" : "muted-foreground")} />
							<Show when={active() === s.id}><text style={{ ...tx("text-[12.5px] font-semibold"), color: tok("foreground"), whiteSpace: "nowrap", marginLeft: 6 }}>{s.tab}</text></Show>
							<Show when={count(s.id)}>
								<text style={{ ...tx("text-[12.5px] text-muted-foreground"), marginLeft: 4 }}>{String(count(s.id))}</text>
							</Show>
						</div>
					)}
				</For>
			</div>
			<div
				ref={(el: HostElement) => { listBox = el; }}
				onLayout={(e) => { const w = (e as { width?: number }).width; if (w) setLabelW(Math.min(112, Math.max(64, Math.round(0.28 * (w - 40))))); }}
				style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, minWidth: 0, width: "100%", display: "flex", flexDirection: "column" }}
			>
				<NoteClip.Provider value={{ el: () => listBox, scrollBy }}>
				<virtual-list
					ref={(el: HostElement) => { list = el; }}
					testId="ip-list"
					estimatedItemHeight={28}
					overdraw={80}
					onVisibleRange={spy}
					style={{ width: "100%", flexGrow: 1, minHeight: 0, scrollbarColor: withAlpha(tok("foreground"), 0.25), scrollbarWidth: 6 }}
				>
					<For each={entries()}>{(e) => e.render()}</For>
				</virtual-list>
				</NoteClip.Provider>
			</div>
		</>
	);
}

/** A top-level note selected in the list: the note itself fills the pane. */
function NotePane(): JSX.Element {
	const pane = usePane();
	const d = () => pane.detail()!;
	const title = () => firstLine((d().data.note as string | undefined) ?? "") || "Untitled note";
	return (
		<div style={{ ...t("flex flex-col w-full h-full") }}>
			<div style={{ ...t("flex flex-col flex-none gap-2.5 px-5 pt-5 pb-4"), backgroundColor: tok("header-tint"), borderTopLeftRadius: 14, borderTopRightRadius: 14, borderBottomWidth: 1, borderColor: tok("border-soft") }}>
				<div style={{ ...t("flex items-center gap-1.5 rounded-full px-2.5 py-1"), alignSelf: "flex-start", backgroundColor: tok("primary-tint") }}>
					<Icon name="sticky-note" size={14} color={tok("primary-deep")} />
					<text style={{ ...tx("text-[11px] font-semibold"), color: tok("primary-deep") }}>NOTE</text>
				</div>
				<text style={{ ...tx("font-title text-[21px] font-semibold"), paddingLeft: 6 }}>{title()}</text>
			</div>
			{/* Zotero's editor scrolls itself and fills the pane; the Markdown fallback scrolls here */}
			<div style={{ flexGrow: 1, minHeight: 0, width: "100%", padding: 16, ...(richNotesAvailable() ? { display: "flex", flexDirection: "column" } : { overflow: "scroll" }) }}>
				<NoteEditor noteKey={d().data.key} fill onSaved={() => { void pane.reload(); pane.refreshList(); }} />
			</div>
		</div>
	);
}

function Single(): JSX.Element {
	const pane = usePane();
	return (
		<Show when={pane.detail()} fallback={pane.error() ? <EmptyState text="Could not load item" /> : <DetailSkeleton />}>
			<Show when={pane.detail()!.data.itemType !== "note"} fallback={<NotePane />}>
				<div data-testid="ip-detail" data-item={pane.detail()!.data.key} style={{ ...t("flex flex-col w-full h-full min-h-0") }}>
					<Header />
					<Body />
				</div>
			</Show>
		</Show>
	);
}

export function ItemPane(): JSX.Element {
	const selected = () => (store as unknown as { selected?: () => Set<string> }).selected?.();
	const multi = () => (selected()?.size ?? 0) > 1;
	const key = createMemo(() => {
		if (multi()) return null;
		return store.selectedItem() ?? [...(selected() ?? [])][0] ?? null;
	});
	const model = createPaneModel(key);
	return (
		<PaneContext.Provider value={model}>
			<div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
				<Show when={!multi()} fallback={<MultiSelect keys={() => [...(selected() ?? [])]} />}>
					<Show when={key()} fallback={<EmptyState text="Select an item to view its details" />}>
						<Single />
					</Show>
				</Show>
			</div>
		</PaneContext.Provider>
	);
}
