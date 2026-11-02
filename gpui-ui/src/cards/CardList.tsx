// The library list. `CardList` picks what fills the list card (ui/src/App.tsx + ItemTable.tsx): the full-text search results, the
// Classic table or the cards (List view). The cards are a windowed GPUIX <virtual-list> of group headers and item cards
// (ui/src/cards/CardList.tsx): the list holds every row logically (itemCount) but only a window of WINDOW rows is mounted; the
// window follows onVisibleRange. Item rows read store.itemAt(i), which fetches the page on demand (a skeleton shows meanwhile).
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js";
import { useGpuix } from "@gpuix/solid";
import type { EventPayload } from "@gpuix/solid";
import { dragSource } from "../dnd";
import { Icon } from "../icons";
import { store } from "../store";
import { TableView } from "../table/Table";
import { loadSchema } from "../table/defs";
import { textStyle, tw } from "../theme";
import { openItem } from "./actions";
import { Card, tok } from "./Card";
import { modsOf, swallowed } from "./click";
import { listFocused, listKeyHandler, setListFocused } from "./keys";
import { cardLayout } from "./layout";
import { loadTagColors } from "./logic";
import { openItemMenu } from "./menus";
import { createRows, type Group, type Rows } from "./rows";
import { SearchResults } from "./SearchResults";

/** Rows mounted at once. */
export const WINDOW = 40;

/** Year header: `flex w-full items-center gap-2 border-b border-border/60 bg-muted/50 px-5 pb-1.5 pt-3` + serif label + count pill + chevron. */
export function GroupHeader(p: { group: Group; collapsed: boolean; onToggle: () => void }): JSX.Element {
	const m = () => store.mode();
	return (
		<div onClick={() => p.onToggle()} style={{ ...tw("flex w-full flex-none items-center gap-2 border-b border-border/60 bg-muted/50 px-5 pb-1.5 pt-3 cursor-pointer", m()) }}>
			{/* 16.7px instead of text-base (16px): same serif optical-size compensation as the card titles */}
			<text style={{ ...textStyle("font-title text-base font-semibold text-primary-deep", m()), fontSize: 16.7 }}>{p.group.label}</text>
			<div style={tw("flex items-center rounded-full bg-primary/10 px-2 py-px", m())}>
				<text style={textStyle("text-[11.5px] font-medium tabular-nums text-primary", m())}>{p.group.count.toLocaleString("en-US")}</text>
			</div>
			<div style={{ flexGrow: 1 }} />
			<Icon name={p.collapsed ? "chevron-right" : "chevron-down"} size={16} color={tok("muted-foreground", m())} />
		</div>
	);
}

/** CardSkeleton: icon block + three bars (bg-primary/10), the paddings of a card. */
function CardSkeleton(): JSX.Element {
	const m = () => store.mode();
	const bar = (cls: string) => tw(`bg-primary/10 rounded ${cls}`, m());
	return (
		<div style={tw("flex gap-3 border-b border-border/60 px-2.5 py-2.5", m())}>
			<div style={{ ...bar("size-[18px] mt-0.5 mx-0.5 flex-none"), borderRadius: 5 }} />
			<div style={tw("flex flex-1 flex-col gap-2 min-w-0", m())}>
				<div style={bar("h-4 w-4/5")} />
				<div style={bar("h-3 w-1/2")} />
				<div style={bar("h-7 w-1/3")} />
			</div>
		</div>
	);
}

function ItemRowView(p: { index: number }): JSX.Element {
	const item = createMemo(() => store.itemAt(p.index));
	const [hovered, setHovered] = createSignal(false);
	const src = dragSource(
		() => { const it = untrack(item); return it ? store.keysFor(it.key) : []; },
		() => { const it = untrack(item); if (it && !store.selected().has(it.key)) store.selectOnly(it.key, p.index); },
	);
	return (
		<div
			style={tw("flex flex-col w-full flex-none px-2.5", store.mode())}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onMouseDown={src.onMouseDown}
			onMouseMove={src.onMouseMove}
			onMouseUp={src.onMouseUp}
			onClick={(e: EventPayload) => {
				if (swallowed() || src.wasDrag()) return;
				const it = untrack(item);
				if (!it) return;
				setListFocused(true);
				const mods = modsOf(e);
				store.selectClick(p.index, mods);
				if ((e.clickCount ?? 1) >= 2 && !mods.shift && !mods.ctrl) void openItem(it); // double-click opens the PDF in a reader tab
			}}
			onAuxClick={(e: EventPayload) => {
				if (!(e.isRightClick || e.button === 2)) return;
				const it = untrack(item);
				if (it) openItemMenu({ x: e.x ?? 0, y: e.y ?? 0 }, it, p.index);
			}}
		>
			<Show when={item()} fallback={<CardSkeleton />}>
				{(x) => (
					<Card
						item={x()} index={p.index} hovered={hovered()}
						focused={listFocused() && store.focusIndex() === p.index}
						onMore={(r) => openItemMenu({ x: r.x, y: r.y + r.height }, x(), p.index)}
					/>
				)}
			</Show>
		</div>
	);
}

