// The right-hand item pane: header, a section tab row, and one scroller with Info / Abstract / Notes / Attachments / Collections /
// Tags / Related; the multi-selection summary; the empty state. Port of ui/src/ItemPane.tsx.
//
//   import { ItemPane } from "./itempane";   // <ItemPane /> fills its parent; it follows store.selectedItem() (and store.selected() when
//   the list store has it: more than one key shows the multi-selection summary).
import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { useGpuix } from "@gpuix/solid";
import { Icon } from "../icons";
import { store } from "../store";
import { withAlpha } from "../theme";
import { AbstractSection, Header } from "./Header";
import { AttachmentsSection } from "./Attachments";
import { CollectionsSection } from "./Collections";
import { InfoSection } from "./Info";
import { MultiSelect } from "./Multi";
import { NoteEditor, NotesSection } from "./Notes";
import { RelatedSection } from "./Related";
import { TagsSection } from "./Tags";
import { Skeleton, setCollapsed, setGoTo, setLabelW, t, tok, tx } from "./kit";
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
	let scroller: { id: number; scrollIntoView?: () => void } | undefined;
	const sections = new Map<string, { id: number; scrollIntoView?: () => void }>();
	const bounds = (el: { id: number }) => gp?.renderer.getElementBounds?.(el.id) ?? null;

	let lockUntil = 0; // a tab click scrolls programmatically; the highlight stays on the clicked tab meanwhile
	const spy = () => {
		if (!scroller || Date.now() < lockUntil) return;
		const top = bounds(scroller)?.y;
		if (top === undefined) return;
		let cur = SECTIONS[0]!.id;
		for (const s of SECTIONS) {
			const el = sections.get(s.id);
			const b = el && bounds(el);
			if (b && b.y <= top + 12) cur = s.id;
		}
		setActive(cur);
	};
	const goTo = (id: string) => {
		setCollapsed(id, false);
		lockUntil = Date.now() + 500;
		setActive(id);
		// after the section has expanded: scroll so its top meets the scroller's top (scrollIntoView alone only makes it visible)
		setTimeout(() => {
			const r = gp?.renderer;
			const el = sections.get(id);
			const sb = scroller && bounds(scroller);
			const eb = el && bounds(el);
			const off = scroller && r?.getScrollOffset?.(scroller.id);
			if (r?.scrollTo && scroller && sb && eb && off) r.scrollTo(scroller.id, 0, Math.min(0, off[1]! - (eb.y - sb.y)));
			else el?.scrollIntoView?.();
			setActive(id);
		}, 30);
	};
	setGoTo(goTo);

	const count = (id: string) =>
		id === "notes" ? d().children.filter((c) => c.itemType === "note").length
		: id === "attachments" ? d().children.filter((c) => c.itemType === "attachment").length
		: id === "tags" ? d().tags.length
		: id === "collections" ? d().collections.length
		: id === "related" ? (d().related?.length ?? 0)
		: 0;
	const ref = (id: string) => (el: unknown) => { sections.set(id, el as never); };

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
				ref={(el: unknown) => { scroller = el as never; }}
				onLayout={(e) => { const w = (e as { width?: number }).width; if (w) setLabelW(Math.min(112, Math.max(64, Math.round(0.28 * (w - 40))))); }}
				onScrollChange={spy}
				style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, minWidth: 0, width: "100%", overflow: "scroll", display: "flex", flexDirection: "column", scrollbarColor: withAlpha(tok("foreground"), 0.25), scrollbarWidth: 6 }}
			>
				<div ref={ref("info")} style={{ width: "100%" }}><InfoSection /></div>
				<div ref={ref("abstract")} style={{ width: "100%" }}><AbstractSection /></div>
				<div ref={ref("notes")} style={{ width: "100%" }}><NotesSection /></div>
				<div ref={ref("attachments")} style={{ width: "100%" }}><AttachmentsSection /></div>
				<div ref={ref("collections")} style={{ width: "100%" }}><CollectionsSection /></div>
				<div ref={ref("tags")} style={{ width: "100%" }}><TagsSection /></div>
				<div ref={ref("related")} style={{ width: "100%" }}><RelatedSection /></div>
				<div style={{ height: 192, flexShrink: 0 }} />
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
			<div style={{ ...t("flex flex-col flex-none gap-2.5 px-5 pt-5 pb-4"), backgroundColor: tok("header-tint"), borderBottomWidth: 1, borderColor: tok("border-soft") }}>
				<div style={{ ...t("flex items-center gap-1.5 rounded-full px-2.5 py-1"), alignSelf: "flex-start", backgroundColor: tok("primary-tint") }}>
					<Icon name="sticky-note" size={14} color={tok("primary-deep")} />
					<text style={{ ...tx("text-[11px] font-semibold"), color: tok("primary-deep") }}>NOTE</text>
				</div>
				<text style={{ ...tx("font-title text-[21px] font-semibold"), paddingLeft: 6 }}>{title()}</text>
			</div>
			<div style={{ flexGrow: 1, minHeight: 0, width: "100%", overflow: "scroll", padding: 16 }}>
				<NoteEditor noteKey={d().data.key} onSaved={() => pane.refreshList()} />
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