function RowView(p: { row: number; rows: Rows }): JSX.Element {
	const r = createMemo(() => p.rows.row(p.row));
	return (
		<Show when={r()} keyed>
			{(rw) => rw.kind === "header"
				? <GroupHeader group={rw.group} collapsed={p.rows.isCollapsed(rw.group)} onToggle={() => p.rows.toggle(rw.group)} />
				: <ItemRowView index={rw.index} />}
		</Show>
	);
}

/** The cards (List view). */
export function CardsView(): JSX.Element {
	const rows = createRows();
	const gpuix = useGpuix();
	let list: { id: number } | undefined;
	const estimate = () => (cardLayout.layout().density === "compact" ? 78 : 104);

	// what the cards show decides which Zotero fields / extras the list requests
	loadSchema();
	loadTagColors();
	createEffect(() => store.setListFields(cardLayout.fieldsParam(), cardLayout.includeParam()));

	const [start, setStart] = createSignal(0);
	const count = () => rows.count();
	const first = createMemo(() => Math.max(0, Math.min(start(), count() - WINDOW)));
	const indices = createMemo(() => {
		const s = first(), e = Math.min(count(), s + WINDOW);
		return Array.from({ length: Math.max(0, e - s) }, (_, i) => s + i);
	});

	let visA = 0, visB = 0;
	/** Item index shown at a row (a header stands for the group's first item). */
	const itemAtRow = (r: number): number => {
		const rw = rows.row(Math.max(0, Math.min(r, count() - 1)));
		return !rw ? 0 : rw.kind === "item" ? rw.index : rw.group.start;
	};
	// keep the mounted window around the visible rows (recentre only when the view nears an edge)
	const onVisibleRange = (e: EventPayload) => {
		const a = Math.floor(e.startIndex ?? 0), b = Math.ceil(e.endIndex ?? a + 1);
		visA = a; visB = b;
		store.setVisible(itemAtRow(a), itemAtRow(b));
		const s = untrack(first);
		if ((a < s + 6 && s > 0) || b > s + WINDOW - 6) setStart(Math.max(0, a - WINDOW / 4));
	};

	// a new list (view / filter / sort) starts at the top
	createEffect(on(() => store.listVersion(), () => {
		setStart(0);
		if (list) gpuix?.renderer.scrollToItem?.(list.id, 0);
	}, { defer: true }));

	/** Scroll so row `r` is on screen (only when it is outside the visible range). */
	function reveal(r: number) {
		if (r < 0 || !list) return;
		if (r >= visA + 1 && r < visB - 1) return;
		setStart(Math.max(0, r - WINDOW / 2));
		gpuix?.renderer.scrollToItem?.(list.id, r, r < visA ? 0 : -300);
	}
	/** Move the focus by `delta` items, skipping items hidden in collapsed groups. */
	function move(delta: number, extend: boolean) {
		const last = store.total() - 1;
		if (last < 0) return;
		const dir = delta < 0 ? -1 : 1;
		let next = Math.max(0, Math.min(last, (store.focusIndex() < 0 ? (delta > 0 ? -1 : 1) : store.focusIndex()) + delta));
		while (next >= 0 && next <= last && rows.rowOf(next) < 0) next += dir;
		if (next < 0 || next > last) return;
		store.focusRow(next, extend);
		reveal(rows.rowOf(next));
	}
	const keys = listKeyHandler({
		move,
		page: () => Math.max(1, Math.floor((visB - visA) * 0.9)),
		open: () => { const it = store.peek(store.focusIndex()); if (it) void openItem(it); },
		toggle: () => { if (store.focusIndex() >= 0) store.selectClick(store.focusIndex(), { shift: false, ctrl: true }); },
	});
	onMount(() => onCleanup(() => setListFocused(false)));

	return (
		<div
			tabIndex={0}
			onKeyDown={keys}
			onFocus={() => setListFocused(true)}
			onBlur={() => setListFocused(false)}
			style={{ ...tw("flex flex-col flex-1 min-h-0 w-full h-full bg-card", store.mode()), keyboardFocusDim: false }}
		>
			<virtual-list
				ref={(el: { id: number }) => { list = el; }}
				testId="card-list"
				itemCount={count()}
				windowStart={first()}
				estimatedItemHeight={estimate()}
				overdraw={400}
				onVisibleRange={onVisibleRange}
				style={{ width: "100%", height: "100%" }}>
				<For each={indices()}>{(i) => <RowView row={i} rows={rows} />}</For>
			</virtual-list>
			<Show when={count() === 0 && !store.loading()}>
				<div style={tw("flex flex-col absolute top-10 inset-x-0 items-center gap-1", store.mode())}>
					<text style={textStyle("text-muted-foreground", store.mode())}>{store.view().kind === "publications" ? "My Publications is not available in this library" : "No items"}</text>
					<Show when={store.error()}>
						<text style={textStyle("text-xs text-destructive", store.mode())}>{store.error() ?? ""}</text>
					</Show>
				</div>
			</Show>
		</div>
	);
}

/**
 * The list card's content: search results with snippets in "Full text" mode, else the Classic table or the cards, per the
 * List / Classic toggle. (ItemTable in ui/src/ItemTable.tsx.)
 */
export function CardList(): JSX.Element {
	return (
		<Show when={!store.fulltext()} fallback={<SearchResults />}>
			<Show when={store.viewMode() === "cards"} fallback={<TableView />}>
				<CardsView />
			</Show>
		</Show>
	);
}
export { CardList as ItemList };
